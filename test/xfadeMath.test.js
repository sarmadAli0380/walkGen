import { test } from "node:test";
import assert from "node:assert/strict";
import { xfadeOffsets, totalDuration, validateTransition } from "../src/video/xfadeMath.js";

test("offsets for realistic Kling durations", () => {
  const d = [5.07, 5.04, 5.1];
  assert.deepEqual(xfadeOffsets(d, 0.75), [4.32, 8.61]);
  assert.equal(totalDuration(d, 0.75), 13.71);
});

test("single clip -> no offsets", () => {
  assert.deepEqual(xfadeOffsets([5.0], 0.75), []);
  assert.equal(totalDuration([5.0], 0.75), 5.0);
});

test("two clips -> one offset", () => {
  assert.deepEqual(xfadeOffsets([5.0, 5.0], 0.75), [4.25]);
  assert.equal(totalDuration([5.0, 5.0], 0.75), 9.25);
});

test("validateTransition rejects td >= shortest clip", () => {
  assert.throws(() => validateTransition([5.04, 5.07], 5.04), /shorter than the shortest clip/);
  assert.throws(() => validateTransition([5.04, 5.07], 6.0), /shorter than the shortest clip/);
  assert.throws(() => validateTransition([5.0], 0), /must be > 0/);
});

test("validateTransition accepts a sane td", () => {
  assert.doesNotThrow(() => validateTransition([5.04, 5.07, 5.1], 0.75));
});
