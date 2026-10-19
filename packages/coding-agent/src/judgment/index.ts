/**
 * Resolves the {@link Judge} that answers typed judgments through the `judge`
 * model role. The chain is re-resolved at most every {@link CANDIDATE_TTL_MS}
 * so live catalog discovery, role edits, credential changes, and session
 * fallback all take effect without recreating feature consumers, while bulk
 * callers (`judge_batch`) do not re-scan the whole catalog per item.
 *
 * Every provider attempt is attributed exactly once: native judgment
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
	type BoxEdges,
	chatTextBackend,
	checkBoxQuestions,
	createNativeJudge,
	type ImageContent,
	isJudgmentApi,
	nativeJudgmentAcceptsImages,
	nativeJudgmentImageBounds,
	nativeJudgmentSupportsBoxes,
	nativeJudgmentSupportsImages,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type NativeJudge,
	type Question,
	type Questions,
	type TextBackend,
	type TextCompletion,
	type TextPrompt,
	TextJudge,
	TYPESAFE_PROVIDER,
	tokenUsage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isEmbeddedImageContent } from "@oh-my-pi/pi-ai/images/shared";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { normalizeModelContextImages } from "../utils/image-loading";
import { type FittedImage, fitImage } from "../utils/image-resize";
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
	[kRoleChain]?: {
		settings: Settings;
		revision: number;
		roleChain: RoleChainCandidate[];
		list: RoleChainCandidate[];
		expiresAt: number;
	};
}

/**
 * The resolved `judge` role chain and its text {@link judgeRoleChain}, reused for {@link CANDIDATE_TTL_MS}
 * across judges over the same settings and registry. A settings change (e.g. a new judge role) resolves
 * afresh; registry or credential changes still wait out the TTL, so {@link hasNativeJudge} (uncached) can
 * briefly see a different chain after a login or discovery change.
 */
function cachedJudgeRoleChain(
	settings: Settings,
	registry: RegistryWithRejections,
): { roleChain: RoleChainCandidate[]; list: RoleChainCandidate[] } {
	const now = Date.now();
	const revision = settings.revision;
	const cached = registry[kRoleChain];
	if (cached && cached.settings === settings && cached.revision === revision && now < cached.expiresAt) {
		return cached;
	}
	const roleChain = resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, registry));
	const entry = {
		settings,
		revision,
		roleChain,
		list: textJudgeRoleChain(roleChain),
		expiresAt: now + CANDIDATE_TTL_MS,
	};
	registry[kRoleChain] = entry;
	return entry;
}

/** Append a compatible session model when no candidate is native and the chain does not already route to it. */
function withSessionFallback(
	candidates: RoleChainCandidate[],
	sessionModel: Model | undefined,
	requiresImages = false,
): RoleChainCandidate[] {
	if (
		!sessionModel ||
		candidates.some(candidate => kindOf(candidate) === "native") ||
		(requiresImages && !supportsImageJudgment(sessionModel))
	) {
		return candidates;
	}
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

/** Whether the model's actual judgment transport sends image input. */
function supportsImageJudgment(model: Model): boolean {
	switch (kindOf(model)) {
		case "native":
			return nativeJudgmentSupportsImages(model);
		case "local":
			return false;
		case "online":
			return sendsImageInputOnWire(model);
	}
}

/**
 * The `judge` role's candidates in attempt order, drawn from credentialed
 * judge-capable models. From the first native candidate on, only native
 * candidates remain: a prompted model never stands in for a failed native
 * judgment, whose calibrated probabilities it cannot reproduce.
 */
function textJudgeRoleChain(chain: RoleChainCandidate[]): RoleChainCandidate[] {
	const firstNative = chain.findIndex(candidate => kindOf(candidate) === "native");
	if (firstNative < 0) return chain;
	return chain.filter((candidate, index) => index < firstNative || kindOf(candidate) === "native");
}

/**
 * Filter candidates that cannot take `images` before applying the native-only tail policy. A native
 * judge gets each image fitted into its bounds ({@link fitNativeImages}), so only its image support and
 * count cap decide; prompted chat models normalize images per model, so their image support alone decides.
 */
function imageJudgeRoleChain(chain: RoleChainCandidate[], images: readonly ImageContent[]): RoleChainCandidate[] {
	return textJudgeRoleChain(
		chain.filter(candidate =>
			kindOf(candidate) === "native"
				? nativeTakesImages(candidate.model, images)
				: supportsImageJudgment(candidate.model),
		),
	);
}

/** Whether native `model` takes `images`: image support within its count cap. Size bounds never decide; {@link fitNativeImages} fits every image into them. */
function nativeTakesImages(model: Model, images: readonly ImageContent[]): boolean {
	const bounds = nativeJudgmentImageBounds(model);
	return bounds !== undefined && images.length <= (bounds.maxCount ?? images.length);
}

/** Whether `questions` include a box question, which only natives whose wire forwards them answer. */
function asksForBoxes(questions: Questions): boolean {
	for (const id in questions) if (questions[id].type === "box") return true;
	return false;
}

/** {@link FittedImage.content} of an image sent as is. */
const WHOLE_IMAGE: BoxEdges = { top: 0, bottom: 1, left: 0, right: 1 };

/**
 * `images` sized into `model`'s native judgment bounds, which the API enforces by rejecting rather than
 * resizing: an image already within them is sent as is, any other goes through {@link fitImage}. A
 * request-wide byte cap is split evenly so the fitted set also fits as a whole.
 */
async function fitNativeImages(model: Model, images: readonly ImageContent[]): Promise<FittedImage[]> {
	const bounds = nativeJudgmentImageBounds(model);
	if (!bounds) return images.map(image => ({ image, content: WHOLE_IMAGE }));
	const maxBytes = Math.min(
		bounds.maxBytes ?? Infinity,
		Math.floor((bounds.maxTotalBytes ?? Infinity) / images.length),
	);
	const fitted: FittedImage[] = [];
	// Sequential on purpose: each fit decodes and re-encodes a whole image.
	for (const image of images) {
		const within = nativeJudgmentAcceptsImages(model, [image]) && Buffer.byteLength(image.data, "base64") <= maxBytes;
		fitted.push(within ? { image, content: WHOLE_IMAGE } : await fitImage(image, { ...bounds, maxBytes }));
	}
	return fitted;
}

/**
 * `result` with each box answer re-measured on the source image its question names: Jev measures the
 * image it was sent, and padding a fit shrinks the source to {@link FittedImage.content} of it. Answers
 * are copied, never mutated, since the answer cache may share them.
 */
function sourceBoxes<Q extends Questions>(
	questions: Q,
	result: JudgmentResult<Q>,
	fitted: readonly FittedImage[],
): JudgmentResult<Q> {
	let answers: Record<string, Answer> | undefined;
	for (const id in questions) {
		const question: Question = questions[id];
		const answer: Answer = result.answers[id];
		if (question.type !== "box" || answer.type !== "box") continue;
		answers ??= { ...result.answers };
		answers[id] = { ...answer, box: unfitBox(answer.box, fitted[question.image].content) };
	}
	// Only box answers change, and they stay box answers.
	return answers ? { ...result, answers: answers as JudgmentResult<Q>["answers"] } : result;
}

/** `box`, measured on a fitted canvas, measured on the source whose edges on it are `content`; edges in the padding clamp onto the source. */
function unfitBox(box: BoxEdges, content: BoxEdges): BoxEdges {
	const x = (edge: number) => Math.min(1, Math.max(0, (edge - content.left) / (content.right - content.left)));
	const y = (edge: number) => Math.min(1, Math.max(0, (edge - content.top) / (content.bottom - content.top)));
	return { top: y(box.top), bottom: y(box.bottom), left: x(box.left), right: x(box.right) };
}

function judgeRoleChain(settings: Settings, registry: ModelRegistry): RoleChainCandidate[] {
	return textJudgeRoleChain(resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, registry)));
}

/**
 * Whether the `judge` role resolves first to a native judgment backend
 * (TypeSafe jev, OpenRouter or OpenAI Decisions, Workers AI Clef) rather than a
 * prompted on-device or chat model. Judge-heavy features gate on it, e.g. the `find`
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
	/** Text-judgment candidates memoized per resolved chain; image candidates depend on each request's images. */
	#candidates: { chain: RoleChainCandidate[]; list: RoleChainCandidate[] } | undefined;

	constructor(deps: JudgeDeps) {
		this.#deps = deps;
		this.#telemetry = resolveTelemetry(deps.telemetry, deps.sessionId);
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		const requestImages = request.images ?? [];
		// Malformed input is the caller's error, not a candidate failure: reject it before trying any candidate.
		for (const [index, image] of requestImages.entries()) {
			if (!isEmbeddedImageContent(image)) {
				throw new AIError.ValidationError(
					`judgment: images[${index}] must contain non-empty base64 data and an image MIME type`,
				);
			}
		}
		checkBoxQuestions(request);
		return this.#withCandidate(
			async (candidateJudge, kind, model) => {
				if (kind === "local" || requestImages.length === 0) return candidateJudge.judge(request, options);
				const fitted = kind === "native" ? await fitNativeImages(model, requestImages) : undefined;
				const images = fitted
					? fitted.map(fit => fit.image)
					: ((await normalizeModelContextImages([...requestImages], { model })) ?? []);
				const signal = options.signal;
				if (signal?.aborted) {
					const reason = signal.reason;
					throw reason instanceof Error ? reason : new AIError.AbortError("judgment aborted");
				}
				const result = await candidateJudge.judge({ ...request, images }, options);
				return fitted ? sourceBoxes(request.questions, result, fitted) : result;
			},
			options,
			request,
		);
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
		return this.#withCandidate((judge, kind) => run(judge, kind), options);
	}

	/** Run `run` against each candidate able to answer `request` (any candidate when omitted) until one succeeds. */
	async #withCandidate<T>(
		run: (judge: Judge, kind: JudgeKind, model: Model) => Promise<T>,
		options: JudgeOptions,
		request?: JudgmentRequest,
	): Promise<T> {
		const requiresImages = (request?.images?.length ?? 0) > 0;
		const signal = options.signal;
		let lastFailure: string | undefined;
		let lastUnavailable: string | undefined;
		let compatibleCandidate = false;
		let unsupportedCandidate = false;
		const candidates = this.#resolveCandidates(request);
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
				if (requiresImages && judge.supportsImages !== true) {
					unsupportedCandidate = true;
					lastUnavailable = `${identity} does not support image inputs`;
					continue;
				}
				compatibleCandidate = true;
				return await run(judge, kindOf(candidate), candidate.model);
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
		if (requiresImages && !compatibleCandidate && unsupportedCandidate) {
			throw new Error("judgment: no compatible judge candidate supports images");
		}
		if (candidates.length === 0) {
			if (request && asksForBoxes(request.questions)) {
				throw new Error("judgment: no judge candidate answers box questions");
			}
			if (requiresImages) throw new Error("judgment: no compatible judge candidate supports images");
			throw new Error("judgment: no judge model available");
		}
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

	#resolveCandidates(request?: JudgmentRequest): RoleChainCandidate[] {
		const { settings, registry, sessionModel } = this.#deps;
		const { roleChain, list: chain } = cachedJudgeRoleChain(settings, registry);
		const images = request?.images ?? [];
		// A prompted model cannot locate anything, so no session fallback either.
		if (request && asksForBoxes(request.questions)) {
			return roleChain.filter(
				candidate => nativeJudgmentSupportsBoxes(candidate.model) && nativeTakesImages(candidate.model, images),
			);
		}
		if (images.length > 0) return withSessionFallback(imageJudgeRoleChain(roleChain, images), sessionModel, true);
		if (chain === this.#candidates?.chain) return this.#candidates.list;
		const list = withSessionFallback(chain, sessionModel);
		this.#candidates = { chain, list };
		return list;
	}

	async #createJudge(candidate: RoleChainCandidate, signal: AbortSignal | undefined): Promise<Judge | undefined> {
		const model = candidate.model;
		if (model.api === "local-inference") return new TextJudge(new LocalTextBackend(model.id));
		if (!(await this.#deps.registry.getApiKey(model, this.#deps.sessionId, { signal }))) return undefined;
		const apiKey = this.#deps.registry.resolver(model, this.#deps.sessionId);
		if (isJudgmentApi(model.api)) {
			const headers = await this.#deps.registry.resolveModelHeaders(model, signal);
			const judge = createNativeJudge(model, { apiKey, headers });
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
 * Native judgment backend. Questions already answered about the same state
 * under this model come from `cache`; only the rest reach the provider (none
 * when every answer is cached). Each call reports exactly one attempt — failed
 * requests included so the ledger shows why a judgment errored. Most judgment
 * APIs report tokens only, so a response without a billed amount is priced from
 * the catalog model; a route that bills (OpenRouter) keeps its reported cost.
 * Attempts and results carry the catalog id, not the wire id the judge sends.
 */
function nativeJudge(
	judge: NativeJudge,
	model: Model,
	cache: JudgmentCache | undefined,
	report: (attempt: JudgmentAttempt) => void,
): Judge {
	const cacheModel = `${model.provider}/${model.id}`;
	return {
		label: judge.label,
		...(judge.supportsImages === undefined ? {} : { supportsImages: judge.supportsImages }),
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			const startedAt = Date.now();
			const cacheRequest =
				request.images === undefined
					? request
					: {
							...request,
							images: request.images.map(image => ({
								...image,
								detail: judge.effectiveImageDetail(image.detail),
							})),
						};
			const cached = cache?.lookup(cacheModel, cacheRequest);
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
				model: model.id,
				startedAt,
				questions,
				cachedQuestions: questions - pendingCount,
			};
			let fresh: JudgmentResult | undefined;
			if (pendingCount > 0 || questions === 0) {
				let partial = tokenUsage(0, 0);
				try {
					fresh = await judge.judge(
						{
							state: request.state,
							questions: pending,
							...(request.images === undefined ? {} : { images: request.images }),
						},
						{
							signal: options?.signal,
							onPartialUsage: usage => {
								partial = usage;
							},
						},
					);
				} catch (error) {
					// A split judgment that fails still billed the chunks that succeeded.
					if (partial.cost.total === 0) calculateCost(model, partial);
					report({
						...attempt,
						usage: partial,
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
				model: fresh?.model ?? model.id,
				// Every id was answered by the cache or by `fresh`, which NativeJudge validated per question type.
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
