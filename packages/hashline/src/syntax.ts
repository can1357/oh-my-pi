/**
 * Syntax probe for candidate edit results, via the native tree-sitter parser.
 *
 * Replacement-boundary repair uses parsing as its semantic filter: exact
 * outside-row equality may justify dropping a duplicated payload edge, while
 * retaining a selected source boundary additionally requires source-range
 * structure, indentation, or a narrow pure-closer shape. An unrecognized
 * language yields no structural proof, so only evidence-complete textual
 * normalization remains available.
 */

import { enclosingBlockBoundaries, type NodeSpan, nodeChainAt } from "@oh-my-pi/pi-natives";

export type { NodeSpan };

/** Parse-result cache keyed by content hash + path; FIFO-bounded. */
const parseCache = new Map<string, boolean>();
const PARSE_CACHE_MAX = 256;

const boundaryCache = new Map<string, readonly number[]>();

const chainCache = new Map<string, readonly NodeSpan[]>();

/**
 * Named-node chain (innermost-first) containing `line`, excluding the file
 * root: single-line nodes beginning on the line (attributes, decorators)
 * first, then every enclosing construct. Empty when the language is unknown,
 * the line is blank, or the source cannot parse — callers treat empty as
 * "no structural evidence", never as evidence about the line.
 */
export function nodeChain(lines: readonly string[], path: string, line: number): readonly NodeSpan[] {
	const text = lines.join("\n");
	const key = `${Bun.hash(text).toString(36)}:${text.length}:${path}:${line}`;
	const cached = chainCache.get(key);
	if (cached !== undefined) return cached;
	let chain: readonly NodeSpan[];
	try {
		chain = nodeChainAt({ code: text, path, line }) ?? [];
	} catch {
		chain = [];
	}
	if (chainCache.size >= PARSE_CACHE_MAX) {
		const oldest = chainCache.keys().next().value;
		if (oldest !== undefined) chainCache.delete(oldest);
	}
	chainCache.set(key, chain);
	return chain;
}

/** Syntactic node boundaries outside a visible source range. */
export function enclosingBoundaries(
	lines: readonly string[],
	path: string,
	startLine: number,
	endLine: number,
): readonly number[] {
	const text = lines.join("\n");
	const key = `${Bun.hash(text).toString(36)}:${text.length}:${path}:${startLine}:${endLine}`;
	const cached = boundaryCache.get(key);
	if (cached !== undefined) return cached;
	let boundaries: readonly number[];
	try {
		boundaries = enclosingBlockBoundaries({ code: text, path, ranges: [{ startLine, endLine }] }) ?? [];
	} catch {
		boundaries = [];
	}
	if (boundaryCache.size >= PARSE_CACHE_MAX) {
		const oldest = boundaryCache.keys().next().value;
		if (oldest !== undefined) boundaryCache.delete(oldest);
	}
	boundaryCache.set(key, boundaries);
	return boundaries;
}

/**
 * `true` when `text` parses without a syntax error under the language inferred
 * from `path`. `false` covers "does not parse" and "cannot tell" alike — no
 * path, an unrecognized language, or a native failure — because both mean the
 * probe has nothing to prove with. Callers must therefore never treat `false`
 * as evidence *about the edit*: it only withholds permission to rewrite.
 *
 * Uses `enclosingBlockBoundaries` over a whole-file window: no node can cross
 * that window, so the boundary walk is trivial and the tree-sitter parse is the
 * only real cost. It returns `null` for an unrecognized language and for a
 * source that fails to parse, which this predicate deliberately conflates.
 */
export function parsesCleanly(path: string | undefined, text: string): boolean {
	if (path === undefined) return false;
	const key = `${Bun.hash(text).toString(36)}:${text.length}:${path}`;
	const cached = parseCache.get(key);
	if (cached !== undefined) return cached;
	const lineCount = text.length === 0 ? 1 : text.split("\n").length;
	let ok: boolean;
	try {
		ok = enclosingBlockBoundaries({ code: text, path, ranges: [{ startLine: 1, endLine: lineCount }] }) !== null;
	} catch {
		ok = false;
	}
	if (parseCache.size >= PARSE_CACHE_MAX) {
		const oldest = parseCache.keys().next().value;
		if (oldest !== undefined) parseCache.delete(oldest);
	}
	parseCache.set(key, ok);
	return ok;
}
