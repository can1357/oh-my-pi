/**
 * Structured metadata for tool outputs.
 *
 * Tools populate details.meta using the fluent OutputMetaBuilder.
 * The tool wrapper automatically formats and appends notices at message boundary.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolExecFn,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Setting } from "../config/registry";
import type { Settings } from "../config/settings";

import {
	type OutputSummary,
	type TruncationResult,
	truncateMiddle,
	truncateTail,
} from "@oh-my-pi/pi-tui/tools/streaming-output";
import { formatOutputNotice, type OutputMeta, type TruncationMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { renderError } from "./tool-errors";
import {
	cfgToolsArtifactHeadBytes,
	cfgToolsArtifactSpillThreshold,
	cfgToolsArtifactTailBytes,
	cfgToolsArtifactTailLines,
	cfgToolsOutputMaxColumns,
} from "./settings";

/** Input for {@link OutputMetaBuilder.limits}. `columnUnit` defaults to `chars`. */
export interface LimitsInput {
	matchLimit?: number;
	resultLimit?: number;
	headLimit?: number;
	columnMax?: number;
	columnUnit?: "bytes" | "chars";
}

// =============================================================================
// OutputMetaBuilder - Fluent API for building OutputMeta
// =============================================================================

/** Metadata supplied when recording a truncated tool result. */
export interface TruncationMetaInput {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
	artifactId?: string;
	/** Byte budget that stopped the read, when truncation is byte-limited. */
	maxBytes?: number;
	/** Override the derived continuation line; `null` suppresses an unsafe continuation hint. */
	nextOffset?: number | null;
}

export interface TruncationSummaryOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
}

export interface TruncationTextOptions {
	direction: "head" | "tail" | "middle";
	totalLines?: number;
	totalBytes?: number;
	maxBytes?: number;
}

/**
 * Fluent builder for OutputMeta.
 *
 * @example
 * ```ts
 * details.meta = outputMeta()
 *   .truncation(truncation, { direction: "head" })
 *   .matchLimit(limitReached ? effectiveLimit : 0)
 *   .columnTruncated(linesTruncated ? DEFAULT_MAX_COLUMN : 0)
 *   .get();
 * ```
 */
export class OutputMetaBuilder {
	#meta: OutputMeta = {};

	/** Add truncation info from TruncationResult. No-op if not truncated. */
	truncation(result: TruncationResult, options: TruncationMetaInput): this {
		if (!result.truncated) return this;

		const { direction, startLine = 1, totalFileLines, artifactId, maxBytes } = options;
		const outputLines = result.outputLines ?? result.totalLines;
		const outputBytes = result.outputBytes ?? result.totalBytes;
		const isMiddle = direction === "middle" || result.truncatedBy === "middle";
		const truncatedBy: "lines" | "bytes" | "middle" = isMiddle
			? "middle"
			: result.truncatedBy === "lines"
				? "lines"
				: "bytes";

		const effectiveTotalLines = totalFileLines ?? result.totalLines;

		if (result.firstLineExceedsLimit) {
			// The window collected no complete line; the body is a byte-capped
			// preview of one oversized line. Describe that partial line instead of
			// deriving an empty range that renders "Showing 0 of N lines".
			this.#meta.truncation = {
				direction,
				truncatedBy: "bytes",
				totalLines: effectiveTotalLines,
				totalBytes: result.totalBytes,
				outputLines,
				outputBytes,
				shownRange: { start: startLine, end: startLine },
				partialLine: true,
				artifactId,
			};
			return this;
		}

		if (isMiddle) {
			const elidedLines = result.elidedLines ?? Math.max(0, effectiveTotalLines - outputLines);
			const elidedBytes = result.elidedBytes ?? Math.max(0, result.totalBytes - outputBytes);
			// Reconstruct head/tail line ranges. The kept output spans the first
			// `headLines` lines and the last `tailLines` lines of the source; lines
			// in the middle (count == elidedLines) are dropped.
			const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
			const headLines = result.headLines ?? Math.ceil(keptLines / 2);
			const tailLines = result.tailLines ?? keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				totalLines: effectiveTotalLines,
				totalBytes: result.totalBytes,
				outputLines,
				outputBytes,
				...(effectiveTotalLines > 1 && !result.partialByteWindows
					? {
							headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
							tailRange:
								tailLines > 0
									? { start: effectiveTotalLines - tailLines + 1, end: effectiveTotalLines }
									: undefined,
						}
					: {}),
				elidedLines,
				elidedBytes,
				artifactId,
			};
			return this;
		}

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = result.totalLines - outputLines + 1;
			shownEnd = result.totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines: effectiveTotalLines,
			totalBytes: result.totalBytes,
			outputLines,
			outputBytes,
			maxBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset:
				direction === "head"
					? options.nextOffset === null
						? undefined
						: (options.nextOffset ?? shownEnd + 1)
					: undefined,
		};

		return this;
	}

	/** Add truncation, column limits, and capture failures from OutputSummary. */
	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		if (summary.artifactError) this.#meta.artifactError = summary.artifactError;
		// A per-line column cap only trims individual lines (with a `…` marker);
		// it is not a window/byte truncation, so surface it as its own limit
		// notice rather than a "Showing lines X-Y … limit" range. This runs even
		// when the output is otherwise complete (`truncated === false`). The sink
		// enforces the cap in UTF-8 bytes, so the notice must say "bytes".
		if (summary.columnMax != null && summary.columnMax > 0 && (summary.columnTruncatedLines ?? 0) > 0) {
			this.columnTruncated(summary.columnMax, "bytes", summary.artifactId);
		}
		if (!summary.truncated) return this;

		const { direction, startLine = 1, totalFileLines } = options;
		const totalLines = totalFileLines ?? summary.totalLines;
		const artifactId = summary.artifactError ? undefined : summary.artifactId;

		// Middle elision: the sink retained head + tail with an elision marker.
		if (summary.elidedBytes != null && summary.elidedBytes > 0) {
			const elidedLines = summary.elidedLines ?? Math.max(0, totalLines - summary.outputLines);
			const keptLines = Math.max(0, summary.outputLines - 1); // -1 for marker line
			const headLines = Math.ceil(keptLines / 2);
			const tailLines = keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
				tailRange: tailLines > 0 ? { start: totalLines - tailLines + 1, end: totalLines } : undefined,
				elidedBytes: summary.elidedBytes,
				elidedLines,
				artifactId,
			};
			return this;
		}

		const truncatedBy: "lines" | "bytes" =
			summary.outputBytes < summary.totalBytes
				? "bytes"
				: summary.outputLines < summary.totalLines
					? "lines"
					: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = totalLines - summary.outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + summary.outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from truncated output text. No-op if truncation not detected. */
	truncationFromText(text: string, options: TruncationTextOptions): this {
		const outputLines = text.length > 0 ? text.split("\n").length : 0;
		const outputBytes = Buffer.byteLength(text, "utf-8");
		const totalLines = options.totalLines ?? outputLines;
		const totalBytes = options.totalBytes ?? outputBytes;

		const truncated = totalLines > outputLines || totalBytes > outputBytes || false;
		if (!truncated) return this;

		const truncatedBy: "lines" | "bytes" =
			options.maxBytes && outputBytes >= options.maxBytes
				? "bytes"
				: totalBytes > outputBytes
					? "bytes"
					: totalLines > outputLines
						? "lines"
						: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (options.direction === "tail") {
			shownStart = totalLines - outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = 1;
			shownEnd = outputLines;
		}

		this.#meta.truncation = {
			direction: options.direction,
			truncatedBy,
			totalLines,
			totalBytes,
			outputLines,
			outputBytes,
			maxBytes: options.maxBytes,
			shownRange: { start: shownStart, end: shownEnd },
			nextOffset: options.direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add match limit notice. No-op if reached <= 0. */
	matchLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, matchLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notices in one call. */
	limits(limits: LimitsInput): this {
		if (limits.matchLimit !== undefined) {
			this.matchLimit(limits.matchLimit);
		}
		if (limits.resultLimit !== undefined) {
			this.resultLimit(limits.resultLimit);
		}
		if (limits.headLimit !== undefined) {
			this.headLimit(limits.headLimit);
		}
		if (limits.columnMax !== undefined) {
			this.columnTruncated(limits.columnMax, limits.columnUnit);
		}
		return this;
	}

	/** Add result limit notice. No-op if reached <= 0. */
	resultLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, resultLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notice for head truncation. No-op if reached <= 0. */
	headLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, headLimit: { reached, suggestion } };
		return this;
	}

	/**
	 * Add column truncation notice. No-op if maxColumn <= 0. `unit` names the
	 * unit the producer enforced the cap in — `"bytes"` for the streaming sink
	 * and grep's UTF-8 caps, `"chars"` (UTF-16 code units) for the read path.
	 *
	 * When `artifactId` is supplied the sink mirrored the raw, uncapped stream
	 * into that artifact; the rendered notice then advertises it as a recovery
	 * pointer (see {@link formatOutputNotice}), matching the tail-truncation notice.
	 */
	columnTruncated(maxColumn: number, unit: "bytes" | "chars" = "chars", artifactId?: string): this {
		if (maxColumn <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, columnTruncated: { maxColumn, unit, artifactId } };
		return this;
	}

	/** Add source path info. */
	sourcePath(value: string): this {
		this.#meta.source = { type: "path", value };
		return this;
	}

	/** Add source URL info. */
	sourceUrl(value: string): this {
		this.#meta.source = { type: "url", value };
		return this;
	}

	/** Add internal URL source info (skill://, agent://, artifact://). */
	sourceInternal(value: string): this {
		this.#meta.source = { type: "internal", value };
		return this;
	}

	/** Mark the output as a bounded page of session artifact storage its source re-reads with line selectors ({@link OutputMeta.pagedSource}). */
	pagedSource(): this {
		this.#meta.pagedSource = true;
		return this;
	}

	/** Add LSP diagnostics. No-op if no messages. */
	diagnostics(summary: string, messages: string[]): this {
		if (messages.length === 0) return this;
		this.#meta.diagnostics = { summary, messages };
		return this;
	}

	/** Get the built OutputMeta, or undefined if empty. */
	get(): OutputMeta | undefined {
		return Object.keys(this.#meta).length > 0 ? this.#meta : undefined;
	}
}

/** Create a new OutputMetaBuilder. */
export function outputMeta(): OutputMetaBuilder {
	return new OutputMetaBuilder();
}

// =============================================================================
// Notice formatting
// =============================================================================

// =============================================================================
// Tool wrapper
// =============================================================================

/**
 * Append output notice to tool result content if meta is present.
 */
function appendOutputNotice(
	content: (TextContent | ImageContent)[],
	meta: OutputMeta | undefined,
): (TextContent | ImageContent)[] {
	const notice = formatOutputNotice(meta);
	if (!notice) return content;

	const result = [...content];
	for (let i = result.length - 1; i >= 0; i--) {
		const item = result[i];
		if (item.type === "text") {
			result[i] = { ...item, text: item.text + notice };
			return result;
		}
	}

	result.push({ type: "text", text: notice.trim() });
	return result;
}

const kUnwrappedExecute = Symbol("OutputMeta.UnwrappedExecute");

// =============================================================================
// Centralized artifact spill for large tool results
// =============================================================================

/** Resolved artifact spill config sourced from the session settings (or schema defaults). */
function getSpillConfig(s: Settings | undefined) {
	const get = (setting: Setting<number>) => (s ? setting.get(s) : setting.default);
	return {
		threshold: get(cfgToolsArtifactSpillThreshold) * 1024,
		tailBytes: get(cfgToolsArtifactTailBytes) * 1024,
		tailLines: get(cfgToolsArtifactTailLines),
		headBytes: get(cfgToolsArtifactHeadBytes) * 1024,
	};
}

/**
 * Resolve the OutputSink `headBytes` budget from session settings.
 * Exposed so streaming executors (bash/python/ssh/eval) can opt into
 * middle elision with the same per-user configuration.
 */
export function resolveOutputSinkHeadBytes(s: Settings | undefined): number {
	return getSpillConfig(s).headBytes;
}

/**
 * Slack on top of the configured spill threshold before the final-defense
 * inline byte cap fires. The OutputSink already bounds inline bodies to the
 * threshold; only notice slop (wall time, exit code, elision marker,
 * `[raw output: artifact://N]` footer) rides above it. The slack keeps the
 * cap a genuine last resort for paths that bypass the sink (e.g. ACP
 * client-bridge terminals) instead of re-truncating — and re-saving — every
 * sink-elided result (the double-artifact `Artifact: N+1` vs `artifact://N`
 * mismatch).
 */
const INLINE_CAP_SLACK_BYTES = 2 * 1024;

/**
 * Resolve the `enforceInlineByteCap` budget for streaming tools (bash/ssh)
 * from session settings: the user's spill threshold plus notice slack.
 */
export function resolveInlineByteCapBudget(s: Settings | undefined): number {
	return getSpillConfig(s).threshold + INLINE_CAP_SLACK_BYTES;
}

/**
 * Resolve the per-line column cap from session settings. Shared by streaming
 * executors (bash/python/ssh/eval via OutputSink) and the `read` tool's
 * line-buffer post-processing, so one setting controls both surfaces.
 */
export function resolveOutputMaxColumns(s: Settings | undefined): number {
	return s ? cfgToolsOutputMaxColumns.get(s) : cfgToolsOutputMaxColumns.default;
}

/**
 * If the tool result text exceeds the spill threshold, save the full output
 * as a session artifact and replace the content with a head+tail (middle
 * elision) view plus an artifact reference. When `tools.artifactHeadBytes`
 * is 0, falls back to tail-only truncation. Skips when the tool already
 * saved its own artifact (e.g. bash/python via OutputSink).
 */
async function spillLargeResultToArtifact(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
): Promise<AgentToolResult> {
	const sessionManager = context?.sessionManager;
	if (!sessionManager) return result;
	const { threshold, tailBytes, tailLines, headBytes } = getSpillConfig(context?.settings);

	// Skip if tool already saved an artifact
	const existingMeta: OutputMeta | undefined = result.details?.meta;
	if (existingMeta?.truncation?.artifactId) return result;

	// A bounded page of artifact storage its source URL re-reads with `:N-M` is already
	// recoverable. Spilling it would only create a redundant artifact holding another
	// artifact's page (and can repeat indefinitely on subsequent artifact reads).
	if (existingMeta?.pagedSource) return result;

	// Measure total text content
	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		}
	}
	if (textParts.length === 0) return result;

	const fullText = textParts.length === 1 ? textParts[0] : textParts.join("\n");
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= threshold) return result;

	// Save the full output as an artifact so the elided bytes stay recoverable.
	// In a persistent session this hits `Bun.write`, which can throw (disk full,
	// permissions). The spill wraps arbitrary tools (built-in, MCP, extension,
	// RPC-host); a save failure must never convert a successful call into an
	// error, nor re-expose the full (possibly context-blowing) output. Mirror
	// `enforceInlineByteCap`: always truncate past the threshold, and only
	// attach the `artifact://` recovery link when the save actually succeeded.
	let artifactId: string | undefined;
	// A failed stream capture only left a preview here. Saving that preview
	// would invent a misleading full-output recovery link, not recover the log.
	if (!existingMeta?.artifactError) {
		try {
			artifactId = await sessionManager.saveArtifact(fullText, toolName);
		} catch (error) {
			logger.warn("Failed to spill large tool result to artifact", {
				tool: toolName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Truncate: middle elision when a head budget is configured, otherwise tail-only.
	const useMiddle = headBytes > 0;
	const truncated = useMiddle
		? truncateMiddle(fullText, {
				maxBytes: headBytes + tailBytes,
				maxLines: tailLines * 2,
				maxHeadBytes: headBytes,
				maxHeadLines: tailLines,
			})
		: truncateTail(fullText, {
				maxBytes: tailBytes,
				maxLines: tailLines,
			});

	// Replace text blocks with single truncated block, keep images
	const newContent: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		if (block.type !== "text") {
			newContent.push(block);
		}
	}
	newContent.push({ type: "text", text: truncated.content });

	// Build truncation meta
	const outputLines = truncated.outputLines ?? truncated.totalLines;
	const outputBytes = truncated.outputBytes ?? truncated.totalBytes;
	let truncationMeta: TruncationMeta;
	if (truncated.truncatedBy === "middle") {
		const elidedLines = truncated.elidedLines ?? Math.max(0, truncated.totalLines - outputLines);
		const elidedBytes = truncated.elidedBytes ?? Math.max(0, truncated.totalBytes - outputBytes);
		const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
		const headLines = truncated.headLines ?? Math.ceil(keptLines / 2);
		const tailLineCount = truncated.tailLines ?? keptLines - headLines;
		truncationMeta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: headBytes + tailBytes,
			...(truncated.totalLines > 1 && !truncated.partialByteWindows
				? {
						headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
						tailRange:
							tailLineCount > 0
								? { start: truncated.totalLines - tailLineCount + 1, end: truncated.totalLines }
								: undefined,
					}
				: {}),
			elidedLines,
			elidedBytes,
			artifactId,
			nextOffset: existingMeta?.truncation?.nextOffset,
		};
	} else {
		const shownStart = truncated.totalLines - outputLines + 1;
		truncationMeta = {
			direction: "tail",
			truncatedBy: truncated.truncatedBy ?? "bytes",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: tailBytes,
			shownRange: { start: shownStart, end: truncated.totalLines },
			artifactId,
			nextOffset: existingMeta?.truncation?.nextOffset,
		};
	}

	const newMeta: OutputMeta = { ...existingMeta, truncation: truncationMeta };
	const newDetails = { ...result.details, meta: newMeta };

	// Prune the raw payload only MCP results duplicate into `details.rawContent`.
	// Identify them by the required `serverName` + `mcpToolName` markers (the same
	// signature the MCP renderer uses) so a property-name collision on an
	// SDK/extension tool's intentionally unconstrained details can never trigger
	// this transformation. Everything already stored elsewhere is dropped so
	// `rawContent` cannot re-inflate the on-disk size: text blocks and
	// `resource.text` are captured verbatim by the artifact, and image data
	// survives on the result content (and eval's `images`). Resource URI/MIME/blob
	// metadata has no other home, so it is retained.
	if (
		typeof newDetails.serverName === "string" &&
		typeof newDetails.mcpToolName === "string" &&
		Array.isArray(newDetails.rawContent)
	) {
		const structuredContent: unknown[] = [];
		for (const block of newDetails.rawContent) {
			if (!isRecord(block)) {
				structuredContent.push(block);
				continue;
			}
			// Text and image payloads live in the artifact / result content.
			if (block.type === "text" || block.type === "image") continue;
			// Resource text is folded into the artifact; keep the rest of the resource.
			if (block.type === "resource" && isRecord(block.resource) && "text" in block.resource) {
				const resource = { ...block.resource };
				delete resource.text;
				structuredContent.push({ ...block, resource });
				continue;
			}
			structuredContent.push(block);
		}
		if (structuredContent.length > 0) {
			newDetails.rawContent = structuredContent;
		} else {
			delete newDetails.rawContent;
		}
	}

	return { ...result, content: newContent, details: newDetails };
}

// =============================================================================
// Tool wrapper
// =============================================================================

export async function postProcessToolResult(
	result: AgentToolResult,
	toolName: string,
	context?: AgentToolContext,
): Promise<AgentToolResult> {
	const processed = await spillLargeResultToArtifact(result, toolName, context);
	const meta: OutputMeta | undefined = processed.details?.meta;
	return meta ? { ...processed, content: appendOutputNotice(processed.content, meta) } : processed;
}

async function wrappedExecute(
	this: AgentTool & { [kUnwrappedExecute]: AgentToolExecFn },
	toolCallId: string,
	params: any,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
	context?: AgentToolContext,
): Promise<AgentToolResult> {
	const originalExecute = this[kUnwrappedExecute];

	try {
		let result = await originalExecute.call(this, toolCallId, params, signal, onUpdate, context);

		// Spill large results to artifact, truncate to tail
		result = await spillLargeResultToArtifact(result, this.name, context);

		// Append notices from meta
		const meta: OutputMeta | undefined = result.details?.meta;
		if (meta) {
			return {
				...result,
				content: appendOutputNotice(result.content, meta),
			};
		}
		return result;
	} catch (e) {
		// Re-throw with formatted message so agent-loop sets isError flag
		throw new Error(renderError(e));
	}
}

/**
 * Wrap a tool to:
 * 1. Automatically append output notices based on details.meta
 * 2. Handle ToolError rendering
 */
export function wrapToolWithMetaNotice<T extends AgentTool<any, any, any>>(tool: T): T {
	if (kUnwrappedExecute in tool) {
		return tool;
	}

	const originalExecute = tool.execute;

	return Object.defineProperties(tool, {
		[kUnwrappedExecute]: {
			value: originalExecute,
			enumerable: false,
			configurable: true,
		},
		execute: {
			value: wrappedExecute,
			enumerable: false,
			configurable: true,
			writable: true,
		},
	});
}
