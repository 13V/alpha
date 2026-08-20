const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

function subscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPTS[Number(d)])
    .join("");
}

function compact(n: number, digits = 2): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(digits)}K`;
  return n.toFixed(abs >= 1 ? digits : 4);
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${compact(Math.abs(value))}`;
}

export function formatMcap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return `$${compact(value, value >= 1e6 ? 1 : 2)}`;
}

/**
 * Memecoin prices have a lot of leading zeros — render $0.00000123 as $0.0₅123
 * the way the charting sites do.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "—";
  const abs = Math.abs(value);
  if (abs >= 0.01) return `$${abs.toFixed(4)}`;
  const exponent = Math.floor(Math.log10(abs));
  const leadingZeros = Math.abs(exponent) - 1;
  if (leadingZeros < 3) return `$${abs.toFixed(8)}`;
  const digits = abs
    .toExponential(3)
    .split("e")[0]
    .replace(".", "")
    .slice(0, 4);
  return `$0.0${subscript(leadingZeros)}${digits}`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return compact(value, 2);
}

export function formatNative(value: number | null | undefined, symbol: string): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "—";
  return `${compact(value, value >= 1000 ? 1 : 2)} ${symbol}`;
}

export function formatMultiple(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(2)}x`;
}

export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatRoi(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(0)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

export function formatDuration(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return "—";
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)}d`;
  return `${(days / 30).toFixed(1)}mo`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(t.getTime())) return "—";
  return t.toISOString().slice(0, 16).replace("T", " ");
}

export function shortAddress(address: string, head = 4, tail = 4): string {
  if (!address) return "";
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
