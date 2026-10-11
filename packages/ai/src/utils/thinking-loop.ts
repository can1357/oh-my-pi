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
 * The semantic heuristics (2, 3) judge prose only: code-shaped lines are dropped
 * before analysis because legitimate code repeats one keyword skeleton with
 * different literals, and numeric tokens are stripped during normalization.
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
/** Blank-line (plus any run of following whitespace) that terminates a segment.
 *  Non-global, so `exec` never advances a shared lastIndex. */
const SEGMENT_BOUNDARY_RE = /\n\s*\n/;
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

/** A whole line shaped like code rather than prose: a fence marker, an indented
 *  line that is not a nested list item, or a line ending in a block, statement,
 *  or markup delimiter. Classified per line rather than by fence state because Gemini
 *  thought summaries routinely end inside an unclosed fence; tracking fences
 *  would hide every later prose paragraph from the heuristics. */
const CODE_LINE = /^(?:[ \t]*```.*|(?: {2,}|\t)(?![ \t]*(?:[-*+]|\d+[.)])[ \t]).*|.*[{}[\](;,>][ \t]*)$/gm;

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
		this.#exactScannedAt += delta.length;
		if (this.#exactScannedAt >= EXACT_CHECK_STRIDE || delta.length >= EXACT_CHECK_STRIDE) {
			this.#exactScannedAt = 0;
			// Trim only here, on the cadence the detector actually scans at: between
			// scans the tail is bounded by the stride plus one delta, so the
			// window copy no longer runs per streamed delta.
			if (this.#tail.length > EXACT_TAIL_WINDOW) this.#tail = this.#tail.slice(-EXACT_TAIL_WINDOW);
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
			const boundary = SEGMENT_BOUNDARY_RE.exec(this.#pending);
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
		// wording would otherwise mask a loop by inflating novelty. Strip them and
		// code lines before analysis (a title- or code-only segment then falls below
		// the length gate).
		const segment = raw
			.replace(CODE_LINE, "")
			.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "")
			.replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
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

/** Bound on the unterminated partial line held between deltas. A reasoning-summary
 *  title is a short markdown heading or bold run, so a partial this long cannot
 *  complete into a header; the cap keeps a newline-free run from growing a buffer
 *  that is re-scanned (and re-copied) on every delta. Well above any real title,
 *  far below the point where retaining it would help detection. The head the cap
 *  drops is folded into `#head` while the line streams, so the line is still
 *  judged whole — see {@link foldPartialLineHead}. */
const GEMINI_HEADER_PARTIAL_LINE_CAP = 512;

/** Closing `\*{2,3}` of a whole-line bold run — the end of the line, which is the
 *  one part the tail cap always keeps. */
const BOLD_RUN_CLOSER_RE = /\*{2,3}$/;

/** `\s`: what trims a line, and what `\S` excludes. */
const WHITESPACE_RE = /\s/;

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
 * Opening marker of one unterminated line, folded a character at a time as the
 * line streams: `run` counts the leading `#`/`*` chars, and `gap` records the
 * `[ \t]+` run that separates a hash heading from its title text. Whitespace is
 * normalized the way the trimmed line needs it — leading whitespace is dropped,
 * and a run of spaces/tabs after the hashes collapses onto the single `[ \t]+`
 * that `#{1,6}[ \t]+\S` needs — so the state stays a few fields wide however
 * long the line runs.
 */
interface PartialLineHead {
	/** Fold phase. `atx`, `bold`, and `plain` are terminal verdicts. */
	phase: "start" | "hashes" | "stars" | "atx" | "bold" | "plain";
	/** Leading `#` (1-6) or `*` (1-3) run counted so far. */
	run: number;
	/** `[ \t]+` has followed the hash run — only the `\S` is still missing. */
	gap: boolean;
}

/**
 * Fold one character of an unterminated line into its opening marker.
 *
 * The marker must be settled while its characters are still in hand:
 * {@link GEMINI_HEADER_PARTIAL_LINE_CAP} keeps only the tail of a long
 * unterminated line, which drops exactly the `# `/`**` that makes it a title.
 * Deciding as the line arrives is what keeps a title's verdict independent of
 * where the chunk boundaries fall — against a tail-only buffer the same line is a
 * title when it arrives whole and stops being one once it is split.
 */
function foldPartialLineHead(head: PartialLineHead, ch: string): void {
	switch (head.phase) {
		case "atx":
		case "bold":
		case "plain":
			return;
		case "start":
			// Leading whitespace is trimmed away before the line is judged.
			if (WHITESPACE_RE.test(ch)) return;
			if (ch === "#") {
				head.phase = "hashes";
				head.run = 1;
			} else if (ch === "*") {
				head.phase = "stars";
				head.run = 1;
			} else {
				head.phase = "plain";
			}
			return;
		case "hashes":
			if (head.gap) {
				// `[ \t]+` may keep running; `\S` settles the heading, and any other
				// whitespace char is not `\S`, so the run is already over.
				if (ch === " " || ch === "\t") return;
				head.phase = WHITESPACE_RE.test(ch) ? "plain" : "atx";
				return;
			}
			if (ch === "#") {
				if (head.run < 6) head.run++;
				else head.phase = "plain";
				return;
			}
			if (ch === " " || ch === "\t") {
				head.gap = true;
				return;
			}
			head.phase = "plain";
			return;
		case "stars":
			// The opener is complete once a second star lands; the character after it
			// is the `.+` body, so only the closer — the line's tail — is still
			// missing.
			if (ch === "*") {
				if (head.run < 3) head.run++;
				else head.phase = "bold";
				return;
			}
			head.phase = head.run >= 2 ? "bold" : "plain";
			return;
	}
}

/**
 * True when a completed line is a reasoning-summary title.
 *
 * With its head intact the line is judged whole, exactly as it was before the
 * tail cap existed. Once {@link GEMINI_HEADER_PARTIAL_LINE_CAP} has cut the head
 * off, the verdict comes from the folded opening marker plus the retained tail:
 * an ATX heading is settled by the marker alone, and a whole-line bold run also
 * needs the line to end on `\*{2,3}` — the tail, which the cap never cuts.
 */
function isSummaryTitleLine(line: string, head: PartialLineHead, headCut: boolean): boolean {
	if (!headCut) return isReasoningSummaryHeader(line);
	return head.phase === "atx" || (head.phase === "bold" && BOLD_RUN_CLOSER_RE.test(line));
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
	/** Opening marker of the unterminated partial line, folded as it streams. */
	#head: PartialLineHead = { phase: "start", run: 0, gap: false };
	/** The held partial line has been cut back to
	 *  {@link GEMINI_HEADER_PARTIAL_LINE_CAP}, so its head survives only in
	 *  `#head`. */
	#headCut = false;
	/** Summary-title lines seen in the current run. */
	#count = 0;
	/** Latches after the first threshold hit so each run fires at most once. */
	#fired = false;

	/** Feed a thinking delta. Returns true the first time the run hits the threshold. */
	push(delta: string): boolean {
		if (this.#fired || !delta) return false;
		this.#pending += delta;
		// Where this delta starts inside `#pending`; everything before it has
		// already been folded into the opening marker of the line under
		// construction.
		let unfolded = this.#pending.length - delta.length;
		// Drain complete lines by index offset: one tail slice for the whole delta
		// instead of a re-copy of the remainder per line found.
		let start = 0;
		let nl = this.#pending.indexOf("\n", start);
		while (nl !== -1) {
			// Settle the line's opening marker before judging it: the cap below cuts
			// the head off a long line, so by completion a title's `# `/`**` lives
			// only in `#head`.
			this.#foldHead(unfolded, nl);
			const line = this.#pending.slice(start, nl).trim();
			const headCut = this.#headCut;
			this.#headCut = false;
			const title = line !== "" && isSummaryTitleLine(line, this.#head, headCut);
			this.#resetHead();
			start = nl + 1;
			unfolded = nl + 1;
			if (title && ++this.#count >= GEMINI_HEADER_RUNAWAY_THRESHOLD) {
				this.#fired = true;
				return true;
			}
			nl = this.#pending.indexOf("\n", start);
		}
		this.#foldHead(unfolded, this.#pending.length);
		if (start > 0) this.#pending = this.#pending.slice(start);
		// Bound the held partial line: a title this long cannot complete into a
		// header, so hold only its tail rather than rescan (and re-copy) a growing
		// buffer on every delta. The head the cut drops is already folded into
		// `#head`, so the line is still judged whole.
		if (this.#pending.length > GEMINI_HEADER_PARTIAL_LINE_CAP) {
			this.#pending = this.#pending.slice(-GEMINI_HEADER_PARTIAL_LINE_CAP);
			this.#headCut = true;
		}
		return false;
	}

	/** Fold the characters of `#pending` in `[from, to)` the opening-marker fold
	 *  has not seen yet. Stops at the character that settles the verdict, so a
	 *  line that is not a title costs one character look per delta. */
	#foldHead(from: number, to: number): void {
		const head = this.#head;
		while (from < to && head.phase !== "atx" && head.phase !== "bold" && head.phase !== "plain") {
			foldPartialLineHead(head, this.#pending[from++]);
		}
	}

	/** Re-arm the opening marker for the next line. */
	#resetHead(): void {
		this.#head.phase = "start";
		this.#head.run = 0;
		this.#head.gap = false;
	}

	/** Number of summary titles counted in the current run (for the reminder/log). */
	get count(): number {
		return this.#count;
	}

	/** Re-arm for a fresh reasoning block: clears the buffer, count, and latch. */
	reset(): void {
		this.#pending = "";
		this.#headCut = false;
		this.#resetHead();
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

/** Reused Z-array scratch; scans are synchronous, so one buffer suffices. */
const exactZ = new Uint16Array(EXACT_MAX_UNIT + 1);

/**
 * Detect an exact cycle at the text suffix. A Z-array over the reversed tail
 * finds every possible suffix period in linear time without substring churn.
 * The reversal is virtual (indexed from the end) and only `z[1..maxUnit]` is
 * computed — the period check reads nothing past it, and each `z[i]` reads
 * only `z[i - left]` with `i - left < i`, which is already filled. Short
 * cycles retain the original 180-character/four-repeat sensitivity; long
 * cycles require at least three repeats and 1024 repeated characters.
 */
function detectExactSuffixCycle(text: string): [unit: string, count: number] | null {
	const n = text.length;
	if (n < EXACT_SHORT_MIN_REPEATED_CHARS) return null;
	const last = n - 1;
	const maxUnit = Math.min(EXACT_MAX_UNIT, Math.floor(n / 3));
	const z = exactZ;
	let left = 0;
	let right = 0;
	for (let i = 1; i <= maxUnit; i++) {
		let zi = i <= right ? Math.min(right - i + 1, z[i - left]) : 0;
		while (i + zi < n && text.charCodeAt(last - zi) === text.charCodeAt(last - i - zi)) zi++;
		z[i] = zi;
		if (i + zi - 1 > right) {
			left = i;
			right = i + zi - 1;
		}
	}

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
