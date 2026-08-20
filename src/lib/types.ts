import type { ChainId } from "./chains";

export type Mode = "traders" | "holders";

export interface WalletRow {
  rank: number;
  wallet: string;
  taker?: string | null;

  // PnL (traders mode)
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  profitMultiple: number | null;
  realizedRoi: number | null;

  // Prices and market caps
  avgBuyPrice: number | null;
  avgSellPrice: number | null;
  avgBuyMcap: number | null;
  avgSellMcap: number | null;
  currentMcap: number | null;

  // Flow
  usdSpent: number | null;
  usdReceived: number | null;
  nativeSpent: number | null;
  nativeReceived: number | null;
  tokensBought: number | null;
  tokensSold: number | null;

  // Position
  tokensHeld: number | null;
  pctSupplyHeld: number | null;
  valueUsd: number | null;
  positionStatus: string | null;
  costBasis: string | null;

  // Activity
  buyCount: number | null;
  sellCount: number | null;
  firstTrade: string | null;
  lastTrade: string | null;
  holdHours: number | null;
}

export interface ScanMeta {
  token: string;
  chain: ChainId;
  mode: Mode;
  limit: number;
  lookbackDays: number | null;
  minUsd: number | null;
  rowCount: number;
  holderCount: number | null;
  circulatingSupply: number | null;
  currentMcap: number | null;
  tokenSymbol: string | null;
  executionId: string | null;
  executionMillis: number | null;
  fetchedAt: string;
  cached: boolean;
}

export interface ScanResponse {
  meta: ScanMeta;
  rows: WalletRow[];
}

export interface ScanError {
  error: string;
  hint?: string;
}
