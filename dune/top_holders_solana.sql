-- ============================================================================
-- Bagtrace — Top holders of a Solana SPL token, ranked by current balance.
-- ============================================================================
-- Source: solana_utils.latest_balances (the canonical per-account snapshot).
--
-- Parameters:
--   token_address  text    SPL mint address
--   wallet_limit   number  how many holders to return
--
-- Balances are rolled up per OWNER — one owner can hold the same mint across
-- several associated token accounts.
--
-- The table's sol_balance column is deliberately not surfaced: on an SPL row it
-- carries the token account's rent-exempt minimum (~0.002 SOL), not the owner's
-- wallet balance, so it reads as zero for everyone and means nothing.
--
-- Perf note: the table is filtered on token_mint_address, which the Dune docs
-- name as the indexed access path. Circulating supply comes from a window over
-- the same scan rather than a second aggregate, so the table is read once.
-- ============================================================================

WITH
balances AS (
    SELECT
        token_balance_owner AS wallet,
        SUM(token_balance)  AS balance,
        MAX(block_time)     AS last_activity,
        COUNT(*)            AS token_accounts
    FROM solana_utils.latest_balances
    WHERE token_mint_address = '{{token_address}}'
      AND token_balance > 0
    GROUP BY 1
),

ranked AS (
    SELECT
        wallet,
        balance,
        last_activity,
        token_accounts,
        SUM(balance) OVER ()                      AS circulating_supply,
        COUNT(*)     OVER ()                      AS holder_count,
        ROW_NUMBER() OVER (ORDER BY balance DESC) AS rank
    FROM balances
)

SELECT
    rank,
    wallet,
    balance                                             AS tokens_held,
    balance / NULLIF(circulating_supply, 0) * 100       AS pct_supply_held,
    token_accounts,
    last_activity,
    circulating_supply,
    holder_count
FROM ranked
WHERE rank <= {{wallet_limit}}
ORDER BY rank
