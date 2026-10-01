/**
 * Speculative-compaction lead: how far below the compaction threshold the
 * background summarizer starts. Derived from the threshold instead of a second
 * user-facing knob so the band scales with the window — a fixed percentage gap
 * would be 200k tokens on a 1M model and useless on a 32k one. The floor keeps
 * tiny windows from speculating every turn; the cap bounds how much history the
 * armed summary misses (the kept tail grows by at most ~lead tokens between
 * compute and apply).
 *
 * Shared by the maintenance loop (fire decision) and the status line's
 * annotated context gauge (boundary marker position).
 */
const SPECULATION_LEAD_FRACTION = 0.125;
/** Floor of the speculation band; also the armed-summary refresh budget floor. */
export const SPECULATION_LEAD_MIN_TOKENS = 8_192;
const SPECULATION_LEAD_MAX_TOKENS = 32_000;

/** Tokens the threshold band spans: speculation fires inside `[threshold − lead, threshold)`. */
export function resolveSpeculationLeadTokens(thresholdTokens: number): number {
	return Math.min(
		SPECULATION_LEAD_MAX_TOKENS,
		Math.max(SPECULATION_LEAD_MIN_TOKENS, Math.floor(thresholdTokens * SPECULATION_LEAD_FRACTION)),
	);
}
