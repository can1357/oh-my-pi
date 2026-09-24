import type { Theme } from "../theme/theme";
import { formatBytes, wrapBrackets } from "../render/render-utils";
import type { OutputArtifactError } from "./streaming-output";
import { formatGroupedFiles } from "./grouped-file-output";

/**
 * Truncation metadata for the output notice.
 */
export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	/** Line range shown (1-indexed, inclusive). Omitted for middle elision. */
	shownRange?: { start: number; end: number };
	/** Head/tail line ranges shown when direction === "middle". */
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	/** Bytes elided from the middle. */
	elidedBytes?: number;
	/** Lines elided from the middle. */
	elidedLines?: number;
	/** Artifact ID if full output was saved */
	artifactId?: string;
	/** Next offset for pagination (head truncation only) */
	nextOffset?: number;
	/**
	 * The single shown line is a byte-capped preview of one oversized line, not
	 * a complete line. `outputBytes`/`totalBytes` are the preview vs full line
	 * size; renders a distinct "partial" notice instead of a line range.
	 */
	partialLine?: boolean;
}

/**
 * Source resolution info for the output.
 */
export type SourceMeta =
	| { type: "path"; value: string }
	| { type: "url"; value: string }
	| { type: "internal"; value: string }
	/** A complete aggregate report, whose entries may contain incomplete source captures. */
	| { type: "report"; value: string };

/**
 * LSP diagnostic info (for edit/write tools).
 */
export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}

/**
 * Limit-specific notices.
 */
export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	resultLimit?: { reached: number; suggestion: number };
	headLimit?: { reached: number; suggestion: number };
	/** `unit` may be absent in sessions persisted before it was recorded. */
	columnTruncated?: { maxColumn: number; unit?: "bytes" | "chars"; artifactId?: string };
}

/**
 * Structured metadata for tool outputs.
 */
export interface OutputMeta {
	truncation?: TruncationMeta;
	/** Capture failure of this output itself; aggregate reports keep source failures on their entries. */
	artifactError?: OutputArtifactError;
	source?: SourceMeta;
	/** The output is a bounded page of a file its `source` re-reads with line selectors; spill-to-artifact skips it. */
	pagedSource?: true;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
}

// Regex: split on the first `:digits:digits` boundary to separate path from the rest
const DIAG_PATH_RE = /^(.+?):(\d+:\d+\s+.*)$/;

/**
 * Reformat pre-formatted diagnostic messages into a multi-level, prefix-folded
 * directory/file grouping (see `formatGroupedFiles`).
 * Input:  ["path:line:col [sev] msg", ...]
 * Output: "# pkg/src/\n## file.ts\n  line:col [sev] msg"
 *
 * Messages that don't match the expected format are appended ungrouped at the end.
 */
export function formatGroupedDiagnosticMessages(messages: string[]): string {
	const diagnosticsByFile = new Map<string, string[]>();
	const fileOrder: string[] = [];
	const ungrouped: string[] = [];

	for (const msg of messages) {
		const match = DIAG_PATH_RE.exec(msg);
		if (!match) {
			ungrouped.push(msg);
			continue;
		}

		const [, rawFilePath, rest] = match;
		const filePath = rawFilePath.replace(/\\/g, "/");
		if (!diagnosticsByFile.has(filePath)) {
			diagnosticsByFile.set(filePath, []);
			fileOrder.push(filePath);
		}
		diagnosticsByFile.get(filePath)?.push(rest);
	}

	if (diagnosticsByFile.size === 0) {
		return ungrouped.join("\n");
	}

	const grouped = formatGroupedFiles(fileOrder, filePath => ({
		modelLines: (diagnosticsByFile.get(filePath) ?? []).map(diagnostic => `  ${diagnostic}`),
	}));
	const lines: string[] = grouped.model;

	if (ungrouped.length > 0) {
		lines.push("");
		for (const msg of ungrouped) {
			lines.push(msg);
		}
	}

	return lines.join("\n");
}

/** Format a recoverable output artifact link. */
export function formatFullOutputReference(artifactId: string): string {
	return `Read artifact://${artifactId} for full output`;
}

/** Strip the last literal notice or a matching final line; optionally preserve surrounding whitespace. */
export function stripTrailingNotice(
	text: string,
	notice: string | ((line: string) => boolean),
	trimResult = true,
): string {
	let start: number;
	let end: number;
	if (typeof notice === "string") {
		start = text.lastIndexOf(notice);
		if (start === -1) return text;
		end = start + notice.length;
	} else {
		const trimmed = text.trimEnd();
		start = trimmed.lastIndexOf("\n") + 1;
		if (!notice(trimmed.slice(start))) return text;
		end = text.length;
	}
	if (trimResult && text[start - 1] === "\n") start -= 1;
	if (trimResult && text[end] === "\n") end += 1;
	const stripped = text.slice(0, start) + text.slice(end);
	return trimResult ? stripped.trimEnd() : stripped;
}

const RAW_OUTPUT_ARTIFACT_PREFIX = "[raw output: artifact://";
const RAW_OUTPUT_ARTIFACT_SUFFIX = "]";

/** Remove the trailing bash raw-output artifact footer while preserving its artifact id. */
export function stripRawOutputArtifactNotice(text: string): { text: string; artifactId?: string } {
	let artifactId: string | undefined;
	const stripped = stripTrailingNotice(text, line => {
		if (!line.startsWith(RAW_OUTPUT_ARTIFACT_PREFIX) || !line.endsWith(RAW_OUTPUT_ARTIFACT_SUFFIX)) {
			return false;
		}
		const idStart = RAW_OUTPUT_ARTIFACT_PREFIX.length;
		const idEnd = line.length - RAW_OUTPUT_ARTIFACT_SUFFIX.length;
		if (idStart === idEnd) return false;
		for (let i = idStart; i < idEnd; i++) {
			const code = line.charCodeAt(i);
			if (code < 48 || code > 57) return false;
		}
		artifactId = line.slice(idStart, idEnd);
		return true;
	});
	return artifactId === undefined ? { text } : { text: stripped, artifactId };
}

function isGeneratedOutputNoticeLine(line: string): boolean {
	if (!line.startsWith("[") || !line.endsWith("]")) return false;
	const body = line.slice(1, -1);
	return (
		body.startsWith("Showing ") ||
		/^\d+ matches limit reached\. Use limit=\d+ for more/u.test(body) ||
		/^\d+ results limit reached\. Use limit=\d+ for more/u.test(body) ||
		body.startsWith("Some lines truncated to ")
	);
}

/** Remove a trailing generated output notice when metadata is unavailable. */
export function stripGeneratedOutputNotice(text: string): string {
	return stripTrailingNotice(text, isGeneratedOutputNoticeLine);
}

/** Format truncation ranges and recovery hints. */
export function formatTruncationMetaNotice(truncation: TruncationMeta, source?: SourceMeta): string {
	let notice: string;
	const artifactReference =
		truncation.artifactId == null
			? undefined
			: source?.type === "report"
				? `Read artifact://${truncation.artifactId} for full report (${source.value})`
				: formatFullOutputReference(truncation.artifactId);

	if (truncation.direction === "middle") {
		const head = truncation.headRange;
		const tail = truncation.tailRange;
		const totalLines = truncation.totalLines;
		const elidedBytes = truncation.elidedBytes ?? Math.max(0, truncation.totalBytes - truncation.outputBytes);
		const elidedLines = truncation.elidedLines ?? Math.max(0, totalLines - truncation.outputLines);
		const headPart = head ? `lines ${head.start}-${head.end}` : "";
		const tailPart = tail ? `${tail.start}-${tail.end}` : "";
		if (headPart && tailPart) {
			notice = `Showing ${headPart} and ${tailPart} of ${totalLines}; ${elidedLines.toLocaleString()} middle line${elidedLines === 1 ? "" : "s"} (${formatBytes(elidedBytes)}) elided`;
		} else if (elidedBytes > 0) {
			notice = `Showing head and tail bytes of ${totalLines.toLocaleString()} line${totalLines === 1 ? "" : "s"}; ${formatBytes(elidedBytes)} elided`;
		} else {
			notice = `Showing ${Math.min(truncation.outputLines, totalLines)} of ${totalLines} lines; middle elided`;
		}
		if (truncation.nextOffset != null) {
			notice += `. Use :${truncation.nextOffset} to continue`;
		}
		if (artifactReference) {
			notice += `. ${artifactReference}`;
		}
		return notice;
	}

	if (truncation.partialLine) {
		const line = truncation.shownRange?.start ?? 1;
		notice = `Showing line ${line} (partial, ${formatBytes(truncation.outputBytes)} of ${formatBytes(truncation.totalBytes)}) of ${truncation.totalLines}`;
		if (artifactReference) {
			notice += `. ${artifactReference}`;
		}
		return notice;
	}

	const range = truncation.shownRange;
	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${truncation.totalLines}`;
	} else {
		notice = `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	}

	if (truncation.truncatedBy === "bytes") {
		const maxBytes = truncation.maxBytes ?? truncation.outputBytes;
		notice += ` (${formatBytes(maxBytes)} limit)`;
	}

	if (truncation.nextOffset != null) {
		notice += `. Use :${truncation.nextOffset} to continue`;
	}

	if (artifactReference) {
		notice += `. ${artifactReference}`;
	}

	return notice;
}

/**
 * Format styled artifact reference with warning color and brackets.
 * For TUI rendering of truncation warnings.
 */
export function formatStyledArtifactReference(artifactId: string, theme: Theme): string {
	return theme.fg("warning", formatFullOutputReference(artifactId));
}

/** Describe an incomplete artifact capture. */
export function formatArtifactErrorNotice(error: OutputArtifactError): string {
	return `Full output was not saved completely (artifact ${error} failed)`;
}

/**
 * Format notices from OutputMeta for LLM consumption.
 * Returns empty string if no notices needed.
 */
export function formatOutputNotice(meta: OutputMeta | undefined): string {
	if (!meta) return "";

	const parts: string[] = [];

	// Truncation notice
	if (meta.truncation) {
		parts.push(formatTruncationMetaNotice(meta.truncation, meta.source));
	}
	if (meta.artifactError) {
		parts.push(formatArtifactErrorNotice(meta.artifactError));
	}

	// Limit notices
	if (meta.limits?.matchLimit) {
		const l = meta.limits.matchLimit;
		parts.push(`${l.reached} matches limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.resultLimit) {
		const l = meta.limits.resultLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.headLimit) {
		const l = meta.limits.headLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.columnTruncated) {
		const c = meta.limits.columnTruncated;
		// Sessions persisted before the unit field carry only `maxColumn`; those
		// notices always read "chars", so default missing units to it. Otherwise
		// a resumed legacy session renders "… 768 undefined" and stripOutputNotice
		// stops matching the persisted "… 768 chars" text.
		let columnNotice = `Some lines truncated to ${c.maxColumn} ${c.unit ?? "chars"}`;
		if (c.artifactId != null) {
			columnNotice += `. ${formatFullOutputReference(c.artifactId)}`;
		}
		parts.push(columnNotice);
	}

	// Diagnostics
	let diagnosticsNotice = "";
	if (meta.diagnostics && meta.diagnostics.messages.length > 0) {
		const d = meta.diagnostics;
		diagnosticsNotice = `\n\nLSP Diagnostics (${d.summary}):\n${formatGroupedDiagnosticMessages(d.messages)}`;
	}

	const notice = parts.length ? `\n\n[${parts.join(". ")}]` : "";
	return notice + diagnosticsNotice;
}

/**
 * Format styled truncation and artifact capture warnings.
 * Returns null if neither warning is present.
 */
export function formatStyledTruncationWarning(meta: OutputMeta | undefined, theme: Theme): string | null {
	if (!meta?.truncation && !meta?.artifactError) return null;
	const parts: string[] = [];
	if (meta.truncation) parts.push(formatTruncationMetaNotice(meta.truncation, meta.source));
	if (meta.artifactError) parts.push(formatArtifactErrorNotice(meta.artifactError));
	return theme.fg("warning", wrapBrackets(parts.join(". "), theme));
}

/**
 * Strip the trailing notice that {@link appendOutputNotice} bakes into the
 * LLM-facing content body. Renderers should call this before printing
 * `result.content` text in the TUI, because they emit a styled warning line of
 * their own; without this, users see the same `[Showing lines …]` string twice
 * (once verbatim from the body, once as the styled `⟨…⟩` warning).
 *
 * Safe to call eagerly: returns the input unchanged when no notice is present
 * (e.g. during streaming, before {@link wrappedExecute} runs).
 */
export function stripOutputNotice(text: string, meta: OutputMeta | undefined): string {
	const notice = formatOutputNotice(meta);
	if (!notice) return text;
	// Trim trailing whitespace from `text` and from the notice itself so we
	// match regardless of whether: (a) the caller already trimEnd()'d, (b)
	// extra blank lines slipped in after the notice (diagnostics blocks add
	// `\n\n` between sections, OutputSink may pad), or (c) neither. Returns
	// the prefix before the notice so the caller can re-trim as needed.
	const trimmedText = text.trimEnd();
	const trimmedNotice = notice.trimEnd();
	if (trimmedText.endsWith(trimmedNotice)) {
		return stripTrailingNotice(trimmedText, trimmedNotice, false);
	}
	return text;
}
