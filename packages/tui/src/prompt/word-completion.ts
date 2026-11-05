import { logger } from "@oh-my-pi/pi-utils";
import type { EditorTextAssistProvider } from "../components/editor";
import { maskNonProse } from "./markdown-prose";
import { isProseWord, lineContext, ProseSource } from "./prose-gate";

/** Values of the `spelling.autocomplete` setting. */
export const WORD_COMPLETION_METHODS = ["off", "auto", "ngram", "smollm", "apple"] as const;

/** Configured word-completion engine; `off` disables ghost text. */
export type WordCompletionMethod = (typeof WORD_COMPLETION_METHODS)[number];

/** Whether `value` is a {@link WordCompletionMethod}. */
export function isWordCompletionMethod(value: unknown): value is WordCompletionMethod {
	return WORD_COMPLETION_METHODS.some(method => method === value);
}

/** An enabled word-completion engine. */
export type WordCompletionEngine = Exclude<WordCompletionMethod, "off">;

/** Asynchronous engine behind ghost-text word completion (coding-agent: the text-prediction daemon). */
export interface WordPredictionBackend {
	/** Characters to paint after `prefix` typed after `before`, or `null` to show nothing. */
	complete(before: string, prefix: string): Promise<string | null>;
	/** Report a shown suggestion the user accepted (Tab/→) or typed past. Fire-and-forget. */
	feedback(before: string, prefix: string, suggestion: string, accepted: boolean): void;
}

/** Resolves the backend for an engine; `undefined` means none is available (no ghost text). */
export type WordPredictionBackendResolver = (method: WordCompletionEngine) => WordPredictionBackend | undefined;

let hostResolver: WordPredictionBackendResolver | undefined;

/**
 * Install the host's backend resolver for every editor, including ones built
 * before the host finished starting. Pass `undefined` to detach.
 */
export function setWordPredictionHost(resolver: WordPredictionBackendResolver | undefined): void {
	hostResolver = resolver;
}

const WORD_SUFFIX = /[\p{L}\p{M}']+$/u;
const WORD_CONTINUES = /^[\p{L}\p{M}']/u;
const CACHE_LIMIT = 256;
/** Context sent with each query: the editor text before the word, capped to a recent tail. */
const BEFORE_LIMIT = 2_000;

/** The prose word ending at the cursor and the editor text before it: what an engine is asked to complete. */
export interface WordCompletionQuery {
	before: string;
	prefix: string;
}

interface WordQuery extends WordCompletionQuery {
	key: string;
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

/**
 * Ghost-text word completion for the prose word ending at the cursor, served
 * by an injected asynchronous {@link WordPredictionBackend}.
 *
 * Rendering is synchronous, so a cache miss schedules a single-flight backend
 * request (one active, the newest queued) and repaints through `onUpdate` when
 * the answer changes what is shown. The previous suggestion is projected: if
 * its full word still extends what was typed, the remainder shows immediately
 * and stays until the engine offers a different word.
 */
export class WordCompletionProvider implements EditorTextAssistProvider {
	#method: WordCompletionMethod = "off";
	#generation = 0;
	#prose = new ProseSource();
	#cache = new Map<string, string | null>();
	#activeKey: string | undefined;
	#queued: WordQuery | undefined;
	/** Last non-empty suggestion shown, for projection while typing through it. */
	#lastShown: { before: string; word: string } | undefined;
	/** What the last `getWordCompletion` returned, so a fetch repaints only when it changes that. */
	#displayed: { key: string; suffix: string | null } | undefined;
	/** Last {@link #query} input snapshot (lines are copied: the editor mutates its array in place). */
	#queryMemo:
		| {
				method: WordCompletionMethod;
				lines: readonly string[];
				cursorLine: number;
				cursorCol: number;
				query: WordQuery | undefined;
		  }
		| undefined;

	/** Invoked when an asynchronous answer changes the rendered ghost text. */
	onUpdate: (() => void) | undefined;

	readonly #resolveBackend: WordPredictionBackendResolver;

	/** `resolveBackend` defaults to the host installed with {@link setWordPredictionHost}. */
	constructor(resolveBackend: WordPredictionBackendResolver = method => hostResolver?.(method)) {
		this.#resolveBackend = resolveBackend;
	}

	/** Select the engine (`off` disables completion) and drop answers from the previous one. */
	setMethod(method: WordCompletionMethod): void {
		if (this.#method === method) return;
		this.#method = method;
		this.#generation++;
		this.#cache.clear();
		this.#queued = undefined;
		this.#lastShown = undefined;
		this.#displayed = undefined;
	}

	/** Return the ghost-text suffix for the prose word ending at the cursor, or `null`. */
	getWordCompletion(lines: string[], cursorLine: number, cursorCol: number): string | null {
		const query = this.#query(lines, cursorLine, cursorCol);
		const backend = query && this.#backend();
		if (!query || !backend) {
			this.#displayed = undefined;
			return null;
		}
		if (!this.#cache.has(query.key)) this.#schedule(backend, query);
		// Typing through a shown ghost without Tab can answer null (the word fell
		// under the show threshold, or SmolLM excludes words typed past); keep that
		// ghost until the engine offers something else.
		const suffix = this.#cache.get(query.key) ?? this.#project(query);
		this.#displayed = { key: query.key, suffix };
		if (suffix) this.#lastShown = { before: query.before, word: query.prefix + suffix };
		return suffix;
	}

	/** Forward accept (Tab/→) or typed-past feedback for the suggestion shown at the cursor. */
	wordCompletionFeedback(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		suggestion: string,
		accepted: boolean,
	): void {
		const query = this.#query(lines, cursorLine, cursorCol);
		if (!query) return;
		this.#backend()?.feedback(query.before, query.prefix, suggestion, accepted);
		if (!accepted) this.#lastShown = undefined;
	}

	#backend(): WordPredictionBackend | undefined {
		return this.#method === "off" ? undefined : this.#resolveBackend(this.#method);
	}

	#query(lines: readonly string[], cursorLine: number, cursorCol: number): WordQuery | undefined {
		if (this.#method === "off") return undefined;
		// Rendering asks every frame; reuse the answer until the buffer, caret, or engine changes.
		const memo = this.#queryMemo;
		if (
			memo?.method === this.#method &&
			memo.cursorLine === cursorLine &&
			memo.cursorCol === cursorCol &&
			memo.lines.length === lines.length &&
			memo.lines.every((line, index) => line === lines[index])
		) {
			return memo.query;
		}
		const query = wordCompletionQuery(lines, cursorLine, cursorCol, this.#prose);
		// The method keeps a request still in flight for the previous engine from
		// shadowing the same word state on the new one.
		const result = query && { key: `${this.#method}\u0000${query.prefix}\u0000${query.before}`, ...query };
		this.#queryMemo = { method: this.#method, lines: lines.slice(), cursorLine, cursorCol, query: result };
		return result;
	}

	#project(query: WordQuery): string | null {
		const shown = this.#lastShown;
		if (!shown || shown.before !== query.before || shown.word.length <= query.prefix.length) return null;
		if (!shown.word.toLocaleLowerCase().startsWith(query.prefix.toLocaleLowerCase())) return null;
		return shown.word.slice(query.prefix.length);
	}

	#schedule(backend: WordPredictionBackend, query: WordQuery): void {
		if (this.#activeKey === query.key || this.#queued?.key === query.key) return;
		if (this.#activeKey !== undefined) {
			this.#queued = query;
			return;
		}
		void this.#run(backend, query);
	}

	/** Answer `query`, start the queued request, then repaint if the answer changes what is shown. */
	async #run(backend: WordPredictionBackend, query: WordQuery): Promise<void> {
		this.#activeKey = query.key;
		const generation = this.#generation;
		let suffix: string | null;
		try {
			suffix = (await backend.complete(query.before, query.prefix)) || null;
		} catch (error) {
			logger.debug("word completion request failed", { error: String(error) });
			suffix = null;
		}
		if (this.#activeKey === query.key) this.#activeKey = undefined;
		const current = generation === this.#generation;
		if (current) {
			if (this.#cache.size >= CACHE_LIMIT) this.#cache.clear();
			this.#cache.set(query.key, suffix);
		}
		const queued = this.#queued;
		this.#queued = undefined;
		const next = queued && !this.#cache.has(queued.key) ? this.#backend() : undefined;
		if (queued && next) void this.#run(next, queued);
		const displayed = this.#displayed;
		if (current && displayed?.key === query.key && displayed.suffix !== (suffix ?? this.#project(query))) {
			this.onUpdate?.();
		}
	}
}
