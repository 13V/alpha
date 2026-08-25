-- ============================================================================
-- CANDIDATE -- faster rewrite of top_traders_solana.sql. NOT LIVE.
-- ============================================================================
-- MEASURED on GUmbtfjSZkybSFgPibBcvwExEBdXwewJHR5PkTjzpump, 1095d, large:
--
--   engine time     291.1s -> 169.3s   (1.71x)
--   dex_solana.trades scans in plan   8 -> 5
--   transfer tables in plan           8 -> 2
--   wallet set and rank order         identical
--   realized_pnl_usd                  within 0.21% (largest move $10.17)
--   received_value_usd                differs on 42 of 100 wallets
--
-- The last line is why this is still NOT LIVE. See (3).
--
-- THREE CHANGES:
--
--   1. Read the two SPL transfer tables instead of tokens_solana.transfers.
--      That view unions eight tables, six of which are native SOL movement --
--      sol_transfers alone is every SOL transfer on Solana. A filter on
--      token_mint_address cannot match a row in any of them, but the query
--      plan still carried all eight. This is the single largest win here.
--
--   2. One pass over dex_solana.trades per reference instead of two.
--      fills was `WHERE token_bought = X UNION ALL WHERE token_sold = X`; an OR
--      predicate plus UNNEST gets both legs from one scan. Trino inlines a CTE
--      at every reference, so the count that matters is references x scans:
--      the plan went from 8 to 5. Getting below 5 means breaking the DAG --
--      price_minute genuinely feeds three branches -- which SQL cannot express
--      without materialisation. The generated day_grid exists for this reason:
--      reading the grid bounds off the price table cost two more scans.
--
--   3. The price fill no longer sorts every row on one node.
--      The live query does:
--
--        LAST_VALUE(price) IGNORE NULLS OVER (
--            ORDER BY block_time ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
--
--      over price minutes UNION every transfer leg, with no PARTITION BY. The
--      plan confirms it: LocalExchange[partitioning = SINGLE] feeding the
--      window. Every row through one thread. Here the fill runs inside day
--      partitions and days are stitched by a carry over one row per day.
--
--      This is also the one change that moves numbers, and it is not yet
--      explained. The intent -- a transfer takes the last price at or before
--      its own block_time -- is the same under both, and both directions of
--      drift appear, which points at ordering of equal timestamps rather than
--      a bias. But "points at" is not "shown", and until it is shown this
--      stays out of the app. Changes 1 and 2 are pure plan changes and touch
--      no arithmetic; if 3 cannot be reconciled, ship 1 and 2 alone.
--
-- REJECTED, measured, do not retry: reading pumpdotfun_solana.trades and
-- pumpswap_solana.trades instead of dex_solana.trades. Those curated tables
-- are views over dex_solana.trades, so the plan went to TEN scans of it.
--
-- VERIFY: scripts/ab-query.mjs <live> <this> <token> [days]
-- ============================================================================

WITH
-- One scan. The mint can be on either side of the swap, so filter on both and
-- fan the row out into its buy leg and its sell leg afterwards.
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
        d.usd_amount,
        x.side,
        x.token_amount,
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

price_minute AS (
    SELECT
        date_trunc('minute', block_time)    AS ts,
        SUM(usd_amount) / SUM(token_amount) AS price
    FROM fills
    WHERE usd_amount > 0 AND token_amount > 0
    GROUP BY 1
),

swap_tx AS (
    SELECT DISTINCT tx_id FROM fills
),

priced_day AS (
    SELECT CAST(date_trunc('day', ts) AS date) AS d, MAX_BY(price, ts) AS px
    FROM price_minute
    GROUP BY 1
),

-- Every day in the requested window, from the parameters alone. Reading the
-- bounds off the price table instead would mean referencing it twice, and
-- Trino inlines a CTE at every reference -- each one another scan of
-- dex_solana.trades underneath. A generated grid costs no scan at all, and at
-- the widest window this app offers it is about 1,100 rows.
day_grid AS (
    SELECT t.day AS d
    FROM UNNEST(sequence(
        CAST(date_add('day', -{{lookback_days}}, now()) AS date),
        CAST(now() AS date),
        INTERVAL '1' DAY
    )) AS t(day)
),

-- Close of each day, carried forward. The grid has to be dense: a token can go
-- a week without a trade while transfers keep moving, and a transfer on one of
-- those days still needs the last price before it. Joining a sparse table on
-- "yesterday" would hand those days a null.
day_close AS (
    SELECT
        g.d,
        LAST_VALUE(p.px) IGNORE NULLS OVER (
            ORDER BY g.d ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS carry
    FROM day_grid g
    LEFT JOIN priced_day p ON p.d = g.d
),

transfer_legs AS (
    SELECT
        x.wallet,
        x.direction,
        x.tokens,
        x.counterparty,
        r.block_time
    FROM (
        -- tokens_solana.transfers is a view over eight tables, only two of
        -- which can hold an SPL mint. The other six are native SOL movement --
        -- sol_transfers, vote withdrawals, nonce withdrawals, account opens and
        -- closes -- and sol_transfers alone is every SOL transfer on Solana.
        -- Filtering the view by token_mint_address cannot match a row in any of
        -- them, but they are still in the plan. Reading the two SPL tables
        -- directly asks for exactly the rows that can match.
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

-- Prices and transfers interleaved, but keyed by day so the fill below can be
-- split across workers.
timeline AS (
    SELECT
        CAST(date_trunc('day', ts) AS date) AS day,
        ts                                  AS block_time,
        price,
        CAST(NULL AS varchar) AS wallet,
        CAST(NULL AS varchar) AS direction,
        CAST(NULL AS double)  AS tokens,
        CAST(NULL AS varchar) AS counterparty
    FROM price_minute
    UNION ALL
    SELECT
        CAST(date_trunc('day', block_time) AS date),
        block_time,
        CAST(NULL AS double),
        wallet,
        direction,
        CAST(tokens AS double),
        counterparty
    FROM transfer_legs
),

-- Fill within the day, in parallel across days.
intraday AS (
    SELECT
        day,
        wallet,
        direction,
        tokens,
        counterparty,
        LAST_VALUE(price) IGNORE NULLS OVER (
            PARTITION BY day
            ORDER BY block_time
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS price_today
    FROM timeline
),

-- Anything still unpriced sits before the day's first trade, so it takes the
-- close of the last priced day before it.
priced_transfers AS (
    SELECT
        i.wallet,
        i.direction,
        i.tokens,
        i.counterparty,
        COALESCE(i.price_today, c.carry) AS price_then
    FROM intraday i
    LEFT JOIN day_close c ON c.d = date_add('day', -1, i.day)
    WHERE i.wallet IS NOT NULL
),

per_transfer_wallet AS (
    SELECT
        wallet,
        SUM(CASE WHEN direction = 'in'  THEN tokens ELSE 0 END)                           AS tokens_in,
        SUM(CASE WHEN direction = 'in'  THEN tokens * COALESCE(price_then, 0) ELSE 0 END) AS value_in,
        SUM(CASE WHEN direction = 'out' THEN tokens ELSE 0 END)                           AS tokens_out,
        COUNT(DISTINCT counterparty)                                                      AS transfer_peers
    FROM priced_transfers
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
        w.tokens_bought + COALESCE(t.tokens_in, 0) AS acquired_tokens,
        w.usd_spent     + COALESCE(t.value_in, 0)  AS acquired_cost
    FROM per_wallet w
    LEFT JOIN per_transfer_wallet t ON t.wallet = w.wallet
    -- Custodial infrastructure is not a trader; see the live query for the
    -- measurement behind this threshold.
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
