import * as path from "node:path";
import { type SummaryResult, summarizeCode } from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { isMarkdownPath } from "@oh-my-pi/pi-tui/theme";
import type { ClientBridge } from "../session/client-bridge";
import type { ToolSession } from "../sdk";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { countTextLines } from "./read-format";
import { formatReadSummary } from "@oh-my-pi/pi-tui/tools/read";
import { throwIfAborted } from "./tool-errors";

import {
	cfgReadSummarizeMinBodyLines,
	cfgReadSummarizeMinCommentLines,
	cfgReadSummarizeMinTotalLines,
	cfgReadSummarizeUnfoldLimit,
	cfgReadSummarizeUnfoldUntil,
} from "./settings";

// Per-session memo for tree-sitter summaries. `summarizeCode` is a pure function
// of (code, path, fold settings) but costs ~12-18ms for a ~1500-line file, and a
// repeat summary read of the same unchanged file re-parses from scratch. Key on
// the content hash of the freshly-read bytes (+ path + fold settings): the file
// is still read fresh on every call, so a hit only reuses the deterministic
// parse — there is no staleness window and no stat guard is needed. Bounded LRU,
// aged out with the session via WeakMap.
// Unusable results (not parsed, or nothing elided) are memoized as `false`: the
// full SummaryResult embeds the whole source in kept segments, and the caller
// only ever renders `parsed && elided` summaries — caching the segments would
// retain up to 48 near-2MiB sources just to remember "no summary".
const SUMMARY_CACHE_MAX = 48;
const summaryParseCaches = new WeakMap<object, LRUCache<string, SummaryResult | false>>();
function getSummaryParseCache(session: object): LRUCache<string, SummaryResult | false> {
	let cache = summaryParseCaches.get(session);
	if (!cache) {
		cache = new LRUCache<string, SummaryResult | false>({ max: SUMMARY_CACHE_MAX });
		summaryParseCaches.set(session, cache);
	}
	return cache;
}
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;
/**
 * Prose files (Markdown flavors and plain text) skip code-block summarization
 * unless `read.summarize.prose` opts them in.
 */
export function isProseSummaryPath(filePath: string): boolean {
	return isMarkdownPath(filePath) || path.extname(filePath).toLowerCase() === ".txt";
}
export function getReadTextFileBridge(session: ToolSession): ClientBridge | undefined {
	const bridge = session.getClientBridge?.();
	return bridge?.capabilities.readTextFile && bridge.readTextFile ? bridge : undefined;
}

export function routeReadThroughBridge(
	session: ToolSession,
	absolutePath: string,
	options?: { line?: number; limit?: number },
): Promise<string> | undefined {
	const bridge = getReadTextFileBridge(session);
	return bridge ? bridge.readTextFile!({ path: absolutePath, ...options }) : undefined;
}
/**
 * Structural summary of `absolutePath`, or `null` when the file is too large,
 * too short, or unparseable. `diskText` lets a caller that already read the file
 * hand those bytes over instead of forcing a second read; an ACP bridge still
 * wins, since the editor's buffer is the source of truth. `languagePath`
 * overrides only parser-language inference (speculative reads pass the
 * requested lexical path while reading the resolved target); bytes and cache
 * identity stay on `absolutePath`.
 */
export async function trySummarize(
	session: ToolSession,
	absolutePath: string,
	fileSize: number,
	signal?: AbortSignal,
	diskText?: string,
	languagePath?: string,
): Promise<SummaryResult | null> {
	if (fileSize > MAX_SUMMARY_BYTES) return null;

	try {
		throwIfAborted(signal);
		const bridgePromise = routeReadThroughBridge(session, absolutePath);
		const readDisk = async () => diskText ?? (await Bun.file(absolutePath).text());
		const code = bridgePromise !== undefined ? await bridgePromise.catch(readDisk) : await readDisk();
		throwIfAborted(signal);
		const lineCount = countTextLines(code);
		if (lineCount > MAX_SUMMARY_LINES) return null;
		if (lineCount < cfgReadSummarizeMinTotalLines.get(session.settings)) return null;

		const minBodyLines = cfgReadSummarizeMinBodyLines.get(session.settings);
		const minCommentLines = cfgReadSummarizeMinCommentLines.get(session.settings);
		const unfoldUntilLines = cfgReadSummarizeUnfoldUntil.get(session.settings);
		const unfoldLimitLines = cfgReadSummarizeUnfoldLimit.get(session.settings);
		const cache = getSummaryParseCache(session);
		const cacheKey = `${absolutePath}\0${languagePath ?? ""}\0${Bun.hash(code)}\0${minBodyLines},${minCommentLines},${unfoldUntilLines},${unfoldLimitLines}`;
		const memoized = cache.get(cacheKey);
		if (memoized !== undefined) return memoized || null;
		const result = summarizeCode({
			code,
			path: languagePath ?? absolutePath,
			minBodyLines,
			minCommentLines,
			unfoldUntilLines,
			unfoldLimitLines,
		});
		const usable = result.parsed && result.elided ? result : false;
		cache.set(cacheKey, usable);
		return usable || null;
	} catch {
		return null;
	}
}

/** Read session display preferences and format a structural summary. */
export function renderSummary(session: ToolSession, summary: SummaryResult) {
	return formatReadSummary(resolveFileDisplayMode(session), summary);
}
