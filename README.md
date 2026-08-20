# Bagtrace

Paste a contract address, get the 100 wallets that made the most money on it, and copy them
straight into Axiom.

Runs on [Dune](https://dune.com). There is no backend account to set up and no server-side
key: each visitor pastes **their own** Dune API key, which stays in their browser and is only
passed through to Dune for that one request.

Solana, Base, BNB Chain and Ethereum. Chain is detected from the address.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

That is the whole setup. Open it, paste a Dune API key
([free](https://dune.com/settings/api)) and a contract address, hit **Top 100**.

It works with no `.env` at all because the four queries are **public** on Dune, and Dune lets
any API key execute a public query — the credits come off whichever key ran it. The ids are
baked into `src/lib/queries.ts`.

### Running your own copies of the queries

If you would rather own the SQL — to edit it, or so it cannot be changed underneath you:

```bash
cp .env.example .env.local     # add DUNE_API_KEY
npm run setup:dune             # creates the queries, prints the ids to paste back
```

Set the printed `DUNE_QUERY_*` ids in `.env.local` and they override the public defaults.
`setup:dune` is idempotent — with the ids already set it updates those queries in place, so
it doubles as the deploy step after editing any `.sql` file. Creating queries over the API
needs a Dune **Analyst plan**; without one, paste each `dune/*.sql` into
<https://dune.com/queries> by hand and add the parameters listed in its header comment.

A `DUNE_API_KEY` in the environment is used only as a fallback when a request arrives without
one — useful for a private deployment, unnecessary otherwise.

### From the terminal

```bash
node scripts/trace.mjs <CA>                              # top 100 by profit
node scripts/trace.mjs <CA> --chain bnb --days 30 --csv out.csv
node scripts/trace.mjs <CA> --addresses | pbcopy
node scripts/trace.mjs <CA> --mode holders --limit 100   # rank by bag size instead
```

The CLI reads `DUNE_API_KEY` from `.env.local`.

---

## Exporting to Axiom

Tick the wallets you want, hit **Copy for Axiom**, paste into Axiom's wallet import:

```json
[
  {
    "trackedWalletAddress": "GVnUUpKhak8kAAkPMKCpUxWSncY2XppmvgTTNZYobzkw",
    "name": "1.52x - KIMCHI",
    "emoji": "🎯",
    "alertsOnToast": false,
    "alertsOnBubble": true,
    "alertsOnFeed": true,
    "groups": ["Main"],
    "sound": "default"
  }
]
```

Names are `<label> - <TICKER>`, and **Name by** picks the label:

| Name by | Example |
| --- | --- |
| Multiple | `1.52x - KIMCHI` |
| PnL | `$98.08K - KIMCHI` |
| Rank | `#1 - KIMCHI` |
| Address | `GVnU…bzkw - KIMCHI` |

Group and emoji are set in the same row. The ticker comes from `tokens_solana.fungible` on
Solana and `tokens.fdv_latest` on EVM; with no metadata it falls back to the first six
characters of the contract address.

Axiom does not publish an import schema, so these fields are matched to a known-good export
rather than to documentation. If it changes, the shape is one object literal in
`buildAxiom` (`src/lib/export.ts`). Also available: plain address list, full CSV, and a
downloadable `highpnl-<ticker>.json`.

---

## How the numbers are built

Weighted-average cost basis over the chosen window:

```
acquired_tokens = tokens bought on a DEX + tokens received by transfer
acquired_cost   = USD spent buying + value of those transfers when they landed
avg_buy_price   = acquired_cost / acquired_tokens
avg_sell_price  = USD received / tokens sold
realized_pnl    = USD received - avg_buy_price × min(tokens_sold, acquired_tokens)
profit_multiple = avg_sell_price / avg_buy_price
```

Entry and exit market caps are those average prices × circulating supply.

### Cost basis includes tokens that arrive by transfer

On pump.fun tokens most of the real winners never appear as buyers at all. Measured on
`6ehEcTMCc85aNF4x9CWx8HuvWGhxQtvKdhKVf2HDpump`, recorded sells exceeded recorded buys by
**1.68x** token-wide, and the wallet a Solana terminal ranks first had **1,290 sell fills and
zero buy fills** — across `dex_solana.trades`, `pumpdotfun_solana.trades` and the raw
`pump_evt_tradeevent` bonding-curve log alike.

It had not bought. It **received 21,865,947 tokens in a single transfer**, then sold them.

Two obvious treatments are both wrong. Treating those tokens as free reports every dollar of
proceeds as profit. Matching sales only against recorded buys scores such a wallet at exactly
zero and hides the biggest winners entirely — tried, and it dropped all ten of a terminal's
top wallets out of our top 100.

So tokens arriving by transfer are **valued at the market price at the moment they land**
(per-minute VWAP from DEX fills), and that value becomes cost basis. Reproducing the wallet
above:

| | Bagtrace | Terminal |
| --- | --- | --- |
| tokens received | 21,865,947 | 21.9M |
| valued at | **$659** | **$658.0** |
| entry market cap | **$30,143** | **$30.1K** |
| realized PnL | $173,236 | $179,690 |

Same method, reproduced on Dune. Buy coverage across that token's top 100 went from mostly
**0% to a median of 96%, with no row left at 0%**, and multiples became meaningful — 398x,
275x, 206x where everything previously read ~1x.

Transfers that are the token leg of a swap are excluded by `tx_id`, or every DEX buy would be
counted twice. Transfers **out** reduce the remaining position but are never counted as
proceeds: moving tokens is not selling.

**Accuracy against the terminal**, same token, its published top ten: seven appear in our top
100, median error 17.6%, best cases within 0.0%, 3.6% and 9.0%. The earlier cash-accounting
build scored a lower median (8.2%) while subtracting no cost at all — right answers for the
wrong reason, and useless multiples. The residual gap is Dune's price series versus the
terminal's, and wallets whose transfers came from linked wallets that a terminal may net out.

**This applies to Solana only.** The EVM query still uses plain cash accounting; EVM tokens
rarely show the pump.fun pattern, but the same treatment would apply via `tokens.transfers`.

### Read this before you trust a row

- **⚠ next to a PnL means the cost basis is incomplete.** That wallet sold more than it
  bought inside the window, so it was already holding when the window opened, and its
  multiple and PnL can disagree in sign. Widen the window. This is common on short windows.
- **Only DEX fills count.** Tokens received by transfer, airdrop or bridge carry no cost
  basis, so an airdropped wallet that dumps looks more profitable than it was.
- **On EVM the wallet is `tx_from`**, the EOA that signed the swap — not `taker`, which is
  usually a router.
- **On Solana the wallet is `trader_id`.**
- **`amount_usd` is null on very thin pairs**, so those fills contribute nothing to the USD
  columns. The `min_usd` floor is skipped entirely when a pair has no USD pricing at all,
  so an unpriced token returns its wallets rather than silently returning nothing.

### Brand-new tokens will not be there yet

Dune's Solana pipeline runs **several hours behind the chain**. Measured on 2026-08-20,
`dex_solana.trades` and `tokens_solana.transfers` were both 336 minutes (5.6 hours) behind,
and `solana_utils.latest_balances` 272 minutes behind.

A token that launched today therefore returns nothing — no trades, no transfers, not even
metadata in `tokens_solana.fungible`. This is the single most likely reason a contract comes
back empty, and it resolves on its own once Dune catches up.

It is not a coverage gap: `dex_solana.trades` decodes `pumpdotfun`, `pumpswap`, `raydium`,
`meteora` and `jupiterz`, so pump.fun bonding-curve swaps are included once indexed.

---

## Performance

Measured, not estimated:

| Query | Cold token | Notes |
| --- | --- | --- |
| EVM profit | 2–5s | `dex.trades` prunes on `blockchain` + `block_month` |
| EVM holders | ~9s | `tokens.transfers` |
| Solana profit, 90d | ~620s | trade scan plus a balances scan for supply |
| Solana holders | ~322s | full `solana_utils.latest_balances` scan |

Two traps worth knowing about:

- **Repeat runs against the same token are dramatically faster and will fool you.** Querying
  one token repeatedly got Solana holders to 16s; the same query against a token never hit
  before took 322s. Benchmark on a fresh mint or you are measuring Dune's cache.
- **Running two queries at once roughly doubles both.** Concurrent Solana runs measured 662s
  and 620s against 322s for the same query alone.

Results are cached per parameter set for `CACHE_TTL_SECONDS` (default 30 min) and the cache
key deliberately excludes the API key, so a repeat trace of the same contract is free for
everyone. `DUNE_PERFORMANCE` defaults to `large` — more credits, ~8× faster than `medium`.
`DUNE_TIMEOUT_MS` defaults to 600s because a cold Solana scan blows through a shorter one.

---

## Notes on the Dune data model

Two things that cost real time to discover:

- **Dune's documented balance tables do not work on a standard key.** Both
  `balances_<chain>.latest` (from the docs) and `tokens_<chain>.balances` fail with
  *"does not exist or it is private"* — the latter is a stored view over a physical table
  standard plans cannot see. EVM balances are therefore reconstructed as net transfer flow
  from `tokens.transfers`, which every plan can read. It agrees with known supply: BRETT on
  Base resolves to exactly 10,000,000,000.
- **CTEs are inlined, so referencing one twice scans the table twice.** Circulating supply
  moved into a window function over a single scan to avoid a duplicate read.

`solana_utils.latest_balances` also carries a `sol_balance` column that looks useful and is
not: on an SPL row it holds the token account's rent-exempt minimum (~0.002 SOL), not the
owner's wallet balance.

---

## Layout

```
dune/
  top_traders_solana.sql    realized PnL, Solana        (public: 8385958)
  top_traders_evm.sql       realized PnL, EVM           (public: 8385959)
  top_holders_solana.sql    balances, Solana            (public: 8385960)
  top_holders_evm.sql       balances, EVM               (public: 8385961)
scripts/
  setup-dune.mjs            creates or updates the four queries
  trace.mjs                 CLI: CA in, table / CSV / JSON out
src/
  app/page.tsx              the whole UI
  app/api/trace/route.ts    start a Dune execution, then poll it
  lib/scan.ts               validate the request and pick the query
  lib/dune.ts               Data API client (execute, poll, results)
  lib/export.ts             Axiom payload and the other formats
```

## Config

Everything is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DUNE_API_KEY` | — | fallback when a request brings no key |
| `DUNE_QUERY_*` | public ids | point at your own copies of the queries |
| `CACHE_TTL_SECONDS` | `1800` | how long a result is reused |
| `DUNE_PERFORMANCE` | `large` | `small` \| `medium` \| `large` |
| `DUNE_TIMEOUT_MS` | `600000` | how long to poll one execution |
| `DEFAULT_LOOKBACK_DAYS` | `90` | default trade window |
| `DEFAULT_MIN_USD` | `50` | drop wallets under this total volume |
| `MAX_WALLET_LIMIT` | `500` | ceiling on one request |

## Deploying to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/13V/alpha)

Import the repo and deploy. **No environment variables are required** — visitors bring their
own Dune key and the queries are public. Verified by running the production build with the
Dune environment stripped out entirely.

### Why it fits inside a serverless timeout

A cold Solana trace takes 5–10 minutes on Dune, and Vercel caps functions at **300s on Hobby**
and **800s on Pro**. A single blocking request would 504.

So `/api/trace` never waits for the query. One `POST` starts the Dune execution and returns an
`executionId`; the browser polls the same route until it reports `done`. Every invocation is a
single short Dune round trip — measured at **0.87s to start and 0.18–0.54s per poll** while the
underlying query ran for far longer. The route caps itself at `maxDuration = 60`, which is well
inside even the Hobby ceiling, and the query keeps running on Dune regardless of any one
request.

There is nothing to configure for this. If you would rather have a plain blocking call for
scripting, use `scripts/trace.mjs`, which talks to Dune directly and has no timeout ceiling.

### Notes for a deployed instance

- **The result cache is per-instance.** `CACHE_TTL_SECONDS` uses process memory, so on
  serverless it only helps when requests land on a warm instance. It is a bonus, not a
  guarantee — put a shared cache in front if you need one.
- **Keys are never persisted.** A visitor's key lives in their `localStorage`, is sent with
  each request, and is used and discarded. It is deliberately excluded from the cache key so
  it cannot influence or leak across cached results.
- **Set `DUNE_API_KEY` only for a private instance**, where you want to pay for everyone's
  traces. Requests that carry their own key still use that key.

### Anywhere else

`npm run build && npm start`. Node 20+.
