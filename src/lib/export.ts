import { formatMultiple, shortAddress } from "./format";
import type { ScanMeta, WalletRow } from "./types";

export type ExportFormat =
  | "axiom"
  | "addresses"
  | "comma"
  | "csv"
  | "json"
  | "watchlist";

/** How each tracked wallet gets labelled in the Axiom payload. */
export type NameBy = "multiple" | "pnl" | "rank" | "address";

export interface AxiomOptions {
  nameBy: NameBy;
  group: string;
  emoji: string;
  alertsOnToast: boolean;
  alertsOnBubble: boolean;
  alertsOnFeed: boolean;
  sound: string;
}

export const AXIOM_DEFAULTS: AxiomOptions = {
  nameBy: "multiple",
  group: "Main",
  emoji: "🎯",
  alertsOnToast: false,
  alertsOnBubble: true,
  alertsOnFeed: true,
  sound: "default",
};

export const EXPORT_FORMATS: Array<{
  id: ExportFormat;
  label: string;
  description: string;
  extension: string;
  mime: string;
}> = [
  {
    id: "axiom",
    label: "Axiom",
    description: "Tracked-wallet JSON — paste straight into Axiom's import",
    extension: "json",
    mime: "application/json",
  },
  {
    id: "addresses",
    label: "Address list",
    description: "One wallet per line — what most trackers want pasted in",
    extension: "txt",
    mime: "text/plain",
  },
  {
    id: "comma",
    label: "Comma separated",
    description: "Single line, for Telegram bots that take a bulk /track",
    extension: "txt",
    mime: "text/plain",
  },
  {
    id: "watchlist",
    label: "Watchlist CSV",
    description: "address,label — importable into Cielo-style trackers",
    extension: "csv",
    mime: "text/csv",
  },
  {
    id: "csv",
    label: "Full CSV",
    description: "Every column, for your own spreadsheet",
    extension: "csv",
    mime: "text/csv",
  },
  {
    id: "json",
    label: "JSON",
    description: "Raw rows plus the scan metadata",
    extension: "json",
    mime: "application/json",
  },
];

const CSV_COLUMNS: Array<[keyof WalletRow, string]> = [
  ["rank", "rank"],
  ["wallet", "wallet"],
  ["realizedPnlUsd", "realized_pnl_usd"],
  ["unrealizedPnlUsd", "unrealized_pnl_usd"],
  ["totalPnlUsd", "total_pnl_usd"],
  ["profitMultiple", "profit_multiple"],
  ["realizedRoi", "realized_roi"],
  ["avgBuyPrice", "avg_buy_price"],
  ["avgSellPrice", "avg_sell_price"],
  ["avgBuyMcap", "avg_buy_mcap"],
  ["avgSellMcap", "avg_sell_mcap"],
  ["usdSpent", "usd_spent"],
  ["usdReceived", "usd_received"],
  ["nativeSpent", "native_spent"],
  ["nativeReceived", "native_received"],
  ["tokensBought", "tokens_bought"],
  ["tokensSold", "tokens_sold"],
  ["tokensHeld", "tokens_held"],
  ["pctSupplyHeld", "pct_supply_held"],
  ["valueUsd", "value_usd"],
  ["positionStatus", "position_status"],
  ["costBasis", "cost_basis"],
  ["buyCoverage", "buy_coverage"],
  ["tokensReceived", "tokens_received"],
  ["receivedValueUsd", "received_value_usd"],
  ["buyCount", "buy_count"],
  ["sellCount", "sell_count"],
  ["firstTrade", "first_trade"],
  ["lastTrade", "last_trade"],
  ["holdHours", "hold_hours"],
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function labelFor(row: WalletRow, meta: ScanMeta): string {
  const tag = meta.tokenSymbol ?? meta.token.slice(0, 6);
  return `bt_${tag}_${String(row.rank).padStart(3, "0")}`;
}

/** Ticker used in wallet names — "14.10x - KIMCHI". */
export function tokenTag(meta: ScanMeta): string {
  return (meta.tokenSymbol ?? meta.token.slice(0, 6)).toUpperCase();
}

/** $1,283,400 -> "$1.28M", 892300 -> "$892.3K" — trailing zeros trimmed. */
function compactUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "$0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const [scaled, suffix] =
    abs >= 1e9 ? [abs / 1e9, "B"]
    : abs >= 1e6 ? [abs / 1e6, "M"]
    : abs >= 1e3 ? [abs / 1e3, "K"]
    : [abs, ""];
  const text = scaled.toFixed(2).replace(/\.?0+$/, "");
  return `${sign}$${text}${suffix}`;
}

export function axiomName(row: WalletRow, meta: ScanMeta, nameBy: NameBy): string {
  const tag = tokenTag(meta);
  switch (nameBy) {
    case "multiple":
      // holders mode has no multiple; fall back rather than emit "— - TAG"
      return row.profitMultiple != null
        ? `${formatMultiple(row.profitMultiple)} - ${tag}`
        : `#${row.rank} - ${tag}`;
    case "pnl":
      return row.realizedPnlUsd != null
        ? `${compactUsd(row.realizedPnlUsd)} - ${tag}`
        : `#${row.rank} - ${tag}`;
    case "rank":
      return `#${row.rank} - ${tag}`;
    case "address":
      return `${shortAddress(row.wallet, 4, 4)} - ${tag}`;
  }
}

export function buildAxiom(
  rows: WalletRow[],
  meta: ScanMeta,
  options: AxiomOptions,
): string {
  const groups = options.group.trim() ? [options.group.trim()] : [];
  return JSON.stringify(
    rows.map((row) => ({
      trackedWalletAddress: row.wallet,
      name: axiomName(row, meta, options.nameBy),
      emoji: options.emoji,
      alertsOnToast: options.alertsOnToast,
      alertsOnBubble: options.alertsOnBubble,
      alertsOnFeed: options.alertsOnFeed,
      groups,
      sound: options.sound,
    })),
    null,
    2,
  );
}

export function buildExport(
  format: ExportFormat,
  rows: WalletRow[],
  meta: ScanMeta,
  axiom: AxiomOptions = AXIOM_DEFAULTS,
): string {
  switch (format) {
    case "axiom":
      return buildAxiom(rows, meta, axiom);

    case "addresses":
      return rows.map((r) => r.wallet).join("\n");

    case "comma":
      return rows.map((r) => r.wallet).join(",");

    case "watchlist":
      return [
        "address,label",
        ...rows.map((r) => `${csvCell(r.wallet)},${csvCell(labelFor(r, meta))}`),
      ].join("\n");

    case "csv": {
      const present = CSV_COLUMNS.filter(([key]) =>
        rows.some((r) => r[key] !== null && r[key] !== undefined),
      );
      return [
        present.map(([, header]) => header).join(","),
        ...rows.map((r) => present.map(([key]) => csvCell(r[key])).join(",")),
      ].join("\n");
    }

    case "json":
      return JSON.stringify({ meta, rows }, null, 2);
  }
}

export function exportFilename(format: ExportFormat, meta: ScanMeta): string {
  const spec = EXPORT_FORMATS.find((f) => f.id === format);
  const tag = (meta.tokenSymbol ?? meta.token.slice(0, 10)).toLowerCase();
  if (format === "axiom") return `highpnl-${tag}.json`;
  return `bagtrace-${meta.chain}-${meta.mode}-${tag}.${spec?.extension ?? "txt"}`;
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
