"use client";

import { useEffect, useMemo, useState } from "react";

import ControlRail, { type ChainChoice } from "@/components/ControlRail";
import ExportToolbar from "@/components/ExportToolbar";
import ResultsTable from "@/components/ResultsTable";
import { CHAINS } from "@/lib/chains";
import { formatCount, formatMcap, formatTokens, shortAddress } from "@/lib/format";
import type { Mode, ScanResponse } from "@/lib/types";

interface Failure {
  error: string;
  hint?: string;
}

type Theme = "dark" | "light";

export default function Home() {
  const [token, setToken] = useState("");
  const [chain, setChain] = useState<ChainChoice>("auto");
  const [mode, setMode] = useState<Mode>("traders");
  const [limit, setLimit] = useState(100);
  const [lookbackDays, setLookbackDays] = useState(90);
  const [minUsd, setMinUsd] = useState(50);
  const [moreChains, setMoreChains] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");

  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const stored = window.localStorage.getItem("bagtrace-theme") as Theme | null;
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, [loading]);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("bagtrace-theme", next);
  }

  async function run() {
    setLoading(true);
    setFailure(null);
    setSelected(new Set());
    try {
      const res = await fetch("/api/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim(),
          chain: chain === "auto" ? undefined : chain,
          mode,
          limit,
          lookbackDays,
          minUsd,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setData(null);
        setFailure(body as Failure);
        return;
      }
      setData(body as ScanResponse);
    } catch (error) {
      setData(null);
      setFailure({
        error: error instanceof Error ? error.message : "Request failed",
        hint: "The dev server may have stopped.",
      });
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

  const exportRows = useMemo(() => {
    if (!data) return [];
    return selected.size > 0 ? data.rows.filter((r) => selected.has(r.wallet)) : data.rows;
  }, [data, selected]);

  return (
    <div className="frame">
      <ControlRail
        token={token}
        chain={chain}
        mode={mode}
        limit={limit}
        lookbackDays={lookbackDays}
        minUsd={minUsd}
        loading={loading}
        moreChains={moreChains}
        theme={theme}
        onTokenChange={setToken}
        onChainChange={setChain}
        onModeChange={setMode}
        onLimitChange={setLimit}
        onLookbackChange={setLookbackDays}
        onMinUsdChange={setMinUsd}
        onToggleMoreChains={() => setMoreChains((v) => !v)}
        onToggleTheme={toggleTheme}
        onRun={run}
      />

      <main className="main">
        {failure && (
          <div className="notice" data-kind="error">
            <strong>{failure.error}</strong>
            {failure.hint && <span>{failure.hint}</span>}
          </div>
        )}

        {loading && (
          <div className="progress">
            <div className="progress-title">Running the query on Dune</div>
            <div className="progress-sub">
              {mode === "traders"
                ? `scanning ${lookbackDays}d of DEX fills · ${elapsed}s`
                : `reading balances · ${elapsed}s`}
            </div>
            <div className="progress-bar">
              <i />
            </div>
          </div>
        )}

        {!loading && data && (
          <>
            <dl className="summary">
              <div>
                <dt>Token</dt>
                <dd>
                  {data.meta.tokenSymbol ?? shortAddress(data.meta.token, 6, 4)}
                </dd>
              </div>
              <div>
                <dt>Chain</dt>
                <dd>
                  <span
                    className="chain-dot"
                    style={{ background: CHAINS[data.meta.chain].accent }}
                  />
                  {CHAINS[data.meta.chain].label}
                </dd>
              </div>
              <div>
                <dt>Ranked by</dt>
                <dd>{data.meta.mode === "traders" ? "Realized PnL" : "Bag size"}</dd>
              </div>
              <div>
                <dt>Rows</dt>
                <dd>{data.meta.rowCount}</dd>
              </div>
              {data.meta.currentMcap != null && (
                <div>
                  <dt>Market cap</dt>
                  <dd>{formatMcap(data.meta.currentMcap)}</dd>
                </div>
              )}
              {data.meta.circulatingSupply != null && (
                <div>
                  <dt>Supply</dt>
                  <dd>{formatTokens(data.meta.circulatingSupply)}</dd>
                </div>
              )}
              {data.meta.holderCount != null && (
                <div>
                  <dt>Holders</dt>
                  <dd>{formatCount(data.meta.holderCount)}</dd>
                </div>
              )}
              {data.meta.lookbackDays != null && (
                <div>
                  <dt>Window</dt>
                  <dd>{data.meta.lookbackDays}d</dd>
                </div>
              )}
              <div>
                <dt>Ran in</dt>
                <dd className="dim">
                  {data.meta.cached
                    ? "cached"
                    : data.meta.executionMillis != null
                      ? `${(data.meta.executionMillis / 1000).toFixed(1)}s`
                      : "—"}
                </dd>
              </div>
            </dl>

            {data.rows.length > 0 ? (
              <>
                <ExportToolbar
                  rows={exportRows}
                  meta={data.meta}
                  selectedCount={selected.size}
                  onClearSelection={() => setSelected(new Set())}
                />
                <ResultsTable
                  rows={data.rows}
                  chain={data.meta.chain}
                  mode={data.meta.mode}
                  selected={selected}
                  onToggle={toggle}
                  onToggleAll={(wallets, select) =>
                    setSelected(select ? new Set(wallets) : new Set())
                  }
                />
              </>
            ) : (
              <div className="placeholder">
                <h2>Nothing came back</h2>
                {data.meta.mode === "traders"
                  ? "No wallet cleared the minimum volume in this window. Try a longer window or lower the floor."
                  : "Dune has no balances indexed for this contract yet."}
              </div>
            )}
          </>
        )}

        {!loading && !data && !failure && (
          <div className="placeholder">
            <h2>Paste a contract address</h2>
            <b>Profit</b> ranks wallets by realized PnL from DEX fills and shows the market
            cap each one entered and exited at.
            <br />
            <b>Bag size</b> just ranks current holders — cheaper and faster.
            <br />
            <br />
            Solana mints and <code>0x…</code> contracts are detected automatically.
          </div>
        )}
      </main>
    </div>
  );
}
