/**
 * Host-side handler for the eval `completion()` helper.
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_COMPLETION_BRIDGE_NAME} lets a single host handler serve both
 * transports without registering an agent-visible tool: cell code calls
 * `completion(prompt, opts)`, the prelude forwards `{ prompt, model, system?, schema? }`
 * through the bridge, and this module performs one stateless completion.
 *
 * The call is oneshot and toolless from the model's perspective — pure text
 * in, text (or, with `schema`, a structured object) out.
 */

import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import { cfgOffline } from "../config/auxiliary-model-policy";
import {
	disabledModelRule,
	disabledSelectorRule,
	formatDisabledModelError,
	withoutDisabledModels,
} from "../config/disabled-models";
import { withDisabledModelFallbackPolicy } from "../config/model-fallback-policy";
import type { ModelRegistry } from "../config/model-registry";
import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ModelLookupRegistry,
	resolveModelFromString,
	resolveModelOverride,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { Semaphore } from "../task/parallel";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import {
	findRetryFallbackCandidates,
	getRetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../session/retry-fallback-chains";
import { AUTO_THINKING, shouldDisableReasoning, toReasoningEffort } from "../thinking/levels";
import { type ConfiguredThinkingLevel } from "../utils/render-utils";
import type { JsStatusEvent } from "./js/shared/types";

import { cfgDisabledProviders } from "../config/model-settings";
import { journalCompletion } from "../session/model-usage-journal";
import { cfgRetry } from "../session/settings";

/** Synthetic bridge name reserved for the `completion()` helper across both runtimes. */
export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

/** Synthetic tool the model is forced to call when a `schema` is supplied. */
const STRUCTURED_TOOL_NAME = "respond";

type CompletionTier = "smol" | "default" | "slow";

const TIER_TO_PATTERN: Record<CompletionTier, string> = {
	smol: "@smol",
	default: "@default",
	slow: "@slow",
};

const completionArgsSchema = type({
	prompt: "string>0",
	// A tier name, or a user-tagged model agent (`m<N>`); see {@link isCompletionTier}.
	"model?": "string",
	"system?": "string",
	"schema?": { "[string]": "unknown" },
});

export interface EvalCompletionBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** Terminal payload of a retained handle. */
export interface EvalCompletionResult {
	text: string;
	/** Structured payload; when present the cell receives it in place of `text`. */
	data?: unknown;
	details: { model: string; tier?: CompletionTier; structured: boolean };
}

/** Handle returned immediately after an eval completion starts. */
export interface EvalCompletionHandleResult {
	id: string;
}

/** One fallback candidate tried by a completion handle, in try order. */
export interface CompletionAttempt {
	/** `provider/id[@upstream]`. */
	model: string;
	/** Reasoning effort sent; `"off"` disables reasoning, `null` leaves the provider default. */
	effort: Effort | "off" | null;
	outcome: "running" | "no-credentials" | "succeeded" | "failed" | "cancelled";
	error?: string;
}

/** Process-local state retained for one eval completion handle. */
export interface CompletionHandleEntry {
	ownerId: string;
	controller: AbortController;
	promise: Promise<void>;
	settled: boolean;
	result?: EvalCompletionResult;
	error?: string;
	attempts: CompletionAttempt[];
	evictionTimer?: NodeJS.Timeout;
}

const COMPLETION_HANDLE_RETENTION_MS = 30 * 60 * 1000;
const completionHandles = new Map<string, CompletionHandleEntry>();

/**
 * Process-wide ceiling on eval model requests executing at once, shared by
 * `completion()` handles, `judge()`, and `judge_batch()` items. A cell that
 * fans out hundreds of calls otherwise opens every request simultaneously and,
 * once the primary candidate rejects, floods each fallback in the role chain
 * (including self-hosted models that serve requests serially). Queued handles
 * report `running` until admitted.
 */
export const EVAL_HANDLE_CONCURRENCY = 32;
export const evalRequestSlots = new Semaphore(EVAL_HANDLE_CONCURRENCY);

/** Resolve a retained completion handle by id. */
export function getCompletionHandle(id: string): CompletionHandleEntry | undefined {
	return completionHandles.get(id);
}

/** Cancel and remove every completion handle owned by an agent session. */
export function releaseCompletionHandles(ownerId: string): void {
	for (const [id, entry] of completionHandles) {
		if (entry.ownerId !== ownerId) continue;
		entry.controller.abort(new ToolError("Completion handle owner released"));
		clearTimeout(entry.evictionTimer);
		completionHandles.delete(id);
	}
}

interface CompletionCandidate {
	/** Raw fallback-chain selector this candidate was resolved from. */
	selector: string;
	model: Model<Api>;
	reasoning: Effort | undefined;
	disableReasoning: boolean;
}

function reasoningForCandidate(
	tier: CompletionTier,
	model: Model<Api>,
	level?: ConfiguredThinkingLevel,
	parent?: Pick<CompletionCandidate, "reasoning" | "disableReasoning">,
): Pick<CompletionCandidate, "reasoning" | "disableReasoning"> {
	// "auto" is a session-level selector; completion() has no per-prompt
	// classifier, so it follows the tier default just like an omitted suffix.
	const normalizedLevel = level === AUTO_THINKING ? undefined : level;
	if (shouldDisableReasoning(normalizedLevel)) return { reasoning: undefined, disableReasoning: true };
	const explicit = toReasoningEffort(normalizedLevel);
	if (explicit !== undefined) {
		return { reasoning: clampThinkingLevelForModel(model, explicit), disableReasoning: false };
	}
	// Bare nested entries inherit the failed candidate's effective effort
	// instead of recomputing the tier default for a different model.
	if (parent) {
		if (parent.disableReasoning) return { reasoning: undefined, disableReasoning: true };
		return { reasoning: clampThinkingLevelForModel(model, parent.reasoning), disableReasoning: false };
	}
	const requested = reasoningForTier(tier, model);
	return {
		reasoning: clampThinkingLevelForModel(model, requested),
		disableReasoning: false,
	};
}

/**
 * Identity used to dedupe fallback candidates. A chain may retry the same model
 * at a different effort (`slow: ["provider/model:low"]`), so the key folds in
 * the effective reasoning settings — matching the shared resolver, which treats
 * differently suffixed selectors as distinct.
 */
function candidateIdentity(
	model: Model<Api>,
	reasoning: Pick<CompletionCandidate, "reasoning" | "disableReasoning">,
): string {
	const effort = reasoning.disableReasoning ? "off" : (reasoning.reasoning ?? "inherit");
	return `${formatModelStringWithRouting(model)}|${effort}`;
}

interface FallbackExpansion {
	context: RetryFallbackResolutionContext;
	/** Where fallback selectors resolve; see {@link completionModelLookup}. */
	lookup: ModelLookupRegistry;
	settings: Settings | undefined;
	tier: CompletionTier;
	disabledProviders: Set<string>;
	/** Offline mode (`models.offline`): the only provider a fallback entry may name. */
	offlineProvider: string | undefined;
}

/**
 * Where completion models resolve: the registry, or with offline mode
 * (`models.offline`) only the active model provider's models, none without an active model.
 */
function completionModelLookup(session: ToolSession, registry: ModelRegistry): ModelLookupRegistry {
	if (!cfgOffline.get(session.settings)) return registry;
	const provider = session.getActiveModel?.()?.provider;
	const models = provider ? registry.getAvailableForProviders(new Set([provider])) : [];
	return { getAvailable: () => models };
}

/**
 * Append the fallback chain applicable to `selector`, then depth-first walk
 * each appended candidate's own chain so a model-oriented chain (B → C)
 * applies when its owner fails. `seen` dedupes by model plus effective
 * reasoning; `expanded` bounds the walk to one visit per raw selector and
 * inherited effort, so the same model reached at another effort still walks
 * its own descendants. `allowMissingPrimary` lets the concrete primary
 * stand in when a role assignment is too unqualified to parse as a chain
 * primary. `roleHint` is the tier, valid only for the root expansion:
 * nested candidates resolve their own exact/wildcard/role chain so a leaf
 * cannot jump back into the root tier chain and reorder its siblings.
 */
function appendFallbackCandidates(
	deps: FallbackExpansion,
	selector: string,
	model: Model<Api>,
	parent: Pick<CompletionCandidate, "reasoning" | "disableReasoning"> | undefined,
	roleHint: string | undefined,
	seen: Set<string>,
	expanded: Set<string>,
	out: CompletionCandidate[],
): void {
	// Explicit primary effort seeds root inheritance; nested calls fold in
	// each candidate's inherited effort.
	const visit = parent ? `${selector}|${parent.disableReasoning ? "off" : (parent.reasoning ?? "inherit")}` : selector;
	if (expanded.has(visit)) return;
	expanded.add(visit);
	const chainKey = resolveRetryFallbackChainKey(deps.context, selector, model, roleHint);
	if (!chainKey) return;
	for (const entry of findRetryFallbackCandidates(deps.context, chainKey, selector, model, {
		allowMissingPrimary: true,
	})) {
		// Like the turn path's offline filter: an entry for another provider is skipped, not re-read
		// as a bare id that one of the allowed provider's models happens to carry.
		if (deps.offlineProvider !== undefined && entry.provider !== deps.offlineProvider) continue;
		const resolved = resolveModelOverride([entry.raw], deps.lookup, deps.settings);
		const candidate = resolved.model;
		if (!candidate || deps.disabledProviders.has(candidate.provider)) continue;
		const reasoning = reasoningForCandidate(deps.tier, candidate, entry.thinkingLevel, parent);
		const identity = candidateIdentity(candidate, reasoning);
		if (seen.has(identity)) continue;
		seen.add(identity);
		out.push({ selector: entry.raw, model: candidate, ...reasoning });
		appendFallbackCandidates(deps, entry.raw, candidate, reasoning, undefined, seen, expanded, out);
	}
}

/**
 * Resolve a tier to its primary model and configured retry-fallback candidates.
 * `default` prefers the session's active model before the `@default` role.
 */
function resolveTierCandidates(tier: CompletionTier, session: ToolSession): CompletionCandidate[] {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return [];
	const lookup = completionModelLookup(session, modelRegistry);
	const catalog = lookup.getAvailable();
	const available = withoutDisabledModels(catalog, session.settings);

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (
		pattern: string | undefined,
	): { model: Model<Api>; selector: string; configuredEffort?: ConfiguredThinkingLevel } | undefined => {
		if (!pattern) return undefined;
		const selector = expandRoleAlias(pattern, session.settings);
		// Refuse a denied selector outright: fuzzy matching over the filtered list could
		// otherwise substitute an allowed sibling on the same provider.
		const denied = disabledSelectorRule(selector, session.settings, available, catalog);
		if (denied) throw new ToolError(formatDisabledModelError(denied.label, denied.rule));
		const model = resolveModelFromString(selector, available, matchPreferences);
		if (!model) return undefined;
		const configuredEffort =
			tier === "slow"
				? extractExplicitThinkingSelector(selector, session.settings, {
						isLiteralModelId: (provider, id) => {
							const normalizedProvider = provider?.trim().toLowerCase();
							const normalizedId = id.trim().toLowerCase();
							return available.some(
								candidate =>
									(normalizedProvider === undefined ||
										candidate.provider.trim().toLowerCase() === normalizedProvider) &&
									candidate.id.trim().toLowerCase() === normalizedId,
							);
						},
					})
				: undefined;
		return { model, selector, configuredEffort };
	};
	const primary =
		tier === "default"
			? (resolve(session.getActiveModelString?.() ?? session.getModelString?.()) ?? resolve(TIER_TO_PATTERN.default))
			: resolve(TIER_TO_PATTERN[tier]);
	if (!primary) return [];

	const candidates: CompletionCandidate[] = [
		{
			selector: primary.selector,
			model: primary.model,
			...reasoningForCandidate(tier, primary.model, primary.configuredEffort),
		},
	];
	const retry = cfgRetry.get(session.settings);
	if (!retry.enabled || !retry.modelFallback) return candidates;
	const primaryLevel = primary.configuredEffort === AUTO_THINKING ? undefined : primary.configuredEffort;
	const inheritPrimary = shouldDisableReasoning(primaryLevel) || toReasoningEffort(primaryLevel) !== undefined;

	appendFallbackCandidates(
		{
			context: {
				chains: getRetryFallbackChains(session.settings),
				getModelRole: (role: string) => session.settings.getModelRole(role),
				modelLookup: modelRegistry,
			},
			lookup,
			settings: session.settings,
			tier,
			disabledProviders: new Set(cfgDisabledProviders.get(session.settings)),
			// Offline, the primary resolved from the active provider's models.
			offlineProvider: cfgOffline.get(session.settings) ? primary.model.provider : undefined,
		},
		primary.selector,
		primary.model,
		inheritPrimary ? candidates[0] : undefined,
		tier,
		new Set([candidateIdentity(primary.model, candidates[0])]),
		new Set(),
		candidates,
	);
	return candidates;
}

/**
 * Choose the reasoning effort for a tier. Only `slow` opts into thinking, and
 * only on reasoning-capable models — guarding against `requireSupportedEffort`
 * throwing downstream on models that cannot reason. Clamps to the highest
 * supported effort so a reasoning model without `high` does not 400.
 */
function reasoningForTier(tier: CompletionTier, model: Model<Api>): Effort | undefined {
	if (tier !== "slow" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
}

/** Whether `value` names one of the fixed completion tiers rather than a model agent. */
function isCompletionTier(value: string): value is CompletionTier {
	return value === "smol" || value === "default" || value === "slow";
}

/**
 * Resolve a user-tagged model agent (`m<N>`) to its candidate. The agent's
 * definition pins the exact `provider/id[:level]` the user tagged, so the
 * candidate inherits that selector's effort. Returns nothing when the name is
 * unknown or its pinned model is unavailable.
 */
function resolveTaggedAgentCandidates(agentName: string, session: ToolSession): CompletionCandidate[] {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return [];
	const lookup = completionModelLookup(session, modelRegistry);
	const available = lookup.getAvailable();
	if (available.length === 0) return [];
	const agent = session.getSessionAgents?.().find(candidate => candidate.name === agentName);
	const selector = agent?.model?.[0];
	if (!selector) return [];
	// Offline mode matches the pin exactly: a fuzzy match on the active provider's models could
	// swap in an aggregator's copy of a model the user tagged on another provider.
	const resolved = resolveModelOverride([selector], lookup, session.settings, {
		exactOnly: cfgOffline.get(session.settings),
	});
	if (resolved.disabledModel)
		throw new ToolError(formatDisabledModelError(resolved.disabledModel.label, resolved.disabledModel.rule));
	if (!resolved.model) return [];
	const reasoning = reasoningForCandidate("default", resolved.model, resolved.thinkingLevel ?? agent?.thinkingLevel);
	return [{ selector, model: resolved.model, ...reasoning }];
}

async function executeCompletion(
	prompt: string,
	tier: CompletionTier | undefined,
	system: string | undefined,
	schema: Record<string, unknown> | undefined,
	candidates: CompletionCandidate[],
	session: ToolSession,
	signal: AbortSignal,
	attempts: CompletionAttempt[],
	rawBuffer: RawSseDebugBuffer,
): Promise<EvalCompletionResult> {
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("completion() has no model registry.");

	const tools: Tool[] | undefined = schema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return your answer by calling this tool with the requested structured fields.",
					parameters: schema,
					strict: false,
				},
			]
		: undefined;
	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	const systemPrompt = system ? [system] : ["You are a helpful assistant."];
	// Each fallback that issues a model request consumes one retry attempt,
	// mirroring session recovery. Keyless candidates are skipped without
	// consuming budget so a usable later fallback is still attempted.
	const maxRetries = Math.max(0, cfgRetry.get(session.settings).maxRetries);
	// One journal for the whole request: every fallback it sends is billed to the branch that asked.
	const journal = journalCompletion(session.sessionManager, { purpose: "completion", role: tier });
	let response: AssistantMessage | undefined;
	let model: Model<Api> | undefined;
	let lastError: unknown;
	let retriesUsed = 0;
	let completed = false;
	let attempt: CompletionAttempt | undefined;
	for (const [index, candidate] of candidates.entries()) {
		if (index > 0 && retriesUsed >= maxRetries) break;
		model = candidate.model;
		// The session's cost cap covers completions a cell makes, attempt by attempt.
		const refusal = session.costGate?.check();
		if (refusal) throw new ToolError(refusal.message);
		attempt = {
			model: formatModelStringWithRouting(model),
			effort: candidate.disableReasoning ? "off" : (candidate.reasoning ?? null),
			outcome: "running",
		};
		attempts.push(attempt);
		try {
			// Forward the session id so session-sticky OAuth credentials
			// resolve (see #5325); without it a usable fallback looks keyless.
			const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined, { signal });
			if (!apiKey) {
				attempt.outcome = "no-credentials";
				lastError = new ToolError(
					`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another model.`,
				);
				continue;
			}
			// Credentials can resolve after the user changes the session policy.
			const denied = disabledModelRule(model, session.settings);
			if (denied) throw new ToolError(formatDisabledModelError(model, denied));
			if (index > 0) retriesUsed += 1;
			response = await instrumentedCompleteSimple(
				withDisabledModelFallbackPolicy(model, session.settings),
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
					tools,
				},
				{
					apiKey: registry.resolver(model, session.getSessionId?.() ?? undefined),
					signal,
					reasoning: candidate.reasoning,
					disableReasoning: candidate.disableReasoning,
					toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
					// Capture this request's raw provider frames (SSE / synthesized WS
					// frames): the local buffer backs the on-error dump; the session
					// buffer surfaces the same frames in `/debug`.
					onSseEvent: (event, model) => {
						rawBuffer.recordEvent(event, model);
						session.rawSseDebugBuffer?.recordEvent(event, model);
					},
				},
				{ telemetry, oneshotKind: "eval_completion" },
			);
			session.costGate?.record(response.usage.cost.total);
			journal?.(response, prompt);
		} catch (error) {
			failAttempt(attempt, error, signal);
			lastError = error;
			if (signal.aborted || index === candidates.length - 1) throw error;
			continue;
		}
		if (response.stopReason === "aborted") {
			attempt.outcome = "cancelled";
			throw new ToolError("completion() request aborted.");
		}
		if (response.stopReason === "error") {
			lastError = new ToolError(response.errorMessage ?? "completion() request failed.");
			failAttempt(attempt, lastError, signal);
			if (!signal.aborted && index < candidates.length - 1) continue;
			throw lastError;
		}
		completed = true;
		break;
	}
	if (!completed || !response || !model || !attempt) {
		if (lastError instanceof Error) throw lastError;
		throw new ToolError("completion() request failed.");
	}

	let resultText: string;
	try {
		resultText = responseText(response, schema);
	} catch (error) {
		failAttempt(attempt, error, signal);
		throw error;
	}
	attempt.outcome = "succeeded";
	return {
		text: resultText,
		details: { model: formatModelString(model), tier, structured: Boolean(schema) },
	};
}

function failAttempt(attempt: CompletionAttempt, error: unknown, signal: AbortSignal): void {
	attempt.outcome = signal.aborted ? "cancelled" : "failed";
	attempt.error = error instanceof Error ? error.message : String(error);
}

function responseText(response: AssistantMessage, schema: Record<string, unknown> | undefined): string {
	if (!schema) {
		const text = extractTextContent(response);
		if (!text) throw new ToolError("completion() returned no text output.");
		return text;
	}
	const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
	if (call) return JSON.stringify(call.arguments);
	const text = extractTextContent(response);
	if (!text) throw new ToolError("completion() returned no structured response.");
	try {
		return JSON.stringify(parseJsonPayload(text));
	} catch {
		throw new ToolError("completion() did not return a structured response matching the schema.");
	}
}

/** Start a stateless completion and return its process-local handle immediately. */
export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionHandleResult> {
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const { prompt, model: modelArg, system, schema } = parsed;
	const requested = modelArg ?? "default";
	const tier = isCompletionTier(requested) ? requested : undefined;
	const candidates = tier
		? resolveTierCandidates(tier, options.session)
		: resolveTaggedAgentCandidates(requested, options.session);
	if (candidates.length === 0) {
		throw new ToolError(
			tier
				? `completion() could not resolve a model for the "${tier}" tier. Configure modelRoles.${tier === "default" ? "default" : tier} or ensure a provider is available.`
				: `completion() could not resolve model "${requested}". Pass a tier ("smol"|"default"|"slow") or the name of a user-tagged model agent ("m<N>").`,
		);
	}

	return retainCompletionHandle("cmp", options, async (signal, attempts) => {
		const rawBuffer = new RawSseDebugBuffer();
		try {
			return await executeCompletion(
				prompt,
				tier,
				system,
				schema,
				candidates,
				options.session,
				signal,
				attempts,
				rawBuffer,
			);
		} catch (error) {
			// A user cancel is not a diagnostic failure; skip the dump.
			if (!signal.aborted) {
				const file = await dumpCompletionStream(rawBuffer, options.session);
				if (file && error instanceof Error) {
					error.message = `${error.message}\nStreamed provider frames written to ${file}.`;
				}
			}
			throw error;
		}
	});
}

/**
 * Persist a failed `completion()`'s captured provider frames to a `.log` file,
 * preferring the session artifacts directory so it is discoverable and cleaned
 * up with the session. Returns the path, or `null` when nothing was captured
 * (e.g. a transport without raw-frame support) or the write failed.
 */
async function dumpCompletionStream(buffer: RawSseDebugBuffer, session: ToolSession): Promise<string | null> {
	const text = buffer.toRawText();
	if (!text.trim()) return null;
	const dir = session.sessionManager?.getArtifactsDir?.() ?? os.tmpdir();
	const file = path.join(dir, `completion-${Snowflake.next()}.sse.log`);
	try {
		await Bun.write(file, text);
		return file;
	} catch (error) {
		logger.debug("completion() stream dump failed", { file, error });
		return null;
	}
}

/**
 * Run `execute` in the background under a session-owned, cancellable handle
 * and return its id immediately; `wait()`/`status()`/`cancel()` resolve it
 * through {@link getCompletionHandle}. Settled entries are evicted after
 * {@link COMPLETION_HANDLE_RETENTION_MS}.
 */
export function retainCompletionHandle(
	prefix: string,
	options: EvalCompletionBridgeOptions,
	execute: (signal: AbortSignal, attempts: CompletionAttempt[]) => Promise<EvalCompletionResult>,
): EvalCompletionHandleResult {
	const id = `${prefix}-${Snowflake.next()}`;
	const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const entry: CompletionHandleEntry = {
		ownerId,
		controller,
		promise: Promise.resolve(),
		settled: false,
		attempts: [],
	};
	completionHandles.set(id, entry);
	const run = async (): Promise<EvalCompletionResult> => {
		await evalRequestSlots.acquire(signal);
		try {
			return await execute(signal, entry.attempts);
		} finally {
			evalRequestSlots.release();
		}
	};
	entry.promise = run()
		.then(
			result => {
				entry.result = result;
			},
			error => {
				entry.error = error instanceof Error ? error.message : String(error);
			},
		)
		.finally(() => {
			entry.settled = true;
			const timer = setTimeout(() => {
				if (completionHandles.get(id) === entry) completionHandles.delete(id);
			}, COMPLETION_HANDLE_RETENTION_MS);
			timer.unref?.();
			entry.evictionTimer = timer;
		});
	return { id };
}
