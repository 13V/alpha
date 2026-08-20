# alphawallets

Paste a contract address, get the wallets that actually made money on it.

A self-hosted rebuild of [alphawallets.fun](https://www.alphawallets.fun/) with
[Dune](https://dune.com) as the data source instead of a closed backend. Same idea —
CA in, ranked wallet list out, export straight into your tracking bot — except the SQL is
sitting in `dune/` where you can read it and change it, and you pay Dune for credits instead
of paying per lookup.

Covers **Solana**, **BNB Chain** and **Base** out of the box, plus Ethereum, Arbitrum,
Optimism and Polygon behind the `+` button.

---

## What it gives you

Two ranking modes:

| Mode | Ranks by | Data | Cost |
| --- | --- | --- | --- |
| **Profit** | realized PnL from DEX fills | `dex_solana.trades` / `dex.trades` | heavier |
| **Holdings** | current bag size | `solana_utils.latest_balances` / `balances_<chain>.latest` | cheap |

Per wallet in profit mode: realized PnL, unrealized PnL, profit multiple, ROI, average buy
and sell price, **average buy and sell market cap**, USD and native-token flow, tokens still
held, % of supply, buy/sell counts, and how long the position was held.

Select any subset of rows and export as a plain address list, a comma-separated line for
Telegram bots, an `address,label` watchlist CSV, the full CSV, or JSON.

---

## Setup

### 1. Get a Dune API key

<https://dune.com/settings/api>. The Data API is a paid feature and every execution burns
credits — see [Costs](#costs) below.

```bash
cp .env.example .env.local
# put your key in DUNE_API_KEY
```

### 2. Create the four queries

```bash
npm install
npm run setup:dune
```

This uploads `dune/*.sql` to your Dune account, wires up the parameters, and prints the four
`DUNE_QUERY_*` lines to paste into `.env.local`.

The query-management endpoint needs a Dune **Analyst plan or higher**. If your plan does not
include it, the script says so and you can create the queries by hand instead: open
<https://dune.com/queries>, hit *New query*, paste one `.sql` file, add the parameters listed
in that file's header comment, save, and copy the id out of the URL.

### 3. Run it

```bash
npm run dev            # http://localhost:3000
```

Or skip the UI entirely:

```bash
node scripts/top.mjs <CONTRACT_ADDRESS>
node scripts/top.mjs <CONTRACT_ADDRESS> --mode holders --limit 100
node scripts/top.mjs <CONTRACT_ADDRESS> --chain bnb --days 30 --csv wallets.csv
node scripts/top.mjs <CONTRACT_ADDRESS> --addresses | pbcopy
```

The API is also callable directly:

```bash
curl 'http://localhost:3000/api/wallets?token=<CA>&mode=traders&limit=100'
```

---

## How the numbers are worked out

Cost basis is **weighted average**, computed per wallet over the chosen window:

```
avg_buy_price   = total USD spent buying  / total tokens bought
avg_sell_price  = total USD received      / total tokens sold
realized_pnl    = USD received - avg_buy_price × min(tokens_sold, tokens_bought)
unrealized_pnl  = tokens still held × (last traded price - avg_buy_price)
profit_multiple = avg_sell_price / avg_buy_price
```

Market caps are `price × circulating_supply`, where circulating supply is the sum of every
live balance in Dune's balances table for that token — so `avg_buy_mcap` is the market cap
the wallet's average entry corresponds to.

### Things to know before you trust a number

- **Only DEX fills count.** Tokens received by transfer, airdrop or bridge arrive with no
  cost basis, so a wallet that was airdropped its bag and dumped it will show an
  inflated profit. Same the other way: a wallet that bought on a venue Dune has not decoded
  will look like it sold from nothing.
- **On EVM the wallet is `tx_from`** — the EOA that signed the swap, not the `taker`, which
  is usually a router contract. Both columns are in the raw result.
- **On Solana the wallet is `trader_id`**, and balances are rolled up per *owner*, not per
  token account.
- **The window matters.** Profit mode only looks back `lookback_days` (default 90). A wallet
  that bought before the window opens shows sells with no matching buys, which suppresses its
  cost basis. For a token launched inside the window this is exact; for older tokens widen it.
- **`amount_usd` can be null** on very thin pairs. Those fills contribute 0 to the USD legs,
  which is why the native (SOL / ETH / BNB) columns are worth a look on brand-new tokens.
- **Prices are Dune's**, marked at the last decoded trade, not a live feed.

---

## Costs

Every scan is one Dune execution and Dune bills by data scanned, so:

- **Holdings mode is cheap** — it touches only the balances table. Use it when you literally
  just want the top 100 holders.
- **Profit mode is the expensive one.** Both trade tables are partitioned on `block_month`, and
  the queries prune on it, so the window length drives the bill almost linearly. 7d costs
  roughly a twelfth of 90d.
- Results are cached in-process for `CACHE_TTL_SECONDS` (default 30 min), keyed on every
  parameter, so re-scanning the same contract is free until it expires.
- `DUNE_PERFORMANCE` picks the engine tier (`small` / `medium` / `large`). `large` finishes
  sooner and costs more per run.

---

## Layout

```
dune/
  top_traders_solana.sql    realized PnL ranking, Solana
  top_traders_evm.sql       realized PnL ranking, any dex.trades chain
  top_holders_solana.sql    current balance ranking, Solana
  top_holders_evm.sql       current balance ranking, EVM
scripts/
  setup-dune.mjs            creates the four queries in your Dune account
  top.mjs                   CLI: CA in, table/CSV/JSON out
src/
  app/api/wallets/route.ts  validate → plan → execute on Dune → normalize
  lib/dune.ts               Data API client (execute, poll, results)
  lib/queries.ts            query ids, parameters, row normalization
  lib/chains.ts             chain registry + address detection
  lib/export.ts             the export formats
  components/               search panel, results table, export bar
```

## Config

| Variable | Default | What it does |
| --- | --- | --- |
| `DUNE_API_KEY` | — | required |
| `DUNE_QUERY_TRADERS_SOLANA` | — | query id from `setup:dune` |
| `DUNE_QUERY_TRADERS_EVM` | — | query id from `setup:dune` |
| `DUNE_QUERY_HOLDERS_SOLANA` | — | query id from `setup:dune` |
| `DUNE_QUERY_HOLDERS_EVM` | — | query id from `setup:dune` |
| `CACHE_TTL_SECONDS` | `1800` | how long a result is reused before paying again |
| `DUNE_PERFORMANCE` | `medium` | `small` \| `medium` \| `large` |
| `DEFAULT_LOOKBACK_DAYS` | `90` | default trade window |
| `DEFAULT_MIN_USD` | `50` | drop wallets under this total volume |
| `MAX_WALLET_LIMIT` | `500` | ceiling on a single request |

## Deploying

It is a stock Next.js app — `vercel deploy`, or `npm run build && npm start` anywhere. Set the
same env vars on the host. The Dune key stays server-side; the browser only ever talks to
`/api/wallets`.

Note that profit-mode scans routinely run longer than the 10s default function timeout on
serverless hosts. On Vercel, raise `maxDuration` for the route or run it on a host without a
hard request cap.
