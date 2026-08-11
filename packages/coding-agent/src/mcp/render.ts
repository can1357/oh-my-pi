/**
 * TUI rendering for MCP tools.
 *
 * Provides structured display of MCP tool calls and results,
 * showing args and output in JSON tree format similar to task tool.
 */
import type { Component } from "@pk-nerdsaver-ai/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../tools/json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "../tools/output-meta";
import { formatExpandHint, truncateToWidth } from "../tools/render-utils";
import { renderStatusLine, WidthAwareText } from "../tui";
import type { MCPToolDetails } from "./tool-bridge";
import type { MCPJsonValue } from "./types";

function sortMCPJsonValue(value: MCPJsonValue): MCPJsonValue {
	if (Array.isArray(value)) return value.map(sortMCPJsonValue);
	if (value !== null && typeof value === "object") {
		const sorted: { [key: string]: MCPJsonValue } = {};
		for (const key of Object.keys(value).sort()) {
			Object.defineProperty(sorted, key, {
				value: sortMCPJsonValue(value[key]),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return sorted;
	}
	return value;
}

function renderMCPJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
	maxScalarLen: number,
): { lines: string[]; truncated: boolean } {
	// The shared tree renderer suppresses harness-only argument keys only at an
	// object root. Scalars and arrays can render directly; object results are
	// nested below a private wrapper and only that wrapper line is removed.
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return renderJsonTreeLines(value, theme, maxDepth, maxLines, maxScalarLen);
	}
	const wrapped = renderJsonTreeLines({ mcpResult: value }, theme, maxDepth + 1, maxLines + 1, maxScalarLen);
	return { lines: wrapped.lines.slice(1), truncated: wrapped.truncated };
}

function stripStructuredModelSuffix(
	text: string,
	formattedStructured: string | undefined,
	wasTruncated: boolean,
): string {
	if (!formattedStructured) return text;
	if (text.endsWith(formattedStructured)) {
		return text.slice(0, -formattedStructured.length);
	}
	if (!wasTruncated) return text;

	// Artifact spilling combines all text blocks and retains the source tail.
	// The generated structured block is the source suffix, so a spill may keep
	// only a suffix of it. Remove the longest common suffix before separately
	// rendering the complete structured value from details.
	let overlap = 0;
	const limit = Math.min(text.length, formattedStructured.length);
	while (
		overlap < limit &&
		text.charCodeAt(text.length - overlap - 1) ===
			formattedStructured.charCodeAt(formattedStructured.length - overlap - 1)
	) {
		overlap += 1;
	}
	return overlap > 0 ? text.slice(0, -overlap) : text;
}

/** Stable JSON representation shared by MCP model and UI output. */
export function formatMCPJsonValue(value: MCPJsonValue): string {
	return JSON.stringify(sortMCPJsonValue(value), null, 2);
}

/** Stable model/UI representation for MCP structured output. */
export function formatMCPStructuredContent(value: MCPJsonValue): string {
	return `Structured content:\n${formatMCPJsonValue(value)}`;
}

/**
 * Render MCP tool call.
 */
export function renderMCPCall(args: Record<string, unknown>, theme: Theme, label: string): Component {
	return new WidthAwareText(
		contentWidth => {
			const lines: string[] = [];
			lines.push(renderStatusLine({ icon: "pending", title: label }, theme));

			if (args && typeof args === "object" && Object.keys(args).length > 0) {
				// Inline preview budgeted against the render width, leaving room for
				// the ` └─ ` connector prefix instead of a fixed cap.
				const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(theme.tree.last) - 2);
				const preview = formatArgsInline(args, inlineBudget);
				if (preview) {
					lines.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
				}
			}

			return lines.join("\n");
		},
		0,
		0,
	);
}

/**
 * Render MCP tool result.
 */
export function renderMCPResult(
	result: {
		content: Array<{ type: string; text?: string; mimeType?: string }>;
		details?: MCPToolDetails;
		isError?: boolean;
	},
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const { expanded } = options;
	return new WidthAwareText(
		contentWidth => {
			const lines: string[] = [];
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			const success = !isError;
			lines.push(
				renderStatusLine(
					success ? { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title } : { icon: "error", title },
					theme,
				),
			);

			// Args section (when expanded)
			if (expanded && args && typeof args === "object" && Object.keys(args).length > 0) {
				lines.push(`${theme.fg("dim", "Args")}`);
				const maxDepth = JSON_TREE_MAX_DEPTH_EXPANDED;
				const maxLines = JSON_TREE_MAX_LINES_EXPANDED;
				const tree = renderJsonTreeLines(args, theme, maxDepth, maxLines, JSON_TREE_SCALAR_LEN_EXPANDED);
				for (const line of tree.lines) {
					lines.push(line);
				}
				if (tree.truncated) {
					lines.push(theme.fg("dim", "…"));
				}
				lines.push(""); // Blank line before output
			}

			// Output section. The bridge appends a deterministic text block for
			// structured content so the model receives it. Remove only that exact
			// generated block here and render the retained structured value as a
			// JSON tree, while preserving every server-provided text block.
			const structuredContent = result.details?.structuredContent;
			const formattedStructured =
				structuredContent === undefined ? undefined : formatMCPStructuredContent(structuredContent);
			const textBlocks: string[] = [];
			for (const item of result.content) {
				if (item.type === "text" && typeof item.text === "string") {
					textBlocks.push(item.text);
				} else if (item.type === "image") {
					textBlocks.push(`[Image: ${item.mimeType ?? "unknown"}]`);
				}
			}

			// Strip the LLM-facing spill notice before parsing/rendering: a spilled
			// result appends `[Showing… artifact://N]` to the body, which would break
			// JSON detection and bury the recovery link. Surface it as a styled warning
			// instead, mirroring the built-in read/bash/ssh/browser renderers.
			const withoutNotice = stripOutputNotice(textBlocks.join("\n\n"), result.details?.meta);
			const trimmedOutput = stripStructuredModelSuffix(
				withoutNotice,
				formattedStructured,
				result.details?.meta?.truncation !== undefined,
			).trimEnd();
			const truncationWarning = result.details?.meta?.truncation
				? formatStyledTruncationWarning(result.details.meta, theme)
				: null;

			if (!trimmedOutput && structuredContent === undefined) {
				lines.push(theme.fg("dim", "(no output)"));
				return lines.join("\n");
			}

			let renderedTextAsTree = false;
			if (
				trimmedOutput &&
				structuredContent === undefined &&
				(trimmedOutput.startsWith("{") || trimmedOutput.startsWith("["))
			) {
				try {
					const parsed: unknown = JSON.parse(trimmedOutput);
					const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
					const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
					const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
					const tree = renderMCPJsonTreeLines(parsed, theme, maxDepth, maxLines, maxScalarLen);
					if (tree.lines.length > 0) {
						lines.push(...tree.lines);
						renderedTextAsTree = true;
						if (!expanded) {
							lines.push(formatExpandHint(theme, expanded, true));
						} else if (tree.truncated) {
							lines.push(theme.fg("dim", "…"));
						}
					}
				} catch {
					// Fall through to raw output.
				}
			}

			if (trimmedOutput && !renderedTextAsTree) {
				const outputLines = trimmedOutput.split("\n");
				const maxOutputLines = expanded ? 12 : 4;
				const displayLines = outputLines.slice(0, maxOutputLines);
				for (const line of displayLines) {
					lines.push(theme.fg("toolOutput", truncateToWidth(line, contentWidth)));
				}
				if (outputLines.length > maxOutputLines) {
					const remaining = outputLines.length - maxOutputLines;
					lines.push(`${theme.fg("dim", `… ${remaining} more lines`)} ${formatExpandHint(theme, expanded, true)}`);
				} else if (!expanded && structuredContent === undefined) {
					lines.push(formatExpandHint(theme, expanded, true));
				}
			}

			if (structuredContent !== undefined) {
				if (trimmedOutput) lines.push("");
				lines.push(theme.fg("dim", "Structured content"));
				const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
				const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
				const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
				const tree = renderMCPJsonTreeLines(
					sortMCPJsonValue(structuredContent),
					theme,
					maxDepth,
					maxLines,
					maxScalarLen,
				);
				lines.push(...tree.lines);
				if (!expanded) {
					lines.push(formatExpandHint(theme, expanded, true));
				} else if (tree.truncated) {
					lines.push(theme.fg("dim", "…"));
				}
			}

			if (truncationWarning) lines.push(truncationWarning);
			return lines.join("\n");
		},
		0,
		0,
	);
}
