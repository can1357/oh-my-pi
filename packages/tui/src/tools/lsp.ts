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
import { highlightCode as highlightThemeCode, isHighlightLanguage, type Theme, type ThemeColor } from "../theme/theme";
import {
	formatCodeFrameLine,
	formatCount,
	formatExpandHint,
	formatMoreItems,
	formatStyledPath,
	PREVIEW_LIMITS,
	type ParsedDiagnostic,
	parseDiagnosticMessage,
	replaceTabs,
	sanitizeDiagnosticDisplayText,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { renderStatusLine, renderTreeList } from "../render";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard } from "../render/tool-card";
import { wrapGuidedLine, wrapPrefixedLine } from "../render/hanging-wrap";
import { ansi, code, col, compact, keyed, md, node, row, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { type NumberedLine, numberedCode, renderCodeFrameRun, walkGroupedOutput } from "./grouped-file-output";
import { diagnosticGlyph, displayPath, fileHref, fileRow, inlineErrorView } from "./native-view";
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
	/** Servers that sent no fresh report in time: the file is unverified for them, not clean. */
	unreported?: string[];
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

function sanitizeInlineText(value: string): string {
	return replaceTabs(value).replaceAll(/\r?\n/g, " ");
}

/**
 * The request half of the LSP status line: `action target` as the description
 * (`references src/a.ts:42 (validateToken)`) and the call facts as meta.
 * `fallbackAction` names the action when the request is unknown.
 */
function lspRequestStatus(
	args: Partial<LspParams> | undefined,
	fallbackAction = "request",
): { description: string; meta: string[] } {
	const actionLabel = (args?.action ?? fallbackAction).replace(/_/g, " ");
	const queryPreview = args?.query ? truncateToWidth(args.query, TRUNCATE_LENGTHS.SHORT) : undefined;
	const symbolPreview = args?.symbol
		? truncateToWidth(sanitizeInlineText(args.symbol), TRUNCATE_LENGTHS.SHORT)
		: undefined;

	let target: string | undefined;
	if (args?.file) {
		target = shortenPath(args.file);
		if (args.line !== undefined) {
			target += `:${args.line}`;
			if (symbolPreview) target += ` (${symbolPreview})`;
		}
	} else if (args?.line !== undefined) {
		target = `line ${args.line}`;
		if (symbolPreview) target += ` (${symbolPreview})`;
	}

	const meta: string[] = [];
	if (queryPreview && target) meta.push(`query:${queryPreview}`);
	if (args?.new_name) meta.push(`new:${args.new_name}`);
	if (args?.apply !== undefined) meta.push(`apply:${args.apply ? "true" : "false"}`);

	const subject = target ?? queryPreview;
	return { description: subject ? `${actionLabel} ${subject}` : actionLabel, meta };
}

/** Render the LSP tool call: `LSP: <action> <file:line (symbol)>`. */
export function renderCall(args: LspParams, _options: RenderResultOptions, theme: Theme): Text {
	const text = renderStatusLine({ icon: "pending", title: "LSP", ...lspRequestStatus(args) }, theme);
	return new Text(text, 0, 0);
}

// =============================================================================
// Result Rendering
// =============================================================================

/** A diagnostics status line for a file no server reported on in time: unverified, never "No issues". */
const UNREPORTED_LINE_RE = /\bno diagnostics report yet\b/;
/** Files shown while a references result is collapsed. */
const COLLAPSED_REFERENCE_FILES = 3;
/** Locations shown per file while a references result is collapsed. */
const COLLAPSED_REFERENCE_LOCATIONS = 2;
/** Diagnostics shown while collapsed. */
const COLLAPSED_DIAGNOSTICS = 3;
/** Top-level symbols shown while collapsed. */
const COLLAPSED_SYMBOLS = 3;
/** Output lines shown while a generic response is collapsed. */
const COLLAPSED_GENERIC_LINES = 4;

/**
 * Whether a line is one of the LSP tool's per-file status rows (`<glyph> <path>: …`).
 * Only a row's start counts: response text such as source or hover content can hold
 * the same characters (ASCII `[-]`).
 */
function isStatusRow(line: string, glyph: string): boolean {
	return line.startsWith(`${glyph} `);
}

/**
 * Whether a result holds a status row drawn with `glyph`. Only the diagnostics action
 * writes status rows; any other action's text is the server's (a `request` response
 * verbatim), so a glyph there is content even at a line start. A result whose action
 * is unknown keeps the inference.
 */
function hasStatusRow(action: string | undefined, lines: readonly string[], glyph: string): boolean {
	if (action !== undefined && action !== "diagnostics") return false;
	return lines.some(line => isStatusRow(line, glyph));
}

/** Body rows for one expansion state; `hidden` says the rows hold something back. */
interface LspBodyRows {
	rows: string[];
	hidden: boolean;
}

/** A parsed LSP response: the header outcome and counts, and the body rows per expansion state. */
interface LspResultView {
	/** The action the response answers (`references`, `type definition`); names the header when the request is unknown. */
	action: string;
	/** The header's status; `success` shows the LSP icon. */
	icon: "success" | "warning" | "error";
	/** Counts appended to the header after the request facts. */
	meta: string[];
	/** Rows wrap while collapsed too (hover code) instead of clipping to one row each. */
	wrapCollapsed?: boolean;
	rows(expanded: boolean): LspBodyRows;
}

/** A view's body laid out for one width, and whether the header advertises Ctrl+O. */
interface LspBodyLayout {
	width: number;
	hinted: boolean;
	rows: string[];
}

/**
 * Expanded rows hang under their tree connector or guide rails so Ctrl+O reveals
 * full text; collapsed rows clip to one row each, and a collapsed view that hides
 * rows or clips one gets the expand hint.
 */
function layoutBody(view: LspResultView, expanded: boolean, width: number, theme: Theme): LspBodyLayout {
	const { rows, hidden } = view.rows(expanded);
	if (expanded || view.wrapCollapsed) {
		return { width, hinted: !expanded && hidden, rows: rows.flatMap(row => wrapGuidedLine(row, width, theme)) };
	}
	const clipped = rows.map(row => truncateToWidth(row, width));
	return { width, hinted: hidden || clipped.some((row, index) => row !== rows[index]), rows: clipped };
}

/**
 * Render an LSP result flush: one status line carrying the request and the
 * result counts, over the result rows. Detects locations, hover, diagnostics,
 * references and symbols; anything else is listed line by line.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: LspToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: LspParams,
): Component {
	const request = args ?? result.details?.request;
	const content = result.content?.[0];
	const text = content?.type === "text" ? (content.text ?? "") : "";

	if (result.isError) {
		const { description, meta } = lspRequestStatus(request, result.details?.action);
		const header = renderStatusLine({ icon: "error", title: "LSP", description, meta }, theme);
		const messageLines = (text.trim() || "LSP request failed").split("\n").filter(line => line.trim().length > 0);
		// The message hangs under the title, like a Grep or AST Grep error's, and wraps in full.
		return plainToolCard(theme, ({ contentWidth }) => ({
			header,
			phase: "error",
			body: messageLines.flatMap(line =>
				wrapPrefixedLine("  ", "  ", theme.fg("error", replaceTabs(line)), contentWidth),
			),
			applyBg: false,
		}));
	}
	if (!text) {
		const { description, meta } = lspRequestStatus(request, result.details?.action);
		const header = renderStatusLine(
			{ icon: "warning", title: "LSP", description, meta: [...meta, "No result"] },
			theme,
		);
		return plainToolCard(theme, () => ({ header, phase: "warning", applyBg: false }));
	}

	const view = parseLspResult(text, request, result.details?.action, theme);
	const { description, meta } = lspRequestStatus(request, result.details?.action ?? view.action);
	const headerMeta = [...meta, ...view.meta];
	// The body depends only on the (immutable) text, theme, width and `expanded`;
	// lay it out once per expanded state instead of on every spinner frame.
	const layouts: Array<LspBodyLayout | undefined> = [undefined, undefined];
	return plainToolCard(theme, ({ contentWidth }) => {
		// Read mutable state at render time
		const { expanded, isPartial, spinnerFrame } = options;
		const slot = expanded ? 1 : 0;
		let layout = layouts[slot];
		if (!layout || layout.width !== contentWidth) {
			layout = layoutBody(view, expanded, contentWidth, theme);
			layouts[slot] = layout;
		}
		const icon: Pick<StatusLineOptions, "icon" | "iconOverride" | "spinnerFrame"> = isPartial
			? { icon: "running", spinnerFrame }
			: view.icon === "success"
				? { iconOverride: theme.styledSymbol("tool.lsp", "accent") }
				: { icon: view.icon };
		const header = renderStatusLine({ ...icon, title: "LSP", description, meta: headerMeta }, theme);
		return {
			header: layout.hinted ? `${header}${formatExpandHint(theme)}` : header,
			phase: isPartial ? "partial" : view.icon,
			body: layout.rows.length > 0 ? layout.rows : undefined,
			applyBg: false,
		};
	});
}

/** Detect the response kind and build its view. */
function parseLspResult(
	text: string,
	request: Partial<LspParams> | undefined,
	detailsAction: string | undefined,
	theme: Theme,
): LspResultView {
	const lines = text.split("\n");
	const action = request?.action ?? detailsAction;
	// Locations and references are anchored at the response's first line, so they win over
	// hover and diagnostics checks that their source context could trip.
	const locations = parseLspLocations(lines);
	if (locations?.noun === "reference") return referencesView(locations, theme);
	if (locations) return locationsView(locations, theme);

	// A diagnostics request answers with diagnostics whatever its rows hold: `OK`, a partial
	// server failure, a summary. Without a known action, the rows themselves decide.
	if (action === "diagnostics") return diagnosticsView(lines, theme);

	const codeBlockMatch = text.match(/```(\w*)\n([\s\S]*?)```/);
	if (codeBlockMatch) return hoverView(codeBlockMatch, text, theme);

	const summarized = /\d+\s+(?:error|warning)\(s\)/.test(text);
	const unreported = lines.some(line => UNREPORTED_LINE_RE.test(line));
	if (summarized || hasStatusRow(action, lines, theme.status.error) || unreported) {
		return diagnosticsView(lines, theme);
	}

	const symbolsMatch = text.match(/Symbols in (.+):/);
	if (symbolsMatch) return symbolsView(symbolsMatch[1], request?.file === undefined, lines, theme);

	return genericView(text, lines, action, theme);
}

// =============================================================================
// Hover Rendering
// =============================================================================

/** Hover: the highlighted signature between any documentation around it; collapsed, its first line. */
function hoverView(codeBlockMatch: RegExpMatchArray, fullText: string, theme: Theme): LspResultView {
	const lang = codeBlockMatch[1] || "";
	const codeStart = codeBlockMatch.index ?? 0;
	const beforeCode = fullText.slice(0, codeStart).trim();
	const afterCode = fullText.slice(codeStart + codeBlockMatch[0].length).trim();
	const codeLines = highlightThemeCode(codeBlockMatch[2].trim(), lang, theme);
	const docLines = (doc: string) => (doc ? doc.split("\n").map(line => theme.fg("muted", replaceTabs(line))) : []);
	const full = [...docLines(beforeCode), ...codeLines, ...docLines(afterCode)];
	const first = codeLines[0] ?? full[0] ?? "";
	const hiddenLines = full.length - 1;

	return {
		action: "hover",
		icon: "success",
		meta: [],
		wrapCollapsed: true,
		rows(expanded) {
			if (expanded || hiddenLines <= 0) return { rows: full, hidden: false };
			return { rows: [first, theme.fg("muted", formatMoreItems(hiddenLines, "line"))], hidden: true };
		},
	};
}

// =============================================================================
// Diagnostics Rendering
// =============================================================================

/** A status or unparsed line of a diagnostics response, shown verbatim in `color`. */
interface RawDiagnostic {
	raw: string;
	color: ThemeColor;
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

/** A diagnostic's location: the muted file-type icon, the styled path and the muted `:line:col`. */
function formatDiagnosticLocation(file: string, line: number, col: number, theme: Theme): string {
	const lang = getLanguageFromPath(file);
	const icon = theme.fg("muted", theme.getLangIcon(lang));
	return `${icon} ${formatStyledPath(file, theme)}${theme.fg("muted", `:${line}:${col}`)}`;
}

/** The `[severity]` tag in its severity's color: the path no longer carries it. */
function formatSeverityTag(severity: ParsedDiagnostic["severity"], theme: Theme): string {
	return theme.fg(severityToColor(severity), `[${severity}]`);
}

/**
 * Diagnostics: the counts in the header, then one branch per row. Server failures
 * and unverified files lead, since a reader must not miss them among diagnostics
 * (`file:line:col [severity] message`); partial-failure warnings and unparsed
 * lines follow. Expanded, a diagnostic's message moves to its own row beneath
 * the location.
 */
function diagnosticsView(lines: string[], theme: Theme): LspResultView {
	const parsed = parseLspDiagnostics(lines);
	// Counted from the rows, not the tool's summary lines: a multi-file response carries one
	// summary per file, and the native view counts the same rows.
	const counts: Record<ParsedDiagnostic["severity"], number> = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const diagnostic of parsed.diagnostics) counts[diagnostic.severity]++;

	const meta: string[] = [];
	for (const severity of ["error", "warning", "info", "hint"] as const) {
		if (counts[severity] > 0) meta.push(formatCount(severity, counts[severity]));
	}
	if (parsed.failures.length > 0) meta.push(formatCount("server failure", parsed.failures.length));
	if (parsed.unreported.length > 0) meta.push(formatCount("unverified file", parsed.unreported.length));

	const raw = (color: ThemeColor) => (line: string) => ({ raw: sanitizeDiagnosticDisplayText(line), color });
	const items: DiagnosticItem[] = [
		...parsed.failures.map(raw("error")),
		...parsed.unreported.map(raw("warning")),
		...parsed.diagnostics,
		...parsed.warnings.map(raw("warning")),
		...parsed.other.map(raw("muted")),
	];
	// Only a response with nothing to count and nothing to show claims a clean file.
	if (meta.length === 0 && items.length === 0) meta.push("No issues");

	return {
		action: "diagnostics",
		// Errors and failed servers are an error state; warnings, unverified files and partial
		// server failures a warning one, like the native view's tone.
		icon:
			counts.error > 0 || parsed.failures.length > 0
				? "error"
				: counts.warning > 0 || parsed.unreported.length > 0 || parsed.warnings.length > 0
					? "warning"
					: "success",
		meta,
		rows(expanded) {
			const rows = renderTreeList(
				{
					items,
					expanded,
					maxCollapsed: COLLAPSED_DIAGNOSTICS,
					itemType: "diagnostic",
					renderItem: item => {
						if ("raw" in item) return theme.fg(item.color, item.raw);
						const location = formatDiagnosticLocation(item.filePath, item.line, item.col, theme);
						const head = `${location} ${formatSeverityTag(item.severity, theme)}`;
						const message = formatDiagnosticMessage(item);
						if (!message) return head;
						return expanded ? [head, theme.fg("muted", message)] : `${head} ${theme.fg("muted", message)}`;
					},
				},
				theme,
			);
			return { rows, hidden: !expanded && items.length > COLLAPSED_DIAGNOSTICS };
		},
	};
}

// =============================================================================
// Locations
// =============================================================================

/** One location of a definition-style or references response, with its numbered source context. */
interface LspLocation {
	file: string;
	line: number;
	col: number;
	/** Source lines around the location; the location's own line is `mark`ed. */
	context: { n: number; text: string; mark: boolean }[];
}

/**
 * `  file:line:col`, the path from column 2 on (it may itself start with whitespace). Context rows are
 * `    N: source`; a row matching both is context of the current location.
 */
const LOCATION_RE = /^ {2}(.+):(\d+):(\d+)$/;
const LOCATION_CONTEXT_RE = /^ {4}(\d+): ?(.*)$/;

/** The `  file:line:col` rows of a locations or references response, each with the `    N: source` lines after it. */
function parseLocationRows(lines: readonly string[]): LspLocation[] {
	const locations: LspLocation[] = [];
	for (const line of lines) {
		const current = locations.at(-1);
		const context = current ? LOCATION_CONTEXT_RE.exec(line) : null;
		if (current && context) {
			const n = Number(context[1]);
			current.context.push({ n, text: context[2].trimEnd(), mark: n === current.line });
			continue;
		}
		const location = LOCATION_RE.exec(line);
		if (location) {
			const [, file, lineNumber, column] = location;
			locations.push({ file, line: Number(lineNumber), col: Number(column), context: [] });
		}
	}
	return locations;
}

/** A definition, type definition, implementation or references response. */
interface LspLocations {
	/** `definition`, `type definition`, `implementation` or `reference`. */
	noun: string;
	count: number;
	locations: LspLocation[];
}

const LOCATIONS_HEADER_RE = /^Found (\d+) (definition|type definition|implementation|reference)\(s\):$/;

/**
 * Parse a `Found N definition(s):` response (also type definitions,
 * implementations and references): `  file:line:col` rows, each followed by
 * its `    N: source` context lines.
 */
function parseLspLocations(lines: readonly string[]): LspLocations | undefined {
	const header = LOCATIONS_HEADER_RE.exec(lines[0] ?? "");
	if (!header) return undefined;
	return { noun: header[2], count: Number(header[1]), locations: parseLocationRows(lines.slice(1)) };
}

/** One source line in its file's language, or in `fallback` when the highlighter doesn't know the language. */
function highlightSourceLine(source: string, lang: string | undefined, fallback: ThemeColor, theme: Theme): string {
	const plain = replaceTabs(source);
	if (!isHighlightLanguage(lang)) return theme.fg(fallback, plain);
	return highlightThemeCode(plain, lang, theme)[0] ?? plain;
}

// =============================================================================
// References Rendering
// =============================================================================

/** Reference locations grouped by file, in first-seen order. */
function groupReferencesByFile(references: readonly LspLocation[]): Map<string, LspLocation[]> {
	const byFile = new Map<string, LspLocation[]>();
	for (const location of references) {
		const locations = byFile.get(location.file);
		if (locations) locations.push(location);
		else byFile.set(location.file, [location]);
	}
	return byFile;
}

function formatPosition(location: LspLocation): string {
	return `${location.line}:${location.col}`;
}

/**
 * One reference: its `line:col` right-aligned to `positionWidth` and a rule, then its
 * source line in the file's language. References past the tool's context limit arrive
 * without source and show the position alone.
 */
function referenceRow(location: LspLocation, positionWidth: number, lang: string | undefined, theme: Theme): string {
	const position = formatPosition(location).padStart(positionWidth);
	const source = location.context.find(line => line.mark)?.text.trim();
	if (!source) return theme.fg("muted", position);
	return `${theme.fg("muted", `${position}│`)} ${highlightSourceLine(source, lang, "toolOutput", theme)}`;
}

/**
 * References: the counts in the header, then one branch per file (`file (N)`) over its
 * locations, each previewing its source line. All positions share one width, so the
 * rules line up across files and stay put when the view expands.
 */
function referencesView(parsed: LspLocations, theme: Theme): LspResultView {
	const refCount = parsed.count;
	const byFile = groupReferencesByFile(parsed.locations);
	const files = Array.from(byFile.keys());
	const meta = [formatCount("reference", refCount)];
	if (files.length > 0) meta.push(formatCount("file", files.length));
	const collapsedHides =
		files.length > COLLAPSED_REFERENCE_FILES ||
		files.slice(0, COLLAPSED_REFERENCE_FILES).some(file => byFile.get(file)!.length > COLLAPSED_REFERENCE_LOCATIONS);
	let positionWidth = 0;
	for (const locations of byFile.values()) {
		for (const location of locations) positionWidth = Math.max(positionWidth, formatPosition(location).length);
	}

	return {
		action: "references",
		icon: refCount > 0 ? "success" : "warning",
		meta,
		rows(expanded) {
			const rows = renderTreeList(
				{
					items: files,
					expanded,
					maxCollapsed: COLLAPSED_REFERENCE_FILES,
					itemType: "file",
					renderItem: file => {
						const locations = byFile.get(file)!;
						const lang = getLanguageFromPath(file);
						const header = `${formatStyledPath(replaceTabs(shortenPath(file)), theme)} ${theme.fg("dim", `(${locations.length})`)}`;
						const locationRows = renderTreeList(
							{
								items: locations,
								expanded,
								maxCollapsed: COLLAPSED_REFERENCE_LOCATIONS,
								itemType: "location",
								renderItem: location => referenceRow(location, positionWidth, lang, theme),
							},
							theme,
						);
						return [header, ...locationRows];
					},
				},
				theme,
			);
			return { rows, hidden: !expanded && collapsedHides };
		},
	};
}

// =============================================================================
// Locations Rendering
// =============================================================================

/**
 * Definitions, type definitions and implementations: the count in the header,
 * then one branch per `file:line:col` over its source context, the location's
 * line marked like a grep match.
 */
function locationsView(parsed: LspLocations, theme: Theme): LspResultView {
	const { noun, count, locations } = parsed;
	return {
		action: noun,
		icon: count > 0 ? "success" : "warning",
		meta: [formatCount(noun, count)],
		rows(expanded) {
			const rows = renderTreeList(
				{
					items: locations,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.LOCATIONS_COLLAPSED,
					itemType: noun,
					renderItem: location => {
						const position = theme.fg("muted", `:${location.line}:${location.col}`);
						const file = formatStyledPath(replaceTabs(shortenPath(location.file)), theme);
						const numberWidth = location.context.reduce(
							(width, line) => Math.max(width, String(line.n).length),
							0,
						);
						const frame = renderCodeFrameRun(
							location.context.map(line => ({
								gutter: formatCodeFrameLine(line.mark ? "*" : "", line.n, "", numberWidth),
								source: line.text,
							})),
							getLanguageFromPath(location.file),
							"toolOutput",
							theme,
						);
						return [`${file}${position}`, ...frame];
					},
				},
				theme,
			);
			return { rows, hidden: !expanded && locations.length > PREVIEW_LIMITS.LOCATIONS_COLLAPSED };
		},
	};
}

// =============================================================================
// Symbols Rendering
// =============================================================================

interface SymbolInfo {
	name: string;
	line: string;
	indent: number;
	icon: string;
}

/**
 * Document symbols: the count in the header (and the file, when the request
 * does not name it), then a tree of symbols. Collapsed, the first top-level
 * symbols; expanded, every symbol with its line beneath it.
 */
function symbolsView(fileName: string, showFile: boolean, lines: string[], theme: Theme): LspResultView {
	const symbols: SymbolInfo[] = [];
	for (const line of lines) {
		if (!line.includes("@") || !line.includes("line")) continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		const symMatch = line.trim().match(/^(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/);
		if (symMatch) {
			symbols.push({ icon: symMatch[1], name: symMatch[2], line: symMatch[3], indent });
		}
	}

	// One linear pass each: `isLast[i]` — the next symbol at indent <= mine is
	// not a sibling (monotonic stack, right to left); `prefixes[i]` — per
	// ancestor level, the nearest earlier symbol at that indent decides the rail.
	const isLast = Array.from({ length: symbols.length }, () => false);
	const pending: number[] = [];
	for (let i = symbols.length - 1; i >= 0; i--) {
		const myIndent = symbols[i].indent;
		while (pending.length > 0 && symbols[pending[pending.length - 1]].indent > myIndent) pending.pop();
		const next = pending.length > 0 ? pending[pending.length - 1] : -1;
		isLast[i] = next < 0 || symbols[next].indent !== myIndent;
		pending.push(i);
	}
	const prefixes: string[] = [];
	const lastAtIndent = new Map<number, number>();
	for (let i = 0; i < symbols.length; i++) {
		const myIndent = symbols[i].indent;
		let prefix = "";
		for (let level = 2; level <= myIndent; level += 2) {
			const ancestorIdx = lastAtIndent.get(level - 2);
			prefix += ancestorIdx !== undefined && isLast[ancestorIdx] ? "   " : `${theme.tree.vertical}  `;
		}
		prefixes.push(theme.fg("dim", prefix));
		lastAtIndent.set(myIndent, i);
	}

	const topLevel = symbols.filter(s => s.indent === 0);
	// The glyph keeps the accent; the name and signature read as code in the file's language.
	const lang = getLanguageFromPath(fileName);
	const symbolLabel = (sym: SymbolInfo) =>
		`${theme.fg("accent", sym.icon)} ${highlightSourceLine(sym.name, lang, "accent", theme)}`;

	const meta = [formatCount("symbol", symbols.length)];
	if (showFile) meta.push(`in ${fileName}`);
	return {
		action: "symbols",
		icon: symbols.length > 0 ? "success" : "warning",
		meta,
		rows(expanded) {
			if (expanded) {
				const rows: string[] = [];
				for (let i = 0; i < symbols.length; i++) {
					const sym = symbols[i];
					const branch = isLast[i] ? theme.tree.last : theme.tree.branch;
					const detail = isLast[i] ? "   " : `${theme.tree.vertical}  `;
					rows.push(`${prefixes[i]}${theme.fg("dim", branch)} ${symbolLabel(sym)}`);
					rows.push(`${prefixes[i]}${theme.fg("dim", detail)}${theme.fg("muted", `line ${sym.line}`)}`);
				}
				return { rows, hidden: false };
			}
			// The marker counts every hidden symbol, nested ones included, so it adds up to the header's count.
			const shown = topLevel.slice(0, COLLAPSED_SYMBOLS);
			const hidden = symbols.length - shown.length;
			const rows = renderTreeList(
				{
					items: shown,
					trailingSummary: hidden > 0 ? formatMoreItems(hidden, "symbol") : "",
					renderItem: sym => `${symbolLabel(sym)} ${theme.fg("muted", `line ${sym.line}`)}`,
				},
				theme,
			);
			return { rows, hidden: hidden > 0 };
		},
	};
}

// =============================================================================
// Generic Rendering
// =============================================================================

/** Any other response (rename, code actions, status…): one branch per output line, capped while collapsed. */
function genericView(text: string, lines: string[], action: string | undefined, theme: Theme): LspResultView {
	const hasError = text.includes("Error:") || hasStatusRow(action, lines, theme.status.error);
	const hasSuccess = hasStatusRow(action, lines, theme.status.success) || text.includes("Applied");
	const outputLines = lines.map(line => theme.fg("toolOutput", replaceTabs(line)));
	return {
		action: "request",
		// The call completed; an error reported inside its output, or an empty
		// answer ("No definition found"), needs attention.
		icon: (hasError && !hasSuccess) || /^no\b.*\bfound\b/i.test(text.trim()) ? "warning" : "success",
		meta: [],
		rows(expanded) {
			const rows = renderTreeList(
				{
					items: outputLines,
					expanded,
					maxCollapsed: COLLAPSED_GENERIC_LINES,
					itemType: "line",
					renderItem: line => line,
				},
				theme,
			);
			return { rows, hidden: !expanded && outputLines.length > COLLAPSED_GENERIC_LINES };
		},
	};
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
	/** Files a server sent no report for in time: unverified, never "No issues". */
	unreported: string[];
	/** Lines neither a diagnostic nor a status line (kept verbatim). */
	other: string[];
}

const DIAGNOSTIC_AT_RE = /^\d+:\d+\s+\[/;
const DIAGNOSTICS_SUMMARY_RE = /^\d+ \w+\(s\)(?:, \d+ \w+\(s\))*:?$/;
/** A per-file status line's leading status glyph (`✘`, `⚠`, a Nerd Font glyph, ASCII `[-]`). */
const STATUS_GLYPH_RE = /^(?:\[[^\]\s]*\]|[^\p{L}\p{N}\s./~\\]+)\s+/u;
/** Per-file summaries (`✗ a.ts: 2 error(s)`, `✓ a.ts: no issues`) repeat what the rows and head count. */
const FILE_SUMMARY_RE = /: (?:no issues|\d+ \w+\(s\)(?:, \d+ \w+\(s\))*)$/;

/**
 * Parse a diagnostics response: grouped (`# dir/`, `## file`, `  12:5 [error] …`)
 * or flat (`file:12:5 [error] …`) diagnostic lines, and the per-file status
 * lines (`✗ file: all language servers failed (…)`, `⚠ …some servers failed`,
 * `⚠ file: no diagnostics report yet from …`, `✓ file: no issues`, `✗ file: 2 error(s)`).
 */
function parseLspDiagnostics(lines: readonly string[]): LspDiagnosticsParse {
	const out: LspDiagnosticsParse = { diagnostics: [], failures: [], warnings: [], unreported: [], other: [] };
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
		if (UNREPORTED_LINE_RE.test(line)) {
			out.unreported.push(line.replace(STATUS_GLYPH_RE, ""));
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
 * Diagnostics view: a card when there are diagnostics, failed or partly failed servers,
 * or unverified files (rows of severity icon · `file:line:col` · source · message), inline otherwise.
 * Only a response with nothing to show reads `No issues`; a failed server or a missing
 * report is a row, never "No issues".
 */
function describeLspDiagnostics(request: Partial<LspParams> | undefined, fallbackAction: string, lines: string[]) {
	const parsed = parseLspDiagnostics(lines);
	const counts = diagnosticCounts(parsed.diagnostics);
	const failed =
		parsed.failures.length > 0 ? [span(formatCount("server failure", parsed.failures.length), "error")] : undefined;
	const unverified =
		parsed.unreported.length > 0
			? [span(formatCount("unverified file", parsed.unreported.length), "warning")]
			: undefined;
	const rows: NativeNode[] = [
		...parsed.failures.map((message, i) => statusRow(message, "error", `x${i}`)),
		...parsed.unreported.map((message, i) => statusRow(message, "warning", `u${i}`)),
		...parsed.diagnostics.map((diag, i) => diagnosticRow(diag, `d${i}`)),
		...parsed.warnings.map((message, i) => statusRow(message, "warning", `w${i}`)),
	];
	if (parsed.other.length > 0) rows.push(keyed(code(parsed.other.join("\n"), { wrap: true }), "other"));
	const hasErrors = parsed.failures.length > 0 || parsed.diagnostics.some(d => d.severity === "error");
	const meta = compact<TspText>([counts, failed, unverified, rows.length === 0 && "No issues"]);
	const head = lspNativeHead(request, fallbackAction, meta);
	const flagged =
		parsed.diagnostics.length + parsed.failures.length + parsed.unreported.length + parsed.warnings.length;
	if (flagged === 0) {
		return { tool: head, inline: true, body: rows.length > 0 ? rows : undefined } satisfies NativeToolView;
	}
	return {
		tool: head,
		tone: hasErrors ? "error" : "warning",
		body: rows,
		preview: { lines: 8 },
	} satisfies NativeToolView;
}

/**
 * References grouped by file (§7.3): a file row with the count, then each referencing
 * line as numbered source, which Tern highlights by the file's path. References past
 * the tool's context limit come without source and list as `line:col` positions.
 */
function describeLspReferences(references: readonly LspLocation[]): NativeNode[] {
	const nodes: NativeNode[] = [];
	for (const [file, locations] of groupReferencesByFile(references)) {
		const name = plainText(file);
		const sourceLines: NumberedLine[] = [];
		const positions: string[] = [];
		for (const location of locations) {
			const line = location.context.find(context => context.mark);
			if (!line) positions.push(formatPosition(location));
			// Two references on one line share its source row.
			else if (sourceLines.at(-1)?.n !== line.n) sourceLines.push({ ...line, text: plainText(line.text) });
		}
		const chip = { text: String(locations.length), title: formatCount("reference", locations.length) };
		nodes.push(
			keyed(
				col(
					compact([
						fileRow(name, { chip }),
						numberedCode(sourceLines, { path: name }),
						positions.length > 0 && text([span(positions.join("  "), "mono muted")], { wrap: "word" }),
					]),
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

/** Definition-style locations: a file row with `:line:col`, then the numbered source context. */
function describeLspLocations(
	request: Partial<LspParams> | undefined,
	fallbackAction: string,
	parsed: LspLocations,
): NativeToolView {
	const body = parsed.locations.map(location => {
		const file = plainText(location.file);
		const context = location.context.map(line => ({ ...line, text: plainText(line.text) }));
		const range = `:${location.line}:${location.col}`;
		const code = numberedCode(context, { path: file });
		const header = fileRow(displayPath(file), { range, title: file });
		return keyed(col(code ? [header, code] : [header], { gap: "xs" }), `${file}${range}`);
	});
	return {
		tool: lspNativeHead(request, fallbackAction, [formatCount(parsed.noun, parsed.count)]),
		tone: parsed.count > 0 ? undefined : "warning",
		inline: true,
		body: body.length > 0 ? body : undefined,
		preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
	};
}

function describeLspResult(result: ToolRenderResult<LspToolDetails>, args: LspParams | undefined): NativeToolView {
	const request = args ?? result.details?.request;
	const fallbackAction = result.details?.action ?? "request";
	const action = request?.action ?? result.details?.action;
	const content = result.content?.[0];
	const text = content?.type === "text" ? (content.text ?? "") : "";
	if (result.isError) return inlineErrorView(lspNativeHead(request, fallbackAction), text || "LSP request failed");
	if (!text) return { tool: lspNativeHead(request, fallbackAction, ["No result"]), tone: "warning", inline: true };

	const lines = text.split("\n");
	const locations = parseLspLocations(lines);
	if (locations?.noun === "reference") {
		const body = describeLspReferences(locations.locations);
		return {
			tool: lspNativeHead(request, fallbackAction, [formatCount("reference", locations.count)]),
			tone: locations.count > 0 ? undefined : "warning",
			inline: true,
			body: body.length > 0 ? body : undefined,
			preview: { lines: 8 },
		};
	}
	if (locations) return describeLspLocations(request, fallbackAction, locations);

	const statusError = activeThemeSymbol("status.error");
	const symbolsMatch = text.match(/Symbols in (.+):/);

	if (/```(\w*)\n([\s\S]*?)```/.test(text)) {
		return { tool: lspNativeHead(request, fallbackAction), inline: true, body: [md(text)], preview: { lines: 4 } };
	}
	if (
		/\d+\s+(?:error|warning)\(s\)/.test(text) ||
		hasStatusRow(action, lines, statusError) ||
		(request?.action ?? fallbackAction) === "diagnostics"
	) {
		return describeLspDiagnostics(request, fallbackAction, lines);
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
	const hasError = text.includes("Error:") || hasStatusRow(action, lines, statusError);
	const hasSuccess = hasStatusRow(action, lines, activeThemeSymbol("status.success")) || text.includes("Applied");
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
