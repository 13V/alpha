#!/usr/bin/env node
/**
 * Creates the four Alpha Wallets queries in your Dune account and prints the
 * env lines to paste into .env.local.
 *
 *   npm run setup:dune              # creates them private
 *   npm run setup:dune -- --public  # creates them public
 *
 * Needs a Dune Analyst plan or higher (the query-management endpoints are gated).
 * If that call is rejected, the script tells you how to paste the SQL in by hand.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { EVM_CHAINS, duneFetch, loadEnv } from "./dune-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(root);

const isPublic = process.argv.includes("--public");
const apiKey = process.env.DUNE_API_KEY;

if (!apiKey) {
  console.error("DUNE_API_KEY is not set. Put it in .env.local first — https://dune.com/settings/api");
  process.exit(1);
}

const sql = (name) => readFileSync(resolve(root, "dune", name), "utf8");

const text = (key, value) => ({ key, type: "text", value });
const number = (key, value) => ({ key, type: "number", value: String(value) });
const chainParam = () => ({
  key: "blockchain",
  type: "enum",
  value: "base",
  enumOptions: EVM_CHAINS,
});

const QUERIES = [
  {
    env: "DUNE_QUERY_TRADERS_SOLANA",
    name: "Alpha Wallets — Top traders (Solana)",
    file: "top_traders_solana.sql",
    description: "Top wallets by realized PnL for a Solana SPL token.",
    parameters: [
      text("token_address", "So11111111111111111111111111111111111111112"),
      number("wallet_limit", 100),
      number("lookback_days", 90),
      number("min_usd", 50),
    ],
  },
  {
    env: "DUNE_QUERY_TRADERS_EVM",
    name: "Alpha Wallets — Top traders (EVM)",
    file: "top_traders_evm.sql",
    description: "Top wallets by realized PnL for an EVM token, on any dex.trades chain.",
    parameters: [
      chainParam(),
      text("token_address", "0x4200000000000000000000000000000000000006"),
      number("wallet_limit", 100),
      number("lookback_days", 90),
      number("min_usd", 50),
    ],
  },
  {
    env: "DUNE_QUERY_HOLDERS_SOLANA",
    name: "Alpha Wallets — Top holders (Solana)",
    file: "top_holders_solana.sql",
    description: "Top holders of a Solana SPL token by current balance.",
    parameters: [
      text("token_address", "So11111111111111111111111111111111111111112"),
      number("wallet_limit", 100),
    ],
  },
  {
    env: "DUNE_QUERY_HOLDERS_EVM",
    name: "Alpha Wallets — Top holders (EVM)",
    file: "top_holders_evm.sql",
    description: "Top holders of an EVM token by current balance.",
    parameters: [
      chainParam(),
      text("token_address", "0x4200000000000000000000000000000000000006"),
      number("wallet_limit", 100),
    ],
  },
];

const created = [];
let failed = false;

for (const query of QUERIES) {
  process.stdout.write(`Creating "${query.name}" … `);
  try {
    const { query_id } = await duneFetch("/query", apiKey, {
      method: "POST",
      body: JSON.stringify({
        name: query.name,
        description: query.description,
        query_sql: sql(query.file),
        is_private: !isPublic,
        parameters: query.parameters,
      }),
    });
    created.push([query.env, query_id]);
    console.log(`ok → https://dune.com/queries/${query_id}`);
  } catch (error) {
    failed = true;
    console.log(`failed (${error.status ?? "?"}) ${error.message}`);
  }
}

if (created.length > 0) {
  console.log("\nPaste these into .env.local:\n");
  for (const [env, id] of created) console.log(`${env}=${id}`);
}

if (failed) {
  console.log(
    [
      "",
      "Some queries could not be created through the API. That endpoint needs an",
      "Analyst plan or higher. To do it by hand instead:",
      "",
      "  1. Open https://dune.com/queries and hit 'New query'.",
      "  2. Paste the contents of the matching file in dune/.",
      "  3. Add the parameters named in the header comment of that file.",
      "  4. Save, then copy the id out of the URL into .env.local.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}
