"use client";

import { ALL_CHAIN_IDS, CHAINS, FEATURED_CHAINS, type ChainId } from "@/lib/chains";
import type { Mode } from "@/lib/types";

export type ChainChoice = ChainId | "auto";

const LIMITS = [100, 250, 500];
const WINDOWS = [7, 30, 90, 365];

interface Props {
  token: string;
  chain: ChainChoice;
  mode: Mode;
  limit: number;
  lookbackDays: number;
  minUsd: number;
  loading: boolean;
  moreChains: boolean;
  theme: "dark" | "light";
  onTokenChange: (v: string) => void;
  onChainChange: (v: ChainChoice) => void;
  onModeChange: (v: Mode) => void;
  onLimitChange: (v: number) => void;
  onLookbackChange: (v: number) => void;
  onMinUsdChange: (v: number) => void;
  onToggleMoreChains: () => void;
  onToggleTheme: () => void;
  onRun: () => void;
}

export default function ControlRail(p: Props) {
  const chains = p.moreChains ? ALL_CHAIN_IDS : FEATURED_CHAINS;

  return (
    <aside className="rail">
      <div className="brand">
        <span className="brand-mark">B</span>
        <div>
          <h1 className="brand-name">Bagtrace</h1>
          <p className="brand-sub">wallet forensics on Dune</p>
        </div>
        <button
          className="theme-toggle"
          onClick={p.onToggleTheme}
          title={`Switch to ${p.theme === "dark" ? "light" : "dark"} theme`}
          aria-label="Toggle theme"
        >
          {p.theme === "dark" ? "☀" : "☾"}
        </button>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="ca">
          Contract address
        </label>
        <textarea
          id="ca"
          className="ca-input"
          value={p.token}
          placeholder="Solana mint or 0x… — paste and hit Trace"
          spellCheck={false}
          autoComplete="off"
          rows={3}
          onChange={(e) => p.onTokenChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!p.loading) p.onRun();
            }
          }}
        />
      </div>

      <div className="field">
        <span className="field-label">Chain</span>
        <div className="seg">
          <button data-active={p.chain === "auto"} onClick={() => p.onChainChange("auto")}>
            Auto
          </button>
          {chains.map((id) => (
            <button
              key={id}
              data-active={p.chain === id}
              onClick={() => p.onChainChange(id)}
            >
              {CHAINS[id].label}
            </button>
          ))}
          <button onClick={p.onToggleMoreChains} title="More EVM chains">
            {p.moreChains ? "Fewer" : "More…"}
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field-label">Rank wallets by</span>
        <div className="seg">
          <button
            data-active={p.mode === "traders"}
            onClick={() => p.onModeChange("traders")}
            title="Realized profit from DEX fills"
          >
            Profit
          </button>
          <button
            data-active={p.mode === "holders"}
            onClick={() => p.onModeChange("holders")}
            title="Current bag size — cheaper and faster"
          >
            Bag size
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field-label">How many</span>
        <div className="seg">
          {LIMITS.map((n) => (
            <button key={n} data-active={p.limit === n} onClick={() => p.onLimitChange(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {p.mode === "traders" && (
        <>
          <div className="field">
            <span className="field-label">Trade window</span>
            <div className="seg">
              {WINDOWS.map((n) => (
                <button
                  key={n}
                  data-active={p.lookbackDays === n}
                  onClick={() => p.onLookbackChange(n)}
                  title="Shorter windows scan less data and cost fewer credits"
                >
                  {n < 365 ? `${n}d` : "1y"}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="minusd">
              Min volume (USD)
            </label>
            <input
              id="minusd"
              className="num-input"
              type="number"
              min={0}
              step={10}
              value={p.minUsd}
              onChange={(e) => p.onMinUsdChange(Number(e.target.value))}
            />
          </div>
        </>
      )}

      <button className="run" onClick={p.onRun} disabled={p.loading || !p.token.trim()}>
        {p.loading ? (
          <>
            <span className="spin" />
            Tracing
          </>
        ) : (
          "Trace wallets"
        )}
      </button>

      <p className="rail-note">
        Every run is one query against{" "}
        <a href="https://dune.com" target="_blank" rel="noreferrer">
          Dune
        </a>{" "}
        and costs credits. Identical runs are cached, so re-tracing the same contract is
        free until the cache expires.
      </p>
    </aside>
  );
}
