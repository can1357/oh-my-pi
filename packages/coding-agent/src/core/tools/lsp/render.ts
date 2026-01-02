/**
 * LSP Tool TUI Rendering
 *
 * Renders LSP tool calls and results in the TUI with:
 * - Syntax-highlighted hover information
 * - Color-coded diagnostics by severity
 * - Grouped references and symbols
 * - Collapsible/expandable views
 */

import type { AgentToolResult, RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { highlight, supportsLanguage } from "cli-highlight";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import type { LspParams, LspToolDetails } from "./types.js";

// =============================================================================
// Tree Drawing Characters
// =============================================================================

const TREE_MID = "├─";
const TREE_END = "└─";
const TREE_PIPE = "│";

// =============================================================================
// Call Rendering
// =============================================================================

/**
 * Render the LSP tool call in the TUI.
 * Shows: "lsp <operation> <file/filecount>"
 */
export function renderCall(args: unknown, theme: Theme): Text {
	const p = args as LspParams & { file?: string; files?: string[] };

	let text = theme.fg("toolTitle", theme.bold("LSP "));
	text += theme.fg("accent", p.action || "?");

	if (p.file) {
		text += ` ${theme.fg("muted", p.file)}`;
	} else if (p.files?.length) {
		text += ` ${theme.fg("muted", `${p.files.length} file(s)`)}`;
	}

	return new Text(text, 0, 0);
}

// =============================================================================
// Result Rendering
// =============================================================================

/**
 * Render LSP tool result with intelligent formatting based on result type.
 * Detects hover, diagnostics, references, symbols, etc. and formats accordingly.
 */
export function renderResult(
	result: AgentToolResult<LspToolDetails>,
	options: RenderResultOptions,
	theme: Theme,
): Text {
	const content = result.content?.[0];
	if (!content || content.type !== "text" || !("text" in content) || !content.text) {
		return new Text(theme.fg("error", "No result"), 0, 0);
	}

	const text = content.text;
	const lines = text.split("\n").filter((l) => l.trim());
	const expanded = options.expanded;

	// Detect result type and render accordingly
	const codeBlockMatch = text.match(/```(\w*)\n([\s\S]*?)```/);
	if (codeBlockMatch) {
		return renderHover(codeBlockMatch, text, lines, expanded, theme);
	}

	const errorMatch = text.match(/(\d+)\s+error\(s\)/);
	const warningMatch = text.match(/(\d+)\s+warning\(s\)/);
	if (errorMatch || warningMatch || text.includes("✗")) {
		return renderDiagnostics(errorMatch, warningMatch, lines, expanded, theme);
	}

	const refMatch = text.match(/(\d+)\s+reference\(s\)/);
	if (refMatch) {
		return renderReferences(refMatch, lines, expanded, theme);
	}

	const symbolsMatch = text.match(/Symbols in (.+):/);
	if (symbolsMatch) {
		return renderSymbols(symbolsMatch, lines, expanded, theme);
	}

	// Default fallback rendering
	return renderGeneric(text, lines, expanded, theme);
}

// =============================================================================
// Hover Rendering
// =============================================================================

/**
 * Render hover information with syntax-highlighted code blocks.
 */
function renderHover(
	codeBlockMatch: RegExpMatchArray,
	fullText: string,
	_lines: string[],
	expanded: boolean,
	theme: Theme,
): Text {
	const lang = codeBlockMatch[1] || "";
	const code = codeBlockMatch[2].trim();
	const afterCode = fullText.slice(fullText.indexOf("```", 3) + 3).trim();

	const codeLines = highlightCode(code, lang, theme);
	const icon = theme.fg("accent", "●");
	const langLabel = lang ? theme.fg("mdCodeBlockBorder", ` ${lang}`) : "";

	if (expanded) {
		let output = `${icon} ${theme.fg("toolTitle", "Hover")}${langLabel}`;
		output += `\n ${theme.fg("mdCodeBlockBorder", "┌───")}`;
		for (const line of codeLines) {
			output += `\n ${theme.fg("mdCodeBlockBorder", "│")} ${line}`;
		}
		output += `\n ${theme.fg("mdCodeBlockBorder", "└───")}`;
		if (afterCode) {
			output += `\n ${theme.fg("muted", afterCode)}`;
		}
		return new Text(output, 0, 0);
	}

	// Collapsed view
	const firstCodeLine = codeLines[0] || "";
	const expandHint = theme.fg("dim", " (Ctrl+O to expand)");

	let output = `${icon} ${theme.fg("toolTitle", "Hover")}${langLabel}${expandHint}`;
	output += `\n ${theme.fg("mdCodeBlockBorder", "│")} ${firstCodeLine}`;

	if (codeLines.length > 1) {
		output += `\n ${theme.fg("mdCodeBlockBorder", "│")} ${theme.fg("muted", `… ${codeLines.length - 1} more lines`)}`;
	}

	if (afterCode) {
		const docPreview = afterCode.length > 60 ? `${afterCode.slice(0, 60)}…` : afterCode;
		output += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", docPreview)}`;
	} else {
		output += `\n ${theme.fg("mdCodeBlockBorder", "└───")}`;
	}

	return new Text(output, 0, 0);
}

/**
 * Syntax highlight code using highlight.ts.
 */
function highlightCode(codeText: string, language: string, theme: Theme): string[] {
	const validLang = language && supportsLanguage(language) ? language : undefined;
	try {
		const cliTheme = {
			keyword: (s: string) => theme.fg("syntaxKeyword", s),
			built_in: (s: string) => theme.fg("syntaxType", s),
			literal: (s: string) => theme.fg("syntaxNumber", s),
			number: (s: string) => theme.fg("syntaxNumber", s),
			string: (s: string) => theme.fg("syntaxString", s),
			comment: (s: string) => theme.fg("syntaxComment", s),
			function: (s: string) => theme.fg("syntaxFunction", s),
			title: (s: string) => theme.fg("syntaxFunction", s),
			class: (s: string) => theme.fg("syntaxType", s),
			type: (s: string) => theme.fg("syntaxType", s),
			attr: (s: string) => theme.fg("syntaxVariable", s),
			variable: (s: string) => theme.fg("syntaxVariable", s),
			params: (s: string) => theme.fg("syntaxVariable", s),
			operator: (s: string) => theme.fg("syntaxOperator", s),
			punctuation: (s: string) => theme.fg("syntaxPunctuation", s),
		};
		return highlight(codeText, { language: validLang, ignoreIllegals: true, theme: cliTheme }).split("\n");
	} catch {
		return codeText.split("\n");
	}
}

// =============================================================================
// Diagnostics Rendering
// =============================================================================

/**
 * Render diagnostics with color-coded severity.
 */
function renderDiagnostics(
	errorMatch: RegExpMatchArray | null,
	warningMatch: RegExpMatchArray | null,
	lines: string[],
	expanded: boolean,
	theme: Theme,
): Text {
	const errorCount = errorMatch ? Number.parseInt(errorMatch[1], 10) : 0;
	const warnCount = warningMatch ? Number.parseInt(warningMatch[1], 10) : 0;

	const icon =
		errorCount > 0 ? theme.fg("error", "●") : warnCount > 0 ? theme.fg("warning", "●") : theme.fg("success", "●");

	const meta: string[] = [];
	if (errorCount > 0) meta.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);
	if (warnCount > 0) meta.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
	if (meta.length === 0) meta.push("No issues");

	const diagLines = lines.filter((l) => l.includes("✗") || /:\d+:\d+/.test(l));

	if (expanded) {
		let output = `${icon} ${theme.fg("toolTitle", "Diagnostics")} ${theme.fg("dim", meta.join(", "))}`;
		for (let i = 0; i < diagLines.length; i++) {
			const isLast = i === diagLines.length - 1;
			const branch = isLast ? TREE_END : TREE_MID;
			const line = diagLines[i].trim();
			const color = line.includes("[error]") ? "error" : line.includes("[warning]") ? "warning" : "dim";
			output += `\n ${theme.fg("dim", branch)} ${theme.fg(color, line)}`;
		}
		return new Text(output, 0, 0);
	}

	// Collapsed view
	const expandHint = theme.fg("dim", " (Ctrl+O to expand)");
	let output = `${icon} ${theme.fg("toolTitle", "Diagnostics")} ${theme.fg("dim", meta.join(", "))}${expandHint}`;

	const previewLines = diagLines.length > 0 ? diagLines.slice(0, 4) : lines.slice(0, 4);
	for (let i = 0; i < previewLines.length; i++) {
		const isLast = i === previewLines.length - 1 && diagLines.length <= 4;
		const branch = isLast ? TREE_END : TREE_MID;
		output += `\n ${theme.fg("dim", branch)} ${previewLines[i].trim()}`;
	}
	if (diagLines.length > 4) {
		output += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${diagLines.length - 4} more`)}`;
	}

	return new Text(output, 0, 0);
}

// =============================================================================
// References Rendering
// =============================================================================

/**
 * Render references grouped by file.
 */
function renderReferences(refMatch: RegExpMatchArray, lines: string[], expanded: boolean, theme: Theme): Text {
	const refCount = Number.parseInt(refMatch[1], 10);
	const icon = refCount > 0 ? theme.fg("success", "●") : theme.fg("warning", "●");

	const locLines = lines.filter((l) => /^\s*\S+:\d+:\d+/.test(l));

	// Group by file
	const byFile = new Map<string, Array<[string, string]>>();
	for (const loc of locLines) {
		const match = loc.trim().match(/^(.+):(\d+):(\d+)$/);
		if (match) {
			const [, file, line, col] = match;
			if (!byFile.has(file)) byFile.set(file, []);
			byFile.get(file)!.push([line, col]);
		}
	}

	const files = Array.from(byFile.keys());

	const renderGrouped = (maxFiles: number, maxLocsPerFile: number, showHint: boolean): string => {
		const expandHint = showHint ? theme.fg("dim", " (Ctrl+O to expand)") : "";
		let output = `${icon} ${theme.fg("toolTitle", "References")} ${theme.fg("dim", `${refCount} found`)}${expandHint}`;

		const filesToShow = files.slice(0, maxFiles);
		for (let fi = 0; fi < filesToShow.length; fi++) {
			const file = filesToShow[fi];
			const locs = byFile.get(file)!;
			const isLastFile = fi === filesToShow.length - 1 && files.length <= maxFiles;
			const fileBranch = isLastFile ? TREE_END : TREE_MID;
			const fileCont = isLastFile ? "   " : `${TREE_PIPE}  `;

			if (locs.length === 1) {
				output += `\n ${theme.fg("dim", fileBranch)} ${theme.fg("accent", file)}:${theme.fg(
					"muted",
					`${locs[0][0]}:${locs[0][1]}`,
				)}`;
			} else {
				output += `\n ${theme.fg("dim", fileBranch)} ${theme.fg("accent", file)}`;

				const locsToShow = locs.slice(0, maxLocsPerFile);
				const locStrs = locsToShow.map(([l, c]) => `${l}:${c}`);
				const locsText = locStrs.join(", ");
				const hasMore = locs.length > maxLocsPerFile;

				output += `\n ${theme.fg("dim", fileCont)}${theme.fg("dim", TREE_END)} ${theme.fg("muted", locsText)}`;
				if (hasMore) {
					output += theme.fg("dim", ` … +${locs.length - maxLocsPerFile} more`);
				}
			}
		}

		if (files.length > maxFiles) {
			output += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${files.length - maxFiles} more files`)}`;
		}

		return output;
	};

	if (expanded) {
		return new Text(renderGrouped(files.length, 30, false), 0, 0);
	}

	return new Text(renderGrouped(4, 10, true), 0, 0);
}

// =============================================================================
// Symbols Rendering
// =============================================================================

/**
 * Render document symbols in a hierarchical tree.
 */
function renderSymbols(symbolsMatch: RegExpMatchArray, lines: string[], expanded: boolean, theme: Theme): Text {
	const fileName = symbolsMatch[1];
	const icon = theme.fg("accent", "●");

	interface SymbolInfo {
		name: string;
		line: string;
		indent: number;
	}

	const symbolLines = lines.filter((l) => l.includes("@") && l.includes("line"));
	const symbols: SymbolInfo[] = [];

	for (const line of symbolLines) {
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		const symMatch = line.trim().match(/^(.+?)\s*@\s*line\s*(\d+)/);
		if (symMatch) {
			symbols.push({ name: symMatch[1], line: symMatch[2], indent });
		}
	}

	const isLastSibling = (i: number): boolean => {
		const myIndent = symbols[i].indent;
		for (let j = i + 1; j < symbols.length; j++) {
			const nextIndent = symbols[j].indent;
			if (nextIndent === myIndent) return false;
			if (nextIndent < myIndent) return true;
		}
		return true;
	};

	const getPrefix = (i: number): string => {
		const myIndent = symbols[i].indent;
		if (myIndent === 0) return " ";

		let prefix = " ";
		for (let level = 2; level <= myIndent; level += 2) {
			let ancestorIdx = -1;
			for (let j = i - 1; j >= 0; j--) {
				if (symbols[j].indent === level - 2) {
					ancestorIdx = j;
					break;
				}
			}
			if (ancestorIdx >= 0 && isLastSibling(ancestorIdx)) {
				prefix += "   ";
			} else {
				prefix += `${TREE_PIPE}  `;
			}
		}
		return prefix;
	};

	const topLevelCount = symbols.filter((s) => s.indent === 0).length;

	if (expanded) {
		let output = `${icon} ${theme.fg("toolTitle", "Symbols")} ${theme.fg("dim", `in ${fileName}`)}`;

		for (let i = 0; i < symbols.length; i++) {
			const sym = symbols[i];
			const prefix = getPrefix(i);
			const branch = isLastSibling(i) ? TREE_END : TREE_MID;
			output += `\n${prefix}${theme.fg("dim", branch)} ${theme.fg("accent", sym.name)} ${theme.fg(
				"muted",
				`@${sym.line}`,
			)}`;
		}
		return new Text(output, 0, 0);
	}

	// Collapsed: show first 4 top-level symbols
	const expandHint = theme.fg("dim", " (Ctrl+O to expand)");
	let output = `${icon} ${theme.fg("toolTitle", "Symbols")} ${theme.fg("dim", `in ${fileName}`)}${expandHint}`;

	const topLevel = symbols.filter((s) => s.indent === 0).slice(0, 4);
	for (let i = 0; i < topLevel.length; i++) {
		const sym = topLevel[i];
		const isLast = i === topLevel.length - 1 && topLevelCount <= 4;
		const branch = isLast ? TREE_END : TREE_MID;
		output += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", sym.name)} ${theme.fg("muted", `@${sym.line}`)}`;
	}
	if (topLevelCount > 4) {
		output += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${topLevelCount - 4} more`)}`;
	}

	return new Text(output, 0, 0);
}

// =============================================================================
// Generic Rendering
// =============================================================================

/**
 * Generic fallback rendering for unknown result types.
 */
function renderGeneric(text: string, lines: string[], expanded: boolean, theme: Theme): Text {
	const hasError = text.includes("Error:") || text.includes("✗");
	const hasSuccess = text.includes("✓") || text.includes("Applied");

	const icon =
		hasError && !hasSuccess
			? theme.fg("error", "●")
			: hasSuccess && !hasError
				? theme.fg("success", "●")
				: theme.fg("accent", "●");

	if (expanded) {
		let output = `${icon} ${theme.fg("toolTitle", "LSP")}`;
		for (const line of lines) {
			output += `\n ${line}`;
		}
		return new Text(output, 0, 0);
	}

	const firstLine = lines[0] || "No output";
	const expandHint = lines.length > 1 ? theme.fg("dim", " (Ctrl+O to expand)") : "";
	let output = `${icon} ${theme.fg("toolTitle", "LSP")} ${theme.fg("dim", firstLine.slice(0, 60))}${expandHint}`;

	if (lines.length > 1) {
		const previewLines = lines.slice(1, 4);
		for (let i = 0; i < previewLines.length; i++) {
			const isLast = i === previewLines.length - 1 && lines.length <= 4;
			const branch = isLast ? TREE_END : TREE_MID;
			output += `\n ${theme.fg("dim", branch)} ${theme.fg("dim", previewLines[i].trim().slice(0, 80))}`;
		}
		if (lines.length > 4) {
			output += `\n ${theme.fg("dim", TREE_END)} ${theme.fg("muted", `… ${lines.length - 4} more lines`)}`;
		}
	}

	return new Text(output, 0, 0);
}
