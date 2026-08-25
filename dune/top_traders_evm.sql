-- ============================================================================
-- Who Printed — Top traders of an EVM token, ranked by realized PnL.
-- Base, BNB Chain, Ethereum, Arbitrum, Optimism, Polygon.
-- ============================================================================
-- Source: dex.trades         every decoded EVM DEX swap
--         tokens.transfers   ERC20 movements, for tokens that arrived
--                            without a swap (airdrops, deposits, mints)
--         tokens.fdv_latest  supply, symbol and current price
--
-- Parameters:
--   blockchain     enum    base | bnb | ethereum | arbitrum | optimism | polygon
--   token_address  text    0x-prefixed contract address
--   wallet_limit   number  how many wallets to return
--   lookback_days  number  how far back to scan (cost control)
--   min_usd        number  drop wallets below this traded volume
--
-- Accounting matches the Solana query: tokens that arrive by transfer are
-- valued at the market price when they land (tokens.transfers carries its own
-- amount_usd; where that is null the per-minute VWAP from DEX fills fills in)
-- and that value becomes cost basis. Transfers that are the token leg of a
-- swap are excluded by tx_hash. Transfers out reduce the position but never
-- count as proceeds. Custodial wallets — hundreds of distinct transfer
-- counterparties — are excluded from the ranking entirely.
--
-- The wallet reported is `tx_from`, the EOA that signed the swap; `taker` is
-- usually a router.
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
        tx_hash,
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
        tx_hash,
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

price_minute AS (
    SELECT
        date_trunc('minute', block_time)    AS ts,
        SUM(usd_amount) / SUM(token_amount) AS price
    FROM fills
    WHERE usd_amount > 0 AND token_amount > 0
    GROUP BY 1
),

swap_tx AS (
    SELECT DISTINCT tx_hash FROM fills
),

transfer_legs AS (
    SELECT
        x.wallet,
        x.direction,
        x.tokens,
        x.usd_value,
        x.counterparty,
        r.block_time
    FROM tokens.transfers r
    LEFT JOIN swap_tx s ON s.tx_hash = r.tx_hash
    CROSS JOIN UNNEST(ARRAY[
        ROW(r."to",   'in' , r.amount, r.amount_usd, r."from"),
        ROW(r."from", 'out', r.amount, r.amount_usd, r."to")
    ]) AS x(wallet, direction, tokens, usd_value, counterparty)
    WHERE r.blockchain = '{{blockchain}}'
      AND r.contract_address = (SELECT addr FROM token)
      AND r.block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND r.block_time  >= date_add('day', -{{lookback_days}}, now())
      AND s.tx_hash IS NULL          -- not the token leg of a swap
      AND x.wallet IS NOT NULL
      AND x.wallet <> 0x0000000000000000000000000000000000000000
      AND x.wallet <> 0x000000000000000000000000000000000000dead
      AND x.tokens > 0
),

timeline AS (
    SELECT ts AS block_time, price,
           CAST(NULL AS varbinary) AS wallet,
           CAST(NULL AS varchar)   AS direction,
           CAST(NULL AS double)    AS tokens,
           CAST(NULL AS double)    AS usd_value,
           CAST(NULL AS varbinary) AS counterparty
    FROM price_minute
    UNION ALL
    SELECT block_time, CAST(NULL AS double), wallet, direction,
           CAST(tokens AS double), CAST(usd_value AS double), counterparty
    FROM transfer_legs
),

priced_transfers AS (
    SELECT
        wallet,
        direction,
        tokens,
        usd_value,
        counterparty,
        LAST_VALUE(price) IGNORE NULLS OVER (
            ORDER BY block_time
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS price_then
    FROM timeline
),

per_transfer_wallet AS (
    SELECT
        wallet,
        SUM(CASE WHEN direction = 'in'  THEN tokens ELSE 0 END) AS tokens_in,
        SUM(CASE WHEN direction = 'in'
                 THEN COALESCE(usd_value, tokens * COALESCE(price_then, 0))
                 ELSE 0 END)                                    AS value_in,
        SUM(CASE WHEN direction = 'out' THEN tokens ELSE 0 END) AS tokens_out,
        COUNT(DISTINCT counterparty)                            AS transfer_peers
    FROM priced_transfers
    WHERE wallet IS NOT NULL
    GROUP BY 1
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
        MAX(block_time)                                            AS last_trade
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
    -- Custodial infrastructure is not a trader; see the Solana query for the
    -- measurement behind the threshold.
    WHERE COALESCE(t.transfer_peers, 0) <= 200
),

marked AS (
    SELECT
        j.*,
        j.acquired_cost / NULLIF(j.acquired_tokens, 0) AS avg_cost_price,
        COALESCE(
            (SELECT price FROM meta),
            (SELECT price FROM price_minute ORDER BY ts DESC LIMIT 1)
        ) AS market_price
    FROM joined j
),

enriched AS (
    SELECT
        m.*,
        mt.symbol AS token_symbol,
        mt.supply AS total_supply,
        GREATEST(m.acquired_tokens - m.tokens_sold - m.tokens_out, 0) AS net_position,
        m.usd_received / NULLIF(m.tokens_sold, 0)                     AS avg_sell_price,
        m.usd_received
          - (m.acquired_cost / NULLIF(m.acquired_tokens, 0))
            * LEAST(m.tokens_sold, m.acquired_tokens)                 AS realized_pnl_usd
    FROM marked m
    LEFT JOIN meta mt ON true
)

SELECT
    ROW_NUMBER() OVER (ORDER BY realized_pnl_usd DESC)    AS rank,
    wallet,
    last_taker                                            AS taker,
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
    native_spent,
    native_received,
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
    total_supply                                          AS circulating_supply
FROM enriched
ORDER BY realized_pnl_usd DESC
LIMIT {{wallet_limit}}
