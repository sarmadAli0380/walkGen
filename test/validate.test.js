import { test } from "node:test";
import assert from "node:assert/strict";
import { assertClipId, sanitizeOutputName, exactlyOne } from "../src/lib/validate.js";

test("assertClipId accepts real-looking IDs, rejects traversal", () => {
  assert.equal(assertClipId("abc123def456"), "abc123def456");
  assert.throws(() => assertClipId("../../etc/passwd"), /invalid clip_id/);
  assert.throws(() => assertClipId("short"), /invalid clip_id/);
  assert.throws(() => assertClipId("HasUpper123456"), /invalid clip_id/);
  assert.throws(() => assertClipId(""), /invalid clip_id/);
});

test("sanitizeOutputName rejects unsafe names, defaults when empty", () => {
  assert.equal(sanitizeOutputName("my_walkthrough-1"), "my_walkthrough-1");
  assert.throws(() => sanitizeOutputName("../evil"), /invalid output_name/);
  assert.throws(() => sanitizeOutputName("has space"), /invalid output_name/);
  assert.match(sanitizeOutputName(), /^walkthrough-\d{8}-\d{6}$/);
});

test("exactlyOne enforces one-of motion/custom_prompt", () => {
  assert.throws(() => exactlyOne("push_in", "some prompt"), /not both/);
  assert.throws(() => exactlyOne(undefined, undefined), /provide one of/);
  assert.throws(() => exactlyOne("no_such_preset", undefined), /unknown motion preset/);
  assert.doesNotThrow(() => exactlyOne("push_in", undefined));
  assert.doesNotThrow(() => exactlyOne(undefined, "free text"));
});
