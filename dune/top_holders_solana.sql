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
-- Token name/symbol. address_prefix is the lowercased first character of the
-- mint and is the table's partition key, so this lookup is nearly free.
token_meta AS (
    SELECT symbol, name
    FROM tokens_solana.fungible
    WHERE token_mint_address = '{{token_address}}'
      AND address_prefix = lower(substr('{{token_address}}', 1, 1))
    LIMIT 1
),

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
    r.rank,
    r.wallet,
    r.balance                                             AS tokens_held,
    r.balance / NULLIF(r.circulating_supply, 0) * 100     AS pct_supply_held,
    r.token_accounts,
    r.last_activity,
    r.circulating_supply,
    r.holder_count,
    tm.symbol                                             AS token_symbol,
    tm.name                                               AS token_name
FROM ranked r
LEFT JOIN token_meta tm ON true
WHERE r.rank <= {{wallet_limit}}
ORDER BY r.rank
