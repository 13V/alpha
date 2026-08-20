-- ============================================================================
-- Bagtrace — Top traders of a Solana SPL token, ranked by realized PnL.
-- ============================================================================
-- Source: dex_solana.trades       every decoded Solana DEX/AMM swap
--         tokens_solana.transfers SPL movements, for tokens that arrived
--                                 without a swap
--         solana_utils.latest_balances  circulating supply
--
-- Parameters:
--   token_address  text    SPL mint address
--   wallet_limit   number  how many wallets to return
--   lookback_days  number  how far back to scan (cost control)
--   min_usd        number  drop wallets below this traded volume
--
-- WHY TRANSFERS MATTER
-- On pump.fun tokens most of the real winners never appear as buyers. Measured
-- on 6ehEcTMCc85aNF4x9CWx8HuvWGhxQtvKdhKVf2HDpump, recorded sells exceeded
-- recorded buys by 1.68x token-wide, and the wallet a Solana terminal ranks
-- first had 1,290 sell fills and zero buy fills across every trade table Dune
-- has, including the raw bonding-curve event log. It had not bought at all: it
-- RECEIVED 21,865,947 tokens in one transfer, then sold them.
--
-- Treating those tokens as free costs nothing and reports every dollar of
-- proceeds as profit. Matching sales only against recorded buys scores such a
-- wallet at exactly zero and hides it. Both are wrong.
--
-- So tokens that arrive by transfer are valued at the market price at the
-- moment they land, and that value becomes cost basis. For the wallet above
-- this yields $658 of basis against a terminal's independently published
-- $658.0 -- the same method, reproduced on Dune.
--
-- Transfers that are the token leg of a swap are excluded by tx id, otherwise
-- every DEX buy would be counted twice. Transfers OUT reduce the remaining
-- position but are never counted as proceeds: moving tokens is not selling.
-- ============================================================================

WITH
fills AS (
    SELECT
        trader_id                                                   AS wallet,
        block_time,
        tx_id,
        'buy'                                                       AS side,
        token_bought_amount                                         AS token_amount,
        COALESCE(amount_usd, 0)                                     AS usd_amount,
        CASE
            WHEN token_sold_mint_address = 'So11111111111111111111111111111111111111112'
            THEN token_sold_amount ELSE 0
        END                                                         AS sol_amount
    FROM dex_solana.trades
    WHERE token_bought_mint_address = '{{token_address}}'
      AND block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND block_time  >= date_add('day', -{{lookback_days}}, now())
      AND token_bought_amount > 0

    UNION ALL

    SELECT
        trader_id,
        block_time,
        tx_id,
        'sell',
        token_sold_amount,
        COALESCE(amount_usd, 0),
        CASE
            WHEN token_bought_mint_address = 'So11111111111111111111111111111111111111112'
            THEN token_bought_amount ELSE 0
        END
    FROM dex_solana.trades
    WHERE token_sold_mint_address = '{{token_address}}'
      AND block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND block_time  >= date_add('day', -{{lookback_days}}, now())
      AND token_sold_amount > 0
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

-- One pass over the transfer log, fanned into a credit and a debit leg.
transfer_legs AS (
    SELECT
        x.wallet,
        x.direction,
        x.tokens,
        r.block_time
    FROM tokens_solana.transfers r
    LEFT JOIN swap_tx s ON s.tx_id = r.tx_id
    CROSS JOIN UNNEST(ARRAY[
        ROW(r.to_owner,   'in' , r.amount_display),
        ROW(r.from_owner, 'out', r.amount_display)
    ]) AS x(wallet, direction, tokens)
    WHERE r.token_mint_address = '{{token_address}}'
      AND r.block_date >= CAST(date_add('day', -{{lookback_days}}, now()) AS date)
      AND r.block_time >= date_add('day', -{{lookback_days}}, now())
      AND s.tx_id IS NULL          -- not the token leg of a swap
      AND x.wallet IS NOT NULL
      AND x.tokens > 0
),

-- As-of join: carry the last known price forward onto each transfer.
timeline AS (
    SELECT ts AS block_time, price,
           CAST(NULL AS varchar) AS wallet,
           CAST(NULL AS varchar) AS direction,
           CAST(NULL AS double)  AS tokens
    FROM price_minute
    UNION ALL
    SELECT block_time, CAST(NULL AS double), wallet, direction, CAST(tokens AS double)
    FROM transfer_legs
),

priced_transfers AS (
    SELECT
        wallet,
        direction,
        tokens,
        LAST_VALUE(price) IGNORE NULLS OVER (
            ORDER BY block_time
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS price_then
    FROM timeline
),

per_transfer_wallet AS (
    SELECT
        wallet,
        SUM(CASE WHEN direction = 'in'  THEN tokens ELSE 0 END)                        AS tokens_in,
        SUM(CASE WHEN direction = 'in'  THEN tokens * COALESCE(price_then, 0) ELSE 0 END) AS value_in,
        SUM(CASE WHEN direction = 'out' THEN tokens ELSE 0 END)                        AS tokens_out
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
        COALESCE(t.tokens_in, 0)  AS tokens_in,
        COALESCE(t.value_in, 0)   AS value_in,
        COALESCE(t.tokens_out, 0) AS tokens_out,
        -- everything the wallet ever got hold of, and what it cost
        w.tokens_bought + COALESCE(t.tokens_in, 0) AS acquired_tokens,
        w.usd_spent     + COALESCE(t.value_in, 0)  AS acquired_cost
    FROM per_wallet w
    LEFT JOIN per_transfer_wallet t ON t.wallet = w.wallet
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
