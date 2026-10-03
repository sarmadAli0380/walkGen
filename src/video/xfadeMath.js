import { fail } from "../errors.js";

// Chained xfade offsets. Each xfade overlaps the previous accumulated output
// with the next clip; the k-th offset (0-indexed, for k in 0..n-2) is where the
// transition into clip k+1 begins on the timeline built so far:
//   offset_k = sum(durations[0..k]) - (k+1) * td
export function xfadeOffsets(durations, td) {
  const offsets = [];
  let acc = 0;
  for (let k = 0; k < durations.length - 1; k++) {
    acc += durations[k];
    offsets.push(+(acc - (k + 1) * td).toFixed(3));
  }
  return offsets;
}

// Total runtime after n-1 crossfades each of length td.
export function totalDuration(durations, td) {
  const sum = durations.reduce((a, b) => a + b, 0);
  return +(sum - (durations.length - 1) * td).toFixed(3);
}

export function validateTransition(durations, td) {
  if (!(td > 0)) fail("validation", `transition_duration_seconds must be > 0 (got ${td})`);
  const shortest = Math.min(...durations);
  if (td >= shortest)
    fail(
      "validation",
      `transition_duration_seconds (${td}) must be shorter than the shortest clip (${shortest.toFixed(2)}s)`
    );
}
