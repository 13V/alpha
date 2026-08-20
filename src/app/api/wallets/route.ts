import { NextResponse } from "next/server";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import {
  CHAINS,
  detectChain,
  isAddressValidForChain,
  isChainId,
  normalizeAddress,
  type ChainId,
} from "@/lib/chains";
import { DuneClient, DuneError } from "@/lib/dune";
import { ConfigError, normalizeRow, planQuery, summaryFromRows } from "@/lib/queries";
import type { Mode, ScanResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface ScanRequest {
  token?: unknown;
  chain?: unknown;
  mode?: unknown;
  limit?: unknown;
  lookbackDays?: unknown;
  minUsd?: unknown;
  refresh?: unknown;
}

function fail(status: number, error: string, hint?: string) {
  return NextResponse.json({ error, ...(hint ? { hint } : {}) }, { status });
}

async function scan(input: ScanRequest) {
  const rawToken = typeof input.token === "string" ? input.token.trim() : "";
  if (!rawToken) {
    return fail(400, "No contract address given", "Paste the token's CA and try again.");
  }

  let chain: ChainId;
  if (input.chain === undefined || input.chain === null || input.chain === "auto") {
    const detected = detectChain(rawToken);
    if (!detected) {
      return fail(
        400,
        "That does not look like a contract address",
        "Expected a Solana mint (base58) or an EVM address (0x + 40 hex characters).",
      );
    }
    chain = detected;
  } else if (isChainId(input.chain)) {
    chain = input.chain;
  } else {
    return fail(400, `Unsupported chain: ${String(input.chain)}`);
  }

  if (!isAddressValidForChain(rawToken, chain)) {
    return fail(
      400,
      `That address is not valid on ${CHAINS[chain].label}`,
      CHAINS[chain].kind === "svm"
        ? "Solana mints are base58, 32–44 characters."
        : "EVM contracts are 0x followed by 40 hex characters.",
    );
  }

  const token = normalizeAddress(rawToken, chain);
  const mode: Mode = input.mode === "holders" ? "holders" : "traders";

  const maxLimit = envInt("MAX_WALLET_LIMIT", 500);
  const limit = clamp(Math.round(Number(input.limit) || 100), 1, maxLimit);
  const lookbackDays = clamp(
    Math.round(Number(input.lookbackDays) || envInt("DEFAULT_LOOKBACK_DAYS", 90)),
    1,
    1095,
  );
  const minUsd = Math.max(0, Number(input.minUsd ?? envInt("DEFAULT_MIN_USD", 50)));

  const key = cacheKey([chain, mode, token, limit, lookbackDays, minUsd]);
  const ttl = envInt("CACHE_TTL_SECONDS", 1800);

  if (input.refresh !== true) {
    const hit = cacheGet<ScanResponse>(key);
    if (hit) {
      return NextResponse.json({ ...hit, meta: { ...hit.meta, cached: true } });
    }
  }

  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) {
    return fail(
      500,
      "DUNE_API_KEY is not set",
      "Add your Dune Data API key to .env.local — https://dune.com/settings/api",
    );
  }

  let plan;
  try {
    plan = planQuery({ chain, mode, token, limit, lookbackDays, minUsd });
  } catch (error) {
    if (error instanceof ConfigError) return fail(500, error.message, error.hint);
    throw error;
  }

  const client = new DuneClient(apiKey);
  const performance = (process.env.DUNE_PERFORMANCE ?? "medium") as
    | "small"
    | "medium"
    | "large";

  try {
    const execution = await client.run<Record<string, unknown>>(
      plan.queryId,
      plan.parameters,
      { performance, limit },
    );

    const rawRows = execution.result?.rows ?? [];
    const summary = summaryFromRows(rawRows);

    const payload: ScanResponse = {
      meta: {
        token,
        chain,
        mode,
        limit,
        lookbackDays: mode === "traders" ? lookbackDays : null,
        minUsd: mode === "traders" ? minUsd : null,
        rowCount: rawRows.length,
        circulatingSupply: summary.circulatingSupply,
        currentMcap: summary.currentMcap,
        tokenSymbol: summary.tokenSymbol,
        executionId: execution.execution_id ?? null,
        executionMillis: execution.result?.metadata?.execution_time_millis ?? null,
        fetchedAt: new Date().toISOString(),
        cached: false,
      },
      rows: rawRows.map(normalizeRow),
    };

    cacheSet(key, payload, ttl);
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof DuneError) {
      return fail(error.status >= 400 && error.status < 600 ? error.status : 502, error.message, error.hint);
    }
    return fail(500, error instanceof Error ? error.message : "Unexpected error");
  }
}

export async function POST(request: Request) {
  let body: ScanRequest;
  try {
    body = (await request.json()) as ScanRequest;
  } catch {
    return fail(400, "Request body must be JSON");
  }
  return scan(body);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return scan({
    token: params.get("token") ?? params.get("ca") ?? undefined,
    chain: params.get("chain") ?? undefined,
    mode: params.get("mode") ?? undefined,
    limit: params.get("limit") ?? undefined,
    lookbackDays: params.get("lookbackDays") ?? undefined,
    minUsd: params.get("minUsd") ?? undefined,
    refresh: params.get("refresh") === "true",
  });
}
