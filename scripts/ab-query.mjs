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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { duneFetch, loadEnv } from "./dune-env.mjs";

loadEnv(process.cwd());

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
// Every run here is billed for the engine time it occupies. medium by default;
// pass --performance large only when comparing against a number measured there.
const PERF = flag("performance", "medium");
// Rows from a previous run of the baseline, so the expensive side is paid once.
const BASELINE_ROWS = flag("baseline-rows", null);
// Where each side's rows are written, so a re-diff never costs another run.
const OUT_DIR = flag("out", ".ab");
const days = /^\d+$/.test(argv[argv.length - 1]) ? argv.pop() : "365";
const token = argv.pop();
const [baselinePath, ...candidatePaths] = argv;
if (!baselinePath || candidatePaths.length === 0 || !token) {
  console.error("usage: node scripts/ab-query.mjs <baseline.sql> <candidate.sql>... <token> [days]");
  process.exit(2);
}

const key = process.env.DUNE_API_KEY;
if (!key) {
  console.error("DUNE_API_KEY is not set");
  process.exit(2);
}


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
    body: JSON.stringify({ performance: PERF }),
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
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${label.trim().replace(/\W+/g, "_")}.json`,
      JSON.stringify(res.result?.rows ?? []));
  } catch { /* diffing still works, it just cannot be replayed for free */ }
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

console.log(`engine tier: ${PERF}. Each side below is a real execution, billed for`);
console.log(`the engine time it occupies. Run scripts/explain.mjs first -- it scans no`);
console.log(`data and catches the errors that would otherwise cost a full run.\n`);

let baseline;
if (BASELINE_ROWS) {
  const rows = JSON.parse(readFileSync(BASELINE_ROWS, "utf8"));
  baseline = { rows, wall: NaN, engine: null, queryId: "(from file)" };
  console.log(`baseline: ${rows.length} rows read from ${BASELINE_ROWS} — not re-run`);
} else {
  baseline = await runOnce("baseline", baselinePath);
  console.log(`baseline rows saved to ${OUT_DIR}/baseline.json — pass --baseline-rows to skip re-running it`);
}
const results = [];
for (const path of candidatePaths) {
  const name = path.split("/").pop().replace(/\.sql$/, "");
  try {
    results.push({ name, path, run: await runOnce(name, path) });
  } catch (error) {
    console.log(`${name}: FAILED — ${error.message}`);
    results.push({ name, path, run: null, error: error.message });
  }
}

console.log("\n=== SPEED ===");
console.log(Number.isNaN(baseline.wall)
  ? "baseline  not re-run (rows from file); speed ratios below are unavailable"
  : `baseline  ${(baseline.wall / 1000).toFixed(1)}s wall` +
    (baseline.engine != null ? `, ${(baseline.engine / 1000).toFixed(1)}s engine` : ""));
for (const { name, run, error } of results) {
  if (!run) { console.log(`${name.padEnd(24)} failed: ${error}`); continue; }
  const wall = Number.isNaN(baseline.wall)
    ? `${(run.wall / 1000).toFixed(1)}s`
    : `${(run.wall / 1000).toFixed(1)}s (${(baseline.wall / run.wall).toFixed(2)}x)`;
  const engine = baseline.engine != null && run.engine != null
    ? `  engine ${(run.engine / 1000).toFixed(1)}s (${(baseline.engine / run.engine).toFixed(2)}x)` : "";
  console.log(`${name.padEnd(24)} ${wall}${engine}`);
}
console.log("\nNOTE: each run warms Dune's file cache for the next one, so a later");
console.log("      candidate is flattered. Re-run with the order reversed before");
console.log("      believing any speedup, and treat engine time as the real number.");

console.log("\n=== AGREEMENT vs BASELINE ===");
let anyBad = false;
for (const { name, run } of results) {
  if (!run) { anyBad = true; continue; }
  const { problems, worst } = diff(baseline, run);
  const gap = worst.column
    ? `worst gap ${worst.column} ${(worst.rel * 100).toExponential(2)}% on ${worst.wallet}`
    : "no numeric columns compared";
  if (problems.length === 0) {
    console.log(`${name.padEnd(24)} MATCHES (${run.rows.length} rows, ${gap})`);
  } else {
    anyBad = true;
    console.log(`${name.padEnd(24)} ${problems.length} disagreement(s) — DO NOT PROMOTE (${gap})`);
    for (const p of problems.slice(0, 15)) console.log(`    ${p}`);
    if (problems.length > 15) console.log(`    ...and ${problems.length - 15} more`);
  }
}

const ids = [baseline.queryId, ...results.filter((r) => r.run).map((r) => r.run.queryId)];
console.log(`\nscratch queries left on dune: ${ids.join(", ")} — delete them when done.`);
process.exit(anyBad ? 1 : 0);
