-- ============================================================================
-- Bagtrace — Top traders of a Solana SPL token, ranked by realized PnL.
-- ============================================================================
-- Source: dex_solana.trades (every decoded Solana DEX/AMM swap)
--         solana_utils.latest_balances (one aggregate, for circulating supply)
--
-- Parameters:
--   token_address  text    SPL mint address
--   wallet_limit   number  how many wallets to return
--   lookback_days  number  only scan trades from the last N days (cost control)
--   min_usd        number  drop wallets whose total traded volume is below this
--
-- Accounting: weighted-average cost basis.
--   avg_buy_price  = USD spent / tokens bought
--   realized_pnl   = USD received - avg_buy_price * tokens sold (capped at bought)
--   net_position   = tokens bought - tokens sold, i.e. the bag built on DEXes
--   unrealized_pnl = net_position * (last traded price - avg_buy_price)
--
-- Perf note: the trade table is read exactly once. The market price comes from
-- a window over the per-wallet aggregate rather than a second pass over fills,
-- and supply is a single aggregate cross-joined in.
-- ============================================================================

WITH
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
        END                                                         AS sol_amount,
        CASE
            WHEN COALESCE(amount_usd, 0) > 0 AND token_bought_amount > 0
            THEN amount_usd / token_bought_amount
        END                                                         AS fill_price
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
        END,
        CASE
            WHEN COALESCE(amount_usd, 0) > 0 AND token_sold_amount > 0
            THEN amount_usd / token_sold_amount
        END
    FROM dex_solana.trades
    WHERE token_sold_mint_address = '{{token_address}}'
      AND block_month >= CAST(date_trunc('month', date_add('day', -{{lookback_days}}, now())) AS date)
      AND block_time  >= date_add('day', -{{lookback_days}}, now())
      AND token_sold_amount > 0
),

-- Token name/symbol. address_prefix is the lowercased first character of the
-- mint and is the table's partition key, so this lookup is nearly free.
token_meta AS (
    SELECT symbol, name
    FROM tokens_solana.fungible
    WHERE token_mint_address = '{{token_address}}'
      AND address_prefix = lower(substr('{{token_address}}', 1, 1))
    LIMIT 1
),

supply AS (
    SELECT SUM(token_balance) AS total_supply
    FROM solana_utils.latest_balances
    WHERE token_mint_address = '{{token_address}}'
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
        MAX(block_time)                                           AS last_trade,
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
        -- most recent priced fill anywhere in the result = the mark price
        FIRST_VALUE(w.wallet_last_price) OVER (
            ORDER BY w.wallet_priced_at DESC NULLS LAST
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS market_price
    FROM per_wallet w
),

enriched AS (
    SELECT
        m.wallet,
        m.tokens_bought,
        m.tokens_sold,
        m.usd_spent,
        m.usd_received,
        m.sol_spent,
        m.sol_received,
        m.buy_count,
        m.sell_count,
        m.first_trade,
        m.last_trade,
        m.market_price,
        s.total_supply,
        tm.symbol                                                     AS token_symbol,
        tm.name                                                       AS token_name,
        GREATEST(m.tokens_bought - m.tokens_sold, 0)                  AS net_position,
        m.usd_spent    / NULLIF(m.tokens_bought, 0)                   AS avg_buy_price,
        m.usd_received / NULLIF(m.tokens_sold,   0)                   AS avg_sell_price,
        -- Profit on the MATCHED portion only: the tokens whose buy price we
        -- actually observed. Counting every dollar of proceeds while only
        -- subtracting the cost of tokens bought in-window treats pre-window
        -- tokens as free, and reports gains for wallets that sold below their
        -- own entry. Measured across one token's top 100: $407,503 claimed
        -- versus $63,039 real, with 34 wallets showing a profit on a sub-1x
        -- multiple. This way the sign of PnL always agrees with the multiple.
        (  (m.usd_received / NULLIF(m.tokens_sold,   0))
         - (m.usd_spent    / NULLIF(m.tokens_bought, 0)) )
          * LEAST(m.tokens_sold, m.tokens_bought)                     AS realized_pnl_usd,
        GREATEST(m.tokens_bought - m.tokens_sold, 0)
          * (m.market_price
             - COALESCE(m.usd_spent / NULLIF(m.tokens_bought, 0), 0)) AS unrealized_pnl_usd
    FROM marked m
    CROSS JOIN supply s
    LEFT JOIN token_meta tm ON true
)

SELECT
    ROW_NUMBER() OVER (ORDER BY realized_pnl_usd DESC)    AS rank,
    wallet,
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
    sol_spent,
    sol_received,
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
