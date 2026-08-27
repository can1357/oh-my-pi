/**
 * Shared UTF-8-boundary prefix helper for every module that bounds a stream's
 * retained/folded process text at a byte budget: `presentation/live-record.ts`
 * (persisted head window), `modes/acp/view/reducer.ts` (settlement-snapshot
 * head window), and `modes/tool-presentation-fold.ts` (display-consumer fold).
 * All three already import from `presentation/projections`, so this lives
 * beside it rather than duplicating the continuation-byte back-off logic —
 * subtle enough that verbatim triplication is real drift risk.
 */

/**
 * Longest prefix of `chunk` that fits in `maxBytes` without splitting a UTF-8
 * code point.
 */
export function utf8PrefixWithin(chunk: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(chunk, "utf8");
	if (buf.length <= maxBytes) return chunk;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}
