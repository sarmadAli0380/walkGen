import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { probe } from "./probe.js";
import { xfadeOffsets, totalDuration, validateTransition } from "./xfadeMath.js";
import { fail } from "../errors.js";
import { log } from "../log.js";

const even = (n) => n - (n % 2);

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1 << 24 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || "").trim().split("\n").slice(-15).join("\n");
        reject(new Error(tail || err.message));
      } else resolve();
    });
  });
}

function norm(i, W, H, fps) {
  return (
    `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},settb=AVTB,format=yuv420p[v${i}]`
  );
}

// clipPaths: absolute .mp4 paths, already verified to exist.
// opts: { transition: "crossfade"|"cut", td: number, outPath: string }
// -> { outputPath, durationSeconds }
export async function stitch(clipPaths, { transition, td, outPath }) {
  const metas = [];
  for (const p of clipPaths) metas.push(await probe(p));
  const durations = metas.map((m) => m.duration);

  // Single clip: just normalize to even dims / yuv420p and copy through.
  if (clipPaths.length === 1) {
    const W = even(metas[0].width), H = even(metas[0].height), fps = metas[0].fps || 24;
    await runFfmpeg([
      "-y", "-i", clipPaths[0],
      "-vf", `scale=${W}:${H},setsar=1,format=yuv420p`,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
      outPath,
    ]);
    return { outputPath: outPath, durationSeconds: +durations[0].toFixed(3) };
  }

  const W = even(metas[0].width);
  const H = even(metas[0].height);
  const fps = metas[0].fps || 24;

  const uniform = metas.every(
    (m) => even(m.width) === W && even(m.height) === H && m.fps === fps && m.pixFmt === "yuv420p" && m.codec === "h264"
  );

  // Fast path: uniform clips + straight cut -> concat demuxer, stream copy.
  if (transition === "cut" && uniform) {
    const listFile = path.join(os.tmpdir(), `viewmax-concat-${Date.now()}.txt`);
    const listBody = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    fs.writeFileSync(listFile, listBody);
    try {
      log("stitch: concat-demuxer stream-copy path", clipPaths.length, "clips");
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", outPath]);
    } catch (e) {
      fail("ffmpeg", e.message);
    } finally {
      try { fs.unlinkSync(listFile); } catch {}
    }
    return { outputPath: outPath, durationSeconds: +durations.reduce((a, b) => a + b, 0).toFixed(3) };
  }

  // General path: normalize every input, then concat filter (cut) or xfade chain.
  const inputs = [];
  for (const p of clipPaths) inputs.push("-i", p);

  const normChains = clipPaths.map((_, i) => norm(i, W, H, fps));
  let filter;
  let finalLabel;
  let expectedDuration;

  if (transition === "cut") {
    const cat = clipPaths.map((_, i) => `[v${i}]`).join("") + `concat=n=${clipPaths.length}:v=1:a=0[outv]`;
    filter = normChains.join(";") + ";" + cat;
    finalLabel = "[outv]";
    expectedDuration = +durations.reduce((a, b) => a + b, 0).toFixed(3);
  } else {
    validateTransition(durations, td);
    const offsets = xfadeOffsets(durations, td);
    const parts = [...normChains];
    let prev = "[v0]";
    for (let k = 1; k < clipPaths.length; k++) {
      const out = k === clipPaths.length - 1 ? "[outv]" : `[x${k}]`;
      parts.push(`${prev}[v${k}]xfade=transition=fade:duration=${td}:offset=${offsets[k - 1]}${out}`);
      prev = out;
    }
    filter = parts.join(";");
    finalLabel = "[outv]";
    expectedDuration = totalDuration(durations, td);
  }

  log("stitch: filtergraph re-encode path", transition, clipPaths.length, "clips ->", `${W}x${H}@${fps}`);
  try {
    await runFfmpeg([
      "-y", ...inputs,
      "-filter_complex", filter,
      "-map", finalLabel,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
      outPath,
    ]);
  } catch (e) {
    fail("ffmpeg", e.message);
  }
  return { outputPath: outPath, durationSeconds: expectedDuration };
}
