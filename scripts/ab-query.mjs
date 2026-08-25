#!/usr/bin/env node
/**
 * Run two versions of a query on the same token and prove they agree.
 *
 *   node scripts/ab-query.mjs <baseline.sql> <candidate.sql> <token> [lookbackDays]
 *
 * Prints each side's execution time and then a row-by-row diff. A candidate is
 * only safe to promote when every wallet matches and every number is within
 * tolerance -- these are floating point sums over millions of rows, so exact
 * equality is the wrong test, but anything past a few parts per million means
 * the accounting changed and the rewrite is not a rewrite.
 *
 * Needs a DUNE_API_KEY with datapoints left; each side is a real execution.
 */
import { readFileSync } from "node:fs";
import { duneFetch, loadEnv } from "./dune-env.mjs";

loadEnv(process.cwd());

const [baselinePath, candidatePath, token, days = "365"] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !token) {
  console.error("usage: node scripts/ab-query.mjs <baseline.sql> <candidate.sql> <token> [days]");
  process.exit(2);
}

const key = process.env.DUNE_API_KEY;
if (!key) {
  console.error("DUNE_API_KEY is not set");
  process.exit(2);
}

const PERFORMANCE = process.env.DUNE_PERFORMANCE ?? "large";
/** Fractional difference we are willing to call the same number. */
const TOLERANCE = 1e-6;
/** Columns whose value is a float sum; everything else must match exactly. */
const NUMERIC = /_(usd|pnl|price|mcap|multiple|roi|supply|tokens?|held|coverage|hours)$|^tokens_|^sol_/;

function render(path) {
  return readFileSync(path, "utf8")
    .replaceAll("{{token_address}}", token)
    .replaceAll("{{lookback_days}}", String(days))
    .replaceAll("{{min_usd}}", "50")
    .replaceAll("{{wallet_limit}}", "100");
}

async function runOnce(label, path) {
  const sql = render(path);
  process.stdout.write(`${label}: creating query... `);
  const { query_id } = await duneFetch("/query", key, {
    method: "POST",
    body: JSON.stringify({ name: `bagtrace A/B ${label}`, query_sql: sql, is_private: false }),
  });
  process.stdout.write(`${query_id}, executing... `);

  const started = Date.now();
  const { execution_id } = await duneFetch(`/query/${query_id}/execute`, key, {
    method: "POST",
    body: JSON.stringify({ performance: PERFORMANCE }),
  });

  for (;;) {
    const status = await duneFetch(`/execution/${execution_id}/status`, key);
    if (status.state === "QUERY_STATE_COMPLETED") break;
    if (["QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED"].includes(status.state)) {
      throw new Error(`${label} ended as ${status.state}: ${status.error?.message ?? ""}`);
    }
    if (Date.now() - started > 900_000) throw new Error(`${label} still running after 15m`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  const res = await duneFetch(`/execution/${execution_id}/results?limit=100`, key);
  const wall = Date.now() - started;
  const engine = res.result?.metadata?.execution_time_millis ?? null;
  console.log(`done in ${(wall / 1000).toFixed(1)}s wall, ${engine != null ? (engine / 1000).toFixed(1) + "s engine" : "engine n/a"}`);
  return { rows: res.result?.rows ?? [], wall, engine, queryId: query_id };
}

const num = (v) => (v == null || v === "" ? null : Number(v));

function diff(a, b) {
  const problems = [];
  if (a.rows.length !== b.rows.length) {
    problems.push(`row count ${a.rows.length} vs ${b.rows.length}`);
  }

  const byWallet = new Map(b.rows.map((r) => [r.wallet, r]));
  let worst = { column: null, rel: 0, wallet: null, a: null, b: null };

  for (const rowA of a.rows) {
    const rowB = byWallet.get(rowA.wallet);
    if (!rowB) {
      problems.push(`wallet ${rowA.wallet} (rank ${rowA.rank}) missing from candidate`);
      continue;
    }
    for (const [column, valueA] of Object.entries(rowA)) {
      const valueB = rowB[column];
      if (NUMERIC.test(column) || column === "rank") {
        const x = num(valueA);
        const y = num(valueB);
        if (x == null && y == null) continue;
        if (x == null || y == null) {
          problems.push(`${rowA.wallet}.${column}: ${valueA} vs ${valueB}`);
          continue;
        }
        const rel = Math.abs(x - y) / Math.max(1e-12, Math.abs(x), Math.abs(y));
        if (rel > worst.rel) worst = { column, rel, wallet: rowA.wallet, a: x, b: y };
        if (rel > TOLERANCE) {
          problems.push(`${rowA.wallet}.${column}: ${x} vs ${y} (${(rel * 100).toFixed(4)}%)`);
        }
      } else if (String(valueA ?? "") !== String(valueB ?? "")) {
        problems.push(`${rowA.wallet}.${column}: "${valueA}" vs "${valueB}"`);
      }
    }
  }

  const missing = a.rows.length && b.rows.filter((r) => !a.rows.some((x) => x.wallet === r.wallet));
  for (const row of missing || []) {
    problems.push(`wallet ${row.wallet} (rank ${row.rank}) only in candidate`);
  }
  return { problems, worst };
}

const baseline = await runOnce("baseline ", baselinePath);
const candidate = await runOnce("candidate", candidatePath);

console.log("\n=== SPEED ===");
const speedup = baseline.wall / candidate.wall;
console.log(`wall   ${(baseline.wall / 1000).toFixed(1)}s -> ${(candidate.wall / 1000).toFixed(1)}s  (${speedup.toFixed(2)}x)`);
if (baseline.engine != null && candidate.engine != null) {
  console.log(`engine ${(baseline.engine / 1000).toFixed(1)}s -> ${(candidate.engine / 1000).toFixed(1)}s  (${(baseline.engine / candidate.engine).toFixed(2)}x)`);
}
console.log("NOTE: the second run benefits from the first warming Dune's file cache.");
console.log("      Re-run with the arguments swapped before believing any speedup.");

console.log("\n=== AGREEMENT ===");
const { problems, worst } = diff(baseline, candidate);
console.log(`rows: ${baseline.rows.length} baseline / ${candidate.rows.length} candidate`);
if (worst.column) {
  console.log(`largest numeric gap: ${worst.column} on ${worst.wallet} — ${worst.a} vs ${worst.b} (${(worst.rel * 100).toExponential(2)}%)`);
}
if (problems.length === 0) {
  console.log("IDENTICAL within tolerance — safe to promote.");
} else {
  console.log(`${problems.length} disagreement(s) — DO NOT PROMOTE:`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
  if (problems.length > 40) console.log(`  ...and ${problems.length - 40} more`);
}
console.log(`\nscratch queries left on dune: ${baseline.queryId}, ${candidate.queryId} — delete them when done.`);
process.exit(problems.length === 0 ? 0 : 1);
