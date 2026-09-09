/**
 * Streaming markdown → speakable-segment transform for assistant speech.
 *
 * Sits between the assistant's raw streaming text deltas and the TTS engine,
 * deciding both *what* is worth speaking and *when* a piece of text is ready
 * to synthesize. Three passes:
 *
 * 1. Block pass (per character, stateful): drops fenced code blocks and table
 *    rows, strips heading/bullet/blockquote markers (numbered-list markers are
 *    spoken as "1, …"), and turns newlines into hard segment breaks.
 * 2. Segmentation (stateful): emits a segment the moment a sentence boundary
 *    appears — no next-sentence confirmation, which is what made the previous
 *    engine-side splitter stall a full sentence behind generation. The first
 *    segment cuts early at a clause boundary for fast time-to-first-audio, and
 *    over-long unpunctuated runs are force-split so no segment exceeds the
 *    synthesizer's input budget.
 * 3. Inline normalization (per segment): markdown links speak their label,
 *    bare URLs speak their host, inline-code ticks and emphasis markers are
 *    stripped, multi-directory file paths collapse to their basename, HTML
 *    tags are dropped, and whitespace is collapsed. Segments with no letters
 *    or digits left are not spoken at all.
 *
 * Pure and synchronous — the vocalizer owns timers (idle flush) and the
 * session lifecycle, so this class stays trivially unit-testable.
 */

/** Minimum length before the very first segment may cut at a sentence boundary. */
const FIRST_SEGMENT_MIN = 12;
/** Buffer length past which the first segment may cut at a clause boundary instead. */
const FIRST_CLAUSE_MIN = 40;
/** Hard cap for the first segment: force a word cut for fast time-to-first-audio. */
const FIRST_FORCED_MAX = 140;
/** Minimum segment length once speech has started (merges stubby sentences). */
const MIN_SEGMENT = 24;
/**
 * Mid-stream soft cut: once this much unpunctuated text is buffered, split at
 * a clause boundary instead of waiting for the sentence to end. Long sentences
 * synthesize as clause-sized pieces, keeping the playback pipeline fed (a
 * 280-char segment costs ~6s of synthesis — enough to drain the player dry).
 */
const SOFT_CLAUSE_LEN = 160;
/**
 * Hard cap per segment. Kokoro's `generate()` truncates past ~510 phoneme
 * tokens rather than splitting, so every emission path must stay well under it.
 */
const MAX_SEGMENT = 280;

/** Sentence-ending punctuation, optional closers, then whitespace. */
const SENTENCE_BOUNDARY_RE = /[.!?…]+[)\]"'»”’]*\s/g;
/** Clause punctuation followed by whitespace — early-cut and force-split points. */
const CLAUSE_BOUNDARY_RE = /[,;:—–]\s/g;
/** Abbreviations whose trailing dot is not a sentence boundary. */
const ABBREVIATION_RE = /(?:^|\s)(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|No)\.$/i;

/** Line-start prefixes that may still grow into a block marker. */
const UNDECIDED_PREFIX_RE = /^(?:#{1,6}|[-*+]|-{2,}|\*{2,}|_{2,}|\d{1,3}|\d{1,3}[.)]|>+|`{1,2}|~{1,2})$/;
/** A whole line that is a horizontal rule (or setext underline) — silence. */
const HR_LINE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

const IMAGE_RE = /!\[([^\]]*)\]\(([^()]*)\)/g;
const LINK_RE = /\[([^\]]+)\]\(([^()]*)\)/g;
const AUTOLINK_RE = /<(https?:\/\/[^\s>]+)>/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+|\bwww\.[\w-]+(?:\.[\w-]+)+[^\s<>()"'\]]*/g;
const INLINE_CODE_RE = /`{1,2}([^`]+)`{1,2}/g;
const BOLD_STRIKE_RE = /\*\*|__|~~/g;
const EMPHASIS_ASTERISK_RE = /\*(?=\S)|(?<=\S)\*/g;
const EMPHASIS_UNDERSCORE_RE = /(^|\s)_+|_+(?=\s|$)/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;
const HR_INLINE_RE = /(^|\s)[-*_]{3,}(?=\s|$)/g;
const PATH_RE = /(^|[\s("'`])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+){2,}\/?)/g;
const HAS_SPEAKABLE_RE = /[\p{L}\p{N}]/u;

/** "https://github.com/foo/bar?x#y" → "github.com". */
function speakableUrl(url: string): string {
	return url
		.replace(/^[a-z][\w+.-]*:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/[/?#].*$/, "");
}

/**
 * Collapse one raw segment to its speakable form; empty string when nothing
 * in it is worth vocalizing (pure markup, URLs-only, whitespace).
 */
function normalizeSpeakable(raw: string): string {
	const spoken = raw
		.replace(IMAGE_RE, "$1")
		.replace(LINK_RE, "$1")
		.replace(AUTOLINK_RE, (_match, url: string) => speakableUrl(url))
		.replace(BARE_URL_RE, match => speakableUrl(match))
		.replace(INLINE_CODE_RE, "$1")
		.replace(BOLD_STRIKE_RE, "")
		.replace(EMPHASIS_ASTERISK_RE, "")
		.replace(EMPHASIS_UNDERSCORE_RE, "$1")
		.replace(HTML_TAG_RE, " ")
		.replace(HR_INLINE_RE, "$1")
		.replace(PATH_RE, (_match, lead: string, path: string) => {
			// "packages/coding-agent/src/tts/vocalizer.ts" → "vocalizer.ts".
			const parts = path.split("/").filter(part => part.length > 0);
			return lead + (parts[parts.length - 1] ?? path);
		})
		.replace(/\s+/g, " ")
		.trim();
	return HAS_SPEAKABLE_RE.test(spoken) ? spoken : "";
}

/**
 * Earliest sentence boundary at or past `min` chars; -1 when none. Skips cuts
 * that would strand an unclosed inline-code span or split an abbreviation.
 */
function findSentenceCut(text: string, min: number): number {
	SENTENCE_BOUNDARY_RE.lastIndex = 0;
	for (let match = SENTENCE_BOUNDARY_RE.exec(text); match; match = SENTENCE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut < min) continue;
		const head = text.slice(0, cut);
		if (ABBREVIATION_RE.test(head.trimEnd())) continue;
		if ((head.match(/`/g)?.length ?? 0) % 2 !== 0) continue;
		return cut;
	}
	return -1;
}

/** Earliest clause boundary at or past `min` chars; -1 when none. */
function findClauseCut(text: string, min: number): number {
	CLAUSE_BOUNDARY_RE.lastIndex = 0;
	for (let match = CLAUSE_BOUNDARY_RE.exec(text); match; match = CLAUSE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut >= min) return cut;
	}
	return -1;
}

/**
 * Latest clause boundary in `[min, max]` chars; -1 when none. Keeps soft-cut
 * segments grouped near the target length instead of shaving off the earliest
 * stale clause.
 */
function findLastClauseCut(text: string, min: number, max: number): number {
	CLAUSE_BOUNDARY_RE.lastIndex = 0;
	let best = -1;
	for (let match = CLAUSE_BOUNDARY_RE.exec(text); match; match = CLAUSE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut > max) break;
		if (cut >= min) best = cut;
	}
	return best;
}

/** Word-level cut for text with no usable punctuation: last space at or before `max`. */
function findForcedCut(text: string, max: number): number {
	const space = text.lastIndexOf(" ", max);
	return space > 0 ? space + 1 : Math.min(max, text.length);
}

/** How a line-start prefix resolved. */
type PrefixDecision =
	| { kind: "undecided" }
	| { kind: "prose"; text: string }
	| { kind: "marker"; spoken: string }
	| { kind: "swallow" }
	| { kind: "fence"; fence: string };

function classifyPrefix(prefix: string): PrefixDecision {
	if (prefix === "|") return { kind: "swallow" };
	if (/^(?:`{3}|~{3})/.test(prefix)) return { kind: "fence", fence: prefix.slice(0, 3) };
	if (/^#{1,6}[ \t]/.test(prefix)) return { kind: "marker", spoken: "" };
	if (/^[-*+][ \t]/.test(prefix)) return { kind: "marker", spoken: "" };
	const numbered = /^(\d{1,3})[.)][ \t]/.exec(prefix);
	if (numbered) return { kind: "marker", spoken: `${numbered[1]}, ` };
	if (/^>+/.test(prefix) && !/^>+$/.test(prefix)) {
		return { kind: "prose", text: prefix.replace(/^>+[ \t]?/, "") };
	}
	if (UNDECIDED_PREFIX_RE.test(prefix)) return { kind: "undecided" };
	return { kind: "prose", text: prefix };
}

/** Block-pass state: where the current character lands. */
type BlockMode = "linestart" | "prose" | "swallow" | "code";

/**
 * One per utterance. Feed raw assistant deltas through {@link push}; each call
 * returns the segments that became ready to speak. {@link flush} drains the
 * remainder at message end; {@link flushIdle} drains it when generation stalls
 * mid-sentence so speech doesn't sit on buffered text through a tool call.
 */
export class SpeakableStream {
	#mode: BlockMode = "linestart";
	/** Pending line-start characters while the block marker is still ambiguous. */
	#prefix = "";
	/** Opening fence of the code block being swallowed (``` or ~~~). */
	#fence = "";
	/** First characters of the current line inside a code block (fence-close probe). */
	#codeLine = "";
	/** Mode to enter after the current swallowed line ends (code for an opening fence). */
	#afterSwallow: BlockMode = "linestart";
	/** Prose accumulator the segmenter cuts from. */
	#buf = "";
	/** Whether anything has been emitted yet (enables the fast first segment). */
	#spoke = false;

	/** Consume a raw delta; returns segments now ready to speak, in order. */
	push(delta: string): string[] {
		const out: string[] = [];
		for (const ch of delta) this.#consume(ch, out);
		this.#extract(out);
		return out;
	}

	/** Message end: drain everything left, including a trailing partial sentence. */
	flush(): string[] {
		const out: string[] = [];
		if (this.#mode === "linestart" && this.#prefix.length > 0 && !HR_LINE_RE.test(this.#prefix)) {
			this.#buf += this.#prefix;
		}
		this.#prefix = "";
		this.#mode = "linestart";
		this.#drain(out);
		return out;
	}

	/**
	 * Generation stalled (tool call, thinking block): speak what we have rather
	 * than sit silent on buffered text. Keeps block state so the stream resumes
	 * afterwards, and refuses stubby mid-sentence fragments — the buffer must be
	 * a complete thought (trailing sentence punctuation) or at least
	 * {@link MIN_SEGMENT} long, so a stall right after "The" stays silent
	 * instead of turning into choppy one-word speech.
	 */
	flushIdle(): string[] {
		const out: string[] = [];
		const pending = this.#buf.trimEnd();
		const completeThought = /[.!?…][)\]"'»”’]*$/.test(pending);
		if (!completeThought && pending.length < MIN_SEGMENT) return out;
		this.#drain(out);
		return out;
	}

	#consume(ch: string, out: string[]): void {
		switch (this.#mode) {
			case "linestart":
				this.#consumeLineStart(ch, out);
				return;
			case "prose":
				if (ch === "\n") this.#hardBreak(out);
				else this.#buf += ch;
				return;
			case "swallow":
				if (ch === "\n") this.#mode = this.#afterSwallow;
				return;
			case "code":
				this.#consumeCode(ch);
				return;
		}
	}

	#consumeLineStart(ch: string, out: string[]): void {
		if (ch === "\n") {
			// The whole line fit in the prefix: an hr/blank line is silence; a
			// short undecided prefix ("Hi.", "OK") was prose all along.
			const line = this.#prefix;
			this.#prefix = "";
			if (line.length > 0 && !HR_LINE_RE.test(line)) this.#buf += line;
			this.#hardBreak(out);
			return;
		}
		this.#prefix += ch;
		const decision = classifyPrefix(this.#prefix);
		if (decision.kind === "undecided") {
			if (this.#prefix.length > 8) {
				this.#buf += this.#prefix;
				this.#prefix = "";
				this.#mode = "prose";
			}
			return;
		}
		this.#prefix = "";
		switch (decision.kind) {
			case "prose":
				this.#buf += decision.text;
				this.#mode = "prose";
				return;
			case "marker":
				this.#buf += decision.spoken;
				this.#mode = "prose";
				return;
			case "swallow":
				this.#mode = "swallow";
				this.#afterSwallow = "linestart";
				return;
			case "fence":
				this.#fence = decision.fence;
				this.#codeLine = "";
				this.#mode = "swallow";
				this.#afterSwallow = "code";
				return;
		}
	}

	#consumeCode(ch: string): void {
		if (ch === "\n") {
			this.#codeLine = "";
			return;
		}
		if (this.#codeLine.length < 3) {
			this.#codeLine += ch;
			if (this.#codeLine === this.#fence) {
				// Closing fence: swallow the rest of its line, then resume prose.
				this.#mode = "swallow";
				this.#afterSwallow = "linestart";
			}
		}
	}

	/** Newline in prose: everything buffered is a complete unit — emit it now. */
	#hardBreak(out: string[]): void {
		this.#mode = "linestart";
		this.#drain(out);
	}

	/**
	 * Emit every buffered character. Runs the bounded streaming segmenter first
	 * so a large buffer (paste-sized delta, one-shot push) prefers sentence and
	 * clause cuts within {@link MAX_SEGMENT}, instead of word-splitting whole
	 * paragraphs at the cap ("…a big jump is" / "coming"). Not byte-identical to
	 * char-by-char streaming — the soft-clause latency cut can fire earlier
	 * there — but every segment obeys the same cap and boundary preferences.
	 * {@link #extract} leaves at most MAX_SEGMENT behind, emitted as the
	 * trailing segment.
	 */
	#drain(out: string[]): void {
		this.#extract(out);
		const text = this.#buf;
		this.#buf = "";
		this.#emit(text, out);
	}

	/** Cut ready segments off the front of the buffer (streaming path). */
	#extract(out: string[]): void {
		for (;;) {
			const buf = this.#buf;
			const min = this.#spoke ? MIN_SEGMENT : FIRST_SEGMENT_MIN;
			// Bounded: a sentence past MAX_SEGMENT risks Kokoro's ~510-phoneme
			// truncation — fall through to clause/word cuts instead.
			const sentence = findSentenceCut(buf, min);
			if (sentence !== -1 && sentence <= MAX_SEGMENT) {
				this.#cut(sentence, out);
				continue;
			}
			if (!this.#spoke && buf.length >= FIRST_CLAUSE_MIN) {
				// Bounded like the sentence branch: in a one-shot buffer the earliest
				// clause can lie far past the cap; per-char streaming would have
				// force-cut at FIRST_FORCED_MAX long before seeing it.
				const clause = findClauseCut(buf, FIRST_SEGMENT_MIN);
				if (clause !== -1 && clause <= FIRST_FORCED_MAX) {
					this.#cut(clause, out);
					continue;
				}
				if (buf.length >= FIRST_FORCED_MAX) {
					this.#cut(findForcedCut(buf, FIRST_FORCED_MAX), out);
					continue;
				}
			}
			if (this.#spoke && buf.length >= SOFT_CLAUSE_LEN) {
				const clause = findLastClauseCut(buf, MIN_SEGMENT, SOFT_CLAUSE_LEN);
				if (clause !== -1) {
					this.#cut(clause, out);
					continue;
				}
			}
			if (buf.length > MAX_SEGMENT) {
				const clause = findLastClauseCut(buf, MIN_SEGMENT, MAX_SEGMENT);
				this.#cut(clause !== -1 ? clause : findForcedCut(buf, MAX_SEGMENT), out);
				continue;
			}
			return;
		}
	}

	#cut(at: number, out: string[]): void {
		const head = this.#buf.slice(0, at);
		this.#buf = this.#buf.slice(at);
		this.#emit(head, out);
	}

	#emit(raw: string, out: string[]): void {
		const spoken = normalizeSpeakable(raw);
		if (!spoken) return;
		out.push(spoken);
		this.#spoke = true;
	}
}
