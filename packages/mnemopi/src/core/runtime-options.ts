import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, ApiKey, DispatchHold, Model } from "@oh-my-pi/pi-ai";

export type MnemopiLlmCompletionTask = {
	kind: "memory-extraction";
	input: string;
};

export interface MnemopiLlmCompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
	task?: MnemopiLlmCompletionTask;
	/**
	 * The instance's {@link MnemopiRuntimeOptions.beforeDispatch}, for a
	 * completion that puts its own request on the wire: await it before the
	 * request's deadline starts, and give it to the request as its
	 * `beforeDispatch` so every attempt waits on it too.
	 */
	beforeDispatch?: DispatchHold;
}

export type MnemopiLlmCompletion = (
	prompt: string,
	opts?: MnemopiLlmCompleteOptions,
) => string | null | Promise<string | null>;

/**
 * What an embedding provider's `embed` returns: the embedding matrix streamed as async batches,
 * matching fastembed's `embed()` (`AsyncGenerator<number[][]>`). Each yielded batch is a list of
 * rows; each row is one number per dimension. Yield the whole matrix as a single batch when not
 * streaming: `async *embed(texts) { yield texts.map(embedOne); }`.
 */
export type EmbeddingOutput = AsyncIterable<number[][]>;

export interface MnemopiEmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export interface MnemopiEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: MnemopiEmbeddingProvider | ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>);
	/** Override `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS`. `0` disables the cap. See `config.embeddingMaxInputChars`. */
	maxInputChars?: number;
}

export interface MnemopiLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemopiLlmCompletion;
	/** Override the fact-extraction prompt template ({text}/{lang}). Used to feed small local models a friendlier format. */
	extractionPrompt?: string;
	/** Override the consolidation/sleep prompt template ({memories}/{source}/{memory_count}). */
	consolidationPrompt?: string;
}

export interface MnemopiRuntimeOptions {
	embeddings?: false | MnemopiEmbeddingRuntimeOptions;
	llm?: false | MnemopiLlmRuntimeOptions | Model<Api> | MnemopiLlmCompletion;
	/** Verbose diagnostics: escalates best-effort failure logs from debug to warn. */
	debug?: boolean;
	/**
	 * Awaited before every remote request the instance makes: each attempt at
	 * a completion or embedding endpoint, and each pi-ai model request. A
	 * custom completion receives it as {@link MnemopiLlmCompleteOptions.beforeDispatch}.
	 * A host that gates its requests holds them here; a rejection fails the
	 * request, which then degrades like any other failed remote call.
	 */
	beforeDispatch?: DispatchHold;
}

export interface ResolvedMnemopiEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: MnemopiEmbeddingProvider;
	maxInputChars?: number;
}

export interface ResolvedMnemopiLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemopiLlmCompletion;
	extractionPrompt?: string;
	consolidationPrompt?: string;
}

export interface ResolvedMnemopiRuntimeOptions {
	embeddings?: ResolvedMnemopiEmbeddingRuntimeOptions;
	llm?: ResolvedMnemopiLlmRuntimeOptions;
	debug?: boolean;
	beforeDispatch?: DispatchHold;
}

const runtimeOptionsStorage = new AsyncLocalStorage<ResolvedMnemopiRuntimeOptions>();

export function withMnemopiRuntimeOptions<T>(options: ResolvedMnemopiRuntimeOptions | undefined, fn: () => T): T {
	if (options === undefined) {
		return fn();
	}
	return runtimeOptionsStorage.run(options, fn);
}

export function getMnemopiRuntimeOptions(): ResolvedMnemopiRuntimeOptions | undefined {
	return runtimeOptionsStorage.getStore();
}

/** Whether the active runtime scope requested verbose diagnostics (`mnemopi.debug`). */
export function mnemopiDebugEnabled(): boolean {
	return runtimeOptionsStorage.getStore()?.debug === true;
}

/** The active runtime scope's dispatch hold, if its instance was given one. */
export function activeDispatchHold(): DispatchHold | undefined {
	return runtimeOptionsStorage.getStore()?.beforeDispatch;
}

export function resolveEmbeddingProvider(
	provider:
		| MnemopiEmbeddingProvider
		| ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>)
		| undefined,
): MnemopiEmbeddingProvider | undefined {
	if (provider === undefined) {
		return undefined;
	}
	if (typeof provider === "function") {
		return { embed: provider };
	}
	return provider;
}

export function isPiAiModel(value: unknown): value is Model<Api> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const maybe = value as Partial<Model<Api>>;
	return (
		typeof maybe.id === "string" &&
		typeof maybe.provider === "string" &&
		typeof maybe.baseUrl === "string" &&
		typeof maybe.api === "string"
	);
}
