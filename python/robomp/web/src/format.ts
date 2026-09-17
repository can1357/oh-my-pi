// Compact, allocation-light formatters. All return `"—"` for empty / invalid
// inputs so the templates can stay terse.

const DASH = "—";

export function fmtDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function fmtAge(iso?: string | null): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${fmtDuration((Date.now() - t) / 1000)} ago`;
}

export function shortText(value: unknown, limit = 180): string {
  const text = value == null ? "" : typeof value === "string" ? value : String(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export interface IssueRef {
  repo: string;
  number: string;
}

export function splitIssueKey(key: string | null | undefined): IssueRef {
  const k = key ?? "";
  const idx = k.lastIndexOf("#");
  if (idx === -1) return { repo: k, number: "" };
  return { repo: k.slice(0, idx), number: k.slice(idx + 1) };
}

export function issueUrl(repo: string, number: number | string): string {
  return `https://github.com/${repo}/issues/${number}`;
}

export function prUrl(repo: string, prNumber: number | string): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

export function shortDelivery(id: string | null | undefined): string {
  if (!id) return DASH;
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function fmtTimestamp(iso?: string | null): string {
  if (!iso) return "";
  // Drop the `T` separator and trailing `Z` so the log table looks like a
  // single calm timestamp instead of an RFC-3339 dump.
  return iso.replace("T", " ").replace("Z", "");
}
