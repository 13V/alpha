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
avg_buy_price   = USD spent buying / tokens bought
avg_sell_price  = USD received     / tokens sold
realized_pnl    = (avg_sell_price - avg_buy_price) × min(tokens_sold, tokens_bought)
profit_multiple = avg_sell_price / avg_buy_price
```

Entry and exit market caps are those average prices × circulating supply.

### Dune's Solana buy-side coverage is incomplete — read this first

On pump.fun tokens, `dex_solana.trades` records far more selling than buying. Measured on
one token (`6ehEcTMCc85aNF4x9CWx8HuvWGhxQtvKdhKVf2HDpump`):

| project | side | fills | tokens |
| --- | --- | --- | --- |
| pumpdotfun | buy | **9** | 813M |
| pumpswap | buy | 735,183 | 3.53B |
| pumpswap | sell | 501,780 | **7.39B** |

Token-wide, recorded sells exceed recorded buys by **1.68x** — 3.06 billion tokens sold that
were never recorded as bought. Nine bonding-curve buy fills exist for a token that ran to a
$12M market cap. The wallet a Solana terminal ranks first on that token has **1,290 sell
fills and zero buy fills** in Dune.

Nothing downstream can repair this. A "match each sale to a recorded buy" formula scores
exactly those wallets at zero and hides the biggest winners entirely — tried, and it dropped
all ten of a terminal's top wallets out of our top 100.

So PnL is **cash accounting**: `usd_received - usd_spent`, the same convention Padre and
Axiom use. Against a terminal's published figures for that token, all ten of its top wallets
now appear in our top 100 with a median error of **8.2%**.

The residual error is the missing buys. Where a wallet's purchases were not recorded, no cost
is subtracted and its PnL is an **upper bound** — which is why some wallets rank above where a
terminal puts them. The **Buys seen** column makes this legible per row:
`tokens_bought / tokens_sold`, capped at 1. 100% means the number is trustworthy; 0% means
every token it sold arrived from somewhere Dune did not record.

**If you need terminal-grade Solana accuracy, Dune is the wrong source.** It is an analytics
warehouse, not a Solana-native indexer. Bagtrace is honest about the gap rather than papering
over it, but it cannot close it.

### Older behaviour: matched-portion accounting

A wallet often sells tokens it bought before the window opened. Their cost is invisible, and
counting the proceeds anyway treats them as free — which reports a profit for wallets that
sold *below* their own entry price.

So PnL covers only the **matched** portion, the tokens whose buy price is actually in view:

```
matched   = min(tokens_sold, tokens_bought)
pnl       = (avg_sell_price - avg_buy_price) × matched
roi       = pnl / usd_spent
multiple  = avg_sell_price / avg_buy_price
```

The sign of PnL therefore always agrees with the multiple, and ROI is defined for every
wallet: one that closed its whole position lands on `multiple - 1`, one still holding lands
proportionally lower.

Measured on one token's top 100 before this was fixed: **$407,503 of claimed profit against
$63,039 real**, with **34 of 100 wallets showing a gain on a sub-1x multiple**. One wallet
reported +$73,127 on a 1.00x multiple; its matched profit was $332.

The trade-off is that a wallet whose entry sits before the window shows less profit than it
really made — flagged with ⚠. Widening the window is the fix: it pulls more of that wallet's
history into view. If most rows carry ⚠, the token is older than the window you picked.

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
