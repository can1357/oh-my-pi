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

interface WordQuery {
	key: string;
	before: string;
	prefix: string;
}

/** Editor text before the word starting at `start`, truncated to its last {@link BEFORE_LIMIT} code units. */
function textBefore(lines: readonly string[], cursorLine: number, start: number): string {
	let text = (lines[cursorLine] ?? "").slice(0, start);
	for (let line = cursorLine - 1; line >= 0 && text.length < BEFORE_LIMIT; line--) {
		text = `${lines[line] ?? ""}\n${text}`;
	}
	if (text.length <= BEFORE_LIMIT) return text;
	let cut = text.length - BEFORE_LIMIT;
	// Never start on the low half of a surrogate pair.
	const unit = text.charCodeAt(cut);
	if (unit >= 0xdc00 && unit <= 0xdfff) cut++;
	return text.slice(cut);
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
		// Engines exclude a word the user already typed past at a shorter prefix, so
		// typing through a shown ghost without Tab answers null; keep that ghost
		// until the engine offers something else.
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
		const line = lines[cursorLine] ?? "";
		if (WORD_CONTINUES.test(line.slice(cursorCol))) return undefined;
		// Single letters are asked too (`figure o|ut`); engines own their minimum prefix.
		const match = WORD_SUFFIX.exec(line.slice(0, cursorCol));
		if (!match) return undefined;
		const start = cursorCol - match[0].length;
		if (!isProseWord(line, maskNonProse(line), start, cursorCol)) return undefined;
		if (!this.#prose.isProse(lineContext(lines, cursorLine), start, cursorCol)) return undefined;
		const prefix = match[0];
		const before = textBefore(lines, cursorLine, start);
		// The method keeps a request still in flight for the previous engine from
		// shadowing the same word state on the new one.
		return { key: `${this.#method}\u0000${prefix}\u0000${before}`, before, prefix };
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
