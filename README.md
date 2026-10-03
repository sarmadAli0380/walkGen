# viewMax MCP Server

A backend-only [MCP](https://modelcontextprotocol.io) server that turns a set of property room photos into a single AI-generated video walkthrough. No frontend — every interaction is an MCP tool call. Video generation is [Kling](https://replicate.com/kwaivgi/kling-v2.5-turbo-pro) via [Replicate](https://replicate.com); stitching is local `ffmpeg`.

## How it works

The design is **fire-and-poll**: `generate_clip` submits one photo and returns immediately with a `clip_id`; `check_clip` polls status and downloads finished clips; `stitch_walkthrough` concatenates them into one video. There is no database — `clip_id` *is* the Replicate prediction ID, and the `storage/` directory is the registry (a `.json` sidecar per clip + the downloaded `.mp4`).

### Tools

| Tool | Purpose |
|---|---|
| `describe_ontology` | Returns the entity model, clip lifecycle, and tool map. Call first. |
| `list_motion_presets` | The camera-movement presets, each with an honest reliability note. |
| `list_clips` | Enumerate known clips from local metadata (no network). |
| `generate_clip` | Submit one photo for animation. Returns a `clip_id` in `processing`. |
| `check_clip` | Batch status check; downloads succeeded clips. Optional bounded `wait_seconds`. |
| `cancel_clip` | Cancel an in-progress clip to stop billing. |
| `stitch_walkthrough` | Concatenate succeeded clips (in order) into one walkthrough. |

## Setup

1. **Install** (needs Node ≥ 20; `ffmpeg`/`ffprobe` are bundled via npm, no system install):
   ```
   npm install
   ```
2. **Get a Replicate API token** at <https://replicate.com/account/api-tokens> (one account-wide token covers all models, including Kling). Add a payment method at <https://replicate.com/account/billing> — Replicate is pay-as-you-go and predictions fail without one.
3. **Set the token.** For local testing you can export it in your shell; for Claude Desktop it goes in the config `env` block (below).

## Connecting to Claude Desktop

Edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "viewmax": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/zainabnasir/Desktop/viewMax/src/index.js"],
      "env": {
        "REPLICATE_API_TOKEN": "r8_your_token_here"
      }
    }
  }
}
```

Two things people get wrong:
- **Use an absolute path to `node`** (`which node`). Claude Desktop does not inherit your shell `PATH`.
- **The token goes in the `env` block**, not your shell profile — the server is launched by Claude Desktop, not your terminal. The server does *not* read `.env` files (a dotenv banner on stdout would corrupt the stdio JSON-RPC stream).

Restart Claude Desktop after editing. Verify with the MCP Inspector any time:
```
REPLICATE_API_TOKEN=r8_... npm run inspect
```

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `REPLICATE_API_TOKEN` | yes | — | fails fast at startup if missing |
| `KLING_MODEL` | no | `kwaivgi/kling-v2.5-turbo-pro` | see cost note below |
| `STORAGE_DIR` | no | `storage/` next to the server script | never relative to cwd |

## Cost

Kling `v2.5-turbo-pro` is roughly **$0.35 per 5-second clip** (1080p); `duration: 10` costs about 2×. A 6-room walkthrough is on the order of **$2**, plus any retries. Verify current pricing on the Replicate model page — it changes.

Cheaper fallback if needed: set `KLING_MODEL=kwaivgi/kling-v2.1` (the adapter pins it to `standard` mode, ~720p, ~$0.25/clip).

## Motion presets

Presets are prompt text only — the Replicate Kling wrapper does not expose native camera controls, so camera adherence is a suggestion, not a guarantee.

| key | reliability |
|---|---|
| `push_in` | most reliable |
| `pull_out` | reliable |
| `dolly_forward` | reliable |
| `pan_left_right` / `pan_right_left` | usually works; watch frame edges |
| `orbit` | least reliable — invents unseen geometry on interiors |

Use `custom_prompt` instead of `motion` for a free-text override.

## Example flow

1. `generate_clip` for each room photo (pick a preset per room).
2. `check_clip` with all the returned `clip_ids` and `wait_seconds: 60`, repeat until all `succeeded`.
3. `stitch_walkthrough` with the `clip_ids` in the order you want the rooms to appear.
4. The result is at the returned `output.path`.

## Photo requirements

JPG or PNG (HEIC is rejected — convert iPhone photos first), ≥ 300px on the short side, aspect ratio within 2.5:1, ≤ 10 MB. Local paths and `http(s)` URLs are both accepted.

## Development

```
npm test        # pure-logic unit tests (xfade math, validators)
npm run inspect # interactive tool testing via MCP Inspector
```

Project layout and the milestone build plan are in `IMPLEMENTATION_PLAN.md`.
