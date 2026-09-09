/**
 * @-import expansion for context files (AGENTS.md / CLAUDE.md / GEMINI.md / …).
 *
 * Other coding agents (Claude Code, Goose, Cline, …) treat `@path/to/file`
 * references inside their markdown memory files as inline includes. omp
 * loads the same files in their native shape, so this module performs the
 * same expansion before content lands in the system prompt.
 *
 * Semantics mirror Claude Code's documented behavior:
 * - `@` must sit at start of line or after whitespace (so `git@github.com`
 *   and `user@example.com` are not treated as imports).
 * - Relative paths resolve against the importing file's directory, not the
 *   working directory.
 * - `~/...` resolves to the user's home directory.
 * - Imports inside fenced code blocks (` ``` ` / `~~~`) and inline code
 *   spans (`` `…` ``) are preserved verbatim so technical examples like
 *   `npm install @types/node` survive intact.
 * - Recursive imports are followed up to {@link MAX_AT_IMPORT_DEPTH} hops;
 *   cycles are broken silently.
 * - When the referenced file cannot be read, the original `@token` is
 *   left untouched and a debug log is emitted.
 *
 * @see https://docs.claude.com/en/docs/claude-code/memory#import-additional-files
 */
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { readFile } from "../capability/fs";

/** Maximum number of recursive `@`-import hops. Matches Claude Code's documented cap. */
export const MAX_AT_IMPORT_DEPTH = 5;

/**
 * Matches a candidate `@import` token: a leading boundary (start-of-string
 * or single whitespace char) and a token whose first character is path-like.
 *
 * The boundary character is captured separately so the slice arithmetic in
 * {@link expandLine} aligns with the `@` position, not the whitespace.
 */
const AT_IMPORT_REGEX = /(^|[ \t])@([./~A-Za-z0-9_-][^\s]*)/g;

/**
 * Trailing characters stripped from a captured path token: sentence-ending
 * punctuation, closing brackets, quotes. A lone trailing period is treated
 * as sentence grammar (e.g. `See @AGENTS.md.`) — legitimate file extensions
 * still match because the stripped set is anchored at the very end of the
 * token, so `@AGENTS.md` keeps the `.md` (the `d` is not in the set).
 */
const TRAILING_PUNCT = /[.,;:!?)\]}"']+$/;

export interface ExpandAtImportsOptions {
	/** Maximum hop depth (default: {@link MAX_AT_IMPORT_DEPTH}). */
	maxDepth?: number;
	/** Override the home directory used to resolve `~/...` (default: `os.homedir()`). */
	home?: string;
}

/**
 * Expand `@path/to/file` references in `content` against `filePath`'s directory.
 *
 * Returns the expanded text. When no imports match, the original string is
 * returned unchanged.
 */
export async function expandAtImports(
	content: string,
	filePath: string,
	options: ExpandAtImportsOptions = {},
): Promise<string> {
	const maxDepth = options.maxDepth ?? MAX_AT_IMPORT_DEPTH;
	const home = options.home ?? os.homedir();
	const absoluteSource = path.resolve(filePath);
	const visited = new Set<string>([absoluteSource]);
	return await expand(content, path.dirname(absoluteSource), 0, maxDepth, home, visited);
}

async function expand(
	content: string,
	baseDir: string,
	depth: number,
	maxDepth: number,
	home: string,
	visited: Set<string>,
): Promise<string> {
	if (depth >= maxDepth) return content;

	const segments = splitMarkdownSegments(content);
	const out: string[] = [];
	for (const segment of segments) {
		if (segment.kind === "code") {
			out.push(segment.text);
			continue;
		}
		out.push(await expandTextSegment(segment.text, baseDir, depth, maxDepth, home, visited));
	}
	return out.join("");
}

async function expandTextSegment(
	text: string,
	baseDir: string,
	depth: number,
	maxDepth: number,
	home: string,
	visited: Set<string>,
): Promise<string> {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		lines[i] = await expandLine(lines[i], baseDir, depth, maxDepth, home, visited);
	}
	return lines.join("\n");
}

async function expandLine(
	line: string,
	baseDir: string,
	depth: number,
	maxDepth: number,
	home: string,
	visited: Set<string>,
): Promise<string> {
	if (!line.includes("@")) return line;

	const matches: Array<{ start: number; end: number; importPath: string }> = [];
	for (const m of line.matchAll(AT_IMPORT_REGEX)) {
		const matchIndex = m.index ?? 0;
		const leading = m[1];
		const rawToken = m[2];
		const atPos = matchIndex + leading.length;
		if (isInsideInlineCode(line, atPos)) continue;

		const trimmedToken = rawToken.replace(TRAILING_PUNCT, "");
		if (trimmedToken.length === 0) continue;

		matches.push({
			start: atPos,
			end: atPos + 1 + trimmedToken.length,
			importPath: trimmedToken,
		});
	}

	if (matches.length === 0) return line;

	const parts: string[] = [];
	let cursor = 0;
	for (const m of matches) {
		parts.push(line.slice(cursor, m.start));
		const expanded = await resolveAndExpand(m.importPath, baseDir, depth, maxDepth, home, visited);
		parts.push(expanded ?? line.slice(m.start, m.end));
		cursor = m.end;
	}
	parts.push(line.slice(cursor));
	return parts.join("");
}

async function resolveAndExpand(
	importPath: string,
	baseDir: string,
	depth: number,
	maxDepth: number,
	home: string,
	visited: Set<string>,
): Promise<string | null> {
	const resolved = resolveImportPath(importPath, baseDir, home);
	if (visited.has(resolved)) {
		logger.debug("@-import: skipping cyclic include", { path: resolved });
		return null;
	}

	const content = await readFile(resolved);
	if (content === null) {
		logger.debug("@-import: file not found", { path: resolved });
		return null;
	}

	// Visited is shared across the whole expansion tree to break cycles,
	// even cycles that span multiple importing files.
	visited.add(resolved);
	return await expand(content, path.dirname(resolved), depth + 1, maxDepth, home, visited);
}

function resolveImportPath(importPath: string, baseDir: string, home: string): string {
	if (importPath === "~") return path.resolve(home);
	if (importPath.startsWith("~/")) return path.resolve(home, importPath.slice(2));
	if (path.isAbsolute(importPath)) return path.resolve(importPath);
	return path.resolve(baseDir, importPath);
}

interface MarkdownSegment {
	kind: "text" | "code";
	text: string;
}

/**
 * Split markdown into alternating text/code segments by tracking fenced
 * code blocks. Inline code spans are handled per-line by {@link isInsideInlineCode}.
 *
 * A fence is recognized as a line whose first non-whitespace run is three or
 * more backticks (or tildes). The closing fence must use the same character
 * with at least as many marks as the opener.
 */
function splitMarkdownSegments(content: string): MarkdownSegment[] {
	const segments: MarkdownSegment[] = [];
	const lines = content.split("\n");
	let buffer: string[] = [];
	let bufferKind: MarkdownSegment["kind"] = "text";
	let fenceChar = "";
	let fenceLen = 0;

	const flush = (): void => {
		if (buffer.length === 0) return;
		segments.push({ kind: bufferKind, text: buffer.join("") });
		buffer = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isLast = i === lines.length - 1;
		// Re-attach each line's trailing newline so adjacent segments
		// concatenate without losing the boundary `\n`.
		const lineText = isLast ? line : `${line}\n`;
		const fence = matchFence(line);

		if (fence && bufferKind === "text") {
			flush();
			bufferKind = "code";
			buffer.push(lineText);
			fenceChar = fence.char;
			fenceLen = fence.len;
		} else if (fence && bufferKind === "code" && fence.char === fenceChar && fence.len >= fenceLen) {
			buffer.push(lineText);
			flush();
			bufferKind = "text";
			fenceChar = "";
			fenceLen = 0;
		} else {
			buffer.push(lineText);
		}

		if (isLast) flush();
	}
	return segments;
}

function matchFence(line: string): { char: string; len: number } | null {
	let i = 0;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
	const char = line[i];
	if (char !== "`" && char !== "~") return null;
	let len = 0;
	while (i + len < line.length && line[i + len] === char) len++;
	if (len < 3) return null;
	return { char, len };
}

/**
 * Returns `true` when `position` falls inside an unclosed inline-code span on
 * this line. Implemented as a backtick-parity scan so it handles repeated
 * delimiters like `` `` literal ` backtick `` `` correctly enough for the
 * "@-imports inside `code` should not expand" case.
 */
function isInsideInlineCode(line: string, position: number): boolean {
	let inSpan = false;
	let i = 0;
	while (i < position && i < line.length) {
		if (line[i] === "`") {
			while (i < line.length && line[i] === "`") i++;
			inSpan = !inSpan;
		} else {
			i++;
		}
	}
	return inSpan;
}
