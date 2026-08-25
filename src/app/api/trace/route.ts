import { NextResponse } from "next/server";

import { cacheGet, cacheKey, cacheSet } from "@/lib/cache";
import { DuneClient, DuneError } from "@/lib/dune";
import { normalizeRow, summaryFromRows } from "@/lib/queries";
import { envInt, isScanFailure, resolveScan, type ScanRequest } from "@/lib/scan";
import type { ScanResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Each call is one short Dune API round trip, never a wait for the query to
 * finish. That matters on Vercel: a cold Solana scan runs several minutes,
 * well past the 300s Hobby ceiling, so the work is split across polls instead
 * of held open in a single invocation.
 */
export const maxDuration = 60;

/** Dune execution ids are ULID-like tokens; anything else never reaches the API. */
const EXECUTION_ID = /^[A-Za-z0-9-]{10,64}$/;

/**
 * Which cache key each execution we started belongs to. The poll leg may only
 * populate the shared cache for an execution this process started for exactly
 * those parameters — otherwise a caller could start a run for token A and poll
 * it under token B's parameters, poisoning B's cache for everyone. Process-
 * local like the cache itself; on a different instance the entry is absent and
 * the poll still serves its caller, it just cannot write the shared cache.
 */
const issuedFor = new Map<string, string>();
const ISSUED_MAX = 500;

function recordIssued(executionId: string, key: string): void {
  if (issuedFor.size >= ISSUED_MAX) {
    const oldest = issuedFor.keys().next();
    if (!oldest.done) issuedFor.delete(oldest.value);
  }
  issuedFor.set(executionId, key);
}

type Payload =
  | ({ status: "done" } & ScanResponse)
  | { status: "running"; executionId: string; state?: string };

function fail(status: number, error: string, hint?: string) {
  return NextResponse.json({ error, ...(hint ? { hint } : {}) }, { status });
}

/** Minutes since an ISO timestamp, or null if it is missing or unparseable. */
function minutesSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 60_000));
}

interface StoredResult {
  rows: Array<Record<string, unknown>>;
  executionId: string | null;
  executionMillis: number | null;
  ageMinutes: number | null;
}

/**
 * Rows Dune already holds for this query and these parameters, if they are
 * recent enough to stand in for a fresh run.
 *
 * Returns null for every unhappy path — nothing stored, stored but stale,
 * stored but empty, or the lookup itself failing. The caller then executes, so
 * the worst case of this whole path is one wasted round trip. It never
 * surfaces an error: not finding a cached result is not a failure to report.
 */
async function reuseStored(
  client: DuneClient,
  plan: { queryId: number; parameters: Record<string, string | number> },
  limit: number,
): Promise<StoredResult | null> {
  const maxAgeMinutes = envInt("DUNE_RESULT_MAX_AGE_MINUTES", 180);
  if (maxAgeMinutes <= 0) return null;

  try {
    const stored = await client.latestResults<Record<string, unknown>>(
      plan.queryId,
      plan.parameters,
      { limit },
    );
    const rows = stored.result?.rows ?? [];
    if (rows.length === 0) return null;

    // An age we cannot read is an age we cannot vouch for.
    const ageMinutes = minutesSince(stored.execution_ended_at);
    if (ageMinutes == null || ageMinutes > maxAgeMinutes) return null;

    return {
      rows,
      executionId: stored.execution_id ?? null,
      executionMillis: stored.result?.metadata?.execution_time_millis ?? null,
      ageMinutes,
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let input: ScanRequest;
  try {
    input = (await request.json()) as ScanRequest;
  } catch {
    return fail(400, "Request body must be JSON");
  }

  const resolved = resolveScan(input);
  if (isScanFailure(resolved)) return fail(resolved.status, resolved.error, resolved.hint);

  const { chain, mode, token, limit, lookbackDays, minUsd, apiKey, plan } = resolved;

  // Keyed on query parameters only — never the API key, which must not
  // influence or leak across cached results.
  const key = cacheKey([chain, mode, token, limit, lookbackDays, minUsd]);
  const ttl = envInt("CACHE_TTL_SECONDS", 1800);

  const client = new DuneClient(apiKey);
  const executionId = typeof input.executionId === "string" ? input.executionId.trim() : "";
  if (executionId && !EXECUTION_ID.test(executionId)) {
    return fail(400, "Malformed execution id");
  }

  /** Shape a finished Dune execution into the response the client renders. */
  function payloadFrom(
    rawRows: Array<Record<string, unknown>>,
    extra: {
      executionId: string | null;
      executionMillis: number | null;
      resultAgeMinutes: number | null;
      cached: boolean;
    },
  ): ScanResponse {
    const summary = summaryFromRows(rawRows);
    return {
      meta: {
        token,
        chain,
        mode,
        limit,
        lookbackDays: mode === "traders" ? lookbackDays : null,
        minUsd: mode === "traders" ? minUsd : null,
        rowCount: rawRows.length,
        holderCount: summary.holderCount,
        circulatingSupply: summary.circulatingSupply,
        currentMcap: summary.currentMcap,
        tokenSymbol: summary.tokenSymbol,
        fetchedAt: new Date().toISOString(),
        ...extra,
      },
      rows: rawRows.map(normalizeRow),
    };
  }

  try {
    // ---- start leg -------------------------------------------------------
    if (!executionId) {
      if (input.refresh !== true) {
        const hit = cacheGet<ScanResponse>(key);
        if (hit) {
          return NextResponse.json({
            status: "done",
            ...hit,
            meta: { ...hit.meta, cached: true },
          } satisfies Payload);
        }

        // Nothing local, so ask Dune whether it still holds rows from the last
        // run of this query with these exact parameters. That lookup starts no
        // execution and costs no execution credits, and our queries are public,
        // so a token anyone has already traced comes back in one round trip
        // instead of the minutes a cold Solana scan takes. A 404 — nobody has
        // run it, or the SQL changed since — just falls through to executing.
        const reused = await reuseStored(client, plan, limit);
        if (reused) {
          const payload = payloadFrom(reused.rows, {
            executionId: reused.executionId,
            executionMillis: reused.executionMillis,
            resultAgeMinutes: reused.ageMinutes,
            cached: true,
          });
          cacheSet(key, payload, ttl);
          return NextResponse.json({ status: "done", ...payload } satisfies Payload);
        }
      }

      const performance = (process.env.DUNE_PERFORMANCE ?? "large") as
        | "small"
        | "medium"
        | "large";
      const started = await client.execute(plan.queryId, plan.parameters, performance);
      recordIssued(started.execution_id, key);
      return NextResponse.json({
        status: "running",
        executionId: started.execution_id,
        state: started.state,
      } satisfies Payload);
    }

    // ---- poll leg --------------------------------------------------------
    const status = await client.status(executionId);

    if (status.query_id != null && status.query_id !== plan.queryId) {
      return fail(400, "That execution does not belong to this query");
    }

    if (status.state === "QUERY_STATE_COMPLETED") {
      const execution = await client.results<Record<string, unknown>>(executionId, { limit });
      const rawRows = execution.result?.rows ?? [];

      // Only an execution this process started for these exact parameters may
      // write the shared cache; see issuedFor above.
      const cacheable = issuedFor.get(executionId) === key;

      const payload = payloadFrom(rawRows, {
        executionId,
        executionMillis: execution.result?.metadata?.execution_time_millis ?? null,
        resultAgeMinutes: null,
        cached: false,
      });

      if (cacheable) {
        cacheSet(key, payload, ttl);
        issuedFor.delete(executionId);
      }
      return NextResponse.json({ status: "done", ...payload } satisfies Payload);
    }

    if (
      status.state === "QUERY_STATE_FAILED" ||
      status.state === "QUERY_STATE_CANCELLED" ||
      status.state === "QUERY_STATE_EXPIRED"
    ) {
      return fail(
        502,
        status.error?.message ?? `Dune execution ended as ${status.state}`,
        status.state === "QUERY_STATE_FAILED"
          ? "The SQL itself failed — open the query on dune.com to see the error."
          : undefined,
      );
    }

    return NextResponse.json({
      status: "running",
      executionId,
      state: status.state,
    } satisfies Payload);
  } catch (error) {
    if (error instanceof DuneError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return fail(status, error.message, error.hint);
    }
    return fail(500, error instanceof Error ? error.message : "Unexpected error");
  }
}
