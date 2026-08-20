"use client";

import { useMemo, useState } from "react";

import ExportBar from "@/components/ExportBar";
import SearchPanel, { type ChainChoice } from "@/components/SearchPanel";
import WalletTable from "@/components/WalletTable";
import { CHAINS } from "@/lib/chains";
import { formatMcap, formatTokens, shortAddress } from "@/lib/format";
import type { Mode, ScanResponse } from "@/lib/types";

interface Failure {
  error: string;
  hint?: string;
}

export default function Home() {
  const [token, setToken] = useState("");
  const [chain, setChain] = useState<ChainChoice>("auto");
  const [mode, setMode] = useState<Mode>("traders");
  const [limit, setLimit] = useState(100);
  const [lookbackDays, setLookbackDays] = useState(90);
  const [minUsd, setMinUsd] = useState(50);
  const [showAllChains, setShowAllChains] = useState(false);

  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function scan() {
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
        hint: "Is the dev server still running?",
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

  function toggleAll(wallets: string[], select: boolean) {
    setSelected(select ? new Set(wallets) : new Set());
  }

  const exportRows = useMemo(() => {
    if (!data) return [];
    return selected.size > 0 ? data.rows.filter((r) => selected.has(r.wallet)) : data.rows;
  }, [data, selected]);

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            alpha<span>wallets</span>
          </h1>
          <p className="tagline">
            Paste a contract. Get the wallets that actually made money on it. Built on Dune.
          </p>
        </div>
        <span className="masthead-note">solana · bnb · base</span>
      </header>

      <SearchPanel
        token={token}
        chain={chain}
        mode={mode}
        limit={limit}
        lookbackDays={lookbackDays}
        minUsd={minUsd}
        loading={loading}
        showAllChains={showAllChains}
        onTokenChange={setToken}
        onChainChange={setChain}
        onModeChange={setMode}
        onLimitChange={setLimit}
        onLookbackChange={setLookbackDays}
        onMinUsdChange={setMinUsd}
        onToggleAllChains={() => setShowAllChains((v) => !v)}
        onScan={scan}
      />

      {failure && (
        <div className="notice" data-kind="error">
          <strong>{failure.error}</strong>
          {failure.hint && <div style={{ marginTop: "0.35rem" }}>{failure.hint}</div>}
        </div>
      )}

      {data && (
        <>
          <div className="summary">
            <div>
              <div className="stat-label">Token</div>
              <div className="stat-value">
                {data.meta.tokenSymbol ? `${data.meta.tokenSymbol} · ` : ""}
                {shortAddress(data.meta.token, 6, 6)}
              </div>
            </div>
            <div>
              <div className="stat-label">Chain</div>
              <div className="stat-value" style={{ color: CHAINS[data.meta.chain].accent }}>
                {CHAINS[data.meta.chain].label}
              </div>
            </div>
            <div>
              <div className="stat-label">Ranked by</div>
              <div className="stat-value">
                {data.meta.mode === "traders" ? "Realized PnL" : "Bag size"}
              </div>
            </div>
            <div>
              <div className="stat-label">Wallets</div>
              <div className="stat-value">{data.meta.rowCount}</div>
            </div>
            {data.meta.currentMcap != null && (
              <div>
                <div className="stat-label">Market cap</div>
                <div className="stat-value">{formatMcap(data.meta.currentMcap)}</div>
              </div>
            )}
            {data.meta.circulatingSupply != null && (
              <div>
                <div className="stat-label">Supply</div>
                <div className="stat-value">{formatTokens(data.meta.circulatingSupply)}</div>
              </div>
            )}
            {data.meta.lookbackDays != null && (
              <div>
                <div className="stat-label">Window</div>
                <div className="stat-value">{data.meta.lookbackDays}d</div>
              </div>
            )}
            <div>
              <div className="stat-label">Source</div>
              <div className="stat-value muted">
                {data.meta.cached
                  ? "cached"
                  : data.meta.executionMillis != null
                    ? `dune · ${(data.meta.executionMillis / 1000).toFixed(1)}s`
                    : "dune"}
              </div>
            </div>
          </div>

          {data.rows.length > 0 ? (
            <WalletTable
              rows={data.rows}
              chain={data.meta.chain}
              mode={data.meta.mode}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          ) : (
            <div className="empty">
              No wallets came back for this contract.
              <br />
              {data.meta.mode === "traders"
                ? "Try a longer window, or drop the minimum volume filter."
                : "Dune may not have indexed this token's balances yet."}
            </div>
          )}
        </>
      )}

      {!data && !failure && !loading && (
        <div className="empty">
          Drop a contract address above and hit <kbd>Enter</kbd>.
          <br />
          Profit mode ranks wallets by realized PnL from DEX fills. Holdings mode just ranks
          current bags — it is much cheaper to run.
        </div>
      )}

      {data && data.rows.length > 0 && (
        <ExportBar
          rows={exportRows}
          meta={data.meta}
          selectedCount={selected.size}
          onClearSelection={() => setSelected(new Set())}
        />
      )}

      <footer className="footer">
        Data from{" "}
        <a href="https://dune.com" target="_blank" rel="noreferrer">
          Dune
        </a>{" "}
        · <code>dex.trades</code>, <code>dex_solana.trades</code> and the curated balances
        tables. PnL uses weighted-average cost basis and only counts DEX fills — tokens
        received by transfer or airdrop have no cost basis attached.
      </footer>
    </main>
  );
}
