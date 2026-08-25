"use client";

import { useEffect, useMemo, useState } from "react";

import ExportToolbar from "@/components/ExportToolbar";
import HowItWorks from "@/components/HowItWorks";
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

const windowLabel = (n: number) => (n < 365 ? `${n}d` : n === 365 ? "1y" : "Max");

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
  const [showHelp, setShowHelp] = useState(false);

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
        error: "add your dune api key",
        hint: "it is free at dune.com/settings/api and never leaves this browser.",
      });
      setEditingKey(true);
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
      return {
        kind: "ok",
        body: parsed as { status: string; executionId?: string } & ScanResponse,
      };
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
          setData(null);
          setFailure(step.failure);
          return;
        }
        if (Date.now() > deadline) {
          setData(null);
          setFailure({
            error: "gave up after 15 minutes",
            hint: "the query is still running on dune. try a shorter window.",
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
  // acquisitions, which is exactly where the winners are.
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
    <div className="app">
      <header className="appbar">
        <span className="brand">
          <i />
          BAGTRACE
        </span>

        <input
          className="ca-field"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="paste a ca"
          spellCheck={false}
          autoComplete="off"
          aria-label="Contract address"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading) run();
          }}
        />

        {needsChain && (
          <div className="seg">
            {EVM_CHOICES.map((id) => (
              <button
                key={id}
                data-active={evmChain === id}
                onClick={() => setEvmChain(id)}
              >
                {CHAINS[id].label}
              </button>
            ))}
          </div>
        )}

        <div className="seg">
          {WINDOWS.map((n) => (
            <button
              key={n}
              data-active={days === n}
              onClick={() => setDays(n)}
              title="How far back to scan. A window that opens after the token launched hides its winners."
            >
              {windowLabel(n)}
            </button>
          ))}
        </div>

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

        <span className="push" />

        <button className="helpbtn" onClick={() => setShowHelp(true)}>
          how it works
        </button>

        {showKeyInput ? (
          <>
            <input
              className="key-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="dune api key"
              spellCheck={false}
              autoComplete="off"
              aria-label="Dune API key"
            />
            <a
              className="bar-link"
              href="https://dune.com/settings/api"
              target="_blank"
              rel="noreferrer"
            >
              get one
            </a>
          </>
        ) : (
          <span className="keychip">
            <i />
            key set
            <button onClick={() => setEditingKey(true)}>swap</button>
          </span>
        )}
      </header>

      <main className="main">
        {loading && (
          <div className="state">
            <h2>cooking</h2>
            <p>
              {elapsed}s in. solana takes a few minutes on a token nobody has pulled before —
              dune has to scan it cold.
            </p>
            <div className="bar-progress">
              <i />
            </div>
          </div>
        )}

        {!loading && failure && (
          <div className="state" data-kind="error">
            <h2>{failure.error.toLowerCase()}</h2>
            {failure.hint && <p>{failure.hint}</p>}
          </div>
        )}

        {!loading && !failure && data && data.rows.length > 0 && (
          <>
            <div className="ctx">
              <span className="sym">{data.meta.tokenSymbol ?? "Unknown token"}</span>
              <span className="dot">·</span>
              <span className="kv">{CHAINS[data.meta.chain].label}</span>
              {data.meta.currentMcap != null && (
                <>
                  <span className="dot">·</span>
                  <span className="kv">
                    mcap <b>{formatMcap(data.meta.currentMcap)}</b>
                  </span>
                </>
              )}
              <span className="dot">·</span>
              <span className="kv">
                wallets <b>{data.meta.rowCount}</b>
              </span>
              <span className="dot">·</span>
              <span className="kv">
                window <b>{data.meta.lookbackDays}d</b>
              </span>
              <span className="dot">·</span>
              <span className="kv">
                {data.meta.cached ? (
                  <b>cached</b>
                ) : data.meta.executionMillis != null ? (
                  <b>{(data.meta.executionMillis / 1000).toFixed(1)}s</b>
                ) : (
                  <b>—</b>
                )}
              </span>
            </div>

            {truncated && (
              <div className="note">
                <b>older than the {data.meta.lookbackDays}d window.</b> its earliest trades sit
                right at the edge, so buys from before that are missing and these wallets look
                worse than they were. widen it.
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
          </>
        )}

        {!loading && !failure && data && data.rows.length === 0 && (
          <div className="state">
            <h2>nothing here yet</h2>
            <p>
              {data.meta.chain === "solana"
                ? "dune's solana pipeline runs a few hours behind the chain, so a token that launched today will not show up until it catches up. check back later."
                : "it may not have traded on a dex dune decodes, or its trades are older than the window."}
            </p>
          </div>
        )}

        {!loading && !failure && !data && (
          <div className="state">
            <h2>paste a ca</h2>
            <p>
              the 100 wallets that made the most money on it — ranked by realized profit, with
              the market cap each one <b>entered</b> and <b>exited</b> at.
            </p>
            <p>
              cost basis counts dex buys <b>and</b> tokens received by transfer, valued at the
              price when they landed. that is how the winners on pump.fun tokens actually get
              their bags — miss it and they all read as zero.
            </p>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span>
          {detected ? `${CHAINS[detected].label.toLowerCase()} detected` : "solana mint or 0x address"}
        </span>
        <span className="push" />
        <span>your key stays in this browser — only passed through to dune</span>
        <span>·</span>
        <a href="https://dune.com" target="_blank" rel="noreferrer">
          Dune
        </a>
      </footer>

      {showHelp && <HowItWorks onClose={() => setShowHelp(false)} />}
    </div>
  );
}
