import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatMultiple,
  formatPrice,
  formatRoi,
  formatUsd,
  parseDuneTime,
  shortAddress,
} from "./format";

test("formatPrice does not shift a decade when rounding carries", () => {
  // The bug this guards: leading zeros were counted from log10 while the digits
  // came from toExponential, so a value whose mantissa rounded up into the next
  // decade kept the old zero count and rendered ten times too small.
  //
  // 0.0009 has three leading zeros and stays there. 0.000999999 rounds to
  // 0.001, which has two — the zero count has to move with the carry.
  assert.equal(formatPrice(0.0009), "$0.0₃9000");
  assert.equal(formatPrice(0.000999999), "$0.0₂1000");
  assert.equal(formatPrice(0.0000999999), "$0.0₃1000");
  // and the same carry across the subscript threshold
  assert.equal(formatPrice(0.00999999), "$0.010000");
});

test("formatPrice switches to subscript at two leading zeros", () => {
  assert.equal(formatPrice(0.12), "$0.1200");
  assert.equal(formatPrice(0.01), "$0.0100");
  assert.equal(formatPrice(0.005), "$0.0₂5000");
  assert.equal(formatPrice(0.0005), "$0.0₃5000");
  assert.equal(formatPrice(0.00000123), "$0.0₅1230");
});

test("formatPrice treats zero and nonsense as no price, not as free", () => {
  for (const v of [0, null, undefined, NaN, Infinity]) {
    assert.equal(formatPrice(v as number), "—");
  }
});

test("formatUsd keeps the sign outside the currency symbol", () => {
  assert.equal(formatUsd(-8420), "-$8.42K");
  assert.equal(formatUsd(65_870), "$65.87K");
  assert.equal(formatUsd(1_283_400), "$1.28M");
  assert.equal(formatUsd(null), "—");
});

test("formatMultiple shows the digit that explains a near-1.00 result", () => {
  // "1.00x" printed in loss red reads as a rendering bug, so a value that only
  // rounds to 1.00 gets a third digit. An actual 1 keeps two.
  assert.equal(formatMultiple(0.996), "0.996x");
  assert.equal(formatMultiple(1.004), "1.004x");
  assert.equal(formatMultiple(1), "1.00x");
  // outside that band, two digits
  assert.equal(formatMultiple(0.995), "0.99x");
  assert.equal(formatMultiple(1.006), "1.01x");
  // three digits or more drop the decimals entirely
  assert.equal(formatMultiple(398.2), "398x");
  assert.equal(formatMultiple(0), "—");
  assert.equal(formatMultiple(-2), "—");
});

test("formatRoi signs gains and leaves losses their own minus", () => {
  assert.equal(formatRoi(1.38), "+138%");
  assert.equal(formatRoi(-0.38), "-38%");
  assert.equal(formatRoi(0), "0%");
  assert.equal(formatRoi(null), "—");
});

test("parseDuneTime reads the format Dune actually returns", () => {
  // "2026-08-19 23:52:38.000 UTC" — a space separator and a UTC suffix, which
  // Date cannot parse on its own
  const t = parseDuneTime("2026-08-19 23:52:38.000 UTC");
  assert.equal(t, Date.parse("2026-08-19T23:52:38.000Z"));
});

test("parseDuneTime returns null rather than NaN for junk", () => {
  for (const v of [null, undefined, "", "not a date"]) {
    assert.equal(parseDuneTime(v as string), null);
  }
});

test("parseDuneTime treats a bare timestamp as UTC, not as local time", () => {
  assert.equal(parseDuneTime("2026-08-19 23:52:38"), Date.parse("2026-08-19T23:52:38Z"));
});

test("shortAddress keeps both ends and leaves short strings whole", () => {
  assert.equal(shortAddress("MRiYA4oN3158fCV8evhuCofrDzbHyYvYnGZUDJvoCsa"), "MRiY…oCsa");
  assert.equal(shortAddress("MRiYA4oN3158fCV8evhuCofrDzbHyYvYnGZUDJvoCsa", 6, 4), "MRiYA4…oCsa");
  assert.equal(shortAddress("short"), "short");
  assert.equal(shortAddress(""), "");
});
