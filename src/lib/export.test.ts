import assert from "node:assert/strict";
import { test } from "node:test";

import { AXIOM_DEFAULTS, axiomName, buildExport, exportFilename } from "./export";
import type { ScanMeta, WalletRow } from "./types";

const META: ScanMeta = {
  token: "GUmbtfjSZkybSFgPibBcvwExEBdXwewJHR5PkTjzpump",
  chain: "solana",
  mode: "traders",
  limit: 100,
  lookbackDays: 7,
  minUsd: 50,
  rowCount: 2,
  holderCount: null,
  circulatingSupply: 1e9,
  currentMcap: 50_000,
  tokenSymbol: "MORTY",
  executionId: "01X",
  executionMillis: 13_500,
  fetchedAt: "2026-08-25T00:00:00.000Z",
  cached: false,
  resultAgeMinutes: null,
};

function row(over: Partial<WalletRow> = {}): WalletRow {
  return {
    rank: 1,
    wallet: "MRiYA4oN3158fCV8evhuCofrDzbHyYvYnGZUDJvoCsa",
    taker: null,
    realizedPnlUsd: 65_870,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 65_870,
    profitMultiple: 14.1,
    realizedRoi: 1.38,
    avgBuyPrice: null,
    avgSellPrice: null,
    avgBuyMcap: null,
    avgSellMcap: null,
    currentMcap: null,
    usdSpent: 47_620,
    usdReceived: 113_500,
    nativeSpent: null,
    nativeReceived: null,
    tokensBought: null,
    tokensSold: null,
    tokensHeld: null,
    pctSupplyHeld: null,
    valueUsd: null,
    positionStatus: null,
    costBasis: null,
    buyCoverage: 1,
    tokensReceived: null,
    receivedValueUsd: null,
    transferPeers: null,
    buyCount: null,
    sellCount: null,
    firstTrade: null,
    lastTrade: null,
    holdHours: null,
    ...over,
  };
}

test("the Axiom payload carries exactly the keys Axiom's import expects", () => {
  const parsed = JSON.parse(buildExport("axiom", [row()], META, AXIOM_DEFAULTS));
  assert.equal(parsed.length, 1);
  assert.deepEqual(Object.keys(parsed[0]).sort(), [
    "alertsOnBubble",
    "alertsOnFeed",
    "alertsOnToast",
    "emoji",
    "groups",
    "name",
    "sound",
    "trackedWalletAddress",
  ]);
  assert.equal(parsed[0].trackedWalletAddress, row().wallet);
});

test("the Axiom group is a list, and an empty group name is no group", () => {
  const grouped = JSON.parse(buildExport("axiom", [row()], META, { ...AXIOM_DEFAULTS, group: "Main" }));
  assert.deepEqual(grouped[0].groups, ["Main"]);
  const blank = JSON.parse(buildExport("axiom", [row()], META, { ...AXIOM_DEFAULTS, group: "   " }));
  assert.deepEqual(blank[0].groups, []);
});

test("wallet names follow the multiple / pnl / rank / address choice", () => {
  assert.equal(axiomName(row(), META, "multiple"), "14.10x - MORTY");
  assert.equal(axiomName(row(), META, "pnl"), "$65.87K - MORTY");
  assert.equal(axiomName(row({ rank: 7 }), META, "rank"), "#7 - MORTY");
  assert.equal(axiomName(row(), META, "address"), "MRiY…oCsa - MORTY");
});

test("a wallet with no usable multiple falls back to its rank, never a dash", () => {
  // holders mode has no multiple at all, and an unpriced sell can produce zero.
  // "— - MORTY" in a tracker is worse than useless.
  assert.equal(axiomName(row({ rank: 4, profitMultiple: null }), META, "multiple"), "#4 - MORTY");
  assert.equal(axiomName(row({ rank: 4, profitMultiple: 0 }), META, "multiple"), "#4 - MORTY");
  assert.equal(axiomName(row({ rank: 4, realizedPnlUsd: null }), META, "pnl"), "#4 - MORTY");
});

test("names fall back to the mint when a token has no symbol", () => {
  const anon = { ...META, tokenSymbol: null };
  assert.equal(axiomName(row({ rank: 2 }), anon, "rank"), "#2 - GUMBTF");
});

test("the address list is one wallet per line and the comma form is one line", () => {
  const rows = [row(), row({ wallet: "SecondWalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })];
  assert.deepEqual(buildExport("addresses", rows, META).split("\n"), rows.map((r) => r.wallet));
  assert.equal(buildExport("comma", rows, META), rows.map((r) => r.wallet).join(","));
});

test("CSV quotes a leading = + @ so a spreadsheet cannot execute it", () => {
  // a wallet label is attacker-controlled in the sense that it comes from chain
  // data; =HYPERLINK(...) in a cell is a real exfiltration route
  const csv = buildExport("csv", [row({ positionStatus: "=1+1", costBasis: "@SUM(A1)" })], META);
  assert.match(csv, /'=1\+1/);
  assert.match(csv, /'@SUM\(A1\)/);
});

test("CSV leaves real numbers alone, including negatives", () => {
  const csv = buildExport("csv", [row({ realizedPnlUsd: -8420 })], META);
  const header = csv.split("\n")[0].split(",");
  const values = csv.split("\n")[1].split(",");
  assert.equal(values[header.indexOf("realized_pnl_usd")], "-8420");
});

test("CSV drops columns that are empty for every row", () => {
  const csv = buildExport("csv", [row()], META);
  const header = csv.split("\n")[0];
  assert.ok(header.includes("realized_pnl_usd"));
  assert.ok(!header.includes("hold_hours"), "all-null column should not be emitted");
});

test("JSON export carries the scan metadata alongside the rows", () => {
  const parsed = JSON.parse(buildExport("json", [row()], META));
  assert.equal(parsed.meta.token, META.token);
  assert.equal(parsed.rows.length, 1);
});

test("the Axiom filename is the one Axiom users expect, others are labelled", () => {
  assert.equal(exportFilename("axiom", META), "highpnl-morty.json");
  assert.match(exportFilename("csv", META), /^whoprinted-solana-traders-morty\.csv$/);
});
