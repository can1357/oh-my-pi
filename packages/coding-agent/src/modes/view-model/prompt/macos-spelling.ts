import * as native from "@oh-my-pi/pi-natives";
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import { isMagicKeyword } from "../../../session/magic-keywords";
import { maskNonProse } from "./markdown-prose";
import { isProseWord, lineContext, ProseSource, type SpellingDecorationContext } from "./prose-gate";

/**
 * Apple's spelling service for the composer: misspelled prose ranges (typo
 * marks), confident corrections after a completed word (autocorrect) and
 * replacement guesses for the word at the caret. Only prose is ever sent
 * (see `prose-gate.ts`); magic keywords are never marked or corrected. Word
 * completion is the cross-platform `WordCompletionProvider`.
 */

/** A synchronous replacement just before the caret. */
export interface InlineReplacement {
	/** UTF-16 units to remove immediately before the caret. */
	readonly replaceLen: number;
	/** Text inserted where the removed units started. */
	readonly insert: string;
}

/** Replacement candidates for a span of one line. */
export interface WordReplacements {
	readonly line: number;
	readonly startCol: number;
	readonly endCol: number;
	readonly items: readonly string[];
}

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
 * The native side awaits a `flume::bounded(1)` reply with no timeout, so a stuck call
 * stays pending and never reaches the `catch` that disables the provider.
 */
const BACKEND_TIMEOUT_MS = 2_000;

/**
 * Bridges Apple's spelling service into the editor's typo and autocorrection
 * paths. Word completion is the cross-platform `WordCompletionProvider`
 * (`word-completion.ts`).
 */
export class MacOSSpellingProvider {
	#features: MacOSSpellingFeatures = { typoDetection: false, autocorrect: false };
	#available: boolean;
	#availabilityChecked = false;
	#cacheGeneration = 0;
	#typoCache = new Map<string, readonly native.SpellingRange[]>();
	/** {@link #projectTypoRanges} answers for the current {@link #typoCache}; render segments re-ask every frame. */
	#projectionMemo = new Map<string, readonly native.SpellingRange[] | undefined>();
	#typoInFlight = new Map<string, Promise<readonly native.SpellingRange[]>>();
	#automaticTypoActive = false;
	#automaticTypoQueue = new Map<string, string>();
	#prose = new ProseSource();

	/** Invoked when an asynchronous spelling result can change rendered output. */
	onUpdate: (() => void) | undefined;

	constructor(private readonly backend: SpellingBackend = NATIVE_BACKEND) {
		this.#available = false;
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

	/**
	 * Misspelled prose ranges in `text` (offsets into it), in order and
	 * non-overlapping, except ones touching `context.typing` (the word still
	 * being typed). Checks the full logical line so rendering cuts cannot
	 * change spelling or prose boundaries. Uncached lines arrive through {@link onUpdate}.
	 */
	typoRanges(text: string, context: SpellingDecorationContext): readonly native.SpellingRange[] {
		if (!this.#available || !this.#features.typoDetection || text.length === 0) return [];
		const line = context.lines[context.line];
		const segmentEnd = context.startCol + text.length;
		if (
			line === undefined ||
			context.startCol < 0 ||
			segmentEnd > line.length ||
			!line.startsWith(text, context.startCol)
		)
			return [];
		if (!this.#prose.isProse(context, context.startCol, segmentEnd)) return [];
		const lane = `${context.line}:0`;
		const cached = this.#typoCache.get(line);
		// A cache hit obsoletes any older text queued for this lane. A miss must
		// keep its just-scheduled entry alive: deleting it here used to cancel the
		// verification check whenever a stale projection painted ranges while
		// another check was in flight, freezing the projected undercurl (e.g. the
		// "eac" of a fast-typed "each") until an unrelated repaint rescheduled it.
		if (cached === undefined) this.#scheduleTypoRanges(line, lane);
		else this.#automaticTypoQueue.delete(lane);
		const ranges = cached ?? this.#projectTypoRanges(line);
		if (!ranges || ranges.length === 0) return [];
		const kept: native.SpellingRange[] = [];
		const typing = context.typing?.line === context.line ? context.typing : undefined;
		let cursor = 0;
		for (const range of ranges) {
			const end = range.start + range.length;
			if (typing && range.start <= typing.end && typing.start <= end) continue;
			// Overlapping or out-of-bounds ranges (stale native data, edit projection)
			// must never re-emit already-rendered text: that doubles it on screen and
			// desyncs the rendered width from the measured width (cursor drift).
			if (range.start < cursor || end > line.length) continue;
			if (!this.#prose.isProse(context, range.start, end)) continue;
			const start = Math.max(range.start, context.startCol);
			const clippedEnd = Math.min(end, segmentEnd);
			if (start < clippedEnd) {
				kept.push({ start: start - context.startCol, length: clippedEnd - start });
			}
			cursor = end;
		}
		return kept;
	}

	/** Return the confident macOS correction after a completed prose word. */
	async tryAutocorrect(lines: string[], cursorLine: number, cursorCol: number): Promise<InlineReplacement | null> {
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
			const correction = await withTimeout(
				this.backend.autocorrectWord(textBeforeCursor, start, word.length),
				BACKEND_TIMEOUT_MS,
				`macOS spelling service did not respond within ${BACKEND_TIMEOUT_MS}ms`,
			);
			if (!correction || correction === word) return null;
			return { replaceLen: word.length + boundary.length, insert: correction + boundary };
		} catch (error) {
			this.#disable(error);
			return null;
		}
	}

	/** Return macOS replacement guesses for the misspelled word at the cursor. */
	async getWordReplacements(lines: string[], cursorLine: number, cursorCol: number): Promise<WordReplacements | null> {
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
			for (const guess of await withTimeout(
				this.backend.spellingGuesses(line, range.start, range.length),
				BACKEND_TIMEOUT_MS,
				`macOS spelling service did not respond within ${BACKEND_TIMEOUT_MS}ms`,
			)) {
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
		if (this.#projectionMemo.has(text)) return this.#projectionMemo.get(text);
		let projected: native.SpellingRange[] | undefined;
		let matchLength = -1;
		for (const [previous, ranges] of this.#typoCache) {
			// The shared prefix and suffix together never exceed the shorter text, so skip unread a line
			// that cannot beat the current match, or that is longer than `text` by more than the one
			// character a projection may replace.
			const bound = Math.min(previous.length, text.length);
			if (bound <= matchLength || previous.length - 1 > bound) continue;
			let prefix = 0;
			if (text.startsWith(previous)) prefix = previous.length;
			else while (prefix < bound && previous.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
			let suffix = 0;
			while (
				suffix < bound - prefix &&
				previous.charCodeAt(previous.length - suffix - 1) === text.charCodeAt(text.length - suffix - 1)
			) {
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
		if (this.#projectionMemo.size >= CACHE_LIMIT) this.#projectionMemo.clear();
		this.#projectionMemo.set(text, projected);
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
			checked = await withTimeout(
				this.backend.checkSpelling(text),
				BACKEND_TIMEOUT_MS,
				`macOS spelling service did not respond within ${BACKEND_TIMEOUT_MS}ms`,
			);
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
		this.#projectionMemo.clear();
		if (ranges.length > 0 || hadProjectedRanges) this.onUpdate?.();
		return ranges;
	}

	#clearCaches(): void {
		this.#cacheGeneration++;
		this.#typoCache.clear();
		this.#projectionMemo.clear();
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
