-- ============================================================================
-- Bagtrace — Top traders of an EVM token, ranked by realized PnL.
-- Base, BNB Chain, Ethereum, Arbitrum, Optimism, Polygon.
-- ============================================================================
-- Source: dex.trades (every decoded EVM DEX swap)
--         tokens.fdv_latest (supply, symbol and current price — a tiny table)
--
-- Parameters:
--   blockchain     enum    base | bnb | ethereum | arbitrum | optimism | polygon
--   token_address  text    0x-prefixed contract address
--   wallet_limit   number  how many wallets to return
--   lookback_days  number  only scan trades from the last N days (cost control)
--   min_usd        number  drop wallets whose total traded volume is below this
--
-- The wallet reported is `tx_from`, the EOA that signed the swap. `taker` is
-- usually a router or aggregator contract, so tx_from is the address worth
-- copy-trading. Both are returned.
-- ============================================================================

WITH
token AS (
    SELECT from_hex(replace(lower('{{token_address}}'), '0x', '')) AS addr
),

wnative AS (
    SELECT CASE '{{blockchain}}'
        WHEN 'ethereum' THEN 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
        WHEN 'base'     THEN 0x4200000000000000000000000000000000000006
        WHEN 'bnb'      THEN 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c
        WHEN 'arbitrum' THEN 0x82af49447d8a07e3bd95bd0d56f35241523fbab1
        WHEN 'optimism' THEN 0x4200000000000000000000000000000000000006
        WHEN 'polygon'  THEN 0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270
    END AS addr
),

meta AS (
    SELECT symbol, supply, price
    FROM tokens.fdv_latest
    WHERE blockchain = '{{blockchain}}'
      AND token_address = (SELECT addr FROM token)
    LIMIT 1
),

fills AS (
    SELECT
        tx_from                                                     AS wallet,
        taker,
        block_time,
        'buy'                                                       AS side,
        token_bought_amount                                         AS token_amount,
        COALESCE(amount_usd, 0)                                     AS usd_amount,
        CASE WHEN token_sold_address = (SELECT addr FROM wnative)
             THEN token_sold_amount ELSE 0 END                      AS native_amount,
        CASE WHEN COALESCE(amount_usd, 0) > 0 AND token_bought_amount > 0
             THEN amount_usd / token_bought_amount END              AS fill_price
    FROM dex.trades
    WHERE blockchain = '{{blockchain}}'
      AND token_bought_address = (SELECT addr FROM token)
      AND block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND block_time  >= date_add('day', -{{lookback_days}}, now())
      AND token_bought_amount > 0

    UNION ALL

    SELECT
        tx_from,
        taker,
        block_time,
        'sell',
        token_sold_amount,
        COALESCE(amount_usd, 0),
        CASE WHEN token_bought_address = (SELECT addr FROM wnative)
             THEN token_bought_amount ELSE 0 END,
        CASE WHEN COALESCE(amount_usd, 0) > 0 AND token_sold_amount > 0
             THEN amount_usd / token_sold_amount END
    FROM dex.trades
    WHERE blockchain = '{{blockchain}}'
      AND token_sold_address = (SELECT addr FROM token)
      AND block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND block_time  >= date_add('day', -{{lookback_days}}, now())
      AND token_sold_amount > 0
),

per_wallet AS (
    SELECT
        wallet,
        MAX(taker)                                                 AS last_taker,
        SUM(CASE WHEN side = 'buy'  THEN token_amount  ELSE 0 END) AS tokens_bought,
        SUM(CASE WHEN side = 'sell' THEN token_amount  ELSE 0 END) AS tokens_sold,
        SUM(CASE WHEN side = 'buy'  THEN usd_amount    ELSE 0 END) AS usd_spent,
        SUM(CASE WHEN side = 'sell' THEN usd_amount    ELSE 0 END) AS usd_received,
        SUM(CASE WHEN side = 'buy'  THEN native_amount ELSE 0 END) AS native_spent,
        SUM(CASE WHEN side = 'sell' THEN native_amount ELSE 0 END) AS native_received,
        COUNT_IF(side = 'buy')                                     AS buy_count,
        COUNT_IF(side = 'sell')                                    AS sell_count,
        MIN(block_time)                                            AS first_trade,
        MAX(block_time)                                            AS last_trade,
        MAX_BY(fill_price, block_time) FILTER (WHERE fill_price IS NOT NULL) AS wallet_last_price,
        MAX(block_time)                FILTER (WHERE fill_price IS NOT NULL) AS wallet_priced_at
    FROM fills
    GROUP BY 1
    -- Apply the USD floor only where the pair actually has USD pricing. On a
    -- brand-new or very thin pair amount_usd is null on every fill, and a naive
    -- floor would drop every wallet and report "no results" for a token that
    -- did in fact trade.
    HAVING SUM(usd_amount) >= {{min_usd}}
        OR SUM(usd_amount) = 0
),

marked AS (
    SELECT
        w.*,
        FIRST_VALUE(w.wallet_last_price) OVER (
            ORDER BY w.wallet_priced_at DESC NULLS LAST
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS last_fill_price
    FROM per_wallet w
),

enriched AS (
    SELECT
        m.wallet,
        m.last_taker,
        m.tokens_bought,
        m.tokens_sold,
        m.usd_spent,
        m.usd_received,
        m.native_spent,
        m.native_received,
        m.buy_count,
        m.sell_count,
        m.first_trade,
        m.last_trade,
        mt.symbol                                                     AS token_symbol,
        mt.supply                                                     AS total_supply,
        COALESCE(mt.price, m.last_fill_price)                         AS market_price,
        GREATEST(m.tokens_bought - m.tokens_sold, 0)                  AS net_position,
        m.usd_spent    / NULLIF(m.tokens_bought, 0)                   AS avg_buy_price,
        m.usd_received / NULLIF(m.tokens_sold,   0)                   AS avg_sell_price,
        -- Cash accounting: what came out minus what went in. This is the
        -- convention Solana terminals (Padre, Axiom) use, and it is the only
        -- one that works here, because Dune's Solana buy-side coverage is
        -- incomplete. On one measured pump.fun token, recorded sells exceeded
        -- recorded buys by 1.68x in token terms and only 9 bonding-curve buy
        -- fills existed at all, so the earliest buyers -- the ones who
        -- actually made the money -- have no buy row to match against. A
        -- matched-only formula scores exactly those wallets at zero and hides
        -- them. Where buys are missing this is an UPPER BOUND, flagged below
        -- as cost_basis = 'partial'.
        m.usd_received - m.usd_spent                                  AS realized_pnl_usd,
        GREATEST(m.tokens_bought - m.tokens_sold, 0)
          * (COALESCE(mt.price, m.last_fill_price)
             - COALESCE(m.usd_spent / NULLIF(m.tokens_bought, 0), 0)) AS unrealized_pnl_usd
    FROM marked m
    LEFT JOIN meta mt ON true
)

SELECT
    ROW_NUMBER() OVER (ORDER BY realized_pnl_usd DESC)    AS rank,
    wallet,
    last_taker                                            AS taker,
    realized_pnl_usd,
    unrealized_pnl_usd,
    realized_pnl_usd + unrealized_pnl_usd                 AS total_pnl_usd,
    avg_sell_price / NULLIF(avg_buy_price, 0)             AS profit_multiple,
    -- Now that PnL covers only the matched portion, ROI is well defined for
    -- every wallet: realized profit against the capital it actually put in.
    -- A wallet that closed everything lands on multiple - 1; one still holding
    -- lands proportionally lower.
    realized_pnl_usd / NULLIF(usd_spent, 0)               AS realized_roi,
    avg_buy_price,
    avg_sell_price,
    avg_buy_price  * total_supply                         AS avg_buy_mcap,
    avg_sell_price * total_supply                         AS avg_sell_mcap,
    market_price   * total_supply                         AS current_mcap,
    usd_spent,
    usd_received,
    native_spent,
    native_received,
    tokens_bought,
    tokens_sold,
    net_position                                          AS tokens_held,
    net_position * market_price                           AS value_usd,
    net_position / NULLIF(total_supply, 0) * 100          AS pct_supply_held,
    CASE
        WHEN tokens_sold >= tokens_bought * 0.99 THEN 'closed'
        WHEN tokens_sold > 0                     THEN 'partial'
        ELSE 'holding'
    END                                                   AS position_status,
    -- A wallet that sold more than it bought inside the window was already
    -- holding when the window opened, so its cost basis is incomplete and the
    -- multiple can disagree with the PnL. Flag it rather than hide it.
    CASE
        WHEN tokens_sold > tokens_bought * 1.01 THEN 'partial'
        ELSE 'full'
    END                                                   AS cost_basis,
    -- How much of what this wallet sold we can actually see it buy. 1.0 means
    -- the PnL above is trustworthy; 0 means every token it sold arrived from
    -- somewhere Dune did not record, so the PnL is an upper bound with no
    -- cost subtracted at all. Rank with this in view, not just the dollars.
    LEAST(tokens_bought / NULLIF(tokens_sold, 0), 1.0)    AS buy_coverage,
    buy_count,
    sell_count,
    first_trade,
    last_trade,
    date_diff('hour', first_trade, last_trade)            AS hold_hours,
    token_symbol,
    total_supply                                          AS circulating_supply
FROM enriched
ORDER BY realized_pnl_usd DESC
LIMIT {{wallet_limit}}
