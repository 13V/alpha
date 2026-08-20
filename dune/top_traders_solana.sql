-- ============================================================================
-- Alpha Wallets — Top traders for a Solana SPL token, ranked by realized PnL.
-- ============================================================================
-- Data source : dex_solana.trades (all Solana DEX/AMM swaps, decimal-adjusted)
--               solana_utils.latest_balances (current balances, for holdings)
--
-- Parameters (create these on the query in Dune):
--   token_address  text    SPL mint address of the token
--   wallet_limit   number  how many wallets to return (100 / 250 / 500)
--   lookback_days  number  only look at trades from the last N days (cost control)
--   min_usd        number  ignore wallets whose total traded volume is below this
--
-- Accounting model: weighted-average cost basis.
--   avg_buy_price  = total USD spent / total tokens bought
--   realized_pnl   = USD received from sells - (avg_buy_price * tokens sold)
--   unrealized_pnl = tokens still held * (last traded price - avg_buy_price)
-- ============================================================================

WITH
-- Both sides of every swap that touches the token, normalised to one row per fill.
fills AS (
    SELECT
        trader_id                                                   AS wallet,
        block_time,
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

-- Most recent traded price, used to mark remaining bags to market.
last_price AS (
    SELECT usd_amount / token_amount AS price
    FROM fills
    WHERE usd_amount > 0 AND token_amount > 0
    ORDER BY block_time DESC
    LIMIT 1
),

-- Circulating supply = sum of every live balance. Used to turn price into mcap.
supply AS (
    SELECT SUM(token_balance) AS total_supply
    FROM solana_utils.latest_balances
    WHERE token_mint_address = '{{token_address}}'
),

-- Current bag per owner (a wallet can hold the mint across several token accounts).
holdings AS (
    SELECT token_balance_owner AS wallet, SUM(token_balance) AS balance
    FROM solana_utils.latest_balances
    WHERE token_mint_address = '{{token_address}}'
      AND token_balance > 0
    GROUP BY 1
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
),

enriched AS (
    SELECT
        w.wallet,
        w.tokens_bought,
        w.tokens_sold,
        w.usd_spent,
        w.usd_received,
        w.sol_spent,
        w.sol_received,
        w.buy_count,
        w.sell_count,
        w.first_trade,
        w.last_trade,
        COALESCE(h.balance, 0)                                        AS tokens_held,
        w.usd_spent    / NULLIF(w.tokens_bought, 0)                   AS avg_buy_price,
        w.usd_received / NULLIF(w.tokens_sold,   0)                   AS avg_sell_price,
        -- realized: only the part of the position that was actually sold
        w.usd_received
          - (w.usd_spent / NULLIF(w.tokens_bought, 0))
            * LEAST(w.tokens_sold, w.tokens_bought)                   AS realized_pnl_usd,
        -- unrealized: bag still on the table, marked at the last traded price
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
    realized_pnl_usd,
    unrealized_pnl_usd,
    realized_pnl_usd + unrealized_pnl_usd                       AS total_pnl_usd,
    -- "avg profit multiple": what each dollar of cost basis came back as
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
    sol_spent,
    sol_received,
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
