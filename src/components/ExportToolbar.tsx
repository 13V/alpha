"use client";

import { useState } from "react";

import {
  AXIOM_DEFAULTS,
  axiomName,
  buildExport,
  downloadFile,
  exportFilename,
  type AxiomOptions,
  type ExportFormat,
  type NameBy,
} from "@/lib/export";
import type { ScanMeta, WalletRow } from "@/lib/types";

const NAME_BY: Array<{ id: NameBy; label: string }> = [
  { id: "multiple", label: "Multiple" },
  { id: "pnl", label: "PnL" },
  { id: "rank", label: "Rank" },
  { id: "address", label: "Address" },
];

interface Props {
  rows: WalletRow[];
  meta: ScanMeta;
  selectedCount: number;
  onClearSelection: () => void;
  /** Fetches the columns a trace does not read by default. Null if it cannot. */
  onFullRows?: () => Promise<WalletRow[] | null>;
}

export default function ExportToolbar({
  rows,
  meta,
  selectedCount,
  onClearSelection,
  onFullRows,
}: Props) {
  const [copied, setCopied] = useState<ExportFormat | null>(null);
  const [axiom, setAxiom] = useState<AxiomOptions>(AXIOM_DEFAULTS);

  const [widening, setWidening] = useState(false);

  /**
   * Rows for this export. The wallet exports need only what is already here;
   * a CSV needs the columns a trace does not pay to read, so those are fetched
   * once and matched back by wallet. If that fails the export still happens,
   * just without the columns it could not get.
   */
  async function rowsFor(format: ExportFormat): Promise<WalletRow[]> {
    if (format !== "csv" && format !== "json") return rows;
    if (!onFullRows) return rows;
    setWidening(true);
    try {
      const wide = await onFullRows();
      if (!wide) return rows;
      const byWallet = new Map(wide.map((r) => [r.wallet, r]));
      return rows.map((r) => ({ ...r, ...(byWallet.get(r.wallet) ?? {}) }));
    } finally {
      setWidening(false);
    }
  }

  async function copy(format: ExportFormat) {
    const content = buildExport(format, await rowsFor(format), meta, axiom);
    try {
      await navigator.clipboard.writeText(content);
      setCopied(format);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      downloadFile(exportFilename(format, meta), content, "text/plain");
    }
  }

  const preview = rows[0] ? axiomName(rows[0], meta, axiom.nameBy) : "";

  return (
    <div className="actions">
      <span className="count">
        <b>{rows.length}</b>
        {selectedCount > 0 ? " picked" : " wallets"}
      </span>

      <button
        className="chip"
        data-primary
        title="Tracked-wallet JSON — paste straight into Axiom's import"
        onClick={() => copy("axiom")}
      >
        {copied === "axiom" ? "copied ✓" : "Copy for Axiom"}
      </button>
      <button
        className="chip"
        title="One wallet per line — paste into Terminal, Photon or any tracker"
        onClick={() => copy("addresses")}
      >
        {copied === "addresses" ? "copied ✓" : "Terminal / Photon"}
      </button>
      <button
        className="chip"
        title="Every column, for your own spreadsheet"
        disabled={widening}
        onClick={() => copy("csv")}
      >
        {copied === "csv" ? "copied ✓" : widening ? "fetching…" : "CSV"}
      </button>
      <button
        className="chip"
        onClick={() =>
          downloadFile(
            exportFilename("axiom", meta),
            buildExport("axiom", rows, meta, axiom),
            "application/json",
          )
        }
      >
        Download
      </button>
      {selectedCount > 0 && (
        <button className="chip" onClick={onClearSelection}>
          Clear
        </button>
      )}

      <span className="bar-sep" />

      <span className="label">name by</span>
      <div className="seg">
        {NAME_BY.map((option) => (
          <button
            key={option.id}
            data-active={axiom.nameBy === option.id}
            onClick={() => setAxiom((prev) => ({ ...prev, nameBy: option.id }))}
          >
            {option.label}
          </button>
        ))}
      </div>
      <input
        className="mini-input"
        style={{ width: "5.5rem" }}
        value={axiom.group}
        onChange={(e) => setAxiom((prev) => ({ ...prev, group: e.target.value }))}
        placeholder="Group"
        aria-label="Axiom group"
      />
      <input
        className="mini-input"
        style={{ width: "2.6rem", textAlign: "center" }}
        value={axiom.emoji}
        onChange={(e) => setAxiom((prev) => ({ ...prev, emoji: e.target.value }))}
        maxLength={4}
        aria-label="Axiom emoji"
      />

      {preview && <span className="preview">{preview}</span>}
    </div>
  );
}
