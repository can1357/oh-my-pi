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
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
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

/**
 * Resolve a tier to a concrete {@link Model}. `default` prefers the session's
 * active model and falls back to the `@default` role; `smol`/`slow` resolve
 * their respective role patterns. Returns `undefined` when nothing matches.
 */
function resolveTierModel(tier: CompletionTier, session: ToolSession): Model<Api> | undefined {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return undefined;
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, session.settings);
		return resolveModelFromString(expanded, available, matchPreferences);
	};

	if (tier === "default") {
		const activePattern = session.getActiveModelString?.() ?? session.getModelString?.();
		return resolve(activePattern) ?? resolve(TIER_TO_PATTERN.default);
	}
	return resolve(TIER_TO_PATTERN[tier]);
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

/**
 * Run a single stateless completion on behalf of an eval cell's `completion()` call.
 * Returns a `{ text, details }` value shaped like a {@link callSessionTool}
 * result so the existing bridge transport carries it to either runtime.
 */
export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionResult> {
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const { prompt, model: modelTier, system, schema } = parsed;
	// Apply default value for model if not provided
	const finalTier: CompletionTier = modelTier ?? "default";

	const model = resolveTierModel(finalTier, options.session);
	if (!model) {
		throw new ToolError(
			`completion() could not resolve a model for the "${finalTier}" tier. Configure modelRoles.${finalTier === "default" ? "default" : finalTier} or ensure a provider is available.`,
		);
	}

	const registry = options.session.modelRegistry;
	const apiKey = await registry?.getApiKey(model);
	if (!registry || !apiKey) {
		throw new ToolError(
			`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another tier.`,
		);
	}

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

	const telemetry = resolveTelemetry(options.session.getTelemetry?.(), options.session.getSessionId?.() ?? undefined);

	// Some providers (notably openai-codex) require a non-empty `instructions`
	// field on every Responses request and 400 with "Instructions are required"
	// when it is missing. Fall back to a minimal default so `completion(prompt)` works
	// without forcing every caller to pass a `system` prompt.
	const systemPrompt = system ? [system] : ["You are a helpful assistant."];

	// Suspend eval timeout accounting while the model request owns control. The
	// timeout clock restarts once the bridge returns to the cell runtime.
	const response = await withBridgeTimeoutPause(options.emitStatus, () =>
		instrumentedCompleteSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: registry.resolver(model, options.session.getSessionId?.() ?? undefined),
				signal: options.signal,
				reasoning: reasoningForTier(finalTier, model),
				toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
			},
			{ telemetry, oneshotKind: "eval_completion" },
		),
	);

	if (response.stopReason === "error") {
		throw new ToolError(response.errorMessage ?? "completion() request failed.");
	}
	if (response.stopReason === "aborted") {
		throw new ToolError("completion() request aborted.");
	}

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

	options.emitStatus?.({
		op: "completion",
		model: formatModelString(model),
		tier: finalTier,
		chars: resultText.length,
	});

	return {
		text: resultText,
		details: { model: formatModelString(model), tier: finalTier, structured: Boolean(schema) },
	};
}
