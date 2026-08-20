"use client";

import { useEffect, useMemo, useState } from "react";

import ExportToolbar from "@/components/ExportToolbar";
import ResultsTable from "@/components/ResultsTable";
import { CHAINS, detectChain, isEvmAddress, type ChainId } from "@/lib/chains";
import { formatMcap } from "@/lib/format";
import type { ScanResponse } from "@/lib/types";

const EVM_CHOICES: ChainId[] = ["base", "bnb", "ethereum"];
const WINDOWS = [7, 30, 90, 365];
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
  const [days, setDays] = useState(90);

  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const stored = window.localStorage.getItem(KEY_STORE);
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
    window.localStorage.setItem(KEY_STORE, key);
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

    const call = async (body: Record<string, unknown>) => {
      const res = await fetch("/api/trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, body: await res.json() };
    };

    try {
      // Start the execution, then poll it. Each request is a short round trip,
      // so a multi-minute Dune query never holds a serverless function open.
      let step = await call(params);
      const deadline = Date.now() + 15 * 60_000;

      while (step.ok && step.body.status === "running") {
        if (Date.now() > deadline) {
          setData(null);
          setFailure({
            error: "Gave up after 15 minutes",
            hint: "The query is still running on Dune — try a shorter window.",
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2500));
        step = await call({ ...params, executionId: step.body.executionId });
      }

      if (!step.ok) {
        setData(null);
        setFailure(step.body as Failure);
        return;
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

  const exportRows = useMemo(() => {
    if (!data) return [];
    return selected.size > 0 ? data.rows.filter((r) => selected.has(r.wallet)) : data.rows;
  }, [data, selected]);

  const showKeyInput = !keySaved || editingKey;

  return (
    <main className="page">
      <header className="head">
        <h1 className="logo">
          bag<b>trace</b>
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
              "Top 100"
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
              {n < 365 ? `${n}d` : "1y"}
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
          <div className="recap">
            <b>{data.meta.tokenSymbol ?? "Unknown token"}</b>
            <span className="sep">·</span>
            {CHAINS[data.meta.chain].label}
            {data.meta.currentMcap != null && (
              <>
                <span className="sep">·</span>
                {formatMcap(data.meta.currentMcap)} mcap
              </>
            )}
            <span className="sep">·</span>
            {data.meta.rowCount} wallets
            <span className="sep">·</span>
            {data.meta.lookbackDays}d
            <span className="sep">·</span>
            <span className="dim">
              {data.meta.cached
                ? "cached"
                : data.meta.executionMillis != null
                  ? `${(data.meta.executionMillis / 1000).toFixed(1)}s`
                  : ""}
            </span>
          </div>

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
        PnL is what came out minus what went in, over DEX fills Dune indexed.{" "}
        <b>Buys seen</b> is how much of each wallet&rsquo;s sales we can match to a recorded
        buy — at 0% the PnL has no cost subtracted and is an upper bound. Dune&rsquo;s Solana
        buy-side coverage is incomplete on pump.fun tokens. Click any column to sort.
      </footer>
    </main>
  );
}
