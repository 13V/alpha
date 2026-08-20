-- ============================================================================
-- Alpha Wallets — Top holders of an EVM token, ranked by current balance.
-- ============================================================================
-- Cheap mode: touches only balances_<chain>.latest, which already carries a USD
-- value per position, so this costs a fraction of the PnL query.
--
-- Parameters:
--   blockchain     enum    base | bnb | ethereum | arbitrum | optimism | polygon
--   token_address  text    0x-prefixed contract address
--   wallet_limit   number  how many holders to return (100 / 250 / 500)
-- ============================================================================

WITH
token AS (
    SELECT from_hex(replace(lower('{{token_address}}'), '0x', '')) AS addr
),

balances AS (
    SELECT
        address        AS wallet,
        SUM(balance)     AS balance,
        SUM(balance_usd) AS balance_usd,
        MAX(token_symbol) AS token_symbol,
        MAX(updated_at)  AS last_activity
    FROM balances_{{blockchain}}.latest
    WHERE token_address = (SELECT addr FROM token)
      AND balance > 0
    GROUP BY 1
),

supply AS (
    SELECT SUM(balance) AS total_supply FROM balances
)

SELECT
    ROW_NUMBER() OVER (ORDER BY balance DESC)                      AS rank,
    wallet,
    balance                                                        AS tokens_held,
    balance_usd                                                    AS value_usd,
    balance / NULLIF((SELECT total_supply FROM supply), 0) * 100   AS pct_supply_held,
    token_symbol,
    last_activity,
    (SELECT total_supply FROM supply)                              AS circulating_supply
FROM balances
ORDER BY balance DESC
LIMIT {{wallet_limit}}
