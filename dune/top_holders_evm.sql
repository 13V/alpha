-- ============================================================================
-- Who Printed — Top holders of an EVM token, ranked by current balance.
-- ============================================================================
-- Balances are reconstructed as net transfer flow from tokens.transfers.
--
-- Dune's curated per-wallet balance tables (tokens_<chain>.balances,
-- balances_<chain>.latest) are gated behind a higher plan tier and fail with
-- "does not exist or it is private" on standard keys, so this derives the same
-- number from the transfer log, which every plan can read.
--
-- Supply, symbol and price come from tokens.fdv_latest — a tiny latest-state
-- table, so it costs almost nothing and gives an authoritative supply rather
-- than one inferred by summing holders.
--
-- Parameters:
--   blockchain     enum    base | bnb | ethereum | arbitrum | optimism | polygon
--   token_address  text    0x-prefixed contract address
--   wallet_limit   number  how many holders to return
-- ============================================================================

WITH
token AS (
    SELECT from_hex(replace(lower('{{token_address}}'), '0x', '')) AS addr
),

meta AS (
    SELECT symbol, supply, price
    FROM tokens.fdv_latest
    WHERE blockchain = '{{blockchain}}'
      AND token_address = (SELECT addr FROM token)
    LIMIT 1
),

-- One pass over the transfer log, fanned out into a credit and a debit leg.
flows AS (
    SELECT
        f.wallet,
        f.delta,
        t.block_time
    FROM tokens.transfers t
    CROSS JOIN UNNEST(ARRAY[
        ROW(t."to",    t.amount),
        ROW(t."from", -t.amount)
    ]) AS f(wallet, delta)
    WHERE t.blockchain = '{{blockchain}}'
      AND t.contract_address = (SELECT addr FROM token)
),

balances AS (
    SELECT
        wallet,
        SUM(delta)      AS balance,
        MAX(block_time) AS last_activity
    FROM flows
    WHERE wallet IS NOT NULL
      AND wallet <> 0x0000000000000000000000000000000000000000
      AND wallet <> 0x000000000000000000000000000000000000dead
    GROUP BY 1
    HAVING SUM(delta) > 0
),

ranked AS (
    SELECT
        wallet,
        balance,
        last_activity,
        SUM(balance) OVER ()                      AS holder_supply,
        COUNT(*)     OVER ()                      AS holder_count,
        ROW_NUMBER() OVER (ORDER BY balance DESC) AS rank
    FROM balances
)

SELECT
    r.rank,
    r.wallet,
    r.balance                                                        AS tokens_held,
    r.balance * m.price                                              AS value_usd,
    r.balance / NULLIF(COALESCE(m.supply, r.holder_supply), 0) * 100 AS pct_supply_held,
    m.symbol                                                         AS token_symbol,
    r.last_activity,
    COALESCE(m.supply, r.holder_supply)                              AS circulating_supply,
    r.holder_count
FROM ranked r
LEFT JOIN meta m ON true
WHERE r.rank <= {{wallet_limit}}
ORDER BY r.rank
