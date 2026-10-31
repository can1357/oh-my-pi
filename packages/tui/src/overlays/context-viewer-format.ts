/**
 * Display text for context entries. Each header has an ANSI-string form (`render`)
 * and a span form (`describe`); keep the twins visually identical.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { CONTEXT_PRESENTATION } from "../chrome/context-presentation";
import type { ContextCategoryId, ContextThinkingGroup, ContextViewEntry } from "../chrome/context-view-model";
import { editorKey } from "../chrome/keybinding-hints";
import { span } from "../native/describe";
import { PREVIEW_LIMITS, replaceTabs, shortenEmbeddedPaths, shortenPath } from "../render/render-utils";
import { theme } from "../theme/theme";
import { wrapTextWithAnsi } from "../utils";

const TIMESTAMP_FORMAT = {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
} as const;

/** Normalized newlines, control characters removed, tabs expanded. */
export function safeContent(value: string): string {
	return replaceTabs(sanitizeText(value.replace(/\r\n?/g, "\n")));
}

/** {@link safeContent} with embedded home paths shortened, for labels and metadata. */
export function safeText(value: string): string {
	return shortenEmbeddedPaths(safeContent(value));
}

/** {@link safeText} collapsed to one row. */
export function safeLine(value: string): string {
	return safeText(value).replace(/\n/g, " ");
}

/** Token label of an entry or group: `—` for a grouped entry, `N/A · Interrupted`, else `N token(s)` (unscaled estimate). */
export function tokenEstimate(item: ContextViewEntry | ContextThinkingGroup): string {
	// A grouped entry shares its group's estimate, which the group heading shows.
	if ("thinkingGroup" in item && item.thinkingGroup) return "—";
	if (item.interrupted) return "N/A · Interrupted";
	return `${item.tokens.toLocaleString("en-US")} ${item.tokens === 1 ? "token" : "tokens"}`;
}

/** `[label] N tokens` as ANSI. */
export function entryHeaderLine(entry: ContextViewEntry, category: ContextCategoryId): string {
	const color = CONTEXT_PRESENTATION[category].color;
	return (
		theme.fg("dim", "[") +
		theme.fg(color, theme.bold(safeLine(entry.label))) +
		theme.fg("dim", `] ${tokenEstimate(entry)}`)
	);
}

/** `[label] N tokens` as spans. */
export function entryHeaderSpans(entry: ContextViewEntry, category: ContextCategoryId): TspSpan[] {
	const color = CONTEXT_PRESENTATION[category].color;
	return [span("[", "dim"), span(safeLine(entry.label), `${color} strong`), span(`] ${tokenEstimate(entry)}`, "dim")];
}

/** Heading for a shared thinking group: label plus its token estimate. */
export function groupHeaderLine(group: ContextThinkingGroup, category: ContextCategoryId): string {
	const color = CONTEXT_PRESENTATION[category].color;
	return theme.fg(color, theme.bold(safeLine(group.label))) + theme.fg("dim", ` · ${tokenEstimate(group)}`);
}

/** Truncation marker under a preview; the selected preview also advertises the open key. */
export function previewHint(selected: boolean): string {
	const confirm = selected ? editorKey("tui.select.confirm") : "";
	return (
		theme.fg("dim", "  … more") +
		(confirm ? theme.fg("dim", " · ") + theme.fg("accent", `${confirm} View Content`) : "")
	);
}

/**
 * Metadata rows: info and path, call id, timestamp. The full-content view also
 * lists the thinking group, which previews show as a shared heading instead.
 */
export function entryMetadata(
	entry: ContextViewEntry,
	options: { hour12: boolean | undefined; withGroup: boolean },
): string[] {
	const lines: string[] = [];
	const group = entry.thinkingGroup;
	if (group && options.withGroup) lines.push(`${safeLine(group.label)} · ${tokenEstimate(group)}`);
	const info = safeText([entry.info, entry.path ? shortenPath(entry.path) : undefined].filter(Boolean).join(" · "));
	if (info) lines.push(info);
	const callId = entry.callId !== undefined ? safeText(entry.callId) : "";
	if (callId) lines.push(callId);
	if (entry.timestamp !== undefined)
		lines.push(new Date(entry.timestamp).toLocaleString([], { ...TIMESTAMP_FORMAT, hour12: options.hour12 }));
	return lines;
}

/** Preview row budget for a list of `height` rows: room for the entry heading, hint, and group heading. */
export function previewRows(entry: ContextViewEntry, height: number): number {
	const reserved = entry.thinkingGroup ? 3 : 2;
	return Math.max(1, Math.min(PREVIEW_LIMITS.OUTPUT_EXPANDED, height - reserved));
}

export interface EntryPreviewOptions {
	/** Wrap width of preview rows. */
	readonly width: number;
	/** Maximum preview rows. */
	readonly rows: number;
	/** Viewport width; bounds the source read to `sourceWidth × rows × 2` characters before sanitizing and wrapping. */
	readonly sourceWidth: number;
	readonly hour12: boolean | undefined;
}

/** Dim metadata rows, then the indented body, cut to `rows`; `complete` is false when anything was omitted. */
export function entryPreview(
	entry: ContextViewEntry,
	options: EntryPreviewOptions,
): { lines: string[]; complete: boolean } {
	const { width, rows } = options;
	const maxChars = Math.max(1, options.sourceWidth) * rows * 2;
	const metadata = entryMetadata(entry, { hour12: options.hour12, withGroup: false }).join("\n");
	const metadataLength = Math.min(metadata.length, maxChars);
	// Providers often end thinking and tool output with newlines; they render as empty rows.
	const body = entry.text.trimEnd();
	const bodyLength = Math.min(body.length, Math.max(0, maxChars - metadataLength - (metadataLength ? 1 : 0)));
	const parts = [
		{
			value: safeContent(metadata.slice(0, metadataLength)),
			prefix: "",
			style: (line: string) => theme.fg("dim", line),
		},
		{ value: safeContent(body.slice(0, bodyLength)), prefix: "  ", style: (line: string) => line },
	];
	const lines: string[] = [];
	for (const { value, prefix, style } of parts) {
		if (!value) continue;
		for (const paragraph of value.split("\n")) {
			const remaining = rows - lines.length;
			if (remaining === 0) return { lines, complete: false };
			const wrapped = paragraph ? wrapTextWithAnsi(style(paragraph), Math.max(1, width - prefix.length)) : [""];
			lines.push(...wrapped.slice(0, remaining).map(line => `${prefix}${line}`));
			if (wrapped.length > remaining) return { lines, complete: false };
		}
	}
	return { lines, complete: metadataLength === metadata.length && bodyLength === body.length };
}
