"use client";

import { useEffect, useMemo, useState } from "react";

import ExportToolbar from "@/components/ExportToolbar";
import ResultsTable from "@/components/ResultsTable";
import { CHAINS, detectChain, isEvmAddress, type ChainId } from "@/lib/chains";
import { formatMcap, parseDuneTime } from "@/lib/format";
import type { ScanResponse } from "@/lib/types";

const EVM_CHOICES: ChainId[] = ["base", "bnb", "ethereum"];
const WINDOWS = [7, 30, 90, 365, 1095];
const DAY_MS = 86_400_000;
const KEY_STORE = "bagtrace-dune-key";

interface Failure {
  error: string;
  hint?: string;
}

export default function Home() {
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [evmChain, setEvmChain] = useState<ChainId>("base");
  const [days, setDays] = useState(365);

  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(KEY_STORE);
    } catch {
      /* storage blocked — the key just is not remembered */
    }
    if (stored) {
      setApiKey(stored);
      setKeySaved(true);
    }
  }, []);

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, [loading]);

  // Only EVM addresses are ambiguous — a Solana mint identifies its chain by itself.
  const needsChain = isEvmAddress(token);
  const detected = detectChain(token);

  async function run() {
    const key = apiKey.trim();
    if (!key) {
      setFailure({
        error: "Add your Dune API key first",
        hint: "It is free at dune.com/settings/api and stays in this browser.",
      });
      return;
    }

    setLoading(true);
    setFailure(null);
    setSelected(new Set());
    try {
      window.localStorage.setItem(KEY_STORE, key);
    } catch {
      /* storage blocked — key kept in memory for this visit only */
    }
    setKeySaved(true);
    setEditingKey(false);

    const params = {
      apiKey: key,
      token: token.trim(),
      chain: needsChain ? evmChain : undefined,
      mode: "traders",
      limit: 100,
      lookbackDays: days,
    };

    // One call = one short round trip. Network blips, rate limits and platform
    // error pages (non-JSON bodies) must not kill a multi-minute trace whose
    // execution is still running fine on Dune, so failures are classified:
    // transient ones retry with the same executionId, real ones surface.
    const call = async (
      body: Record<string, unknown>,
    ): Promise<
      | { kind: "ok"; body: { status: string; executionId?: string } & ScanResponse }
      | { kind: "fail"; failure: Failure }
      | { kind: "transient"; failure: Failure }
    > => {
      let res: Response;
      try {
        res = await fetch("/api/trace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        return {
          kind: "transient",
          failure: { error: error instanceof Error ? error.message : "Network error" },
        };
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        // a proxy/platform error page, not our route
        return {
          kind: res.ok ? "fail" : "transient",
          failure: { error: `The server returned an unreadable response (${res.status})` },
        };
      }
      if (!res.ok) {
        const failure = parsed as Failure;
        const transient = res.status === 429 || res.status === 502 || res.status >= 503;
        return { kind: transient ? "transient" : "fail", failure };
      }
      return { kind: "ok", body: parsed as { status: string; executionId?: string } & ScanResponse };
    };

    try {
      let step = await call(params);
      const deadline = Date.now() + 15 * 60_000;
      let executionId: string | undefined;
      let strikes = 0;

      for (;;) {
        if (step.kind === "ok") {
          strikes = 0;
          if (step.body.status !== "running") break;
          executionId = step.body.executionId ?? executionId;
        } else if (step.kind === "fail" || !executionId || ++strikes > 5) {
          // a hard error, or transient trouble before/beyond what retrying covers
          setData(null);
          setFailure(step.failure);
          return;
        }
        if (Date.now() > deadline) {
          setData(null);
          setFailure({
            error: "Gave up after 15 minutes",
            hint: "The query is still running on Dune — try a shorter window.",
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, step.kind === "ok" ? 2500 : 5000));
        step = await call(executionId ? { ...params, executionId } : params);
      }

      setData(step.body as ScanResponse);
    } catch (error) {
      setData(null);
      setFailure({ error: error instanceof Error ? error.message : "Request failed" });
    } finally {
      setLoading(false);
    }
  }

  function toggle(wallet: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(wallet)) next.delete(wallet);
      else next.add(wallet);
      return next;
    });
  }

  // A window that opens after the token launched hides the launch-period
  // acquisitions, which is exactly where the winners are. Detect it rather
  // than let the user read a truncated list as the whole story.
  const truncated = useMemo(() => {
    if (!data || data.rows.length === 0 || data.meta.lookbackDays == null) return false;
    const times = data.rows
      .map((r) => parseDuneTime(r.firstTrade))
      .filter((t): t is number => t != null);
    if (times.length === 0) return false;
    const windowStart = Date.now() - data.meta.lookbackDays * DAY_MS;
    return Math.min(...times) - windowStart < 2 * DAY_MS;
  }, [data]);

  const exportRows = useMemo(() => {
    if (!data) return [];
    return selected.size > 0 ? data.rows.filter((r) => selected.has(r.wallet)) : data.rows;
  }, [data, selected]);

  const showKeyInput = !keySaved || editingKey;

  return (
    <main className="page">
      <header className="head">
        <h1 className="logo">
          Bagtrace<b>.</b>
        </h1>
        <p className="sub">
          Paste a contract. Get the 100 wallets that made the most money on it.
        </p>
      </header>

      <div className="box">
        <div className="search">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Contract address — Solana mint or 0x…"
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) run();
            }}
          />
          <button className="go" onClick={run} disabled={loading || !token.trim()}>
            {loading ? (
              <>
                <span className="spin" />
                Tracing
              </>
            ) : (
              "Trace"
            )}
          </button>
        </div>

        <div className="under">
          {showKeyInput ? (
            <>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Dune API key"
                spellCheck={false}
                autoComplete="off"
                aria-label="Dune API key"
              />
              <a href="https://dune.com/settings/api" target="_blank" rel="noreferrer">
                get one free →
              </a>
            </>
          ) : (
            <>
              <span className="keyok">✓ key saved in this browser</span>
              <button className="mini" onClick={() => setEditingKey(true)}>
                change
              </button>
            </>
          )}

          {needsChain && (
            <>
              <span>chain</span>
              {EVM_CHOICES.map((id) => (
                <button
                  key={id}
                  className="mini"
                  data-active={evmChain === id}
                  onClick={() => setEvmChain(id)}
                >
                  {CHAINS[id].label}
                </button>
              ))}
            </>
          )}

          <span>window</span>
          {WINDOWS.map((n) => (
            <button
              key={n}
              className="mini"
              data-active={days === n}
              onClick={() => setDays(n)}
              title="How far back to scan trades. Shorter costs fewer Dune credits."
            >
              {n < 365 ? `${n}d` : n === 365 ? "1y" : "Max"}
            </button>
          ))}

          {detected === "solana" && <span className="dim">· solana</span>}
        </div>
      </div>

      {failure && (
        <div className="msg" data-kind="error">
          <strong>{failure.error}</strong>
          {failure.hint && <span>{failure.hint}</span>}
        </div>
      )}

      {loading && (
        <div className="working">
          Running your query on Dune…
          <div className="bar">
            <i />
          </div>
          <div style={{ marginTop: "0.7rem", fontSize: "0.78rem" }}>
            {elapsed}s · Solana can take a few minutes on a token nobody has queried before
          </div>
        </div>
      )}

      {!loading && data && data.rows.length > 0 && (
        <div className="results">
          <dl className="recap">
            <div>
              <dt>Token</dt>
              <dd>{data.meta.tokenSymbol ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>{CHAINS[data.meta.chain].label}</dd>
            </div>
            {data.meta.currentMcap != null && (
              <div>
                <dt>Market cap</dt>
                <dd>{formatMcap(data.meta.currentMcap)}</dd>
              </div>
            )}
            <div>
              <dt>Wallets</dt>
              <dd>{data.meta.rowCount}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>{data.meta.lookbackDays}d</dd>
            </div>
            <div>
              <dt>Ran in</dt>
              <dd className="quiet">
                {data.meta.cached
                  ? "cached"
                  : data.meta.executionMillis != null
                    ? `${(data.meta.executionMillis / 1000).toFixed(1)}s`
                    : "—"}
              </dd>
            </div>
          </dl>

          {truncated && (
            <div className="msg" style={{ margin: "0 0 0.75rem" }}>
              <strong style={{ color: "var(--accent)" }}>
                This token is older than the {data.meta.lookbackDays}-day window
              </strong>
              <span>
                Its earliest trades sit right at the edge, so buys and transfers from before
                that are missing and these wallets look less profitable than they were. Run it
                again on a longer window.
              </span>
            </div>
          )}

          <ExportToolbar
            rows={exportRows}
            meta={data.meta}
            selectedCount={selected.size}
            onClearSelection={() => setSelected(new Set())}
          />
          <ResultsTable
            rows={data.rows}
            chain={data.meta.chain}
            selected={selected}
            onToggle={toggle}
            onToggleAll={(wallets, select) =>
              setSelected(select ? new Set(wallets) : new Set())
            }
          />
        </div>
      )}

      {!loading && data && data.rows.length === 0 && (
        <div className="hint">
          <b>Dune has no trades indexed for this contract</b> in the last{" "}
          {data.meta.lookbackDays} days.
          <br />
          {data.meta.chain === "solana" ? (
            <>
              Dune&rsquo;s Solana pipeline runs several hours behind the chain, so a token
              that launched today will not appear until it catches up. If this is a fresh
              launch, check back in a few hours.
            </>
          ) : (
            <>
              It may not have traded on a DEX that Dune decodes, or the trades may be older
              than the window.
            </>
          )}
          <br />
          Otherwise, try a longer window.
        </div>
      )}

      {!loading && !data && !failure && (
        <div className="hint">
          Ranked by realized profit from DEX fills, with the market cap each wallet entered
          and exited at.
          <br />
          Pick the ones you want and copy them straight into Axiom.
        </div>
      )}

      <footer className="foot">
        Runs on your own{" "}
        <a href="https://dune.com/settings/api" target="_blank" rel="noreferrer">
          Dune
        </a>{" "}
        key — it stays in your browser and is only passed through to Dune.
        <br />
        Cost basis counts DEX buys <i>and</i> tokens received by transfer, valued at the price
        when they landed — which is how the winners on pump.fun tokens actually acquire their
        bags. <b>Buys seen</b> is how much of each wallet&rsquo;s sales that accounts for. Click
        any column to sort.
      </footer>
    </main>
  );
}
