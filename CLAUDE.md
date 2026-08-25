# Who Printed

Paste a contract address, get the 100 wallets that made the most money on it,
export them to a wallet tracker. Next 16 App Router, React 19, TypeScript.
Users bring their own Dune API key; it lives in their browser, is sent per
request, and is never logged, persisted server-side, or part of a cache key.

## Layout

    dune/*.sql              the four queries, run on Dune, not in this repo
    src/app/api/trace/      start/poll route — one short round trip per call
    src/lib/dune.ts         Dune Data API client (DUNE_API_BASE overridable)
    src/lib/scan.ts         validation + which query id and params to run
    scripts/explain.mjs     EXPLAIN a query without running it — USE THIS FIRST
    scripts/ab-query.mjs    run baseline vs candidates, diff every row
    scripts/stub-dune.mjs   fake api.dune.com, for testing without credits

Live query ids: traders svm 8385958, evm 8385959; holders svm 8385960,
evm 8385961. They are public, so any key can execute them — which is also why
Dune's stored results are shared across everyone using the app.

## Hard rules

- **Never commit an API key.** Check `git diff --cached` before every commit.
  Keys live in `.env.local`, which is gitignored.
- **Never point the app at unverified SQL.** These numbers are people's money.
  `scripts/ab-query.mjs` must show the same wallets in the same order first.
- Push only to the branch named in the task. Do not open a PR unless asked.
- Changing a query means `PATCH`ing it on Dune. Editing the `.sql` file alone
  changes nothing, and it invalidates every stored result for that query.

## Dune: what costs money

Two meters. **Executions** are billed for the engine time they occupy and are
most of the bill. **Result reads** are billed in datapoints -- rows x columns --
and matter in the steady state, once reuse means most serves are reads. So, in
order:

1. Don't execute — `DUNE_RESULT_MAX_AGE_MINUTES` reuses a run Dune already has,
   and the client rejoins its own in-flight execution after a reload.
2. The narrowest window that still covers the token — see below. Not the
   engine tier: medium was measured at >25 minutes against large's 116s on the
   same query, so a lower rate over far more engine seconds costs more.
3. A faster query, since the bill tracks engine seconds.
4. Fewer columns per read. `DISPLAY_COLUMNS` in `src/lib/queries.ts` asks for
   the 15 the screen and the wallet exports use rather than all 35 — 1,500
   datapoints per 100 rows instead of 3,500. The CSV and JSON exports pass
   `full: true`, which re-reads the same execution wide; nothing re-runs.

**Run `scripts/explain.mjs` before any execution.** EXPLAIN scans no data, so it
catches syntax and type errors that otherwise cost a full multi-minute run to
find, and prints the two numbers that predict cost.

## Dune: traps that cost real credits to discover

- **Trino inlines CTEs.** A table read once in the SQL is read once *per
  reference to the CTE that reads it*, transitively. `fills` referenced four
  times over a two-scan UNION put `dex_solana.trades` in the plan eight times.
  The plan's count is the truth, not the FROM clauses.
- **`tokens_solana.transfers` is a view over eight tables.** Six are native SOL
  movement — `sol_transfers` is every SOL transfer on Solana. A
  `token_mint_address` filter cannot match a row in any of them, but they are
  all in the plan. Read `tokens_solana.spl_token_transfers` and
  `spl_token_2022_transfers` directly.
- **A window with no `PARTITION BY` runs on one worker.** Look for
  `LocalExchange[partitioning = SINGLE]` feeding a `Window[orderBy = ...]`.
  Fine over aggregated rows, ruinous over raw ones.
- **The live traders query is non-deterministic.** Its as-of price window has no
  tie-break, so transfers landing exactly on a minute boundary take either that
  minute's price or the previous one depending on how rows spread across
  workers. Two identical runs disagreed on 694 values, `avg_buy_mcap` by $46.
  Fix pending in `dune/top_traders_solana.safe.sql`.
- **Warm-cache readings lie, and they fooled this file once already.** The
  live query, unchanged, ran in 291.1s cold and 123.9s warm. A candidate that
  ran third on the same token then "measured" 115.7s and was written up as
  2.52x faster; warm against warm it was 1.07x. Never compare a candidate
  against a baseline that ran at a different cache temperature. Run both warm,
  then reverse the order.
- **The window is the biggest lever on cost, by far.** Same query, same key, on
  a token five days old: 1095d took 411.3s of engine time, 365d took 97.8s, 7d
  took 13.5s -- all three returning the same 100 wallets in the same order. The
  client walks a ladder (`LADDER` in `src/app/page.tsx`) and stops at the first
  window whose earliest trade is not against the edge.

### Measured and rejected — do not retry

- `pumpdotfun_solana.trades` / `pumpswap_solana.trades` instead of
  `dex_solana.trades`: they are **views over it**. Plan went to ten scans.
- Fixing the tie-break with a second `ORDER BY` key: correct, and 322s against
  the live query's 291s. A compound sort on a single-node window is worse.
- Deriving the day grid from the price table: two more inlined references.

## Testing without credits

    node scripts/stub-dune.mjs --port 3999 --mode stored|cold
    DUNE_API_BASE=http://localhost:3999 PORT=3100 npx next start

The stub records the engine tier each request asks for at `/__seen`. Chromium
is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; drive the real UI
with `playwright-core` rather than trusting a change by eye.

`npm run check` is typecheck, tests and build. `npm test` alone runs
`src/lib/*.test.ts` on Node's own runner -- no framework, no build step, and
`scripts/test/register.mjs` teaches Node the two import rules the source is
written for (extensionless relative paths, and the `@/` alias).

The test worth knowing about: `queries.test.ts` parses the final SELECT out of
each `dune/*.sql` and asserts every name in `DISPLAY_COLUMNS` appears there.
Dune answers an unknown column with `400`, not by ignoring it, so a mismatch
breaks every request for that mode and chain -- which shipped once. Nothing
else catches it: the compiler sees string literals and the stub answers
whatever it is asked.

There is no eslint config.

## Accounting, in one paragraph

Cost basis is weighted-average and counts **dex buys plus tokens received by
transfer**, valued at the market price when they landed. On pump.fun tokens most
real winners never appear as buyers — the top wallet on one measured token had
1,290 sells and zero buys, having received 21.8M tokens in a single transfer.
Treating those as free reports every dollar of proceeds as profit; matching
sales only against recorded buys scores the wallet at zero. Both are wrong.
Transfers that are the token leg of a swap are excluded by tx id. Transfers out
reduce the position but are never proceeds. Wallets trading with more than 200
distinct transfer counterparties are exchange infrastructure and are dropped.
`buy_coverage` says how much of what a wallet sold has a known cost; below 1.0
its profit is a ceiling, not a measurement.
