import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobeStatic from "ffprobe-static";
import { fail } from "../errors.js";

const execFileAsync = promisify(execFile);
const FFPROBE = ffprobeStatic.path;

function parseFps(rate) {
  if (!rate || typeof rate !== "string") return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!den) return num || 0;
  return +(num / den).toFixed(3); // "30000/1001" -> 29.97
}

// -> { codec, width, height, fps, pixFmt, duration } ; throws ffmpeg-coded on
// unparseable/corrupt files (the safety net past the ftyp download check).
export async function probe(file) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(FFPROBE, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,r_frame_rate,pix_fmt",
      "-show_entries", "format=duration",
      "-of", "json",
      file,
    ]));
  } catch (e) {
    fail("ffmpeg", `ffprobe failed on ${file}: ${(e.stderr || e.message || "").toString().trim()}`);
  }

  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    fail("ffmpeg", `ffprobe returned unparseable output for ${file}`);
  }

  const stream = json.streams && json.streams[0];
  if (!stream) fail("ffmpeg", `no video stream in ${file}`);

  const duration = parseFloat(json.format && json.format.duration);
  if (!(duration > 0)) fail("ffmpeg", `could not read duration for ${file}`);

  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    fps: parseFps(stream.r_frame_rate),
    pixFmt: stream.pix_fmt,
    duration,
  };
}
