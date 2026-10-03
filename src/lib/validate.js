import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import { fail } from "../errors.js";
import { PRESET_KEYS } from "./motionPresets.js";

// Matches Replicate prediction IDs. This is the path-traversal gate: no clip_id
// is ever turned into a filesystem path before passing here.
export const CLIP_ID_RE = /^[a-z0-9]{10,40}$/;

export function assertClipId(id) {
  if (typeof id !== "string" || !CLIP_ID_RE.test(id)) {
    fail("validation", `invalid clip_id "${id}" — must match ${CLIP_ID_RE}`);
  }
  return id;
}

const OUTPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function sanitizeOutputName(name) {
  if (name === undefined || name === null || name === "") {
    const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15); // YYYYMMDDHHmmss-ish
    return `walkthrough-${t.slice(0, 8)}-${t.slice(8, 14)}`;
  }
  if (!OUTPUT_NAME_RE.test(name)) {
    fail(
      "validation",
      `invalid output_name "${name}" — use letters, digits, dash, underscore (max 64 chars, must start alphanumeric)`
    );
  }
  return name;
}

// Exactly one of motion / custom_prompt must be provided.
export function exactlyOne(motion, customPrompt) {
  const hasMotion = motion !== undefined && motion !== null && motion !== "";
  const hasCustom = customPrompt !== undefined && customPrompt !== null && customPrompt !== "";
  if (hasMotion && hasCustom) {
    fail("validation", "provide either `motion` or `custom_prompt`, not both");
  }
  if (!hasMotion && !hasCustom) {
    fail("validation", "provide one of `motion` (a preset key) or `custom_prompt` (free text)");
  }
  if (hasMotion && !PRESET_KEYS.includes(motion)) {
    fail("validation", `unknown motion preset "${motion}" — valid keys: ${PRESET_KEYS.join(", ")}`);
  }
  return { hasMotion, hasCustom };
}

const MAX_BYTES = 10 * 1024 * 1024;
const MIN_DIM = 300;
const MAX_ASPECT = 2.5;

function magicMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
    return "image/png";
  // ISO-BMFF container ("ftyp" at offset 4) — HEIC/HEIF land here.
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    return `__heif__:${brand}`;
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "__webp__";
  return "__unknown__";
}

// URL → pass through untouched (Replicate fetches it; its errors surface via the
// prediction). Both local and URL sources are validated identically — a bad
// image must fail here (free) rather than becoming a paid prediction.
const FETCH_TIMEOUT_MS = 15000;

// Shared image checks on raw bytes (format, dimensions, aspect). Returns the mime.
function checkImageBuffer(buffer, label) {
  if (buffer.length > MAX_BYTES)
    fail("photo_preflight", `image too large (${(buffer.length / 1048576).toFixed(1)} MB) — Kling limit is 10 MB: ${label}`);

  const mime = magicMime(buffer);
  if (mime.startsWith("__heif__")) {
    fail(
      "photo_preflight",
      `unsupported format (HEIC/HEIF) — convert to JPG/PNG first (iPhone photos are often HEIC): ${label}`
    );
  }
  if (mime === "__webp__") {
    fail("photo_preflight", `unsupported format (WebP) — convert to JPG/PNG first: ${label}`);
  }
  if (mime === "__unknown__") {
    fail("photo_preflight", `unrecognized image format — must be JPG or PNG: ${label}`);
  }

  let dim;
  try {
    dim = imageSize(buffer);
  } catch {
    fail("photo_preflight", `could not read image dimensions: ${label}`);
  }
  const { width, height } = dim;
  if (!width || !height) fail("photo_preflight", `could not read image dimensions: ${label}`);
  if (Math.min(width, height) < MIN_DIM)
    fail("photo_preflight", `image too small (${width}x${height}) — minimum dimension is ${MIN_DIM}px: ${label}`);
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect > MAX_ASPECT)
    fail(
      "photo_preflight",
      `aspect ratio too extreme (${width}x${height}, ${aspect.toFixed(2)}:1) — must be within 2.5:1: ${label}`
    );

  return mime;
}

// Fetch a URL image with a timeout and a hard 10 MB download cap (so a huge or
// slow URL can't hang or exhaust memory before we reject it).
async function fetchImageForPreflight(url) {
  const controller = new AbortController();
  // Inactivity timeout that covers the WHOLE transfer — headers AND body. It is
  // re-armed before every read, so a slow-but-steady download is allowed while a
  // server that flushes headers then stalls the body is still aborted. Clearing
  // it only after fetch() (i.e. after headers) would leave the body read
  // unguarded and let such a server hang the request forever.
  const timeoutMs = Number(process.env.VIEWMAX_FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  const disarm = () => clearTimeout(timer);

  arm();
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    disarm();
    const reason = e && e.name === "AbortError" ? "timed out" : (e && e.message) || String(e);
    fail("photo_preflight", `could not fetch photo URL (${reason}): ${url}`);
  }
  if (!res.ok) { disarm(); fail("photo_preflight", `photo URL returned HTTP ${res.status}: ${url}`); }
  if (!res.body) { disarm(); fail("photo_preflight", `photo URL returned an empty response: ${url}`); }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let tooBig = false;
  try {
    for (;;) {
      arm(); // reset the inactivity deadline before each chunk read
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        tooBig = true;
        try { await reader.cancel(); } catch {}
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    const reason = e && e.name === "AbortError" ? "timed out" : (e && e.message) || String(e);
    fail("photo_preflight", `could not fetch photo URL (${reason}): ${url}`);
  } finally {
    disarm();
  }
  if (tooBig) fail("photo_preflight", `photo URL exceeds 10 MB limit: ${url}`);
  if (total === 0) fail("photo_preflight", `photo URL returned no data: ${url}`);
  return Buffer.concat(chunks);
}

export async function preflightPhoto(source) {
  if (typeof source !== "string" || source.trim() === "") {
    fail("photo_preflight", "photo_source is required (a local file path or http(s) URL)");
  }

  if (/^https?:\/\//i.test(source)) {
    const buffer = await fetchImageForPreflight(source);
    checkImageBuffer(buffer, source);
    // Generation still passes the original URL to Replicate; we only validated it.
    return { isUrl: true, source };
  }

  const abs = path.resolve(source);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    fail("photo_preflight", `file not found: ${source}`);
  }
  if (!stat.isFile()) fail("photo_preflight", `not a file: ${source}`);
  if (stat.size > MAX_BYTES)
    fail("photo_preflight", `file too large (${(stat.size / 1048576).toFixed(1)} MB) — Kling limit is 10 MB`);

  const buffer = fs.readFileSync(abs);
  const mime = checkImageBuffer(buffer, source);
  return { isUrl: false, buffer, filename: path.basename(abs), mime };
}
