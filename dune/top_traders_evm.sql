-- ============================================================================
-- Alpha Wallets — Top traders for an EVM token, ranked by realized PnL.
-- Works on Base, BNB Chain, Ethereum, Arbitrum, Optimism, Polygon.
-- ============================================================================
-- Data source : dex.trades (all EVM DEX swaps, decimal-adjusted + USD priced)
--               balances_<chain>.latest (current balances, for holdings)
--
-- Parameters:
--   blockchain     enum    base | bnb | ethereum | arbitrum | optimism | polygon
--   token_address  text    0x-prefixed contract address
--   wallet_limit   number  how many wallets to return (100 / 250 / 500)
--   lookback_days  number  only look at trades from the last N days (cost control)
--   min_usd        number  ignore wallets whose total traded volume is below this
--
-- The wallet reported is `tx_from` — the EOA that signed the swap. `taker` is
-- often a router/aggregator contract, so tx_from is what you actually want to
-- copy-trade. Both are returned so you can eyeball the difference.
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

fills AS (
    SELECT
        tx_from                                                     AS wallet,
        taker,
        block_time,
        'buy'                                                       AS side,
        token_bought_amount                                         AS token_amount,
        COALESCE(amount_usd, 0)                                     AS usd_amount,
        CASE WHEN token_sold_address = (SELECT addr FROM wnative)
             THEN token_sold_amount ELSE 0 END                      AS native_amount
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
             THEN token_bought_amount ELSE 0 END
    FROM dex.trades
    WHERE blockchain = '{{blockchain}}'
      AND token_sold_address = (SELECT addr FROM token)
      AND block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND block_time  >= date_add('day', -{{lookback_days}}, now())
      AND token_sold_amount > 0
),

last_price AS (
    SELECT usd_amount / token_amount AS price
    FROM fills
    WHERE usd_amount > 0 AND token_amount > 0
    ORDER BY block_time DESC
    LIMIT 1
),

supply AS (
    SELECT SUM(balance) AS total_supply
    FROM balances_{{blockchain}}.latest
    WHERE token_address = (SELECT addr FROM token)
),

holdings AS (
    SELECT address AS wallet, SUM(balance) AS balance
    FROM balances_{{blockchain}}.latest
    WHERE token_address = (SELECT addr FROM token)
      AND balance > 0
    GROUP BY 1
),

per_wallet AS (
    SELECT
        wallet,
        MAX(taker)                                                AS last_taker,
        SUM(CASE WHEN side = 'buy'  THEN token_amount  ELSE 0 END) AS tokens_bought,
        SUM(CASE WHEN side = 'sell' THEN token_amount  ELSE 0 END) AS tokens_sold,
        SUM(CASE WHEN side = 'buy'  THEN usd_amount    ELSE 0 END) AS usd_spent,
        SUM(CASE WHEN side = 'sell' THEN usd_amount    ELSE 0 END) AS usd_received,
        SUM(CASE WHEN side = 'buy'  THEN native_amount ELSE 0 END) AS native_spent,
        SUM(CASE WHEN side = 'sell' THEN native_amount ELSE 0 END) AS native_received,
        COUNT_IF(side = 'buy')                                     AS buy_count,
        COUNT_IF(side = 'sell')                                    AS sell_count,
        MIN(block_time)                                            AS first_trade,
        MAX(block_time)                                            AS last_trade
    FROM fills
    GROUP BY 1
),

enriched AS (
    SELECT
        w.*,
        COALESCE(h.balance, 0)                                        AS tokens_held,
        w.usd_spent    / NULLIF(w.tokens_bought, 0)                   AS avg_buy_price,
        w.usd_received / NULLIF(w.tokens_sold,   0)                   AS avg_sell_price,
        w.usd_received
          - (w.usd_spent / NULLIF(w.tokens_bought, 0))
            * LEAST(w.tokens_sold, w.tokens_bought)                   AS realized_pnl_usd,
        COALESCE(h.balance, 0)
          * ((SELECT price FROM last_price)
             - COALESCE(w.usd_spent / NULLIF(w.tokens_bought, 0), 0)) AS unrealized_pnl_usd
    FROM per_wallet w
    LEFT JOIN holdings h ON h.wallet = w.wallet
    WHERE w.usd_spent + w.usd_received >= {{min_usd}}
)

SELECT
    ROW_NUMBER() OVER (ORDER BY realized_pnl_usd DESC)          AS rank,
    wallet,
    last_taker                                                  AS taker,
    realized_pnl_usd,
    unrealized_pnl_usd,
    realized_pnl_usd + unrealized_pnl_usd                       AS total_pnl_usd,
    avg_sell_price / NULLIF(avg_buy_price, 0)                   AS profit_multiple,
    realized_pnl_usd / NULLIF(usd_spent, 0)                     AS realized_roi,
    avg_buy_price,
    avg_sell_price,
    avg_buy_price  * (SELECT total_supply FROM supply)          AS avg_buy_mcap,
    avg_sell_price * (SELECT total_supply FROM supply)          AS avg_sell_mcap,
    (SELECT price FROM last_price) * (SELECT total_supply FROM supply) AS current_mcap,
    (SELECT total_supply FROM supply)                                 AS circulating_supply,
    usd_spent,
    usd_received,
    native_spent,
    native_received,
    tokens_bought,
    tokens_sold,
    tokens_held,
    tokens_held / NULLIF((SELECT total_supply FROM supply), 0) * 100 AS pct_supply_held,
    CASE
        WHEN tokens_sold >= tokens_bought * 0.99 THEN 'closed'
        WHEN tokens_sold > 0                     THEN 'partial'
        ELSE 'holding'
    END                                                          AS position_status,
    buy_count,
    sell_count,
    first_trade,
    last_trade,
    date_diff('hour', first_trade, last_trade)                   AS hold_hours
FROM enriched
ORDER BY realized_pnl_usd DESC
LIMIT {{wallet_limit}}
