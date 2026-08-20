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
  align?: "left";
  modes: Mode[];
  value: (row: WalletRow) => number | string | null;
  render: (row: WalletRow, chain: ChainId) => ReactNode;
}

function signed(value: number | null, text: string): ReactNode {
  if (value == null) return <span className="muted">—</span>;
  return <span className={value >= 0 ? "pos" : "neg"}>{text}</span>;
}

const COLUMNS: Column[] = [
  {
    key: "realizedPnlUsd",
    header: "Realized PnL",
    modes: ["traders"],
    value: (r) => r.realizedPnlUsd,
    render: (r) => signed(r.realizedPnlUsd, formatUsd(r.realizedPnlUsd)),
  },
  {
    key: "unrealizedPnlUsd",
    header: "Unrealized",
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
    modes: ["traders"],
    value: (r) => r.profitMultiple,
    render: (r) =>
      r.profitMultiple == null ? (
        <span className="muted">—</span>
      ) : (
        <span className={r.profitMultiple >= 1 ? "pos" : "neg"}>
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
    header: "Avg buy MC",
    modes: ["traders"],
    value: (r) => r.avgBuyMcap,
    render: (r) => formatMcap(r.avgBuyMcap),
  },
  {
    key: "avgSellMcap",
    header: "Avg sell MC",
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
    header: "Spent",
    modes: ["traders"],
    value: (r) => r.usdSpent,
    render: (r) => formatUsd(r.usdSpent),
  },
  {
    key: "usdReceived",
    header: "Received",
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
    header: "Still holding",
    modes: ["traders"],
    value: (r) => r.tokensHeld,
    render: (r) => formatTokens(r.tokensHeld),
  },
  {
    key: "tokensHeld",
    header: "Balance",
    modes: ["holders"],
    value: (r) => r.tokensHeld,
    render: (r) => formatTokens(r.tokensHeld),
  },
  {
    key: "valueUsd",
    header: "Value",
    modes: ["holders"],
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
    key: "solBalance",
    header: "SOL bal",
    modes: ["holders"],
    value: (r) => r.solBalance,
    render: (r) => (r.solBalance == null ? <span className="muted">—</span> : r.solBalance.toFixed(2)),
  },
  {
    key: "positionStatus",
    header: "Status",
    modes: ["traders"],
    value: (r) => r.positionStatus,
    render: (r) =>
      r.positionStatus ? (
        <span className="badge" data-status={r.positionStatus}>
          {r.positionStatus}
        </span>
      ) : (
        <span className="muted">—</span>
      ),
  },
  {
    key: "trades",
    header: "B / S",
    modes: ["traders"],
    value: (r) => (r.buyCount ?? 0) + (r.sellCount ?? 0),
    render: (r) => (
      <span className="muted">
        {formatCount(r.buyCount)} / {formatCount(r.sellCount)}
      </span>
    ),
  },
  {
    key: "holdHours",
    header: "Held for",
    modes: ["traders"],
    value: (r) => r.holdHours,
    render: (r) => <span className="muted">{formatDuration(r.holdHours)}</span>,
  },
  {
    key: "lastTrade",
    header: "Last seen",
    modes: ["traders", "holders"],
    value: (r) => r.lastTrade ?? r.firstTrade,
    render: (r) => <span className="muted">{formatWhen(r.lastTrade)}</span>,
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

export default function WalletTable({
  rows,
  chain,
  mode,
  selected,
  onToggle,
  onToggleAll,
}: Props) {
  const [sortKey, setSortKey] = useState<string>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const columns = useMemo(() => {
    const active = COLUMNS.filter((c) => c.modes.includes(mode));
    // hide columns that are entirely empty for this result set
    return active.filter((c) => rows.some((r) => c.value(r) != null));
  }, [mode, rows]);

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
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "rank" ? "asc" : "desc");
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
                aria-label="Select all wallets"
              />
            </th>
            <th
              className="sortable"
              data-align="left"
              onClick={() => sortBy("rank")}
              title="Sort by rank"
            >
              #{arrow("rank")}
            </th>
            <th data-align="left">Wallet</th>
            {columns.map((c) => (
              <th
                key={c.key}
                className="sortable"
                data-align={c.align}
                onClick={() => sortBy(c.key)}
                title={`Sort by ${c.header}`}
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
                <td className="rank-cell" data-align="left">
                  {row.rank}
                </td>
                <td data-align="left">
                  <a
                    className="wallet-link"
                    href={CHAINS[chain].explorer(row.wallet)}
                    target="_blank"
                    rel="noreferrer"
                    title={row.wallet}
                  >
                    {shortAddress(row.wallet, 6, 6)}
                  </a>
                </td>
                {columns.map((c) => (
                  <td key={c.key} data-align={c.align}>
                    {c.render(row, chain)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
