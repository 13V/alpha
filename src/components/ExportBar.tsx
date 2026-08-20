"use client";

import { useState } from "react";

import {
  EXPORT_FORMATS,
  buildExport,
  downloadFile,
  exportFilename,
  type ExportFormat,
} from "@/lib/export";
import type { ScanMeta, WalletRow } from "@/lib/types";

interface Props {
  rows: WalletRow[];
  meta: ScanMeta;
  selectedCount: number;
  onClearSelection: () => void;
}

export default function ExportBar({ rows, meta, selectedCount, onClearSelection }: Props) {
  const [copied, setCopied] = useState<ExportFormat | null>(null);

  async function copy(format: ExportFormat) {
    const content = buildExport(format, rows, meta);
    try {
      await navigator.clipboard.writeText(content);
      setCopied(format);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // clipboard blocked (insecure origin / permissions) — fall back to a file
      const spec = EXPORT_FORMATS.find((f) => f.id === format);
      downloadFile(exportFilename(format, meta), content, spec?.mime ?? "text/plain");
    }
  }

  function save(format: ExportFormat) {
    const spec = EXPORT_FORMATS.find((f) => f.id === format);
    downloadFile(
      exportFilename(format, meta),
      buildExport(format, rows, meta),
      spec?.mime ?? "text/plain",
    );
  }

  return (
    <div className="export-bar">
      <span className="export-count">
        <b>{rows.length}</b> wallet{rows.length === 1 ? "" : "s"}
        {selectedCount > 0 ? " selected" : " (all)"}
      </span>

      <div className="export-actions">
        {EXPORT_FORMATS.map((format) => (
          <button
            key={format.id}
            className="ghost-button"
            title={format.description}
            onClick={() => copy(format.id)}
          >
            {copied === format.id ? "copied ✓" : format.label}
          </button>
        ))}
        <button
          className="ghost-button"
          title="Download the full CSV"
          onClick={() => save("csv")}
        >
          ↓ file
        </button>
        {selectedCount > 0 && (
          <button className="ghost-button" onClick={onClearSelection}>
            clear
          </button>
        )}
      </div>
    </div>
  );
}
