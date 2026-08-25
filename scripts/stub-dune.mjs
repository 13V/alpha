#!/usr/bin/env node
/**
 * Stands in for api.dune.com so the trace route can be exercised without
 * spending credits. Point the app at it with DUNE_API_BASE.
 *
 *   node scripts/stub-dune.mjs --port 3999 --mode stored
 *
 * Modes:
 *   stored  /query/{id}/results returns rows, aged --age-minutes
 *   cold    /query/{id}/results 404s, so the caller has to execute
 */
import { createServer } from "node:http";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--") ? [[a.slice(2), all[i + 1]?.startsWith("--") ? "true" : all[i + 1]]] : [],
  ),
);
const PORT = Number(args.port ?? 3999);
const MODE = args.mode ?? "stored";
const AGE_MINUTES = Number(args["age-minutes"] ?? 12);

const seen = [];

function project(list, cols) {
  if (!cols) return list;
  const want = cols.split(",");
  return list.map((r) => Object.fromEntries(want.filter((c) => c in r).map((c) => [c, r[c]])));
}

function rows(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    rank: i + 1,
    wallet: `StubWallet${i + 1}`.padEnd(44, "x"),
    realized_pnl_usd: String(1000 - i * 100),
    profit_multiple: String(5 - i),
    realized_roi: String(2 - i * 0.1),
    tokens_bought: "1000",
    tokens_sold: "1000",
    buy_coverage: "1",
    token_symbol: "STUB",
    circulating_supply: "1000000000",
    current_mcap: "50000",
    first_trade: "2026-08-01 00:00:00.000 UTC",
    last_trade: "2026-08-20 00:00:00.000 UTC",
  }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  seen.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // latest stored result for a query + params
  if (req.method === "GET" && /\/query\/\d+\/results$/.test(url.pathname)) {
    if (MODE !== "stored") return send(404, { error: "no results found for those parameters" });
    return send(200, {
      execution_id: "01STUBSTOREDEXECUTION",
      query_id: Number(url.pathname.split("/")[2]),
      state: "QUERY_STATE_COMPLETED",
      execution_ended_at: new Date(Date.now() - AGE_MINUTES * 60_000).toISOString(),
      result: { rows: project(rows(), url.searchParams.get("columns")),
                metadata: { column_names: [], row_count: 3, execution_time_millis: 41234 } },
    });
  }

  if (req.method === "POST" && /\/query\/\d+\/execute$/.test(url.pathname)) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let perf = "?";
      try { perf = JSON.parse(body || "{}").performance ?? "(unset)"; } catch {}
      seen.push(`  -> execute performance=${perf}`);
      send(200, { execution_id: "01STUBFRESHEXECUTION", state: "QUERY_STATE_PENDING" });
    });
    return;
  }

  if (req.method === "GET" && /\/execution\/[^/]+\/status$/.test(url.pathname)) {
    return send(200, {
      execution_id: "01STUBFRESHEXECUTION",
      query_id: 8385958,
      state: "QUERY_STATE_COMPLETED",
      execution_ended_at: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && /\/execution\/[^/]+\/results$/.test(url.pathname)) {
    return send(200, {
      execution_id: "01STUBFRESHEXECUTION",
      query_id: 8385958,
      state: "QUERY_STATE_COMPLETED",
      result: { rows: project(rows(), url.searchParams.get("columns")),
                metadata: { column_names: [], row_count: 3, execution_time_millis: 298000 } },
    });
  }

  if (url.pathname === "/__seen") return send(200, { seen });
  send(404, { error: `stub has no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => console.log(`stub dune on :${PORT} mode=${MODE} age=${AGE_MINUTES}m`));
