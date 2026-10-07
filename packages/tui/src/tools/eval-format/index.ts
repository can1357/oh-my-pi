import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { EvalLanguage } from "../eval";
import { formatJavaScriptForDisplay } from "./javascript";
import { formatPythonForDisplay } from "./python";

export * from "./javascript";
export * from "./python";

function createDisplayFormatMemo(): LRUCache<string, string> {
	return new LRUCache<string, string>({
		max: 64,
		maxSize: 4_000_000,
		// LRUCache rejects sizes <= 0; empty sources (cells not yet streamed) still cost one.
		sizeCalculation: (formatted, source) => formatted.length + source.length + 1,
	});
}

/**
 * Formatted display text keyed by source, one memo per formatter. Renderers
 * reformat every cell on each streamed argument delta and result update; the
 * memo keeps that linear in the changed cell instead of the whole call.
 */
const jsDisplayMemo = createDisplayFormatMemo();
const pythonDisplayMemo = createDisplayFormatMemo();

/** Formats an arbitrary eval-code prefix for display without changing the executed source. */
export function formatEvalCodeForDisplay(source: string, language: EvalLanguage): string {
	if (/^\s*%/.test(source)) return source;
	switch (language) {
		case "js":
			return memoizedFormat(jsDisplayMemo, source, formatJavaScriptForDisplay);
		case "python":
			return memoizedFormat(pythonDisplayMemo, source, formatPythonForDisplay);
	}
}

function memoizedFormat(memo: LRUCache<string, string>, source: string, format: (source: string) => string): string {
	const cached = memo.get(source);
	if (cached !== undefined) return cached;
	const formatted = format(source);
	memo.set(source, formatted);
	return formatted;
}
