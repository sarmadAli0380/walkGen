#!/usr/bin/env node
import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

import { CONFIG } from "./config.js";
import { log } from "./log.js";
import { AppError, fail } from "./errors.js";
import { ONTOLOGY } from "./ontology.js";
import { PRESETS, PRESET_KEYS, DEFAULT_NEGATIVE_PROMPT, SHOT_GUIDE } from "./lib/motionPresets.js";
import { assertClipId, sanitizeOutputName, exactlyOne, preflightPhoto } from "./lib/validate.js";
import {
  ensureDirs, sweepPartials, writeSidecar, readSidecar, listSidecars,
  ensureClipLocal, clipVideoPath, outputPath,
} from "./lib/storage.js";
import { createClip, cancelClip } from "./providers/replicate.js";
import { stitch } from "./video/stitch.js";

// ---------- startup checks (fail fast, one clear line to stderr) ----------
function die(msg) {
  log("FATAL:", msg);
  process.exit(1);
}
if (!CONFIG.replicateToken) {
  die("REPLICATE_API_TOKEN is not set. Add it to the Claude Desktop config 'env' block (see README).");
}
for (const [name, p] of [["ffmpeg", ffmpegPath], ["ffprobe", ffprobeStatic.path]]) {
  if (!p || !fs.existsSync(p)) die(`${name} binary not found at ${p} — reinstall dependencies (npm install).`);
}
ensureDirs();
sweepPartials();

// ---------- result envelope helpers ----------
const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const errEnvelope = (code, message) => ({
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }, null, 2) }],
  isError: true,
});

// Wraps a handler so no tool call can crash the server; AppError -> its code,
// anything else -> internal.
const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof AppError) return errEnvelope(e.code, e.message);
    log("UNEXPECTED", e && e.stack ? e.stack : String(e));
    return errEnvelope("internal", e && e.message ? e.message : String(e));
  }
};

const server = new McpServer({ name: "viewmax-mcp", version: "0.1.0" });

// ---------- describe_ontology ----------
server.registerTool(
  "describe_ontology",
  {
    description: "Returns the entity/relationship model, clip lifecycle, and tool map. Call first to orient.",
    inputSchema: {},
  },
  tool(async () => ok(ONTOLOGY))
);

// ---------- list_motion_presets ----------
server.registerTool(
  "list_motion_presets",
  {
    description:
      "Lists motion presets. Prefer kind:'room' presets (say what the room IS — the professional shot is chosen for you); kind:'camera' presets give explicit control. shot_guide maps room types to the preset a professional videographer would use.",
    inputSchema: {},
  },
  tool(async () =>
    ok({
      presets: PRESET_KEYS.map((key) => ({
        key,
        kind: PRESETS[key].kind,
        prompt: PRESETS[key].prompt,
        reliability_note: PRESETS[key].reliability_note,
      })),
      shot_guide: SHOT_GUIDE,
      default_negative_prompt: DEFAULT_NEGATIVE_PROMPT,
    })
  )
);

// ---------- list_clips ----------
server.registerTool(
  "list_clips",
  {
    description: "Enumerates known clips from local metadata (no network). downloaded=false means call check_clip.",
    inputSchema: {},
  },
  tool(async () => {
    const clips = listSidecars().map((m) => ({
      clip_id: m.clip_id,
      room_label: m.room_label ?? null,
      motion: m.motion ?? null,
      duration: m.duration,
      model: m.model,
      created_at: m.created_at,
      downloaded: fs.existsSync(clipVideoPath(m.clip_id)),
    }));
    return ok({ clips });
  })
);

// ---------- generate_clip ----------
server.registerTool(
  "generate_clip",
  {
    description:
      "Submits one photo for animation and returns immediately with a clip_id in 'processing'. " +
      "Provide exactly one of motion (a preset key) or custom_prompt.",
    inputSchema: {
      photo_source: z.string().describe("local file path or http(s) URL"),
      motion: z.string().optional().describe(`preset key: ${PRESET_KEYS.join(", ")}`),
      custom_prompt: z.string().optional().describe("free-text prompt instead of a preset"),
      negative_prompt: z.string().optional(),
      duration: z.union([z.literal(5), z.literal(10)]).default(5),
      room_label: z.string().optional(),
    },
  },
  tool(async ({ photo_source, motion, custom_prompt, negative_prompt, duration, room_label }) => {
    exactlyOne(motion, custom_prompt);
    const prompt = motion ? PRESETS[motion].prompt : custom_prompt;
    const negativePrompt = negative_prompt ?? DEFAULT_NEGATIVE_PROMPT;
    const photo = await preflightPhoto(photo_source);
    const startImage = photo.isUrl ? photo.source : photo;

    const { clipId } = await createClip({ startImage, prompt, negativePrompt, duration });

    await writeSidecar({
      clip_id: clipId,
      photo_source,
      room_label: room_label ?? null,
      motion: motion ?? null,
      custom_prompt: custom_prompt ?? null,
      negative_prompt: negativePrompt,
      duration,
      model: CONFIG.klingModel,
      created_at: new Date().toISOString(),
    });

    return ok({
      clip_id: clipId,
      status: "processing",
      photo_source,
      motion: motion ?? null,
      duration,
      model: CONFIG.klingModel,
      room_label: room_label ?? null,
    });
  })
);

// ---------- check_clip ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.registerTool(
  "check_clip",
  {
    description:
      "Batch status check. Disk-first (free after first success), downloads succeeded clips locally. " +
      "Optional wait_seconds (<=60) briefly server-side-polls pending clips.",
    inputSchema: {
      clip_ids: z.array(z.string()).min(1),
      wait_seconds: z.number().min(0).max(60).optional(),
    },
  },
  tool(async ({ clip_ids, wait_seconds }) => {
    clip_ids.forEach(assertClipId);
    const deadline = Date.now() + Math.min(wait_seconds ?? 0, 60) * 1000;

    // Per-clip resolution must NEVER throw — one bad clip (e.g. a 404 on lookup)
    // must not discard the status of every other clip in the batch.
    const resolveOne = async (id) => {
      try {
        const r = await ensureClipLocal(id);
        return { clip_id: id, status: r.status, local_path: r.localPath, error: r.error };
      } catch (e) {
        const message = e instanceof AppError ? e.message : e && e.message ? e.message : String(e);
        return { clip_id: id, status: "failed", error: message };
      }
    };
    const resolveAll = async () => Promise.all(clip_ids.map(resolveOne));

    let results = await resolveAll();
    while (Date.now() < deadline && results.some((r) => r.status === "processing")) {
      await sleep(4000);
      results = await resolveAll();
    }
    return ok({ clips: results });
  })
);

// ---------- cancel_clip ----------
server.registerTool(
  "cancel_clip",
  {
    description: "Cancels an in-progress clip to stop billing. Returns its terminal state.",
    inputSchema: { clip_id: z.string() },
  },
  tool(async ({ clip_id }) => {
    assertClipId(clip_id);
    const { status, error } = await cancelClip(clip_id);
    return ok({ clip_id, status, error: error ?? "canceled by caller" });
  })
);

// ---------- stitch_walkthrough ----------
server.registerTool(
  "stitch_walkthrough",
  {
    description:
      "Concatenates succeeded clips (in the given order) into one walkthrough. " +
      "Self-heals clips that succeeded but were never downloaded.",
    inputSchema: {
      clips: z.array(z.string()).min(1),
      transition: z.enum(["crossfade", "cut"]).default("crossfade"),
      transition_duration_seconds: z.number().default(0.75),
      output_name: z.string().optional(),
    },
  },
  tool(async ({ clips, transition, transition_duration_seconds, output_name }) => {
    clips.forEach(assertClipId);
    const outPath = outputPath(output_name); // also validates output_name

    // Per-clip resolution must not throw — a lookup error on one clip should be
    // reported as that clip being not-ready, not abort the whole request.
    const resolveOne = async (id) => {
      try {
        return { id, ...(await ensureClipLocal(id)) };
      } catch (e) {
        const message = e instanceof AppError ? e.message : e && e.message ? e.message : String(e);
        return { id, status: "failed", error: message };
      }
    };
    const resolved = await Promise.all(clips.map(resolveOne));
    const notReady = resolved.filter((r) => r.status !== "succeeded");
    if (notReady.length) {
      const detail = notReady.map((r) => `${r.id}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("; ");
      fail("not_ready", `not all clips are ready — ${detail}`);
    }

    const paths = resolved.map((r) => r.localPath);
    const { outputPath: finalPath, durationSeconds } = await stitch(paths, {
      transition,
      td: transition_duration_seconds,
      outPath,
    });

    return ok({
      output: { path: finalPath },
      clip_count: clips.length,
      duration_seconds: durationSeconds,
    });
  })
);

// ---------- connect ----------
const transport = new StdioServerTransport();
await server.connect(transport);
log(`viewmax-mcp ready — model=${CONFIG.klingModel} storage=${CONFIG.storageDir}`);
