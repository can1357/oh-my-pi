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

import { type } from "@oh-my-pi/omptype";
import { instrumentedCompleteSimple, resolveTelemetry, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import {
	expandRoleAlias,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveModelFromString,
	resolveModelOverride,
} from "../config/model-resolver";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import {
	findRetryFallbackCandidates,
	getRetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../session/retry-fallback-chains";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import type { JsStatusEvent } from "./js/shared/types";

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
	"model?": "'smol'|'default'|'slow'",
	"system?": "string",
	"schema?": { "[string]": "unknown" },
});

export interface EvalCompletionBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalCompletionResult {
	text: string;
	details: { model: string; tier: CompletionTier; structured: boolean };
}

/** Handle returned immediately after an eval completion starts. */
export interface EvalCompletionHandleResult {
	id: string;
}

/** Process-local state retained for one eval completion handle. */
export interface CompletionHandleEntry {
	ownerId: string;
	controller: AbortController;
	promise: Promise<void>;
	settled: boolean;
	result?: EvalCompletionResult;
	error?: string;
	evictionTimer?: NodeJS.Timeout;
}

const COMPLETION_HANDLE_RETENTION_MS = 30 * 60 * 1000;
const completionHandles = new Map<string, CompletionHandleEntry>();

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
	model: Model<Api>;
	reasoning: Effort | undefined;
	disableReasoning: boolean;
}

function reasoningForCandidate(
	tier: CompletionTier,
	model: Model<Api>,
	level?: ThinkingLevel,
): Pick<CompletionCandidate, "reasoning" | "disableReasoning"> {
	if (shouldDisableReasoning(level)) return { reasoning: undefined, disableReasoning: true };
	const requested = toReasoningEffort(level) ?? reasoningForTier(tier, model);
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

/**
 * Resolve a tier to its primary model and configured retry-fallback candidates.
 * `default` prefers the session's active model before the `@default` role.
 */
function resolveTierCandidates(tier: CompletionTier, session: ToolSession): CompletionCandidate[] {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return [];
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return [];

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (pattern: string | undefined): { model: Model<Api>; selector: string } | undefined => {
		if (!pattern) return undefined;
		const selector = expandRoleAlias(pattern, session.settings);
		const model = resolveModelFromString(selector, available, matchPreferences);
		return model ? { model, selector } : undefined;
	};
	const primary =
		tier === "default"
			? (resolve(session.getActiveModelString?.() ?? session.getModelString?.()) ?? resolve(TIER_TO_PATTERN.default))
			: resolve(TIER_TO_PATTERN[tier]);
	if (!primary) return [];

	const candidates: CompletionCandidate[] = [{ model: primary.model, ...reasoningForCandidate(tier, primary.model) }];
	const retry = session.settings.getGroup("retry");
	if (!retry.enabled || !retry.modelFallback) return candidates;

	const context: RetryFallbackResolutionContext = {
		chains: getRetryFallbackChains(session.settings),
		getModelRole: role => session.settings.getModelRole(role),
		modelLookup: modelRegistry,
	};
	const chainKey = resolveRetryFallbackChainKey(context, primary.selector, primary.model, tier);
	if (!chainKey) return candidates;

	const disabledProviders = new Set(session.settings.get("disabledProviders"));
	const seen = new Set([candidateIdentity(primary.model, candidates[0])]);
	for (const selector of findRetryFallbackCandidates(context, chainKey, primary.selector, primary.model)) {
		const resolved = resolveModelOverride([selector.raw], modelRegistry, session.settings);
		const model = resolved.model;
		if (!model || disabledProviders.has(model.provider)) continue;
		const reasoning = reasoningForCandidate(tier, model, selector.thinkingLevel);
		const identity = candidateIdentity(model, reasoning);
		if (seen.has(identity)) continue;
		seen.add(identity);
		candidates.push({ model, ...reasoning });
	}
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

async function executeCompletion(
	prompt: string,
	finalTier: CompletionTier,
	system: string | undefined,
	schema: Record<string, unknown> | undefined,
	candidates: CompletionCandidate[],
	session: ToolSession,
	signal: AbortSignal,
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
	let response: AssistantMessage | undefined;
	let model: Model<Api> | undefined;
	for (const [index, candidate] of candidates.entries()) {
		model = candidate.model;
		try {
			const apiKey = await registry.getApiKey(model);
			if (!apiKey) {
				throw new ToolError(
					`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another tier.`,
				);
			}
			response = await instrumentedCompleteSimple(
				model,
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
				},
				{ telemetry, oneshotKind: "eval_completion" },
			);
		} catch (error) {
			if (signal.aborted || index === candidates.length - 1) throw error;
			continue;
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("completion() request aborted.");
		}
		if (response.stopReason === "error") {
			if (!signal.aborted && index < candidates.length - 1) continue;
			throw new ToolError(response.errorMessage ?? "completion() request failed.");
		}
		break;
	}
	if (!response || !model) throw new ToolError("completion() request failed.");

	let resultText: string;
	if (schema) {
		const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
		let value: unknown;
		if (call) {
			value = call.arguments;
		} else {
			const text = extractTextContent(response);
			if (!text) throw new ToolError("completion() returned no structured response.");
			try {
				value = parseJsonPayload(text);
			} catch {
				throw new ToolError("completion() did not return a structured response matching the schema.");
			}
		}
		resultText = JSON.stringify(value);
	} else {
		resultText = extractTextContent(response);
		if (!resultText) throw new ToolError("completion() returned no text output.");
	}

	return {
		text: resultText,
		details: { model: formatModelString(model), tier: finalTier, structured: Boolean(schema) },
	};
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
	const { prompt, model: modelTier, system, schema } = parsed;
	const finalTier: CompletionTier = modelTier ?? "default";
	const candidates = resolveTierCandidates(finalTier, options.session);
	if (candidates.length === 0) {
		throw new ToolError(
			`completion() could not resolve a model for the "${finalTier}" tier. Configure modelRoles.${finalTier === "default" ? "default" : finalTier} or ensure a provider is available.`,
		);
	}

	const id = `cmp-${Snowflake.next()}`;
	const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const entry: CompletionHandleEntry = {
		ownerId,
		controller,
		promise: Promise.resolve(),
		settled: false,
	};
	completionHandles.set(id, entry);
	entry.promise = executeCompletion(prompt, finalTier, system, schema, candidates, options.session, signal)
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
