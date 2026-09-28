import * as native from "@oh-my-pi/pi-natives";
import { TERMINAL } from "../index";
import type { EditorInlineReplacement, EditorTextAssistProvider, EditorWordReplacements } from "../components/editor";
import { logger } from "@oh-my-pi/pi-utils";
import { isMagicKeyword } from "./magic-keywords";
import { maskNonProse } from "./markdown-prose";
import { isProseWord, lineContext, ProseSource, type SpellingDecorationContext } from "./prose-gate";

/** Styled underline: red curly undercurl via colon-subparameter SGR (4:3 + SGR 58 color). */
const STYLED_TYPO_MARKS = { start: "\x1b[4:3m\x1b[58:2::255:95:95m", end: "\x1b[4:0m\x1b[59m" } as const;
/**
 * Flat underline: legacy CSI 4 m / CSI 24 m only, no SGR 58/59. Used where the
 * terminal lacks styled underlines — Apple Terminal paints CSI 4 : 0 m (the
 * styled reset) as a solid black bar to end of line.
 */
const FLAT_TYPO_MARKS = { start: "\x1b[4m", end: "\x1b[24m" } as const;

const COMPLETED_WORD = /([\p{L}\p{M}']+)([\s.,;:!?"\])}])$/u;
const CACHE_LIMIT = 256;
const WORD_BOUNDARY = /[\s.,;:!?"\])}]/u;

/** Independently switchable macOS prose-assistance features. */
export interface MacOSSpellingFeatures {
	typoDetection: boolean;
	autocorrect: boolean;
}

/** Native spelling operations used by {@link MacOSSpellingProvider}. */
export interface SpellingBackend {
	isAvailable(): boolean;
	checkSpelling(text: string): Promise<readonly native.SpellingRange[]>;
	autocorrectWord(text: string, start: number, length: number): Promise<string | null>;
	spellingGuesses(text: string, start: number, length: number): Promise<readonly string[]>;
}

const NATIVE_BACKEND: SpellingBackend = {
	isAvailable: () =>
		typeof native.macOSSpellCheckerAvailable === "function" &&
		typeof native.macOSCheckSpelling === "function" &&
		typeof native.macOSAutocorrectWord === "function" &&
		typeof native.macOSSpellingGuesses === "function" &&
		native.macOSSpellCheckerAvailable(),
	checkSpelling: text => native.macOSCheckSpelling(text),
	autocorrectWord: (text, start, length) => native.macOSAutocorrectWord(text, start, length),
	spellingGuesses: (text, start, length) => native.macOSSpellingGuesses(text, start, length),
};

/**
 * Bridges Apple's spelling service into the editor's typo and autocorrection
 * paths. Word completion is the cross-platform `WordCompletionProvider`
 * (`word-completion.ts`).
 */
export class MacOSSpellingProvider implements EditorTextAssistProvider {
	#features: MacOSSpellingFeatures = { typoDetection: false, autocorrect: false };
	#available: boolean;
	#availabilityChecked = false;
	#cacheGeneration = 0;
	#typoCache = new Map<string, readonly native.SpellingRange[]>();
	#typoInFlight = new Map<string, Promise<readonly native.SpellingRange[]>>();
	#automaticTypoActive = false;
	#automaticTypoQueue = new Map<string, string>();
	#prose = new ProseSource();
	/** Underline open/close pair, chosen once from the terminal's styled-underline capability. */
	readonly #marks: { start: string; end: string };

	/** Invoked when an asynchronous spelling result can change rendered output. */
	onUpdate: (() => void) | undefined;

	constructor(
		private readonly backend: SpellingBackend = NATIVE_BACKEND,
		styledUnderlines: boolean = TERMINAL.styledUnderlines,
	) {
		this.#available = false;
		this.#marks = styledUnderlines ? STYLED_TYPO_MARKS : FLAT_TYPO_MARKS;
	}

	/** Apply both independent feature gates and invalidate rendered typo ranges. */
	setFeatures(features: MacOSSpellingFeatures): void {
		if (
			this.#features.typoDetection === features.typoDetection &&
			this.#features.autocorrect === features.autocorrect
		) {
			return;
		}
		this.#features = { ...features };
		if (!this.#availabilityChecked && (features.typoDetection || features.autocorrect)) {
			this.#availabilityChecked = true;
			this.#available = typeof this.backend.isAvailable === "function" && this.backend.isAvailable();
		}
		this.#clearCaches();
	}

	/** Add red undercurls to misspellings while preserving visible text width. */
	decorateTypos(
		text: string,
		context: SpellingDecorationContext,
		decorate: (span: string) => string = value => value,
	): string {
		if (!this.#available || !this.#features.typoDetection || text.length === 0) return decorate(text);
		if (!this.#prose.isProse(context, context.startCol, context.startCol + text.length)) {
			return decorate(text);
		}
		const lane = `${context.line}:${context.startCol}`;
		const cached = this.#typoCache.get(text);
		// A cache hit obsoletes any older text queued for this lane. A miss must
		// keep its just-scheduled entry alive: deleting it here used to cancel the
		// verification check whenever a stale projection painted ranges while
		// another check was in flight, freezing the projected undercurl (e.g. the
		// "eac" of a fast-typed "each") until an unrelated repaint rescheduled it.
		if (cached === undefined) this.#scheduleTypoRanges(text, lane);
		else this.#automaticTypoQueue.delete(lane);
		const ranges = cached ?? this.#projectTypoRanges(text);
		if (!ranges) return decorate(text);
		if (ranges.length === 0) return decorate(text);
		let rendered = "";
		let cursor = 0;
		for (const range of ranges) {
			const end = range.start + range.length;
			// Overlapping or out-of-bounds ranges (stale native data, edit projection)
			// must never re-emit already-rendered text: that doubles it on screen and
			// desyncs the rendered width from the measured width (cursor drift).
			if (range.start < cursor || end > text.length) continue;
			if (!this.#prose.isProse(context, context.startCol + range.start, context.startCol + end)) {
				continue;
			}
			rendered += decorate(text.slice(cursor, range.start));
			rendered += this.#marks.start + decorate(text.slice(range.start, end)) + this.#marks.end;
			cursor = end;
		}
		return rendered + decorate(text.slice(cursor));
	}

	/** Return the confident macOS correction after a completed prose word. */
	async tryAutocorrect(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<EditorInlineReplacement | null> {
		if (!this.#available || !this.#features.autocorrect) return null;
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const match = COMPLETED_WORD.exec(textBeforeCursor);
		if (!match) return null;
		const word = match[1] ?? "";
		// Magic keywords are deliberate non-dictionary words; never "fix" them.
		if (isMagicKeyword(word)) return null;
		const boundary = match[2] ?? "";
		const start = match.index;
		const masked = maskNonProse(textBeforeCursor);
		if (!isProseWord(textBeforeCursor, masked, start, start + word.length)) return null;
		const context = lineContext(lines, cursorLine);
		if (!this.#prose.isProse(context, start, start + word.length)) return null;
		try {
			const correction = await this.backend.autocorrectWord(textBeforeCursor, start, word.length);
			if (!correction || correction === word) return null;
			return { replaceLen: word.length + boundary.length, insert: correction + boundary };
		} catch (error) {
			this.#disable(error);
			return null;
		}
	}

	/** Return macOS replacement guesses for the misspelled word at the cursor. */
	async getWordReplacements(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<EditorWordReplacements | null> {
		if (!this.#available || !this.#features.typoDetection) return null;

		const line = lines[cursorLine] ?? "";
		const context = lineContext(lines, cursorLine);
		if (!this.#prose.isProse(context, 0, line.length)) return null;
		const ranges = this.#typoCache.get(line) ?? (await this.#loadTypoRanges(line));
		const range = ranges.find(candidate => {
			const end = candidate.start + candidate.length;
			return (
				cursorCol >= candidate.start &&
				(cursorCol <= end || (cursorCol === end + 1 && WORD_BOUNDARY.test(line[end] ?? ""))) &&
				this.#prose.isProse(context, candidate.start, end)
			);
		});
		if (!range || !this.#available || !this.#features.typoDetection) return null;
		try {
			const seen = new Set<string>();
			const items: string[] = [];
			for (const guess of await this.backend.spellingGuesses(line, range.start, range.length)) {
				if (!guess || seen.has(guess)) continue;
				seen.add(guess);
				items.push(guess);
				if (items.length === 10) break;
			}
			if (items.length === 0) return null;
			return {
				line: cursorLine,
				startCol: range.start,
				endCol: range.start + range.length,
				items,
			};
		} catch (error) {
			this.#disable(error);
			return null;
		}
	}

	#loadTypoRanges(text: string): Promise<readonly native.SpellingRange[]> {
		const cached = this.#typoCache.get(text);
		if (cached) return Promise.resolve(cached);
		const pending = this.#typoInFlight.get(text);
		if (pending) return pending;

		const generation = this.#cacheGeneration;
		const request = this.#fetchTypoRanges(text, generation);
		this.#typoInFlight.set(text, request);
		void request.then(
			() => {
				if (this.#typoInFlight.get(text) === request) this.#typoInFlight.delete(text);
			},
			() => {
				if (this.#typoInFlight.get(text) === request) this.#typoInFlight.delete(text);
			},
		);
		return request;
	}
	#projectTypoRanges(text: string): readonly native.SpellingRange[] | undefined {
		let projected: native.SpellingRange[] | undefined;
		let matchLength = -1;
		for (const [previous, ranges] of this.#typoCache) {
			let prefix = 0;
			while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix++;
			let suffix = 0;
			while (suffix < previous.length - prefix && suffix < text.length - prefix) {
				const previousCharacter = previous[previous.length - suffix - 1];
				const nextCharacter = text[text.length - suffix - 1];
				if (previousCharacter === undefined || nextCharacter === undefined || previousCharacter !== nextCharacter)
					break;
				suffix++;
			}
			if (prefix + suffix < previous.length - 1 || prefix + suffix <= matchLength) continue;
			const oldChangeEnd = previous.length - suffix;
			const newChangeEnd = text.length - suffix;
			const delta = text.length - previous.length;
			projected = ranges.map(range => {
				const end = range.start + range.length;
				if (end <= prefix) return range;
				if (range.start >= oldChangeEnd) return { start: range.start + delta, length: range.length };
				return {
					start: Math.min(range.start, prefix),
					length: Math.max(end + delta, newChangeEnd) - Math.min(range.start, prefix),
				};
			});
			matchLength = prefix + suffix;
		}
		return projected;
	}

	#scheduleTypoRanges(text: string, lane: string): void {
		if (this.#typoCache.has(text) || this.#typoInFlight.has(text)) return;
		if (this.#automaticTypoActive) {
			this.#automaticTypoQueue.set(lane, text);
			return;
		}
		this.#startTypoRanges(text);
	}

	#startTypoRanges(text: string): void {
		this.#automaticTypoActive = true;
		const request = this.#loadTypoRanges(text);
		const finished = (): void => {
			this.#automaticTypoActive = false;
			this.#drainTypoRanges();
		};
		void request.then(finished, finished);
	}

	#drainTypoRanges(): void {
		if (this.#automaticTypoActive) return;
		for (const [lane, text] of this.#automaticTypoQueue) {
			this.#automaticTypoQueue.delete(lane);
			if (this.#typoCache.has(text) || this.#typoInFlight.has(text)) continue;
			this.#startTypoRanges(text);
			return;
		}
	}

	async #fetchTypoRanges(text: string, generation: number): Promise<readonly native.SpellingRange[]> {
		let checked: readonly native.SpellingRange[];
		try {
			checked = await this.backend.checkSpelling(text);
		} catch (error) {
			this.#disable(error);
			return [];
		}
		if (generation !== this.#cacheGeneration || !this.#available) return [];
		const masked = maskNonProse(text);
		const ranges = checked
			.filter(range => {
				const end = range.start + range.length;
				return isProseWord(text, masked, range.start, end) && !isMagicKeyword(text.slice(range.start, end));
			})
			.toSorted((left, right) => left.start - right.start);
		const hadProjectedRanges = (this.#projectTypoRanges(text)?.length ?? 0) > 0;
		if (this.#typoCache.size >= CACHE_LIMIT) this.#typoCache.clear();
		this.#typoCache.set(text, ranges);
		if (ranges.length > 0 || hadProjectedRanges) this.onUpdate?.();
		return ranges;
	}

	#clearCaches(): void {
		this.#cacheGeneration++;
		this.#typoCache.clear();
		this.#typoInFlight.clear();
		this.#automaticTypoQueue.clear();
	}

	#disable(error: unknown): void {
		if (!this.#available) return;
		this.#available = false;
		this.#clearCaches();
		logger.warn("macOS spelling service failed; disabling editor spelling assistance", { error: String(error) });
	}
}
