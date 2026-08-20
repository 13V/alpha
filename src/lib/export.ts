import type { ScanMeta, WalletRow } from "./types";

export type ExportFormat = "addresses" | "comma" | "csv" | "json" | "watchlist";

export const EXPORT_FORMATS: Array<{
  id: ExportFormat;
  label: string;
  description: string;
  extension: string;
  mime: string;
}> = [
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

export function buildExport(
  format: ExportFormat,
  rows: WalletRow[],
  meta: ScanMeta,
): string {
  switch (format) {
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
  const token = meta.token.slice(0, 10);
  return `bagtrace-${meta.chain}-${meta.mode}-${token}.${spec?.extension ?? "txt"}`;
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
