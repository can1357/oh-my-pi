import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { supportsAllTurnsReasoningContext, supportsCodexReasoningSummary } from "@oh-my-pi/pi-catalog/identity";
import { requireSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { $env } from "@oh-my-pi/pi-utils";
import type { Model } from "../../types";
import { mapOpenAIReasoningEffort } from "../openai-shared";

/** Reasoning replay scope for the Codex Responses API (`reasoning.context`). */
export type CodexReasoningContext = "auto" | "current_turn" | "all_turns";

/** User-facing effort levels accepted by Codex request options. */
type CodexCallerEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Caller literal → catalog `Effort` bridge (the enum is nominal). */
const EFFORT_BY_NAME: Record<CodexCallerEffort, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	summary?: "auto" | "concise" | "detailed";
	context?: CodexReasoningContext;
	/** Pro reasoning serving mode (gpt-5.6+ catalog pro aliases). */
	mode?: "pro";
}

export interface CodexRequestOptions {
	/** User-facing effort; maps 1:1 onto the wire tier of the same name. */
	reasoningEffort?: CodexCallerEffort | "none";
	/** Suppress native reasoning by sending `reasoning.effort: "none"`. */
	reasoningOff?: boolean;
	reasoningSummary?: ReasoningConfig["summary"] | null;
	/** Explicit `reasoning.context` override. Omitted by default; Responses Lite forces `all_turns` as required by that transport. */
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	/**
	 * Responses Lite transport override; defaults to the model's
	 * `useResponsesLite`. Lite moves instructions/tools into input items,
	 * strips image detail, and disables parallel tool calling (codex-rs
	 * `use_responses_lite`).
	 */
	responsesLite?: boolean;
}

export interface InputItem {
	id?: string | null;
	type?: string | null;
	role?: string;
	content?: unknown;
	call_id?: string | null;
	name?: string;
	output?: unknown;
	arguments?: unknown;
	action?: unknown;
	actions?: unknown;
	pending_safety_checks?: unknown;
	acknowledged_safety_checks?: unknown;
	/** `additional_tools` developer item payload (Responses Lite). */
	tools?: unknown;
}

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	tool_choice?: unknown;
	/** Concurrent reasoning-summary delivery (codex-rs `StreamOptions`). */
	stream_options?: { reasoning_summary_delivery: "sequential_cutoff" };
	// Sampling controls (temperature/top_p/top_k/min_p/presence_penalty/
	// repetition_penalty/frequency_penalty/stop) are intentionally absent: the
	// Codex backend rejects every one with a 400 `Unsupported parameter`, so
	// the transformer never sets them (#3117).
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	client_metadata?: Record<string, string>;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	[key: string]: unknown;
}

/**
 * Resolve whether a Codex request uses the Responses Lite transport: an
 * explicit option wins, then the `PI_CODEX_RESPONSES_LITE` env override
 * (`1`/`true` forces Lite, `0`/`false` forces the full Responses body),
 * otherwise the model's catalog flag (codex-rs `model_info.use_responses_lite`)
 * decides.
 */
export function resolveCodexResponsesLite(
	model: Model<"openai-codex-responses">,
	requested: boolean | undefined,
): boolean {
	if (requested !== undefined) return requested;
	const env = $env.PI_CODEX_RESPONSES_LITE?.trim().toLowerCase();
	if (env === "1" || env === "true") return true;
	if (env === "0" || env === "false") return false;
	return model.useResponsesLite === true;
}

/**
 * Whether to request `stream_options.reasoning_summary_delivery =
 * "sequential_cutoff"` (codex-rs `concurrent_reasoning_summaries`), enabled by
 * `PI_CODEX_CONCURRENT_SUMMARIES=1`.
 *
 * Off by default because the mode cancels summary sections still in flight when
 * the reasoning item closes: measured over 12 interleaved turns it halved
 * visible thinking (0.83 vs 1.67 summary parts, 37 vs 69 chars per turn) and
 * produced no summary at all on 3 of 12 turns. codex-rs ships it disabled too
 * (`Stage::UnderDevelopment`, `default_enabled: false`).
 */
function concurrentSummariesEnabled(): boolean {
	const env = $env.PI_CODEX_CONCURRENT_SUMMARIES?.trim().toLowerCase();
	return env === "1" || env === "true";
}

/**
 * Clamp a user-facing effort to the model's ladder, then remap to the wire
 * tier. User efforts map 1:1 onto wire tiers; the effort map only covers
 * host quirks where a wire tier genuinely does not exist (e.g. `minimal→none`).
 * A mapped value outside the Codex wire vocabulary is a broken compat/model
 * effort map — fail loudly rather than silently sending a different tier.
 */
function mapCodexWireEffort(
	model: Model<"openai-codex-responses">,
	effort: CodexCallerEffort,
): ReasoningConfig["effort"] {
	const mapped = mapOpenAIReasoningEffort(model, model.compat, requireSupportedEffort(model, EFFORT_BY_NAME[effort]));
	switch (mapped) {
		case "none":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return mapped;
		default:
			throw new Error(
				`Effort map for ${model.provider}/${model.id} produced invalid Codex reasoning effort "${mapped}"`,
			);
	}
}

function getReasoningConfig(
	model: Model<"openai-codex-responses">,
	effort: NonNullable<CodexRequestOptions["reasoningEffort"]>,
	options: CodexRequestOptions,
): ReasoningConfig {
	const config: ReasoningConfig = {
		effort: effort === "none" ? "none" : mapCodexWireEffort(model, effort),
	};
	// The backend only emits reasoning summaries when `reasoning.summary` is
	// present: omitting it yields zero `response.reasoning_summary_text.*`
	// events (measured against gpt-5.5, gpt-5.6-sol and gpt-5.6-terra). So
	// `undefined` means "default on" — matching `applyResponsesCompatPolicy`
	// on the plain Responses path — and only an explicit `null` (the caller
	// hiding thinking) opts out.
	if (options.reasoningSummary !== null && supportsCodexReasoningSummary(model.id)) {
		config.summary = options.reasoningSummary ?? "auto";
	}
	return config;
}

function filterInput(input: InputItem[] | undefined): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter(item => item.type !== "item_reference")
		.map(item => {
			if (item.type === "computer_call") return item;
			if (item.id != null) {
				const { id: _id, ...rest } = item;
				return rest as InputItem;
			}
			return item;
		});
}

const CODEX_ORPHAN_OUTPUT_LIMIT = 16_000;
/** Placeholder output for a tool call whose result never landed in the input. */
const CODEX_INTERRUPTED_TOOL_OUTPUT =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

function orphanFunctionOutputToMessage(item: InputItem, callId: string): InputItem {
	const itemRecord = item as unknown as Record<string, unknown>;
	const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "tool";
	let text = "";
	try {
		const output = itemRecord.output;
		text = typeof output === "string" ? output : JSON.stringify(output);
	} catch {
		text = String(itemRecord.output ?? "");
	}
	if (text.length > CODEX_ORPHAN_OUTPUT_LIMIT) {
		text = `${text.slice(0, CODEX_ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
	}
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${callId}]: ${text}`,
	} as InputItem;
}

type ToolCallKind = "function" | "custom" | "computer";

function toolCallKind(type: unknown): ToolCallKind | undefined {
	if (type === "function_call") return "function";
	if (type === "custom_tool_call") return "custom";
	if (type === "computer_call") return "computer";
	return undefined;
}

function toolOutputKind(type: unknown): ToolCallKind | undefined {
	if (type === "function_call_output") return "function";
	if (type === "custom_tool_call_output") return "custom";
	if (type === "computer_call_output") return "computer";
	return undefined;
}

/**
 * Repair both halves of unpaired tool exchanges so the Responses input grammar
 * stays valid — the API rejects either orphan with a 400:
 *
 * - `function_call_output` / `custom_tool_call_output` with no matching call →
 *   folded into an assistant message (`400 No tool call found for … output`).
 *   Regression of #472 / #1351.
 * - `function_call` / `custom_tool_call` with no matching `*_output` → a
 *   placeholder output is synthesized immediately after the call
 *   (`400 No tool output found for function call …`). Hit when the user
 *   branches/navigates the session tree to a node that ends on a tool call (the
 *   tool-result child is dropped from the reconstructed history) or when a turn
 *   is aborted/crashes after the call streamed but before its result persisted.
 */
function repairToolCallPairs(input: InputItem[]): InputItem[] {
	const callKinds = new Map<string, ToolCallKind>();
	const outputKinds = new Map<string, ToolCallKind>();
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;
		if (callId === undefined) continue;
		const callKind = toolCallKind(item.type);
		const outputKind = toolOutputKind(item.type);
		if (callKind) callKinds.set(callId, callKind);
		if (outputKind) outputKinds.set(callId, outputKind);
	}

	const repaired: InputItem[] = [];
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;
		const callKind = toolCallKind(item.type);
		const outputKind = toolOutputKind(item.type);

		if (outputKind && callId !== undefined && callKinds.get(callId) !== outputKind) {
			repaired.push(orphanFunctionOutputToMessage(item, callId));
			continue;
		}
		if (callKind && callId !== undefined && outputKinds.get(callId) !== callKind) {
			if (callKind === "computer") {
				repaired.push({
					type: "message",
					role: "assistant",
					content: `[Computer call interrupted before a screenshot was recorded; call_id=${callId}]`,
				});
				continue;
			}
			repaired.push(item, {
				type: callKind === "custom" ? "custom_tool_call_output" : "function_call_output",
				call_id: callId,
				output: CODEX_INTERRUPTED_TOOL_OUTPUT,
			});
			continue;
		}
		repaired.push(item);
	}
	return repaired;
}

/**
 * Responses Lite requests must not pin image detail levels: codex-rs strips
 * `detail` from every input image (message content and tool outputs) before
 * sending, letting the server choose.
 */
function stripImageDetails(input: unknown[]): void {
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const content = "content" in item ? item.content : undefined;
		const output = "output" in item ? item.output : undefined;
		for (const collection of [content, output]) {
			if (!Array.isArray(collection)) continue;
			for (const part of collection) {
				if (!part || typeof part !== "object") continue;
				if (!("type" in part) || part.type !== "input_image") continue;
				if ("detail" in part) part.detail = undefined;
			}
		}
	}
}

/**
 * Structural view of a Responses-style body mutated by the Lite rewrite.
 * Loose (`unknown`) property types let the turn transformer (`RequestBody`)
 * and the agent's remote-compaction payloads reuse one shaper.
 */
export interface CodexLiteShapedBody {
	instructions?: unknown;
	tools?: unknown;
	tool_choice?: unknown;
	input?: unknown;
	parallel_tool_calls?: unknown;
}

/**
 * Applies the Responses Lite body contract in place (codex-rs
 * `build_responses_request` with `use_responses_lite`): strips pinned image
 * detail, forces parallel tool calling off, moves tools into a leading
 * `additional_tools` developer item and the base instructions into a
 * developer message, then omits top-level `instructions`/`tools`. Because the
 * rewrite removes top-level `tools`, a forced hosted-tool choice (e.g.
 * `{ type: "web_search" }`) would leave the backend unable to validate the
 * choice against a tools collection and it rejects the request with HTTP 400
 * (#5771). Native computer and named-function choices preserve exact forcing
 * by isolating the selected declaration and using `"required"`; other hosted
 * choices fall back to `"auto"`. Explicit string constraints such as `"none"`
 * and `"required"` remain valid. Shared by normal turns and both remote-compaction
 * paths — codex-rs routes `/responses/compact` through the same builder.
 */
export function applyCodexResponsesLiteShape(body: CodexLiteShapedBody): void {
	const input = Array.isArray(body.input) ? body.input : [];
	stripImageDetails(input);
	body.parallel_tool_calls = false;
	const declaredTools = Array.isArray(body.tools) ? body.tools : [];
	let additionalTools = declaredTools;
	if (body.tool_choice && typeof body.tool_choice === "object" && "type" in body.tool_choice) {
		const choice = body.tool_choice;
		const selected = declaredTools.find(tool => {
			if (tool === null || typeof tool !== "object" || !("type" in tool)) return false;
			if (choice.type === "computer") return tool.type === "computer";
			return (
				choice.type === "function" &&
				tool.type === "function" &&
				"name" in choice &&
				typeof choice.name === "string" &&
				"name" in tool &&
				tool.name === choice.name
			);
		});
		if (selected) {
			additionalTools = [selected];
			body.tool_choice = "required";
		}
	}
	const prefix: InputItem[] = [{ type: "additional_tools", role: "developer", tools: additionalTools }];
	if (typeof body.instructions === "string" && body.instructions.length > 0) {
		prefix.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: body.instructions }],
		});
	}
	body.input = [...prefix, ...input];
	if (body.tool_choice !== "none" && body.tool_choice !== "required") {
		body.tool_choice = "auto";
	}
	delete body.instructions;
	delete body.tools;
}

export async function transformRequestBody(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	options: CodexRequestOptions = {},
	prompt?: { developerMessages: string[] },
): Promise<RequestBody> {
	body.store = false;
	body.stream = true;

	if (body.input && Array.isArray(body.input)) {
		body.input = filterInput(body.input);
		if (body.input) {
			body.input = repairToolCallPairs(body.input);
		}
	}

	if (prompt?.developerMessages && prompt.developerMessages.length > 0) {
		const developerMessages: InputItem[] = prompt.developerMessages.map(text => ({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text }],
		}));
		const input = Array.isArray(body.input) ? body.input : [];
		body.input = [...developerMessages, ...input];
	}

	let finalInstruction = prompt?.developerMessages.findLast(text => text.trim().length > 0);
	if (finalInstruction === undefined && Array.isArray(body.input)) {
		for (let itemIndex = body.input.length - 1; itemIndex >= 0; itemIndex -= 1) {
			const item = body.input[itemIndex];
			if (item.role !== "developer" || !Array.isArray(item.content)) continue;
			for (let partIndex = item.content.length - 1; partIndex >= 0; partIndex -= 1) {
				const part = item.content[partIndex];
				if (
					part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "input_text" &&
					"text" in part &&
					typeof part.text === "string" &&
					part.text.trim().length > 0
				) {
					finalInstruction = part.text;
					break;
				}
			}
			if (finalInstruction !== undefined) break;
		}
	}
	if (finalInstruction === undefined && typeof body.instructions === "string" && body.instructions.trim().length > 0) {
		finalInstruction = body.instructions;
	}
	if (finalInstruction !== undefined) {
		const input = Array.isArray(body.input) ? body.input : [];
		let hasVisibleInput = false;
		for (const item of input) {
			if (item.role !== "developer") {
				hasVisibleInput = true;
				break;
			}
		}
		if (!hasVisibleInput) {
			body.input = [
				...input,
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: finalInstruction }],
				},
			];
		}
	}

	const responsesLite = resolveCodexResponsesLite(model, options.responsesLite);
	if (responsesLite) {
		applyCodexResponsesLiteShape(body);
	}

	if (options.reasoningOff || options.reasoningEffort !== undefined || responsesLite) {
		const reasoningConfig: Partial<ReasoningConfig> = options.reasoningOff
			? { effort: "none" }
			: options.reasoningEffort !== undefined
				? getReasoningConfig(model, options.reasoningEffort, options)
				: {};
		body.reasoning = {
			...body.reasoning,
			...reasoningConfig,
		};
		// Lite requires `all_turns` even for opaque/codenamed model ids. Only explicit
		// full-transport overrides are gated by the known model wire generation.
		if (responsesLite) {
			body.reasoning.context = "all_turns";
		} else if (options.reasoningContext !== undefined) {
			if (options.reasoningContext === "all_turns" && !supportsAllTurnsReasoningContext(model.id)) {
				delete body.reasoning.context;
			} else {
				body.reasoning.context = options.reasoningContext;
			}
		}
	} else {
		delete body.reasoning;
	}
	// Catalog pro aliases (`gpt-5.6-*-pro`): applied after the effort branch so
	// the mode is sent even when no effort is set (the branch above deletes
	// `body.reasoning` in that case) — mode and effort are independent fields.
	if (model.reasoningMode && !options.reasoningOff) {
		body.reasoning = { ...body.reasoning, mode: model.reasoningMode };
	}

	// Concurrent reasoning summaries (codex-rs `concurrent_reasoning_summaries`):
	// `sequential_cutoff` lets the server stream output without blocking on
	// summary generation, delivering each completed section as an atomic
	// `response.reasoning_summary_text.done`. Opt-in only — see
	// {@link concurrentSummariesEnabled} for why. Requires a requested summary;
	// codex-rs additionally gates on its OpenAI provider check, inherent here.
	if (body.reasoning?.summary !== undefined && concurrentSummariesEnabled()) {
		body.stream_options = { reasoning_summary_delivery: "sequential_cutoff" };
	} else {
		delete body.stream_options;
	}

	if (options.textVerbosity !== undefined) {
		body.text = {
			...body.text,
			verbosity: options.textVerbosity,
		};
	}

	const include = Array.isArray(options.include) ? [...options.include] : [];
	include.push("reasoning.encrypted_content");
	body.include = Array.from(new Set(include));

	delete body.max_output_tokens;
	delete body.max_completion_tokens;

	return body;
}
