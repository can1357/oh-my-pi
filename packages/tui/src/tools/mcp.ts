/**
 * TUI rendering for MCP tools.
 *
 * Provides structured display of MCP tool calls and results,
 * showing args and output in JSON tree format similar to task tool.
 */
import { type Component, Markdown } from "../index";

import type { RenderResultOptions } from "./renderer";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import {
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
import { formatExpandHint, truncateToWidth } from "../render/render-utils";
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
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			const body: string[] = [];
			if (options.expanded && args && Object.keys(args).length > 0) {
				body.push(...buildMcpArgsSection(args, theme));
			}

			const rendered = markdown.render(Math.max(1, contentWidth));
			body.push(
				...formatOutputPaneLines(
					{
						lines: rendered,
						expanded: options.expanded,
						collapsedMaxLines: 4,
						expandedMaxLines: 12,
						showExpandHintWhenUncapped: true,
					},
					theme,
				).lines,
			);
			if (truncationWarning) body.push(truncationWarning);
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
		{ paddingX: 0, paddingY: 0 },
	);
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
			const body: string[] = [];

			// Args section (when expanded)
			if (expanded && args && typeof args === "object" && Object.keys(args).length > 0) {
				body.push(...buildMcpArgsSection(args, theme));
			}

			// Output section. The body and spill metadata are normalized before
			// component selection so the opt-in Markdown path can use its own renderer.

			if (!trimmedOutput) {
				body.push(theme.fg("dim", "(no output)"));
				return { status, phase, body, applyBg: false };
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
					return { status, phase, body, applyBg: false };
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
						styleLine: line => truncateToWidth(styleToolOutputLine(line, theme), contentWidth),
						showExpandHintWhenUncapped: true,
					},
					theme,
				).lines,
			);

			if (truncationWarning) body.push(truncationWarning);
			return { status, phase, body, applyBg: false };
		},
		{ paddingX: 0, paddingY: 0 },
	);
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
