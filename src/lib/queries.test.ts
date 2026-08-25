import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DISPLAY_COLUMNS, normalizeRow, planQuery, summaryFromRows } from "./queries";

/**
 * Dune answers a column name a query does not return with `400 unknown
 * column`, not by ignoring it. A mismatch between DISPLAY_COLUMNS and the SQL
 * therefore fails every request for that mode and chain, and nothing else in
 * this repo can catch it: the compiler sees string literals, and the stub
 * answers whatever it is asked. It shipped once already, breaking both holders
 * queries, so it is the first thing tested.
 */
const QUERY_FILES = {
  traders: { svm: "dune/top_traders_solana.sql", evm: "dune/top_traders_evm.sql" },
  holders: { svm: "dune/top_holders_solana.sql", evm: "dune/top_holders_evm.sql" },
} as const;

/** Column names the final SELECT of a query file actually produces. */
function selectedColumns(path: string): Set<string> {
  const sql = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  // the last top-level SELECT is the one whose columns come back
  const select = sql.slice(sql.lastIndexOf("\nSELECT"));
  const body = select.slice(0, select.search(/\nFROM /));
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const aliased = line.match(/\bAS\s+([a-z_][a-z0-9_]*)\s*,?\s*$/i);
    if (aliased) {
      names.add(aliased[1].toLowerCase());
      continue;
    }
    // bare column, optionally table-qualified: "    r.wallet," or "    wallet,"
    const bare = line.match(/^\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*,?\s*$/i);
    if (bare) names.add(bare[1].toLowerCase());
  }
  return names;
}

for (const [mode, byChain] of Object.entries(QUERY_FILES)) {
  for (const [kind, path] of Object.entries(byChain)) {
    test(`every ${mode}/${kind} display column exists in ${path}`, () => {
      const available = selectedColumns(path);
      // guard the parser itself: every query returns these two
      assert.ok(available.has("wallet"), `parsed no columns from ${path}`);
      assert.ok(available.has("rank"), `parsed no rank from ${path}`);

      const asked = DISPLAY_COLUMNS[mode as keyof typeof QUERY_FILES][kind as "svm" | "evm"];
      const missing = asked.filter((c) => !available.has(c));
      assert.deepEqual(
        missing,
        [],
        `${mode}/${kind} asks Dune for ${missing.join(", ")}, which ${path} does not return — ` +
          `Dune answers 400 unknown column, so every ${mode} request on ${kind} would fail`,
      );
    });
  }
}

test("display columns cover what the header reads off the first row", () => {
  for (const kind of ["svm", "evm"] as const) {
    for (const mode of ["traders", "holders"] as const) {
      const asked = new Set(DISPLAY_COLUMNS[mode][kind]);
      assert.ok(asked.has("token_symbol"), `${mode}/${kind} drops token_symbol`);
      assert.ok(asked.has("circulating_supply"), `${mode}/${kind} drops circulating_supply`);
      assert.ok(asked.has("wallet"), `${mode}/${kind} drops wallet`);
      assert.ok(asked.has("rank"), `${mode}/${kind} drops rank`);
    }
  }
});

test("normalizeRow coerces Dune's stringified decimals", () => {
  const row = normalizeRow(
    {
      rank: "3",
      wallet: "abc",
      realized_pnl_usd: "1234.5",
      profit_multiple: "2.5",
      tokens_held: "0E0",
      buy_coverage: "1",
    },
    0,
  );
  assert.equal(row.rank, 3);
  assert.equal(row.realizedPnlUsd, 1234.5);
  assert.equal(row.profitMultiple, 2.5);
  assert.equal(row.tokensHeld, 0);
  assert.equal(row.buyCoverage, 1);
});

test("normalizeRow falls back to the row index when rank is absent", () => {
  assert.equal(normalizeRow({ wallet: "a" }, 0).rank, 1);
  assert.equal(normalizeRow({ wallet: "a" }, 41).rank, 42);
});

test("normalizeRow keeps missing numbers null rather than zero", () => {
  // a dropped column must not read as "made no money"
  const row = normalizeRow({ wallet: "a" }, 0);
  assert.equal(row.realizedPnlUsd, null);
  assert.equal(row.profitMultiple, null);
  assert.equal(row.usdSpent, null);
  assert.equal(row.buyCoverage, null);
});

test("normalizeRow discards non-numeric junk instead of emitting NaN", () => {
  const row = normalizeRow({ wallet: "a", realized_pnl_usd: "n/a", tokens_sold: "" }, 0);
  assert.equal(row.realizedPnlUsd, null);
  assert.equal(row.tokensSold, null);
});

test("normalizeRow reads the holders queries' last_activity as lastTrade", () => {
  assert.equal(normalizeRow({ wallet: "a", last_activity: "2026-08-01" }, 0).lastTrade, "2026-08-01");
  // last_trade wins when a query returns both
  assert.equal(
    normalizeRow({ wallet: "a", last_trade: "A", last_activity: "B" }, 0).lastTrade,
    "A",
  );
});

test("normalizeRow reads EVM native amounts as well as Solana's", () => {
  assert.equal(normalizeRow({ wallet: "a", sol_spent: "1.5" }, 0).nativeSpent, 1.5);
  assert.equal(normalizeRow({ wallet: "a", native_spent: "2.5" }, 0).nativeSpent, 2.5);
});

test("summaryFromRows reads the token-wide values off the first row", () => {
  const s = summaryFromRows([
    { circulating_supply: "1000000000", current_mcap: "50000", token_symbol: "X", holder_count: "12" },
    { circulating_supply: "1000000000" },
  ]);
  assert.equal(s.circulatingSupply, 1e9);
  assert.equal(s.currentMcap, 50000);
  assert.equal(s.tokenSymbol, "X");
  assert.equal(s.holderCount, 12);
});

test("summaryFromRows survives an empty result", () => {
  assert.deepEqual(summaryFromRows([]), {
    circulatingSupply: null,
    currentMcap: null,
    tokenSymbol: null,
    holderCount: null,
  });
});

test("planQuery sends lookback and min_usd only for traders", () => {
  const traders = planQuery({
    chain: "solana", mode: "traders", token: "M", limit: 100, lookbackDays: 7, minUsd: 50,
  });
  assert.equal(traders.parameters.lookback_days, 7);
  assert.equal(traders.parameters.min_usd, 50);
  assert.equal(traders.parameters.blockchain, undefined);

  const holders = planQuery({
    chain: "solana", mode: "holders", token: "M", limit: 100, lookbackDays: 7, minUsd: 50,
  });
  assert.equal(holders.parameters.lookback_days, undefined);
  assert.equal(holders.parameters.min_usd, undefined);
});

test("planQuery names the chain for EVM and picks a different query id", () => {
  const base = planQuery({
    chain: "base", mode: "traders", token: "0x1", limit: 100, lookbackDays: 7, minUsd: 50,
  });
  const solana = planQuery({
    chain: "solana", mode: "traders", token: "M", limit: 100, lookbackDays: 7, minUsd: 50,
  });
  assert.equal(base.parameters.blockchain, "base");
  assert.notEqual(base.queryId, solana.queryId);
});
