import * as path from "node:path";
import { type SummaryResult, summarizeCode } from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { isMarkdownPath } from "../modes/theme/theme";
import type { ToolSession } from "../sdk";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import {
	canMergeBracePair,
	countTextLines,
	type ElidedRange,
	formatMergedBraceLine,
	formatSingleLine,
} from "./read-format";
import { throwIfAborted } from "./tool-errors";

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
export function routeReadThroughBridge(
	session: ToolSession,
	absolutePath: string,
	options?: { line?: number; limit?: number },
): Promise<string> | undefined {
	const bridge = session.getClientBridge?.();
	if (!bridge?.capabilities.readTextFile || !bridge.readTextFile) return undefined;
	return bridge.readTextFile({ path: absolutePath, ...options });
}
/**
 * Structural summary of `absolutePath`, or `null` when the file is too large,
 * too short, or unparseable. `diskText` lets a caller that already read the file
 * hand those bytes over instead of forcing a second read; an ACP bridge still
 * wins, since the editor's buffer is the source of truth.
 */
export async function trySummarize(
	session: ToolSession,
	absolutePath: string,
	fileSize: number,
	signal?: AbortSignal,
	diskText?: string,
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
		if (lineCount < session.settings.get("read.summarize.minTotalLines")) return null;

		const minBodyLines = session.settings.get("read.summarize.minBodyLines");
		const minCommentLines = session.settings.get("read.summarize.minCommentLines");
		const unfoldUntilLines = session.settings.get("read.summarize.unfoldUntil");
		const unfoldLimitLines = session.settings.get("read.summarize.unfoldLimit");
		const cache = getSummaryParseCache(session);
		const cacheKey = `${absolutePath}\0${Bun.hash(code)}\0${minBodyLines},${minCommentLines},${unfoldUntilLines},${unfoldLimitLines}`;
		const memoized = cache.get(cacheKey);
		if (memoized !== undefined) return memoized || null;
		const result = summarizeCode({
			code,
			path: absolutePath,
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

export function renderSummary(
	session: ToolSession,
	summary: SummaryResult,
): {
	text: string;
	displayText: string;
	elidedRanges: ElidedRange[];
	elidedLines: number;
} {
	const displayMode = resolveFileDisplayMode(session);
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

	// Flatten segments into per-line units so we can merge a kept-head /
	// elided / kept-tail sandwich into a single brace-pair line when the
	// boundary lines look like `… {` and `}` (or matching variants).
	type Unit =
		| { kind: "line"; line: number; text: string }
		| { kind: "elided"; startLine: number; endLine: number }
		| {
				kind: "merged";
				startLine: number;
				endLine: number;
				headText: string;
				tailText: string;
		  };

	const raw: Unit[] = [];
	for (const segment of summary.segments) {
		if (segment.kind === "elided") {
			raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
			continue;
		}
		const text = segment.text ?? "";
		if (text.length === 0) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			raw.push({ kind: "line", line: segment.startLine + i, text: lines[i] });
		}
	}

	const units: Unit[] = [];
	let i = 0;
	while (i < raw.length) {
		const cur = raw[i];
		if (cur.kind === "elided") {
			const prev = units.length > 0 ? units[units.length - 1] : null;
			const next = i + 1 < raw.length ? raw[i + 1] : null;
			if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
				units.pop();
				units.push({
					kind: "merged",
					startLine: prev.line,
					endLine: next.line,
					headText: prev.text,
					tailText: next.text,
				});
				i += 2;
				continue;
			}
		}
		units.push(cur);
		i++;
	}

	const modelParts: string[] = [];
	const displayParts: string[] = [];
	const elidedRanges: ElidedRange[] = [];
	let elidedLines = 0;
	for (const unit of units) {
		if (unit.kind === "elided") {
			modelParts.push("…");
			displayParts.push("…");
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += unit.endLine - unit.startLine + 1;
			continue;
		}
		if (unit.kind === "merged") {
			const formatted = formatMergedBraceLine(
				unit.startLine,
				unit.endLine,
				unit.headText,
				unit.tailText,
				shouldAddHashLines,
				shouldAddLineNumbers,
			);
			modelParts.push(formatted.model);
			displayParts.push(formatted.display);
			// Suggest the full brace range so re-reading shows both braces
			// plus the elided body in one shot.
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			// Merged brace pair encloses (start+1)..(end-1) as elided.
			elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
			continue;
		}
		modelParts.push(formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers));
		displayParts.push(unit.text);
	}

	return { text: modelParts.join("\n"), displayText: displayParts.join("\n"), elidedRanges, elidedLines };
}
