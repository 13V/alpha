"use client";

import { useMemo, useState } from "react";

import { CHAINS, type ChainId } from "@/lib/chains";
import {
  formatMcap,
  formatMultiple,
  formatRoi,
  formatUsd,
  shortAddress,
} from "@/lib/format";
import type { WalletRow } from "@/lib/types";

type SortKey =
  | "rank"
  | "realizedPnlUsd"
  | "profitMultiple"
  | "realizedRoi"
  | "avgBuyMcap"
  | "avgSellMcap"
  | "usdSpent"
  | "usdReceived"
  | "buyCoverage";

const COLUMNS: Array<{ key: SortKey; label: string; title?: string }> = [
  { key: "realizedPnlUsd", label: "Realized PnL" },
  { key: "profitMultiple", label: "Multiple", title: "Average sell price / average buy price" },
  {
    key: "realizedRoi",
    label: "ROI",
    title:
      "Realized profit as a share of the USD this wallet spent in the window. A wallet that closed everything lands on multiple - 1; one still holding lands lower.",
  },
  { key: "avgBuyMcap", label: "Entry MC" },
  { key: "avgSellMcap", label: "Exit MC" },
  { key: "usdSpent", label: "Cost in", title: "What this wallet paid, including tokens it received by transfer valued at the price when they landed" },
  { key: "usdReceived", label: "Sold" },
  {
    key: "buyCoverage",
    label: "Buys seen",
    title:
      "How much of what this wallet sold we can account for — DEX buys plus tokens received by transfer, valued at the price when they landed. 100% means the PnL rests on a real cost basis.",
  },
];

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
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // nulls always sink, whichever way the column is pointing
      if (av == null && bv == null) return a.rank - b.rank;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = Number(av) - Number(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function sortBy(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // rank reads best ascending; every value column reads best biggest-first
      setSortDir(key === "rank" ? "asc" : "desc");
    }
  }

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "");

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
            <th className="l sortable" onClick={() => sortBy("rank")} title="Sort by rank">
              #{arrow("rank")}
            </th>
            <th className="l">Wallet</th>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className="sortable"
                title={column.title ?? `Sort by ${column.label}`}
                onClick={() => sortBy(column.key)}
              >
                {column.label}
                {arrow(column.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
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
                <td
                  className={
                    row.buyCoverage == null || row.buyCoverage < 0.2
                      ? "down"
                      : row.buyCoverage < 0.9
                        ? "dim"
                        : "up"
                  }
                  title={
                    row.buyCoverage != null && row.buyCoverage < 0.9
                      ? "Dune has no buy record for the rest of what this wallet sold, so its PnL is an upper bound."
                      : undefined
                  }
                >
                  {row.buyCoverage == null ? "0%" : `${Math.round(row.buyCoverage * 100)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
