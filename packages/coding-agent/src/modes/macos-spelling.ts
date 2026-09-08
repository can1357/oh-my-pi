import * as native from "@oh-my-pi/pi-natives";
import type {
	EditorInlineReplacement,
	EditorTextAssistProvider,
	EditorWordReplacements,
} from "@oh-my-pi/pi-tui/components/editor";
import { logger } from "@oh-my-pi/pi-utils";
import { maskNonProse } from "./markdown-prose";

const TYPO_START = "\x1b[4:3m\x1b[58:2::255:95:95m";
const TYPO_END = "\x1b[4:0m\x1b[59m";
const WORD_SUFFIX = /[\p{L}\p{M}']+$/u;
const COMPLETED_WORD = /([\p{L}\p{M}']+)([\s.,;:!?"\])}])$/u;
const CODEISH_CHARACTERS = "\\/@_=:{}[]<>";
const CAMEL_CASE = /\p{Ll}\p{Lu}/u;
const CACHE_LIMIT = 256;
const MAX_SPELLING_BUFFER_LENGTH = 20_000;
const MAX_SPELLING_LINE_LENGTH = 1_000;
const WORD_BOUNDARY = /[\s.,;:!?"\])}]/u;

/** Independently switchable macOS prose-assistance features. */
export interface SpellingFeatures {
	typoDetection: boolean;
	autocomplete: boolean;
	autocorrect: boolean;
}

/** Logical source location for one rendered editor segment. */
export interface SpellingDecorationContext {
	editorText: string;
	lines: readonly string[];
	line: number;
	startCol: number;
}

/** Native spelling operations used by {@link MacOSSpellingProvider}. */
export interface SpellingBackend {
	isAvailable(): boolean;
	checkSpelling(text: string): Promise<readonly native.SpellingRange[]>;
	completeWord(text: string, start: number, length: number): Promise<readonly string[]>;
	autocorrectWord(text: string, start: number, length: number): Promise<string | null>;
	spellingGuesses(text: string, start: number, length: number): Promise<readonly string[]>;
}

const NATIVE_BACKEND: SpellingBackend = {
	isAvailable: () =>
		typeof native.macOSSpellCheckerAvailable === "function" &&
		typeof native.macOSCheckSpelling === "function" &&
		typeof native.macOSCompleteWord === "function" &&
		typeof native.macOSAutocorrectWord === "function" &&
		typeof native.macOSSpellingGuesses === "function" &&
		native.macOSSpellCheckerAvailable(),
	checkSpelling: text => native.macOSCheckSpelling(text),
	completeWord: (text, start, length) => native.macOSCompleteWord(text, start, length),
	autocorrectWord: (text, start, length) => native.macOSAutocorrectWord(text, start, length),
	spellingGuesses: (text, start, length) => native.macOSSpellingGuesses(text, start, length),
};

function tokenAt(text: string, start: number, end: number): string {
	let tokenStart = start;
	while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) tokenStart--;
	let tokenEnd = end;
	while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) tokenEnd++;
	return text.slice(tokenStart, tokenEnd);
}

function isProseWord(text: string, masked: string, start: number, end: number): boolean {
	if (start < 0 || end <= start || end > text.length) return false;
	if (masked.slice(start, end).trim().length === 0) return false;
	const token = tokenAt(text, start, end);
	for (const char of token) {
		if (CODEISH_CHARACTERS.includes(char)) return false;
	}
	if (CAMEL_CASE.test(token) || /\d/.test(token)) return false;
	return !text.trimStart().startsWith("/") && !text.startsWith("->") && !text.startsWith("=>");
}

/**
 * Bridges Apple's spelling service into the editor's separate typo,
 * word-completion, and autocorrection paths.
 */
export class MacOSSpellingProvider implements EditorTextAssistProvider {
	#features: SpellingFeatures = { typoDetection: false, autocomplete: false, autocorrect: false };
	#available: boolean;
	#availabilityChecked = false;
	#cacheGeneration = 0;
	#typoCache = new Map<string, readonly native.SpellingRange[]>();
	#typoInFlight = new Map<string, Promise<readonly native.SpellingRange[]>>();
	#automaticTypoActive = false;
	#automaticTypoQueue = new Map<string, string>();
	#completionCache = new Map<string, string | null>();
	#completionActiveKey: string | undefined;
	#completionQueued: { key: string; line: string; start: number; prefix: string } | undefined;
	#sourceText = "";
	#sourceMask = "";
	#sourceLineOffsets: number[] = [];

	/** Invoked when an asynchronous spelling result can change rendered output. */
	onUpdate: (() => void) | undefined;

	constructor(private readonly backend: SpellingBackend = NATIVE_BACKEND) {
		this.#available = false;
	}

	/** Apply all three independent feature gates and invalidate rendered typo ranges. */
	setFeatures(features: SpellingFeatures): void {
		if (
			this.#features.typoDetection === features.typoDetection &&
			this.#features.autocomplete === features.autocomplete &&
			this.#features.autocorrect === features.autocorrect
		) {
			return;
		}
		this.#features = { ...features };
		if (!this.#availabilityChecked && (features.typoDetection || features.autocomplete || features.autocorrect)) {
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
		if (!this.#sourceRangeIsProse(context, context.startCol, context.startCol + text.length)) {
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
			if (!this.#sourceRangeIsProse(context, context.startCol + range.start, context.startCol + end)) {
				continue;
			}
			rendered += decorate(text.slice(cursor, range.start));
			rendered += TYPO_START + decorate(text.slice(range.start, end)) + TYPO_END;
			cursor = end;
		}
		return rendered + decorate(text.slice(cursor));
	}

	/** Return the cached macOS completion suffix for the word ending at the cursor. */
	getWordCompletion(lines: string[], cursorLine: number, cursorCol: number): string | null {
		if (!this.#available || !this.#features.autocomplete) return null;
		const line = lines[cursorLine] ?? "";
		if (/^[\p{L}\p{M}']/u.test(line.slice(cursorCol))) return null;
		const match = WORD_SUFFIX.exec(line.slice(0, cursorCol));
		if (!match || match[0].length < 2) return null;
		const start = cursorCol - match[0].length;
		const masked = maskNonProse(line);
		if (!isProseWord(line, masked, start, cursorCol)) return null;
		const context = this.#context(lines, cursorLine);
		if (!this.#sourceRangeIsProse(context, start, cursorCol)) return null;

		const prefix = match[0];
		const key = `${start}:${prefix.length}:${line}`;
		if (this.#completionCache.has(key)) return this.#completionCache.get(key) ?? null;
		this.#scheduleWordCompletion(key, line, start, prefix);
		return null;
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
		const boundary = match[2] ?? "";
		const start = match.index;
		const masked = maskNonProse(textBeforeCursor);
		if (!isProseWord(textBeforeCursor, masked, start, start + word.length)) return null;
		const context = this.#context(lines, cursorLine);
		if (!this.#sourceRangeIsProse(context, start, start + word.length)) return null;
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
		const context = this.#context(lines, cursorLine);
		if (!this.#sourceRangeIsProse(context, 0, line.length)) return null;
		const ranges = this.#typoCache.get(line) ?? (await this.#loadTypoRanges(line));
		const range = ranges.find(candidate => {
			const end = candidate.start + candidate.length;
			return (
				cursorCol >= candidate.start &&
				(cursorCol <= end || (cursorCol === end + 1 && WORD_BOUNDARY.test(line[end] ?? ""))) &&
				this.#sourceRangeIsProse(context, candidate.start, end)
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
			.filter(range => isProseWord(text, masked, range.start, range.start + range.length))
			.toSorted((left, right) => left.start - right.start);
		const hadProjectedRanges = (this.#projectTypoRanges(text)?.length ?? 0) > 0;
		if (this.#typoCache.size >= CACHE_LIMIT) this.#typoCache.clear();
		this.#typoCache.set(text, ranges);
		if (ranges.length > 0 || hadProjectedRanges) this.onUpdate?.();
		return ranges;
	}

	#scheduleWordCompletion(key: string, line: string, start: number, prefix: string): void {
		if (this.#completionActiveKey === key || this.#completionQueued?.key === key) return;
		if (this.#completionActiveKey !== undefined) {
			this.#completionQueued = { key, line, start, prefix };
			return;
		}
		this.#startWordCompletion(key, line, start, prefix);
	}
	#startWordCompletion(key: string, line: string, start: number, prefix: string): void {
		this.#completionActiveKey = key;
		const generation = this.#cacheGeneration;
		const request = this.#fetchWordCompletion(key, line, start, prefix, generation);
		const finished = (): void => {
			if (this.#completionActiveKey === key) this.#completionActiveKey = undefined;
			const queued = this.#completionQueued;
			this.#completionQueued = undefined;
			if (queued && this.#available && this.#features.autocomplete && !this.#completionCache.has(queued.key)) {
				this.#startWordCompletion(queued.key, queued.line, queued.start, queued.prefix);
			}
		};
		void request.then(finished, finished);
	}

	async #fetchWordCompletion(
		key: string,
		line: string,
		start: number,
		prefix: string,
		generation: number,
	): Promise<void> {
		try {
			const completions = await this.backend.completeWord(line, start, prefix.length);
			if (generation !== this.#cacheGeneration || !this.#available) return;
			const lowerPrefix = prefix.toLocaleLowerCase();
			let suffix: string | null = null;
			for (const completion of completions) {
				if (completion.length > prefix.length && completion.toLocaleLowerCase().startsWith(lowerPrefix)) {
					suffix = completion.slice(prefix.length);
					break;
				}
			}
			if (this.#completionCache.size >= CACHE_LIMIT) this.#completionCache.clear();
			this.#completionCache.set(key, suffix);
			// A null suffix means no ghost text; the current paint is already right.
			if (suffix !== null && this.#completionQueued === undefined) this.onUpdate?.();
		} catch (error) {
			this.#disable(error);
		}
	}

	#context(lines: readonly string[], line: number): SpellingDecorationContext {
		return { editorText: lines.join("\n"), lines, line, startCol: 0 };
	}

	#sourceRangeIsProse(context: SpellingDecorationContext, startCol: number, endCol: number): boolean {
		if (context.editorText.length > MAX_SPELLING_BUFFER_LENGTH || startCol < 0 || endCol <= startCol) {
			return false;
		}
		const line = context.lines[context.line];
		if (line === undefined || line.length > MAX_SPELLING_LINE_LENGTH || endCol > line.length) return false;
		this.#prepareSource(context);
		const lineOffset = this.#sourceLineOffsets[context.line];
		if (lineOffset === undefined) return false;
		return this.#sourceMask.slice(lineOffset + startCol, lineOffset + endCol).trim().length > 0;
	}

	#prepareSource(context: SpellingDecorationContext): void {
		if (this.#sourceText === context.editorText) return;
		this.#sourceText = context.editorText;
		this.#sourceMask = maskNonProse(context.editorText);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		this.#sourceLineOffsets = new Array<number>(context.lines.length);
		let offset = 0;
		for (let line = 0; line < context.lines.length; line++) {
			this.#sourceLineOffsets[line] = offset;
			offset += (context.lines[line]?.length ?? 0) + 1;
		}
	}

	#clearCaches(): void {
		this.#cacheGeneration++;
		this.#typoCache.clear();
		this.#typoInFlight.clear();
		this.#automaticTypoQueue.clear();
		this.#completionCache.clear();
		this.#completionQueued = undefined;
	}

	#disable(error: unknown): void {
		if (!this.#available) return;
		this.#available = false;
		this.#clearCaches();
		logger.warn("macOS spelling service failed; disabling editor spelling assistance", { error: String(error) });
	}
}
