/**
 * Gemini thinking-loop guard.
 *
 * Gemini models (notably `gemini-3.5-flash` via OpenRouter) occasionally fall
 * into a degenerate reasoning loop: they re-emit the same paragraph intent over
 * and over with cosmetic wording drift ("Confirming Safety", "Verifying
 * Completion", …), burning the entire output budget without ever calling a tool
 * or answering. The runaway is *not* byte-identical, so a cheap verbatim
 * tail-repeat check alone misses it.
 *
 * This guard watches the streamed `thinking` deltas and, on a match, terminates
 * the stream with a synthetic `error` {@link AssistantMessage} that carries
 * **no observable content**. An empty-content `stopReason: "error"` message tagged
 * with `AIError.Flag.ThinkingLoop` lets result consumers and `AgentSession` discard
 * the runaway and re-sample instead of committing garbage transcript.
 *
 * Three failure shapes are detected:
 * 1. **Verbatim tail repetition** — a short unit repeated back-to-back (e.g.
 *    "🌊 🌊 🌊 …"). Caught from a rolling 250-char tail.
 * 2. **Near-duplicate segments** — paragraphs that normalize to the same
 *    word-trigram fingerprint. Caught with a Jaccard window over recent
 *    paragraphs. Thresholds were calibrated on a real loop transcript plus
 *    13.5k non-loop thinking blocks (zero false positives; hardest negative
 *    scored 3 against the trigger of 4).
 * 3. **Progress-lexicon stall** — paragraphs that keep reshuffling the same
 *    motivational filler ("just doing it, pushing ahead, maintaining momentum")
 *    into fresh word order, so trigrams never match, yet introduce no new
 *    vocabulary and name nothing concrete. Caught by a run of low-novelty,
 *    anchor-free segments; a segment naming a path/identifier resets the run, so
 *    genuine but vocabulary-repetitive work (per-file templates) is spared.
 *
 * Scope is narrow: guarded Gemini/DeepSeek streams before any tool call. Native
 * thinking is checked first; assistant text can also be checked for providers
 * that surface reasoning as visible prose. On a hit the failed turn is emitted as
 * an empty retryable stream-stall error; result-awaiting callers (`complete`,
 * `completeSimple`) re-sample it a few times and then let a stubborn loop cook
 * through one unguarded pass. Disable detection with `PI_NO_THINKING_LOOP_GUARD=1`.
 */
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import type { Api, AssistantMessage, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

/** Stable lead phrase of the guard's error message; exported for tests. The
 *  message also carries "stream stall" so the session + transport retry
 *  classifiers treat it as a transient (retryable) stop without bespoke rules. */
export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

/** Rolling tail (chars) inspected for verbatim back-to-back repetition. */
const VERBATIM_TAIL_WINDOW = 250;
/** Minimum total repeated chars before a verbatim run counts as a loop. */
const VERBATIM_MIN_REPEATED_CHARS = 180;
/** Longest unit length probed for a verbatim repeat. */
const VERBATIM_MAX_UNIT = 60;

/** Char cap for an unterminated segment; forces a flush so a wall-of-text loop
 *  (no blank lines / headings) still segments. */
const SEGMENT_CHAR_CAP = 700;
/** Normalized-length floor below which a segment is ignored (too short to be a
 *  meaningful paragraph; bare headings must not trip detection). */
const SEGMENT_MIN_NORM_CHARS = 60;
/** How many recent substantial segments are kept for similarity comparison. */
const SEGMENT_WINDOW = 16;
/** Word-trigram Jaccard at/above which two segments count as near-duplicates. */
const SEGMENT_SIMILARITY = 0.8;
/** Substantial segments required before detection may fire (warm-up). */
const SEGMENT_MIN_COUNT = 8;
/** Near-duplicate cluster size (current + matches) that trips the loop. */
const SEGMENT_MIN_CLUSTER = 4;

/** Recent segments whose pooled unigram vocabulary is the novelty baseline for
 *  progress-lexicon stall detection. */
const LEX_NOVELTY_WINDOW = 8;
/** Novelty (fraction of a segment's content words unseen across the recent
 *  window) at/below which a segment counts as recycling earlier wording.
 *  Calibrated against 536k real non-Gemini reasoning blocks: at 0.2 the longest
 *  low-information run any legitimate block reached was 7. */
const LEX_STALL_NOVELTY_FLOOR = 0.2;
/** Consecutive low-information segments that trip a progress-lexicon stall. Set
 *  to 8 (one above the worst legitimate run observed in the 536k-block corpus) so
 *  the heuristic stays clear of focused reasoning that briefly recycles wording;
 *  the real reasoning-summarizer loop sustains far longer runs (10+). */
const LEX_STALL_MIN_RUN = 8;

/** A concrete reference the model is actually reasoning about: a code span, a
 *  file extension / dotted member, a multi-segment path, or a snake/camel/Pascal
 *  identifier. A segment that introduces a NEW one resets the lexical-stall run —
 *  this spares genuine per-target work (per-file templates, focused single-symbol
 *  debugging) while still catching reworded filler that names nothing new ("just
 *  doing it, pushing ahead") or fixates on one unchanging reference. Excludes bare
 *  digits, abbreviations, and decimals (e.g. "Step 2", "i.e.", "1.2") so numbered
 *  or punctuated filler is not self-anchoring. Global flag: collected with
 *  matchAll, so never used with the stateful test(). */
const CONCRETE_ANCHOR =
	/`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g;

const OPENAI_COMPAT_GUARDED_APIS: Partial<Record<Api, true>> = {
	"openai-completions": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

/**
 * True when `model` is a Gemini model whose native thinking stream surfaces the
 * "thought summary" titles this module's header guard counts.
 *
 * OpenAI-compat transports can serve Gemini under an arbitrary provider/id, so they
 * carry the explicit `compat.enableGeminiThinkingLoopGuard` flag; direct Gemini
 * transports carry a clearly shaped id/provider, so a string match is sufficient.
 */
export function isGeminiThinkingModel(model: Model<Api>): boolean {
	if (OPENAI_COMPAT_GUARDED_APIS[model.api]) {
		const compat = model.compat as { enableGeminiThinkingLoopGuard?: boolean } | undefined;
		return compat?.enableGeminiThinkingLoopGuard === true;
	}
	return /gemini/i.test(`${model.provider}/${model.id}`);
}

/**
 * True when `model` should be guarded for thinking/response loops (Gemini & DeepSeek).
 *
 * OpenAI-compat transports can serve Gemini or DeepSeek under an arbitrary provider/id.
 * Direct Gemini/DeepSeek transports carry a clearly shaped id/provider, so a string match
 * is sufficient.
 */
export function isLoopGuardedModel(model: Model<Api>, options?: StreamOptions): boolean {
	if (options?.loopGuard?.enabled === false) return false;
	const isDeepseek = /deepseek/i.test(`${model.provider}/${model.id}`);
	return isGeminiThinkingModel(model) || isDeepseek;
}

/** @deprecated Use isLoopGuardedModel instead. */
export function isGeminiThinkingLoopModel(model: Model<Api>): boolean {
	return isLoopGuardedModel(model);
}

/**
 * Stateful detector fed the streamed thinking deltas. `push` returns a
 * human-readable reason the first time a loop shape is recognized; the caller
 * is responsible for stopping after the first hit.
 */
export class ThinkingLoopDetector {
	/** Rolling char tail for verbatim repeat detection. */
	#tail = "";
	/** Pending thinking text not yet split into completed segments. */
	#pending = "";
	/** Fingerprints of the most recent substantial segments (≤ SEGMENT_WINDOW). */
	#window: Set<string>[] = [];
	/** Count of substantial segments seen so far (warm-up gate). */
	#count = 0;
	/** Unigram word sets of the most recent segments (≤ LEX_NOVELTY_WINDOW); the
	 *  novelty baseline for progress-lexicon stall detection. */
	#wordWindow: Set<string>[] = [];
	/** Consecutive low-information (low-novelty, anchor-free) segments seen. */
	#lexStallRun = 0;
	/** Concrete anchors seen per recent segment (≤ LEX_NOVELTY_WINDOW). A stall is
	 *  only broken by a *new* reference, so filler repeating one fixed
	 *  path/identifier every paragraph is still caught. */
	#anchorWindow: Set<string>[] = [];

	push(delta: string): string | null {
		if (!delta) return null;

		// 1. Verbatim back-to-back repetition over the rolling tail.
		this.#tail += delta;
		if (this.#tail.length > VERBATIM_TAIL_WINDOW) this.#tail = this.#tail.slice(-VERBATIM_TAIL_WINDOW);
		const verbatim = detectVerbatimRepetition(this.#tail);
		if (verbatim) {
			const [unit, times] = verbatim;
			return `repeated "${unit.trim()}" ${times}× back-to-back`;
		}

		// 2. Near-duplicate paragraph loop. Append, then drain completed segments.
		this.#pending += delta;
		while (true) {
			const boundary = /\n\s*\n/.exec(this.#pending);
			let raw: string;
			if (boundary) {
				raw = this.#pending.slice(0, boundary.index);
				this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
			} else if (this.#pending.length > SEGMENT_CHAR_CAP) {
				// No boundary yet but the segment is runaway-long: force a flush.
				raw = this.#pending.slice(0, SEGMENT_CHAR_CAP);
				this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP);
			} else {
				return null;
			}
			// An over-long segment is chunked so each piece stays comparable.
			for (let rest = raw; rest.length > 0; ) {
				const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
				rest = rest.slice(chunk.length);
				const hit = this.#consumeSegment(chunk);
				if (hit) return hit;
			}
		}
	}

	/** Process the buffered trailing paragraph (one with no blank-line / heading
	 *  terminator). Called when the thinking block ends so the final segment —
	 *  which may be the one that completes a duplicate cluster — is not dropped. */
	flush(): string | null {
		if (!this.#pending) return null;
		let rest = this.#pending;
		this.#pending = "";
		while (rest.length > 0) {
			const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
			rest = rest.slice(chunk.length);
			const hit = this.#consumeSegment(chunk);
			if (hit) return hit;
		}
		return null;
	}

	#consumeSegment(raw: string): string | null {
		// Reasoning-summarizer titles ("**Maintaining Momentum**", "## Heading")
		// are per-thought formatting, not chain-of-thought; their ever-changing
		// wording would otherwise mask a loop by inflating novelty. Strip them
		// before analysis (a title-only segment then falls below the length gate).
		const segment = raw.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "").replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
		const normalized = normalizeSegment(segment);
		if (normalized.length < SEGMENT_MIN_NORM_CHARS) return null;

		// (a) Near-duplicate trigram cluster: the same paragraph reused with
		// cosmetic wording drift (high word-trigram overlap).
		const fingerprint = trigramShingles(normalized);
		let cluster = 1;
		for (const prev of this.#window) {
			if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++;
		}

		// (b) Progress-lexicon stall: paragraphs that recycle the recent
		// vocabulary (low novelty) and add no *new* concrete reference — reworded
		// filler that burns budget without advancing. The trigram check above
		// already claims high-overlap near-duplicates; this catches the
		// low-overlap, reshuffled-wording shape it misses. Requiring a NEW anchor
		// (not merely any anchor) still catches filler that name-drops one fixed
		// path/identifier every paragraph, while sparing genuine per-target work
		// that names a fresh file/symbol each time.
		const words = new Set<string>(normalized.split(" ").filter(Boolean));
		const priorVocab = new Set<string>();
		for (const set of this.#wordWindow) for (const w of set) priorVocab.add(w);
		let unseen = 0;
		for (const w of words) if (!priorVocab.has(w)) unseen++;
		const novelty = priorVocab.size === 0 ? 1 : unseen / words.size;

		const anchors = new Set<string>();
		// Canonicalize so the same reference written as `Foo`, Foo, or FOO is one
		// anchor and cannot masquerade as "new" to keep a fixed-reference stall alive.
		for (const match of segment.matchAll(CONCRETE_ANCHOR)) anchors.add(match[0].replace(/`/g, "").toLowerCase());
		let newAnchor = false;
		for (const anchor of anchors) {
			if (this.#anchorWindow.every(seen => !seen.has(anchor))) {
				newAnchor = true;
				break;
			}
		}

		if (novelty <= LEX_STALL_NOVELTY_FLOOR && !newAnchor) {
			this.#lexStallRun++;
		} else {
			this.#lexStallRun = 0;
		}

		this.#window.push(fingerprint);
		if (this.#window.length > SEGMENT_WINDOW) this.#window.shift();
		this.#wordWindow.push(words);
		if (this.#wordWindow.length > LEX_NOVELTY_WINDOW) this.#wordWindow.shift();
		this.#anchorWindow.push(anchors);
		if (this.#anchorWindow.length > LEX_NOVELTY_WINDOW) this.#anchorWindow.shift();
		this.#count++;

		if (this.#count >= SEGMENT_MIN_COUNT) {
			if (cluster >= SEGMENT_MIN_CLUSTER) {
				return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`;
			}
			if (this.#lexStallRun >= LEX_STALL_MIN_RUN) {
				return `${this.#lexStallRun} low-information segments recycling recent wording`;
			}
		}
		return null;
	}
}

/**
 * Consecutive Gemini thought-summary headers in one uninterrupted reasoning
 * stream that trips the tool-call reminder. Gemini occasionally narrates a long
 * chain of titled summaries ("Examining Result Handling", "Refining Result
 * Rendering", …) without ever calling a tool, burning the whole budget on
 * planning; at this many distinct titles it has almost certainly stalled. This
 * is the over-planning shape {@link ThinkingLoopDetector} misses — those titles
 * are stripped before its similarity analysis precisely because their wording
 * keeps changing, so a genuinely-distinct planning runaway never trips it.
 */
export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 10;

/**
 * True when a single trimmed line is a Gemini reasoning-summary title: a markdown
 * ATX heading (`## …`) or a whole-line bold / bold-italic run (`**Title**`,
 * `***Title***`). Inline emphasis inside prose never matches — the bold run must
 * span the entire line. Mirrors the title shapes {@link ThinkingLoopDetector}
 * strips before similarity analysis.
 */
export function isReasoningSummaryHeader(line: string): boolean {
	return /^#{1,6}[ \t]+\S/.test(line) || /^\*{2,3}.+\*{2,3}$/.test(line);
}

/**
 * Counts consecutive Gemini reasoning-summary headers across a streamed thinking
 * block. {@link push} returns true exactly once — when the running header count
 * first reaches {@link GEMINI_HEADER_RUNAWAY_THRESHOLD} — and the caller then
 * interrupts the stream and reminds the model to issue a tool call. Paragraph
 * lines between titles do NOT reset the run (Gemini emits header + paragraph per
 * thought, so the run IS the number of summaries); leaving the reasoning channel
 * does, via {@link reset} on a new thinking block / prose / tool call.
 */
export class GeminiHeaderRunDetector {
	/** Thinking text not yet split into completed lines. */
	#pending = "";
	/** Summary-title lines seen in the current run. */
	#count = 0;
	/** Latches after the first threshold hit so each run fires at most once. */
	#fired = false;

	/** Feed a thinking delta. Returns true the first time the run hits the threshold. */
	push(delta: string): boolean {
		if (this.#fired || !delta) return false;
		this.#pending += delta;
		let nl = this.#pending.indexOf("\n");
		while (nl !== -1) {
			const line = this.#pending.slice(0, nl).trim();
			this.#pending = this.#pending.slice(nl + 1);
			if (line !== "" && isReasoningSummaryHeader(line) && ++this.#count >= GEMINI_HEADER_RUNAWAY_THRESHOLD) {
				this.#fired = true;
				return true;
			}
			nl = this.#pending.indexOf("\n");
		}
		return false;
	}

	/** Number of summary titles counted in the current run (for the reminder/log). */
	get count(): number {
		return this.#count;
	}

	/** Re-arm for a fresh reasoning block: clears the buffer, count, and latch. */
	reset(): void {
		this.#pending = "";
		this.#count = 0;
		this.#fired = false;
	}
}

/**
 * Wrap a provider stream with the loop guard. `controller` is the guard's own
 * abort handle: aborting it (after wiring it into the provider's signal via
 * {@link withGeminiThinkingLoopGuard}) tears down the upstream once a loop
 * trips.
 */
export function guardThinkingLoopStream(
	inner: AssistantMessageEventStream,
	model: Model<Api>,
	controller: AbortController,
	options?: StreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const thinkingDetector = new ThinkingLoopDetector();
	const textDetector = new ThinkingLoopDetector();
	const checkAssistantContent = options?.loopGuard?.checkAssistantContent !== false;

	void (async () => {
		let thinkingArmed = true;
		let textArmed = checkAssistantContent;
		try {
			for await (const event of inner) {
				let detail: string | null = null;
				if (thinkingArmed && event.type === "thinking_delta") {
					detail = thinkingDetector.push(event.delta);
				} else if (thinkingArmed && event.type === "thinking_end") {
					detail = thinkingDetector.flush();
					thinkingArmed = false;
				} else if (event.type === "text_start" || event.type === "text_delta") {
					thinkingArmed = false;
					if (textArmed && event.type === "text_delta") {
						detail = textDetector.push(event.delta);
					}
				} else if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
					thinkingArmed = false;
					textArmed = false;
				} else if (event.type === "done") {
					if (thinkingArmed) {
						detail = thinkingDetector.flush();
					}
					if (textArmed) {
						detail = detail || textDetector.flush();
					}
				}
				if (detail) {
					logger.warn("Thinking loop detected; aborting stream for retry.", {
						model: model.id,
						provider: model.provider,
						detail,
					});
					controller.abort(
						AIError.attach(new Error(THINKING_LOOP_ERROR_MARKER), AIError.create(AIError.Flag.ThinkingLoop)),
					);
					outer.push({
						type: "error",
						reason: "error",
						error: buildThinkingLoopError(model, detail),
					});
					return;
				}
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (err) {
					outer.fail(err);
				}
			}
		} catch (err) {
			if (!outer.done) outer.fail(err);
		}
	})();

	return outer;
}

/**
 * Apply the loop guard around a provider dispatch. For non-guarded models
 * (or when disabled) this is a transparent pass-through. For guarded models it injects a
 * guard abort signal into the provider call so a detected loop tears down the
 * upstream, then wraps the returned stream. The guard only raises the retryable
 * stall; bounding the re-samples and the final cook pass lives in the
 * result-awaiting caller.
 */
export function withGeminiThinkingLoopGuard<
	O extends { signal?: AbortSignal; loopGuard?: { enabled?: boolean; checkAssistantContent?: boolean } },
>(
	model: Model<Api>,
	options: O | undefined,
	dispatch: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (process.env.PI_NO_THINKING_LOOP_GUARD === "1" || !isLoopGuardedModel(model, options)) {
		return dispatch(options);
	}
	const controller = new AbortController();
	const caller = options?.signal;
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const merged = { ...(options ?? {}), signal } as O;
	return guardThinkingLoopStream(dispatch(merged), model, controller, options);
}

function buildThinkingLoopError(model: Model<Api>, detail: string): AssistantMessage {
	return {
		role: "assistant",
		// Empty content is load-bearing: loop-guard output is replay garbage, even
		// when it arrived as assistant text instead of native thinking. Keeping it
		// would persist the failed attempt before AgentSession retries.
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		// "stream stall" makes the transport/session retry classifiers treat this
		// as a transient (retryable) failure with no bespoke rule.
		errorMessage: `${THINKING_LOOP_ERROR_MARKER}: the model repeated near-identical content (${detail}). Treating as a stream stall and retrying.`,
		errorId: AIError.create(AIError.Flag.ThinkingLoop),
		timestamp: Date.now(),
	};
}

/**
 * Detect a short unit repeated back-to-back at the tail (verbatim loop). Only a
 * unit carrying a letter or pictographic emoji counts — runs of digits,
 * whitespace or punctuation are legitimate in tabular / hex / numeric output.
 */
function detectVerbatimRepetition(text: string): [unit: string, count: number] | null {
	if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null;
	const windowSize = Math.min(text.length, VERBATIM_TAIL_WINDOW);
	const searchSpace = text.slice(-windowSize);

	for (let len = 2; len <= VERBATIM_MAX_UNIT; len++) {
		if (searchSpace.length < len * 4) continue;
		const unit = searchSpace.slice(-len);
		if (!/[\p{L}\p{Extended_Pictographic}]/u.test(unit)) continue;

		let count = 0;
		let pos = searchSpace.length;
		while (pos >= len) {
			if (searchSpace.slice(pos - len, pos) === unit) {
				count++;
				pos -= len;
			} else {
				break;
			}
		}
		if (count >= 4 && len * count >= VERBATIM_MIN_REPEATED_CHARS) return [unit, count];
	}
	return null;
}

/** Lowercase and tokenize prose plus code/path payloads, dropping pure numbers. */
function normalizeSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/`([^`]*)`/g, " $1 ")
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter(token => /[a-z]/.test(token))
		.join(" ")
		.trim();
}

/** Word-trigram shingle set of a normalized segment. */
function trigramShingles(normalized: string): Set<string> {
	const words = normalized.split(" ").filter(Boolean);
	if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : []);
	const shingles = new Set<string>();
	for (let i = 0; i + 3 <= words.length; i++) {
		shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size < b.size ? [a, b] : [b, a];
	let intersection = 0;
	for (const x of small) {
		if (large.has(x)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
