#!/usr/bin/env node
/**
 * Bagtrace from the terminal — no web server needed.
 *
 *   node scripts/trace.mjs <contract-address> [options]
 *
 *   --chain <id>     solana | base | bnb | ethereum | arbitrum | optimism | polygon
 *                    (default: detected from the address shape)
 *   --mode <m>       traders (realized PnL, default) | holders (current bag)
 *   --limit <n>      how many wallets (default 100)
 *   --days <n>       trade window for traders mode (default 90)
 *   --min <usd>      drop wallets under this total volume (default 50)
 *   --addresses      print just the wallet addresses, one per line
 *   --csv <path>     write the full result as CSV
 *   --json <path>    write the raw Dune rows as JSON
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { duneFetch, loadEnv } from "./dune-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(root);

// ---------------------------------------------------------------- args

const VALUE_FLAGS = new Set(["chain", "mode", "limit", "days", "min", "csv", "json"]);

const options = {};
const positionals = [];

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    if (VALUE_FLAGS.has(name)) {
      options[name] = process.argv[++i];
    } else {
      options[name] = true;
    }
  } else {
    positionals.push(arg);
  }
}

const flag = (name, fallback) => (options[name] === undefined ? fallback : options[name]);
const has = (name) => options[name] === true;

const token = positionals[0];

if (!token || has("help") || has("h")) {
  console.log(
    `Usage: node scripts/trace.mjs <contract-address> [--chain solana] [--mode traders]\n` +
      `                           [--limit 100] [--days 90] [--min 50]\n` +
      `                           [--addresses] [--csv out.csv] [--json out.json]`,
  );
  process.exit(token ? 0 : 1);
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const chain = flag("chain", EVM_ADDRESS.test(token) ? "base" : SOLANA_ADDRESS.test(token) ? "solana" : null);
if (!chain) {
  console.error(`"${token}" does not look like a Solana mint or an EVM contract address.`);
  process.exit(1);
}

const mode = flag("mode", "traders");
const limit = Number(flag("limit", 100));
const days = Number(flag("days", 90));
const minUsd = Number(flag("min", 50));

// ---------------------------------------------------------------- config

const apiKey = process.env.DUNE_API_KEY;
if (!apiKey) {
  console.error("DUNE_API_KEY is not set — put it in .env.local (https://dune.com/settings/api).");
  process.exit(1);
}

const isSolana = chain === "solana";
const envVar =
  mode === "holders"
    ? isSolana
      ? "DUNE_QUERY_HOLDERS_SOLANA"
      : "DUNE_QUERY_HOLDERS_EVM"
    : isSolana
      ? "DUNE_QUERY_TRADERS_SOLANA"
      : "DUNE_QUERY_TRADERS_EVM";

const queryId = Number(process.env[envVar]);
if (!Number.isInteger(queryId) || queryId <= 0) {
  console.error(`${envVar} is not set. Run \`npm run setup:dune\` first.`);
  process.exit(1);
}

const parameters = {
  token_address: isSolana ? token : token.toLowerCase(),
  wallet_limit: limit,
};
if (!isSolana) parameters.blockchain = chain;
if (mode === "traders") {
  parameters.lookback_days = days;
  parameters.min_usd = minUsd;
}

// ---------------------------------------------------------------- run

const performance = process.env.DUNE_PERFORMANCE ?? "large";
process.stderr.write(`Running ${envVar}=${queryId} on ${chain} … `);

const { execution_id } = await duneFetch(`/query/${queryId}/execute`, apiKey, {
  method: "POST",
  body: JSON.stringify({ query_parameters: parameters, performance }),
});

const started = Date.now();
let state = "QUERY_STATE_PENDING";
while (!["QUERY_STATE_COMPLETED", "QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED"].includes(state)) {
  await new Promise((r) => setTimeout(r, 2000));
  const status = await duneFetch(`/execution/${execution_id}/status`, apiKey);
  state = status.state;
  process.stderr.write(".");
  if (Date.now() - started > 300_000) {
    console.error("\nTimed out after 5 minutes.");
    process.exit(1);
  }
}

if (state !== "QUERY_STATE_COMPLETED") {
  console.error(`\nExecution ended as ${state}. Open https://dune.com/queries/${queryId} to see why.`);
  process.exit(1);
}

const results = await duneFetch(`/execution/${execution_id}/results?limit=${limit}`, apiKey);
const rows = results.result?.rows ?? [];
process.stderr.write(` ${rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s\n\n`);

// ---------------------------------------------------------------- output

if (has("addresses")) {
  for (const row of rows) console.log(row.wallet);
} else {
  const cols =
    mode === "holders"
      ? ["rank", "wallet", "tokens_held", "pct_supply_held", "value_usd"]
      : ["rank", "wallet", "realized_pnl_usd", "profit_multiple", "avg_buy_mcap", "avg_sell_mcap", "tokens_held"];

  const fmt = (v) => {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
    return n.toFixed(abs < 1 ? 4 : 2);
  };

  console.table(
    rows.map((row) =>
      Object.fromEntries(
        cols.map((c) => [c, c === "wallet" || c === "rank" ? row[c] : fmt(row[c])]),
      ),
    ),
  );
}

const csvPath = flag("csv");
if (csvPath && rows.length > 0) {
  const headers = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  writeFileSync(
    csvPath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\n"),
  );
  console.error(`\nCSV written to ${csvPath}`);
}

const jsonPath = flag("json");
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ chain, mode, token, rows }, null, 2));
  console.error(`JSON written to ${jsonPath}`);
}
