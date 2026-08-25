/**
 * Minimal client for the Dune Data API.
 *
 *   POST /api/v1/query/{id}/execute      -> kick off a run
 *   GET  /api/v1/execution/{id}/status   -> poll it
 *   GET  /api/v1/execution/{id}/results  -> read the rows
 *   POST /api/v1/query                   -> create a query (Analyst plan+)
 *
 * Docs: https://docs.dune.com/api-reference/api-overview
 */

/** Overridable only so the stub in scripts/stub-dune.mjs can stand in for Dune in tests. */
const DUNE_API = process.env.DUNE_API_BASE ?? "https://api.dune.com/api/v1";

export type QueryParameters = Record<string, string | number>;

export type ExecutionState =
  | "QUERY_STATE_PENDING"
  | "QUERY_STATE_EXECUTING"
  | "QUERY_STATE_COMPLETED"
  | "QUERY_STATE_FAILED"
  | "QUERY_STATE_CANCELLED"
  | "QUERY_STATE_EXPIRED";

export interface ExecutionStatus {
  execution_id: string;
  query_id: number;
  state: ExecutionState;
  is_execution_finished?: boolean;
  submitted_at?: string;
  execution_started_at?: string;
  execution_ended_at?: string;
  error?: { type?: string; message?: string };
}

export interface ResultMetadata {
  column_names: string[];
  column_types?: string[];
  row_count: number;
  total_row_count?: number;
  execution_time_millis?: number;
  datapoint_count?: number;
}

export interface ExecutionResults<Row = Record<string, unknown>> extends ExecutionStatus {
  result?: { rows: Row[]; metadata: ResultMetadata };
  next_offset?: number;
}

export class DuneError extends Error {
  readonly status: number;
  readonly hint?: string;

  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.name = "DuneError";
    this.status = status;
    this.hint = hint;
  }
}

const FINISHED: ExecutionState[] = [
  "QUERY_STATE_COMPLETED",
  "QUERY_STATE_FAILED",
  "QUERY_STATE_CANCELLED",
  "QUERY_STATE_EXPIRED",
];

function hintFor(status: number): string | undefined {
  if (status === 401 || status === 403)
    return "Dune rejected that key. Copy it again from dune.com/settings/api — it needs Read scope.";
  if (status === 402)
    return "That Dune account is out of credits for this billing period.";
  if (status === 404)
    return "Query not found. It may have been made private; set DUNE_QUERY_* to your own copies.";
  if (status === 429) return "Rate limited by Dune — back off and retry.";
  return undefined;
}

export class DuneClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) throw new DuneError("Missing Dune API key", 401, hintFor(401));
    this.apiKey = apiKey;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${DUNE_API}${path}`, {
      ...init,
      headers: {
        "X-Dune-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text };
    }

    if (!res.ok) {
      const message =
        (body as { error?: string; message?: string })?.error ??
        (body as { message?: string })?.message ??
        `Dune request failed (${res.status})`;
      throw new DuneError(message, res.status, hintFor(res.status));
    }

    return body as T;
  }

  execute(
    queryId: number,
    queryParameters: QueryParameters = {},
    performance: "small" | "medium" | "large" = "medium",
  ): Promise<{ execution_id: string; state: ExecutionState }> {
    return this.request(`/query/${queryId}/execute`, {
      method: "POST",
      body: JSON.stringify({ query_parameters: queryParameters, performance }),
    });
  }

  status(executionId: string): Promise<ExecutionStatus> {
    return this.request(`/execution/${executionId}/status`);
  }

  /**
   * `columns` is a cost control, not a convenience. Dune charges a result read
   * in datapoints -- rows times columns -- so asking for the fifteen columns a
   * screen uses instead of all thirty-five is a direct cut to the bill. It
   * changes nothing about the execution, which has already happened and been
   * charged; only what gets sent back.
   */
  results<Row = Record<string, unknown>>(
    executionId: string,
    opts: { limit?: number; offset?: number; columns?: readonly string[] } = {},
  ): Promise<ExecutionResults<Row>> {
    const search = new URLSearchParams();
    if (opts.limit != null) search.set("limit", String(opts.limit));
    if (opts.offset != null) search.set("offset", String(opts.offset));
    if (opts.columns?.length) search.set("columns", opts.columns.join(","));
    const qs = search.toString();
    return this.request(`/execution/${executionId}/results${qs ? `?${qs}` : ""}`);
  }

  /**
   * Rows from the most recent execution that ran with these parameter values.
   *
   * This never starts a run — it either hands back a stored result or 404s.
   * Dune matches on the parameters given and on the query's current SQL, so
   * editing the query invalidates every stored result for it. Our queries are
   * public, so a token someone else has already traced is already paid for.
   *
   * https://docs.dune.com/api-reference/executions/endpoint/get-query-result
   */
  latestResults<Row = Record<string, unknown>>(
    queryId: number,
    parameters: QueryParameters = {},
    opts: { limit?: number; columns?: readonly string[] } = {},
  ): Promise<ExecutionResults<Row>> {
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    if (opts.columns?.length) qs.set("columns", opts.columns.join(","));
    for (const [name, value] of Object.entries(parameters)) {
      qs.set(`params.${name}`, String(value));
    }
    const suffix = qs.toString();
    return this.request(`/query/${queryId}/results${suffix ? `?${suffix}` : ""}`);
  }

  createQuery(input: {
    name: string;
    query_sql: string;
    description?: string;
    is_private?: boolean;
    parameters?: Array<{
      key: string;
      type: "text" | "number" | "enum" | "datetime";
      value: string;
      enumOptions?: string[];
    }>;
  }): Promise<{ query_id: number }> {
    return this.request(`/query`, { method: "POST", body: JSON.stringify(input) });
  }

  /** Execute, poll until the run settles, then pull the rows. */
  async run<Row = Record<string, unknown>>(
    queryId: number,
    queryParameters: QueryParameters,
    opts: {
      performance?: "small" | "medium" | "large";
      limit?: number;
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ExecutionResults<Row>> {
    const {
      performance = "medium",
      limit,
      pollIntervalMs = 2000,
      timeoutMs = 600_000,
      signal,
    } = opts;

    const { execution_id } = await this.execute(queryId, queryParameters, performance);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (signal?.aborted) throw new DuneError("Request aborted", 499);

      const status = await this.status(execution_id);

      if (status.state === "QUERY_STATE_COMPLETED") {
        return this.results<Row>(execution_id, { limit });
      }

      if (FINISHED.includes(status.state)) {
        throw new DuneError(
          status.error?.message ?? `Dune execution ended as ${status.state}`,
          502,
          status.state === "QUERY_STATE_FAILED"
            ? "The SQL itself failed — open the query on dune.com to see the error."
            : undefined,
        );
      }

      if (Date.now() > deadline) {
        throw new DuneError(
          `Dune execution timed out after ${Math.round(timeoutMs / 1000)}s (execution ${execution_id})`,
          504,
          "Cold Solana balance scans can run several minutes. Raise DUNE_TIMEOUT_MS, shorten the window, or use Bag size mode.",
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
