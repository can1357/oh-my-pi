import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Shell } from "@oh-my-pi/pi-natives";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { DEFAULT_MAX_LINES, truncateHead, truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent, sanitizeText } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import { quotePosixArgument } from "../utils/shell-quote";
import { resolveReadPath } from "./path-utils";
import { buildInMemorySelectorResult, prependSuffixResolutionNotice, toReadTruncationStats } from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { parseSel } from "./read-selector";
import { throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const JSON_FILE_PATTERN = /\.(?:jsonl?|ndjson)$/i;
const DEFAULT_JSON_QUERY_LIMIT = 100;
const MAX_JSON_QUERY_LIMIT = 1000;
const MAX_QUERY_CAPTURE_CHARS = 5 * 1024 * 1024;
const JSON_QUERY_TIMEOUT_MS = 30_000;
/**
 * Aborting a shell run costs a reader grace period (hundreds of ms), while a
 * filled page usually means jaq is about to exit; let it finish first.
 */
const PAGE_FULL_ABORT_DELAY_MS = 50;
/** Bounds the jq stderr quoted in a result; the tail keeps the error after any `debug` lines. */
const JSON_QUERY_ERROR_MAX_BYTES = 8 * 1024;
/** jaq's default pretty-print indent. */
const PRETTY_INDENT = "  ";

/** One page of query results requested via `offset`/`limit`. */
export interface JsonPage {
	offset: number;
	limit: number;
}

/** Options parsed from the query string of a `file.json?q=<filter>` read. */
export interface JsonSelector {
	query: string;
	raw: boolean;
	compact: boolean;
	/** Present when `offset` or `limit` asks for a page instead of the whole output. */
	page?: JsonPage;
}

/** Why output capture ended before jq exited on its own. */
type JqStop = "capture-cap" | "page-full";

/**
 * Splits `file.json?q=…` at its first `?`; null unless the text before it names
 * a `.json`, `.jsonl`, or `.ndjson` file. jq filters may contain `?`, paths rarely do.
 */
export function splitJsonQueryTarget(readPath: string): { jsonPath: string; queryString: string } | null {
	const queryIndex = readPath.indexOf("?");
	if (queryIndex === -1) return null;
	const jsonPath = readPath.slice(0, queryIndex);
	return JSON_FILE_PATTERN.test(jsonPath) ? { jsonPath, queryString: readPath.slice(queryIndex + 1) } : null;
}

/**
 * Parses `q`, `raw`, `compact`, `offset`, and `limit`; null without a filter.
 * `q` is percent-decoded but never form-decoded, so jq's `+` survives.
 */
export function parseJsonSelector(queryString: string): JsonSelector | null {
	const match = /(?:^|&)(?:q|query)=([^&]*)/.exec(queryString);
	if (!match?.[1]) return null;
	let query: string;
	try {
		query = decodeURIComponent(match[1]);
	} catch {
		// A filter with a bare `%` (jq modulo) is not valid percent-encoding; take it verbatim.
		query = match[1];
	}

	const params = new URLSearchParams(queryString);
	const flag = (name: string) => {
		const value = params.get(name)?.toLowerCase();
		return value === "true" || value === "1";
	};
	const offset = parseCount(params.get("offset"), 0);
	const limit = parseCount(params.get("limit"), 1);
	return {
		query,
		raw: flag("raw"),
		compact: flag("compact"),
		page:
			offset === undefined && limit === undefined
				? undefined
				: { offset: offset ?? 0, limit: Math.min(limit ?? DEFAULT_JSON_QUERY_LIMIT, MAX_JSON_QUERY_LIMIT) },
	};
}

function parseCount(value: string | null, min: number): number | undefined {
	if (value === null) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= min ? parsed : undefined;
}

/** A followable `?q=…&offset=` suffix for the next page; `remaining` is known only for array pages. */
function continuationHint(selector: JsonSelector, page: JsonPage, nextOffset: number, remaining?: number): string {
	const flags = `${selector.raw ? "&raw=true" : ""}${selector.compact ? "&compact=true" : ""}`;
	const count = remaining === undefined ? "more results" : `${remaining} more items`;
	// Inverse of the `q` decoding in parseJsonSelector: escaping only `%` and `&` round-trips any filter.
	const query = selector.query.replaceAll("%", "%25").replaceAll("&", "%26");
	return `[${count}; append ?q=${query}${flags}&limit=${page.limit}&offset=${nextOffset} to continue]`;
}

/** Index of the quote closing the JSON string that opens at `open`. */
function stringEnd(text: string, open: number): number {
	for (let i = open + 1; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === '"') return i;
	}
	return text.length - 1;
}

/**
 * Lays out one compact JSON value the way jaq pretty-prints it. Works on the
 * text, so number literals beyond f64 precision stay verbatim.
 */
function prettyJson(compact: string): string {
	let out = "";
	let depth = 0;
	for (let i = 0; i < compact.length; i++) {
		const ch = compact[i];
		switch (ch) {
			case '"': {
				const end = stringEnd(compact, i);
				out += compact.slice(i, end + 1);
				i = end;
				break;
			}
			case "{":
			case "[":
				if (compact[i + 1] === (ch === "{" ? "}" : "]")) {
					out += compact.slice(i, i + 2);
					i++;
				} else {
					depth++;
					out += `${ch}\n${PRETTY_INDENT.repeat(depth)}`;
				}
				break;
			case "}":
			case "]":
				depth--;
				out += `\n${PRETTY_INDENT.repeat(depth)}${ch}`;
				break;
			case ",":
				out += `,\n${PRETTY_INDENT.repeat(depth)}`;
				break;
			case ":":
				out += ": ";
				break;
			default:
				out += ch;
		}
	}
	return out;
}

/** Splits a compact JSON array into the compact text of each element. */
function splitCompactArray(compact: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let start = 1;
	for (let i = 0; i < compact.length; i++) {
		const ch = compact[i];
		if (ch === '"') {
			i = stringEnd(compact, i);
		} else if (ch === "[" || ch === "{") {
			depth++;
		} else if (ch === "]" || ch === "}") {
			depth--;
			if (depth === 0 && i > start) items.push(compact.slice(start, i));
		} else if (ch === "," && depth === 1) {
			items.push(compact.slice(start, i));
			start = i + 1;
		}
	}
	return items;
}

/** Renders one compact jq value as `jq` prints it under the selector's `-r`/`-c` flags. */
function renderValue(value: string, selector: JsonSelector): string {
	if (selector.raw && value.startsWith('"')) return JSON.parse(value);
	return selector.compact ? value : prettyJson(value);
}

/** Pages the elements of a query's single array result; the page stays one array. */
function pageArray(array: string, selector: JsonSelector, page: JsonPage): string {
	const items = splitCompactArray(array);
	const slice = items.slice(page.offset, page.offset + page.limit);
	const compact = `[${slice.join(",")}]`;
	const text = selector.compact ? compact : prettyJson(compact);
	const remaining = items.length - page.offset - slice.length;
	return remaining > 0 ? `${text}\n${continuationHint(selector, page, page.offset + slice.length, remaining)}` : text;
}

/** Pages a stream of query results, one value per unit. */
function pageStream(values: string[], selector: JsonSelector, page: JsonPage, more: boolean): string {
	const slice = values.slice(page.offset, page.offset + page.limit);
	const lines = slice.map(value => renderValue(value, selector));
	if (more) {
		lines.push(continuationHint(selector, page, page.offset + slice.length));
	} else if (slice.length === 0 && page.offset > 0) {
		lines.push(`[offset ${page.offset} is past the last result (${values.length} total)]`);
	}
	return lines.join("\n");
}

async function readStderr(stderrPath: string): Promise<string> {
	try {
		return await Bun.file(stderrPath).text();
	} catch (err) {
		if (isEnoent(err)) return "";
		throw err;
	}
}

/**
 * Runs the bundled jaq over `filePath` and captures stdout; stderr goes to a
 * temp file so diagnostics never mix into result values. Capture stops at
 * {@link MAX_QUERY_CAPTURE_CHARS} or after `stopAfterLines` newlines.
 *
 * Like jq, jaq reports an input that fails and goes on with the rest, exiting
 * 0 unless the last input failed; `stderr` carries those reports.
 *
 * @throws ToolError when jq fails, times out, or the caller aborts.
 */
async function runJq(
	filePath: string,
	query: string,
	flags: string[],
	options: { signal?: AbortSignal; stopAfterLines?: number },
): Promise<{ output: string; stopped?: JqStop; stderr: string }> {
	const { signal, stopAfterLines } = options;
	throwIfAborted(signal);

	const stderrPath = path.join(os.tmpdir(), `omp-jq-${crypto.randomUUID()}.err`);
	// jaq parses any argument starting with `-` as flags even when shell-quoted;
	// `--` keeps filters such as `-.price` positional.
	const command = `jq ${flags.join(" ")} -- ${quotePosixArgument(query)} ${quotePosixArgument(filePath)} 2>${quotePosixArgument(stderrPath)}`;

	let output = "";
	let lines = 0;
	let stopped: JqStop | undefined;
	let callbackError = false;
	let abortTimer: NodeJS.Timeout | undefined;
	const run = new AbortController();
	const stop = (reason: JqStop) => {
		stopped = reason;
		if (reason === "page-full") abortTimer = setTimeout(() => run.abort(), PAGE_FULL_ABORT_DELAY_MS);
		else run.abort();
	};
	const onAbort = () => run.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const result = await new Shell().run(
			{ command, timeoutMs: JSON_QUERY_TIMEOUT_MS, signal: run.signal },
			(err, chunk) => {
				if (err) callbackError = true;
				if (!chunk || stopped) return;
				const room = MAX_QUERY_CAPTURE_CHARS - output.length;
				const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
				output += piece;
				if (stopAfterLines !== undefined) {
					for (let i = piece.indexOf("\n"); i !== -1; i = piece.indexOf("\n", i + 1)) lines++;
					if (lines >= stopAfterLines) return stop("page-full");
				}
				if (output.length >= MAX_QUERY_CAPTURE_CHARS) stop("capture-cap");
			},
		);

		throwIfAborted(signal);
		if (result.timedOut && !stopped) {
			throw new ToolError(`JSON query timed out after ${JSON_QUERY_TIMEOUT_MS / 1000} seconds`);
		}
		const stderr = truncateTail(sanitizeText(await readStderr(stderrPath)).trim(), {
			maxBytes: JSON_QUERY_ERROR_MAX_BYTES,
		}).content;
		if (!stopped && (result.exitCode !== 0 || callbackError)) {
			throw new ToolError(`Failed to execute JSON query: ${stderr || `jq exited with code ${result.exitCode}`}`);
		}
		return { output, stopped, stderr };
	} finally {
		clearTimeout(abortTimer);
		signal?.removeEventListener("abort", onAbort);
		await fs.rm(stderrPath, { force: true });
	}
}

/** Puts what jq wrote to stderr, such as an input that failed, ahead of the results. */
function withStderr(text: string, stderr: string): string {
	if (!stderr) return text;
	const notice = `[jq stderr: ${stderr}]`;
	return text ? `${notice}\n${text}` : notice;
}

/**
 * Evaluates `selector.query` over `filePath` with the bundled jaq.
 *
 * Without a page, returns jaq's output verbatim (minus the final newline).
 * With one, jaq runs compact so each line is exactly one value and stops once
 * the page plus one lookahead value is captured; a single array result pages
 * its elements instead. Values are re-rendered from text, never reparsed.
 * Anything jaq wrote to stderr leads the result.
 *
 * @throws ToolError on jq errors and timeouts, or when the values before the
 * requested page exceed the capture cap.
 */
export async function executeJsonQuery(
	filePath: string,
	selector: JsonSelector,
	signal?: AbortSignal,
): Promise<string> {
	const { page } = selector;
	if (!page) {
		const flags = [...(selector.raw ? ["-r"] : []), ...(selector.compact ? ["-c"] : [])];
		const { output, stderr } = await runJq(filePath, selector.query, flags, { signal });
		return withStderr(output.endsWith("\n") ? output.slice(0, -1) : output, stderr);
	}

	const { output, stopped, stderr } = await runJq(filePath, selector.query, ["-c"], {
		signal,
		stopAfterLines: page.offset + page.limit + 1,
	});
	const values = output.split("\n");
	// jaq ends every compact value with a newline; text after the last one is a cut-off value.
	const tail = values.pop();
	if (tail && !stopped) values.push(tail);
	if (stopped === "capture-cap" && values.length <= page.offset) {
		throw new ToolError(
			`JSON query output before the requested page exceeds ${MAX_QUERY_CAPTURE_CHARS / (1024 * 1024)} MB; narrow the filter or stream large arrays with .[]`,
		);
	}
	const text =
		!stopped && values.length === 1 && values[0].startsWith("[")
			? pageArray(values[0], selector, page)
			: pageStream(values, selector, page, stopped !== undefined || values.length > page.offset + page.limit);
	return withStderr(text, stderr);
}

/** A JSON file path with its parsed `?q=` selector, ready for {@link readJson}. */
export interface ResolvedJsonReadPath {
	absolutePath: string;
	selector: JsonSelector;
	suffixResolution?: { from: string; to: string };
}

/**
 * Resolves `file.json?q=…` to an existing file, falling back to a unique
 * workspace suffix match; null when the path is not a JSON query or no file exists.
 */
export async function resolveJsonReadPath(
	session: ToolSession,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedJsonReadPath | null> {
	const target = splitJsonQueryTarget(readPath);
	if (!target) return null;
	const selector = parseJsonSelector(target.queryString);
	if (!selector) return null;

	const absolutePath = resolveReadPath(target.jsonPath, session.cwd);
	try {
		const stat = await Bun.file(absolutePath).stat();
		return stat.isFile() ? { absolutePath, selector } : null;
	} catch (error) {
		if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) return null;
	}

	const suffixMatch = await findSuffixMatchCached(session, suffixCache, target.jsonPath, signal);
	if (!suffixMatch) return null;
	try {
		const stat = await Bun.file(suffixMatch.absolutePath).stat();
		if (!stat.isFile()) return null;
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw error;
	}
	return {
		absolutePath: suffixMatch.absolutePath,
		selector,
		suffixResolution: { from: target.jsonPath, to: suffixMatch.displayPath },
	};
}

/** Runs a resolved JSON query and renders it as a read result; `lineSelector` slices the output. */
export async function readJson(
	session: ToolSession,
	resolvedJsonPath: ResolvedJsonReadPath,
	lineSelector?: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);

	const details: ReadToolDetails = {
		resolvedPath: resolvedJsonPath.absolutePath,
		suffixResolution: resolvedJsonPath.suffixResolution,
	};

	const queryOutput = await executeJsonQuery(resolvedJsonPath.absolutePath, resolvedJsonPath.selector, signal);

	const output = prependSuffixResolutionNotice(queryOutput, resolvedJsonPath.suffixResolution);

	if (lineSelector) {
		const parsedSel = parseSel(lineSelector);
		if (parsedSel.kind !== "none") {
			return buildInMemorySelectorResult(session, output, parsedSel, {
				details,
				sourcePath: resolvedJsonPath.absolutePath,
				entityLabel: "JSON query output",
				immutable: true,
			});
		}
	}

	const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES });
	details.truncation = truncation.truncated ? toReadTruncationStats(truncation) : undefined;
	const resultBuilder = toolResult<ReadToolDetails>(details)
		.text(truncation.content)
		.sourcePath(resolvedJsonPath.absolutePath);
	if (truncation.truncated) {
		resultBuilder.truncation(truncation, { direction: "head" });
	}

	return resultBuilder.done();
}
