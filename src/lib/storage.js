import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CLIPS_DIR, OUTPUT_DIR } from "../config.js";
import { fail } from "../errors.js";
import { assertClipId, sanitizeOutputName } from "./validate.js";
import { getClip } from "../providers/replicate.js";
import { log } from "../log.js";

// --- path builders (callers must have run assertClipId first) ---
export const clipVideoPath = (clipId) => path.join(CLIPS_DIR, `${clipId}.mp4`);
export const clipSidecarPath = (clipId) => path.join(CLIPS_DIR, `${clipId}.json`);
export const outputPath = (name) => path.join(OUTPUT_DIR, `${sanitizeOutputName(name)}.mp4`);

export function ensureDirs() {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Delete leftover .part files from a crashed run.
export function sweepPartials() {
  let entries = [];
  try {
    entries = fs.readdirSync(CLIPS_DIR);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.endsWith(".part")) {
      try {
        fs.unlinkSync(path.join(CLIPS_DIR, e));
        log("swept partial", e);
      } catch {
        /* ignore */
      }
    }
  }
}

// --- sidecar metadata (append-only; never mutated after creation) ---
export async function writeSidecar(meta) {
  const dest = clipSidecarPath(meta.clip_id);
  const tmp = dest + ".part";
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
  await fsp.rename(tmp, dest);
}

export function readSidecar(clipId) {
  try {
    return JSON.parse(fs.readFileSync(clipSidecarPath(clipId), "utf8"));
  } catch {
    return null;
  }
}

export function listSidecars() {
  let entries = [];
  try {
    entries = fs.readdirSync(CLIPS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const clipId = e.slice(0, -5);
    const meta = readSidecar(clipId);
    if (meta) out.push(meta);
  }
  return out;
}

// --- atomic download ---
export async function downloadAtomic(url, destPath) {
  const tmp = destPath + ".part";
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    fail("provider", `download failed: ${e.message || e}`);
  }
  if (res.status === 404) {
    fail(
      "expired_output",
      "Replicate output expired before it was downloaded; re-run generate_clip for this photo"
    );
  }
  if (!res.ok) fail("provider", `download failed with HTTP ${res.status}`);

  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    fail("provider", `download stream failed: ${e.message || e}`);
  }

  // Sanity: non-empty and looks like an MP4 ("ftyp" at offset 4).
  const fd = fs.openSync(tmp, "r");
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const size = fs.statSync(tmp).size;
  if (size === 0 || head.toString("ascii", 4, 8) !== "ftyp") {
    try { fs.unlinkSync(tmp); } catch {}
    fail("provider", "downloaded file is not a valid MP4");
  }

  await fsp.rename(tmp, destPath);
  return destPath;
}

// The shared disk-first routine used by check_clip AND stitch_walkthrough.
// -> { status, localPath?, error? }
export async function ensureClipLocal(clipId) {
  assertClipId(clipId);
  const dest = clipVideoPath(clipId);
  if (fs.existsSync(dest)) {
    return { status: "succeeded", localPath: dest }; // no network
  }
  const { status, outputUrl, error } = await getClip(clipId);
  if (status === "succeeded") {
    if (!outputUrl) fail("provider", `clip ${clipId} succeeded but returned no output URL`);
    const localPath = await downloadAtomic(outputUrl, dest);
    return { status: "succeeded", localPath };
  }
  if (status === "failed") return { status: "failed", error: error ?? "generation failed" };
  return { status: "processing" };
}
