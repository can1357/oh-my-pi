/**
 * Exa TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for Exa search results.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import type { RenderResultOptions } from "../../custom-tools/types.js";
import { logViewError } from "./logger.js";
import type { ExaRenderDetails } from "./types.js";

// Tree formatting constants
const TREE_MID = "├─";
const TREE_END = "└─";
const TREE_PIPE = "│";
const TREE_SPACE = " ";
const TREE_HOOK = "⎿";

/** Truncate text to max length with ellipsis */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 1)}…`;
}

/** Extract domain from URL */
function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** Get first N lines of text as preview */
function getPreviewLines(text: string, maxLines: number, maxLineLen: number): string[] {
	const lines = text.split("\n").filter((l) => l.trim());
	return lines.slice(0, maxLines).map((l) => truncate(l.trim(), maxLineLen));
}

/** Render Exa result with tree-based layout */
export function renderExaResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ExaRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const { expanded } = options;
	const details = result.details;

	// Handle error case
	if (details?.error) {
		logViewError("Exa render error", { error: details.error, toolName: details.toolName });
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const response = details?.response;
	if (!response) {
		// Non-search response: show raw result
		if (details?.raw) {
			const rawText = typeof details.raw === "string" ? details.raw : JSON.stringify(details.raw, null, 2);
			const preview = expanded ? rawText : truncate(rawText, 200);
			const toolLabel = details?.toolName ?? "Exa";
			return new Text(
				`${theme.fg("success", "●")} ${theme.fg("toolTitle", toolLabel)}\n ${theme.fg("dim", TREE_PIPE)}  ${preview}`,
				0,
				0,
			);
		}
		return new Text(theme.fg("error", "No response data"), 0, 0);
	}

	const results = response.results ?? [];
	const resultCount = results.length;
	const cost = response.costDollars?.total;
	const time = response.searchTime;

	// Build header: ● Exa Search · N results · $X.XX · Xs
	const icon = resultCount > 0 ? theme.fg("success", "●") : theme.fg("warning", "●");
	const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
	const toolLabel = details?.toolName ?? "Exa Search";

	let headerParts = `${icon} ${theme.fg("toolTitle", toolLabel)} · ${theme.fg(
		"dim",
		`${resultCount} result${resultCount !== 1 ? "s" : ""}`,
	)}`;

	if (cost !== undefined) {
		headerParts += ` · ${theme.fg("muted", `$${cost.toFixed(4)}`)}`;
	}
	if (time !== undefined) {
		headerParts += ` · ${theme.fg("muted", `${time.toFixed(2)}s`)}`;
	}

	let text = headerParts + expandHint;

	if (!expanded) {
		// Collapsed view: show 3-line preview from first result
		if (resultCount > 0) {
			const first = results[0];
			const previewText = first.text ?? first.title ?? "";
			const previewLines = getPreviewLines(previewText, 3, 100);

			for (const line of previewLines) {
				text += `\n ${theme.fg("dim", TREE_PIPE)}  ${theme.fg("dim", line)}`;
			}

			const totalLines = previewText.split("\n").filter((l) => l.trim()).length;
			if (totalLines > 3) {
				text += `\n ${theme.fg("dim", TREE_PIPE)}  ${theme.fg("muted", `… ${totalLines - 3} more lines`)}`;
			}

			if (resultCount > 1) {
				text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg(
					"muted",
					`${resultCount - 1} more result${resultCount !== 2 ? "s" : ""}`,
				)}`;
			}
		}
	} else {
		// Expanded view: full results tree
		if (resultCount > 0) {
			text += `\n ${theme.fg("dim", TREE_PIPE)}`;
			text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("accent", "Results")}`;

			for (let i = 0; i < results.length; i++) {
				const res = results[i];
				const isLast = i === results.length - 1;
				const branch = isLast ? TREE_END : TREE_MID;
				const cont = isLast ? TREE_SPACE : TREE_PIPE;

				// Title + domain
				const title = truncate(res.title ?? "Untitled", 60);
				const domain = res.url ? getDomain(res.url) : "";
				const domainPart = domain ? theme.fg("dim", ` (${domain})`) : "";

				text += `\n ${theme.fg("dim", TREE_SPACE)} ${theme.fg("dim", branch)} ${theme.fg(
					"accent",
					title,
				)}${domainPart}`;

				// URL
				if (res.url) {
					text += `\n ${theme.fg("dim", cont)}   ${theme.fg("dim", TREE_HOOK)} ${theme.fg("mdLinkUrl", res.url)}`;
				}

				// Author
				if (res.author) {
					text += `\n ${theme.fg("dim", cont)}   ${theme.fg("muted", `Author: ${res.author}`)}`;
				}

				// Published date
				if (res.publishedDate) {
					text += `\n ${theme.fg("dim", cont)}   ${theme.fg("muted", `Published: ${res.publishedDate}`)}`;
				}

				// Text content
				if (res.text) {
					const textLines = res.text.split("\n").filter((l) => l.trim());
					const displayLines = textLines.slice(0, 5); // Show first 5 lines
					for (const line of displayLines) {
						text += `\n ${theme.fg("dim", cont)}   ${truncate(line.trim(), 90)}`;
					}
					if (textLines.length > 5) {
						text += `\n ${theme.fg("dim", cont)}   ${theme.fg("muted", `… ${textLines.length - 5} more lines`)}`;
					}
				}

				// Highlights
				if (res.highlights?.length) {
					text += `\n ${theme.fg("dim", cont)}   ${theme.fg("accent", "Highlights:")}`;
					for (let j = 0; j < Math.min(res.highlights.length, 3); j++) {
						const h = res.highlights[j];
						text += `\n ${theme.fg("dim", cont)}   ${theme.fg("muted", `• ${truncate(h, 80)}`)}`;
					}
					if (res.highlights.length > 3) {
						text += `\n ${theme.fg("dim", cont)}   ${theme.fg("muted", `… ${res.highlights.length - 3} more`)}`;
					}
				}
			}
		}
	}

	return new Text(text, 0, 0);
}

/** Render Exa call (query/args preview) */
export function renderExaCall(args: Record<string, unknown>, toolName: string, theme: Theme): Component {
	const query = typeof args.query === "string" ? truncate(args.query, 80) : "";
	const numResults = typeof args.num_results === "number" ? args.num_results : undefined;
	const detail = numResults ? theme.fg("dim", ` (${numResults} results)`) : "";

	const text = `${theme.fg("toolTitle", toolName)} ${theme.fg("muted", query)}${detail}`;
	return new Text(text, 0, 0);
}
