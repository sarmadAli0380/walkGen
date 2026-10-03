# viewMax MCP Server — Detailed Implementation Plan

Companion to the design doc (`viewmax-mcp-implementation-plan.md`, v2). That doc records *what* and *why*; this one specifies *exactly how*: dependencies, file-by-file responsibilities, function signatures, API calls, ffmpeg command lines, and milestone-by-milestone acceptance criteria.

Environment facts this plan assumes (verified on this machine):
- Node **v24.12.0** — native `fetch`, `File`/`Blob`, ESM. No transpiler, no TypeScript build step; plain ESM JavaScript.
- **No system ffmpeg/ffprobe** — therefore `ffmpeg-static` and `ffprobe-static` are hard dependencies, not optional fallbacks.

---

## 0. Stack and dependencies

`package.json`:

```json
{
  "name": "viewmax-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": { "viewmax-mcp": "src/index.js" },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "replicate": "^1.x",
    "zod": "^3.x",
    "ffmpeg-static": "^5.x",
    "ffprobe-static": "^3.x",
    "image-size": "^2.x"
  }
}
```

Notes:
- `zod` is how the MCP SDK expresses tool input schemas — one source of truth for validation *and* the schema the client sees.
- `image-size` (pure JS, no native deps) powers the photo preflight (dimensions/aspect) without invoking ffmpeg on images.
- **No `dotenv`.** Recent dotenv versions print a banner via `console.log`, which corrupts the stdio JSON-RPC stream. Env comes from the Claude Desktop config `env` block (production) or the shell (Inspector testing). This is a deliberate exclusion — do not add it later without `{ quiet: true }`.
- No test framework dependency; milestone verification uses `node --test` (built-in) for the pure logic (validators, xfade offset math) and the MCP Inspector for tool-level testing.

---

## 1. Repository layout (final state)

```
viewMax/
  package.json
  .env.example                 # REPLICATE_API_TOKEN= (documentation only; see §0 note on dotenv)
  .gitignore                   # node_modules/, storage/, .env
  README.md                    # written in M7
  IMPLEMENTATION_PLAN.md       # this file
  src/
    index.js                   # bootstrap: startup checks, McpServer, registerTool ×7, stdio transport
    log.js                     # log(...args) -> process.stderr.write; the ONLY logging path
    config.js                  # env resolution, script-relative paths, startup assertions
    ontology.js                # static describe_ontology payload
    lib/
      motionPresets.js         # PRESETS: { key: { prompt, reliability_note } }
      storage.js               # paths, sidecar read/write, atomic download, ensureClipLocal
      validate.js              # preflightPhoto, assertClipId, sanitizeOutputName, exactlyOne
    providers/
      replicate.js             # createClip, getClip, cancelClip — the ONLY file that imports 'replicate'
    video/
      probe.js                 # probe(file) -> { duration, width, height, fps, pixFmt, codec }
      stitch.js                # stitch(clips, opts) -> { outputPath, durationSeconds }
      xfadeMath.js             # pure function: offsets(durations, td) -> number[]  (unit-tested)
  test/
    xfadeMath.test.js
    validate.test.js
  storage/                     # gitignored, created on startup
    clips/                     # {clip_id}.mp4, {clip_id}.json, {clip_id}.mp4.part (transient)
    output/
```

Initialize as a git repo in M0 (`git init`, first commit after scaffold) so each milestone lands as a commit.

---

## 2. Cross-cutting conventions

### 2.1 Config (`src/config.js`)

```js
export const CONFIG = {
  replicateToken: process.env.REPLICATE_API_TOKEN,        // asserted non-empty at startup
  klingModel:     process.env.KLING_MODEL ?? "kwaivgi/kling-v2.5-turbo-pro",
  storageDir:     process.env.STORAGE_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "storage"),
};
export const CLIPS_DIR  = path.join(CONFIG.storageDir, "clips");
export const OUTPUT_DIR = path.join(CONFIG.storageDir, "output");
```

Startup sequence in `index.js`, in order, each failing with a one-line actionable message on stderr + `process.exit(1)`:
1. `REPLICATE_API_TOKEN` present.
2. `ffmpeg-static` / `ffprobe-static` resolved to existing binary paths.
3. `mkdir -p` `CLIPS_DIR` and `OUTPUT_DIR`.
4. On boot, sweep `CLIPS_DIR` for orphaned `*.mp4.part` files and delete them (crashed downloads from a previous run).

**Never `process.cwd()` anywhere.** Claude Desktop launches servers from `/`.

### 2.2 Tool result envelope

Every tool returns `{ content: [{ type: "text", text: JSON.stringify(payload) }] }`.

- Success payloads are exactly the shapes in §3.
- Handled failures return `isError: true` with payload `{ error: { code, message } }`, where `code` is one of:
  `validation` | `photo_preflight` | `not_found` | `provider` | `expired_output` | `ffmpeg` | `not_ready`.
- Every handler body is wrapped in one try/catch; unexpected exceptions become `{ error: { code: "internal", message } }` — a tool call must never crash the server process.

### 2.3 Logging (`src/log.js`)

```js
export const log = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
```
Rule enforced by convention and review: **no `console.log` anywhere in `src/`** (grep for it before each commit; `console.error` is tolerable but use `log()`).

### 2.4 Validation primitives (`src/lib/validate.js`)

- `CLIP_ID_RE = /^[a-z0-9]{10,40}$/` — matches Replicate prediction IDs; anything else is rejected **before** any filesystem path is built from it. This is the path-traversal gate.
- `sanitizeOutputName(name)` — must match `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`; invalid → `validation` error (don't silently rewrite). Default when absent: `walkthrough-YYYYMMDD-HHmmss`.
- `exactlyOne(motion, custom_prompt)` — throws `validation` error naming both fields when 0 or 2 are supplied.
- `preflightPhoto(source)`:
  - URL (`/^https?:\/\//`): pass through untouched (Replicate fetches it; its errors surface via the prediction).
  - Local path: must exist and be a file; extension + magic bytes must be JPEG (`FF D8`) or PNG (`89 50 4E 47`) — **HEIC/HEIF/WebP rejected** with message `"unsupported format X — convert to JPG/PNG first (iPhone photos are often HEIC)"`; size ≤ 10 MB; via `image-size`: min dimension ≥ 300 px, aspect ratio within [1:2.5, 2.5:1]. Each check has its own message; return `{ buffer, filename, mime }` on success.

### 2.5 Sidecar JSON (exact shape)

`storage/clips/{clip_id}.json`, written by `generate_clip` immediately after prediction creation:

```json
{
  "clip_id": "…",
  "photo_source": "/abs/path/or/url",
  "room_label": "primary bedroom",
  "motion": "push_in",
  "custom_prompt": null,
  "negative_prompt": "distortion, warping, people, flickering",
  "duration": 5,
  "model": "kwaivgi/kling-v2.5-turbo-pro",
  "created_at": "2026-07-30T19:04:11Z"
}
```

Written with the same atomic pattern as downloads (`.json.part` → rename). Sidecars are never deleted or mutated after creation.

---

## 3. Module and tool specifications

### 3.1 `providers/replicate.js`

The only module importing `replicate`. Client construction:

```js
const client = new Replicate({ auth: CONFIG.replicateToken, useFileOutput: false });
```

`useFileOutput: false` makes `prediction.output` a plain URL string instead of a `FileOutput` object — everything downstream assumes strings.

- `createClip({ photo, prompt, negativePrompt, duration })` →
  ```js
  client.predictions.create({ model: CONFIG.klingModel, input: buildInput(...) })
  ```
  where `buildInput` maps our contract onto the configured model's schema:
  - `start_image`: for a URL, the string itself; for a local photo, `new File([buffer], filename, { type: mime })` — the client uploads it via Replicate's Files API automatically. **M2 exit criterion includes verifying this upload path with a >1 MB photo**; if the installed client version doesn't auto-upload, fall back to explicit `client.files.create(file)` then pass `file.urls.get`.
  - `prompt`, `duration` (integer 5 or 10), `negative_prompt`.
  - Per-model quirks live here and nowhere else: e.g. if `KLING_MODEL` is ever set to `kwaivgi/kling-v2.1`, add `mode: "standard"`; drop `negative_prompt` if a configured model lacks it.
  - Returns `{ clipId: prediction.id }`.
- `getClip(clipId)` → `client.predictions.get(clipId)` → `{ status, outputUrl, error }` with the status **mapped here**: `starting|processing → "processing"`, `succeeded → "succeeded"`, `failed → "failed"`, `canceled → "failed"` (error prefixed `"canceled: "`). A 404 from Replicate → throw `not_found`.
- `cancelClip(clipId)` → `client.predictions.cancel(clipId)`, then `getClip` to report the terminal state.

### 3.2 `lib/storage.js`

- `clipVideoPath(clipId)` / `clipSidecarPath(clipId)` / `outputPath(name)` — the only functions that build storage paths; both callers of clip paths must have run `assertClipId` first.
- `downloadAtomic(url, destPath)` — `fetch(url)`; non-200 with `.mp4`-typed dest → if HTTP 404, throw `expired_output` with message `"Replicate output expired before it was downloaded; re-run generate_clip for this photo"`; stream to `destPath + ".part"`; on completion assert size > 0 and first bytes look like an MP4 (`ftyp` at offset 4), then `rename` into place. Any failure deletes the `.part`.
- `ensureClipLocal(clipId)` — **the shared disk-first routine** used by both `check_clip` and `stitch_walkthrough`:
  1. If `clipVideoPath` exists → `{ status: "succeeded", localPath }`. No network.
  2. Else `getClip(clipId)`:
     - `succeeded` → `downloadAtomic(outputUrl, path)` → `{ status: "succeeded", localPath }`.
     - `processing` → `{ status: "processing" }`.
     - `failed` → `{ status: "failed", error }`.
- `writeSidecar(meta)` / `readSidecar(clipId)` / `listSidecars()`.

### 3.3 `lib/motionPresets.js`

Starting prompt texts (M6 tunes these; treat as v0, not final):

| key | prompt (v0) | reliability_note |
|---|---|---|
| `push_in` | "Slow steady cinematic camera push forward into the room, smooth dolly-in, static furniture and decor, no people, photorealistic, consistent geometry" | most reliable preset |
| `pull_out` | "Slow steady camera pull backward revealing the room, smooth dolly-out, static scene, no people, photorealistic" | reliable |
| `pan_left_right` | "Smooth slow camera pan from left to right across the room, level horizon, static scene, no people" | usually works; watch for warping at edges |
| `pan_right_left` | mirror of above | same |
| `dolly_forward` | "Gentle forward glide at walking pace through the room toward the far wall, stabilized gimbal shot, no people" | reliable |
| `orbit` | "Slow partial orbit around the center of the room, camera arcing sideways while facing the room center, consistent room geometry, no people" | **least reliable** — invents unseen geometry on interiors; prefer push_in/pan |

Default `negative_prompt` (applied when caller sends none): `"distortion, warping, people, flickering"`.

### 3.4 `video/probe.js`

```
ffprobe -v error -select_streams v:0
  -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt
  -show_entries format=duration -of json <file>
```
→ `{ codec, width, height, fps, pixFmt, duration }`, with `fps` parsed from `r_frame_rate` ("24/1" → 24, "30000/1001" → 29.97) and `duration` as float seconds. Throws `ffmpeg`-coded error on unparseable files (this is what catches a corrupt download that somehow got past the `ftyp` check).

### 3.5 `video/xfadeMath.js` (pure, unit-tested first)

```js
export function xfadeOffsets(durations, td) {
  // offsets[k] = sum(durations[0..k]) - (k+1) * td   for k in 0..n-2
}
export function totalDuration(durations, td) {
  // sum(durations) - (durations.length - 1) * td
}
```
Also `validateTransition(durations, td)` → throws `validation` if `td <= 0` or `td >= min(durations)`.

Test vectors to encode in `test/xfadeMath.test.js` (real Kling-like durations, not round numbers):
- `[5.07, 5.04, 5.10], td=0.75` → offsets `[4.32, 8.61]`, total `13.71`
- `[5.0], td=0.75` → offsets `[]` (single clip)
- `td=5.0` with a 5.04s clip → throws

### 3.6 `video/stitch.js`

`stitch(clipPaths, { transition, td, outPath })`:

1. `probe()` every clip.
2. **Target format**: first clip's `width×height` rounded down to even, first clip's `fps`, `yuv420p`.
3. **Uniform + cut fast path**: all clips match target exactly and `transition === "cut"` →
   ```
   ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart out.mp4
   ```
   (`list.txt` written to the OS temp dir with absolute `file '…'` lines; stream copy, lossless, <1s.)
4. **Everything else** (any mismatch, or crossfade): one ffmpeg invocation, per-input normalization chains feeding either `concat` filter (cut) or chained `xfade` (crossfade):
   - per input `i`: `[i:v]scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=FPS,settb=AVTB,format=yuv420p[v{i}]`
     (scale-then-pad = the letterbox policy; `settb=AVTB` because xfade requires identical timebases)
   - crossfade: `[v0][v1]xfade=transition=fade:duration=TD:offset=O0[x0]; [x0][v2]xfade=…:offset=O1[x1]; …` with offsets from `xfadeOffsets(probedDurations, td)`
   - encode: `-map "[last]" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart -an`
   - `-an` always: Kling clips are silent; never emit a half-audio walkthrough.
5. Run ffmpeg via `child_process.execFile` (args array — **never** a shell string; filtergraphs full of `;` and `,` must not touch a shell), `stdio: ['ignore','ignore','pipe']`, capture stderr; on non-zero exit throw `ffmpeg` error with the last 15 lines of stderr in the message.
6. Probe the output for its real duration; return `{ outputPath, durationSeconds }`.

### 3.7 Tool registrations (`src/index.js`)

All seven via `server.registerTool(name, { description, inputSchema }, handler)` with zod raw shapes:

| tool | zod input schema | handler = thin glue over |
|---|---|---|
| `describe_ontology` | `{}` | return `ontology.js` static object (entities, relationships, lifecycle, tools list) |
| `list_motion_presets` | `{}` | return `PRESETS` with reliability notes |
| `list_clips` | `{}` | `listSidecars()` + per-clip `existsSync(mp4)` → `downloaded` flag; no network |
| `generate_clip` | `{ photo_source: z.string(), motion: z.string().optional(), custom_prompt: z.string().optional(), negative_prompt: z.string().optional(), duration: z.union([z.literal(5), z.literal(10)]).default(5), room_label: z.string().optional() }` | `exactlyOne` → resolve preset (unknown key → `validation` error listing valid keys) → `preflightPhoto` → `createClip` → `writeSidecar` → echo payload with `status:"processing"` |
| `check_clip` | `{ clip_ids: z.array(z.string()).min(1), wait_seconds: z.number().min(0).max(60).optional() }` | assert every id first; loop: `ensureClipLocal` per id (parallel, `Promise.all`); if any `processing` and wait budget remains, sleep 4s and repeat; return per-clip array |
| `cancel_clip` | `{ clip_id: z.string() }` | assert id → `cancelClip` → report terminal state |
| `stitch_walkthrough` | `{ clips: z.array(z.string()).min(1), transition: z.enum(["crossfade","cut"]).default("crossfade"), transition_duration_seconds: z.number().default(0.75), output_name: z.string().optional() }` | assert ids → `ensureClipLocal` for all (this is where "succeeded but never downloaded" self-heals) → if any not succeeded, `not_ready` error listing each offender as `clip_id: actual status` → `validateTransition` on probed durations → `stitch` → `{ output: { path }, clip_count, duration_seconds }` |

`check_clip`'s wait loop uses a monotonic deadline (`Date.now() + wait_seconds*1000`, hard-capped at 60s); one Replicate GET per pending clip per 4s cycle.

---

## 4. Milestones

Each milestone ends with a git commit and its acceptance criteria demonstrably passing. Estimated external spend is marked per milestone; total build budget ≈ **$4–6**.

### M0 — Scaffold & stdio discipline ($0)
Build: `git init`, `package.json`, `npm install`, `.gitignore`, `log.js`, `config.js` with all four startup checks, `index.js` with `describe_ontology` registered (static stub), stdio transport connected.
Verify:
- `REPLICATE_API_TOKEN=x npx @modelcontextprotocol/inspector node src/index.js` → Inspector connects, lists 1 tool, calls it.
- Unset token → process exits 1 with the one-line message, nothing on stdout.
- `grep -rn "console.log\|process.cwd" src/` → empty.

### M1 — Static tools ($0)
Build: `ontology.js` (full payload incl. tools list), `motionPresets.js`, `list_motion_presets`, `list_clips`, `validate.js` + `test/validate.test.js`.
Verify: `node --test` green; in Inspector, `list_clips` returns `[]` on empty dir and correct rows against two hand-written sidecar fixtures (one with a matching fixture `.mp4`, one without → `downloaded: false`); `assertClipId("../../etc")` throws.

### M2 — `generate_clip` (~$1: 2–3 real predictions)
Build: `providers/replicate.js`, preflight wiring, sidecar writes.
Verify, in order (free failures first):
1. Missing file, an HEIC file, a 200×150 thumbnail, a panorama beyond 2.5:1 → four distinct `photo_preflight` messages, zero API calls.
2. Both `motion` and `custom_prompt` → `validation` error naming both.
3. One real room photo **> 1 MB** (this specifically exercises the Files-API upload path, the plan's known risk) → `clip_id` returned in < 5s, sidecar JSON on disk matching §2.5, prediction visible at replicate.com dashboard.

### M3 — `check_clip` + `cancel_clip` (~$1)
Build: `storage.js` download/ensure logic, both tools.
Verify:
1. `check_clip` on M2's clip_id with `wait_seconds: 55`, repeated until `succeeded` → `.mp4` in `storage/clips/`, plays in QuickTime, no `.part` left behind.
2. Same call again → returns instantly; confirm via log line that no Replicate request was made (disk-first).
3. Batch call with one valid + one garbage-but-well-formed id → per-clip results: one `succeeded`, one `not_found`-style `failed`; malformed id → whole-call `validation` error.
4. Submit a fresh clip, `cancel_clip` within ~10s → `failed` with `canceled:` error; dashboard shows canceled (billing stopped).
5. Simulate expiry: hand-edit a sidecar to a fake old id → `expired_output` message path exercised.

### M4 — Stitch math + ffmpeg against dummy clips ($0 — **before** real content, so stitch debugging never burns API money)
Build: `xfadeMath.js` + tests, `probe.js`, `stitch.js`.
Prepare fixtures with ffmpeg-static itself: three `testsrc2` clips at deliberately awkward specs — 1280×720@24 5.07s, 1920×1080@30 5.04s, **720×1280 (portrait)** 5.10s.
Verify:
- `node --test` green on the §3.5 vectors.
- Cut + uniform triple (make 3 identical-spec clips too) → output via concat demuxer path (assert by log line), stream-copied, opens in QuickTime.
- Crossfade on the mixed trio → output is 1280×720 (first clip wins), portrait clip letterboxed not distorted, duration ≈ 13.71s ± 0.1, transitions land where expected on scrub, no frozen frames.
- `td: 5.0` → `validation`; single clip → passthrough normalize only; one path replaced by a text file renamed `.mp4` → clean `ffmpeg` error, not a crash.

### M5 — End-to-end on real photos (~$1.50: 4 clips)
4 real room photos of one property, **at least one portrait**, different rooms: `generate_clip` ×4 (varied presets) → batch `check_clip` with waits → `stitch_walkthrough` crossfade.
Acceptance: one watchable ≥18s 1080p walkthrough in `storage/output/`; total tool calls for the property ≤ ~10 (the batch+wait design working); `list_clips` in a **fresh Inspector session** shows all four with room labels (cross-session continuity proven).

### M6 — Preset tuning (~$2–3, the deliberately budgeted iteration step)
For each preset: run against 2 room photos, grade watchability, iterate prompt text / default negative_prompt once or twice where weak, and rewrite `reliability_note`s to match observed reality (expectation: `orbit` gets an honest warning or is dropped). Output: updated `motionPresets.js` — this is a data change, no code.

### M7 — README + Claude Desktop wiring ($0)
README contains: setup (`npm install`, get Replicate token), the exact Claude Desktop config snippet:
```json
{ "mcpServers": { "viewmax": {
    "command": "/absolute/path/to/node",
    "args": ["/Users/zainabnasir/Desktop/viewMax/src/index.js"],
    "env": { "REPLICATE_API_TOKEN": "r8_…" }
} } }
```
(absolute node path — Desktop doesn't inherit your shell PATH; env block — not shell profile), cost table (~$0.35/5s clip, duration 10 ≈ 2×), preset reliability table, and a worked example conversation (photos → walkthrough).
Final acceptance: from a clean Claude Desktop restart, drive the full M5 flow purely via Claude chat.

---

## 5. Deferred (unchanged from design doc §9)

Second provider (needs prefixed clip_ids), whole-property orchestrator tool, webhooks, database, cloud storage/auth/rate-limiting, center-crop aspect policy, `list_clips` filtering. The cloud transition contract audit is design doc §10.
