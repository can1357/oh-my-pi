import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { formatBytes, sanitizeText } from "@oh-my-pi/pi-utils";
import { sanitizeWithOptionalSixelPassthrough } from "../utils/sixel";

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_MAX_LINES = 3000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const DEFAULT_MAX_COLUMN = 512; // Max chars per grep match line

/**
 * Default artifact-on-disk cap for {@link OutputSink}.
 *
 * `0` means unbounded: by default, `artifact://<id>` references preserve the
 * complete raw stream instead of a capped head/tail sample.
 */
export const ARTIFACT_DEFAULT_MAX_BYTES = 0;
/** Default head budget; the remainder becomes the rolling tail window. */
export const ARTIFACT_DEFAULT_HEAD_BYTES = 3 * 1024 * 1024; // 3 MiB

const NL = "\n";
const CR = "\r";
const ELLIPSIS = "…";

// =============================================================================
// Interfaces
// =============================================================================

export interface OutputSummary {
	output: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	/** Bytes elided from the middle when head-retain mode is active. */
	elidedBytes?: number;
	/** Lines elided from the middle when head-retain mode is active. */
	elidedLines?: number;
	/** Bytes dropped by the per-line column cap (sum across all lines). */
	columnDroppedBytes?: number;
	/** Number of distinct lines that hit the per-line column cap. */
	columnTruncatedLines?: number;
	/** Configured per-line column cap in effect (chars), when > 0. */
	columnMax?: number;
	/** Artifact ID for internal URL access (artifact://<id>) when truncated */
	artifactId?: string;
}

export interface OutputSinkOptions {
	artifactPath?: string;
	artifactId?: string;
	/**
	 * Total inline body budget (bytes). Default DEFAULT_MAX_BYTES. The head
	 * window and rolling tail window share this budget, so a composed
	 * `dump()` body never exceeds it (plus the elision marker).
	 */
	spillThreshold?: number;
	/**
	 * When > 0, the sink keeps the first `headBytes` of output in addition to
	 * the rolling tail window. Output between the two windows is elided
	 * (middle elision). Clamped to `spillThreshold / 2` so the tail keeps at
	 * least half the inline budget. Default 0 = tail-only behavior.
	 */
	headBytes?: number;
	/**
	 * Per-line byte cap. When > 0, lines wider than `maxColumns` bytes are
	 * truncated with an ellipsis at write time; remaining bytes up to the next
	 * `\n` are dropped. Cap state persists across chunks so split-mid-line
	 * writes still respect the budget. Default 0 = no per-line cap.
	 */
	maxColumns?: number;
	onChunk?: (chunk: string) => void;
	/** Minimum ms between onChunk calls. 0 = every chunk (default). */
	chunkThrottleMs?: number;
	/**
	 * Optional cap on bytes written to the artifact-on-disk file. When the cap
	 * is hit, the head window is preserved verbatim and subsequent output feeds
	 * a rolling tail window; on close, the sink writes a single
	 * `[ARTIFACT TRUNCATED: …]` notice between them. Default
	 * {@link ARTIFACT_DEFAULT_MAX_BYTES} (unbounded).
	 */
	artifactMaxBytes?: number;
	/**
	 * Bytes reserved for the head window of the capped artifact file. The
	 * tail window receives `artifactMaxBytes - artifactHeadBytes`. Default
	 * {@link ARTIFACT_DEFAULT_HEAD_BYTES}; clamped to `[0, artifactMaxBytes]`.
	 */
	artifactHeadBytes?: number;
}

export interface TruncationResult {
	content: string;
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines?: number;
	outputBytes?: number;
	/** Bytes elided from the middle (truncateMiddle only). */
	elidedBytes?: number;
	/** Lines elided from the middle (truncateMiddle only). */
	elidedLines?: number;
	/** Exact source-line counts retained before/after the middle marker. */
	headLines?: number;
	tailLines?: number;
	/** True when either retained side is a partial byte range of a source line. */
	partialByteWindows?: boolean;
	lastLinePartial?: boolean;
	firstLineExceedsLimit?: boolean;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 3000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
	/**
	 * For `truncateMiddle`: bytes reserved for the head window. The tail
	 * window receives `maxBytes - maxHeadBytes`. Default `floor(maxBytes/2)`.
	 */
	maxHeadBytes?: number;
	/**
	 * For `truncateMiddle`: lines reserved for the head window. The tail
	 * window receives `maxLines - maxHeadLines`. Default `floor(maxLines/2)`.
	 */
	maxHeadLines?: number;
}

/** Result from byte-level truncation helpers. */
export interface ByteTruncationResult {
	text: string;
	bytes: number;
}

export interface TailTruncationNoticeOptions {
	fullOutputPath?: string;
	originalContent?: string;
	suffix?: string;
}

export interface HeadTruncationNoticeOptions {
	startLine?: number;
	totalFileLines?: number;
}

// =============================================================================
// Internal low-level helpers
// =============================================================================

/** Count newline characters via native substring search. */
function countNewlines(text: string): number {
	let count = 0;
	let pos = text.indexOf(NL);
	while (pos !== -1) {
		count++;
		pos = text.indexOf(NL, pos + 1);
	}
	return count;
}

/** Zero-copy view of a Uint8Array as a Buffer (copies only if already a Buffer). */
function asBuffer(data: Uint8Array): Buffer {
	return Buffer.isBuffer(data) ? (data as Buffer) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Advance past UTF-8 continuation bytes (10xxxxxx) to a leading byte. */
function findUtf8BoundaryForward(buf: Buffer, pos: number): number {
	let i = Math.max(0, pos);
	while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
	return i;
}

/** Retreat past UTF-8 continuation bytes to land on a leading byte. */
function findUtf8BoundaryBackward(buf: Buffer, cut: number): number {
	let i = Math.min(buf.length, Math.max(0, cut));
	// If the cut is at end-of-buffer, it's already a valid boundary.
	if (i >= buf.length) return buf.length;
	while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
	return i;
}

// =============================================================================
// Byte-level truncation (windowed encoding)
// =============================================================================

function truncateBytesWindowed(
	data: string | Uint8Array,
	maxBytesRaw: number,
	mode: "head" | "tail",
): ByteTruncationResult {
	const maxBytes = maxBytesRaw;
	if (maxBytes === 0) return { text: "", bytes: 0 };

	// --------------------------
	// String path (windowed)
	// --------------------------
	if (typeof data === "string") {
		// Fast non-truncation check only when it *might* fit.
		if (data.length <= maxBytes) {
			const len = Buffer.byteLength(data, "utf-8");
			if (len <= maxBytes) return { text: data, bytes: len };
			// else: multibyte-heavy string; fall through to truncation using full string as window.
		}

		const window =
			mode === "head"
				? data.substring(0, Math.min(data.length, maxBytes))
				: data.substring(Math.max(0, data.length - maxBytes));

		const buf = Buffer.from(window, "utf-8");

		if (mode === "head") {
			const end = findUtf8BoundaryBackward(buf, maxBytes);
			if (end <= 0) return { text: "", bytes: 0 };
			const slice = buf.subarray(0, end);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		} else {
			const startAt = Math.max(0, buf.length - maxBytes);
			const start = findUtf8BoundaryForward(buf, startAt);
			const slice = buf.subarray(start);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		}
	}

	// --------------------------
	// Uint8Array / Buffer path
	// --------------------------
	const buf = asBuffer(data);
	if (buf.length <= maxBytes) return { text: buf.toString("utf-8"), bytes: buf.length };

	if (mode === "head") {
		const end = findUtf8BoundaryBackward(buf, maxBytes);
		if (end <= 0) return { text: "", bytes: 0 };
		const slice = buf.subarray(0, end);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	} else {
		const startAt = buf.length - maxBytes;
		const start = findUtf8BoundaryForward(buf, startAt);
		const slice = buf.subarray(start);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	}
}

/**
 * Truncate a string/buffer to fit within a byte limit, keeping the tail.
 * Handles multi-byte UTF-8 boundaries correctly.
 */
export function truncateTailBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "tail");
}

/**
 * Truncate a string/buffer to fit within a byte limit, keeping the head.
 * Handles multi-byte UTF-8 boundaries correctly.
 */
export function truncateHeadBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "head");
}

// =============================================================================
// Line-level utilities
// =============================================================================

/**
 * Truncate a single line to max characters, appending '…' if truncated.
 */
export function truncateLine(
	line: string,
	maxChars: number = DEFAULT_MAX_COLUMN,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}…`, wasTruncated: true };
}

// =============================================================================
// Content truncation (line + byte aware, no full Buffer allocation)
// =============================================================================

/** Shared helper to build a no-truncation result. */
export function noTruncResult(content: string, totalLines?: number, totalBytes?: number): TruncationResult {
	if (totalLines == null) totalLines = countNewlines(content) + 1;
	if (totalBytes == null) totalBytes = Buffer.byteLength(content, "utf-8");
	return { content, totalLines, totalBytes };
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Never returns partial lines. If the first line exceeds the byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 *
 * This implementation avoids Buffer.from(content) for the whole input.
 * It only computes UTF-8 byteLength for candidate lines that can still fit.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let cutIndex = 0; // char index where we cut (exclusive)
	let cursor = 0;

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.indexOf(NL, cursor);
		const lineEnd = nl === -1 ? content.length : nl;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		// No room even for separators / bytes.
		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		// Fast reject huge lines without slicing/encoding:
		// UTF-8 bytes >= UTF-16 code units, so if code units exceed remaining, bytes must exceed too.
		const lineCodeUnits = lineEnd - cursor;
		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		// Small slice (bounded by remaining <= maxBytes) for exact UTF-8 byte count.
		const lineText = content.slice(cursor, lineEnd);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		// Include the line (join semantics: no trailing newline after the last included line).
		bytesUsed += sepBytes + lineBytes;
		includedLines++;

		cutIndex = nl === -1 ? content.length : nl; // exclude the newline after the last included line
		if (nl === -1) break;
		cursor = nl + 1;
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: content.slice(0, cutIndex),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * May return a partial first line if the last line exceeds the byte limit.
 *
 * Also avoids Buffer.from(content) for the whole input.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let startIndex = content.length; // char index where output starts
	let end = content.length; // char index where current line ends (exclusive)

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.lastIndexOf(NL, end - 1);
		const lineStart = nl === -1 ? 0 : nl + 1;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		const lineCodeUnits = end - lineStart;

		// Fast reject huge line without slicing/encoding.
		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				// Window the line substring to avoid materializing a giant string.
				const windowStart = Math.max(lineStart, end - maxBytes);
				const window = content.substring(windowStart, end);
				const tail = truncateTailBytes(window, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
				};
			}
			break;
		}

		const lineText = content.slice(lineStart, end);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				const tail = truncateTailBytes(lineText, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
				};
			}
			break;
		}

		bytesUsed += sepBytes + lineBytes;
		includedLines++;
		startIndex = lineStart;

		if (nl === -1) break;
		end = nl; // exclude the newline itself; it'll be accounted as sepBytes in the next iteration
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: content.slice(startIndex),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

// =============================================================================
// Middle elision (keep head + tail, drop middle)
// =============================================================================

/**
 * Format the inline marker substituted for the elided middle region.
 * Returned without surrounding newlines so callers can position it freely.
 */
export function formatMiddleElisionMarker(elidedLines: number, elidedBytes: number): string {
	// A 0/1-line elision (e.g. one giant single line) would read as
	// "[…0ln elided…]"; fall back to a byte count there.
	if (elidedLines <= 1) return `[…${elidedBytes}B elided…]`;
	return `[…${elidedLines}ln elided…]`;
}

/**
 * Truncate content keeping a head window and a tail window, eliding the middle.
 *
 * The combined output is `<head>\n<marker>\n<tail>` when truncation is needed.
 * `maxHeadBytes` defaults to `floor(maxBytes / 2)`; the tail receives the
 * remainder. Falls back to `truncateTail` / `truncateHead` if either side's
 * budget is empty or the content already fits.
 */
export function truncateMiddle(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const headBytes = options.maxHeadBytes ?? Math.floor(maxBytes / 2);
	const tailBytes = Math.max(0, maxBytes - headBytes);
	const headLines = options.maxHeadLines ?? Math.max(1, Math.floor(maxLines / 2));
	const tailLines = Math.max(0, maxLines - headLines);

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalBytes <= maxBytes && totalLines <= maxLines) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	// Degenerate budgets → fall back to one-sided truncation.
	if (headBytes <= 0 || headLines <= 0) {
		return truncateTail(content, { maxBytes: tailBytes || maxBytes, maxLines: tailLines || maxLines });
	}
	if (tailBytes <= 0 || tailLines <= 0) {
		return truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	}

	const head = truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	const tail = truncateTail(content, { maxBytes: tailBytes, maxLines: tailLines });

	const headLinesKept = head.outputLines ?? 0;
	const tailLinesKept = tail.outputLines ?? 0;
	const headBytesKept = head.outputBytes ?? Buffer.byteLength(head.content, "utf-8");
	const tailBytesKept = tail.outputBytes ?? Buffer.byteLength(tail.content, "utf-8");

	// A giant first/last line cannot use one of the line-preserving windows. Use
	// a byte window only for that side and retain the normal line cap on the other.
	if (headLinesKept === 0 || head.firstLineExceedsLimit || tailLinesKept === 0) {
		const useByteHead = headLinesKept === 0 || head.firstLineExceedsLimit;
		const byteHead = useByteHead
			? truncateHeadBytes(content, Math.min(headBytes, totalBytes))
			: { text: head.content, bytes: headBytesKept };
		const actualHeadLines = useByteHead ? 1 : headLinesKept;
		const remainingBytes = Math.max(0, totalBytes - byteHead.bytes);
		const useByteTail = tailLinesKept === 0;
		const byteTail = useByteTail
			? truncateTailBytes(content, Math.min(tailBytes, remainingBytes))
			: (() => {
					const limited = truncateTail(content, {
						maxBytes: Math.min(tailBytes, remainingBytes),
						maxLines: tailLines,
					});
					return { text: limited.content, bytes: limited.outputBytes ?? Buffer.byteLength(limited.content) };
				})();
		const actualTailLines = useByteTail ? 1 : Math.min(tailLinesKept, tailLines);
		const elidedBytes = Math.max(0, totalBytes - byteHead.bytes - byteTail.bytes);
		if (elidedBytes === 0) return noTruncResult(content, totalLines, totalBytes);
		const marker = formatMiddleElisionMarker(0, elidedBytes);
		const composed = `${byteHead.text}\n${marker}\n${byteTail.text}`;
		return {
			content: composed,
			truncated: true,
			truncatedBy: "middle",
			totalLines,
			totalBytes,
			outputLines: actualHeadLines + actualTailLines + 1,
			outputBytes: Buffer.byteLength(composed, "utf-8"),
			elidedLines: Math.max(0, totalLines - actualHeadLines - actualTailLines),
			headLines: actualHeadLines,
			tailLines: actualTailLines,
			partialByteWindows: useByteHead || useByteTail || tail.lastLinePartial === true,
			elidedBytes,
			lastLinePartial: true,
			firstLineExceedsLimit: false,
		};
	}
	// Fully retained line windows need no marker. A partial tail still omitted
	// bytes from its source line even when the windows account for every line.
	if (headLinesKept + tailLinesKept >= totalLines && !tail.lastLinePartial) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	const elidedLines = totalLines - headLinesKept - tailLinesKept;
	// `totalBytes - headBytesKept - tailBytesKept` includes newline separators
	// between the kept windows and the elided region; close enough for a notice.
	const elidedBytes = Math.max(0, totalBytes - headBytesKept - tailBytesKept);
	const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
	const composed = `${head.content}\n${marker}\n${tail.content}`;
	const markerBytes = Buffer.byteLength(marker, "utf-8");

	return {
		content: composed,
		truncated: true,
		truncatedBy: "middle",
		totalLines,
		totalBytes,
		outputLines: headLinesKept + tailLinesKept + 1,
		outputBytes: headBytesKept + tailBytesKept + markerBytes + 2,
		elidedLines,
		elidedBytes,
		headLines: headLinesKept,
		tailLines: tailLinesKept,
		lastLinePartial: tail.lastLinePartial,
		firstLineExceedsLimit: false,
	};
}

// =============================================================================
// Inline byte cap — final defense at the tool-result boundary
// =============================================================================

/** Options for {@link enforceInlineByteCap}. */
export interface InlineByteCapOptions {
	/** Inline byte budget. Defaults to {@link DEFAULT_MAX_BYTES}. */
	maxBytes?: number;
	/**
	 * Persist the full text as a session artifact. When an artifact id is
	 * returned, a `[raw output: artifact://<id>]` footer is appended so the
	 * elided bytes stay recoverable.
	 */
	saveArtifact?: (full: string) => string | undefined | Promise<string | undefined>;
}

/** Drop the partial last line of a head window (keep it if there is no newline at all). */
function trimHeadToLineBoundary(text: string): string {
	const idx = text.lastIndexOf(NL);
	return idx > 0 ? text.substring(0, idx) : text;
}

/** Drop the partial first line of a tail window (keep it if there is no newline at all). */
function trimTailToLineBoundary(text: string): string {
	const idx = text.indexOf(NL);
	if (idx < 0 || idx === text.length - 1) return text;
	return text.substring(idx + 1);
}

/**
 * Final-defense inline size guard for tool results.
 *
 * No-op when `text` fits within `maxBytes` (the common path). Otherwise keeps
 * ~60% of the budget from the head and ~25% from the tail — cut on line
 * boundaries, never splitting a multi-byte UTF-8 sequence — with an elision
 * marker between. The remaining ~15% is slack for the marker and the optional
 * `[raw output: artifact://<id>]` footer, so the result stays under `maxBytes`.
 */
export async function enforceInlineByteCap(text: string, options: InlineByteCapOptions): Promise<string> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (maxBytes <= 0) return text;
	const totalBytes = Buffer.byteLength(text, "utf-8");
	if (totalBytes <= maxBytes) return text;

	const head = trimHeadToLineBoundary(truncateHeadBytes(text, Math.floor(maxBytes * 0.6)).text);
	const tail = trimTailToLineBoundary(truncateTailBytes(text, Math.floor(maxBytes * 0.25)).text);
	const elidedBytes = Math.max(0, totalBytes - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8"));
	const marker = `[…${elidedBytes}B elided…]`;
	let composed = `${head}\n${marker}\n${tail}`;

	const artifactId = await options.saveArtifact?.(text);
	if (artifactId) {
		const sep = composed.endsWith(NL) ? "" : NL;
		composed += `${sep}[raw output: artifact://${artifactId}]`;
	}
	return composed;
}

// =============================================================================
// TailBuffer — ring-style tail buffer with lazy joining
// =============================================================================

const MAX_PENDING = 10;

export class TailBuffer {
	#pending: string[] = [];
	#pos = 0; // byte count of the currently-held tail (after trims)

	constructor(readonly maxBytes: number) {}

	append(text: string): void {
		if (!text) return;

		const max = this.maxBytes;
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}

		const n = Buffer.byteLength(text, "utf-8");

		// If the incoming chunk alone is >= budget, it fully dominates the tail.
		if (n >= max) {
			const { text: t, bytes } = truncateTailBytes(text, max);
			this.#pending[0] = t;
			this.#pending.length = 1;
			this.#pos = bytes;
			return;
		}

		this.#pos += n;

		if (this.#pending.length === 0) {
			this.#pending[0] = text;
			this.#pending.length = 1;
		} else {
			this.#pending.push(text);
			if (this.#pending.length > MAX_PENDING) this.#compact();
		}

		// Trim when we exceed 2× budget to amortize cost.
		if (this.#pos > max * 2) this.#trimTo(max);
	}

	text(): string {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#flush();
	}

	bytes(): number {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#pos;
	}

	// -- private ---------------------------------------------------------------

	#compact(): void {
		this.#pending[0] = this.#pending.join("");
		this.#pending.length = 1;
	}

	#flush(): string {
		if (this.#pending.length === 0) return "";
		if (this.#pending.length > 1) this.#compact();
		return this.#pending[0];
	}

	#trimTo(max: number): void {
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}
		if (this.#pos <= max) return;

		const joined = this.#flush();
		const { text, bytes } = truncateTailBytes(joined, max);
		this.#pos = bytes;
		this.#pending[0] = text;
		this.#pending.length = 1;
	}
}

// =============================================================================
// OutputSink — line-buffered output with file spill support
// =============================================================================

export class OutputSink {
	#buffer = "";
	#bufferBytes = 0;
	#head = "";
	#headBytes = 0;
	#headLines = 0; // newline count inside #head
	#headRetentionDisabled = false;
	#totalLines = 0; // newline count
	#totalBytes = 0;
	#sawData = false;
	#truncated = false;
	#lastChunkTime = 0;
	#pendingChunk = "";
	#pendingCarriageReturn = false;
	#pendingChunkTimer: Timer | undefined;

	// Per-line column cap streaming state (persists across `push` calls so a
	// long line split across chunks still trips the same trigger).
	#currentLineBytes = 0;
	#columnEllipsisAdded = false;
	#columnDroppedBytes = 0;
	#columnTruncatedLines = 0;
	#file?: {
		path: string;
		artifactId?: string;
		sink: Bun.FileSink;
	};

	// Queue of chunks waiting for the file sink to be created.
	#pendingFileWrites?: string[];
	#fileReady = false;
	/** In-flight sink creation, awaited by finalize/dispose so a fd opened by a late chunk is still released. */
	#fileCreation?: Promise<void>;
	/** Set once the spill file has been closed; guards double-close and post-finalize resurrection. */
	#finalized = false;

	readonly #artifactPath?: string;
	readonly #artifactId?: string;
	readonly #spillThreshold: number;
	readonly #headLimit: number;
	readonly #onChunk?: (chunk: string) => void;
	readonly #chunkThrottleMs: number;
	readonly #maxColumns: number;

	// Optional artifact-on-disk cap. When `#artifactMaxBytes > 0` the file sink
	// owns a head budget + a rolling tail buffer; once the head is closed,
	// subsequent chunks are diverted into `#artifactTailRing` (bounded by
	// `#artifactTailBudget`). On `dump()` the tail is flushed back to the sink
	// behind a `[ARTIFACT TRUNCATED: …]` notice. The default cap is disabled so
	// advertised `artifact://<id>` captures are lossless.
	readonly #artifactMaxBytes: number;
	readonly #artifactHeadBudget: number;
	readonly #artifactTailBudget: number;
	#artifactHeadBytesWritten = 0;
	#artifactHeadClosed = false;
	#artifactTailRing = "";
	#artifactTailRingBytes = 0;
	#artifactTailIncomingBytes = 0;

	constructor(options?: OutputSinkOptions) {
		const {
			artifactPath,
			artifactId,
			spillThreshold = DEFAULT_MAX_BYTES,
			headBytes = 0,
			maxColumns = 0,
			onChunk,
			chunkThrottleMs = 0,
			artifactMaxBytes = ARTIFACT_DEFAULT_MAX_BYTES,
			artifactHeadBytes = ARTIFACT_DEFAULT_HEAD_BYTES,
		} = options ?? {};
		this.#artifactPath = artifactPath;
		this.#artifactId = artifactId;
		this.#spillThreshold = spillThreshold;
		this.#headLimit = Math.max(0, Math.min(headBytes, Math.floor(spillThreshold / 2)));
		this.#maxColumns = Math.max(0, maxColumns);
		this.#onChunk = onChunk;
		this.#chunkThrottleMs = chunkThrottleMs;
		this.#artifactMaxBytes = Math.max(0, artifactMaxBytes);
		this.#artifactHeadBudget = Math.max(0, Math.min(artifactHeadBytes, this.#artifactMaxBytes));
		this.#artifactTailBudget = Math.max(0, this.#artifactMaxBytes - this.#artifactHeadBudget);
	}

	/**
	 * Converts carriage-return progress updates into line boundaries while
	 * collapsing CRLF to one newline. A trailing CR is held until the next
	 * chunk so split CRLF sequences do not create blank lines.
	 */
	#normalizeCarriageReturns(text: string): string {
		if (text.length === 0 || (!this.#pendingCarriageReturn && !text.includes(CR))) return text;

		let cursor = 0;
		let normalized = "";
		if (this.#pendingCarriageReturn) {
			this.#pendingCarriageReturn = false;
			normalized = NL;
			if (text.startsWith(NL)) cursor = 1;
		}

		while (cursor < text.length) {
			const carriageReturn = text.indexOf(CR, cursor);
			if (carriageReturn === -1) {
				normalized += text.substring(cursor);
				break;
			}
			normalized += text.substring(cursor, carriageReturn);
			if (carriageReturn === text.length - 1) {
				this.#pendingCarriageReturn = true;
				break;
			}
			normalized += NL;
			cursor = text.startsWith(NL, carriageReturn + 1) ? carriageReturn + 2 : carriageReturn + 1;
		}
		return normalized;
	}

	/**
	 * Push a chunk of output. The buffer management and onChunk callback run
	 * synchronously. File sink writes are deferred and serialized internally.
	 */
	push(chunk: string): void {
		if (this.#finalized) return;
		chunk = sanitizeWithOptionalSixelPassthrough(chunk, text => sanitizeText(this.#normalizeCarriageReturns(text)));

		// Throttled onChunk: coalesce chunks arriving inside the throttle window.
		// A timer flushes quiet tails at the throttle boundary; dump() catches a
		// final pending chunk when the process exits before that timer fires.
		// Live preview gets the raw (pre-cap) chunk so the TUI never lags behind
		// what reached the sink — the column cap is for the persisted LLM view.
		if (this.#onChunk) {
			const now = Date.now();
			if (now - this.#lastChunkTime >= this.#chunkThrottleMs) {
				this.#emitPendingChunkWith(chunk, now);
			} else {
				this.#pendingChunk += chunk;
				this.#schedulePendingChunkFlush();
			}
		}

		const rawBytes = Buffer.byteLength(chunk, "utf-8");
		this.#totalBytes += rawBytes;

		if (chunk.length > 0) {
			this.#sawData = true;
			this.#totalLines += countNewlines(chunk);
		}

		// Per-line column cap. State persists across chunks so a mid-line split
		// still respects the budget. Operates on the sanitized chunk; the cap is
		// applied before head/tail accounting but after artifact mirroring decides.
		const capped = this.#maxColumns > 0 ? this.#applyColumnCap(chunk) : chunk;
		const cappedBytes = capped === chunk ? rawBytes : Buffer.byteLength(capped, "utf-8");
		const cappedThisChunk = cappedBytes < rawBytes;

		// Mirror RAW chunk to the artifact file so the on-disk record is the full
		// uncapped stream. Mirror triggers on: in-memory overflow OR this chunk's
		// column cap dropped bytes (otherwise we'd lose data) OR file already open.
		if (this.#artifactPath && (this.#file != null || cappedThisChunk || this.#willOverflow(cappedBytes))) {
			this.#writeToFile(chunk);
		}

		if (cappedBytes === 0) return;

		// Head retention: drain the (capped) chunk into #head until the budget is
		// exhausted, then forward any leftover to the tail buffer.
		let tailChunk = capped;
		let tailBytes = cappedBytes;
		if (this.#headLimit > 0 && !this.#headRetentionDisabled && this.#headBytes < this.#headLimit) {
			const room = this.#headLimit - this.#headBytes;
			if (cappedBytes <= room) {
				this.#head += capped;
				this.#headBytes += cappedBytes;
				this.#headLines += countNewlines(capped);
				return;
			}
			// Split: head takes a UTF-8-safe prefix; remainder flows to tail.
			const headSlice = truncateHeadBytes(capped, room);
			if (headSlice.bytes > 0) {
				this.#head += headSlice.text;
				this.#headBytes += headSlice.bytes;
				this.#headLines += countNewlines(headSlice.text);
				tailChunk = capped.substring(headSlice.text.length);
				tailBytes = cappedBytes - headSlice.bytes;
			}
		}

		this.#pushTail(tailChunk, tailBytes);
	}

	/**
	 * Apply the per-line byte cap to `chunk`, dropping bytes that would push the
	 * current line beyond `#maxColumns`. Emits a single `…` once a line trips the
	 * cap; subsequent bytes are skipped until the next `\n`. State persists
	 * across calls so a long line split across chunks still produces one marker.
	 */
	#applyColumnCap(chunk: string): string {
		if (chunk.length === 0) return chunk;
		const max = this.#maxColumns;
		const parts: string[] = [];
		let cursor = 0;
		while (cursor < chunk.length) {
			const nlIdx = chunk.indexOf(NL, cursor);
			const segEnd = nlIdx === -1 ? chunk.length : nlIdx;
			if (segEnd > cursor) {
				const segment = chunk.substring(cursor, segEnd);
				if (this.#columnEllipsisAdded) {
					// Past the cap; drop until newline.
					this.#columnDroppedBytes += Buffer.byteLength(segment, "utf-8");
				} else {
					const segBytes = Buffer.byteLength(segment, "utf-8");
					const remaining = max - this.#currentLineBytes;
					if (segBytes <= remaining) {
						parts.push(segment);
						this.#currentLineBytes += segBytes;
					} else {
						// First overflow on this line: keep what fits, append ellipsis,
						// arm the skip-until-newline flag.
						const ellipsisBytes = 3; // "…" in UTF-8
						const headRoom = Math.max(0, remaining - ellipsisBytes);
						let kept = "";
						let keptBytes = 0;
						if (headRoom > 0) {
							const sliced = truncateHeadBytes(segment, headRoom);
							kept = sliced.text;
							keptBytes = sliced.bytes;
							parts.push(kept);
						}
						parts.push(ELLIPSIS);
						this.#columnDroppedBytes += segBytes - keptBytes;
						this.#columnTruncatedLines++;
						this.#currentLineBytes += keptBytes + ellipsisBytes;
						this.#columnEllipsisAdded = true;
					}
				}
			}
			if (nlIdx === -1) break;
			parts.push(NL);
			this.#currentLineBytes = 0;
			this.#columnEllipsisAdded = false;
			cursor = nlIdx + 1;
		}
		return parts.join("");
	}

	// The rolling tail budget is whatever the head window has not consumed of
	// the inline budget: `spillThreshold - #headBytes`. While the head window
	// fills it shrinks toward `spillThreshold - headLimit`; after `replace()`
	// (head cleared) it grows back to the full threshold. This keeps
	// `head + tail <= spillThreshold`, so the composed dump body fits the
	// inline byte cap by construction.

	#willOverflow(dataBytes: number): boolean {
		// Triggers file mirroring as soon as the next chunk would push us over
		// the tail budget — i.e. the first byte that could be lost from memory.
		return this.#bufferBytes + dataBytes > this.#spillThreshold - this.#headBytes;
	}

	#pushTail(chunk: string, dataBytes: number): void {
		if (dataBytes === 0) return;

		const threshold = Math.max(0, this.#spillThreshold - this.#headBytes);
		const willOverflow = this.#bufferBytes + dataBytes > threshold;

		if (!willOverflow) {
			this.#buffer += chunk;
			this.#bufferBytes += dataBytes;
			return;
		}

		// Overflow: keep only a tail window in memory.
		this.#truncated = true;

		// Avoid creating a giant intermediate string when chunk alone dominates.
		if (dataBytes >= threshold) {
			const { text, bytes } = truncateTailBytes(chunk, threshold);
			this.#buffer = text;
			this.#bufferBytes = bytes;
		} else {
			// Intermediate size is bounded (<= threshold + dataBytes), safe to concat.
			this.#buffer += chunk;
			this.#bufferBytes += dataBytes;

			const { text, bytes } = truncateTailBytes(this.#buffer, threshold);
			this.#buffer = text;
			this.#bufferBytes = bytes;
		}
	}

	/**
	 * Write a chunk to the artifact file. Handles the async file sink creation
	 * by queuing writes until the sink is ready, then draining synchronously.
	 * Once the sink is up, every byte flows through {@link #emitToSink} which
	 * owns the head + tail cap so artifacts cannot grow beyond
	 * `#artifactMaxBytes` on disk.
	 */
	#writeToFile(chunk: string): void {
		if (this.#fileReady && this.#file) {
			this.#emitToSink(chunk);
			return;
		}
		// File sink not yet created — queue this chunk and kick off creation.
		// The queue is bounded only by how many chunks arrive before the open
		// resolves (typically <2). The cap is enforced on drain.
		if (!this.#pendingFileWrites) {
			this.#pendingFileWrites = [chunk];
			this.#fileCreation = this.#createFileSink();
		} else {
			this.#pendingFileWrites.push(chunk);
		}
	}

	/**
	 * Cap-aware sink writer. Bytes flow into the head window verbatim until the
	 * budget is exhausted; subsequent bytes are diverted into a rolling tail
	 * ring, evicted from the front so total RAM stays bounded by
	 * `#artifactTailBudget`. `dump()` replays the ring behind a single notice
	 * line before closing the sink.
	 *
	 * When the cap is disabled (`#artifactMaxBytes === 0`) this collapses to a
	 * straight pass-through, preserving the historical "stream everything"
	 * contract.
	 */
	#emitToSink(chunk: string): void {
		if (!this.#file || chunk.length === 0) return;
		if (this.#artifactMaxBytes === 0) {
			this.#file.sink.write(chunk);
			return;
		}
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		const room = this.#artifactHeadClosed ? 0 : this.#artifactHeadBudget - this.#artifactHeadBytesWritten;
		if (room >= chunkBytes) {
			this.#file.sink.write(chunk);
			this.#artifactHeadBytesWritten += chunkBytes;
			return;
		}
		let overflow = chunk;
		if (room > 0) {
			const headSlice = truncateHeadBytes(chunk, room);
			if (headSlice.bytes > 0) {
				this.#file.sink.write(headSlice.text);
				this.#artifactHeadBytesWritten += headSlice.bytes;
			}
			// Even when UTF-8 boundary safety leaves a few bytes of nominal room,
			// this chunk has already overflowed the head window. Close it now so a
			// later small ASCII chunk cannot be written before this overflow tail.
			this.#artifactHeadClosed = true;
			overflow = chunk.substring(headSlice.text.length);
		}
		if (overflow.length === 0 || this.#artifactTailBudget === 0) {
			// No tail budget: count the dropped bytes so the notice reflects them.
			if (overflow.length > 0) {
				this.#artifactTailIncomingBytes += Buffer.byteLength(overflow, "utf-8");
			}
			return;
		}
		this.#pushArtifactTail(overflow);
	}

	#pushArtifactTail(chunk: string): void {
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		this.#artifactTailIncomingBytes += chunkBytes;
		const budget = this.#artifactTailBudget;
		if (chunkBytes >= budget) {
			// Chunk alone dominates — keep only its tail slice.
			const { text, bytes } = truncateTailBytes(chunk, budget);
			this.#artifactTailRing = text;
			this.#artifactTailRingBytes = bytes;
			return;
		}
		this.#artifactTailRing += chunk;
		this.#artifactTailRingBytes += chunkBytes;
		if (this.#artifactTailRingBytes > budget) {
			const { text, bytes } = truncateTailBytes(this.#artifactTailRing, budget);
			this.#artifactTailRing = text;
			this.#artifactTailRingBytes = bytes;
		}
	}

	async #createFileSink(): Promise<void> {
		if (!this.#artifactPath || this.#fileReady) return;
		try {
			const sink = Bun.file(this.#artifactPath).writer();
			this.#file = { path: this.#artifactPath, artifactId: this.#artifactId, sink };
			this.#fileReady = true;

			// Head-retained bytes precede the rolling tail buffer in the capture.
			// Route through #emitToSink so they count against the artifact head
			// budget — a direct sink.write would let them escape the cap.
			if (this.#head.length > 0) {
				this.#emitToSink(this.#head);
			}

			// Flush existing buffer to file BEFORE it gets trimmed further.
			if (this.#buffer.length > 0) {
				this.#emitToSink(this.#buffer);
			}

			// Drain any chunks that arrived while the sink was being created.
			if (this.#pendingFileWrites) {
				for (const pending of this.#pendingFileWrites) {
					this.#emitToSink(pending);
				}
				this.#pendingFileWrites = undefined;
			}
		} catch {
			try {
				await this.#file?.sink?.end();
			} catch {
				/* ignore */
			}
			this.#file = undefined;
			this.#pendingFileWrites = undefined;
			this.#fileReady = false;
		}
	}

	createInput(): WritableStream<Uint8Array | string> {
		const dec = new TextDecoder("utf-8", { ignoreBOM: true });
		const finalize = () => {
			this.push(dec.decode());
		};
		return new WritableStream({
			write: chunk => {
				this.push(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }));
			},
			close: finalize,
			abort: finalize,
		});
	}

	/**
	 * Replace the in-memory buffer with the given text. Used when an upstream
	 * minimizer rewrites the captured output after the raw bytes have already
	 * been streamed.
	 *
	 * After this call the buffer is authoritative: streaming counters realign
	 * to the replacement, the retained head window is cleared, and head
	 * retention is disabled so subsequent `push()` calls append directly to the
	 * tail buffer instead of repopulating the (now meaningless) head window
	 * — which would otherwise reorder content and trip the middle-elision
	 * branch in `dump()` against stale totals.
	 */
	replace(text: string): void {
		this.#clearPendingChunkTimer();
		this.#buffer = text;
		this.#bufferBytes = Buffer.byteLength(text, "utf-8");
		this.#head = "";
		this.#headBytes = 0;
		this.#headLines = 0;
		this.#headRetentionDisabled = true;
		this.#totalBytes = this.#bufferBytes;
		this.#totalLines = countNewlines(text);
		this.#sawData = text.length > 0;
		this.#truncated = false;
		this.#currentLineBytes = 0;
		this.#columnEllipsisAdded = false;
		this.#columnDroppedBytes = 0;
		this.#columnTruncatedLines = 0;
		this.#pendingChunk = "";
		this.#pendingCarriageReturn = false;
	}

	#clearPendingChunkTimer(): void {
		if (!this.#pendingChunkTimer) return;
		clearTimeout(this.#pendingChunkTimer);
		this.#pendingChunkTimer = undefined;
	}

	#emitPendingChunkWith(chunk: string, now: number): void {
		this.#clearPendingChunkTimer();
		this.#lastChunkTime = now;
		const merged = this.#pendingChunk + chunk;
		this.#pendingChunk = "";
		this.#onChunk?.(merged);
	}

	#flushPendingChunk(): void {
		if (this.#pendingChunk.length === 0) {
			this.#clearPendingChunkTimer();
			return;
		}
		this.#emitPendingChunkWith("", Date.now());
	}

	#schedulePendingChunkFlush(): void {
		if (this.#chunkThrottleMs <= 0 || this.#pendingChunkTimer) return;
		const elapsed = Date.now() - this.#lastChunkTime;
		const delay = Math.max(0, this.#chunkThrottleMs - elapsed);
		this.#pendingChunkTimer = setTimeout(() => {
			this.#pendingChunkTimer = undefined;
			this.#flushPendingChunk();
		}, delay);
	}

	/**
	 * Replay the rolling tail ring back into the artifact sink. When bytes
	 * were actually dropped from the middle (the head budget was exhausted
	 * *and* the tail ring evicted), a single `[ARTIFACT TRUNCATED: …]`
	 * notice is injected between head and tail so a reader of
	 * `artifact://<id>` understands the gap. When the total stream simply
	 * spilled past the head budget but still fits below `artifactMaxBytes`,
	 * `droppedBytes` is zero — head + tail together are the verbatim stream
	 * and the notice is suppressed so we don't corrupt the artifact with a
	 * misleading "0 B elided" marker (PR #2083 review by codex).
	 *
	 * No-op when the cap was never hit at all (head budget never exhausted,
	 * tail ring empty).
	 */
	#flushArtifactTailIfCapped(): void {
		if (!this.#file) return;
		if (this.#artifactMaxBytes === 0) return;
		const tailBytes = this.#artifactTailRingBytes;
		const droppedBytes = Math.max(0, this.#artifactTailIncomingBytes - tailBytes);
		if (tailBytes === 0 && droppedBytes === 0) return;

		if (droppedBytes > 0) {
			const headWritten = this.#artifactHeadBytesWritten;
			const totalCapped = headWritten + this.#artifactTailIncomingBytes;
			const headSep = headWritten > 0 ? "\n" : "";
			const tailSep = tailBytes > 0 && !this.#artifactTailRing.startsWith("\n") ? "\n" : "";
			const notice =
				`${headSep}[ARTIFACT TRUNCATED: kept first ${formatBytes(headWritten)} + last ${formatBytes(tailBytes)} ` +
				`of ${formatBytes(totalCapped)}; ${formatBytes(droppedBytes)} elided from the middle]${tailSep}`;
			this.#file.sink.write(notice);
		}
		if (tailBytes > 0) {
			this.#file.sink.write(this.#artifactTailRing);
		}
	}

	async dump(notice?: string): Promise<OutputSummary> {
		if (this.#pendingCarriageReturn) {
			this.#pendingCarriageReturn = false;
			this.push(NL);
		}
		const noticeLine = notice ? `[${notice}]\n` : "";

		// Flush any chunk still held back by the throttle so the live preview
		// ends with the complete stream.
		this.#flushPendingChunk();
		const totalLines = this.#sawData ? this.#totalLines + 1 : 0;

		await this.#finalizeFile();

		// Compose the visible output. With head retention, splice head + marker
		// + tail when content was elided. Otherwise return the rolling buffer.
		const headBytes = this.#headBytes;
		const tailBuf = this.#buffer;
		const tailBytes = this.#bufferBytes;
		const headLines = this.#headLines + (headBytes > 0 && !this.#head.endsWith("\n") ? 1 : 0);
		const tailLines = tailBuf.length > 0 ? countNewlines(tailBuf) + 1 : 0;

		// Bytes that survived the column cap. Middle elision operates on these,
		// so column-dropped bytes don't inflate the "elided from middle" count.
		const effectiveTotalBytes = Math.max(0, this.#totalBytes - this.#columnDroppedBytes);

		let body: string;
		let outputBytes: number;
		let outputLines: number;
		let elidedBytes: number | undefined;
		let elidedLines: number | undefined;

		if (headBytes > 0 && effectiveTotalBytes > headBytes + tailBytes) {
			// Middle was elided. Emit head + marker + tail.
			elidedBytes = Math.max(0, effectiveTotalBytes - headBytes - tailBytes);
			elidedLines = Math.max(0, totalLines - headLines - tailLines);
			const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
			const markerBytes = Buffer.byteLength(marker, "utf-8");
			const headSep = this.#head.endsWith("\n") ? "" : "\n";
			const tailSep = tailBuf.startsWith("\n") ? "" : "\n";
			body = `${this.#head}${headSep}${marker}${tailSep}${tailBuf}`;
			outputBytes =
				headBytes +
				markerBytes +
				tailBytes +
				Buffer.byteLength(headSep, "utf-8") +
				Buffer.byteLength(tailSep, "utf-8");
			outputLines = headLines + 1 + tailLines;
			this.#truncated = true;
		} else if (headBytes > 0) {
			// Head + tail combine into the full buffered output (no overlap or elision).
			body = `${this.#head}${tailBuf}`;
			outputBytes = headBytes + tailBytes;
			outputLines = body.length > 0 ? countNewlines(body) + 1 : 0;
		} else {
			body = tailBuf;
			outputBytes = tailBytes;
			outputLines = tailLines;
		}

		return {
			output: `${noticeLine}${body}`,
			truncated: this.#truncated,
			totalLines,
			totalBytes: this.#totalBytes,
			outputLines,
			outputBytes,
			elidedBytes,
			elidedLines,
			columnDroppedBytes: this.#columnDroppedBytes > 0 ? this.#columnDroppedBytes : undefined,
			columnTruncatedLines: this.#columnTruncatedLines > 0 ? this.#columnTruncatedLines : undefined,
			columnMax: this.#columnTruncatedLines > 0 ? this.#maxColumns : undefined,
			artifactId: this.#file?.artifactId,
		};
	}

	/**
	 * Flush any capped artifact tail and close the spill file descriptor,
	 * awaiting an in-flight sink creation so a descriptor opened by a late
	 * chunk is still released. Idempotent via {@link #finalized}: the artifact
	 * is finalized exactly once whether the caller reached {@link dump} or
	 * bailed through {@link dispose}. `#file` is left set so {@link dump} can
	 * still read `artifactId` for its summary.
	 */
	async #finalizeFile(): Promise<void> {
		if (this.#finalized) return;
		this.#finalized = true;
		if (this.#fileCreation) {
			await this.#fileCreation.catch(() => undefined);
		}
		const file = this.#file;
		if (!file) return;
		// The tail/notice replay writes to the sink and can throw (e.g. a disk
		// write error). Closing the descriptor MUST still happen — otherwise the
		// fd leaks and the replay error masks the original tool error that put us
		// on this path. Both failures are swallowed so dispose() never throws.
		try {
			this.#flushArtifactTailIfCapped();
		} catch {
			/* ignore */
		} finally {
			try {
				await file.sink.end();
			} catch {
				/* ignore */
			}
		}
	}

	/**
	 * Release the artifact spill descriptor on an exit path that skips
	 * {@link dump} — a thrown error or abort. Idempotent and safe in a
	 * `finally`: if {@link dump} already ran this is a no-op, otherwise it
	 * flushes the capped tail and closes the sink so the descriptor is not
	 * leaked until a later unrelated read hits `EMFILE` (issue #6463).
	 */
	async dispose(): Promise<void> {
		this.#clearPendingChunkTimer();
		await this.#finalizeFile();
	}
}

// =============================================================================
// Truncation notice formatting
// =============================================================================

/**
 * Format a truncation notice for tail-truncated output (bash, python, ssh).
 * Returns empty string if not truncated.
 */
export function formatTailTruncationNotice(
	truncation: TruncationResult,
	options: TailTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const { fullOutputPath, originalContent, suffix = "" } = options;
	const startLine = truncation.totalLines - (truncation.outputLines ?? truncation.totalLines) + 1;
	const endLine = truncation.totalLines;
	const fullOutputPart = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

	let notice: string;
	if (truncation.lastLinePartial) {
		let lastLineSizePart = "";
		if (originalContent) {
			const lastNl = originalContent.lastIndexOf(NL);
			const lastLine = lastNl === -1 ? originalContent : originalContent.substring(lastNl + 1);
			lastLineSizePart = ` (line is ${formatBytes(Buffer.byteLength(lastLine, "utf-8"))})`;
		}
		notice = `[Showing last ${formatBytes(truncation.outputBytes ?? truncation.totalBytes)} of line ${endLine}${lastLineSizePart}${fullOutputPart}${suffix}]`;
	} else {
		notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutputPart}${suffix}]`;
	}

	return `\n\n${notice}`;
}

/**
 * Format a truncation notice for head-truncated output (read tool).
 * Returns empty string if not truncated.
 */
export function formatHeadTruncationNotice(
	truncation: TruncationResult,
	options: HeadTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const startLineDisplay = options.startLine ?? 1;
	const totalFileLines = options.totalFileLines ?? truncation.totalLines;
	const endLineDisplay = startLineDisplay + (truncation.outputLines ?? truncation.totalLines) - 1;
	const nextOffset = endLineDisplay + 1;
	const notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use :${nextOffset} to continue]`;
	return `\n\n${notice}`;
}

// =============================================================================
// Streaming tail update helper (shared by bash/ssh tools)
// =============================================================================

/**
 * Build an onChunk handler that appends to a TailBuffer and emits a streaming
 * update (when `onUpdate` is defined) with the buffer's current text.
 */
export function streamTailUpdates<TDetails, TInput = unknown>(
	tailBuffer: TailBuffer,
	onUpdate: AgentToolUpdateCallback<TDetails, TInput> | undefined,
): (chunk: string) => void {
	return chunk => {
		tailBuffer.append(chunk);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: tailBuffer.text() }],
				details: {} as TDetails,
			});
		}
	};
}
