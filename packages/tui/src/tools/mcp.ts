/**
 * TUI rendering for MCP tools.
 *
 * Provides structured display of MCP tool calls and results,
 * showing args and output in JSON tree format similar to task tool.
 */
import { type Component, Markdown } from "../index";

import type { NativeToolHead, NativeToolView, RenderResultOptions } from "./renderer";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { ansi, md, node, span } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorText, noteText, truncationNotice } from "./native-view";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import {
	describeJsonValue,
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import { clipCollapsed, flattenLine, formatExpandHint, shortenEmbeddedPaths } from "../render/render-utils";
import { truncateToWidth, visibleWidth } from "../utils";
import { formatOutputPaneLines, styleToolOutputLine } from "../render/output-pane";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard, type ToolCardPhase } from "../render/tool-card";

/** Expanded Args tree shared by the MCP result cards. */
function buildMcpArgsSection(args: Record<string, unknown>, theme: Theme): readonly string[] {
	const lines: string[] = [theme.fg("dim", "Args")];
	const tree = renderJsonTreeLines(
		args,
		theme,
		JSON_TREE_MAX_DEPTH_EXPANDED,
		JSON_TREE_MAX_LINES_EXPANDED,
		JSON_TREE_SCALAR_LEN_EXPANDED,
	);
	lines.push(...tree.lines);
	if (tree.truncated) lines.push(theme.fg("dim", "…"));
	lines.push("");
	return lines;
}

/**
 * Render MCP tool call.
 */
export function renderMCPCall(args: Record<string, unknown>, theme: Theme, label: string): Component {
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const body: string[] = [];
			if (args && typeof args === "object" && Object.keys(args).length > 0) {
				// Inline preview budgeted against the render width, leaving room for
				// the ` └─ ` connector prefix instead of a fixed cap.
				const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(theme.tree.last) - 2);
				const preview = formatArgsInline(args, inlineBudget);
				if (preview) {
					body.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
				}
			}

			return {
				status: { icon: "pending", title: label },
				phase: "pending",
				body,
				applyBg: false,
			};
		},
		{ paddingX: 0, paddingY: 0 },
	);
}

/** Render an MCP status/args prefix followed by Markdown-aware text output. */
function renderMarkdownMCPResult(
	result: { details?: MCPToolDetails; isError?: boolean },
	trimmedOutput: string,
	truncationWarning: string | null,
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const markdown = new Markdown(trimmedOutput, 0, 0, getMarkdownTheme(), {
		color: text => theme.fg("toolOutput", text),
	});
	// Args tree and output pane rows are spinner-invariant; rebuild only on
	// expansion or width change instead of every animated frame.
	let bodyMemo: { expanded: boolean; width: number; lines: readonly string[] } | undefined;
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			if (bodyMemo === undefined || bodyMemo.expanded !== options.expanded || bodyMemo.width !== contentWidth) {
				bodyMemo = {
					expanded: options.expanded,
					width: contentWidth,
					lines: buildMarkdownMcpBody(markdown, truncationWarning, options.expanded, contentWidth, theme, args),
				};
			}
			const body = bodyMemo.lines;
			const status: StatusLineOptions = options.isPartial
				? {
						icon: options.spinnerFrame !== undefined ? "running" : "pending",
						spinnerFrame: options.spinnerFrame,
						title,
					}
				: isError
					? { icon: "error", title }
					: { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title };
			const phase: ToolCardPhase = options.isPartial ? "partial" : isError ? "error" : "success";
			return {
				status,
				phase,
				body,
				applyBg: false,
			};
		},
		{
			paddingX: 0,
			paddingY: 0,
			onInvalidate: () => (bodyMemo = undefined),
			onReleaseRenderCaches: () => {
				bodyMemo = undefined;
				markdown.releaseRenderCaches();
			},
		},
	);
}

function buildMarkdownMcpBody(
	markdown: Markdown,
	truncationWarning: string | null,
	expanded: boolean,
	contentWidth: number,
	theme: Theme,
	args: Record<string, unknown> | undefined,
): string[] {
	const body: string[] = [];
	if (expanded && args && Object.keys(args).length > 0) {
		body.push(...buildMcpArgsSection(args, theme));
	}
	const rendered = markdown.render(Math.max(1, contentWidth));
	body.push(
		...formatOutputPaneLines(
			{
				lines: rendered,
				expanded,
				collapsedMaxLines: 4,
				expandedMaxLines: 12,
				showExpandHintWhenUncapped: true,
			},
			theme,
		).lines,
	);
	if (truncationWarning) body.push(truncationWarning);
	return body;
}

/**
 * Render MCP tool result.
 */
export function renderMCPResult(
	result: { content: Array<{ type: string; text?: string }>; details?: MCPToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const { expanded } = options;
	const textContent = (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.filter(text => text.length > 0)
		.join("\n\n");
	const trimmedOutput = stripOutputNotice(textContent, result.details?.meta).trimEnd();
	const truncationWarning = result.details?.meta?.truncation
		? formatStyledTruncationWarning(result.details.meta, theme)
		: null;
	let parsedOutput: unknown;
	let isJsonOutput = false;
	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			parsedOutput = JSON.parse(trimmedOutput);
			isJsonOutput = true;
		} catch {
			// Non-JSON text beginning with a bracket is still eligible for Markdown.
		}
	}
	if (trimmedOutput && renderMarkdownResults && !isJsonOutput) {
		return renderMarkdownMCPResult(result, trimmedOutput, truncationWarning, options, theme, args);
	}
	// `expanded`, args and output are fixed for this card; only width varies the body.
	let bodyMemo: { width: number; lines: readonly string[] } | undefined;
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			const status: StatusLineOptions = options.isPartial
				? {
						icon: options.spinnerFrame !== undefined ? "running" : "pending",
						spinnerFrame: options.spinnerFrame,
						title,
					}
				: isError
					? { icon: "error", title }
					: { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title };
			const phase: ToolCardPhase = options.isPartial ? "partial" : isError ? "error" : "success";
			if (bodyMemo === undefined || bodyMemo.width !== contentWidth) {
				bodyMemo = { width: contentWidth, lines: buildMcpResultBody(contentWidth) };
			}
			return { status, phase, body: bodyMemo.lines, applyBg: false };
		},
		{
			paddingX: 0,
			paddingY: 0,
			onInvalidate: () => (bodyMemo = undefined),
			onReleaseRenderCaches: () => (bodyMemo = undefined),
		},
	);

	function buildMcpResultBody(contentWidth: number): string[] {
		const body: string[] = [];
		// Args section (when expanded)
		if (expanded && args && typeof args === "object" && Object.keys(args).length > 0) {
			body.push(...buildMcpArgsSection(args, theme));
		}

		// Output section. The body and spill metadata are normalized before
		// component selection so the opt-in Markdown path can use its own renderer.

		if (!trimmedOutput) {
			body.push(theme.fg("dim", "(no output)"));
			return body;
		}

		// Preserve the existing structured JSON renderer regardless of the
		// Markdown preference; JSON trees remain more useful than styled source.
		if (isJsonOutput) {
			const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
			const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
			const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
			const tree = renderJsonTreeLines(parsedOutput, theme, maxDepth, maxLines, maxScalarLen);

			if (tree.lines.length > 0) {
				body.push(...tree.lines);
				if (!expanded) {
					body.push(formatExpandHint(theme, expanded, true));
				} else if (tree.truncated) {
					body.push(theme.fg("dim", "…"));
				}
				if (truncationWarning) body.push(truncationWarning);
				return body;
			}
		}

		// Raw text output, capped to the first rows with an expand hint while collapsed.
		body.push(
			...formatOutputPaneLines(
				{
					lines: trimmedOutput.split("\n"),
					expanded,
					collapsedMaxLines: 4,
					expandedMaxLines: 12,
					styleLine: line => clipCollapsed(styleToolOutputLine(line, theme), contentWidth, expanded),
					showExpandHintWhenUncapped: true,
				},
				theme,
			).lines,
		);

		if (truncationWarning) body.push(truncationWarning);
		return body;
	}
}

/** Visible MCP argument entries (streaming/intent bookkeeping keys dropped). */
function visibleMcpArgs(args: Record<string, unknown> | undefined): [string, unknown][] {
	if (!args || typeof args !== "object") return [];
	return Object.entries(args).filter(([key]) => key !== INTENT_FIELD && key !== "__partialJson");
}

/** Inline args summary budget in characters (a data cap, not a width). */
const MCP_ARGS_SUMMARY_CHARS = 160;

/** Native MCP head: the tool title with a one-line args summary as target. */
function mcpHead(title: string, entries: readonly [string, unknown][]): NativeToolHead {
	const summary =
		entries.length > 0
			? formatArgsInline(Object.fromEntries(entries), MCP_ARGS_SUMMARY_CHARS, { characterBudget: true })
			: "";
	return { title, target: summary ? plainText(summary) : undefined, targetKind: "text" };
}

/**
 * Native counterpart of the ANSI card's Args tree: the complete arguments,
 * folded under an `Args` section because the head summary clips each value.
 * The host's `json` viewer, when it draws one, lists the arguments with their
 * containers folded to one-line previews.
 */
function mcpArgsSection(entries: readonly [string, unknown][], json: boolean): NativeNode | undefined {
	if (entries.length === 0) return undefined;
	return node(
		"section",
		{ head: [span("Args", "muted")], collapsible: true, collapsed: true },
		[describeJsonValue(Object.fromEntries(entries), { native: json })],
		"args",
	);
}

/** Native MCP call view: the head plus the folded args, inline while pending. */
export function describeMCPCall(
	args: Record<string, unknown>,
	label: string,
	options?: RenderResultOptions,
): NativeToolView {
	const entries = visibleMcpArgs(args);
	const section = mcpArgsSection(entries, options?.json === true);
	return { tool: mcpHead(label, entries), body: section ? [section] : undefined, inline: true };
}

const mcpResultMemo = new OwnerMemo<NativeToolView | undefined>();

/**
 * Native MCP result view: JSON output as the host's `json` viewer (when it
 * draws one) or a JSON tree, Markdown when the preference is on, otherwise
 * the raw text as tool output; the folded Args section follows, so the
 * collapsed preview still leads with the output.
 */
export function describeMCPResult(
	result: { content: Array<{ type: string; text?: string }>; details?: MCPToolDetails; isError?: boolean },
	options: RenderResultOptions,
	args?: Record<string, unknown>,
): NativeToolView | undefined {
	const json = options.json === true;
	// Callers allocate a fresh args object per streamed delta, so identity is a sound dep.
	return mcpResultMemo.get(result, [renderMarkdownResults, args, json], () => {
		const textContent = (result.content ?? [])
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.filter(text => text.length > 0)
			.join("\n\n");
		const output = stripOutputNotice(textContent, result.details?.meta).trimEnd();
		const isError = result.isError ?? result.details?.isError ?? false;
		const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
		const body: NativeChild[] = [];
		let parsed: unknown;
		let isJson = false;
		if (output.startsWith("{") || output.startsWith("[")) {
			try {
				parsed = JSON.parse(output);
				isJson = true;
			} catch {
				// Bracketed non-JSON text falls through to Markdown/raw output.
			}
		}
		if (!output) body.push(noteText("(no output)"));
		else if (isError) body.push(errorText(output));
		else if (isJson) body.push(describeJsonValue(parsed, { native: json }));
		else if (renderMarkdownResults) body.push(md(output));
		else body.push(ansi(output));
		const warning = truncationNotice(result.details?.meta);
		if (warning) body.push(warning);
		const entries = visibleMcpArgs(args);
		const section = mcpArgsSection(entries, json);
		if (section) body.push(section);
		return {
			tool: mcpHead(title, entries),
			tone: isError ? "error" : undefined,
			body,
			preview: { lines: 4 },
		};
	});
}

import type { OutputMeta } from "./output-meta";

let renderMarkdownResults = false;

/** Set whether plain MCP text results render as Markdown. */
export function setMcpRenderMarkdownResults(enabled: boolean): void {
	renderMarkdownResults = enabled;
}

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

/** Base64-encoded image returned by an MCP tool. */
export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** Embedded text or binary resource returned by an MCP tool. */
export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

/** Supported MCP result content blocks retained in display metadata. */
export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** Server-reported progress of an in-flight MCP request. */
export interface MCPProgress {
	progress: number;
	total?: number;
	message?: string;
}

/**
 * Read MCP progress fields from an untrusted record: `progress` must be a
 * finite number; `total` is kept only when finite and `message` only when a
 * string. Shared by the transports, the Eval bridge, and the status renderer.
 */
export function parseMCPProgress(value: unknown): MCPProgress | undefined {
	if (!isRecord(value) || typeof value.progress !== "number" || !Number.isFinite(value.progress)) return undefined;
	const progress: MCPProgress = { progress: value.progress };
	if (typeof value.total === "number" && Number.isFinite(value.total)) progress.total = value.total;
	if (typeof value.message === "string") progress.message = value.message;
	return progress;
}

/**
 * One-line display text for MCP progress, at most `maxWidth` cells: the
 * message, with `progress/total` when the server reports a total. The bare
 * progress value appears only when there is no message: without a total it is
 * an opaque counter, not a percentage. Home paths in the message show as `~`,
 * and a long message is cut before the count, so the count stays visible.
 * Every progress display (tool card and both Eval status renderers) uses it.
 */
export function formatMCPProgress(progress: MCPProgress, maxWidth = 200): string {
	const message =
		progress.message === undefined ? "" : shortenEmbeddedPaths(flattenLine(sanitizeText(progress.message)));
	const amount = progress.total === undefined ? `${progress.progress}` : `${progress.progress}/${progress.total}`;
	if (!message) return truncateToWidth(amount, maxWidth);
	if (progress.total === undefined) return truncateToWidth(message, maxWidth);
	const suffix = ` (${amount})`;
	const messageWidth = maxWidth - visibleWidth(suffix);
	return messageWidth > 0 ? `${truncateToWidth(message, messageWidth)}${suffix}` : truncateToWidth(amount, maxWidth);
}

/** MCP result details shared by renderers and programmatic tool consumers. */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
	/** Server-supplied structured data, independent of the model-facing text rendering. */
	structuredContent?: Record<string, unknown>;
	/** Structured metadata from the MCP response */
	mcpMeta?: Record<string, unknown>;
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Latest progress of a running call; present only on partial updates. */
	progress?: MCPProgress;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}

/** Registry prefix every minted MCP tool name carries. */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;

	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}
