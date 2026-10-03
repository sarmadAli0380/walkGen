import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { preflightPhoto } from "../src/lib/validate.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vm-preflight-"));
const p = (n) => path.join(DIR, n);
let server, base;

before(async () => {
  const gen = (name, size) =>
    execFileSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", `color=c=gray:s=${size}`, "-frames:v", "1", p(name)], { stdio: "ignore" });
  gen("valid.jpg", "1280x720");
  gen("small.png", "200x150");
  gen("pano.jpg", "3000x600");
  // fake HEIC: ISO-BMFF ftyp 'heic'
  fs.writeFileSync(p("photo.heic"), Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypheic"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from("mif1heic"),
  ]));

  const valid = fs.readFileSync(p("valid.jpg"));
  const heic = fs.readFileSync(p("photo.heic"));
  const small = fs.readFileSync(p("small.png"));
  const huge = Buffer.alloc(11 * 1024 * 1024, 0x41); // 11 MB -> trips download cap

  server = http.createServer((req, res) => {
    const map = { "/valid.jpg": valid, "/photo.heic": heic, "/small.png": small, "/huge.jpg": huge };
    if (req.url === "/missing") { res.writeHead(404); return res.end("nope"); }
    // Flush headers + a partial body byte, then stall the socket forever — the
    // case that previously hung because the timeout only covered headers.
    if (req.url === "/stall") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.write(Buffer.from([0xff]));
      return; // never end -> body stalls
    }
    const body = map[req.url];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test("local: valid image passes", async () => {
  const r = await preflightPhoto(p("valid.jpg"));
  assert.equal(r.isUrl, false);
  assert.equal(r.mime, "image/jpeg");
});

test("local: HEIC / too-small / panorama rejected", async () => {
  await assert.rejects(() => preflightPhoto(p("photo.heic")), /HEIC\/HEIF/);
  await assert.rejects(() => preflightPhoto(p("small.png")), /too small/);
  await assert.rejects(() => preflightPhoto(p("pano.jpg")), /aspect ratio too extreme/);
  await assert.rejects(() => preflightPhoto(p("nope.jpg")), /file not found/);
});

test("URL: valid image passes (fetched + validated)", async () => {
  const r = await preflightPhoto(`${base}/valid.jpg`);
  assert.equal(r.isUrl, true);
  assert.equal(r.source, `${base}/valid.jpg`);
});

test("URL: HEIC is now rejected (the fix — was previously bypassed)", async () => {
  await assert.rejects(() => preflightPhoto(`${base}/photo.heic`), /HEIC\/HEIF/);
});

test("URL: too-small image rejected", async () => {
  await assert.rejects(() => preflightPhoto(`${base}/small.png`), /too small/);
});

test("URL: >10MB download rejected by cap", async () => {
  await assert.rejects(() => preflightPhoto(`${base}/huge.jpg`), /exceeds 10 MB/);
});

test("URL: HTTP 404 surfaces a photo_preflight error", async () => {
  await assert.rejects(() => preflightPhoto(`${base}/missing`), /HTTP 404/);
});

test("URL: unreachable host surfaces a fetch error, not a crash", async () => {
  await assert.rejects(() => preflightPhoto("http://127.0.0.1:1/x.jpg"), /could not fetch/);
});

test("URL: body stall (headers flushed, then no data) times out — does not hang", async () => {
  const prev = process.env.VIEWMAX_FETCH_TIMEOUT_MS;
  process.env.VIEWMAX_FETCH_TIMEOUT_MS = "800";
  const started = Date.now();
  try {
    await assert.rejects(() => preflightPhoto(`${base}/stall`), /timed out/);
    assert.ok(Date.now() - started < 5000, "should abort near the 800ms deadline, not hang");
  } finally {
    if (prev === undefined) delete process.env.VIEWMAX_FETCH_TIMEOUT_MS;
    else process.env.VIEWMAX_FETCH_TIMEOUT_MS = prev;
  }
});
