import { countTokens as countTokensNat } from "@pk-nerdsaver-ai/pi-natives";

/**
 * Tokenizer facade: every token estimate in the agent runtime funnels through
 * `countTokens` so threshold math, prune gates, and status displays all agree.
 *
 * Modes:
 * - `cl100k`: native BPE count (~5-10% of provider-reported usage for
 *   English/code). Default whenever the native addon loads.
 * - `estimate`: `bytes/4` heuristic. Fallback when the addon is unavailable,
 *   or forced via `PI_TOKENIZER=estimate` as a perf escape hatch.
 *
 * The mode is a performance toggle, not a correctness fork: callers that need
 * ground truth anchor on provider-reported usage and only estimate the tail.
 * `tokenizerMode()` exposes the active mode so telemetry can record which
 * estimator produced a number.
 */
export type TokenizerMode = "cl100k" | "estimate";

/**
 * BPE merge passes are quadratic in the length of a single-character run
 * (a 100K-char run takes ~20s). Runs past this cap are counted once at the
 * cap and scaled linearly — runs tokenize proportionally to length, so the
 * scaled count stays accurate while the cost stays bounded.
 */
const RUN_CAP = 512;

let resolvedMode: TokenizerMode | undefined;

function byteEstimate(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}

function resolveMode(): TokenizerMode {
	if (resolvedMode !== undefined) return resolvedMode;
	if (process.env.PI_TOKENIZER === "estimate") {
		resolvedMode = "estimate";
		return resolvedMode;
	}
	try {
		countTokensNat("probe");
		resolvedMode = "cl100k";
	} catch {
		resolvedMode = "estimate";
	}
	return resolvedMode;
}

/** The estimator currently backing `countTokens`. Recorded by telemetry. */
export function tokenizerMode(): TokenizerMode {
	return resolveMode();
}

interface RunSpan {
	start: number;
	end: number;
}

/** Locate single-character runs of at least RUN_CAP*2 code units. */
function findPathologicalRuns(text: string): RunSpan[] | undefined {
	// Only runs long enough that clipping changes the result are collected;
	// a run of exactly RUN_CAP is already cheap to count directly.
	const minRun = RUN_CAP * 2;
	let spans: RunSpan[] | undefined;
	let runStart = 0;
	let prev = -1;
	const len = text.length;
	for (let i = 0; i <= len; i++) {
		const code = i < len ? text.charCodeAt(i) : -2;
		if (code !== prev) {
			if (i - runStart >= minRun) {
				spans ??= [];
				spans.push({ start: runStart, end: i });
			}
			runStart = i;
			prev = code;
		}
	}
	return spans;
}

const runSliceTokens = new Map<number, number>();

/** Tokens for a RUN_CAP-length run of the given character, memoized per char. */
function runCapTokens(charCode: number): number {
	let cached = runSliceTokens.get(charCode);
	if (cached === undefined) {
		cached = countTokensNat(String.fromCharCode(charCode).repeat(RUN_CAP));
		runSliceTokens.set(charCode, cached);
	}
	return cached;
}

/** Count one string natively, clipping pathological runs and scaling their share. */
function countClipped(text: string, spans: RunSpan[]): number {
	let total = 0;
	const segments: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) segments.push(text.slice(cursor, span.start));
		const perCap = runCapTokens(text.charCodeAt(span.start));
		total += Math.ceil((perCap * (span.end - span.start)) / RUN_CAP);
		cursor = span.end;
	}
	if (cursor < text.length) segments.push(text.slice(cursor));
	if (segments.length > 0) total += countTokensNat(segments);
	return total;
}

export function countTokens(text: string | string[]): number {
	if (resolveMode() === "estimate") {
		if (Array.isArray(text)) {
			return text.reduce((sum, t) => sum + byteEstimate(t), 0);
		}
		return byteEstimate(text);
	}

	try {
		const items = Array.isArray(text) ? text : [text];
		let total = 0;
		let plain: string[] | undefined;
		for (const item of items) {
			const spans = findPathologicalRuns(item);
			if (spans) {
				total += countClipped(item, spans);
			} else {
				plain ??= [];
				plain.push(item);
			}
		}
		if (plain) total += countTokensNat(plain.length === 1 ? plain[0] : plain);
		return total;
	} catch {
		// Native addon failed mid-flight; degrade to the estimate permanently
		// rather than throwing out of token accounting.
		resolvedMode = "estimate";
		return countTokens(text);
	}
}
