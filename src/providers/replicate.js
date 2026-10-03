import Replicate from "replicate";
import { CONFIG } from "../config.js";
import { fail } from "../errors.js";
import { log } from "../log.js";

// The ONLY module that imports 'replicate'. Everything provider-specific —
// status vocabulary, input schema quirks, ID format — is contained here.
// useFileOutput:false keeps prediction.output a plain URL string.
const client = new Replicate({ auth: CONFIG.replicateToken, useFileOutput: false });

// Map our neutral contract onto whatever fields the CONFIGured model accepts.
// Per-model quirks live here and nowhere else.
function buildInput({ startImage, prompt, negativePrompt, duration }) {
  const input = {
    start_image: startImage, // string URL, or a File object (auto-uploaded)
    prompt,
    duration, // 5 | 10
    negative_prompt: negativePrompt,
  };
  // kling-v2.1 has a standard/pro mode switch; pin it to standard (cheap tier).
  // kling-v2.5-turbo-pro has no such field — do not send it.
  if (CONFIG.klingModel.includes("kling-v2.1")) {
    input.mode = "standard";
  }
  return input;
}

// startImage: for a URL, the string; for a local photo, { buffer, filename, mime }.
export async function createClip({ startImage, prompt, negativePrompt, duration }) {
  let imageInput = startImage;
  if (startImage && typeof startImage === "object" && startImage.buffer) {
    // File object → the replicate client uploads via the Files API automatically.
    imageInput = new File([startImage.buffer], startImage.filename, { type: startImage.mime });
  }

  let prediction;
  try {
    prediction = await client.predictions.create({
      model: CONFIG.klingModel,
      input: buildInput({ startImage: imageInput, prompt, negativePrompt, duration }),
    });
  } catch (e) {
    fail("provider", `Replicate rejected the prediction: ${e.message || e}`);
  }
  log("createClip", prediction.id, CONFIG.klingModel);
  return { clipId: prediction.id };
}

function mapStatus(replicateStatus) {
  switch (replicateStatus) {
    case "starting":
    case "processing":
      return "processing";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "failed";
    default:
      return "processing";
  }
}

// -> { status, outputUrl, error }. 404 -> not_found.
export async function getClip(clipId) {
  let p;
  try {
    p = await client.predictions.get(clipId);
  } catch (e) {
    if (e.response && e.response.status === 404) fail("not_found", `no such clip: ${clipId}`);
    fail("provider", `Replicate lookup failed for ${clipId}: ${e.message || e}`);
  }
  const status = mapStatus(p.status);
  let error = p.error ? String(p.error) : undefined;
  if (p.status === "canceled") error = `canceled: ${error ?? "prediction canceled"}`;

  // Kling output may be a string URL or an array with one URL.
  let outputUrl;
  if (typeof p.output === "string") outputUrl = p.output;
  else if (Array.isArray(p.output) && p.output.length) outputUrl = p.output[p.output.length - 1];

  return { status, outputUrl, error };
}

export async function cancelClip(clipId) {
  try {
    await client.predictions.cancel(clipId);
  } catch (e) {
    if (e.response && e.response.status === 404) fail("not_found", `no such clip: ${clipId}`);
    fail("provider", `cancel failed for ${clipId}: ${e.message || e}`);
  }
  return getClip(clipId);
}
