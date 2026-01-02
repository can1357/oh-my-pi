/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { RenderResultOptions } from "../custom-tools/types.js";
import type { AskToolDetails } from "./ask.js";
import type { FindToolDetails } from "./find.js";
import type { GrepToolDetails } from "./grep.js";
import type { LsToolDetails } from "./ls.js";
import { renderCall as renderLspCall, renderResult as renderLspResult } from "./lsp/render.js";
import type { LspToolDetails } from "./lsp/types.js";
import type { NotebookToolDetails } from "./notebook.js";
import { renderCall as renderTaskCall, renderResult as renderTaskResult } from "./task/render.js";
import type { TaskToolDetails } from "./task/types.js";
import { renderWebFetchCall, renderWebFetchResult, type WebFetchToolDetails } from "./web-fetch.js";
import { renderWebSearchCall, renderWebSearchResult, type WebSearchRenderDetails } from "./web-search/render.js";

// Tree drawing characters
const TREE_MID = "├─";
const TREE_END = "└─";

// Icons
const ICON_SUCCESS = "●";
const ICON_WARNING = "●";
const ICON_ERROR = "●";

interface ToolRenderer<TArgs = any, TDetails = any> {
	renderCall(args: TArgs, theme: Theme): Component;
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TDetails },
		options: RenderResultOptions,
		theme: Theme,
	): Component;
}

// ============================================================================
// Grep Renderer
// ============================================================================

interface GrepArgs {
	pattern: string;
	path?: string;
	glob?: string;
	type?: string;
	ignoreCase?: boolean;
	caseSensitive?: boolean;
	literal?: boolean;
	multiline?: boolean;
	context?: number;
	limit?: number;
	outputMode?: string;
}

const grepRenderer: ToolRenderer<GrepArgs, GrepToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("grep "));
		text += theme.fg("accent", args.pattern || "?");

		const meta: string[] = [];
		if (args.path) meta.push(args.path);
		if (args.glob) meta.push(`glob:${args.glob}`);
		if (args.type) meta.push(`type:${args.type}`);
		if (args.outputMode && args.outputMode !== "files_with_matches") meta.push(args.outputMode);
		if (args.caseSensitive) {
			meta.push("--case-sensitive");
		} else if (args.ignoreCase) {
			meta.push("-i");
		}
		if (args.multiline) meta.push("multiline");

		if (meta.length > 0) {
			text += ` ${theme.fg("muted", meta.join(" "))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;

		// Error case
		if (details?.error) {
			return new Text(`${theme.fg("error", ICON_ERROR)} ${theme.fg("error", details.error)}`, 0, 0);
		}

		// Check for detailed rendering data - fall back to raw output if not available
		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			// Fall back to showing raw text content
			const textContent = result.content?.find((c) => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(`${theme.fg("warning", ICON_WARNING)} ${theme.fg("muted", "No matches found")}`, 0, 0);
			}

			// Show abbreviated output
			const lines = textContent.split("\n");
			const maxLines = expanded ? lines.length : 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			let text = `${theme.fg("success", ICON_SUCCESS)} ${theme.fg("toolTitle", "grep")}`;
			text += `\n${displayLines.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
			if (remaining > 0) {
				text += `\n${theme.fg("muted", `... ${remaining} more lines`)}`;
			}
			return new Text(text, 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const mode = details?.mode ?? "files_with_matches";
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		// No matches
		if (matchCount === 0) {
			return new Text(`${theme.fg("warning", ICON_WARNING)} ${theme.fg("muted", "No matches found")}`, 0, 0);
		}

		// Build summary
		const icon = theme.fg("success", ICON_SUCCESS);
		let summary: string;
		if (mode === "files_with_matches") {
			summary = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		} else if (mode === "count") {
			summary = `${matchCount} match${matchCount !== 1 ? "es" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		} else {
			summary = `${matchCount} match${matchCount !== 1 ? "es" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		}

		if (truncated) {
			summary += theme.fg("warning", " (truncated)");
		}

		const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
		let text = `${icon} ${theme.fg("toolTitle", "grep")} ${theme.fg("dim", summary)}${expandHint}`;

		// Show file tree if we have files
		if (files.length > 0) {
			const maxFiles = expanded ? files.length : Math.min(files.length, 8);
			for (let i = 0; i < maxFiles; i++) {
				const isLast = i === maxFiles - 1 && (expanded || files.length <= 8);
				const branch = isLast ? TREE_END : TREE_MID;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", files[i])}`;
			}

			if (!expanded && files.length > 8) {
				text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${files.length - 8} more files`)}`;
			}
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Find Renderer
// ============================================================================

interface FindArgs {
	pattern: string;
	path?: string;
	type?: string;
	hidden?: boolean;
	sortByMtime?: boolean;
	limit?: number;
}

const findRenderer: ToolRenderer<FindArgs, FindToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("find "));
		text += theme.fg("accent", args.pattern || "*");

		const meta: string[] = [];
		if (args.path) meta.push(args.path);
		if (args.type && args.type !== "all") meta.push(`type:${args.type}`);
		if (args.hidden) meta.push("--hidden");

		if (meta.length > 0) {
			text += ` ${theme.fg("muted", meta.join(" "))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;

		// Error case
		if (details?.error) {
			return new Text(`${theme.fg("error", ICON_ERROR)} ${theme.fg("error", details.error)}`, 0, 0);
		}

		// Check for detailed rendering data - fall back to parsing raw output if not available
		const hasDetailedData = details?.fileCount !== undefined;

		// Get text content for fallback or to extract file list
		const textContent = result.content?.find((c) => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (!textContent || textContent.includes("No files matching") || textContent.trim() === "") {
				return new Text(`${theme.fg("warning", ICON_WARNING)} ${theme.fg("muted", "No files found")}`, 0, 0);
			}

			// Parse the raw output as file list
			const lines = textContent.split("\n").filter((l) => l.trim());
			const maxLines = expanded ? lines.length : Math.min(lines.length, 8);
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			let text = `${theme.fg("success", ICON_SUCCESS)} ${theme.fg("toolTitle", "find")} ${theme.fg(
				"dim",
				`${lines.length} file${lines.length !== 1 ? "s" : ""}`,
			)}`;
			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? TREE_END : TREE_MID;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", displayLines[i])}`;
			}
			if (remaining > 0) {
				text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${remaining} more files`)}`;
			}
			return new Text(text, 0, 0);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		// No matches
		if (fileCount === 0) {
			return new Text(`${theme.fg("warning", ICON_WARNING)} ${theme.fg("muted", "No files found")}`, 0, 0);
		}

		// Build summary
		const icon = theme.fg("success", ICON_SUCCESS);
		let summary = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;

		if (truncated) {
			summary += theme.fg("warning", " (truncated)");
		}

		const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
		let text = `${icon} ${theme.fg("toolTitle", "find")} ${theme.fg("dim", summary)}${expandHint}`;

		// Show file tree if we have files
		if (files.length > 0) {
			const maxFiles = expanded ? files.length : Math.min(files.length, 8);
			for (let i = 0; i < maxFiles; i++) {
				const isLast = i === maxFiles - 1 && (expanded || files.length <= 8);
				const branch = isLast ? TREE_END : TREE_MID;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", files[i])}`;
			}

			if (!expanded && files.length > 8) {
				text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${files.length - 8} more files`)}`;
			}
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Notebook Renderer
// ============================================================================

interface NotebookArgs {
	action: string;
	notebookPath: string;
	cellNumber?: number;
	cellType?: string;
	content?: string;
}

const notebookRenderer: ToolRenderer<NotebookArgs, NotebookToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("notebook "));
		text += theme.fg("accent", args.action || "?");

		const meta: string[] = [];
		meta.push(args.notebookPath || "?");
		if (args.cellNumber !== undefined) meta.push(`cell:${args.cellNumber}`);
		if (args.cellType) meta.push(args.cellType);

		if (meta.length > 0) {
			text += ` ${theme.fg("muted", meta.join(" "))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, _options, theme) {
		const details = result.details;

		// Error case - check for error in content
		const content = result.content?.[0];
		if (content?.type === "text" && content.text?.startsWith("Error:")) {
			return new Text(`${theme.fg("error", ICON_ERROR)} ${theme.fg("error", content.text)}`, 0, 0);
		}

		const action = details?.action ?? "edit";
		const cellIndex = details?.cellIndex;
		const cellType = details?.cellType;
		const totalCells = details?.totalCells;

		// Build summary
		const icon = theme.fg("success", ICON_SUCCESS);
		let summary: string;

		switch (action) {
			case "insert":
				summary = `Inserted ${cellType || "cell"} at index ${cellIndex}`;
				break;
			case "delete":
				summary = `Deleted cell at index ${cellIndex}`;
				break;
			default:
				summary = `Edited ${cellType || "cell"} at index ${cellIndex}`;
		}

		if (totalCells !== undefined) {
			summary += ` (${totalCells} total)`;
		}

		return new Text(`${icon} ${theme.fg("toolTitle", "notebook")} ${theme.fg("dim", summary)}`, 0, 0);
	},
};

// ============================================================================
// Ask Renderer
// ============================================================================

interface AskArgs {
	question: string;
	options?: Array<{ label: string }>;
	multi?: boolean;
}

const askRenderer: ToolRenderer<AskArgs, AskToolDetails> = {
	renderCall(args, theme) {
		if (!args.question) {
			return new Text(theme.fg("error", "ask: no question provided"), 0, 0);
		}

		const multiTag = args.multi ? theme.fg("muted", " [multi-select]") : "";
		let text = theme.fg("toolTitle", "? ") + theme.fg("accent", args.question) + multiTag;

		if (args.options?.length) {
			for (const opt of args.options) {
				text += `\n${theme.fg("dim", "  ○ ")}${theme.fg("muted", opt.label)}`;
			}
			text += `\n${theme.fg("dim", "  ○ ")}${theme.fg("muted", "Other (custom input)")}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, _opts, theme) {
		const { details } = result;
		if (!details) {
			const txt = result.content[0];
			return new Text(txt?.type === "text" && txt.text ? txt.text : "", 0, 0);
		}

		let text = theme.fg("toolTitle", "? ") + theme.fg("accent", details.question);

		if (details.customInput) {
			// Custom input provided
			text += `\n${theme.fg("dim", "  ⎿ ")}${theme.fg("success", details.customInput)}`;
		} else if (details.selectedOptions.length > 0) {
			// Show only selected options
			const selected = details.selectedOptions;
			if (selected.length === 1) {
				text += `\n${theme.fg("dim", "  ⎿ ")}${theme.fg("success", selected[0])}`;
			} else {
				// Multiple selections - tree format
				for (let i = 0; i < selected.length; i++) {
					const isLast = i === selected.length - 1;
					const branch = isLast ? TREE_END : TREE_MID;
					text += `\n${theme.fg("dim", `  ${branch} `)}${theme.fg("success", selected[i])}`;
				}
			}
		} else {
			text += `\n${theme.fg("dim", "  ⎿ ")}${theme.fg("warning", "Cancelled")}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Export
// ============================================================================

// ============================================================================
// LSP Renderer
// ============================================================================

interface LspArgs {
	action: string;
	file?: string;
	files?: string[];
	line?: number;
	column?: number;
}

const lspRenderer: ToolRenderer<LspArgs, LspToolDetails> = {
	renderCall: renderLspCall,
	renderResult: renderLspResult,
};

// ============================================================================
// Task Renderer
// ============================================================================

const taskRenderer: ToolRenderer<any, TaskToolDetails> = {
	renderCall: renderTaskCall,
	renderResult: renderTaskResult,
};

// ============================================================================
// Ls Renderer
// ============================================================================

interface LsArgs {
	path?: string;
	limit?: number;
}

const lsRenderer: ToolRenderer<LsArgs, LsToolDetails> = {
	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("ls "));
		text += theme.fg("accent", args.path || ".");
		if (args.limit !== undefined) {
			text += ` ${theme.fg("muted", `(limit ${args.limit})`)}`;
		}
		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details;
		const textContent = result.content?.find((c: any) => c.type === "text")?.text;

		if (!textContent || textContent.trim() === "") {
			return new Text(`${theme.fg("warning", ICON_WARNING)} ${theme.fg("muted", "Empty directory")}`, 0, 0);
		}

		const entries = textContent.split("\n").filter((l: string) => l.trim());
		const dirs = entries.filter((e: string) => e.endsWith("/"));
		const files = entries.filter((e: string) => !e.endsWith("/"));

		const truncated = details?.truncation?.truncated || details?.entryLimitReached;
		const icon = truncated ? theme.fg("warning", ICON_WARNING) : theme.fg("success", ICON_SUCCESS);

		let summary = `${dirs.length} dir${dirs.length !== 1 ? "s" : ""}, ${files.length} file${
			files.length !== 1 ? "s" : ""
		}`;
		if (truncated) {
			summary += theme.fg("warning", " (truncated)");
		}

		const expandHint = expanded ? "" : theme.fg("dim", " (Ctrl+O to expand)");
		let text = `${icon} ${theme.fg("toolTitle", "ls")} ${theme.fg("dim", summary)}${expandHint}`;

		const maxEntries = expanded ? entries.length : Math.min(entries.length, 12);
		for (let i = 0; i < maxEntries; i++) {
			const entry = entries[i];
			const isLast = i === maxEntries - 1 && (expanded || entries.length <= 12);
			const branch = isLast ? TREE_END : TREE_MID;
			const isDir = entry.endsWith("/");
			const color = isDir ? "accent" : "toolOutput";
			text += `\n ${theme.fg("dim", branch)} ${theme.fg(color, entry)}`;
		}

		if (!expanded && entries.length > 12) {
			text += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${entries.length - 12} more entries`)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Web Fetch Renderer
// ============================================================================

interface WebFetchArgs {
	url: string;
	timeout?: number;
	raw?: boolean;
}

const webFetchRenderer: ToolRenderer<WebFetchArgs, WebFetchToolDetails> = {
	renderCall: renderWebFetchCall,
	renderResult: renderWebFetchResult,
};

// ============================================================================
// Web Search Renderer
// ============================================================================

interface WebSearchArgs {
	query: string;
	provider?: string;
	[key: string]: unknown;
}

const webSearchRenderer: ToolRenderer<WebSearchArgs, WebSearchRenderDetails> = {
	renderCall: renderWebSearchCall,
	renderResult: renderWebSearchResult,
};

// ============================================================================
// Export
// ============================================================================

export const toolRenderers: Record<
	string,
	{
		renderCall: (args: any, theme: Theme) => Component;
		renderResult: (result: any, options: RenderResultOptions, theme: Theme) => Component;
	}
> = {
	ask: askRenderer,
	grep: grepRenderer,
	find: findRenderer,
	notebook: notebookRenderer,
	ls: lsRenderer,
	lsp: lspRenderer,
	task: taskRenderer,
	web_fetch: webFetchRenderer,
	web_search: webSearchRenderer,
};
