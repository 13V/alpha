import assert from "node:assert/strict";
import { test } from "node:test";

import { pollDelay } from "./poll";

test("polls quickly while a fast run could still land", () => {
  // a warm trace has finished in 9s; a flat 2.5s interval would waste a
  // quarter of that waiting after the answer was already ready
  assert.equal(pollDelay(0), 800);
  assert.equal(pollDelay(9_000), 800);
});

test("backs off once the run is clearly a long one", () => {
  assert.equal(pollDelay(10_000), 2_000);
  assert.equal(pollDelay(29_999), 2_000);
  assert.equal(pollDelay(30_000), 3_000);
  assert.equal(pollDelay(10 * 60_000), 3_000);
});

test("never returns something that would spin or stall", () => {
  for (const t of [0, 1, 999, 9_999, 10_001, 60_000, 15 * 60_000]) {
    const d = pollDelay(t);
    assert.ok(d >= 500, `${d}ms at ${t}ms would hammer the api`);
    assert.ok(d <= 5_000, `${d}ms at ${t}ms would sit on a finished result`);
  }
});
