/** Provider-pool dispatch with target-scoped authentication and pre-output failover. */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@pk-nerdsaver-ai/pi-ai";
import { status } from "@pk-nerdsaver-ai/pi-ai/error/flags";
import { isProviderRetryableError, isTransientStatus } from "@pk-nerdsaver-ai/pi-ai/error/retryable";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import type { Usage } from "@pk-nerdsaver-ai/pi-catalog/types";
import type { ModelPoolManager } from "./pool-manager";
import type { ResolvedModelPool } from "./types";

export function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createErrorMessage(model: Model, error: unknown, aborted = false): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		errorStatus: status(error),
		timestamp: Date.now(),
	};
}

function terminalEvent(message: AssistantMessage): AssistantMessageEvent {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return { type: "error", reason: message.stopReason, error: message };
	}
	return { type: "done", reason: message.stopReason, message };
}

export type StreamFunction = (
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export class FastStreamRouter {
	readonly #poolManager: ModelPoolManager;
	readonly #getApiKey: (model: Model) => SimpleStreamOptions["apiKey"];

	constructor(poolManager: ModelPoolManager, getApiKey: (model: Model) => SimpleStreamOptions["apiKey"]) {
		this.#poolManager = poolManager;
		this.#getApiKey = getApiKey;
	}

	get poolManager(): ModelPoolManager {
		return this.#poolManager;
	}

	/** Check whether an error represents a recoverable capacity, rate-limit, or quota condition. */
	static isFailoverRecoverable(error: unknown): boolean {
		if (!error || (error instanceof Error && error.name === "AbortError")) return false;
		const httpStatus = status(error);
		if (isTransientStatus(httpStatus)) return true;
		// A definitive client/auth error must not be overridden by incidental capacity wording.
		if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) return false;

		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			if (
				msg.includes("rate limit") ||
				msg.includes("quota") ||
				msg.includes("capacity") ||
				msg.includes("overloaded") ||
				msg.includes("busy") ||
				msg.includes("too many requests") ||
				msg.includes("resource exhausted")
			) {
				return true;
			}
			return isProviderRetryableError(error);
		}
		return false;
	}

	/** Estimate current context token count for context-limit checks. */
	static estimateContextTokens(context: Context): number {
		let totalChars = 0;
		if (context.systemPrompt) totalChars += context.systemPrompt.length;
		for (const msg of context.messages) {
			if (typeof msg.content === "string") {
				totalChars += msg.content.length;
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if ("text" in part && typeof part.text === "string") {
						totalChars += part.text.length;
					}
				}
			}
		}
		return Math.ceil(totalChars / 4);
	}

	streamWithRouting(
		requestedModel: Model,
		context: Context,
		options: SimpleStreamOptions | undefined,
		pool: ResolvedModelPool | null,
		dispatchStream: StreamFunction,
		sessionId?: string,
	): AssistantMessageEventStream {
		if (!this.#poolManager.isEnabled || !pool || pool.candidates.length <= 1) {
			return dispatchStream(requestedModel, context, options);
		}

		const outputStream = new AssistantMessageEventStream();
		const contextTokens = FastStreamRouter.estimateContextTokens(context);
		const initialTarget = this.#poolManager.selectTarget(pool, {
			sessionId,
			currentContextTokens: contextTokens,
			preferredModel: requestedModel,
		});
		const candidates = [
			initialTarget,
			...pool.candidates.filter(c => `${c.provider}/${c.id}` !== `${initialTarget.provider}/${initialTarget.id}`),
		];

		void (async () => {
			let lastFailure: AssistantMessageEvent | undefined;

			candidateLoop: for (const candidate of candidates) {
				if (options?.signal?.aborted) {
					outputStream.push(terminalEvent(createErrorMessage(candidate, options.signal.reason, true)));
					outputStream.end();
					return;
				}
				const window = candidate.contextWindow ?? 0;
				if (contextTokens > 0 && window > 0 && window < contextTokens) continue;

				let replayUnsafe = false;
				const buffered: AssistantMessageEvent[] = [];
				const flush = () => {
					for (const event of buffered) outputStream.push(event);
					buffered.length = 0;
				};
				const accept = (event: AssistantMessageEvent): "continue" | "retry" | "terminal" => {
					if (options?.signal?.aborted) {
						event = terminalEvent(createErrorMessage(candidate, options.signal.reason, true));
					}
					// Providers can emit start before their HTTP request succeeds. Hide only
					// empty setup events; text, thinking, and tool-call events commit this attempt.
					if (!replayUnsafe && event.type === "start" && event.partial.content.length === 0) {
						buffered.push(event);
						return "continue";
					}
					if (event.type === "error") {
						const error = Object.assign(new Error(event.error.errorMessage ?? "Provider stream failed"), {
							status: event.error.errorStatus,
						});
						if (
							event.reason !== "aborted" &&
							!options?.signal?.aborted &&
							FastStreamRouter.isFailoverRecoverable(error)
						) {
							this.#poolManager.markFailure(candidate, error);
							if (!replayUnsafe && event.error.content.length === 0) {
								lastFailure = event;
								return "retry";
							}
						}
					}
					flush();
					replayUnsafe = true;
					outputStream.push(event);
					if (event.type === "done" || event.type === "error") {
						if (event.type === "done") this.#poolManager.markSuccess(candidate);
						outputStream.end();
						return "terminal";
					}
					return "continue";
				};

				try {
					const isRequestedTarget =
						candidate.provider === requestedModel.provider &&
						candidate.id === requestedModel.id &&
						candidate.baseUrl === requestedModel.baseUrl &&
						candidate.api === requestedModel.api &&
						candidate.transport === requestedModel.transport;
					// The loop's key (including a seeded OAuth resolver), caller headers,
					// and account metadata belong to the original endpoint. Model-defined
					// headers remain on the candidate; streamSimple resolves its fresh key.
					const candidateOptions = isRequestedTarget
						? options
						: {
								...options,
								apiKey: this.#getApiKey(candidate),
								headers: undefined,
								metadata: undefined,
							};
					const stream = dispatchStream(candidate, context, candidateOptions);
					for await (const event of stream) {
						const result = accept(event);
						if (result === "retry") continue candidateLoop;
						if (result === "terminal") return;
					}
					// Some transports end with a result instead of emitting a terminal event.
					if (accept(terminalEvent(await stream.result())) === "retry") continue;
					return;
				} catch (error) {
					const aborted = options?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
					const failure = terminalEvent(createErrorMessage(candidate, error, aborted));
					if (!aborted && FastStreamRouter.isFailoverRecoverable(error)) {
						this.#poolManager.markFailure(candidate, error);
						if (!replayUnsafe) {
							lastFailure = failure;
							continue;
						}
					}
					flush();
					outputStream.push(failure);
					outputStream.end();
					return;
				}
			}

			outputStream.push(
				lastFailure ??
					terminalEvent(
						createErrorMessage(
							requestedModel,
							`All providers in pool "${pool.name}" were exhausted or failed context checks.`,
						),
					),
			);
			outputStream.end();
		})().catch(error => {
			outputStream.push(terminalEvent(createErrorMessage(requestedModel, error, options?.signal?.aborted)));
			outputStream.end();
		});

		return outputStream;
	}
}
