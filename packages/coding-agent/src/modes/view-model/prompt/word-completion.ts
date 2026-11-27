import { type Accessor, signal } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { maskNonProse } from "./markdown-prose";
import { isProseWord, lineContext, ProseSource } from "./prose-gate";

import {
	WORD_COMPLETION_METHODS,
	type WordCompletionEngine,
	type WordCompletionMethod,
} from "./word-completion-methods";
export { WORD_COMPLETION_METHODS, type WordCompletionEngine, type WordCompletionMethod };

/** Asynchronous engine behind ghost-text word completion (coding-agent: the text-prediction daemon). */
export interface WordPredictionBackend {
	/** Characters to paint after `prefix` typed after `before`, or `null` to show nothing. */
	complete(before: string, prefix: string): Promise<string | null>;
	/** Report a shown suggestion the user accepted (Tab/→) or typed past. Fire-and-forget. */
	feedback(before: string, prefix: string, suggestion: string, accepted: boolean): void;
}

const WORD_SUFFIX = /[\p{L}\p{M}']+$/u;

const WORD_CONTINUES = /^[\p{L}\p{M}']/u;

/** Context sent with each query: the editor text before the word, capped to a recent tail. */
const BEFORE_LIMIT = 2_000;

/** The prose word ending at the cursor and the editor text before it: what an engine is asked to complete. */
export interface WordCompletionQuery {
	before: string;
	prefix: string;
}

/** Editor text before the word starting at `start`, truncated to its last {@link BEFORE_LIMIT} code units. */
function textBefore(lines: readonly string[], cursorLine: number, start: number): string {
	const head = (lines[cursorLine] ?? "").slice(0, start);
	// Find the first line the capped tail reaches, then join once.
	let length = head.length;
	let first = cursorLine;
	while (first > 0 && length < BEFORE_LIMIT) {
		first--;
		length += (lines[first] ?? "").length + 1;
	}
	let text = head;
	if (first < cursorLine) {
		const parts: string[] = [];
		for (let line = first; line < cursorLine; line++) parts.push(lines[line] ?? "");
		parts.push(head);
		text = parts.join("\n");
	}
	if (text.length <= BEFORE_LIMIT) return text;
	let cut = text.length - BEFORE_LIMIT;
	// Never start on the low half of a surrogate pair.
	const unit = text.charCodeAt(cut);
	if (unit >= 0xdc00 && unit <= 0xdfff) cut++;
	return text.slice(cut);
}

/**
 * The query for the prose word ending at the cursor, or `undefined` where no
 * ghost text applies (mid-word, no word, code, paths, commands). `prose`
 * memoizes the whole-buffer mask; pass one instance across keystrokes.
 */
export function wordCompletionQuery(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
	prose: ProseSource = new ProseSource(),
): WordCompletionQuery | undefined {
	const line = lines[cursorLine] ?? "";
	if (WORD_CONTINUES.test(line.slice(cursorCol))) return undefined;
	// Single letters are asked too (`figure o|ut`); engines own their minimum prefix.
	const match = WORD_SUFFIX.exec(line.slice(0, cursorCol));
	if (!match) return undefined;
	const start = cursorCol - match[0].length;
	if (!isProseWord(line, maskNonProse(line), start, cursorCol)) return undefined;
	if (!prose.isProse(lineContext(lines, cursorLine), start, cursorCol)) return undefined;
	return { before: textBefore(lines, cursorLine, start), prefix: match[0] };
}

/** Answers kept per provider before the cache starts over. */
const CACHE_LIMIT = 256;

interface KeyedQuery extends WordCompletionQuery {
	/** Engine, prefix and context: one answer per key. */
	readonly key: string;
}

/**
 * Ghost-text word completion over an asynchronous engine.
 *
 * {@link getWordCompletion} answers synchronously from a cache and asks the
 * engine for words it has not answered yet (one request in flight, the
 * newest waiting); {@link revision} bumps when an answer changes what the
 * last call showed, so a reactive caller re-reads it. While the user types
 * through a shown word, its remainder stays (projected) until the engine
 * offers a different word.
 */
export class WordCompletionProvider {
	readonly #backend: (engine: WordCompletionEngine) => WordPredictionBackend | undefined;
	readonly #revision = signal(0);
	readonly #prose = new ProseSource();
	readonly #cache = new Map<string, string | null>();
	#method: WordCompletionMethod = "off";
	#generation = 0;
	#active: string | undefined;
	#queued: KeyedQuery | undefined;
	/** The last word shown, for projection while typing through it. */
	#lastShown: { before: string; word: string } | undefined;
	/** What the last {@link getWordCompletion} returned. */
	#displayed: { key: string; suffix: string | null } | undefined;

	/** Bumped when an answer changes the ghost text the last call returned (reactive). */
	readonly revision: Accessor<number> = this.#revision;

	constructor(backend: (engine: WordCompletionEngine) => WordPredictionBackend | undefined) {
		this.#backend = backend;
	}

	/** Select the engine (`off` disables completion) and drop the previous engine's answers. */
	setMethod(method: WordCompletionMethod): void {
		if (this.#method === method) return;
		this.#method = method;
		this.#generation++;
		this.#cache.clear();
		this.#queued = undefined;
		this.#lastShown = undefined;
		this.#displayed = undefined;
	}

	/** The ghost-text suffix for the prose word ending at the cursor, or `null`. */
	getWordCompletion(lines: readonly string[], cursorLine: number, cursorCol: number): string | null {
		const query = this.#query(lines, cursorLine, cursorCol);
		const backend = query && this.#engine();
		if (!query || !backend) {
			this.#displayed = undefined;
			return null;
		}
		if (!this.#cache.has(query.key)) this.#schedule(backend, query);
		const suffix = this.#cache.get(query.key) ?? this.#project(query);
		this.#displayed = { key: query.key, suffix };
		if (suffix) this.#lastShown = { before: query.before, word: query.prefix + suffix };
		return suffix;
	}

	/** Report the suggestion shown at the cursor as accepted (Tab/→) or typed past. */
	wordCompletionFeedback(
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
		suggestion: string,
		accepted: boolean,
	): void {
		const query = this.#query(lines, cursorLine, cursorCol);
		if (!query) return;
		this.#engine()?.feedback(query.before, query.prefix, suggestion, accepted);
		if (!accepted) this.#lastShown = undefined;
	}

	#engine(): WordPredictionBackend | undefined {
		return this.#method === "off" ? undefined : this.#backend(this.#method);
	}

	#query(lines: readonly string[], cursorLine: number, cursorCol: number): KeyedQuery | undefined {
		if (this.#method === "off") return undefined;
		const query = wordCompletionQuery(lines, cursorLine, cursorCol, this.#prose);
		return query && { ...query, key: `${this.#method}\u0000${query.prefix}\u0000${query.before}` };
	}

	/** The rest of the last shown word while the typed prefix still matches it. */
	#project(query: KeyedQuery): string | null {
		const shown = this.#lastShown;
		if (!shown || shown.before !== query.before || shown.word.length <= query.prefix.length) return null;
		if (!shown.word.toLocaleLowerCase().startsWith(query.prefix.toLocaleLowerCase())) return null;
		return shown.word.slice(query.prefix.length);
	}

	#schedule(backend: WordPredictionBackend, query: KeyedQuery): void {
		if (this.#active === query.key || this.#queued?.key === query.key) return;
		if (this.#active !== undefined) {
			this.#queued = query;
			return;
		}
		void this.#run(backend, query);
	}

	async #run(backend: WordPredictionBackend, query: KeyedQuery): Promise<void> {
		this.#active = query.key;
		const generation = this.#generation;
		let suffix: string | null;
		try {
			suffix = (await backend.complete(query.before, query.prefix)) || null;
		} catch (error) {
			logger.debug("word completion request failed", { error: String(error) });
			suffix = null;
		}
		if (this.#active === query.key) this.#active = undefined;
		const current = generation === this.#generation;
		if (current) {
			if (this.#cache.size >= CACHE_LIMIT) this.#cache.clear();
			this.#cache.set(query.key, suffix);
		}
		const queued = this.#queued;
		this.#queued = undefined;
		const next = queued && !this.#cache.has(queued.key) ? this.#engine() : undefined;
		if (queued && next) void this.#run(next, queued);
		const displayed = this.#displayed;
		if (current && displayed?.key === query.key && displayed.suffix !== (suffix ?? this.#project(query))) {
			this.#revision.update(n => n + 1);
		}
	}
}
