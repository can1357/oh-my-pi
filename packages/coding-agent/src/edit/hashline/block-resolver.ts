/**
 * Tree-sitter-backed {@link BlockResolver} for the hashline `N*` locator.
 * Bridges the pure hashline seam to the native `blockRangeAt` primitive in
 * `@oh-my-pi/pi-natives`, which infers the language from the file path and
 * returns the 1-indexed line span of the syntactic block beginning on the
 * requested line (or `null` when none can be resolved).
 */
import type { BlockResolver } from "@oh-my-pi/hashline";
import { blockRangeAt } from "@oh-my-pi/pi-natives";

/**
 * `blockRangeAt` runs a full synchronous tree-sitter parse of `text` per
 * call, and streaming previews re-resolve the same (text, line) every
 * streamed chunk. Memoize by content: identical text + line always yields the
 * same span. FIFO-bounded; hashing the text is orders of magnitude cheaper
 * than re-parsing it.
 */
const resolutionCache = new Map<string, { start: number; end: number } | null>();
const RESOLUTION_CACHE_MAX = 512;

export const nativeBlockResolver: BlockResolver = ({ path, text, line }) => {
	const key = `${Bun.hash(text).toString(36)}:${text.length}:${line}:${path}`;
	const cached = resolutionCache.get(key);
	if (cached !== undefined) return cached;
	const range = blockRangeAt({ code: text, path, line });
	const result = range ? { start: range.startLine, end: range.endLine } : null;
	if (resolutionCache.size >= RESOLUTION_CACHE_MAX) {
		const oldest = resolutionCache.keys().next().value;
		if (oldest !== undefined) resolutionCache.delete(oldest);
	}
	resolutionCache.set(key, result);
	return result;
};
