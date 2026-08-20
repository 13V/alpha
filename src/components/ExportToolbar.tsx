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

export default function ExportToolbar({
  rows,
  meta,
  selectedCount,
  onClearSelection,
}: Props) {
  const [copied, setCopied] = useState<ExportFormat | null>(null);

  async function copy(format: ExportFormat) {
    const content = buildExport(format, rows, meta);
    const spec = EXPORT_FORMATS.find((f) => f.id === format);
    try {
      await navigator.clipboard.writeText(content);
      setCopied(format);
      setTimeout(() => setCopied(null), 1500);
    } catch {
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
    <div className="toolbar">
      <span className="toolbar-count">
        exporting <b>{rows.length}</b>
        {selectedCount > 0 ? ` selected` : ` (whole list)`}
      </span>

      {EXPORT_FORMATS.map((format) => (
        <button
          key={format.id}
          className="chip"
          title={`Copy — ${format.description}`}
          onClick={() => copy(format.id)}
        >
          {copied === format.id ? "copied ✓" : format.label}
        </button>
      ))}

      <button className="chip" data-primary onClick={() => save("csv")} title="Download CSV">
        ↓ CSV
      </button>

      {selectedCount > 0 && (
        <button className="chip" onClick={onClearSelection}>
          clear
        </button>
      )}
    </div>
  );
}
