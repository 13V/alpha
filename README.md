# Bagtrace

Paste a contract address, trace the wallets behind it.

Bagtrace answers two questions about any token: **who made the most money on it**, and
**who is holding the biggest bag right now**. It runs on [Dune](https://dune.com) — the SQL
lives in `dune/` where you can read and change it, and you pay Dune for credits rather than
paying per lookup.

Solana, BNB Chain and Base up front; Ethereum, Arbitrum, Optimism and Polygon behind the
*More…* button.

---

## Two modes

| Mode | Ranks by | Reads | Typical run |
| --- | --- | --- | --- |
| **Profit** | realized PnL from DEX fills | `dex_solana.trades` / `dex.trades` | EVM 2–5s · Solana 1–10 min |
| **Bag size** | current balance | `solana_utils.latest_balances` / `tokens.transfers` | EVM ~9s · Solana 3–6 min |

Runtimes are honest ranges, not best cases. **EVM is consistently fast. Solana is not**, and
the cause is `solana_utils.latest_balances` — see [Performance](#performance) below.

Profit mode returns, per wallet: realized PnL, open PnL, profit multiple, ROI, average buy
and sell price, **the market cap it entered and exited at**, USD and native-token flow, net
bag, % of supply, fill counts and hold time.

Select any rows and export as a plain address list, a comma-separated line for Telegram
bots, an `address,label` watchlist CSV, the full CSV, or JSON.

---

## Setup

```bash
cp .env.example .env.local     # add your key from https://dune.com/settings/api
npm install
npm run setup:dune             # creates the 4 queries, prints the ids to paste back
npm run dev                    # http://localhost:3000
```

`setup:dune` is idempotent: if the `DUNE_QUERY_*` ids are already in `.env.local` it updates
those queries in place instead of creating duplicates, so it doubles as the deploy step
after you edit any `.sql` file.

Creating queries over the API needs a Dune **Analyst plan or higher**. Without it the script
tells you and you can paste each `dune/*.sql` into <https://dune.com/queries> by hand, adding
the parameters listed in that file's header comment.

### Without the web UI

```bash
node scripts/trace.mjs <CA>                              # top 100 by profit
node scripts/trace.mjs <CA> --mode holders --limit 100   # top 100 holders
node scripts/trace.mjs <CA> --chain bnb --days 30 --csv out.csv
node scripts/trace.mjs <CA> --addresses | pbcopy
curl 'http://localhost:3000/api/wallets?token=<CA>&mode=holders&limit=100'
```

---

## How the numbers are built

Cost basis is **weighted average** over the chosen window:

```
avg_buy_price   = USD spent buying / tokens bought
avg_sell_price  = USD received     / tokens sold
realized_pnl    = USD received - avg_buy_price × min(tokens_sold, tokens_bought)
net_position    = tokens bought - tokens sold          (the bag built on DEXes)
open_pnl        = net_position × (mark price - avg_buy_price)
profit_multiple = avg_sell_price / avg_buy_price
```

Market caps are `price × circulating supply`. On EVM, supply and the mark price come from
`tokens.fdv_latest`; on Solana, supply is summed from live balances and the mark price is the
most recent priced fill.

### Read this before you trust a row

- **⚠ next to a PnL means the cost basis is incomplete.** That wallet sold more than it
  bought inside the window, so it was already holding when the window opened. Its multiple
  and its PnL can disagree in sign. Widen the window for a true figure. The queries return
  this as `cost_basis`.
- **Only DEX fills count.** Tokens received by transfer, airdrop or bridge carry no cost
  basis, so an airdropped wallet that dumps looks more profitable than it was.
- **On EVM the wallet is `tx_from`**, the EOA that signed the swap — not `taker`, which is
  usually a router. Both are in the raw result.
- **On Solana the wallet is `trader_id`**, and balances roll up per owner, not per token
  account. The table's `sol_balance` column is not surfaced: on an SPL row it holds the token
  account's rent-exempt minimum (~0.002 SOL), not the owner's wallet balance.
- **`amount_usd` is null on very thin pairs.** Those fills contribute nothing to the USD
  columns, which is why the native (SOL / ETH / BNB) columns matter on brand-new tokens.

---

## Notes on the Dune data model

Two things cost real time to discover, so they are written down here:

- **Dune's documented balance tables do not work on a standard key.** Both
  `balances_<chain>.latest` (from the docs) and `tokens_<chain>.balances` fail with
  *"does not exist or it is private"* — the latter is a stored view over a physical table
  that standard plans cannot see. EVM balances here are therefore reconstructed as net
  transfer flow from `tokens.transfers`, which every plan can read. It agrees with the
  known supply: BRETT on Base resolves to exactly 10,000,000,000.
- **CTEs are inlined, so referencing one twice scans the table twice.** The first cut of
  these queries computed circulating supply in a second CTE over the same table; folding it
  into a window function over a single scan removed a whole duplicate read.

## Performance

Measured, not estimated:

| Query | Cold token | Notes |
| --- | --- | --- |
| EVM holders | ~9s | `tokens.transfers`, prunes well |
| EVM profit | 2–5s | `dex.trades` prunes on `blockchain` + `block_month` |
| Solana holders | ~322s | full `solana_utils.latest_balances` scan |
| Solana profit, 90d | ~620s | trade scan plus the same balances scan for supply |

Two traps worth knowing about:

- **Repeat runs against the same token are dramatically faster and will fool you.** Querying
  one token over and over got Solana holders down to 16s; the same query against a token not
  hit before took 322s. Benchmark on a fresh mint or you will measure Dune's cache.
- **Running two queries at once roughly doubles both.** Concurrent Solana runs measured 662s
  and 620s; the same holders query alone was 322s. They contend on the same scan.

`solana_utils.latest_balances` has no partition key usable here — Dune's own docs say to
filter on `token_mint_address`, which these queries do, and it is still a large read. If
Solana latency matters more than the market-cap columns, drop the `supply` CTE from
`top_traders_solana.sql`: the trade scan alone is fast, and losing it only costs the
entry/exit market-cap columns.

`DUNE_PERFORMANCE` defaults to `large`, which costs more credits but ran ~8× faster than
`medium` on the same query (121s → 16s, both warm). Set it to `medium` to trade speed for
credits. `DUNE_TIMEOUT_MS` defaults to 600s because a cold Solana scan will blow through a
shorter ceiling.

---

## Cost control

- **Bag size mode is the cheap one.** Use it when you just want the top 100 holders.
- **Profit mode scales with the window.** Both trade tables are partitioned on `block_month`
  and the queries prune on it, so 7d costs roughly a twelfth of 90d.
- Results are cached per parameter set for `CACHE_TTL_SECONDS` (default 30 min), so
  re-tracing the same contract is free until it expires.

## Layout

```
dune/
  top_traders_solana.sql    realized PnL, Solana
  top_traders_evm.sql       realized PnL, any dex.trades chain
  top_holders_solana.sql    current balances, Solana
  top_holders_evm.sql       current balances, EVM (net transfer flow)
scripts/
  setup-dune.mjs            creates or updates the four queries
  trace.mjs                 CLI: CA in, table / CSV / JSON out
src/
  app/api/wallets/route.ts  validate → plan → execute on Dune → normalize
  lib/dune.ts               Data API client (execute, poll, results)
  lib/queries.ts            query ids, parameters, row normalization
  lib/chains.ts             chain registry + address detection
  lib/export.ts             export formats
  components/               control rail, results table, export toolbar
```

## Config

| Variable | Default | Purpose |
| --- | --- | --- |
| `DUNE_API_KEY` | — | required |
| `DUNE_QUERY_TRADERS_SOLANA` | — | id from `setup:dune` |
| `DUNE_QUERY_TRADERS_EVM` | — | id from `setup:dune` |
| `DUNE_QUERY_HOLDERS_SOLANA` | — | id from `setup:dune` |
| `DUNE_QUERY_HOLDERS_EVM` | — | id from `setup:dune` |
| `CACHE_TTL_SECONDS` | `1800` | how long a result is reused |
| `DUNE_PERFORMANCE` | `large` | `small` \| `medium` \| `large` |
| `DEFAULT_LOOKBACK_DAYS` | `90` | default trade window |
| `DEFAULT_MIN_USD` | `50` | drop wallets under this total volume |
| `DUNE_TIMEOUT_MS` | `600000` | how long to poll one execution |
| `MAX_WALLET_LIMIT` | `500` | ceiling on one request |

## Deploying

Stock Next.js — `vercel deploy`, or `npm run build && npm start` anywhere. Set the same env
vars on the host; the Dune key stays server-side and the browser only talks to
`/api/wallets`.

Traces routinely outlast the 10s default function timeout on serverless hosts. On Vercel,
raise `maxDuration` for the route, or run somewhere without a hard request cap.
