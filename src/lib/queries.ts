import { CHAINS, type ChainId } from "./chains";
import type { QueryParameters } from "./dune";
import type { Mode, WalletRow } from "./types";

export interface QueryPlan {
  queryId: number;
  parameters: QueryParameters;
  envVar: string;
}

const ENV_VARS: Record<Mode, Record<"svm" | "evm", string>> = {
  traders: { svm: "DUNE_QUERY_TRADERS_SOLANA", evm: "DUNE_QUERY_TRADERS_EVM" },
  holders: { svm: "DUNE_QUERY_HOLDERS_SOLANA", evm: "DUNE_QUERY_HOLDERS_EVM" },
};

/**
 * These queries are public on Dune, so any API key can execute them — that is
 * what lets a visitor paste their own key and get results without creating
 * anything in their own account. Override via the DUNE_QUERY_* env vars to
 * point at your own copies (`npm run setup:dune` creates and prints them).
 */
const DEFAULT_QUERY_IDS: Record<Mode, Record<"svm" | "evm", number>> = {
  traders: { svm: 8385958, evm: 8385959 },
  holders: { svm: 8385960, evm: 8385961 },
};

export class ConfigError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "ConfigError";
    this.hint = hint;
  }
}

export function planQuery(args: {
  chain: ChainId;
  mode: Mode;
  token: string;
  limit: number;
  lookbackDays: number;
  minUsd: number;
}): QueryPlan {
  const chain = CHAINS[args.chain];
  const envVar = ENV_VARS[args.mode][chain.kind];
  const raw = process.env[envVar];

  const queryId = raw ? Number(raw) : DEFAULT_QUERY_IDS[args.mode][chain.kind];
  if (!Number.isInteger(queryId) || queryId <= 0) {
    throw new ConfigError(
      `${envVar} is not a valid query id: ${raw}`,
      "It should be the number from the query's dune.com URL.",
    );
  }

  const parameters: QueryParameters = {
    token_address: args.token,
    wallet_limit: args.limit,
  };

  if (chain.kind === "evm") {
    parameters.blockchain = chain.duneName;
  }

  if (args.mode === "traders") {
    parameters.lookback_days = args.lookbackDays;
    parameters.min_usd = args.minUsd;
  }

  return { queryId, parameters, envVar };
}

/** Dune hands decimals back as strings; coerce anything numeric-looking. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * The columns a result read asks for by default.
 *
 * Dune charges a read in datapoints -- rows times columns -- so every column
 * that reaches the browser without being looked at is paid for. This is what
 * the table renders, what the header needs, and what the wallet exports use.
 * It is deliberately not the full row: the twenty-odd columns left out are the
 * ones only the CSV and JSON exports touch, and those pull the full row on
 * demand (see the `full` flag on the trace route) rather than every trace
 * paying for them.
 *
 * A column named here that the query does not have is ignored by Dune, so the
 * two traders queries and the two holders queries can share one list each.
 */
export const DISPLAY_COLUMNS: Record<Mode, readonly string[]> = {
  traders: [
    "rank",
    "wallet",
    "realized_pnl_usd",
    "profit_multiple",
    "realized_roi",
    "avg_buy_mcap",
    "avg_sell_mcap",
    "usd_spent",
    "usd_received",
    "buy_coverage",
    "first_trade",
    "last_trade",
    // constant per token, but the header reads them off the first row
    "token_symbol",
    "current_mcap",
    "circulating_supply",
  ],
  holders: [
    "rank",
    "wallet",
    "tokens_held",
    "pct_supply_held",
    "value_usd",
    "first_trade",
    "last_activity",
    "token_symbol",
    "current_mcap",
    "circulating_supply",
    "holder_count",
  ],
};

export function normalizeRow(row: Record<string, unknown>, index: number): WalletRow {
  return {
    rank: num(row.rank) ?? index + 1,
    wallet: String(row.wallet ?? ""),
    taker: str(row.taker),

    realizedPnlUsd: num(row.realized_pnl_usd),
    unrealizedPnlUsd: num(row.unrealized_pnl_usd),
    totalPnlUsd: num(row.total_pnl_usd),
    profitMultiple: num(row.profit_multiple),
    realizedRoi: num(row.realized_roi),

    avgBuyPrice: num(row.avg_buy_price),
    avgSellPrice: num(row.avg_sell_price),
    avgBuyMcap: num(row.avg_buy_mcap),
    avgSellMcap: num(row.avg_sell_mcap),
    currentMcap: num(row.current_mcap),

    usdSpent: num(row.usd_spent),
    usdReceived: num(row.usd_received),
    nativeSpent: num(row.sol_spent ?? row.native_spent),
    nativeReceived: num(row.sol_received ?? row.native_received),
    tokensBought: num(row.tokens_bought),
    tokensSold: num(row.tokens_sold),

    tokensHeld: num(row.tokens_held),
    pctSupplyHeld: num(row.pct_supply_held),
    valueUsd: num(row.value_usd),
    positionStatus: str(row.position_status),
    costBasis: str(row.cost_basis),
    buyCoverage: num(row.buy_coverage),
    tokensReceived: num(row.tokens_received),
    receivedValueUsd: num(row.received_value_usd),
    transferPeers: num(row.transfer_peers),

    buyCount: num(row.buy_count),
    sellCount: num(row.sell_count),
    firstTrade: str(row.first_trade),
    lastTrade: str(row.last_trade ?? row.last_activity),
    holdHours: num(row.hold_hours),
  };
}

export function summaryFromRows(rows: Record<string, unknown>[]): {
  circulatingSupply: number | null;
  currentMcap: number | null;
  tokenSymbol: string | null;
  holderCount: number | null;
} {
  const first = rows[0] ?? {};
  return {
    circulatingSupply: num(first.circulating_supply),
    currentMcap: num(first.current_mcap),
    tokenSymbol: str(first.token_symbol),
    holderCount: num(first.holder_count),
  };
}
