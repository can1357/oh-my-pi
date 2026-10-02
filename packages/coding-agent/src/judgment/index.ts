/**
 * Resolves the {@link Judge} that answers typed judgments through the `judge`
 * model role. The chain is re-resolved at most every {@link CANDIDATE_TTL_MS}
 * so live catalog discovery, role edits, credential changes, and session
 * fallback all take effect without recreating feature consumers, while bulk
 * callers (`judge_batch`) do not re-scan the whole catalog per item.
 *
 * Every provider attempt is attributed exactly once: native System One
 * requests by {@link nativeJudge}, prompted chat attempts by the chat
 * backend's `onAttempt`. Each report reaches both {@link JudgeDeps.onUsage}
 * (the session ledger) and one `judgment` telemetry span, so a judgment backed
 * by a chat model is never billed again from its aggregated result.
 */
import {
	type AgentTelemetry,
	type AgentTelemetryConfig,
	recordJudgmentTelemetry,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core";
import {
	type Answer,
	type AssistantMessage,
	chatTextBackend,
	isJudgmentApi,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type Questions,
	type TextBackend,
	type TextCompletion,
	type TextPrompt,
	TextJudge,
	TYPESAFE_PROVIDER,
	TypeSafeJudge,
	tokenUsage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveRoleChain, type RoleChainCandidate } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import type { SessionManager } from "../session/session-manager";
import { getTinyLocalModelSpec } from "../tiny/models";
import localPromptTemplate from "../prompts/system/judgment-local.md" with { type: "text" };
import { tinyModelClient } from "../tiny/title-client";
import type { JudgmentCache } from "./cache";

export * from "./cache";

/** Usage of one billed judgment attempt, recorded on the session ledger by callers. */
export interface JudgmentUsage {
	/** Why the judgment ran; see {@link JudgeDeps.purpose}. */
	purpose: string;
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
	/** Why the judgment runs (`find`, `ttsr`, `judge_batch`, …); labels ledger entries and telemetry spans. */
	purpose: string;
	/**
	 * Receives every billed attempt exactly once — failed ones included, cache
	 * hits never. Wire {@link journalJudgmentUsage} here to bill the session.
	 */
	onUsage?: (usage: JudgmentUsage) => void;
	/** Host telemetry; every attempt, cache hits included, emits one `judgment` span. */
	telemetry?: AgentTelemetryConfig;
	/** Answer cache for native judgments; omitted runs every question against the provider. */
	cache?: JudgmentCache;
}

/**
 * One attempt as observed by a backend wrapper, before {@link ChainJudge}
 * stamps its purpose. `questions`/`cachedQuestions` are set by native
 * judgments, which consult the answer cache.
 */
interface JudgmentAttempt extends Omit<JudgmentUsage, "purpose"> {
	startedAt: number;
	responseModel?: string;
	questions?: number;
	cachedQuestions?: number;
}

/** Session journal surface that records off-transcript model cost; journal-only managers omit it. */
export type JudgmentUsageLedger = Pick<SessionManager, "appendModelUsage" | "getSessionId" | "getLeafId">;

function isUsageLedger(manager: Partial<JudgmentUsageLedger>): manager is JudgmentUsageLedger {
	return (
		manager.appendModelUsage !== undefined && manager.getSessionId !== undefined && manager.getLeafId !== undefined
	);
}

/**
 * Build a {@link JudgeDeps.onUsage} that journals every billed judgment attempt
 * as a `model_usage` entry beneath the session leaf at record time, so
 * `getSessionStats()` counts it in session totals. Attempts that land after
 * the session changes are dropped by the ledger. Returns `undefined` when the
 * journal cannot record usage.
 */
export function journalJudgmentUsage(manager: Partial<JudgmentUsageLedger> | undefined): JudgeDeps["onUsage"] {
	if (!manager || !isUsageLedger(manager)) return undefined;
	const sessionId = manager.getSessionId();
	return usage => {
		manager.appendModelUsage(usage, { sessionId, parentId: manager.getLeafId() });
	};
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
/**
 * How long a resolved role chain is reused. Resolution filters the full
 * catalog (thousands of models) synchronously — milliseconds per call, which a
 * concurrent fan-out turns into sustained event-loop stalls. The chain is
 * shared by every judge built over the same settings and registry, since
 * per-call consumers (auto-thinking, subagent starts) resolve a fresh judge.
 */
const CANDIDATE_TTL_MS = 1_000;
/** Skip-until timestamps keyed by routed model identity, carried by the registry that produced the rejection. */
const kRejections = Symbol("judgment.rejections");
/** Last resolved judge role chain, carried by the registry it was drawn from. */
const kRoleChain = Symbol("judgment.roleChain");
interface RegistryWithRejections extends ModelRegistry {
	[kRejections]?: Map<string, number>;
	[kRoleChain]?: { settings: Settings; list: RoleChainCandidate[]; expiresAt: number };
}

/** {@link judgeRoleChain}, reused for {@link CANDIDATE_TTL_MS} across judges over the same settings and registry. */
function cachedJudgeRoleChain(settings: Settings, registry: RegistryWithRejections): RoleChainCandidate[] {
	const now = Date.now();
	const cached = registry[kRoleChain];
	if (cached && cached.settings === settings && now < cached.expiresAt) return cached.list;
	const list = judgeRoleChain(settings, registry);
	registry[kRoleChain] = { settings, list, expiresAt: now + CANDIDATE_TTL_MS };
	return list;
}

/** Append the session model when no candidate is native and the chain does not already route to it. */
function withSessionFallback(candidates: RoleChainCandidate[], sessionModel: Model | undefined): RoleChainCandidate[] {
	if (!sessionModel || candidates.some(candidate => kindOf(candidate) === "native")) return candidates;
	const sessionIdentity = formatModelStringWithRouting(sessionModel);
	if (candidates.some(candidate => formatModelStringWithRouting(candidate.model) === sessionIdentity)) {
		return candidates;
	}
	return [...candidates, { model: sessionModel, explicit: false }];
}

/** Which backend a judge-role candidate routes to: native System One decisions, on-device keywords, or a chat model. */
export type JudgeKind = "native" | "local" | "online";

/** Classify a role candidate by model API, never by provider identity. */
export function kindOf(candidate: RoleChainCandidate): JudgeKind;
export function kindOf(model: Model): JudgeKind;
export function kindOf(value: RoleChainCandidate | Model): JudgeKind {
	const model = "model" in value ? value.model : value;
	if (isJudgmentApi(model.api)) return "native";
	if (model.api === "local-inference") return "local";
	return "online";
}

/**
 * The `judge` role's candidates in attempt order, drawn from credentialed
 * judge-capable models. From the first native candidate on, only native
 * candidates remain: a prompted model never stands in for a failed native
 * judgment, whose calibrated probabilities it cannot reproduce.
 */
function judgeRoleChain(settings: Settings, registry: ModelRegistry): RoleChainCandidate[] {
	const chain = resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, registry));
	const firstNative = chain.findIndex(candidate => kindOf(candidate) === "native");
	if (firstNative < 0) return chain;
	return chain.filter((candidate, index) => index < firstNative || kindOf(candidate) === "native");
}

/**
 * Whether the `judge` role resolves first to a native System One backend
 * (TypeSafe jev, directly or through OpenRouter) rather than a prompted
 * on-device or chat model. Judge-heavy features gate on it, e.g. the `find`
 * tool under `find.enabled: auto`.
 */
export function hasNativeJudge(settings: Settings, registry: ModelRegistry): boolean {
	const [primary] = judgeRoleChain(settings, registry);
	return primary !== undefined && kindOf(primary) === "native";
}

/** Resolve a live judge-role chain. Candidates resolve lazily and are reused for {@link CANDIDATE_TTL_MS}. */
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
	readonly #telemetry: AgentTelemetry | undefined;
	#candidates: { chain: RoleChainCandidate[]; list: RoleChainCandidate[] } | undefined;

	constructor(deps: JudgeDeps) {
		this.#deps = deps;
		this.#telemetry = resolveTelemetry(deps.telemetry, deps.sessionId);
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		return this.withCandidate(candidate => candidate.judge(request, options), options);
	}

	/**
	 * Model of the first judge-role candidate, i.e. the one a judgment routes to
	 * when it is credentialed and healthy. Used to price work before running it;
	 * undefined when no candidate resolves.
	 */
	primaryModel(): Model | undefined {
		return this.#resolveCandidates()[0]?.model;
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
				const rejected = isAccountRejection(error);
				if (rejected) rejections.set(identity, Date.now() + CANDIDATE_REJECTION_COOLDOWN_MS);
				lastFailure = error instanceof Error ? error.message : String(error);
				logger.warn("judgment candidate failed", {
					candidate: identity,
					status: AIError.status(error),
					error: lastFailure,
					skippedForMs: rejected ? CANDIDATE_REJECTION_COOLDOWN_MS : undefined,
				});
			}
		}
		if (candidates.length === 0) throw new Error("judgment: no judge model available");
		throw new Error(`judgment: every judge candidate failed: ${lastFailure ?? lastUnavailable ?? "unknown error"}`);
	}

	/** Attribute one attempt: the ledger unless answered wholly from cache, and one telemetry span. */
	#report(attempt: JudgmentAttempt): void {
		const { startedAt, responseModel, questions, cachedQuestions, ...rest } = attempt;
		const usage: JudgmentUsage = { purpose: this.#deps.purpose, ...rest };
		if (questions === undefined || cachedQuestions !== questions) this.#deps.onUsage?.(usage);
		recordJudgmentTelemetry(this.#telemetry, {
			provider: usage.provider,
			model: usage.model,
			responseModel,
			purpose: usage.purpose,
			usage: usage.usage,
			stopReason: usage.stopReason,
			errorMessage: usage.errorMessage,
			startTime: startedAt,
			questions,
			cachedQuestions,
		}).catch(error => logger.warn("judgment telemetry failed", { error: String(error) }));
	}

	#rejections(): Map<string, number> {
		const registry: RegistryWithRejections = this.#deps.registry;
		return (registry[kRejections] ??= new Map());
	}

	#resolveCandidates(): RoleChainCandidate[] {
		const { settings, registry, sessionModel } = this.#deps;
		const candidates = cachedJudgeRoleChain(settings, registry);
		if (candidates === this.#candidates?.chain) return this.#candidates.list;
		const list = withSessionFallback(candidates, sessionModel);
		this.#candidates = { chain: candidates, list };
		return list;
	}

	async #createJudge(candidate: RoleChainCandidate, signal: AbortSignal | undefined): Promise<Judge | undefined> {
		const model = candidate.model;
		if (model.api === "local-inference") return new TextJudge(new LocalTextBackend(model.id));
		if (!(await this.#deps.registry.getApiKey(model, this.#deps.sessionId, { signal }))) return undefined;
		const apiKey = this.#deps.registry.resolver(model, this.#deps.sessionId);
		if (isJudgmentApi(model.api)) {
			const headers = await this.#deps.registry.resolveModelHeaders(model, signal);
			const judge = new TypeSafeJudge({
				apiKey,
				api: model.api,
				provider: model.provider,
				model: model.id,
				baseUrl: model.baseUrl,
				headers,
				judgment: model.judgment,
			});
			return nativeJudge(judge, model, this.#deps.cache, attempt => this.#report(attempt));
		}
		// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
		const metadata = this.#deps.metadataResolver?.(model.provider);
		const backend = chatTextBackend(model, {
			apiKey,
			sessionId: this.#deps.sessionId,
			metadata,
			// Sole attribution point for prompted judgments: TextJudge's result.usage
			// aggregates these same attempts and must never be billed again.
			onAttempt: attempt =>
				this.#report({
					role: "judge",
					api: attempt.api,
					provider: attempt.provider,
					model: attempt.model,
					usage: attempt.usage,
					stopReason: attempt.stopReason,
					errorMessage: attempt.errorMessage,
					startedAt: attempt.timestamp,
				}),
		});
		return new TextJudge(backend);
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

/**
 * Native System One judge. Questions already answered about the same state
 * under this model come from `cache`; only the rest reach the provider (none
 * when every answer is cached). Each call reports exactly one attempt — failed
 * requests included so the ledger shows why a judgment errored. TypeSafe
 * reports tokens only, so a response without a billed amount is priced from
 * the catalog model; a route that bills (OpenRouter) keeps its reported cost.
 */
function nativeJudge(
	judge: TypeSafeJudge,
	model: Model,
	cache: JudgmentCache | undefined,
	report: (attempt: JudgmentAttempt) => void,
): Judge {
	const cacheModel = `${model.provider}/${model.id}`;
	return {
		label: judge.label,
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			const startedAt = Date.now();
			const cached = cache?.lookup(cacheModel, request);
			const known = cached?.answers ?? {};
			const pending: Questions = {};
			let questions = 0;
			let pendingCount = 0;
			for (const id in request.questions) {
				questions++;
				if (known[id] !== undefined) continue;
				pending[id] = request.questions[id];
				pendingCount++;
			}
			const attempt = {
				role: TYPESAFE_PROVIDER,
				api: judge.api,
				provider: judge.provider,
				model: judge.model,
				startedAt,
				questions,
				cachedQuestions: questions - pendingCount,
			};
			let fresh: JudgmentResult | undefined;
			if (pendingCount > 0 || questions === 0) {
				try {
					fresh = await judge.judge({ state: request.state, questions: pending }, options);
				} catch (error) {
					report({
						...attempt,
						usage: tokenUsage(0, 0),
						stopReason: isAbortOrTimeout(error) ? "aborted" : "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
				if (fresh.usage.cost.total === 0) calculateCost(model, fresh.usage);
				if (cache && cached) cache.record(cacheModel, cached, pending, fresh);
			}
			const usage = fresh?.usage ?? tokenUsage(0, 0);
			report({ ...attempt, usage, stopReason: "stop", responseModel: fresh?.model });
			const answers: Record<string, Answer> = {};
			for (const id in request.questions) {
				const answer = known[id] ?? fresh?.answers[id];
				if (answer) answers[id] = answer;
			}
			return {
				api: judge.api,
				provider: judge.provider,
				model: fresh?.model ?? judge.model,
				// Every id was answered by the cache or by `fresh`, which TypeSafeJudge validated per question type.
				answers: answers as JudgmentResult<Q>["answers"],
				usage,
			};
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
