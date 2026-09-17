/**
 * Resolves the {@link Judge} that answers a feature's typed judgments
 * (auto-thinking difficulty, Smart unexpected-stop detection, git AI staging,
 * the eval `judge()` helper).
 *
 * Backend precedence, governed by `providers.judgmentProvider`:
 *
 * 1. **TypeSafe Jev** (`jev`, or `auto` with a stored / env credential): the
 *    native System One API, keyed by `AuthStorage` so `/login jev` (or `/login typesafe`) and
 *    `TYPESAFE_API_KEY` both work and 401s rotate credentials.
 * 2. **Local on-device model** when the feature's backend setting names one:
 *    keyword prompts through the shared tiny-model worker.
 * 3. **Online chat bridge** (`online`): keyword prompts to the `tiny`/`smol`
 *    role chain, trying each retry-fallback candidate in turn so one dead
 *    model does not sink the judgment.
 */
import {
	type AssistantMessage,
	chatTextBackend,
	type Judge,
	type JudgeOptions,
	type Model,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	type TextBackend,
	type TextCompletion,
	type TextPrompt,
	TextJudge,
	TYPESAFE_PROVIDER,
	TypeSafeJudge,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { isTinyMemoryLocalModelKey, isTinyMemoryReasoningModelKey, ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { collectOnlineTinyCandidates } from "../tiny/online-candidates";
import localPromptTemplate from "../prompts/system/judgment-local.md" with { type: "text" };
import { tinyModelClient } from "../tiny/title-client";

/** Usage of one judgment attempt, recorded on the session ledger by callers. */
export interface JudgmentUsage {
	/** Model role the call resolved through (`tiny`, `smol`), or `typesafe`. */
	role: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
}

export interface JudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** Feature backend: {@link ONLINE_MEMORY_MODEL_KEY} for the chat chain, or a local model key. */
	backend: string;
	/** The session's active model: last resort of the chat chain after `tiny`, `smol`, and `default`. */
	sessionModel?: Model;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
}

/** One keyword per answer; OpenAI-compatible endpoints reject budgets below 16. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/** On-device reasoning models need room for the keyword after their `<think>` preamble. */
const LOCAL_REASONING_MAX_TOKENS = 1024;

/** Which backend a resolved judge routes to; callers tune question granularity on it. */
export type JudgeKind = "typesafe" | "local" | "online";

export interface ResolvedJudge extends Judge {
	readonly kind: JudgeKind;
}

/** Whether typed judgments currently go to TypeSafe rather than a chat/local model. */
export function usesTypeSafeJudge(settings: Settings, registry: ModelRegistry): boolean {
	const mode = settings.get("providers.judgmentProvider");
	if (mode === "llm") return false;
	return mode === "typesafe" || registry.authStorage.hasAuth(TYPESAFE_PROVIDER);
}

/**
 * Resolve the judge for a feature. With TypeSafe in front, a failed TypeSafe
 * call (network, 5xx after retries, rejected key) falls back to the LLM judge
 * the feature would otherwise use; only caller aborts propagate.
 */
export function resolveJudge(deps: JudgeDeps): ResolvedJudge {
	const configuredLlm = resolveLlmJudge(deps);
	if (!usesTypeSafeJudge(deps.settings, deps.registry)) return configuredLlm;
	// A native judgment failure always falls back to the online role chain,
	// never a feature's optional local-model override.
	const fallback = new OnlineChatJudge(deps);
	const typesafe = new TypeSafeJudge({
		apiKey: deps.registry.authStorage.resolver(TYPESAFE_PROVIDER, { sessionId: deps.sessionId }),
	});
	return {
		kind: "typesafe",
		label: typesafe.label,
		async judge(request, options) {
			try {
				const result = await typesafe.judge(request, options);
				deps.onUsage?.({
					role: TYPESAFE_PROVIDER,
					api: result.api,
					provider: result.provider,
					model: result.model,
					usage: result.usage,
					stopReason: "stop",
				});
				return result;
			} catch (error) {
				if (options?.signal?.aborted || AIError.is(AIError.classify(error), AIError.Flag.Abort)) throw error;
				logger.debug("judgment: TypeSafe failed; falling back to LLM judge", {
					error: error instanceof Error ? error.message : String(error),
					fallback: fallback.label,
				});
				return fallback.judge(request, options);
			}
		},
	};
}

function resolveLlmJudge(deps: JudgeDeps): ResolvedJudge {
	if (deps.backend !== ONLINE_MEMORY_MODEL_KEY) {
		if (!isTinyMemoryLocalModelKey(deps.backend)) {
			throw new Error(`judgment: unsupported local model: ${deps.backend}`);
		}
		return new LocalJudge(deps.backend);
	}
	return new OnlineChatJudge(deps);
}

/** Keyword judgments through the shared on-device tiny-model worker. */
class LocalJudge extends TextJudge implements ResolvedJudge {
	readonly kind = "local";

	constructor(modelKey: string) {
		super(new LocalTextBackend(modelKey));
	}
}

/** Keyword completions through the shared on-device tiny-model worker. */
class LocalTextBackend implements TextBackend {
	readonly api = "tiny-local";
	readonly provider = "local";
	readonly guardState = false;
	readonly model: string;
	readonly #reasoning: boolean;

	constructor(modelKey: string) {
		this.model = modelKey;
		this.#reasoning = isTinyMemoryLocalModelKey(modelKey) && isTinyMemoryReasoningModelKey(modelKey);
	}

	async complete(judgment: TextPrompt, options: JudgeOptions): Promise<TextCompletion> {
		// Sub-2B models answer a bare user message as a question (or echo the
		// system prompt); one turn that ends in `Answer:` keeps them classifying.
		const text = await tinyModelClient.complete(
			this.model,
			prompt.render(localPromptTemplate, { system: judgment.system, state: judgment.user }),
			{
				maxTokens: Math.max(LOCAL_ANSWER_MAX_TOKENS, this.#reasoning ? LOCAL_REASONING_MAX_TOKENS : 0),
				signal: options.signal,
			},
		);
		if (!text) throw new Error(`judgment: local model ${this.model} returned no output`);
		return { text };
	}
}

/**
 * Tries each candidate — `tiny`, `smol`, `default` (each with its retry-fallback
 * chain), then the session's active model — until one yields a parseable
 * answer. Credential and provider failures move on to the next candidate;
 * caller aborts propagate immediately.
 */
class OnlineChatJudge implements ResolvedJudge {
	readonly kind = "online";
	readonly label = "tiny/smol/default";
	readonly #deps: JudgeDeps;

	constructor(deps: JudgeDeps) {
		this.#deps = deps;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		const deps = this.#deps;
		const candidates = collectOnlineTinyCandidates(
			["tiny", "smol", "default"],
			deps.settings,
			deps.registry.getAvailable(),
			{ tryAllRoles: true },
		);
		const session = deps.sessionModel;
		if (session && !candidates.some(c => c.model.provider === session.provider && c.model.id === session.id)) {
			candidates.push({ role: "session", model: session });
		}
		if (candidates.length === 0) throw new Error("judgment: no tiny/smol/default model available");
		const signal = options.signal;
		let lastError: string | undefined;
		for (const { role, model } of candidates) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
			}
			try {
				const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
				if (!apiKey) {
					lastError = `no API key for ${model.provider}/${model.id}`;
					continue;
				}
				// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
				const metadata = deps.metadataResolver?.(model.provider);
				const backend = chatTextBackend(model, {
					apiKey: deps.registry.resolver(model, deps.sessionId),
					sessionId: deps.sessionId,
					metadata,
					onAttempt: attempt =>
						deps.onUsage?.({
							role,
							api: attempt.api,
							provider: attempt.provider,
							model: attempt.model,
							usage: attempt.usage,
							stopReason: attempt.stopReason,
							errorMessage: attempt.errorMessage,
						}),
				});
				return await new TextJudge(backend).judge(request, options);
			} catch (error) {
				if (signal?.aborted) {
					throw signal.reason instanceof Error
						? signal.reason
						: error instanceof Error
							? error
							: new AIError.AbortError("judgment aborted");
				}
				if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
		throw new Error(`judgment: every tiny/smol candidate failed: ${lastError ?? "unknown error"}`);
	}
}
