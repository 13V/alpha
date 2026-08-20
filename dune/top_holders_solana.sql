-- ============================================================================
-- Alpha Wallets — Top holders of a Solana SPL token, ranked by current balance.
-- ============================================================================
-- Cheap mode: touches only the balances table, so it costs a fraction of the
-- PnL query and returns in seconds. Use top_traders_solana.sql when you want
-- profit ranking instead of bag size.
--
-- Parameters:
--   token_address  text    SPL mint address
--   wallet_limit   number  how many holders to return (100 / 250 / 500)
--
-- Balances are rolled up per OWNER, not per token account — one owner can hold
-- the same mint across several associated token accounts.
-- ============================================================================

WITH
balances AS (
    SELECT
        token_balance_owner AS wallet,
        SUM(token_balance)  AS balance,
        MAX(sol_balance)    AS sol_balance,
        MAX(block_time)     AS last_activity,
        COUNT(*)            AS token_accounts
    FROM solana_utils.latest_balances
    WHERE token_mint_address = '{{token_address}}'
      AND token_balance > 0
    GROUP BY 1
),

supply AS (
    SELECT SUM(balance) AS total_supply FROM balances
)

SELECT
    ROW_NUMBER() OVER (ORDER BY balance DESC)                      AS rank,
    wallet,
    balance                                                        AS tokens_held,
    balance / NULLIF((SELECT total_supply FROM supply), 0) * 100   AS pct_supply_held,
    sol_balance,
    token_accounts,
    last_activity,
    (SELECT total_supply FROM supply)                              AS circulating_supply
FROM balances
ORDER BY balance DESC
LIMIT {{wallet_limit}}
