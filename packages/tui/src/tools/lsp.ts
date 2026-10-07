/**
 * LSP Tool TUI Rendering
 *
 * Renders LSP tool calls and results in the TUI with:
 * - Syntax-highlighted hover information
 * - Color-coded diagnostics by severity
 * - Grouped references and symbols
 * - Collapsible/expandable views
 */
import type { TspSpan, TspText, TspTone, TspTreeNode } from "@oh-my-pi/pi-wire";
import type { NativeToolHead, NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
import type { Component } from "../tui";
import { Text } from "../components/text";
import { getLanguageFromPath } from "../lang-from-path";
import { highlightCode as highlightThemeCode, type Theme } from "../theme/theme";
import {
	formatCount,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	type ParsedDiagnostic,
	parseDiagnosticMessage,
	replaceTabs,
	sanitizeDiagnosticDisplayText,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { renderStatusLine } from "../render";
import { framedToolCard } from "../render/tool-card";
import { ansi, code, col, compact, keyed, md, node, row, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { walkGroupedOutput } from "./grouped-file-output";
import { diagnosticGlyph, fileHref, fileRow, inlineErrorView } from "./native-view";
import { activeThemeSymbol } from "../theme/active-symbols";

/** Display arguments for an LSP tool request. */
export interface LspParams {
	action:
		| "diagnostics"
		| "definition"
		| "references"
		| "hover"
		| "symbols"
		| "rename"
		| "rename_file"
		| "code_actions"
		| "type_definition"
		| "implementation"
		| "status"
		| "reload"
		| "capabilities"
		| "request";
	file?: string;
	line?: number;
	symbol?: string;
	query?: string;
	new_name?: string;
	apply?: boolean;
	timeout?: number;
	payload?: string;
}

/** Details accompanying an LSP tool response. */
export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: LspParams;
}

/** Diagnostics and formatting status for one file. */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
	/** Whether the file was formatted */
	formatter?: FileFormatResult;
}

/** Outcome of automatic file formatting. */
export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
	FAILED = "failed",
	UNSUPPORTED = "unsupported",
}

// =============================================================================
// Call Rendering
// =============================================================================

/**
 * Render the LSP tool call in the TUI.
 * Shows: "lsp <operation> <file/filecount>"
 */
function sanitizeInlineText(value: string): string {
	return replaceTabs(value).replaceAll(/\r?\n/g, " ");
}

export function renderCall(args: LspParams, _options: RenderResultOptions, theme: Theme): Text {
	const actionLabel = (args.action ?? "request").replace(/_/g, " ");
	const queryPreview = args.query ? truncateToWidth(args.query, TRUNCATE_LENGTHS.SHORT) : undefined;
	const symbolPreview = args.symbol
		? truncateToWidth(sanitizeInlineText(args.symbol), TRUNCATE_LENGTHS.SHORT)
		: undefined;

	let target: string | undefined;
	let hasFileTarget = false;

	if (args.file) {
		target = shortenPath(args.file);
		hasFileTarget = true;
	}

	if (hasFileTarget && args.line !== undefined) {
		target += `:${args.line}`;
		if (symbolPreview) {
			target += ` (${symbolPreview})`;
		}
	} else if (!target && args.line !== undefined) {
		target = `line ${args.line}`;
		if (symbolPreview) {
			target += ` (${symbolPreview})`;
		}
	}

	const meta: string[] = [];
	if (queryPreview && target) meta.push(`query:${queryPreview}`);
	if (args.new_name) meta.push(`new:${args.new_name}`);
	if (args.apply !== undefined) meta.push(`apply:${args.apply ? "true" : "false"}`);

	const descriptionParts = [actionLabel];
	if (target) {
		descriptionParts.push(target);
	} else if (queryPreview) {
		descriptionParts.push(queryPreview);
	}

	const text = renderStatusLine(
		{
			icon: "pending",
			title: "LSP",
			description: descriptionParts.join(" "),
			meta,
		},
		theme,
	);

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
	result: { content: Array<{ type: string; text?: string }>; details?: LspToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: LspParams,
): Component {
	const content = result.content?.[0];
	if (content?.type !== "text" || !("text" in content) || !content.text) {
		const icon = formatStatusIcon("warning", theme, options.spinnerFrame);
		const header = `${icon} LSP`;
		return new Text([header, theme.fg("dim", "No result")].join("\n"), 0, 0);
	}

	const text = content.text;
	const lines = text.split("\n");

	// Static type detection (result content doesn't change between renders)
	const codeBlockMatch = text.match(/```(\w*)\n([\s\S]*?)```/);
	const errorMatch = text.match(/(\d+)\s+error\(s\)/);
	const warningMatch = text.match(/(\d+)\s+warning\(s\)/);
	const refMatch = text.match(/(\d+)\s+reference\(s\)/);
	const symbolsMatch = text.match(/Symbols in (.+):/);
	const hasStatusError = text.includes(theme.status.error);

	// Static request info
	const request = args ?? result.details?.request;
	const requestLines: string[] = [];
	if (request?.file) {
		requestLines.push(theme.fg("toolOutput", request.file));
	}
	if (request?.line !== undefined) {
		requestLines.push(theme.fg("dim", `line ${request.line}`));
	}
	if (request?.symbol) {
		requestLines.push(theme.fg("dim", `symbol: ${sanitizeInlineText(request.symbol)}`));
	}
	if (request?.query) requestLines.push(theme.fg("dim", `query: ${request.query}`));
	if (request?.new_name) requestLines.push(theme.fg("dim", `new name: ${request.new_name}`));
	if (request?.apply !== undefined) requestLines.push(theme.fg("dim", `apply: ${request.apply ? "true" : "false"}`));

	// The body depends only on the (immutable) text, theme and `expanded`; parse
	// and render it once per expanded state instead of on every spinner frame.
	const bodies: Array<LspResultBody | undefined> = [undefined, undefined];
	const renderBody = (expanded: boolean): LspResultBody => {
		if (codeBlockMatch) {
			return {
				label: "Hover",
				state: "success",
				bodyLines: renderHover(codeBlockMatch, text, lines, expanded, theme),
			};
		}
		if (errorMatch || warningMatch || hasStatusError) {
			const errorCount = errorMatch ? Number.parseInt(errorMatch[1], 10) : 0;
			const warnCount = warningMatch ? Number.parseInt(warningMatch[1], 10) : 0;
			return {
				label: "Diagnostics",
				state: errorCount > 0 ? "error" : warnCount > 0 ? "warning" : "success",
				bodyLines: renderDiagnostics(errorMatch, warningMatch, lines, expanded, theme),
			};
		}
		if (refMatch) {
			return {
				label: "References",
				state: "success",
				bodyLines: renderReferences(refMatch, lines, expanded, theme),
			};
		}
		if (symbolsMatch) {
			return { label: "Symbols", state: "success", bodyLines: renderSymbols(symbolsMatch, lines, expanded, theme) };
		}
		if (result.details?.action === "diagnostics" && text === "OK") {
			return {
				label: "Diagnostics",
				state: "success",
				bodyLines: [`${theme.styledSymbol("tool.lsp", "accent")} ${theme.fg("dim", "OK")}`],
			};
		}
		return { label: "Response", state: "success", bodyLines: renderGeneric(text, lines, expanded, theme) };
	};

	return framedToolCard(theme, () => {
		// Read mutable state at render time
		const { expanded, isPartial, spinnerFrame } = options;
		const slot = expanded ? 1 : 0;
		let body = bodies[slot];
		if (!body) {
			body = renderBody(expanded);
			bodies[slot] = body;
		}
		const { label, state, bodyLines } = body;

		const actionLabel = (request?.action ?? result.details?.action ?? label.toLowerCase()).replace(/_/g, " ");
		const isSuccess = !isPartial && !result.isError;
		const icon = isSuccess
			? theme.styledSymbol("tool.lsp", "accent")
			: formatStatusIcon(isPartial ? "running" : "error", theme, spinnerFrame);
		const header = `${icon} LSP ${actionLabel}`;

		return {
			header,
			phase: isPartial ? "partial" : state,
			sections: [
				...(requestLines.length > 0 ? [{ content: requestLines }] : []),
				{ label: theme.fg("toolTitle", "Response"), content: bodyLines },
			],
			applyBg: false,
		};
	});
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
): string[] {
	const lang = codeBlockMatch[1] || "";
	const code = codeBlockMatch[2].trim();
	const codeStart = codeBlockMatch.index ?? 0;
	const beforeCode = fullText.slice(0, codeStart).trimEnd();
	const afterCode = fullText.slice(fullText.indexOf("```", 3) + 3).trim();

	const codeLines = highlightThemeCode(code, lang, theme);
	const icon = theme.styledSymbol("status.info", "accent");
	const langLabel = lang ? theme.fg("mdCodeBlockBorder", ` ${lang}`) : "";

	if (expanded) {
		const h = theme.boxRound.horizontal;
		const v = theme.boxRound.vertical;
		const top = `${theme.boxRound.topLeft}${h.repeat(3)}`;
		const bottom = `${theme.boxRound.bottomLeft}${h.repeat(3)}`;
		let output = `${icon}${langLabel}`;
		if (beforeCode) {
			for (const line of beforeCode.split("\n")) {
				output += `\n ${theme.fg("muted", line)}`;
			}
		}
		output += `\n ${theme.fg("mdCodeBlockBorder", top)}`;
		for (const line of codeLines) {
			output += `\n ${theme.fg("mdCodeBlockBorder", v)} ${line}`;
		}
		output += `\n ${theme.fg("mdCodeBlockBorder", bottom)}`;
		if (afterCode) {
			output += `\n ${theme.fg("muted", afterCode)}`;
		}
		return output.split("\n");
	}

	// Collapsed view
	const firstCodeLine = codeLines[0] || "";
	const hasMore = codeLines.length > 1 || Boolean(afterCode) || Boolean(beforeCode);
	const expandHint = formatExpandHint(theme, expanded, hasMore);

	let output = `${icon}${langLabel}${expandHint}`;
	if (beforeCode) {
		const preview = truncateToWidth(beforeCode, TRUNCATE_LENGTHS.TITLE);
		output += `\n ${theme.fg("dim", theme.tree.branch)} ${theme.fg("muted", preview)}`;
	}
	const h = theme.boxRound.horizontal;
	const v = theme.boxRound.vertical;
	const bottom = `${theme.boxRound.bottomLeft}${h.repeat(3)}`;
	output += `\n ${theme.fg("mdCodeBlockBorder", v)} ${firstCodeLine}`;

	if (codeLines.length > 1) {
		output += `\n ${theme.fg("mdCodeBlockBorder", v)} ${theme.fg("muted", `… ${codeLines.length - 1} more lines`)}`;
	}

	if (afterCode) {
		const docPreview = truncateToWidth(afterCode, TRUNCATE_LENGTHS.TITLE);
		output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", docPreview)}`;
	} else {
		output += `\n ${theme.fg("mdCodeBlockBorder", bottom)}`;
	}

	return output.split("\n");
}

// =============================================================================
// Diagnostics Rendering
// =============================================================================

function formatDiagnosticLocation(file: string, line: number, col: number, theme: Theme): string {
	const lang = getLanguageFromPath(file);
	const icon = theme.fg("muted", theme.getLangIcon(lang));
	return `${icon} ${file}:${line}:${col}`;
}

/**
 * Render diagnostics with color-coded severity.
 */
function renderDiagnostics(
	errorMatch: RegExpMatchArray | null,
	warningMatch: RegExpMatchArray | null,
	lines: string[],
	expanded: boolean,
	theme: Theme,
): string[] {
	const errorCount = errorMatch ? Number.parseInt(errorMatch[1], 10) : 0;
	const warnCount = warningMatch ? Number.parseInt(warningMatch[1], 10) : 0;

	const icon =
		errorCount > 0
			? theme.styledSymbol("status.error", "error")
			: warnCount > 0
				? theme.styledSymbol("status.warning", "warning")
				: theme.styledSymbol("tool.lsp", "accent");

	const meta: string[] = [];
	if (errorCount > 0) meta.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);
	if (warnCount > 0) meta.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
	if (meta.length === 0) meta.push("No issues");

	const diagLines = lines.filter(l => l.includes(theme.status.error) || /:\d+:\d+/.test(l));
	const parsedDiagnostics = diagLines
		.map(line => parseDiagnosticMessage(line.trim()))
		.filter((diag): diag is ParsedDiagnostic => diag !== null);
	const fallbackDiagnostics: RawDiagnostic[] = diagLines.map(line => ({
		raw: sanitizeDiagnosticDisplayText(line.trim()),
	}));

	if (expanded) {
		let output = `${icon} ${theme.fg("dim", meta.join(theme.sep.dot))}`;
		const items: DiagnosticItem[] = parsedDiagnostics.length > 0 ? parsedDiagnostics : fallbackDiagnostics;
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const isLast = i === items.length - 1;
			const branch = isLast ? theme.tree.last : theme.tree.branch;
			const detailPrefix = isLast ? "   " : `${theme.tree.vertical}  `;
			if ("raw" in item) {
				output += `\n ${theme.fg("dim", branch)} ${theme.fg("muted", item.raw)}`;
				continue;
			}
			const severityColor = severityToColor(item.severity);
			const location = formatDiagnosticLocation(item.filePath, item.line, item.col, theme);
			output += `\n ${theme.fg("dim", branch)} ${theme.fg(severityColor, location)} ${theme.fg(
				"dim",
				`[${item.severity}]`,
			)}`;
			const message = formatDiagnosticMessage(item);
			if (message) {
				output += `\n ${theme.fg("dim", detailPrefix)}${theme.fg(
					"muted",
					truncateToWidth(message, TRUNCATE_LENGTHS.LINE),
				)}`;
			}
		}
		return output.split("\n");
	}

	// Collapsed view
	const previewItems: DiagnosticItem[] =
		parsedDiagnostics.length > 0 ? parsedDiagnostics.slice(0, 3) : fallbackDiagnostics.slice(0, 3);
	const remaining =
		(parsedDiagnostics.length > 0 ? parsedDiagnostics.length : fallbackDiagnostics.length) - previewItems.length;
	const expandHint = formatExpandHint(theme, expanded, remaining > 0);
	let output = `${icon} ${theme.fg("dim", meta.join(theme.sep.dot))}${expandHint}`;
	for (let i = 0; i < previewItems.length; i++) {
		const item = previewItems[i];
		const isLast = i === previewItems.length - 1 && remaining <= 0;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		if ("raw" in item) {
			output += `\n ${theme.fg("dim", branch)} ${theme.fg("muted", item.raw)}`;
			continue;
		}
		const severityColor = severityToColor(item.severity);
		const location = formatDiagnosticLocation(item.filePath, item.line, item.col, theme);
		const diagnosticMessage = formatDiagnosticMessage(item);
		const message = diagnosticMessage
			? ` ${theme.fg("muted", truncateToWidth(diagnosticMessage, TRUNCATE_LENGTHS.CONTENT))}`
			: "";
		output += `\n ${theme.fg("dim", branch)} ${theme.fg(severityColor, location)}${message}`;
	}
	if (remaining > 0) {
		output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", `… ${remaining} more`)}`;
	}

	return output.split("\n");
}

// =============================================================================
// References Rendering
// =============================================================================

/**
 * Render references grouped by file.
 */
function renderReferences(refMatch: RegExpMatchArray, lines: string[], expanded: boolean, theme: Theme): string[] {
	const refCount = Number.parseInt(refMatch[1], 10);
	const icon =
		refCount > 0 ? theme.styledSymbol("tool.lsp", "accent") : theme.styledSymbol("status.warning", "warning");

	const locLines = lines.filter(l => /^\s*\S+:\d+:\d+/.test(l));

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
		const expandHint = formatExpandHint(theme, undefined, showHint);
		let output = `${icon} ${theme.fg("dim", `${refCount} found`)}${expandHint}`;

		const filesToShow = files.slice(0, maxFiles);
		for (let fi = 0; fi < filesToShow.length; fi++) {
			const file = filesToShow[fi];
			const locs = byFile.get(file)!;
			const isLastFile = fi === filesToShow.length - 1 && files.length <= maxFiles;
			const fileBranch = isLastFile ? theme.tree.last : theme.tree.branch;
			const fileCont = isLastFile ? "   " : `${theme.tree.vertical}  `;

			const fileMeta = `${locs.length} reference${locs.length !== 1 ? "s" : ""}`;
			output += `\n ${theme.fg("dim", fileBranch)} ${theme.fg("accent", file)} ${theme.fg("dim", fileMeta)}`;

			if (maxLocsPerFile > 0) {
				const locsToShow = locs.slice(0, maxLocsPerFile);
				for (let li = 0; li < locsToShow.length; li++) {
					const [line, col] = locsToShow[li];
					const isLastLoc = li === locsToShow.length - 1 && locs.length <= maxLocsPerFile;
					const locBranch = isLastLoc ? theme.tree.last : theme.tree.branch;
					const locCont = isLastLoc ? "   " : `${theme.tree.vertical}  `;
					output += `\n ${theme.fg("dim", fileCont)}${theme.fg("dim", locBranch)} ${theme.fg(
						"muted",
						`line ${line}, col ${col}`,
					)}`;
					if (expanded) {
						const context = `at ${file}:${line}:${col}`;
						output += `\n ${theme.fg("dim", fileCont)}${theme.fg("dim", locCont)}${theme.fg(
							"muted",
							truncateToWidth(context, TRUNCATE_LENGTHS.LINE),
						)}`;
					}
				}
				if (locs.length > maxLocsPerFile) {
					output += `\n ${theme.fg("dim", fileCont)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"muted",
						`… ${locs.length - maxLocsPerFile} more`,
					)}`;
				}
			}
		}

		if (files.length > maxFiles) {
			output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"muted",
				formatMoreItems(files.length - maxFiles, "file"),
			)}`;
		}

		return output;
	};

	if (expanded) {
		return renderGrouped(files.length, 3, false).split("\n");
	}

	return renderGrouped(3, 1, true).split("\n");
}

// =============================================================================
// Symbols Rendering
// =============================================================================

/**
 * Render document symbols in a hierarchical tree.
 */
function renderSymbols(symbolsMatch: RegExpMatchArray, lines: string[], expanded: boolean, theme: Theme): string[] {
	const fileName = symbolsMatch[1];
	const icon = theme.styledSymbol("status.info", "accent");

	interface SymbolInfo {
		name: string;
		line: string;
		indent: number;
		icon: string;
	}

	const symbolLines = lines.filter(l => l.includes("@") && l.includes("line"));
	const symbols: SymbolInfo[] = [];

	for (const line of symbolLines) {
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		const symMatch = line.trim().match(/^(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/);
		if (symMatch) {
			symbols.push({ icon: symMatch[1], name: symMatch[2], line: symMatch[3], indent });
		}
	}

	// One linear pass each: `isLast[i]` — the next symbol at indent <= mine is
	// not a sibling (monotonic stack, right to left); `prefixes[i]` — per
	// ancestor level, the nearest earlier symbol at that indent decides the rail.
	const isLast: boolean[] = new Array(symbols.length);
	const pending: number[] = [];
	for (let i = symbols.length - 1; i >= 0; i--) {
		const myIndent = symbols[i].indent;
		while (pending.length > 0 && symbols[pending[pending.length - 1]].indent > myIndent) pending.pop();
		const next = pending.length > 0 ? pending[pending.length - 1] : -1;
		isLast[i] = next < 0 || symbols[next].indent !== myIndent;
		pending.push(i);
	}
	const getPrefixes = (): string[] => {
		const prefixes: string[] = new Array(symbols.length);
		const lastAtIndent = new Map<number, number>();
		for (let i = 0; i < symbols.length; i++) {
			const myIndent = symbols[i].indent;
			let prefix = " ";
			for (let level = 2; level <= myIndent; level += 2) {
				const ancestorIdx = lastAtIndent.get(level - 2);
				prefix += ancestorIdx !== undefined && isLast[ancestorIdx] ? "   " : `${theme.tree.vertical}  `;
			}
			prefixes[i] = prefix;
			lastAtIndent.set(myIndent, i);
		}
		return prefixes;
	};

	const topLevelCount = symbols.filter(s => s.indent === 0).length;

	if (expanded) {
		let output = `${icon} ${theme.fg("dim", `in ${fileName}`)}`;

		const prefixes = getPrefixes();
		for (let i = 0; i < symbols.length; i++) {
			const sym = symbols[i];
			const prefix = prefixes[i];
			const symIsLast = isLast[i];
			const branch = symIsLast ? theme.tree.last : theme.tree.branch;
			const detailPrefix = symIsLast ? "   " : `${theme.tree.vertical}  `;
			output += `\n${prefix}${theme.fg("dim", branch)} ${theme.fg("accent", sym.icon)} ${theme.fg("accent", sym.name)}`;
			output += `\n${prefix}${theme.fg("dim", detailPrefix)}${theme.fg("muted", `line ${sym.line}`)}`;
		}
		return output.split("\n");
	}

	// Collapsed: show first 3 top-level symbols
	const topLevel = symbols.filter(s => s.indent === 0).slice(0, 3);
	const hasMoreSymbols = symbols.length > topLevel.length;
	const expandHint = formatExpandHint(theme, expanded, hasMoreSymbols);
	let output = `${icon} ${theme.fg("dim", `in ${fileName}`)}${expandHint}`;
	for (let i = 0; i < topLevel.length; i++) {
		const sym = topLevel[i];
		const isLast = i === topLevel.length - 1 && topLevelCount <= 3;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		output += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", sym.icon)} ${theme.fg("accent", sym.name)} ${theme.fg(
			"muted",
			`line ${sym.line}`,
		)}`;
	}
	if (topLevelCount > 3) {
		output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", `… ${topLevelCount - 3} more`)}`;
	}

	return output.split("\n");
}

// =============================================================================
// Generic Rendering
// =============================================================================

/**
 * Generic fallback rendering for unknown result types.
 */
function renderGeneric(text: string, lines: string[], expanded: boolean, theme: Theme): string[] {
	const hasError = text.includes("Error:") || text.includes(theme.status.error);
	const hasSuccess = text.includes(theme.status.success) || text.includes("Applied");

	const icon =
		hasError && !hasSuccess
			? theme.styledSymbol("status.error", "error")
			: hasSuccess && !hasError
				? theme.styledSymbol("tool.lsp", "accent")
				: theme.styledSymbol("status.info", "accent");

	if (expanded) {
		let output = `${icon} ${theme.fg("dim", "Output")}`;
		for (let i = 0; i < lines.length; i++) {
			const isLast = i === lines.length - 1;
			const branch = isLast ? theme.tree.last : theme.tree.branch;
			output += `\n ${theme.fg("dim", branch)} ${truncateToWidth(replaceTabs(lines[i]), TRUNCATE_LENGTHS.CONTENT)}`;
		}
		return output.split("\n");
	}

	const firstLine = lines[0] || "No output";
	const expandHint = formatExpandHint(theme, expanded, lines.length > 1);
	let output = `${icon} ${theme.fg("dim", truncateToWidth(firstLine, TRUNCATE_LENGTHS.TITLE))}${expandHint}`;

	if (lines.length > 1) {
		const previewLines = lines.slice(1, 4);
		for (let i = 0; i < previewLines.length; i++) {
			const isLast = i === previewLines.length - 1 && lines.length <= 4;
			const branch = isLast ? theme.tree.last : theme.tree.branch;
			output += `\n ${theme.fg("dim", branch)} ${theme.fg(
				"dim",
				truncateToWidth(previewLines[i].trim(), TRUNCATE_LENGTHS.CONTENT),
			)}`;
		}
		if (lines.length > 4) {
			output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"muted",
				formatMoreItems(lines.length - 4, "line"),
			)}`;
		}
	}

	return output.split("\n");
}

// =============================================================================
// Parsing Helpers
// =============================================================================

interface RawDiagnostic {
	raw: string;
}

/** A rendered LSP result body for one `expanded` state. */
interface LspResultBody {
	label: string;
	state: "success" | "warning" | "error";
	bodyLines: string[];
}

type DiagnosticItem = ParsedDiagnostic | RawDiagnostic;

function formatDiagnosticMessage(diagnostic: ParsedDiagnostic): string {
	const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
	const code = diagnostic.code ? ` (${diagnostic.code})` : "";
	return `${source}${diagnostic.message}${code}`;
}

function severityToColor(severity: ParsedDiagnostic["severity"]): "error" | "warning" | "accent" | "dim" {
	switch (severity) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
			return "accent";
		default:
			return "dim";
	}
}

// =============================================================================
// Native (TSP) Description
// =============================================================================

/** The head verb for an LSP action (`type_definition` → `Type definition`). */
function lspActionTitle(action: string | undefined): string {
	if (!action || action === "request") return "LSP";
	const words = action.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Native head (§7.3 lsp): the action as the verb; the file (`:line`) as a
 * path target, else the query; then the symbol and option facts, then the
 * result `meta` (a count chip).
 */
function lspNativeHead(
	request: Partial<LspParams> | undefined,
	fallbackAction: string,
	meta: readonly TspText[] = [],
): NativeToolHead {
	const facts: string[] = [];
	const symbol = request?.symbol ? plainText(request.symbol).replaceAll(/\r?\n/g, " ") : undefined;
	let target: string | undefined;
	let targetKind: NativeToolHead["targetKind"];
	if (request?.file) {
		target = request.line !== undefined ? `${shortenPath(request.file)}:${request.line}` : shortenPath(request.file);
		targetKind = "path";
	} else if (request?.query) {
		target = request.query;
		targetKind = "query";
	} else if (request?.line !== undefined) {
		facts.push(`line ${request.line}`);
	}
	if (symbol) facts.push(symbol);
	if (request?.query && target !== request.query) facts.push(`query:${request.query}`);
	if (request?.new_name) facts.push(`\u2192 ${request.new_name}`);
	if (request?.apply !== undefined) facts.push(`apply:${request.apply ? "true" : "false"}`);
	return {
		title: lspActionTitle(request?.action ?? fallbackAction),
		target,
		targetKind,
		href: request?.file ? fileHref(request.file) : undefined,
		meta: [...(facts.length > 0 ? [plainText(facts.join(" \u00b7 "))] : []), ...meta],
	};
}

/** A diagnostics response, parsed: diagnostics, server failures and partial-failure warnings. */
interface LspDiagnosticsParse {
	diagnostics: ParsedDiagnostic[];
	failures: string[];
	warnings: string[];
	/** Lines neither a diagnostic nor a status line (kept verbatim). */
	other: string[];
}

const DIAGNOSTIC_AT_RE = /^\d+:\d+\s+\[/;
const DIAGNOSTICS_SUMMARY_RE = /^\d+ \w+\(s\)(?:, \d+ \w+\(s\))*:?$/;
/** A per-file status line's leading status glyph (`✘`, `⚠`, a Nerd Font glyph, ASCII `[!!]`). */
const STATUS_GLYPH_RE = /^(?:\[[^\]\s]*\]|[^\p{L}\p{N}\s./~\\]+)\s+/u;
/** Per-file summaries (`✗ a.ts: 2 error(s)`, `✓ a.ts: no issues`) repeat what the rows and head count. */
const FILE_SUMMARY_RE = /: (?:no issues|\d+ \w+\(s\)(?:, \d+ \w+\(s\))*)$/;

/**
 * Parse a diagnostics response: grouped (`# dir/`, `## file`, `  12:5 [error] …`)
 * or flat (`file:12:5 [error] …`) diagnostic lines, and the per-file status
 * lines (`✗ file: all language servers failed (…)`, `⚠ …some servers failed`,
 * `✓ file: no issues`, `✗ file: 2 error(s)`).
 */
function parseLspDiagnostics(lines: readonly string[]): LspDiagnosticsParse {
	const out: LspDiagnosticsParse = { diagnostics: [], failures: [], warnings: [], other: [] };
	let file: string | undefined;
	for (const event of walkGroupedOutput(lines)) {
		if (event.kind !== "line") {
			file = event.kind === "file" ? event.path : undefined;
			continue;
		}
		const line = event.text.trim();
		if (line === "OK" || DIAGNOSTICS_SUMMARY_RE.test(line)) continue;
		// Matched by wording, not glyph: a transcript may outlive the theme that wrote it.
		if (/\ball language servers failed\b/.test(line)) {
			out.failures.push(line.replace(STATUS_GLYPH_RE, ""));
			continue;
		}
		if (/\bsome servers failed\b/.test(line)) {
			out.warnings.push(line.replace(STATUS_GLYPH_RE, ""));
			continue;
		}
		if (FILE_SUMMARY_RE.test(line)) continue;
		const parsed = parseDiagnosticMessage(file && DIAGNOSTIC_AT_RE.test(line) ? `${file}:${line}` : line);
		if (parsed) out.diagnostics.push(parsed);
		else out.other.push(line);
	}
	return out;
}

/** `2 errors · 1 warning` in the severity tones, or undefined when there are none. */
function diagnosticCounts(diagnostics: readonly ParsedDiagnostic[]): TspSpan[] | undefined {
	const counts: Record<ParsedDiagnostic["severity"], number> = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const d of diagnostics) counts[d.severity]++;
	const spans: TspSpan[] = [];
	for (const severity of ["error", "warning", "info", "hint"] as const) {
		const n = counts[severity];
		if (!n) continue;
		if (spans.length > 0) spans.push(span(" \u00b7 ", "dim"));
		spans.push(span(formatCount(severity, n), severityTone(severity)));
	}
	return spans.length > 0 ? spans : undefined;
}

function severityTone(severity: ParsedDiagnostic["severity"]): TspTone {
	switch (severity) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
			return "info";
		default:
			return "muted";
	}
}

/** One diagnostic row (role `omp.tool.diagnostic`): severity icon, mono `file:line:col`, source chip, message. */
function diagnosticRow(diag: ParsedDiagnostic, key: string): NativeNode {
	const message: TspSpan[] = [span(diag.message)];
	if (diag.code) message.push(span(` ${diag.code}`, "muted"));
	return keyed(
		row(
			compact([
				diagnosticGlyph(diag.severity),
				text([span(`${diag.filePath}:${diag.line}:${diag.col}`, "mono muted")], { wrap: "none" }),
				diag.source ? node("badge", { text: diag.source }) : undefined,
				text(message, { wrap: "word", grow: 1 }),
			]),
			{ role: "omp.tool.diagnostic" },
		),
		key,
	);
}

/** A server failure / partial-failure row: the status icon and the message, in its tone. */
function statusRow(message: string, tone: "error" | "warning", key: string): NativeNode {
	return keyed(
		row([diagnosticGlyph(tone), text([span(plainText(message), tone)], { wrap: "word", grow: 1 })], {
			role: tone === "error" ? "omp.tool.error" : "omp.tool.diagnostic",
		}),
		key,
	);
}

/**
 * Diagnostics view: a card when there are diagnostics or failures (rows of
 * severity icon · `file:line:col` · source · message), an inline `No issues`
 * otherwise. A failed server is an error row, never "No issues".
 */
function describeLspDiagnostics(request: Partial<LspParams> | undefined, fallbackAction: string, lines: string[]) {
	const parsed = parseLspDiagnostics(lines);
	const counts = diagnosticCounts(parsed.diagnostics);
	const failed =
		parsed.failures.length > 0 ? [span(formatCount("server failure", parsed.failures.length), "error")] : undefined;
	const rows: NativeNode[] = [
		...parsed.failures.map((message, i) => statusRow(message, "error", `x${i}`)),
		...parsed.diagnostics.map((diag, i) => diagnosticRow(diag, `d${i}`)),
		...parsed.warnings.map((message, i) => statusRow(message, "warning", `w${i}`)),
	];
	if (parsed.other.length > 0) rows.push(keyed(code(parsed.other.join("\n"), { wrap: true }), "other"));
	const hasErrors = parsed.failures.length > 0 || parsed.diagnostics.some(d => d.severity === "error");
	const meta = compact<TspText>([counts, failed, !counts && !failed && "No issues"]);
	const head = lspNativeHead(request, fallbackAction, meta);
	if (parsed.diagnostics.length === 0 && parsed.failures.length === 0) {
		return { tool: head, inline: true, body: rows.length > 0 ? rows : undefined } satisfies NativeToolView;
	}
	return {
		tool: head,
		tone: hasErrors ? "error" : "warning",
		body: rows,
		preview: { lines: 8 },
	} satisfies NativeToolView;
}

/** References grouped by file (§7.3): a file row with the count, then the `line:col` positions. */
function describeLspReferences(lines: string[]): NativeNode[] {
	const byFile = new Map<string, string[]>();
	for (const loc of lines) {
		const match = loc.trim().match(/^(.+):(\d+):(\d+)$/);
		if (!match) continue;
		const [, file, line, col] = match;
		let locs = byFile.get(file);
		if (!locs) {
			locs = [];
			byFile.set(file, locs);
		}
		locs.push(`${line}:${col}`);
	}
	const nodes: NativeNode[] = [];
	for (const [file, locs] of byFile) {
		const name = plainText(file);
		nodes.push(
			keyed(
				col(
					[
						fileRow(name, { chip: { text: String(locs.length), title: formatCount("reference", locs.length) } }),
						text([span(locs.join("  "), "mono muted")], { wrap: "word" }),
					],
					{ gap: "xs" },
				),
				name,
			),
		);
	}
	return nodes;
}

function describeLspSymbols(lines: string[]): NativeNode | undefined {
	const roots: TspTreeNode[] = [];
	const stack: { indent: number; children: TspTreeNode[] }[] = [];
	let index = 0;
	for (const line of lines) {
		if (!line.includes("@") || !line.includes("line")) continue;
		const symMatch = line.trim().match(/^(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/);
		if (!symMatch) continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		const children: TspTreeNode[] = [];
		const treeNode: TspTreeNode = {
			id: `${index++}`,
			label: [
				span(plainText(symMatch[1]), "accent"),
				span(" "),
				span(plainText(symMatch[2]), "accent"),
				span(` line ${symMatch[3]}`, "muted"),
			],
			open: true,
			children,
		};
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
		(stack[stack.length - 1]?.children ?? roots).push(treeNode);
		stack.push({ indent, children });
	}
	return roots.length > 0 ? node("tree", { nodes: roots }) : undefined;
}

function describeLspResult(result: ToolRenderResult<LspToolDetails>, args: LspParams | undefined): NativeToolView {
	const request = args ?? result.details?.request;
	const fallbackAction = result.details?.action ?? "request";
	const content = result.content?.[0];
	const text = content?.type === "text" ? (content.text ?? "") : "";
	if (result.isError) return inlineErrorView(lspNativeHead(request, fallbackAction), text || "LSP request failed");
	if (!text) return { tool: lspNativeHead(request, fallbackAction, ["No result"]), tone: "warning", inline: true };

	const lines = text.split("\n");
	const statusError = activeThemeSymbol("status.error");
	const refMatch = text.match(/(\d+)\s+reference\(s\)/);
	const symbolsMatch = text.match(/Symbols in (.+):/);

	if (/```(\w*)\n([\s\S]*?)```/.test(text)) {
		return { tool: lspNativeHead(request, fallbackAction), inline: true, body: [md(text)], preview: { lines: 4 } };
	}
	if (
		/\d+\s+(?:error|warning)\(s\)/.test(text) ||
		text.includes(statusError) ||
		(request?.action ?? fallbackAction) === "diagnostics"
	) {
		return describeLspDiagnostics(request, fallbackAction, lines);
	}
	if (refMatch) {
		const refCount = Number.parseInt(refMatch[1], 10);
		const body = describeLspReferences(lines);
		return {
			tool: lspNativeHead(request, fallbackAction, [formatCount("reference", refCount)]),
			tone: refCount > 0 ? undefined : "warning",
			inline: true,
			body: body.length > 0 ? body : undefined,
			preview: { lines: 8 },
		};
	}
	if (symbolsMatch) {
		const body = describeLspSymbols(lines);
		return {
			tool: lspNativeHead(request, fallbackAction, [`in ${symbolsMatch[1]}`]),
			inline: true,
			body: body ? [body] : undefined,
			preview: { lines: 8 },
		};
	}
	const hasError = text.includes("Error:") || text.includes(statusError);
	const hasSuccess = text.includes(activeThemeSymbol("status.success")) || text.includes("Applied");
	return {
		tool: lspNativeHead(request, fallbackAction),
		tone: hasError && !hasSuccess ? "error" : undefined,
		inline: true,
		body: [ansi(text)],
		preview: { lines: 4 },
	};
}

const lspResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render LSP requests and responses in the transcript. */
export const lspToolRenderer = {
	renderCall,
	renderResult,
	describeCall(args: LspParams): NativeToolView {
		return { tool: lspNativeHead(args, "request"), inline: true };
	},
	describeResult(
		result: ToolRenderResult<LspToolDetails>,
		_options: RenderResultOptions,
		args?: LspParams,
	): NativeToolView | undefined {
		return lspResultMemo.get(result, [], () => describeLspResult(result, args));
	},
	mergeCallAndResult: true,
	inline: true,
} satisfies ToolRenderer<LspParams, LspToolDetails>;
