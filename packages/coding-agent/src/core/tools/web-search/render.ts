/**
 * Web Search TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for web search results.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import type { RenderResultOptions } from "../../custom-tools/types.js";
import type { WebSearchResponse } from "./types.js";

// Tree formatting constants
const TREE_MID = "├─";
const TREE_END = "└─";
const TREE_PIPE = "│";
const TREE_SPACE = " ";
const TREE_HOOK = "⎿";

/** Truncate text to max length with ellipsis */
export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 1)}…`;
}

/** Extract domain from URL */
export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** Format age string from seconds */
export function formatAge(ageSeconds: number | null | undefined): string {
	if (!ageSeconds) return "";
	const mins = Math.floor(ageSeconds / 60);
	const hours = Math.floor(mins / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);

	if (months > 0) return `${months}mo ago`;
	if (weeks > 0) return `${weeks}w ago`;
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (mins > 0) return `${mins}m ago`;
	return "just now";
}

/** Get first N lines of text as preview */
export function getPreviewLines(text: string, maxLines: number, maxLineLen: number): string[] {
	const lines = text.split("\n").filter((l) => l.trim());
	return lines.slice(0, maxLines).map((l) => truncate(l.trim(), maxLineLen));
}

export interface WebSearchRenderDetails {
	response: WebSearchResponse;
	error?: string;
}

/** Render web search result with tree-based layout */
export function renderWebSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: WebSearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const { expanded } = options;
	const details = result.details;

	// Handle error case
	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const response = details?.response;
	if (!response) {
		return new Text(theme.fg("error", "No response data"), 0, 0);
	}

	const sources = response.sources ?? [];
	const sourceCount = sources.length;
	const _modelName = response.model ?? response.provider;
	const provider = response.provider;

	// Build header: ● Web Search (provider/model) · N sources
	const icon = sourceCount > 0 ? theme.fg("success", "●") : theme.fg("warning", "●");
	const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
	const providerLabel = provider === "anthropic" ? "Anthropic" : "Perplexity";
	let text = `${icon} ${theme.fg("toolTitle", "Web Search")} ${theme.fg("dim", `(${providerLabel})`)} · ${theme.fg(
		"dim",
		`${sourceCount} source${sourceCount !== 1 ? "s" : ""}`,
	)}${expandHint}`;

	// Get answer text
	const contentText = response.answer ?? result.content[0]?.text ?? "";

	if (!expanded) {
		// Collapsed view: show 2-3 preview lines of answer
		const previewLines = getPreviewLines(contentText, 3, 100);
		for (const line of previewLines) {
			text += `\n ${theme.fg("dim", TREE_PIPE)}  ${theme.fg("dim", line)}`;
		}
		const totalLines = contentText.split("\n").filter((l) => l.trim()).length;
		if (totalLines > 3) {
			text += `\n ${theme.fg("dim", TREE_PIPE)}  ${theme.fg("muted", `… ${totalLines - 3} more lines`)}`;
		}

		// Show source count summary
		if (sourceCount > 0) {
			text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg(
				"muted",
				`${sourceCount} source${sourceCount !== 1 ? "s" : ""}`,
			)}`;
		}
	} else {
		// Expanded view: full answer + source tree
		const answerLines = contentText.split("\n");
		for (const line of answerLines) {
			text += `\n ${theme.fg("dim", TREE_PIPE)}  ${line}`;
		}

		// Render sources as tree
		const hasRelatedQuestions = response.relatedQuestions && response.relatedQuestions.length > 0;

		if (sourceCount > 0) {
			text += `\n ${theme.fg("dim", TREE_PIPE)}`;
			const sourcesBranch = hasRelatedQuestions ? TREE_MID : TREE_END;
			text += `\n ${theme.fg("dim", sourcesBranch)} ${theme.fg("accent", "Sources")}`;

			for (let i = 0; i < sources.length; i++) {
				const src = sources[i];
				const isLast = i === sources.length - 1;
				const branch = isLast ? TREE_END : TREE_MID;
				const cont = isLast ? TREE_SPACE : TREE_PIPE;
				const indent = hasRelatedQuestions ? TREE_PIPE : TREE_SPACE;

				// Title + domain + age
				const title = truncate(src.title, 60);
				const domain = getDomain(src.url);
				const age = formatAge(src.ageSeconds) || src.publishedDate;
				const agePart = age ? theme.fg("muted", ` · ${age}`) : "";

				text += `\n ${theme.fg("dim", indent)} ${theme.fg("dim", branch)} ${theme.fg("accent", title)} ${theme.fg(
					"dim",
					`(${domain})`,
				)}${agePart}`;
				text += `\n ${theme.fg("dim", indent)} ${theme.fg("dim", `${cont}  ${TREE_HOOK} `)}${theme.fg(
					"mdLinkUrl",
					src.url,
				)}`;
			}
		}

		// Render related questions (Perplexity only)
		if (hasRelatedQuestions) {
			text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("accent", "Related Questions")}`;
			const questions = response.relatedQuestions!;
			for (let i = 0; i < questions.length; i++) {
				const question = questions[i];
				const isLast = i === questions.length - 1;
				const branch = isLast ? TREE_END : TREE_MID;
				text += `\n ${theme.fg("dim", TREE_SPACE)} ${theme.fg("dim", branch)} ${theme.fg("muted", question)}`;
			}
		}
	}

	return new Text(text, 0, 0);
}

/** Render web search call (query preview) */
export function renderWebSearchCall(
	args: { query: string; provider?: string; [key: string]: unknown },
	theme: Theme,
): Component {
	const provider = args.provider ?? "auto";
	const query = truncate(args.query, 80);
	const text = `${theme.fg("toolTitle", "Web Search")} ${theme.fg("dim", `(${provider})`)} ${theme.fg("muted", query)}`;
	return new Text(text, 0, 0);
}
