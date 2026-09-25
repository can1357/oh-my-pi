/**
 * Thinking-loop guard.
 *
 * Gemini models (notably `gemini-3.5-flash` via OpenRouter) occasionally fall
 * into a degenerate reasoning loop: they re-emit the same paragraph intent over
 * and over with cosmetic wording drift ("Confirming Safety", "Verifying
 * Completion", …), burning the entire output budget without ever calling a tool
 * or answering. The runaway is *not* byte-identical, so a cheap verbatim
 * tail-repeat check alone misses it.
 *
 * This guard watches streamed deltas and, on a match, terminates the stream with
 * a synthetic `error` {@link AssistantMessage} whose terminal content is empty.
 * Deltas emitted before enough evidence accumulates may already be observable to
 * a live streaming consumer; the empty terminal prevents the failed attempt from
 * being committed or replayed. Tagged with `AIError.Flag.ThinkingLoop`, the
 * result lets `AgentSession` discard the runaway and re-sample.
 *
 * Four failure shapes are detected:
 * 1. **Exact suffix cycles** — a byte-identical unit repeated back-to-back,
 *    including long cycles such as the observed 311-character Kiro runaway.
 *    This bounded detector applies to every model.
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
 * 4. **Gemini summary-header runaway** — handled separately by
 *    {@link GeminiHeaderRunDetector}.
 *
 * Scope: exact cycles are guarded for every model; semantic heuristics remain
 * limited to Gemini, DeepSeek, and Grok family streams. Thinking stays armed
 * after a tool call starts — xAI/Grok can keep emitting `thinking_delta` after
 * `toolcall_start`, and those deltas count as stream progress so the idle
 * watchdog never fires. Visible assistant text still latches the thinking
 * detector off. Native thinking is checked first; assistant text can also be
 * checked for providers that surface reasoning as visible prose. On a hit the
 * failed turn is emitted as an empty retryable stream-stall error;
 * result-awaiting callers (`complete`, `completeSimple`) re-sample at most
 * three guarded attempts and then fail closed. Disable detection with
 * `PI_NO_THINKING_LOOP_GUARD=1`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Api, AssistantMessage, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

/** Stable lead phrase of the guard's error message; exported for tests. The
 *  message also carries "stream stall" so the session + transport retry
 *  classifiers treat it as a transient (retryable) stop without bespoke rules. */
export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

/** Rolling tail retained for exact suffix-cycle detection. */
const EXACT_TAIL_WINDOW = 4096;
/** Longest exact cycle length considered. */
const EXACT_MAX_UNIT = 1024;
/** New characters between scans. Large deltas are scanned immediately. */
const EXACT_CHECK_STRIDE = 128;
/** Short cycles need four repeats covering at least this many characters. */
const EXACT_SHORT_MAX_UNIT = 60;
const EXACT_SHORT_MIN_REPEATED_CHARS = 180;
/** Long cycles need at least three repeats covering at least this many chars. */
const EXACT_LONG_MIN_REPEATED_CHARS = 1024;

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

/**
 * True when resolved compatibility policy enables semantic loop heuristics for
 * this model. Exact suffix-cycle detection applies to every enabled model
 * independently of this predicate.
 */
export function isLoopGuardedModel(model: Model<Api>, options?: StreamOptions): boolean {
	if (options?.loopGuard?.enabled === false) return false;
	const compat = model.compat;
	if (compat !== undefined) return "thinkingLoopGuard" in compat && compat.thinkingLoopGuard !== undefined;
	// Custom API surfaces resolve no compat record, so the KDL `thinking-loop-guard`
	// axis cannot land on them; fall back to the class facts the axis encodes
	// (classes/{gemini,deepseek,xai}.kdl).
	const cls = model.identity?.class;
	return cls === "gemini" || cls === "deepseek" || cls === "xai";
}

/**
 * Stateful detector fed the streamed thinking deltas. `push` returns a
 * human-readable reason the first time a loop shape is recognized; the caller
 * is responsible for stopping after the first hit.
 */
export class ThinkingLoopDetector {
	/** Rolling char tail for exact suffix-cycle detection. */
	#tail = "";
	/** Total characters received when the exact detector last scanned. */
	#exactScannedAt = 0;
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

	constructor(private readonly semanticHeuristics = true) {}

	push(delta: string): string | null {
		if (!delta) return null;

		// 1. Exact suffix cycles. Scan at a bounded cadence rather than doing
		// quadratic work for every token-sized delta.
		this.#tail += delta;
		if (this.#tail.length > EXACT_TAIL_WINDOW) this.#tail = this.#tail.slice(-EXACT_TAIL_WINDOW);
		this.#exactScannedAt += delta.length;
		if (this.#exactScannedAt >= EXACT_CHECK_STRIDE || delta.length >= EXACT_CHECK_STRIDE) {
			this.#exactScannedAt = 0;
			const exact = detectExactSuffixCycle(this.#tail);
			if (exact) {
				const [unit, times] = exact;
				return `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
			}
		}

		if (!this.semanticHeuristics) return null;

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
			for (let rest = raw; rest.length > 0;) {
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
		// A stream can end before the next cadence boundary. Force one final exact
		// check even when semantic heuristics are disabled and #pending is empty.
		const exact = detectExactSuffixCycle(this.#tail);
		if (exact) {
			const [unit, times] = exact;
			return `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
		}
		if (!this.semanticHeuristics || !this.#pending) return null;
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
 * planning. This is the over-planning shape {@link ThinkingLoopDetector} misses —
 * those titles are stripped before its similarity analysis precisely because their
 * wording keeps changing, so a genuinely-distinct planning runaway never trips it.
 *
 * Set well above legitimate hard-problem depth: a capable model can emit ~10
 * distinct, progressing hypotheses in a single reasoning block before acting (and
 * a false trip is costly — the interrupt discards the whole reasoning turn). A
 * real narration runaway burns dozens-to-hundreds of titles, so this still trips
 * fast on the actual pathology.
 */
export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 36;

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
 * {@link withThinkingLoopGuard}) tears down the upstream once a loop
 * trips.
 */
export function guardThinkingLoopStream(
	inner: AssistantMessageEventStream,
	model: Model<Api>,
	controller: AbortController,
	options?: StreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const semanticHeuristics = isLoopGuardedModel(model, options);
	const thinkingDetector = new ThinkingLoopDetector(semanticHeuristics);
	const textDetector = new ThinkingLoopDetector(semanticHeuristics);
	const checkAssistantContent = options?.loopGuard?.checkAssistantContent !== false;

	void (async () => {
		let thinkingArmed = true;
		let textArmed = checkAssistantContent;
		let textStarted = false;
		try {
			for await (const event of inner) {
				let detail: string | null = null;
				if (event.type === "thinking_delta") {
					// Re-arm after thinking_end / toolcall_start unless visible answer
					// text has already latched the detector off. Grok/xAI Responses can
					// keep reasoning after the first toolcall_start; those deltas still
					// count as stream progress while the TUI sits on a streamed preview.
					if (!textStarted) {
						thinkingArmed = true;
						detail = thinkingDetector.push(event.delta);
					}
				} else if (event.type === "thinking_end") {
					if (thinkingArmed) {
						detail = thinkingDetector.flush();
					}
				} else if (event.type === "text_start") {
					// Responses emits this as soon as an empty message item is added.
					// No visible answer text yet — do not latch the thinking detector.
				} else if (event.type === "text_delta") {
					if (event.delta.length > 0) {
						thinkingArmed = false;
						textStarted = true;
					}
					if (textArmed) {
						detail = textDetector.push(event.delta);
					}
				} else if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
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
 * Apply the loop guard around a provider dispatch. Unless explicitly disabled,
 * every model gets exact suffix-cycle detection; Gemini, DeepSeek, and Grok also
 * get the semantic heuristics selected by {@link isLoopGuardedModel}. The guard
 * injects an abort signal into the provider call so a detected loop tears down
 * the upstream, then wraps the returned stream. Bounding result-path re-samples
 * lives in the result-awaiting caller.
 */
export function withThinkingLoopGuard<
	O extends { signal?: AbortSignal; loopGuard?: { enabled?: boolean; checkAssistantContent?: boolean } },
>(
	model: Model<Api>,
	options: O | undefined,
	dispatch: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (process.env.PI_NO_THINKING_LOOP_GUARD === "1" || options?.loopGuard?.enabled === false) {
		return dispatch(options);
	}
	const controller = new AbortController();
	const caller = options?.signal;
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const merged = { ...options, signal } as O;
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
 * Detect an exact cycle at the text suffix. A Z-array over the reversed tail
 * finds every possible suffix period in linear time without substring churn.
 * Short cycles retain the original 180-character/four-repeat sensitivity; long
 * cycles require at least three repeats and 1024 repeated characters.
 */
function detectExactSuffixCycle(text: string): [unit: string, count: number] | null {
	if (text.length < EXACT_SHORT_MIN_REPEATED_CHARS) return null;
	const reversed = text.split("").reverse().join("");
	const z = new Uint16Array(reversed.length);
	let left = 0;
	let right = 0;
	for (let i = 1; i < reversed.length; i++) {
		if (i <= right) z[i] = Math.min(right - i + 1, z[i - left]);
		while (i + z[i] < reversed.length && reversed[z[i]] === reversed[i + z[i]]) z[i]++;
		if (i + z[i] - 1 > right) {
			left = i;
			right = i + z[i] - 1;
		}
	}

	const maxUnit = Math.min(EXACT_MAX_UNIT, Math.floor(reversed.length / 3));
	for (let len = 2; len <= maxUnit; len++) {
		const count = 1 + Math.floor(z[len] / len);
		const minCount = len <= EXACT_SHORT_MAX_UNIT ? 4 : 3;
		const minChars = len <= EXACT_SHORT_MAX_UNIT ? EXACT_SHORT_MIN_REPEATED_CHARS : EXACT_LONG_MIN_REPEATED_CHARS;
		if (count < minCount || len * count < minChars) continue;
		const unit = text.slice(-len);
		if (/\p{L}|\p{Extended_Pictographic}/u.test(unit)) return [unit, count];
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
