export { truncate } from "@oh-my-pi/pi-utils";

import * as fs from "node:fs/promises";
import { isEnoent, pathExists } from "@oh-my-pi/pi-utils";
import { formatPathRelativeToCwd, resolveToCwd, specialFileKind } from "../tools/path-utils";
import {
	type CodeAction,
	type Command,
	type Diagnostic,
	type DiagnosticSeverity,
	type DocumentSymbol,
	type Location,
	SYMBOL_KIND_NAMES,
	type SymbolInformation,
	type SymbolKind,
	type TextEdit,
	type WorkspaceEdit,
} from "./types";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { uriToFile } from "./uri";

export { detectLanguageId } from "../utils/lang-from-path";

const UTF8_KEEPING_BOM = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Read a file's text, refusing FIFOs, devices and sockets, whose reads can block forever
 * or never end. Edit snapshots keep the BOM so they match the on-disk text.
 */
export async function readTextFromDisk(filePath: string, keepBom = false): Promise<string> {
	const kind = specialFileKind(await fs.stat(filePath));
	if (kind) throw new Error(`Cannot open '${filePath}': it is a ${kind}, not a regular file or directory.`);
	const file = Bun.file(filePath);
	return keepBom ? UTF8_KEEPING_BOM.decode(await file.bytes()) : file.text();
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

function diagnosticFingerprint(d: Diagnostic): string {
	return `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.source ?? ""}:${d.message}`;
}

/**
 * Merge two diagnostic lists, preserving order and deduplicating by range, source and message.
 */
export function mergeDiagnosticLists(primary: Diagnostic[], secondary: Diagnostic[]): Diagnostic[] {
	if (primary.length === 0) return secondary.slice();
	if (secondary.length === 0) return primary.slice();
	const seen = new Set<string>();
	const merged: Diagnostic[] = [];
	for (const d of primary) {
		const key = diagnosticFingerprint(d);
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(d);
		}
	}
	for (const d of secondary) {
		const key = diagnosticFingerprint(d);
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(d);
		}
	}
	return merged;
}

/**
 * Get icon for diagnostic severity.
 */
export function severityToIcon(severity?: DiagnosticSeverity): string {
	const symbols = currentTheme().symbols;
	switch (severity ?? 1) {
		case 2:
			return symbols.symbol("status.warning");
		case 3:
			return symbols.symbol("status.info");
		case 4:
			return symbols.symbol("format.bullet");
		default:
			return symbols.symbol("status.error");
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
 * Format a workspace edit as a summary of changes.
 */
export function formatWorkspaceEdit(edit: WorkspaceEdit, cwd: string): string[] {
	const results: string[] = [];

	// Handle changes map (legacy format)
	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const file = formatPathRelativeToCwd(uriToFile(uri), cwd);
			results.push(`${file}: ${textEdits.length} edit${textEdits.length > 1 ? "s" : ""}`);
		}
	}

	// Handle documentChanges array (modern format)
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("edits" in change && change.textDocument) {
				const file = formatPathRelativeToCwd(uriToFile(change.textDocument.uri), cwd);
				results.push(`${file}: ${change.edits.length} edit${change.edits.length > 1 ? "s" : ""}`);
			} else if ("kind" in change) {
				switch (change.kind) {
					case "create":
						results.push(`CREATE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
						break;
					case "rename":
						results.push(
							`RENAME: ${formatPathRelativeToCwd(uriToFile(change.oldUri), cwd)} ${navArrow()} ${formatPathRelativeToCwd(uriToFile(change.newUri), cwd)}`,
						);
						break;
					case "delete":
						results.push(`DELETE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
						break;
				}
			}
		}
	}

	return results;
}

/**
 * Format a text edit as a preview.
 */
export function formatTextEdit(edit: TextEdit, maxLength = 50): string {
	const range = `${edit.range.start.line + 1}:${edit.range.start.character + 1}`;
	const preview =
		edit.newText.length > maxLength
			? `${edit.newText.slice(0, maxLength).replace(/\n/g, "\\n")}…`
			: edit.newText.replace(/\n/g, "\\n");
	return `line ${range} ${navArrow()} "${preview}"`;
}

// =============================================================================
// Symbol Formatting
// =============================================================================

function getSymbolKindIcons(): Record<SymbolKind, string> {
	const symbols = currentTheme().symbols;
	const fallback = symbols.symbol("format.bullet");
	const file = symbols.symbol("icon.file");
	const folder = symbols.symbol("icon.folder");
	const pkg = symbols.symbol("icon.package");
	const model = symbols.symbol("icon.model");
	const func = symbols.symbol("icon.auto");

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
	return getSymbolKindIcons()[kind] ?? currentTheme().symbols.symbol("format.bullet");
}

/**
 * Get name for symbol kind.
 */
export function symbolKindToName(kind: SymbolKind): string {
	return SYMBOL_KIND_NAMES[kind] ?? "Unknown";
}

/**
 * Format a document symbol with optional hierarchy.
 */
export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string[] {
	const prefix = "  ".repeat(indent);
	const icon = symbolKindToIcon(symbol.kind);
	const line = symbol.selectionRange.start.line + 1;
	const detail = symbol.detail ? ` ${symbol.detail}` : "";
	const results = [`${prefix}${icon} ${symbol.name}${detail} @ line ${line}`];

	if (symbol.children) {
		for (const child of symbol.children) {
			results.push(...formatDocumentSymbol(child, indent + 1));
		}
	}

	return results;
}

/** The theme's arrow glyph. */
function navArrow(): string {
	return currentTheme().symbols.symbol("nav.cursor");
}

/**
 * Document symbols whose name contains `query` (case-insensitive), each with its
 * subtree and, when nested, the path of its containers.
 */
export function formatMatchingDocumentSymbols(symbols: DocumentSymbol[], query: string): string[] {
	const needle = query.trim().toLowerCase();
	const lines: string[] = [];
	const visit = (symbol: DocumentSymbol, containers: string[]): void => {
		if (symbol.name.toLowerCase().includes(needle)) {
			const [head, ...rest] = formatDocumentSymbol(symbol);
			lines.push(containers.length > 0 ? `${head} (in ${containers.join(".")})` : head!, ...rest);
			return;
		}
		for (const child of symbol.children ?? []) visit(child, [...containers, symbol.name]);
	};
	for (const symbol of symbols) visit(symbol, []);
	return lines;
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

/**
 * Appends the `extra` code actions that do not already appear, identically, in `base`.
 * `code_actions` merges its unfiltered and `source`-kind requests with this; servers that
 * ignore `context.only` answer both with the same actions. Same-titled actions that differ
 * in any field (edit, command, data) stay distinct, as do repeats within one response.
 */
export function mergeCodeActions(
	base: (CodeAction | Command)[] | null,
	extra: (CodeAction | Command)[] | null,
): (CodeAction | Command)[] {
	const merged = base ?? [];
	const seen = new Set(merged.map(action => JSON.stringify(action)));
	return [...merged, ...(extra ?? []).filter(action => !seen.has(JSON.stringify(action)))];
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
	let resolveError: unknown;
	if (!resolvedAction.edit && dependencies.resolveCodeAction) {
		try {
			resolvedAction = await dependencies.resolveCodeAction(resolvedAction);
		} catch (error) {
			// Resolve is optional: an action that already carries a command still applies.
			resolveError = error;
		}
	}

	const edits = resolvedAction.edit ? await dependencies.applyWorkspaceEdit(resolvedAction.edit) : [];
	const executedCommands: string[] = [];
	if (resolvedAction.command) {
		await dependencies.executeCommand(resolvedAction.command);
		executedCommands.push(resolvedAction.command.command);
	}

	if (edits.length === 0 && executedCommands.length === 0) {
		if (resolveError !== undefined) {
			const reason = resolveError instanceof Error ? resolveError.message : String(resolveError);
			throw new Error(`codeAction/resolve failed for "${action.title}": ${reason}`);
		}
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

/**
 * Files a diagnostics `file` names: a path, a glob, or a `;`-separated list of
 * either (unless the whole string is itself an existing path).
 */
export async function resolveDiagnosticTargets(
	file: string,
	cwd: string,
	maxMatches: number,
): Promise<{ matches: string[]; truncated: boolean }> {
	const entries = file
		.split(";")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
	if (entries.length > 1 && !(await pathExists(resolveToCwd(file, cwd)))) {
		const matches = new Set<string>();
		for (const entry of entries) {
			if (matches.size >= maxMatches) return { matches: [...matches], truncated: true };
			const resolved = await resolveDiagnosticTarget(entry, cwd, maxMatches - matches.size);
			for (const match of resolved.matches) matches.add(match);
			if (resolved.truncated) return { matches: [...matches], truncated: true };
		}
		return { matches: [...matches], truncated: false };
	}
	return resolveDiagnosticTarget(file, cwd, maxMatches);
}

async function resolveDiagnosticTarget(
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
export function parseSymbolSpec(spec: string): { symbol: string; occurrence: number } {
	const match = spec.match(/^(.+)#(\d+)$/);
	if (!match) return { symbol: spec, occurrence: 1 };
	const occurrence = Math.max(1, Number.parseInt(match[2], 10));
	return { symbol: match[1], occurrence };
}

export async function resolveSymbolColumn(filePath: string, line: number, symbolSpec?: string): Promise<number> {
	const lineNumber = Math.max(1, line);
	try {
		const fileText = await readTextFromDisk(filePath);
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

/**
 * Position of `symbolSpec` (`name` or `name#N`) when no line was given: its Nth
 * whole-word occurrence in the file, falling back to case-insensitive matches.
 */
export async function findSymbolInFile(
	filePath: string,
	symbolSpec: string,
): Promise<{ line: number; character: number }> {
	const { symbol, occurrence } = parseSymbolSpec(symbolSpec);
	let fileText: string;
	try {
		fileText = await readTextFromDisk(filePath);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${filePath}`);
		throw error;
	}
	const lines = fileText.split("\n");
	for (const caseInsensitive of [false, true]) {
		let seen = 0;
		for (let index = 0; index < lines.length; index++) {
			for (const character of findSymbolMatchIndexes(lines[index]!, symbol, caseInsensitive)) {
				seen++;
				if (seen === occurrence) return { line: index + 1, character };
			}
		}
		if (seen > 0) {
			throw new Error(`Symbol "${symbol}" occurrence ${occurrence} is out of bounds in ${filePath} (found ${seen})`);
		}
	}
	throw new Error(`Symbol "${symbol}" not found in ${filePath}`);
}

export async function readLocationContext(filePath: string, line: number, contextLines = 1): Promise<string[]> {
	const targetLine = Math.max(1, line);
	const surrounding = Math.max(0, contextLines);
	try {
		// Context is decoration: a special-file location keeps its header, like a missing file.
		if (specialFileKind(await fs.stat(filePath))) return [];
		const fileText = await Bun.file(filePath).text();
		const lines = fileText.split(/\r?\n/);
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
