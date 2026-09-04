export { truncate } from "@oh-my-pi/pi-utils";

import * as fs from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Theme, theme } from "../modes/theme/theme";
import { formatGroupedFiles } from "../tools/grouped-file-output";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS } from "../tools/render-utils";
import type {
	CodeAction,
	Command,
	Diagnostic,
	DiagnosticSeverity,
	DocumentSymbol,
	Location,
	SymbolInformation,
	SymbolKind,
	TextEdit,
	WorkspaceEdit,
} from "./types";

export { detectLanguageId } from "../utils/lang-from-path";

// =============================================================================
// URI Handling (Cross-Platform)
// =============================================================================

/**
 * Convert a file path to a file:// URI.
 * Uses the URL machinery so special characters (`%`, `#`, `?`, spaces) are
 * percent-encoded; plain concatenation produced URIs that broke round-trips.
 * Handles Windows drive letters correctly.
 */
export function fileToUri(filePath: string): string {
	return Bun.pathToFileURL(path.resolve(filePath)).href;
}

/**
 * Convert a file:// URI to a file path.
 * Tolerates both percent-encoded URIs and lax servers that send raw paths.
 * Handles Windows drive letters correctly.
 */
export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) {
		return uri;
	}

	// A raw `#`/`?` parses *successfully* as fragment/query and silently
	// truncates the path — it never reaches the catch below. LSP servers do
	// not use fragments or queries on file URIs (encoded forms are %23/%3F),
	// so raw occurrences mean a lax server sent an unencoded path.
	if (uri.includes("#") || uri.includes("?")) {
		return laxUriToFile(uri);
	}

	try {
		return Bun.fileURLToPath(uri);
	} catch {
		// Not a well-formed file URL (unencoded characters, stray `%`, host
		// component). Fall back to a lenient manual conversion.
		return laxUriToFile(uri);
	}
}

function laxUriToFile(uri: string): string {
	let filePath = uri.slice(7);
	try {
		filePath = decodeURIComponent(filePath);
	} catch {
		// Invalid percent-encoding — treat as a literal path.
	}

	// Windows: file:///C:/path → C:/path (strip leading slash before drive letter)
	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
		filePath = filePath.slice(1);
	}

	return filePath;
}

/** Map that treats equivalent file URI spellings as the same key. */
export class EquivalentUriMap<Value> extends Map<string, Value> {
	#key(uri: string): string {
		if (!uri.startsWith("file://")) return uri;
		const filePath = path.normalize(uriToFile(uri));
		return process.platform === "win32" ? filePath.toLowerCase() : filePath;
	}

	override delete(uri: string): boolean {
		const key = this.#key(uri);
		return super.delete(key);
	}

	override get(uri: string): Value | undefined {
		const key = this.#key(uri);
		return super.get(key);
	}

	override has(uri: string): boolean {
		const key = this.#key(uri);
		return super.has(key);
	}

	override set(uri: string, value: Value): this {
		const key = this.#key(uri);
		return super.set(key, value);
	}
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

const SEVERITY_NAMES: Record<DiagnosticSeverity, string> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
};

/**
 * Convert diagnostic severity number to string name.
 */
export function severityToString(severity?: DiagnosticSeverity): string {
	return SEVERITY_NAMES[severity ?? 1] ?? "unknown";
}

/**
 * Sort diagnostics by severity, then by location and message.
 */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.sort((a, b) => {
		const aSeverity = a.severity ?? 1;
		const bSeverity = b.severity ?? 1;
		if (aSeverity !== bSeverity) return aSeverity - bSeverity;
		const aLine = a.range.start.line;
		const bLine = b.range.start.line;
		if (aLine !== bLine) return aLine - bLine;
		const aCol = a.range.start.character;
		const bCol = b.range.start.character;
		if (aCol !== bCol) return aCol - bCol;
		return a.message.localeCompare(b.message);
	});
}

/**
 * Get icon for diagnostic severity.
 */
export function severityToIcon(severity?: DiagnosticSeverity): string {
	const currentTheme = theme as Theme | undefined;
	const fallback = currentTheme?.format?.bullet ?? "*";
	const status = currentTheme?.status;
	switch (severity ?? 1) {
		case 1:
			return status?.error ?? fallback;
		case 2:
			return status?.warning ?? fallback;
		case 3:
			return status?.info ?? fallback;
		case 4:
			return currentTheme?.format?.bullet ?? fallback;
		default:
			return status?.error ?? fallback;
	}
}

/**
 * Strip noise from diagnostic messages (clippy URLs, override hints).
 */
function stripDiagnosticNoise(message: string): string {
	return message
		.split("\n")
		.filter(line => {
			const trimmed = line.trim();
			// Skip "for further information visit <url>" lines
			if (trimmed.startsWith("for further information visit")) return false;
			// Skip bare URLs
			if (/^https?:\/\//.test(trimmed)) return false;
			return true;
		})
		.join("\n")
		.trim();
}

/**
 * Format a diagnostic as a human-readable string.
 */
export function formatDiagnostic(diagnostic: Diagnostic, filePath: string): string {
	const severity = severityToString(diagnostic.severity);
	const line = diagnostic.range.start.line + 1;
	const col = diagnostic.range.start.character + 1;
	const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
	const code = diagnostic.code ? ` (${diagnostic.code})` : "";
	const message = stripDiagnosticNoise(diagnostic.message);

	return `${filePath}:${line}:${col} [${severity}] ${source}${message}${code}`;
}

// Regex: split on the first `:digits:digits` boundary to separate path from the rest
const DIAG_PATH_RE = /^(.+?):(\d+:\d+\s+.*)$/;

/**
 * Reformat pre-formatted diagnostic messages into a multi-level, prefix-folded
 * directory/file grouping (see `formatGroupedFiles`).
 * Input:  ["path:line:col [sev] msg", ...]
 * Output: "# pkg/src/\n## file.ts\n  line:col [sev] msg"
 *
 * Messages that don't match the expected format are appended ungrouped at the end.
 */
export function formatGroupedDiagnosticMessages(messages: string[]): string {
	const diagnosticsByFile = new Map<string, string[]>();
	const fileOrder: string[] = [];
	const ungrouped: string[] = [];

	for (const msg of messages) {
		const match = DIAG_PATH_RE.exec(msg);
		if (!match) {
			ungrouped.push(msg);
			continue;
		}

		const [, rawFilePath, rest] = match;
		const filePath = rawFilePath.replace(/\\/g, "/");
		if (!diagnosticsByFile.has(filePath)) {
			diagnosticsByFile.set(filePath, []);
			fileOrder.push(filePath);
		}
		diagnosticsByFile.get(filePath)?.push(rest);
	}

	if (diagnosticsByFile.size === 0) {
		return ungrouped.join("\n");
	}

	const grouped = formatGroupedFiles(fileOrder, filePath => ({
		modelLines: (diagnosticsByFile.get(filePath) ?? []).map(diagnostic => `  ${diagnostic}`),
	}));
	const lines: string[] = grouped.model;

	if (ungrouped.length > 0) {
		lines.push("");
		for (const msg of ungrouped) {
			lines.push(msg);
		}
	}

	return lines.join("\n");
}

/**
 * Format diagnostics grouped by severity.
 */
export function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };

	for (const d of diagnostics) {
		const sev = severityToString(d.severity);
		if (sev in counts) {
			counts[sev as keyof typeof counts]++;
		}
	}

	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);

	return parts.length > 0 ? parts.join(", ") : "no issues";
}

export function summarizeDiagnosticMessages(messages: string[]): { summary: string; errored: boolean } {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const message of messages) {
		const match = message.match(/\[(error|warning|info|hint)\]/i);
		if (!match) continue;
		const key = match[1].toLowerCase() as keyof typeof counts;
		counts[key] += 1;
	}

	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);

	return {
		summary: parts.length > 0 ? parts.join(", ") : "no issues",
		errored: counts.error > 0,
	};
}

// =============================================================================
// Location Formatting
// =============================================================================

/**
 * Format a location as file:line:col relative to cwd.
 */
export function formatLocation(location: Location, cwd: string): string {
	const file = formatPathRelativeToCwd(uriToFile(location.uri), cwd);
	const line = location.range.start.line + 1;
	const col = location.range.start.character + 1;
	return `${file}:${line}:${col}`;
}

/**
 * Format a position as line:col.
 */
export function formatPosition(line: number, col: number): string {
	return `${line}:${col}`;
}

// =============================================================================
// WorkspaceEdit Formatting
// =============================================================================

/**
 * Format a text edit as a preview.
 */
export function formatTextEdit(edit: TextEdit, maxLength = TRUNCATE_LENGTHS.TITLE): string {
	const range = `${edit.range.start.line + 1}:${edit.range.start.character + 1}`;
	const escapedText = edit.newText.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
	const preview = escapedText.length > maxLength ? `${escapedText.slice(0, maxLength)}…` : escapedText;
	return `line ${range} ${theme?.nav.cursor ?? "→"} "${replaceTabs(preview)}"`;
}

/**
 * Format a workspace edit with bounded text-edit details.
 */
export function formatWorkspaceEdit(edit: WorkspaceEdit, cwd: string): string[] {
	const results: string[] = [];
	let textEditCount = 0;
	let shownTextEdits = 0;

	const addTextEdits = (uri: string, textEdits: TextEdit[]): void => {
		const file = formatPathRelativeToCwd(uriToFile(uri), cwd);
		results.push(`${file}: ${textEdits.length} edit${textEdits.length > 1 ? "s" : ""}`);
		textEditCount += textEdits.length;
		for (const textEdit of textEdits) {
			if (shownTextEdits >= PREVIEW_LIMITS.COLLAPSED_ITEMS) continue;
			results.push(`  ${formatTextEdit(textEdit)}`);
			shownTextEdits++;
		}
	};

	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			addTextEdits(uri, textEdits);
		}
	}

	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("edits" in change && change.textDocument) {
				addTextEdits(change.textDocument.uri, change.edits);
			} else if ("kind" in change) {
				switch (change.kind) {
					case "create":
						results.push(`CREATE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
						break;
					case "rename":
						results.push(
							`RENAME: ${formatPathRelativeToCwd(uriToFile(change.oldUri), cwd)} ${theme.nav.cursor} ${formatPathRelativeToCwd(uriToFile(change.newUri), cwd)}`,
						);
						break;
					case "delete":
						results.push(`DELETE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
						break;
				}
			}
		}
	}

	if (shownTextEdits < textEditCount) {
		results.push(
			`INCOMPLETE preview: showing ${shownTextEdits}/${textEditCount} text edits; ${textEditCount - shownTextEdits} omitted`,
		);
	}
	return results;
}

// =============================================================================
// Symbol Formatting
// =============================================================================

function getSymbolKindIcons(): Record<SymbolKind, string> {
	const currentTheme = theme as Theme | undefined;
	const fallback = currentTheme?.format?.bullet ?? "*";
	const dash = currentTheme?.format?.dash ?? fallback;
	const icon = currentTheme?.icon;

	const file = icon?.file ?? fallback;
	const folder = icon?.folder ?? fallback;
	const pkg = icon?.package ?? folder;
	const model = icon?.model ?? fallback;
	const func = icon?.auto ?? dash;

	return {
		1: file, // File
		2: folder, // Module
		3: folder, // Namespace
		4: pkg, // Package
		5: model, // Class
		6: func, // Method
		7: fallback, // Property
		8: fallback, // Field
		9: func, // Constructor
		10: fallback, // Enum
		11: model, // Interface
		12: func, // Function
		13: fallback, // Variable
		14: fallback, // Constant
		15: fallback, // String
		16: fallback, // Number
		17: fallback, // Boolean
		18: fallback, // Array
		19: fallback, // Object
		20: fallback, // Key
		21: fallback, // Null
		22: fallback, // EnumMember
		23: folder, // Struct
		24: fallback, // Event
		25: fallback, // Operator
		26: fallback, // TypeParameter
	};
}

/**
 * Get icon for symbol kind.
 */
export function symbolKindToIcon(kind: SymbolKind): string {
	const currentTheme = theme as Theme | undefined;
	const bullet = currentTheme?.format?.bullet ?? "*";
	return getSymbolKindIcons()[kind] ?? bullet;
}

/**
 * Get name for symbol kind.
 */
export function symbolKindToName(kind: SymbolKind): string {
	const names: Record<number, string> = {
		1: "File",
		2: "Module",
		3: "Namespace",
		4: "Package",
		5: "Class",
		6: "Method",
		7: "Property",
		8: "Field",
		9: "Constructor",
		10: "Enum",
		11: "Interface",
		12: "Function",
		13: "Variable",
		14: "Constant",
		15: "String",
		16: "Number",
		17: "Boolean",
		18: "Array",
		19: "Object",
		20: "Key",
		21: "Null",
		22: "EnumMember",
		23: "Struct",
		24: "Event",
		25: "Operator",
		26: "TypeParameter",
	};
	return names[kind] ?? "Unknown";
}

/**
 * Format a document symbol with optional hierarchy.
 */
export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string[] {
	const prefix = "  ".repeat(indent);
	const icon = symbolKindToIcon(symbol.kind);
	const line = symbol.range.start.line + 1;
	const detail = symbol.detail ? ` ${symbol.detail}` : "";
	const results = [`${prefix}${icon} ${symbol.name}${detail} @ line ${line}`];

	if (symbol.children) {
		for (const child of symbol.children) {
			results.push(...formatDocumentSymbol(child, indent + 1));
		}
	}

	return results;
}

/**
 * Format a symbol information (flat format).
 */
export function formatSymbolInformation(symbol: SymbolInformation, cwd: string): string {
	const icon = symbolKindToIcon(symbol.kind);
	const location = formatLocation(symbol.location, cwd);
	const container = symbol.containerName ? ` (${symbol.containerName})` : "";
	return `${icon} ${symbol.name}${container} @ ${location}`;
}

export function filterWorkspaceSymbols(symbols: SymbolInformation[], query: string): SymbolInformation[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return symbols;
	return symbols.filter(symbol => {
		const fields = [symbol.name, symbol.containerName ?? "", uriToFile(symbol.location.uri)];
		return fields.some(field => field.toLowerCase().includes(needle));
	});
}

export function dedupeWorkspaceSymbols(symbols: SymbolInformation[]): SymbolInformation[] {
	const seen = new Set<string>();
	const unique: SymbolInformation[] = [];
	for (const symbol of symbols) {
		const key = [
			symbol.name,
			symbol.containerName ?? "",
			symbol.kind,
			symbol.location.uri,
			symbol.location.range.start.line,
			symbol.location.range.start.character,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(symbol);
	}
	return unique;
}

export function formatCodeAction(action: CodeAction | Command, index: number): string {
	const kind = "kind" in action && action.kind ? action.kind : "action";
	const preferred = "isPreferred" in action && action.isPreferred ? " (preferred)" : "";
	const disabled = "disabled" in action && action.disabled ? ` (disabled: ${action.disabled.reason})` : "";
	return `${index}: [${kind}] ${action.title}${preferred}${disabled}`;
}

export interface CodeActionApplyDependencies {
	resolveCodeAction?: (action: CodeAction) => Promise<CodeAction>;
	applyWorkspaceEdit: (edit: WorkspaceEdit) => Promise<string[]>;
	executeCommand: (command: Command) => Promise<void>;
}

export interface AppliedCodeActionResult {
	title: string;
	edits: string[];
	executedCommands: string[];
}

function isCommandItem(action: CodeAction | Command): action is Command {
	return typeof action.command === "string";
}

export async function applyCodeAction(
	action: CodeAction | Command,
	dependencies: CodeActionApplyDependencies,
): Promise<AppliedCodeActionResult | null> {
	if (isCommandItem(action)) {
		await dependencies.executeCommand(action);
		return { title: action.title, edits: [], executedCommands: [action.command] };
	}

	let resolvedAction = action;
	if (!resolvedAction.edit && dependencies.resolveCodeAction) {
		try {
			resolvedAction = await dependencies.resolveCodeAction(resolvedAction);
		} catch {
			// Resolve is optional; continue with unresolved action.
		}
	}

	const edits = resolvedAction.edit ? await dependencies.applyWorkspaceEdit(resolvedAction.edit) : [];
	const executedCommands: string[] = [];
	if (resolvedAction.command) {
		await dependencies.executeCommand(resolvedAction.command);
		executedCommands.push(resolvedAction.command.command);
	}

	if (edits.length === 0 && executedCommands.length === 0) {
		return null;
	}

	return { title: resolvedAction.title, edits, executedCommands };
}

const GLOB_PATTERN_CHARS = /[*?[{]/;

export function hasGlobPattern(value: string): boolean {
	return GLOB_PATTERN_CHARS.test(value);
}

export async function collectGlobMatches(
	pattern: string,
	cwd: string,
	maxMatches: number,
): Promise<{ matches: string[]; truncated: boolean }> {
	const normalizedLimit = Number.isFinite(maxMatches) ? Math.max(1, Math.trunc(maxMatches)) : 1;
	const matches: string[] = [];
	for await (const match of new Bun.Glob(pattern).scan({ cwd })) {
		if (matches.length >= normalizedLimit) {
			return { matches, truncated: true };
		}
		matches.push(match);
	}
	return { matches, truncated: false };
}

export async function resolveDiagnosticTargets(
	file: string,
	cwd: string,
	maxMatches: number,
): Promise<{ matches: string[]; truncated: boolean }> {
	if (!hasGlobPattern(file)) {
		return { matches: [file], truncated: false };
	}

	const resolved = resolveToCwd(file, cwd);
	try {
		const stat = await fs.stat(resolved);
		if (stat.isFile()) {
			return { matches: [file], truncated: false };
		}
	} catch (error) {
		if (!isEnoent(error)) {
			throw error;
		}
	}

	return collectGlobMatches(file, cwd, maxMatches);
}
// =============================================================================
// Hover Content Extraction
// =============================================================================

/**
 * Extract plain text from hover contents.
 */
export function extractHoverText(
	contents: string | { kind: string; value: string } | { language: string; value: string } | unknown[],
): string {
	if (typeof contents === "string") {
		return contents;
	}

	if (Array.isArray(contents)) {
		return contents.map(c => extractHoverText(c as string | { kind: string; value: string })).join("\n\n");
	}

	if (typeof contents === "object" && contents !== null) {
		if ("value" in contents && typeof contents.value === "string") {
			return contents.value;
		}
	}

	return String(contents);
}

// =============================================================================
// General Utilities

function firstNonWhitespaceColumn(lineText: string): number {
	const match = lineText.match(/\S/);
	return match ? (match.index ?? 0) : 0;
}

const BARE_IDENTIFIER_RE = /^[$A-Za-z_][\w$]*$/;
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;

function findSymbolMatchIndexes(lineText: string, symbol: string, caseInsensitive = false): number[] {
	if (symbol.length === 0) return [];
	const haystack = caseInsensitive ? lineText.toLowerCase() : lineText;
	const needle = caseInsensitive ? symbol.toLowerCase() : symbol;
	const requireWordBoundary = BARE_IDENTIFIER_RE.test(symbol);
	const indexes: number[] = [];
	let fromIndex = 0;
	while (fromIndex <= haystack.length - needle.length) {
		const matchIndex = haystack.indexOf(needle, fromIndex);
		if (matchIndex === -1) break;
		if (requireWordBoundary) {
			const before = matchIndex > 0 ? haystack[matchIndex - 1] : "";
			const afterIdx = matchIndex + needle.length;
			const after = afterIdx < haystack.length ? haystack[afterIdx] : "";
			if (IDENTIFIER_CHAR_RE.test(before) || IDENTIFIER_CHAR_RE.test(after)) {
				fromIndex = matchIndex + 1;
				continue;
			}
		}
		indexes.push(matchIndex);
		fromIndex = matchIndex + needle.length;
	}
	return indexes;
}

/**
 * Parses a symbol spec of the form `name` or `name#N` where N is the 1-indexed
 * occurrence on the target line. Returns `name` and `occurrence` (default 1).
 *
 * Greedy match on `.+` so `#name#2` parses as symbol=`#name` (TS private field)
 * with occurrence 2. Specs without a trailing `#\d+` are treated as literal.
 */
function parseSymbolSpec(spec: string): { symbol: string; occurrence: number } {
	const match = spec.match(/^(.+)#(\d+)$/);
	if (!match) return { symbol: spec, occurrence: 1 };
	const occurrence = Math.max(1, Number.parseInt(match[2], 10));
	return { symbol: match[1], occurrence };
}

export async function resolveSymbolColumn(filePath: string, line: number, symbolSpec?: string): Promise<number> {
	const lineNumber = Math.max(1, line);
	try {
		const fileText = await Bun.file(filePath).text();
		const lines = fileText.split("\n");
		const targetLine = lines[lineNumber - 1] ?? "";
		if (!symbolSpec) {
			return firstNonWhitespaceColumn(targetLine);
		}

		const { symbol, occurrence } = parseSymbolSpec(symbolSpec);
		const exactIndexes = findSymbolMatchIndexes(targetLine, symbol);
		const fallbackIndexes = exactIndexes.length > 0 ? exactIndexes : findSymbolMatchIndexes(targetLine, symbol, true);
		if (fallbackIndexes.length === 0) {
			throw new Error(`Symbol "${symbol}" not found on line ${lineNumber}`);
		}
		if (occurrence > fallbackIndexes.length) {
			throw new Error(
				`Symbol "${symbol}" occurrence ${occurrence} is out of bounds on line ${lineNumber} (found ${fallbackIndexes.length})`,
			);
		}
		return fallbackIndexes[occurrence - 1];
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${filePath}`);
		}
		throw error;
	}
}

export async function readLocationContext(filePath: string, line: number, contextLines = 1): Promise<string[]> {
	const targetLine = Math.max(1, line);
	const surrounding = Math.max(0, contextLines);
	try {
		const fileText = await Bun.file(filePath).text();
		const lines = fileText.split("\n");
		if (lines.length === 0) return [];

		const startLine = Math.max(1, targetLine - surrounding);
		const endLine = Math.min(lines.length, targetLine + surrounding);
		const context: string[] = [];
		for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
			const content = lines[currentLine - 1] ?? "";
			context.push(`${currentLine}: ${content}`);
		}
		return context;
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		throw error;
	}
}
