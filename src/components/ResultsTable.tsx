"use client";

import { useMemo, useState, type ReactNode } from "react";

import { CHAINS, type ChainId } from "@/lib/chains";
import {
  formatCount,
  formatDuration,
  formatMcap,
  formatMultiple,
  formatNative,
  formatPct,
  formatPrice,
  formatRoi,
  formatTokens,
  formatUsd,
  formatWhen,
  shortAddress,
} from "@/lib/format";
import type { Mode, WalletRow } from "@/lib/types";

interface Column {
  key: string;
  header: string;
  title?: string;
  modes: Mode[];
  value: (row: WalletRow) => number | string | null;
  render: (row: WalletRow, chain: ChainId) => ReactNode;
}

function signed(value: number | null, text: string): ReactNode {
  if (value == null) return <span className="dim">—</span>;
  return <span className={value >= 0 ? "up" : "down"}>{text}</span>;
}

const COLUMNS: Column[] = [
  {
    key: "realizedPnlUsd",
    header: "Realized",
    title: "Profit already taken, on weighted-average cost basis",
    modes: ["traders"],
    value: (r) => r.realizedPnlUsd,
    render: (r) => (
      <>
        {signed(r.realizedPnlUsd, formatUsd(r.realizedPnlUsd))}
        {r.costBasis === "partial" && (
          <span
            className="dim"
            title="Sold more than it bought in this window — it was already holding when the window opened, so the cost basis is incomplete. Widen the window for a true figure."
          >
            {" "}
            ⚠
          </span>
        )}
      </>
    ),
  },
  {
    key: "unrealizedPnlUsd",
    header: "Open",
    title: "Paper profit on the bag still held",
    modes: ["traders"],
    value: (r) => r.unrealizedPnlUsd,
    render: (r) => signed(r.unrealizedPnlUsd, formatUsd(r.unrealizedPnlUsd)),
  },
  {
    key: "totalPnlUsd",
    header: "Total PnL",
    modes: ["traders"],
    value: (r) => r.totalPnlUsd,
    render: (r) => signed(r.totalPnlUsd, formatUsd(r.totalPnlUsd)),
  },
  {
    key: "profitMultiple",
    header: "Multiple",
    title: "Average sell price divided by average buy price",
    modes: ["traders"],
    value: (r) => r.profitMultiple,
    render: (r) =>
      r.profitMultiple == null ? (
        <span className="dim">—</span>
      ) : (
        <span className={r.profitMultiple >= 1 ? "up" : "down"}>
          {formatMultiple(r.profitMultiple)}
        </span>
      ),
  },
  {
    key: "realizedRoi",
    header: "ROI",
    modes: ["traders"],
    value: (r) => r.realizedRoi,
    render: (r) => signed(r.realizedRoi, formatRoi(r.realizedRoi)),
  },
  {
    key: "avgBuyMcap",
    header: "Entry MC",
    title: "Market cap at this wallet's average buy price",
    modes: ["traders"],
    value: (r) => r.avgBuyMcap,
    render: (r) => formatMcap(r.avgBuyMcap),
  },
  {
    key: "avgSellMcap",
    header: "Exit MC",
    title: "Market cap at this wallet's average sell price",
    modes: ["traders"],
    value: (r) => r.avgSellMcap,
    render: (r) => formatMcap(r.avgSellMcap),
  },
  {
    key: "avgBuyPrice",
    header: "Avg buy",
    modes: ["traders"],
    value: (r) => r.avgBuyPrice,
    render: (r) => formatPrice(r.avgBuyPrice),
  },
  {
    key: "avgSellPrice",
    header: "Avg sell",
    modes: ["traders"],
    value: (r) => r.avgSellPrice,
    render: (r) => formatPrice(r.avgSellPrice),
  },
  {
    key: "usdSpent",
    header: "Bought",
    modes: ["traders"],
    value: (r) => r.usdSpent,
    render: (r) => formatUsd(r.usdSpent),
  },
  {
    key: "usdReceived",
    header: "Sold",
    modes: ["traders"],
    value: (r) => r.usdReceived,
    render: (r) => formatUsd(r.usdReceived),
  },
  {
    key: "nativeSpent",
    header: "Native in",
    modes: ["traders"],
    value: (r) => r.nativeSpent,
    render: (r, chain) => formatNative(r.nativeSpent, CHAINS[chain].nativeSymbol),
  },
  {
    key: "tokensHeld",
    header: "Net bag",
    title: "Tokens bought minus sold on DEXes over the window",
    modes: ["traders"],
    value: (r) => r.tokensHeld,
    render: (r) => formatTokens(r.tokensHeld),
  },
  {
    key: "tokensHeldNow",
    header: "Balance",
    modes: ["holders"],
    value: (r) => r.tokensHeld,
    render: (r) => formatTokens(r.tokensHeld),
  },
  {
    key: "valueUsd",
    header: "Value",
    modes: ["traders", "holders"],
    value: (r) => r.valueUsd,
    render: (r) => formatUsd(r.valueUsd),
  },
  {
    key: "pctSupplyHeld",
    header: "% supply",
    modes: ["traders", "holders"],
    value: (r) => r.pctSupplyHeld,
    render: (r) => formatPct(r.pctSupplyHeld, 3),
  },
  {
    key: "positionStatus",
    header: "Position",
    modes: ["traders"],
    value: (r) => r.positionStatus,
    render: (r) =>
      r.positionStatus ? (
        <span className="tag" data-status={r.positionStatus}>
          {r.positionStatus}
        </span>
      ) : (
        <span className="dim">—</span>
      ),
  },
  {
    key: "trades",
    header: "B / S",
    title: "Buy and sell fill counts",
    modes: ["traders"],
    value: (r) => (r.buyCount ?? 0) + (r.sellCount ?? 0),
    render: (r) => (
      <span className="dim">
        {formatCount(r.buyCount)} / {formatCount(r.sellCount)}
      </span>
    ),
  },
  {
    key: "holdHours",
    header: "Held",
    modes: ["traders"],
    value: (r) => r.holdHours,
    render: (r) => <span className="dim">{formatDuration(r.holdHours)}</span>,
  },
  {
    key: "lastTrade",
    header: "Last seen",
    modes: ["traders", "holders"],
    value: (r) => r.lastTrade ?? r.firstTrade,
    render: (r) => <span className="dim">{formatWhen(r.lastTrade)}</span>,
  },
];

interface Props {
  rows: WalletRow[];
  chain: ChainId;
  mode: Mode;
  selected: Set<string>;
  onToggle: (wallet: string) => void;
  onToggleAll: (wallets: string[], select: boolean) => void;
}

export default function ResultsTable({
  rows,
  chain,
  mode,
  selected,
  onToggle,
  onToggleAll,
}: Props) {
  const [sortKey, setSortKey] = useState("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [copied, setCopied] = useState<string | null>(null);

  const columns = useMemo(
    () =>
      COLUMNS.filter((c) => c.modes.includes(mode)).filter((c) =>
        rows.some((r) => c.value(r) != null),
      ),
    [mode, rows],
  );

  const sorted = useMemo(() => {
    const column = COLUMNS.find((c) => c.key === sortKey);
    const copy = [...rows];
    copy.sort((a, b) => {
      if (!column) return sortDir === "asc" ? a.rank - b.rank : b.rank - a.rank;
      const av = column.value(a);
      const bv = column.value(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function sortBy(key: string) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "rank" ? "asc" : "desc");
    }
  }

  async function copyAddress(wallet: string) {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(wallet);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard unavailable — the address is still visible and linked */
    }
  }

  const allWallets = rows.map((r) => r.wallet);
  const allSelected = allWallets.length > 0 && allWallets.every((w) => selected.has(w));
  const arrow = (key: string) => (sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "");

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th data-align="left" style={{ width: "2rem" }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => onToggleAll(allWallets, !allSelected)}
                aria-label="Select all"
              />
            </th>
            <th className="sortable" data-align="left" onClick={() => sortBy("rank")}>
              #{arrow("rank")}
            </th>
            <th data-align="left">Wallet</th>
            {columns.map((c) => (
              <th
                key={c.key}
                className="sortable"
                title={c.title}
                onClick={() => sortBy(c.key)}
              >
                {c.header}
                {arrow(c.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const isSelected = selected.has(row.wallet);
            return (
              <tr key={row.wallet} data-selected={isSelected}>
                <td data-align="left">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(row.wallet)}
                    aria-label={`Select ${row.wallet}`}
                  />
                </td>
                <td data-align="left">
                  <span className="rank-pill" data-top={row.rank <= 3}>
                    {row.rank}
                  </span>
                </td>
                <td data-align="left">
                  <span className="addr">
                    <a
                      href={CHAINS[chain].explorer(row.wallet)}
                      target="_blank"
                      rel="noreferrer"
                      title={row.wallet}
                    >
                      {shortAddress(row.wallet, 6, 6)}
                    </a>
                    <button
                      className="copy"
                      onClick={() => copyAddress(row.wallet)}
                      title="Copy address"
                      aria-label="Copy address"
                    >
                      {copied === row.wallet ? "✓" : "⧉"}
                    </button>
                  </span>
                </td>
                {columns.map((c) => (
                  <td key={c.key}>{c.render(row, chain)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
