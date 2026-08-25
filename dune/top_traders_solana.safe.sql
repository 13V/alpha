-- ============================================================================
-- CANDIDATE (safe) -- NOT LIVE. Two plan changes plus a determinism fix.
-- ============================================================================
-- MEASURED on GUmbtfjSZkybSFgPibBcvwExEBdXwewJHR5PkTjzpump, 1095d, large:
--
--   live query                        291.1s engine
--   this, before the as-of rewrite    115.7s engine   (2.52x)
--   plan: dex_solana.trades scans     8 -> 4
--   plan: transfer tables             8 -> 2
--   wallet set and rank order         identical
--
-- The as-of rewrite below landed after that timing and is NOT yet measured --
-- it replaces a single-node running window with an equi-join, so it should not
-- be slower, but should is not measured. Run scripts/ab-query.mjs before this
-- goes anywhere near the app.
--
-- THE THREE CHANGES
--
--   1. Read the two SPL transfer tables, not tokens_solana.transfers.
--      That view unions eight tables. Six carry native SOL -- sol_transfers is
--      every SOL transfer on Solana, plus vote and nonce withdrawals and
--      account opens and closes. A filter on token_mint_address cannot match a
--      row in any of them, yet all eight were in the plan. Largest single win.
--
--   2. One scan of dex_solana.trades per reference, not two.
--      fills was `WHERE token_bought = X UNION ALL WHERE token_sold = X`. An OR
--      predicate plus UNNEST gets both legs from one scan. Trino inlines a CTE
--      at each reference, so this halves all of them: 8 -> 4.
--
--   3. The as-of price join is an equi-join over minutes, not a running window.
--      Speed and correctness at once -- see the comment at minute_keys.
--
-- THE LIVE QUERY IS NON-DETERMINISTIC. This is not a theory. The live query was
-- run twice, unchanged, same token, same window: the two runs disagreed on 694
-- values, avg_buy_mcap by up to $46.42 and realized_pnl_usd by $0.65. The cause
-- is the tie-break that the as-of window does not have. Any wallet whose
-- transfers land on minute boundaries can be valued at either the current
-- minute's price or the previous one, and which it gets depends on how the
-- rows happened to spread across workers that run.
--
-- MEASURED AND REJECTED, do not retry:
--   * Fixing the tie by adding a second ORDER BY key to the existing window:
--     correct, but 322.1s against the live query's 291.1s. A compound sort key
--     on a single-node window is worse than the ambiguity it fixes.
--   * pumpdotfun_solana.trades and pumpswap_solana.trades in place of
--     dex_solana.trades: those curated tables are views over dex_solana.trades,
--     so the plan went to TEN scans of it instead of fewer.
--   * Deriving the day grid from the price table (see candidate.sql): two more
--     inlined references, 5 scans instead of 4, and 169.3s instead of 115.7s.
-- ============================================================================

WITH
dex_scan AS (
    SELECT
        trader_id AS wallet,
        block_time,
        tx_id,
        COALESCE(amount_usd, 0) AS usd_amount,
        token_bought_mint_address,
        token_sold_mint_address,
        token_bought_amount,
        token_sold_amount
    FROM dex_solana.trades
    WHERE block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND block_time  >= date_add('day', -{{lookback_days}}, now())
      AND (token_bought_mint_address = '{{token_address}}'
        OR token_sold_mint_address   = '{{token_address}}')
),

fills AS (
    SELECT
        d.wallet,
        d.block_time,
        d.tx_id,
        x.side,
        x.token_amount,
        d.usd_amount,
        x.sol_amount
    FROM dex_scan d
    CROSS JOIN UNNEST(ARRAY[
        ROW('buy',
            CASE WHEN d.token_bought_mint_address = '{{token_address}}'
                 THEN d.token_bought_amount ELSE 0 END,
            CASE WHEN d.token_sold_mint_address = 'So11111111111111111111111111111111111111112'
                 THEN d.token_sold_amount ELSE 0 END),
        ROW('sell',
            CASE WHEN d.token_sold_mint_address = '{{token_address}}'
                 THEN d.token_sold_amount ELSE 0 END,
            CASE WHEN d.token_bought_mint_address = 'So11111111111111111111111111111111111111112'
                 THEN d.token_bought_amount ELSE 0 END)
    ]) AS x(side, token_amount, sol_amount)
    WHERE x.token_amount > 0
),

-- Per-minute VWAP from the fills themselves. This is the price used to value
-- tokens that arrive by transfer.
price_minute AS (
    SELECT
        date_trunc('minute', block_time)              AS ts,
        SUM(usd_amount) / SUM(token_amount)           AS price
    FROM fills
    WHERE usd_amount > 0 AND token_amount > 0
    GROUP BY 1
),

swap_tx AS (
    SELECT DISTINCT tx_id FROM fills
),

-- One pass over the transfer log, fanned into a credit and a debit leg. The
-- counterparty rides along so custodial wallets can be recognised below.
transfer_legs AS (
    SELECT
        x.wallet,
        x.direction,
        x.tokens,
        x.counterparty,
        r.block_time
    FROM (
        SELECT block_time, tx_id, amount_display, from_owner, to_owner
        FROM tokens_solana.spl_token_transfers
        WHERE token_mint_address = '{{token_address}}'
          AND block_date >= CAST(date_add('day', -{{lookback_days}}, now()) AS date)
          AND block_time >= date_add('day', -{{lookback_days}}, now())
        UNION ALL
        SELECT block_time, tx_id, amount_display, from_owner, to_owner
        FROM tokens_solana.spl_token_2022_transfers
        WHERE token_mint_address = '{{token_address}}'
          AND block_date >= CAST(date_add('day', -{{lookback_days}}, now()) AS date)
          AND block_time >= date_add('day', -{{lookback_days}}, now())
    ) r
    LEFT JOIN swap_tx s ON s.tx_id = r.tx_id
    CROSS JOIN UNNEST(ARRAY[
        ROW(r.to_owner,   'in' , r.amount_display, r.from_owner),
        ROW(r.from_owner, 'out', r.amount_display, r.to_owner)
    ]) AS x(wallet, direction, tokens, counterparty)
    WHERE s.tx_id IS NULL          -- not the token leg of a swap
      AND x.wallet IS NOT NULL
      AND x.tokens > 0
),

-- As-of join, done as an equi-join rather than a running window.
--
-- The live query unions price minutes with every transfer leg and runs
--
--   LAST_VALUE(price) IGNORE NULLS OVER (ORDER BY block_time ROWS ...)
--
-- over the lot. Two problems. It has no PARTITION BY, so the plan shows
-- LocalExchange[partitioning = SINGLE] and every row goes through one thread.
-- And it has no tie-break, so rows sharing a block_time -- price rows sit at
-- the start of their minute and plenty of transfers land on exactly that
-- instant -- are ordered arbitrarily by however the data spread across
-- workers. Two runs of the live query unchanged disagreed on 694 values,
-- avg_buy_mcap by as much as $46.
--
-- Adding a second sort key fixes the ordering but not the single node, and
-- measured worse than the original: 322s against 291s.
--
-- So the fill happens over minutes instead. Every minute that carries either a
-- price or a transfer, forward-filled once -- a small set, one row per minute,
-- not one per transfer leg -- and then each transfer joins its own minute by
-- equality. Minute keys are distinct, so there is nothing left to tie-break
-- and the result is the same on every run.
minute_keys AS (
    SELECT DISTINCT m
    FROM (
        SELECT ts AS m FROM price_minute
        UNION ALL
        SELECT date_trunc('minute', block_time) FROM transfer_legs
    )
),

minute_fill AS (
    SELECT
        k.m,
        LAST_VALUE(p.price) IGNORE NULLS OVER (
            ORDER BY k.m ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS px
    FROM minute_keys k
    LEFT JOIN price_minute p ON p.ts = k.m
),

priced_transfers AS (
    SELECT
        t.wallet,
        t.direction,
        t.tokens,
        t.counterparty,
        f.px AS price_then
    FROM transfer_legs t
    JOIN minute_fill f ON f.m = date_trunc('minute', t.block_time)
),

per_transfer_wallet AS (
    SELECT
        wallet,
        SUM(CASE WHEN direction = 'in'  THEN tokens ELSE 0 END)                        AS tokens_in,
        SUM(CASE WHEN direction = 'in'  THEN tokens * COALESCE(price_then, 0) ELSE 0 END) AS value_in,
        SUM(CASE WHEN direction = 'out' THEN tokens ELSE 0 END)                        AS tokens_out,
        COUNT(DISTINCT counterparty)                                                   AS transfer_peers
    FROM priced_transfers
    WHERE wallet IS NOT NULL
    GROUP BY 1
),

supply AS (
    SELECT SUM(token_balance) AS total_supply
    FROM solana_utils.latest_balances
    WHERE token_mint_address = '{{token_address}}'
),

token_meta AS (
    SELECT symbol, name
    FROM tokens_solana.fungible
    WHERE token_mint_address = '{{token_address}}'
      AND address_prefix = lower(substr('{{token_address}}', 1, 1))
    LIMIT 1
),

per_wallet AS (
    SELECT
        wallet,
        SUM(CASE WHEN side = 'buy'  THEN token_amount ELSE 0 END) AS tokens_bought,
        SUM(CASE WHEN side = 'sell' THEN token_amount ELSE 0 END) AS tokens_sold,
        SUM(CASE WHEN side = 'buy'  THEN usd_amount   ELSE 0 END) AS usd_spent,
        SUM(CASE WHEN side = 'sell' THEN usd_amount   ELSE 0 END) AS usd_received,
        SUM(CASE WHEN side = 'buy'  THEN sol_amount   ELSE 0 END) AS sol_spent,
        SUM(CASE WHEN side = 'sell' THEN sol_amount   ELSE 0 END) AS sol_received,
        COUNT_IF(side = 'buy')                                    AS buy_count,
        COUNT_IF(side = 'sell')                                   AS sell_count,
        MIN(block_time)                                           AS first_trade,
        MAX(block_time)                                           AS last_trade
    FROM fills
    GROUP BY 1
    HAVING SUM(usd_amount) >= {{min_usd}}
        OR SUM(usd_amount) = 0
),

joined AS (
    SELECT
        w.*,
        COALESCE(t.tokens_in, 0)      AS tokens_in,
        COALESCE(t.value_in, 0)       AS value_in,
        COALESCE(t.tokens_out, 0)     AS tokens_out,
        COALESCE(t.transfer_peers, 0) AS transfer_peers,
        -- everything the wallet ever got hold of, and what it cost
        w.tokens_bought + COALESCE(t.tokens_in, 0) AS acquired_tokens,
        w.usd_spent     + COALESCE(t.value_in, 0)  AS acquired_cost
    FROM per_wallet w
    LEFT JOIN per_transfer_wallet t ON t.wallet = w.wallet
    -- Custodial infrastructure is not a trader. An exchange hot wallet on one
    -- measured token moved 458M tokens in and 458M out across ~4,000 distinct
    -- counterparties each way; the real top trader had exactly one. Wallets
    -- exchanging this token with hundreds of distinct peers are deposit
    -- sweeps, not people, and ranking them buries the actual winners.
    WHERE COALESCE(t.transfer_peers, 0) <= 200
),

marked AS (
    SELECT
        j.*,
        j.acquired_cost / NULLIF(j.acquired_tokens, 0) AS avg_cost_price,
        (SELECT price FROM price_minute ORDER BY ts DESC LIMIT 1) AS market_price
    FROM joined j
),

enriched AS (
    SELECT
        m.*,
        s.total_supply,
        tm.symbol AS token_symbol,
        tm.name   AS token_name,
        GREATEST(m.acquired_tokens - m.tokens_sold - m.tokens_out, 0) AS net_position,
        m.usd_received / NULLIF(m.tokens_sold, 0)                     AS avg_sell_price,
        -- proceeds minus the cost of what was sold, on a basis that now
        -- includes tokens that arrived by transfer
        m.usd_received
          - (m.acquired_cost / NULLIF(m.acquired_tokens, 0))
            * LEAST(m.tokens_sold, m.acquired_tokens)                 AS realized_pnl_usd
    FROM marked m
    CROSS JOIN supply s
    LEFT JOIN token_meta tm ON true
)

SELECT
    ROW_NUMBER() OVER (ORDER BY realized_pnl_usd DESC)    AS rank,
    wallet,
    realized_pnl_usd,
    net_position * (market_price - avg_cost_price)        AS unrealized_pnl_usd,
    realized_pnl_usd + net_position * (market_price - avg_cost_price) AS total_pnl_usd,
    avg_sell_price / NULLIF(avg_cost_price, 0)            AS profit_multiple,
    realized_pnl_usd / NULLIF(acquired_cost, 0)           AS realized_roi,
    avg_cost_price                                        AS avg_buy_price,
    avg_sell_price,
    avg_cost_price * total_supply                         AS avg_buy_mcap,
    avg_sell_price * total_supply                         AS avg_sell_mcap,
    market_price   * total_supply                         AS current_mcap,
    acquired_cost                                         AS usd_spent,
    usd_received,
    sol_spent,
    sol_received,
    acquired_tokens                                       AS tokens_bought,
    tokens_sold,
    tokens_in                                             AS tokens_received,
    value_in                                              AS received_value_usd,
    net_position                                          AS tokens_held,
    net_position * market_price                           AS value_usd,
    net_position / NULLIF(total_supply, 0) * 100          AS pct_supply_held,
    CASE
        WHEN tokens_sold >= acquired_tokens * 0.99 THEN 'closed'
        WHEN tokens_sold > 0                       THEN 'partial'
        ELSE 'holding'
    END                                                   AS position_status,
    CASE
        WHEN tokens_sold > acquired_tokens * 1.01 THEN 'partial'
        ELSE 'full'
    END                                                   AS cost_basis,
    -- how much of what this wallet sold we can account for, buys plus
    -- priced transfers in. 1.0 means the PnL above rests on a real cost.
    LEAST(acquired_tokens / NULLIF(tokens_sold, 0), 1.0)  AS buy_coverage,
    transfer_peers,
    buy_count,
    sell_count,
    first_trade,
    last_trade,
    date_diff('hour', first_trade, last_trade)            AS hold_hours,
    token_symbol,
    token_name,
    total_supply                                          AS circulating_supply
FROM enriched
ORDER BY realized_pnl_usd DESC
LIMIT {{wallet_limit}}
