/**
 * Resolves the {@link Judge} that answers typed judgments through the `judge`
 * model role. The chain is rebuilt for every call so live catalog discovery,
 * role edits, credential changes, and session fallback all take effect without
 * recreating feature consumers.
 */
import {
	type AssistantMessage,
	chatTextBackend,
	isSystemOneApi,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type Questions,
	type SystemOneApi,
	type TextBackend,
	type TextCompletion,
	type TextPrompt,
	TextJudge,
	TYPESAFE_PROVIDER,
	TypeSafeJudge,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveRoleChain, type RoleChainCandidate } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { getTinyLocalModelSpec } from "../tiny/models";
import localPromptTemplate from "../prompts/system/judgment-local.md" with { type: "text" };
import { tinyModelClient } from "../tiny/title-client";

/** Usage of one judgment attempt, recorded on the session ledger by callers. */
export interface JudgmentUsage {
	/** Model role the call resolved through, or `typesafe` for native judgments. */
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
	/** The session's active model, appended when the judge role does not already route to it. */
	sessionModel?: Model;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
}

/** One keyword per answer; OpenAI-compatible endpoints reject budgets below 16. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/** On-device reasoning models need room for the keyword after their `<think>` preamble. */
const LOCAL_REASONING_MAX_TOKENS = 1024;

/**
 * How long a candidate stays skipped after its account rejected a judgment
 * outright (401/403 credential, 402 billing cap). Every judgment rebuilds the
 * chain, so without this each call re-pays the rejected request plus a
 * credential-rotation round trip before reaching the next candidate.
 */
const CANDIDATE_REJECTION_COOLDOWN_MS = 5 * 60 * 1000;
/** Skip-until timestamps keyed by routed model identity, carried by the registry that produced the rejection. */
const kRejections = Symbol("judgment.rejections");
interface RegistryWithRejections extends ModelRegistry {
	[kRejections]?: Map<string, number>;
}

/** Which backend a judge-role candidate routes to. */
export type JudgeKind = "typesafe" | "local" | "online";

/** Classify a role candidate by model API, never by provider identity. */
export function kindOf(candidate: RoleChainCandidate): JudgeKind;
export function kindOf(model: Model): JudgeKind;
export function kindOf(value: RoleChainCandidate | Model): JudgeKind {
	const model = "model" in value ? value.model : value;
	if (isSystemOneApi(model.api)) return "typesafe";
	if (model.api === "local-inference") return "local";
	return "online";
}

/** Resolve a live judge-role chain. Candidate resolution remains lazy per judgment call. */
export function resolveJudge(deps: JudgeDeps): ChainJudge {
	return new ChainJudge(deps);
}

/**
 * Judge facade that falls through the live `judge` role chain. `withCandidate`
 * lets a caller choose candidate-specific questions while retaining the exact
 * same credential, failure, timeout, and abort semantics as ordinary `judge`.
 */
export class ChainJudge implements Judge {
	readonly label = "judge role chain";
	readonly #deps: JudgeDeps;

	constructor(deps: JudgeDeps) {
		this.#deps = deps;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		return this.withCandidate(candidate => candidate.judge(request, options), options);
	}

	async withCandidate<T>(run: (judge: Judge, kind: JudgeKind) => Promise<T>, options: JudgeOptions = {}): Promise<T> {
		const signal = options.signal;
		let lastFailure: string | undefined;
		let lastUnavailable: string | undefined;
		const candidates = this.#resolveCandidates();
		const rejections = this.#rejections();
		for (const candidate of candidates) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
			}
			const identity = formatModelStringWithRouting(candidate.model);
			const skippedUntil = rejections.get(identity);
			if (skippedUntil !== undefined) {
				if (skippedUntil > Date.now()) {
					lastUnavailable = `${identity} rejected the account recently`;
					continue;
				}
				rejections.delete(identity);
			}
			try {
				const judge = await this.#createJudge(candidate, signal);
				if (!judge) {
					lastUnavailable = `no API key for ${candidate.model.provider}/${candidate.model.id}`;
					continue;
				}
				return await run(judge, kindOf(candidate));
			} catch (error) {
				if (signal?.aborted) {
					throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
				}
				if (isAbortOrTimeout(error)) throw error;
				if (isAccountRejection(error)) rejections.set(identity, Date.now() + CANDIDATE_REJECTION_COOLDOWN_MS);
				lastFailure = error instanceof Error ? error.message : String(error);
			}
		}
		if (candidates.length === 0) throw new Error("judgment: no judge model available");
		throw new Error(`judgment: every judge candidate failed: ${lastFailure ?? lastUnavailable ?? "unknown error"}`);
	}

	#rejections(): Map<string, number> {
		const registry: RegistryWithRejections = this.#deps.registry;
		return (registry[kRejections] ??= new Map());
	}

	#resolveCandidates(): RoleChainCandidate[] {
		const { settings, registry, sessionModel } = this.#deps;
		const candidates = resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, registry));
		if (!sessionModel) return candidates;
		const sessionIdentity = formatModelStringWithRouting(sessionModel);
		if (candidates.some(candidate => formatModelStringWithRouting(candidate.model) === sessionIdentity)) {
			return candidates;
		}
		return [...candidates, { model: sessionModel, explicit: false }];
	}

	async #createJudge(candidate: RoleChainCandidate, signal: AbortSignal | undefined): Promise<Judge | undefined> {
		const model = candidate.model;
		switch (kindOf(candidate)) {
			case "typesafe": {
				if (!(await this.#deps.registry.getApiKey(model, this.#deps.sessionId, { signal }))) return undefined;
				// `kindOf` admitted only System One apis to this arm.
				const api = model.api as SystemOneApi;
				const judge = new TypeSafeJudge({
					apiKey: this.#deps.registry.resolver(model, this.#deps.sessionId),
					api,
					model: model.id,
					baseUrl: model.baseUrl,
				});
				return usageReportingTypeSafeJudge(judge, this.#deps.onUsage);
			}
			case "local":
				return new TextJudge(new LocalTextBackend(model.id));
			case "online": {
				if (!(await this.#deps.registry.getApiKey(model, this.#deps.sessionId, { signal }))) return undefined;
				// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
				const metadata = this.#deps.metadataResolver?.(model.provider);
				const backend = chatTextBackend(model, {
					apiKey: this.#deps.registry.resolver(model, this.#deps.sessionId),
					sessionId: this.#deps.sessionId,
					metadata,
					onAttempt: attempt =>
						this.#deps.onUsage?.({
							role: "judge",
							api: attempt.api,
							provider: attempt.provider,
							model: attempt.model,
							usage: attempt.usage,
							stopReason: attempt.stopReason,
							errorMessage: attempt.errorMessage,
						}),
				});
				return new TextJudge(backend);
			}
		}
	}
}

/** Keyword completions through the shared on-device tiny-model worker. */
class LocalTextBackend implements TextBackend {
	readonly api = "local-inference";
	readonly provider = "local";
	readonly guardState = false;
	readonly model: string;
	readonly #reasoning: boolean;

	constructor(modelId: string) {
		this.model = modelId;
		this.#reasoning = getTinyLocalModelSpec(modelId)?.reasoning === true;
	}

	async complete(judgment: TextPrompt, options: JudgeOptions): Promise<TextCompletion> {
		// Sub-2B models answer a bare user message as a question (or echo the
		// system prompt); one merged turn ending in `Answer:` keeps them classifying.
		const text = await tinyModelClient.complete(
			this.model,
			prompt.render(localPromptTemplate, { system: judgment.system, state: judgment.user }),
			{
				maxTokens: this.#reasoning ? LOCAL_REASONING_MAX_TOKENS : LOCAL_ANSWER_MAX_TOKENS,
				signal: options.signal,
			},
		);
		if (!text) throw new Error(`judgment: local model ${this.model} returned no output`);
		return { text };
	}
}

function usageReportingTypeSafeJudge(judge: TypeSafeJudge, onUsage: JudgeDeps["onUsage"]): Judge {
	return {
		label: judge.label,
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			const result = await judge.judge(request, options);
			onUsage?.({
				role: TYPESAFE_PROVIDER,
				api: result.api,
				provider: result.provider,
				model: judge.model,
				usage: result.usage,
				stopReason: "stop",
			});
			return result;
		},
	};
}

/** Credential or billing rejection: the account cannot serve this candidate until something changes out of band. */
function isAccountRejection(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 401 || status === 402 || status === 403;
}

function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
