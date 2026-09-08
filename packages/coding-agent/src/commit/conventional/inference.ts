import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { toReasoningEffort } from "../../thinking";
import type { ResolvedCommitModel } from "../model-selection";
import { type CommitInferenceCache, computeCommitCacheKey } from "./cache";
import type { ConventionalGenerationConfig } from "./config";
import type { ConventionalPromptFamily } from "./prompts";

/** Model roles preserved from llm-git's analysis/summary/map/fast pipeline. */
export type CommitInferenceRole = "analysis" | "summary" | "map" | "fast";

/** One fully rendered inference operation. */
export interface CommitInferenceRequest {
	operation: string;
	role: CommitInferenceRole;
	promptFamily: ConventionalPromptFamily;
	systemPrompt: string;
	userPrompt: string;
	toolName: string;
	progressLabel: string;
	cacheable?: boolean;
}

/** Raw text and stop metadata passed to operation-specific parsers. */
export interface CommitInferenceResponse {
	text: string;
	stopReason: string;
}

/** Parser-aware inference boundary so malformed responses share the normal retry budget. */
export interface CommitInference {
	complete<T>(request: CommitInferenceRequest, parse: (response: CommitInferenceResponse) => T): Promise<T>;
}

/** User-visible phase updates emitted during generation. */
export type CommitProgress = (message: string) => void;

interface InferenceTarget {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
}

/** Omp's model/provider adapter for llm-git's parser-aware one-shot algorithm. */
export class OmpCommitInference implements CommitInference {
	readonly #targets: Record<CommitInferenceRole, InferenceTarget>;
	readonly #config: ConventionalGenerationConfig;
	readonly #cache: CommitInferenceCache | null;
	readonly #authStorage: AuthStorage | null;
	readonly #onProgress?: CommitProgress;
	readonly #signal?: AbortSignal;
	readonly #sessionId = Bun.randomUUIDv7();

	constructor(options: {
		primary: ResolvedCommitModel;
		smol: ResolvedCommitModel;
		forcePrimaryForEveryRole?: boolean;
		config: ConventionalGenerationConfig;
		cache: CommitInferenceCache | null;
		/** Closed on dispose; broker-backed storage runs a background sync loop that pins the event loop. */
		authStorage?: AuthStorage;
		onProgress?: CommitProgress;
		signal?: AbortSignal;
	}) {
		const secondary = options.forcePrimaryForEveryRole ? options.primary : options.smol;
		this.#targets = {
			analysis: options.primary,
			summary: secondary,
			map: secondary,
			fast: secondary,
		};
		this.#config = options.config;
		this.#cache = options.cache;
		this.#authStorage = options.authStorage ?? null;
		this.#onProgress = options.onProgress;
		this.#signal = options.signal;
	}

	/** Run one request with cache lookup, parse validation, and exponential retries. */
	async complete<T>(request: CommitInferenceRequest, parse: (response: CommitInferenceResponse) => T): Promise<T> {
		const target = this.#targets[request.role];
		const modelKey = `${target.model.provider}/${target.model.id}`;
		const reasoning = toReasoningEffort(target.thinkingLevel);
		const key = computeCommitCacheKey({
			operation: request.operation,
			model: modelKey,
			apiMode: target.model.api,
			toolName: request.toolName,
			systemPrompt: request.systemPrompt,
			userPrompt: request.userPrompt,
			reasoningEffort: reasoning,
		});
		if (request.cacheable !== false) {
			const cached = this.#cache?.get(key);
			if (cached) {
				try {
					const parsed = parse({ text: cached.text, stopReason: cached.stopReason });
					this.#onProgress?.(`Cache hit: ${request.progressLabel}`);
					return parsed;
				} catch {}
			}
		}

		const requestJson = JSON.stringify({
			model: modelKey,
			system: request.systemPrompt,
			user: request.userPrompt,
			reasoning,
		});
		let lastError: Error | undefined;
		for (let attempt = 1; attempt <= Math.max(1, this.#config.maxRetries); attempt += 1) {
			this.#signal?.throwIfAborted();
			let responseText = "";
			try {
				this.#onProgress?.(request.progressLabel);
				const timeout = AbortSignal.timeout(120_000);
				const signal = this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout;
				const message = await completeSimple(
					target.model,
					{
						systemPrompt: request.systemPrompt.trim() ? [request.systemPrompt] : undefined,
						messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
					},
					{
						apiKey: target.apiKey,
						sessionId: this.#sessionId,
						maxTokens: 16_384,
						reasoning,
						signal,
					},
				);
				responseText = extractAssistantText(message);
				if (message.stopReason === "error") throw new Error(message.errorMessage ?? "Provider error");
				if (!responseText.trim()) throw new Error("Empty model response");
				const raw = { text: responseText, stopReason: message.stopReason };
				const parsed = parse(raw);
				if (request.cacheable !== false) {
					this.#cache?.put({
						key,
						model: modelKey,
						operation: request.operation,
						request: requestJson,
						response: {
							text: responseText,
							stopReason: message.stopReason,
							costUsd: message.usage.cost.total,
						},
					});
				}
				this.#cache?.recordUsage(modelKey, request.operation, message.usage);
				return parsed;
			} catch (error) {
				this.#signal?.throwIfAborted();
				lastError = error instanceof Error ? error : new Error(String(error));
				this.#cache?.putFailure({
					key,
					model: modelKey,
					operation: request.operation,
					request: requestJson,
					response: responseText,
					error: lastError.message,
				});
				if (attempt < this.#config.maxRetries) {
					await Bun.sleep(Math.max(0, this.#config.initialBackoffMs) * 2 ** (attempt - 1));
				}
			}
		}
		throw lastError ?? new Error(`Max retries exceeded for ${request.operation}`);
	}

	/** Release the cache and auth-storage handles after generation completes. */
	dispose(): void {
		this.#cache?.close();
		this.#authStorage?.close();
	}
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}
