"use client";

import { useState } from "react";

import { CHAINS, type ChainId } from "@/lib/chains";
import {
  formatMcap,
  formatMultiple,
  formatRoi,
  formatUsd,
  shortAddress,
} from "@/lib/format";
import type { WalletRow } from "@/lib/types";

interface Props {
  rows: WalletRow[];
  chain: ChainId;
  selected: Set<string>;
  onToggle: (wallet: string) => void;
  onToggleAll: (wallets: string[], select: boolean) => void;
}

export default function ResultsTable({
  rows,
  chain,
  selected,
  onToggle,
  onToggleAll,
}: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  const all = rows.map((r) => r.wallet);
  const allSelected = all.length > 0 && all.every((w) => selected.has(w));

  async function copyAddress(wallet: string) {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(wallet);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard blocked — the address is still linked to the explorer */
    }
  }

  return (
    <div className="wrap">
      <table>
        <thead>
          <tr>
            <th className="l" style={{ width: "2rem" }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => onToggleAll(all, !allSelected)}
                aria-label="Select all"
              />
            </th>
            <th className="l">#</th>
            <th className="l">Wallet</th>
            <th>Realized PnL</th>
            <th>Multiple</th>
            <th>ROI</th>
            <th>Entry MC</th>
            <th>Exit MC</th>
            <th>Bought</th>
            <th>Sold</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const sel = selected.has(row.wallet);
            const pnl = row.realizedPnlUsd;
            return (
              <tr key={row.wallet} data-sel={sel}>
                <td className="l">
                  <input
                    type="checkbox"
                    checked={sel}
                    onChange={() => onToggle(row.wallet)}
                    aria-label={`Select ${row.wallet}`}
                  />
                </td>
                <td className="l">
                  <span className="rank" data-top={row.rank <= 3}>
                    {row.rank}
                  </span>
                </td>
                <td className="l">
                  <a
                    href={CHAINS[chain].explorer(row.wallet)}
                    target="_blank"
                    rel="noreferrer"
                    title={row.wallet}
                  >
                    {shortAddress(row.wallet, 5, 5)}
                  </a>{" "}
                  <button
                    className="dim"
                    style={{ background: "none", border: "none", padding: 0 }}
                    onClick={() => copyAddress(row.wallet)}
                    title="Copy address"
                    aria-label="Copy address"
                  >
                    {copied === row.wallet ? "✓" : "⧉"}
                  </button>
                </td>
                <td className={pnl != null && pnl >= 0 ? "up" : "down"}>
                  {formatUsd(pnl)}
                  {row.costBasis === "partial" && (
                    <span
                      className="dim"
                      title="Sold more than it bought in this window, so it was already holding when the window opened and the cost basis is incomplete. Widen the window for a true figure."
                    >
                      {" "}
                      ⚠
                    </span>
                  )}
                </td>
                <td className={(row.profitMultiple ?? 0) >= 1 ? "up" : "down"}>
                  {formatMultiple(row.profitMultiple)}
                </td>
                <td className={(row.realizedRoi ?? 0) >= 0 ? "up" : "down"}>
                  {formatRoi(row.realizedRoi)}
                </td>
                <td>{formatMcap(row.avgBuyMcap)}</td>
                <td>{formatMcap(row.avgSellMcap)}</td>
                <td className="dim">{formatUsd(row.usdSpent)}</td>
                <td className="dim">{formatUsd(row.usdReceived)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
