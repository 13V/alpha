import {
  CHAINS,
  detectChain,
  isAddressValidForChain,
  isChainId,
  normalizeAddress,
  type ChainId,
} from "./chains";
import { planQuery, type QueryPlan } from "./queries";
import type { Mode } from "./types";

export interface ScanRequest {
  apiKey?: unknown;
  token?: unknown;
  chain?: unknown;
  mode?: unknown;
  limit?: unknown;
  lookbackDays?: unknown;
  /** Ask for every column, not just the ones the screen uses. Costs more datapoints. */
  full?: unknown;
  minUsd?: unknown;
  executionId?: unknown;
  refresh?: unknown;
}

export interface ResolvedScan {
  chain: ChainId;
  mode: Mode;
  token: string;
  limit: number;
  lookbackDays: number;
  minUsd: number;
  apiKey: string;
  plan: QueryPlan;
}

export interface ScanFailure {
  status: number;
  error: string;
  hint?: string;
}

export function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFailure(value: unknown): value is ScanFailure {
  return typeof value === "object" && value !== null && "error" in value;
}

export function isScanFailure(value: ResolvedScan | ScanFailure): value is ScanFailure {
  return isFailure(value);
}

/**
 * Validate a request and work out which Dune query to run. Shared by both the
 * start and the poll leg so the two can never disagree about parameters.
 */
export function resolveScan(input: ScanRequest): ResolvedScan | ScanFailure {
  const rawToken = typeof input.token === "string" ? input.token.trim() : "";
  if (!rawToken) {
    return { status: 400, error: "No contract address", hint: "Paste the token's CA." };
  }

  let chain: ChainId;
  if (input.chain === undefined || input.chain === null || input.chain === "auto") {
    const detected = detectChain(rawToken);
    if (!detected) {
      return {
        status: 400,
        error: "That does not look like a contract address",
        hint: "Expected a Solana mint (base58) or an EVM address (0x + 40 hex characters).",
      };
    }
    chain = detected;
  } else if (isChainId(input.chain)) {
    chain = input.chain;
  } else {
    return { status: 400, error: `Unsupported chain: ${String(input.chain)}` };
  }

  if (!isAddressValidForChain(rawToken, chain)) {
    return {
      status: 400,
      error: `That address is not valid on ${CHAINS[chain].label}`,
      hint:
        CHAINS[chain].kind === "svm"
          ? "Solana mints are base58, 32–44 characters."
          : "EVM contracts are 0x followed by 40 hex characters.",
    };
  }

  // The visitor's own key. Used for this request only — never logged or stored.
  const supplied = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = supplied || process.env.DUNE_API_KEY || "";
  if (!apiKey) {
    return {
      status: 401,
      error: "No Dune API key",
      hint: "Paste a Dune API key to run a trace — get one free at dune.com/settings/api",
    };
  }

  const token = normalizeAddress(rawToken, chain);
  const mode: Mode = input.mode === "holders" ? "holders" : "traders";
  const limit = clamp(Math.round(Number(input.limit) || 100), 1, envInt("MAX_WALLET_LIMIT", 500));
  const lookbackDays = clamp(
    Math.round(Number(input.lookbackDays) || envInt("DEFAULT_LOOKBACK_DAYS", 365)),
    1,
    1095,
  );
  // NaN would ride into the cache key and serialize as null in the Dune
  // payload; an empty string would silently drop the default floor.
  const rawMinUsd = Number(
    (input.minUsd === "" ? undefined : input.minUsd) ?? envInt("DEFAULT_MIN_USD", 50),
  );
  const minUsd = Number.isFinite(rawMinUsd)
    ? Math.max(0, rawMinUsd)
    : envInt("DEFAULT_MIN_USD", 50);

  try {
    const plan = planQuery({ chain, mode, token, limit, lookbackDays, minUsd });
    return { chain, mode, token, limit, lookbackDays, minUsd, apiKey, plan };
  } catch (error) {
    return {
      status: 500,
      error: error instanceof Error ? error.message : "Could not resolve the query",
      hint: (error as { hint?: string }).hint,
    };
  }
}
