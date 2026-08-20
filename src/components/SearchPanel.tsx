"use client";

import { ALL_CHAIN_IDS, CHAINS, FEATURED_CHAINS, type ChainId } from "@/lib/chains";
import type { Mode } from "@/lib/types";

export type ChainChoice = ChainId | "auto";

const LIMITS = [100, 250, 500];
const LOOKBACKS = [7, 30, 90, 365];

interface Props {
  token: string;
  chain: ChainChoice;
  mode: Mode;
  limit: number;
  lookbackDays: number;
  minUsd: number;
  loading: boolean;
  showAllChains: boolean;
  onTokenChange: (value: string) => void;
  onChainChange: (value: ChainChoice) => void;
  onModeChange: (value: Mode) => void;
  onLimitChange: (value: number) => void;
  onLookbackChange: (value: number) => void;
  onMinUsdChange: (value: number) => void;
  onToggleAllChains: () => void;
  onScan: () => void;
}

export default function SearchPanel(props: Props) {
  const chainOptions = props.showAllChains ? ALL_CHAIN_IDS : FEATURED_CHAINS;

  return (
    <div className="panel">
      <div className="search-row">
        <input
          className="ca-input"
          value={props.token}
          placeholder="Paste a contract address — Solana mint or 0x…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => props.onTokenChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !props.loading) props.onScan();
          }}
        />
        <button
          className="scan-button"
          onClick={props.onScan}
          disabled={props.loading || props.token.trim().length === 0}
        >
          {props.loading ? (
            <>
              <span className="spinner" />
              Scanning
            </>
          ) : (
            `Find top ${props.limit}`
          )}
        </button>
      </div>

      <div className="controls">
        <div className="control-group">
          <span className="control-label">Chain</span>
          <button
            className="pill"
            data-active={props.chain === "auto"}
            onClick={() => props.onChainChange("auto")}
            title="Detect from the address format"
          >
            Auto
          </button>
          {chainOptions.map((id) => (
            <button
              key={id}
              className="pill"
              data-active={props.chain === id}
              onClick={() => props.onChainChange(id)}
            >
              {CHAINS[id].label}
            </button>
          ))}
          <button
            className="pill"
            onClick={props.onToggleAllChains}
            title="Show the other EVM chains dex.trades covers"
          >
            {props.showAllChains ? "−" : "+"}
          </button>
        </div>

        <div className="control-group">
          <span className="control-label">Rank by</span>
          <button
            className="pill"
            data-active={props.mode === "traders"}
            onClick={() => props.onModeChange("traders")}
            title="Wallets that made the most realized profit trading this token"
          >
            Profit
          </button>
          <button
            className="pill"
            data-active={props.mode === "holders"}
            onClick={() => props.onModeChange("holders")}
            title="Wallets holding the biggest bag right now (much cheaper to run)"
          >
            Holdings
          </button>
        </div>

        <div className="control-group">
          <span className="control-label">Wallets</span>
          {LIMITS.map((n) => (
            <button
              key={n}
              className="pill"
              data-active={props.limit === n}
              onClick={() => props.onLimitChange(n)}
            >
              {n}
            </button>
          ))}
        </div>

        {props.mode === "traders" && (
          <>
            <div className="control-group">
              <span className="control-label">Window</span>
              {LOOKBACKS.map((n) => (
                <button
                  key={n}
                  className="pill"
                  data-active={props.lookbackDays === n}
                  onClick={() => props.onLookbackChange(n)}
                  title="How far back to scan trades. Shorter windows cost fewer Dune credits."
                >
                  {n < 365 ? `${n}d` : "1y"}
                </button>
              ))}
            </div>

            <div className="control-group">
              <span className="control-label">Min volume $</span>
              <input
                className="number-input"
                type="number"
                min={0}
                step={10}
                value={props.minUsd}
                onChange={(e) => props.onMinUsdChange(Number(e.target.value))}
                title="Drop wallets whose total buy+sell volume is under this"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
