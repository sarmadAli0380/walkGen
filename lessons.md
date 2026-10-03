# Lessons Log

Mistakes made during this project, recorded so they are never repeated. Newest first.

---

## L4 — Batch-submitting to a rate-limited API without spacing or 429 handling

**What I did wrong:** The first real batch run fired 9 `generate_clip` submissions back-to-back. Replicate throttles low-credit accounts to ~1 prediction submission per 10 seconds (burst of 1), so 3 of 9 submissions bounced with HTTP 429 — even though the response *told us exactly what to do* (`retry_after: 3`). The submission loop ignored it and just moved on, leaving 3 rooms unsubmitted.

**Why it mattered:** A third of the batch silently didn't happen on the first attempt. In an agent-driven flow (Claude calling the tools), the caller would have had to notice and manually resubmit.

**The lesson:** Any loop that creates provider resources must expect and handle throttling: space submissions to the documented/observed rate, and on 429 honor `retry_after` with a bounded retry instead of failing outright. Rate limits are part of the provider contract, not an edge case — especially the *tighter limits on low-credit/trial accounts*, which is exactly the state a new user testing the pipeline will be in.

**How to apply going forward:** The `providers/replicate.js` adapter should retry 429s internally (bounded, honoring `retry_after`) so every caller gets this for free rather than each script reimplementing it. Also surfaced: a transient download failure ("fetch failed") is recoverable by simply re-calling `check_clip` — the prediction still exists remotely — which the disk-first design already handles; scripts should re-check before assuming a clip is lost.

**Fixed in:** retry handling added to the batch scripts; adapter-level 429 retry is the durable follow-up.

---

## L3 — A timeout that only covers connection setup, not the whole transfer

**What I did wrong:** In `fetchImageForPreflight` I armed an `AbortController` timeout, then `clearTimeout`-ed it immediately after `await fetch()` resolved — but `fetch()` resolves as soon as the **response headers** arrive, before the body is read. So the timeout guarded only header negotiation. A server that flushes headers (even one body byte) and then stalls the socket left the `reader.read()` loop — and the whole `generate_clip` call — hanging **indefinitely**. My own "slow server" test missed it because it withheld headers, so `fetch()` itself never resolved; the gap only appears once headers flush and the body stalls.

**Why it mattered:** The feature promised "a slow/hanging URL eventually times out rather than hang forever," and it didn't. A malicious or broken image URL could pin a request forever. It was caught by QA, not by me, precisely because my test exercised the wrong half of the transfer.

**The lesson:** A network timeout must cover the operation you actually care about — for a download that's headers **and** body, not just the connection. Don't disarm a timeout at the point a promise resolves if meaningful work continues after it (streamed bodies, follow-up reads). Prefer a per-chunk inactivity deadline (re-armed on each read) so slow-but-progressing transfers are allowed while true stalls are aborted.

**How to apply going forward:** When testing timeouts, test the *stall-after-progress* case (headers/first-chunk delivered, then silence), not just connect-refused or headers-withheld — those exercise different code paths. Make the timeout duration injectable (env/param) so the stall path can be tested in milliseconds instead of the production timeout.

**Fixed in:** `src/lib/validate.js` (`fetchImageForPreflight` now re-arms the abort timer before every `reader.read()` and only disarms in `finally`); regression test `test/preflight.test.js` (`/stall` route + injectable `VIEWMAX_FETCH_TIMEOUT_MS`).

---

## L2 — Validation applied to one input variant but silently skipped for another

**What I did wrong:** `preflightPhoto` accepts either a local path or an `http(s)` URL. I ran the full battery of checks (format/HEIC rejection, ≤10 MB, ≥300px, ≤2.5:1 aspect) for local files, but for URL sources I returned immediately with `{ isUrl: true, source }` — zero validation. Meanwhile the README/tool contract promised those requirements unconditionally. So a HEIC / oversized / extreme-aspect image passed by URL sailed straight into a **paid** Replicate prediction, the exact cost/quality failure preflight exists to prevent.

**Why it mattered:** The contract said one thing; the code enforced it for only one of two equally-common input paths. The gap was invisible in local-file testing and only appeared with URL inputs — and its cost was real money on a bad prediction.

**The lesson:** When an input has multiple accepted forms (path vs URL, string vs object, etc.), every documented guarantee must hold for *all* forms, or the contract must explicitly say which form is exempt. Don't let the easy-to-check variant define the guarantee and let the harder one slip through. Factor the shared checks into one function both paths call (here: `checkImageBuffer`), so it's structurally impossible for one path to skip them.

**Guardrails added:** URL sources are now fetched (with a 15s timeout and a hard 10 MB streaming cap to avoid hangs / memory blowup) and run through the identical `checkImageBuffer` as local files. Regression test `test/preflight.test.js` covers both local and URL paths, including the previously-bypassed URL-HEIC case.

**Fixed in:** `src/lib/validate.js` (`preflightPhoto` now async, shared `checkImageBuffer`, capped `fetchImageForPreflight`); `src/index.js` awaits it.

---

## L1 — `Promise.all` poisons batch operations where individual items can fail

**What I did wrong:** Implemented the batch `check_clip` tool (and the per-clip resolution in `stitch_walkthrough`) with `Promise.all` over a map that could throw. Because `ensureClipLocal` throws (via `fail()`) on a `not_found`/`provider` error, a single bad clip_id — e.g. an expired or mistyped Replicate prediction that 404s on lookup — rejected the *entire* `Promise.all`, which the tool wrapper turned into one top-level error. The status of every other clip in the batch, including clips already downloaded to disk, was silently discarded.

**Why it mattered:** It defeated the whole point of a *batch* status check in a fire-and-poll design. Replicate prediction outputs expire, so during a long multi-room run one early clip going bad would blind the agent to the state of all the others.

**The lesson:** For any batch/independent operation, one item's failure must not discard the others' results. Resolve each item behind its own `try/catch` (or use `Promise.allSettled`) and map failures into per-item result entries. Reserve `Promise.all`-that-rejects for the case where the items are genuinely all-or-nothing.

**How to apply going forward:** When a tool takes an array and does independent work per element, the default shape is: `const resolveOne = async (x) => { try { ... } catch (e) { return {…, status:"failed", error:msg} } }; await Promise.all(items.map(resolveOne))`. Never let a per-element async map throw.

**Fixed in:** `src/index.js` — `check_clip` and `stitch_walkthrough` handlers now use a non-throwing `resolveOne`.
