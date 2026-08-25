import assert from "node:assert/strict";
import { test } from "node:test";

import { isScanFailure, resolveScan } from "./scan";

const SOLANA_MINT = "GUmbtfjSZkybSFgPibBcvwExEBdXwewJHR5PkTjzpump";
const EVM_TOKEN = "0x532f27101965dd16442E59d40670FaF5eBB142E4";

/** resolveScan with the fields every request needs, so tests state only what they vary. */
function scan(over: Record<string, unknown> = {}) {
  return resolveScan({ apiKey: "k", token: SOLANA_MINT, mode: "traders", ...over });
}

function ok(result: ReturnType<typeof scan>) {
  assert.ok(!isScanFailure(result), `expected success, got: ${JSON.stringify(result)}`);
  return result as Exclude<typeof result, { error: string }>;
}

test("a request without a key is refused before anything reaches Dune", () => {
  const result = resolveScan({ token: SOLANA_MINT, mode: "traders" });
  assert.ok(isScanFailure(result));
});

test("a token that is neither a mint nor an 0x address is refused", () => {
  for (const token of ["", "   ", "hello", "0x123", "not-an-address"]) {
    assert.ok(isScanFailure(scan({ token })), `accepted ${JSON.stringify(token)}`);
  }
});

test("chain is inferred from a Solana mint and required for an EVM address", () => {
  assert.equal(ok(scan()).chain, "solana");
  // an 0x address is ambiguous across EVM chains, so the caller has to say
  assert.equal(ok(scan({ token: EVM_TOKEN, chain: "base" })).chain, "base");
});

test("an unknown chain name is refused rather than guessed at", () => {
  assert.ok(isScanFailure(scan({ token: EVM_TOKEN, chain: "dogechain" })));
});

test("minUsd survives text, blanks and nonsense without becoming NaN", () => {
  // NaN here would reach the SQL as a parameter and silently return no rows
  for (const minUsd of ["", "abc", undefined, null, NaN, {}]) {
    const resolved = ok(scan({ minUsd }));
    assert.ok(Number.isFinite(resolved.minUsd), `minUsd became ${resolved.minUsd} for ${String(minUsd)}`);
  }
});

test("minUsd accepts a real number and never goes negative", () => {
  assert.equal(ok(scan({ minUsd: 250 })).minUsd, 250);
  assert.equal(ok(scan({ minUsd: "250" })).minUsd, 250);
  assert.equal(ok(scan({ minUsd: -5 })).minUsd, 0);
});

test("limit is clamped into range instead of being passed through", () => {
  assert.equal(ok(scan({ limit: 100 })).limit, 100);
  assert.equal(ok(scan({ limit: 0 })).limit, 100, "0 should fall back to the default, not ask for nothing");
  assert.equal(ok(scan({ limit: -10 })).limit, 1);
  assert.ok(ok(scan({ limit: 99_999 })).limit <= 500);
});

test("lookbackDays is clamped, so a bad value cannot widen the scan without bound", () => {
  const wide = ok(scan({ lookbackDays: 99_999 }));
  assert.ok(wide.lookbackDays <= 1095, `lookback ran to ${wide.lookbackDays}`);
  assert.ok(ok(scan({ lookbackDays: -1 })).lookbackDays >= 1);
  assert.equal(ok(scan({ lookbackDays: 7 })).lookbackDays, 7);
});

test("a resolved scan carries a query plan with the token in its parameters", () => {
  const resolved = ok(scan({ lookbackDays: 7 }));
  assert.equal(resolved.plan.parameters.token_address, SOLANA_MINT);
  assert.equal(resolved.plan.parameters.lookback_days, 7);
  assert.ok(Number.isInteger(resolved.plan.queryId));
});

test("the api key is carried for the request but never lands in the plan", () => {
  // the plan is what gets cached and logged; the key must not be in it
  const resolved = ok(scan({ apiKey: "secret-key-value" }));
  assert.equal(resolved.apiKey, "secret-key-value");
  assert.ok(!JSON.stringify(resolved.plan).includes("secret-key-value"));
});
