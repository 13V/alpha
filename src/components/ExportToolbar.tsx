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
}

export default function ExportToolbar({
  rows,
  meta,
  selectedCount,
  onClearSelection,
}: Props) {
  const [copied, setCopied] = useState<ExportFormat | null>(null);
  const [axiom, setAxiom] = useState<AxiomOptions>(AXIOM_DEFAULTS);

  async function copy(format: ExportFormat) {
    const content = buildExport(format, rows, meta, axiom);
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
        {selectedCount > 0 ? " selected" : " wallets"}
      </span>

      <button className="chip" data-primary onClick={() => copy("axiom")}>
        {copied === "axiom" ? "Copied" : "Copy for Axiom"}
      </button>
      <button className="chip" onClick={() => copy("addresses")}>
        {copied === "addresses" ? "Copied" : "Addresses"}
      </button>
      <button className="chip" onClick={() => copy("csv")}>
        {copied === "csv" ? "Copied" : "CSV"}
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

      <span className="label">Name by</span>
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
