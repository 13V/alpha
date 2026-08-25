#!/usr/bin/env node
/**
 * EXPLAIN a query file without running it.
 *
 *   node scripts/explain.mjs dune/top_traders_solana.sql <token> [days]
 *
 * ALWAYS DO THIS FIRST. Dune bills an execution for the engine time it
 * occupies, so a five-minute query that turns out to have a typo in it costs
 * the same as one that works. EXPLAIN scans no data: it catches syntax and
 * type errors, and prints the two numbers that predict what a query will cost.
 *
 *   table scans   Trino inlines a CTE at every reference, so a table read once
 *                 in the SQL can be read eight times in the plan. This is the
 *                 count that matters, not what the FROM clauses look like.
 *
 *   single-node   A window with no PARTITION BY collapses to one worker --
 *                 look for LocalExchange[partitioning = SINGLE] feeding a
 *                 Window[orderBy = ...]. Everything goes through one thread.
 *
 * Reuses one scratch query id if given, rather than littering the account.
 */
import { readFileSync } from "node:fs";
import { duneFetch, loadEnv } from "./dune-env.mjs";

loadEnv(process.cwd());

const [sqlPath, token, days = "365", scratchId] = process.argv.slice(2);
if (!sqlPath || !token) {
  console.error("usage: node scripts/explain.mjs <file.sql> <token> [days] [scratchQueryId]");
  process.exit(2);
}
const key = process.env.DUNE_API_KEY;
if (!key) { console.error("DUNE_API_KEY is not set"); process.exit(2); }

const sql = readFileSync(sqlPath, "utf8")
  .replaceAll("{{token_address}}", token)
  .replaceAll("{{lookback_days}}", String(days))
  .replaceAll("{{min_usd}}", "50")
  .replaceAll("{{wallet_limit}}", "100");

let queryId = Number(scratchId) || 0;
if (queryId) {
  await duneFetch(`/query/${queryId}`, key, {
    method: "PATCH", body: JSON.stringify({ query_sql: "EXPLAIN " + sql }),
  });
} else {
  queryId = (await duneFetch("/query", key, {
    method: "POST",
    body: JSON.stringify({ name: "scratch: EXPLAIN (safe to delete)", query_sql: "EXPLAIN " + sql, is_private: false }),
  })).query_id;
  console.log(`created scratch query ${queryId} — pass it as the 4th argument to reuse it`);
}

// small engine: this reads no data, so there is nothing for a bigger one to do
const { execution_id } = await duneFetch(`/query/${queryId}/execute`, key, {
  method: "POST", body: JSON.stringify({ performance: "medium" }),
});

let status;
for (let i = 0; i < 120; i++) {
  status = await duneFetch(`/execution/${execution_id}/status`, key);
  if (["QUERY_STATE_COMPLETED", "QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED"].includes(status.state)) break;
  await new Promise((r) => setTimeout(r, 2000));
}

if (status.state !== "QUERY_STATE_COMPLETED") {
  console.error(`\n${status.state}`);
  if (status.error) console.error(status.error.message ?? JSON.stringify(status.error));
  process.exit(1);
}

const res = await duneFetch(`/execution/${execution_id}/results`, key);
const plan = res.result.rows.map((r) => Object.values(r).join("\n")).join("\n");

const scans = {};
for (const m of plan.matchAll(/table = [a-z_]+:([a-zA-Z0-9_.]+)/g)) {
  // sqlmesh__x.x__real_name__1234 -> real_name
  const name = m[1].replace(/__\d+$/, "").replace(/^sqlmesh__[^.]*\./, "");
  scans[name] = (scans[name] ?? 0) + 1;
}

console.log("\nPLAN OK\n");
console.log("table scans in the plan:");
for (const [t, n] of Object.entries(scans).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${t}`);
}

const windows = [...plan.matchAll(/Window\[([^\]]*)\]/g)].map((m) => m[1]);
console.log("\nwindow operators:");
for (const w of windows) {
  const partitioned = w.includes("partitionBy");
  console.log(`  ${partitioned ? "partitioned" : "SINGLE NODE "}  ${w.slice(0, 90)}`);
}
if (windows.some((w) => !w.includes("partitionBy"))) {
  console.log("\n  A window with no partitionBy runs every row through one worker.");
  console.log("  Fine over an already-aggregated handful of rows; ruinous over raw ones.");
}
