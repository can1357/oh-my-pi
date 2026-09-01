/**
 * Remote compaction utilities.
 *
 * Provider-side conversation summarization endpoints. Three flavors:
 *
 * - **OpenAI remote compaction V2** (Responses streaming): appends a
 *   `compaction_trigger` input item to the normal stream and stores the returned
 *   `compaction` item with retained real user messages in `preserveData`.
 * - **OpenAI remote compaction V1** (`/responses/compact`): preserves encrypted
 *   reasoning across compactions by submitting the full responses-API native
 *   history and storing the returned `compaction` / `compaction_summary`
 *   item in `preserveData` so future turns can replay the encrypted state.
 * - **Generic remote compaction**: a thin POST helper for self-hosted
 *   summarization endpoints that accept `{ systemPrompt, prompt }` and reply
 *   with `{ summary, shortSummary? }`.
 */

import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { applyCodexResponsesLiteShape } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import {
	createOpenAICodexCompactionRequestContext,
	createOpenAICodexCompatibilityMetadata,
	getCodexAttestationHeader,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	encodeResponsesToolResultOutput,
	hoistInterleavedResponsesToolBatchMessages,
	parseAzureDeploymentNameMap,
	parseTextSignature,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type {
	Api,
	AssistantMessage,
	CodexCompactionContext,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
	stripOpenAIResponsesOutputOnlyStatusesForReplay,
} from "@oh-my-pi/pi-ai/utils";
import { captureOpenAIHttpError } from "@oh-my-pi/pi-ai/utils/openai-http";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { $env, isRecord, logger, prompt, stringifyJson, structuredCloneJSON } from "@oh-my-pi/pi-utils";
import { Tokenizer } from "../tokenizer";
import contextWindowTruncatedOutputPrompt from "./prompts/context-window-truncated-output.md" with { type: "text" };

export * from "./compaction-v2-streaming";

// ============================================================================
// Public types
// ============================================================================

export const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = "openaiRemoteCompaction";

/**
 * Hard ceiling on remote compaction HTTP requests. Unlike every provider
 * stream (guarded by first-event/idle watchdogs in pi-ai), these are raw
 * fetches awaiting one non-streamed JSON body — a connection silently dropped
 * by a middlebox would otherwise hang the whole compaction pipeline forever
 * (frozen "Auto context-full maintenance…" spinner, manual /compact queueing
 * behind it). On timeout the caller falls back to local summarization.
 */
export const REMOTE_COMPACTION_TIMEOUT_MS = 180_000;

const DEFAULT_AZURE_API_VERSION = "v1";

export const CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE = prompt.render(contextWindowTruncatedOutputPrompt);

const REMOTE_COMPACTION_REQUEST_OVERHEAD_TOKENS = 256;
const REMOTE_COMPACTION_IMAGE_TOKEN_ESTIMATE = 12_000;
const TOOL_RESULT_IMAGE_ATTACHMENT_TEXT = "Attached image(s) from tool result:";

interface NormalizedEstimateValue {
	value: unknown;
	imageTokens: number;
}

function normalizeRemoteCompactionEstimateValue(value: unknown): NormalizedEstimateValue {
	if (Array.isArray(value)) {
		const normalized: unknown[] = [];
		let imageTokens = 0;
		for (const item of value) {
			const result = normalizeRemoteCompactionEstimateValue(item);
			normalized.push(result.value);
			imageTokens += result.imageTokens;
		}
		return { value: normalized, imageTokens };
	}
	if (!value || typeof value !== "object") return { value, imageTokens: 0 };

	const record = value as Record<string, unknown>;
	if (record.type === "input_image") {
		return {
			value: { ...record, image_url: "<image>" },
			imageTokens: REMOTE_COMPACTION_IMAGE_TOKEN_ESTIMATE,
		};
	}

	const normalized: Record<string, unknown> = {};
	let imageTokens = 0;
	for (const [key, item] of Object.entries(record)) {
		const result = normalizeRemoteCompactionEstimateValue(item);
		normalized[key] = result.value;
		imageTokens += result.imageTokens;
	}
	return { value: normalized, imageTokens };
}

export interface TrimRemoteCompactionInputResult {
	input: Array<Record<string, unknown>>;
	rewrittenOutputs: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
}

/** Verdict for one remote-compaction request measured against the model window. */
interface RemoteCompactionBudgetProbe {
	/** Estimated request tokens; the text part is exact when the cheap bound busted. */
	tokens: number;
	/** Whether the request fits the window. Always true when no window is known. */
	fits: boolean;
}

/**
 * Cheap-first sizing of a remote-compaction request. Images and the request
 * frame are charged flat, so they come off the budget rather than through the
 * tokenizer; the serialized transcript is then probed with
 * {@link Tokenizer.checkTokenBudget}, which only pays for an exact count when
 * the byte bound cannot already prove the request fits.
 */
function probeRemoteCompactionInputBudget(
	input: Array<Record<string, unknown>>,
	tokenizer: Tokenizer,
	instructions: string,
	tools: unknown[] | undefined,
	contextWindow: number | null | undefined,
): RemoteCompactionBudgetProbe {
	const normalized = normalizeRemoteCompactionEstimateValue({ instructions, input, ...(tools ? { tools } : {}) });
	const serialized = stringifyJson(normalized.value) ?? "";
	const flatTokens = normalized.imageTokens + REMOTE_COMPACTION_REQUEST_OVERHEAD_TOKENS;
	if (!contextWindow || contextWindow <= 0) {
		return { tokens: tokenizer.countTokens(serialized, "upperbound") + flatTokens, fits: true };
	}
	const budget = tokenizer.checkTokenBudget(serialized, Math.max(0, contextWindow - flatTokens));
	return { tokens: budget.tokens + flatTokens, fits: budget.fits };
}

function rewriteToolOutputForContextWindow(item: Record<string, unknown>): Record<string, unknown> | undefined {
	if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
		return { ...item, output: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE };
	}
	if (item.type === "tool_search_output") {
		return { ...item, tools: [] };
	}
	return undefined;
}

function isToolResultImageAttachment(item: Record<string, unknown>): boolean {
	if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) return false;

	let hasLabel = false;
	let hasImage = false;
	for (const block of item.content) {
		if (!isRecord(block)) continue;
		if (block.type === "input_text" && block.text === TOOL_RESULT_IMAGE_ATTACHMENT_TEXT) hasLabel = true;
		if (block.type === "input_image") hasImage = true;
	}
	return hasLabel && hasImage;
}

/**
 * Preserve the full native transcript unless trailing tool outputs alone push a
 * remote compaction request beyond the model window. Replacing only those
 * outputs keeps call/result pairing and all earlier assistant/reasoning history,
 * matching Codex's recovery path for oversized tool turns.
 */
export function trimRemoteCompactionInputToContextWindow(
	input: Array<Record<string, unknown>>,
	tokenizer: Tokenizer,
	contextWindow: number | null | undefined,
	instructions: string,
	tools?: unknown[],
): TrimRemoteCompactionInputResult {
	const before = probeRemoteCompactionInputBudget(input, tokenizer, instructions, tools, contextWindow);
	if (before.fits) {
		return {
			input,
			rewrittenOutputs: 0,
			estimatedTokensBefore: before.tokens,
			estimatedTokensAfter: before.tokens,
		};
	}

	let rewrittenInput: Array<Record<string, unknown>> | undefined;
	let after = before;
	let rewrittenOutputs = 0;
	for (let index = input.length - 1; index >= 0 && !after.fits; index--) {
		const item = input[index];
		if (isToolResultImageAttachment(item)) continue;
		const rewritten = rewriteToolOutputForContextWindow(item);
		if (!rewritten) break;
		rewrittenInput ??= input.slice();
		rewrittenInput[index] = rewritten;
		rewrittenOutputs++;
		after = probeRemoteCompactionInputBudget(rewrittenInput, tokenizer, instructions, tools, contextWindow);
	}

	if (!rewrittenInput || !after.fits) {
		return {
			input,
			rewrittenOutputs: 0,
			estimatedTokensBefore: before.tokens,
			estimatedTokensAfter: before.tokens,
		};
	}

	return {
		input: rewrittenInput,
		rewrittenOutputs,
		estimatedTokensBefore: before.tokens,
		estimatedTokensAfter: after.tokens,
	};
}

/** Race the caller's signal against the request timeout; `timeoutMs <= 0` disables the watchdog. */
function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
	if (timeoutMs <= 0) return signal;
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type OpenAiRemoteCompactionItem = {
	type: "compaction" | "compaction_summary";
	encrypted_content?: string;
	summary?: string;
};

export interface OpenAiRemoteCompactionPreserveData {
	provider?: string;
	replacementHistory: Array<Record<string, unknown>>;
	compactionItem: OpenAiRemoteCompactionItem;
}

export interface OpenAiRemoteCompactionRequest {
	model: string;
	input: Array<Record<string, unknown>>;
	instructions: string;
	reasoning?: {
		context?: string;
		[key: string]: unknown;
	};
	include?: string[];
}

export interface OpenAiRemoteCompactionResponse extends OpenAiRemoteCompactionPreserveData {}

export interface RemoteCompactionRequest {
	systemPrompt: string;
	prompt: string;
	maxTokens?: number;
}

export interface RemoteCompactionResponse {
	summary: string;
	shortSummary?: string;
}

// ============================================================================
// OpenAI provider gating + endpoint resolution
// ============================================================================

function isOpenAiRemoteCompactionApi(api: Api | undefined): boolean {
	return api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses";
}

export function shouldUseOpenAiRemoteCompaction(model: Model): boolean {
	if (model.remoteCompaction?.enabled === false) return false;
	if (model.provider === "openai" || model.provider === "openai-codex") return true;
	if (model.remoteCompaction?.enabled !== true) return false;
	return isOpenAiRemoteCompactionApi(model.remoteCompaction.api ?? model.api);
}

function resolveOpenAiCompactEndpoint(model: Model): string {
	const configuredEndpoint = model.remoteCompaction?.endpoint;
	const compactionApi = model.remoteCompaction?.api ?? model.api;
	if (compactionApi === "azure-openai-responses") {
		return resolveAzureOpenAiCompactEndpoint(model, configuredEndpoint);
	}
	if (configuredEndpoint && configuredEndpoint.length > 0) return configuredEndpoint;
	if (model.provider === "openai-codex" || compactionApi === "openai-codex-responses") {
		return resolveOpenAiCodexCompactEndpoint(model.baseUrl);
	}

	const defaultBase = "https://api.openai.com/v1";
	const rawBase = model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : defaultBase;
	const normalizedBase = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
	if (normalizedBase.endsWith("/v1")) return `${normalizedBase}/responses/compact`;
	return `${normalizedBase}/v1/responses/compact`;
}

function resolveAzureOpenAiCompactEndpoint(model: Model, configuredEndpoint: string | undefined): string {
	const endpoint =
		configuredEndpoint && configuredEndpoint.length > 0
			? configuredEndpoint
			: `${resolveAzureOpenAiBaseUrl(model)}/responses/compact`;
	return appendAzureApiVersion(endpoint);
}

function resolveAzureOpenAiBaseUrl(model: Model): string {
	const baseUrl = $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = $env.AZURE_OPENAI_RESOURCE_NAME;
	const resolvedBaseUrl =
		baseUrl ?? (resourceName ? `https://${resourceName}.openai.azure.com/openai/v1` : undefined) ?? model.baseUrl;
	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or configure model.baseUrl.",
		);
	}
	return resolvedBaseUrl.replace(/\/+$/, "");
}

function appendAzureApiVersion(endpoint: string): string {
	if (/[?&]api-version=/.test(endpoint)) return endpoint;
	const separator = endpoint.includes("?") ? "&" : "?";
	return `${endpoint}${separator}api-version=${encodeURIComponent($env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION)}`;
}

function resolveOpenAiCompactModel(model: Model): string {
	const requestModel = model.remoteCompaction?.model ?? model.requestModelId ?? model.id;
	const compactionApi = model.remoteCompaction?.api ?? model.api;
	if (compactionApi !== "azure-openai-responses") return requestModel;
	const mappedDeployment = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(requestModel);
	return mappedDeployment ?? requestModel;
}

function resolveOpenAiCodexCompactEndpoint(baseUrl: string | undefined): string {
	const rawBase = baseUrl && baseUrl.length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalizedBase = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
	if (/\/codex(?:\/v\d+)?$/.test(normalizedBase)) return `${normalizedBase}/responses/compact`;
	return `${normalizedBase}/codex/responses/compact`;
}

function normalizeOpenAiCompactionToolCallId(id: string): string {
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId ?? normalized.callId}`;
}

// ============================================================================
// Preserve-data helpers
// ============================================================================

export function getPreservedOpenAiRemoteCompactionData(
	preserveData: Record<string, unknown> | undefined,
): OpenAiRemoteCompactionPreserveData | undefined {
	const candidate = preserveData?.[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const maybeData = candidate as { provider?: unknown; replacementHistory?: unknown; compactionItem?: unknown };
	if (!Array.isArray(maybeData.replacementHistory)) return undefined;
	const maybeItem = maybeData.compactionItem;
	if (!maybeItem || typeof maybeItem !== "object") return undefined;
	const compactionItem = maybeItem as { type?: unknown; encrypted_content?: unknown; summary?: unknown };
	const isClassicCompaction =
		compactionItem.type === "compaction" && typeof compactionItem.encrypted_content === "string";
	const isSummaryCompaction = compactionItem.type === "compaction_summary";
	if (!isClassicCompaction && !isSummaryCompaction) {
		return undefined;
	}
	return {
		provider: typeof maybeData.provider === "string" ? maybeData.provider : undefined,
		replacementHistory: maybeData.replacementHistory as Array<Record<string, unknown>>,
		compactionItem: compactionItem as unknown as OpenAiRemoteCompactionItem,
	};
}

export function withOpenAiRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
	remoteCompaction: OpenAiRemoteCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
	if (remoteCompaction) {
		return {
			...(preserveData ?? {}),
			[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: remoteCompaction,
		};
	}

	if (!preserveData || !(OPENAI_REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) {
		return preserveData;
	}

	const { [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

// ============================================================================
// Input/output filtering for OpenAI compact endpoint
// ============================================================================

function shouldKeepOpenAiCompactOutputItem(item: Record<string, unknown>): boolean {
	if (item.type === "compaction" || item.type === "compaction_summary") return true;
	if (item.type !== "message") return false;
	return item.role === "assistant" || item.role === "user";
}

// Register every tool-call id in `items` (and the subset using the custom-tool
// wire shape) into the running sets. The history builder maintains both sets
// incrementally as native history is appended, so this only scans the
// newly-added items (or, after a full-snapshot replace, the fresh input) rather
// than re-scanning the whole growing history per message — the latter was
// O(N²) and blocked the event loop for seconds while compacting large codex
// contexts (frozen spinner until the next forced render).
function addOpenAiCallIds(
	items: Array<Record<string, unknown>>,
	knownCallIds: Set<string>,
	customCallIds: Set<string>,
	computerCallIds: Set<string>,
): void {
	for (const item of items) {
		if (typeof item.call_id !== "string") continue;
		if (item.type === "function_call") {
			knownCallIds.add(item.call_id);
		} else if (item.type === "custom_tool_call") {
			knownCallIds.add(item.call_id);
			customCallIds.add(item.call_id);
		} else if (item.type === "computer_call") {
			knownCallIds.add(item.call_id);
			computerCallIds.add(item.call_id);
		}
	}
}

function computerHistoryNote(item: Record<string, unknown>): Record<string, unknown> {
	const serialized = stringifyJson(item) ?? "";
	return {
		type: "message",
		id: `msg_${Bun.hash(`computer-history:${serialized}`).toString(36)}`,
		role: "assistant",
		content: [
			{
				type: "output_text",
				text: `[Previous computer history unavailable to this model]: ${serialized}`,
				annotations: [],
			},
		],
		status: "completed",
	};
}

function adaptComputerHistoryForCompaction(
	items: Array<Record<string, unknown>>,
	supportsComputerUse: boolean,
): Array<Record<string, unknown>> {
	if (supportsComputerUse) return items;
	return items.map(item =>
		item.type === "computer_call" || item.type === "computer_call_output" ? computerHistoryNote(item) : item,
	);
}

function computerFailureNote(call: Record<string, unknown>, output: string): Record<string, unknown> {
	const serialized = stringifyJson(call) ?? "";
	return {
		type: "message",
		id: `msg_${Bun.hash(`computer-failure:${serialized}:${output}`).toString(36)}`,
		role: "assistant",
		content: [
			{
				type: "output_text",
				text: `[Computer call failed before a screenshot was recorded]: ${serialized}${output ? `\n${output}` : ""}`,
				annotations: [],
			},
		],
		status: "completed",
	};
}

// ============================================================================
// Native history construction (responses-API shape)
// ============================================================================

/**
 * Build the OpenAI Responses-API native history array from LLM messages.
 *
 * Caller is responsible for converting any custom message types to
 * `Message[]` first (e.g. via the agent's `convertToLlm`); this function
 * operates purely on the LLM-domain shape.
 *
 * @param messages - LLM messages to encode.
 * @param model - Target model (used for provider gating + tool-call id rules).
 * @param previousReplacementHistory - History from a prior compaction whose
 *   encrypted reasoning we want to preserve.
 */
export function buildOpenAiNativeHistory(
	messages: Message[],
	model: Model,
	previousReplacementHistory?: Array<Record<string, unknown>>,
	supportsImageDetailOriginal = false,
): Array<Record<string, unknown>> {
	const input: Array<Record<string, unknown>> = previousReplacementHistory
		? adaptComputerHistoryForCompaction([...previousReplacementHistory], model.supportsComputerUse === true)
		: [];
	const transformedMessages = transformMessages(messages, model, id => normalizeOpenAiCompactionToolCallId(id));

	let msgIndex = 0;
	const knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	const computerCallIds = new Set<string>();
	const demotedComputerCallIds = new Set<string>();
	addOpenAiCallIds(input, knownCallIds, customCallIds, computerCallIds);
	for (const message of transformedMessages) {
		if (message.role === "user" || message.role === "developer") {
			const providerPayload = (message as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const rawHistoryItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider);
			if (rawHistoryItems) {
				if (model.supportsComputerUse !== true) {
					for (const item of rawHistoryItems) {
						if (item.type === "computer_call" && typeof item.call_id === "string") {
							demotedComputerCallIds.add(item.call_id);
						}
					}
				}
				const historyItems = adaptComputerHistoryForCompaction(rawHistoryItems, model.supportsComputerUse === true);
				input.push(...historyItems);
				addOpenAiCallIds(historyItems, knownCallIds, customCallIds, computerCallIds);
				msgIndex++;
				continue;
			}

			const contentBlocks: Array<Record<string, unknown>> = [];
			if (typeof message.content === "string") {
				if (message.content.trim().length > 0) {
					contentBlocks.push({ type: "input_text", text: message.content.toWellFormed() });
				}
			} else {
				for (const block of message.content) {
					if (block.type === "text") {
						if (!block.text || block.text.trim().length === 0) continue;
						contentBlocks.push({ type: "input_text", text: block.text.toWellFormed() });
						continue;
					}
					if (block.type === "image") {
						contentBlocks.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}
			}
			if (contentBlocks.length > 0) {
				input.push({ type: "message", role: message.role, content: contentBlocks });
			}
			msgIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			const providerPayload = getOpenAIResponsesHistoryPayload(
				assistant.providerPayload,
				model.provider,
				assistant.provider,
			);
			if (providerPayload) {
				if (!providerPayload.dt) demotedComputerCallIds.clear();
				if (model.supportsComputerUse !== true) {
					for (const item of providerPayload.items) {
						if (item.type === "computer_call" && typeof item.call_id === "string") {
							demotedComputerCallIds.add(item.call_id);
						}
					}
				}
				const historyItems = adaptComputerHistoryForCompaction(
					providerPayload.items,
					model.supportsComputerUse === true,
				);
				if (providerPayload.dt) {
					input.push(...historyItems);
					addOpenAiCallIds(historyItems, knownCallIds, customCallIds, computerCallIds);
				} else {
					input.splice(0, input.length, ...historyItems);
					knownCallIds.clear();
					customCallIds.clear();
					computerCallIds.clear();
					addOpenAiCallIds(input, knownCallIds, customCallIds, computerCallIds);
				}
				msgIndex++;
				continue;
			}
			const isDifferentModel =
				assistant.model !== model.id && assistant.provider === model.provider && assistant.api === model.api;

			for (const block of assistant.content) {
				if (block.type === "thinking" && assistant.stopReason !== "error" && block.thinkingSignature) {
					try {
						const reasoningItem = JSON.parse(block.thinkingSignature) as Record<string, unknown>;
						if (reasoningItem && typeof reasoningItem === "object") {
							input.push(reasoningItem);
						}
					} catch {
						logger.warn("Failed to parse assistant reasoning for remote compaction", {
							model: assistant.model,
							provider: assistant.provider,
						});
					}
					continue;
				}

				if (block.type === "text") {
					if (!block.text || block.text.trim().length === 0) continue;
					const parsedSignature = parseTextSignature(block.textSignature);
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${Bun.hash(msgId).toString(36)}`;
					}
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					});
					continue;
				}

				if (block.type === "toolCall") {
					const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
					if (block.providerMetadata?.type === "computer") {
						const computerCall = {
							type: "computer_call",
							id: block.providerMetadata.providerItemId,
							call_id: normalized.callId,
							actions: structuredCloneJSON(block.providerMetadata.actions),
							pending_safety_checks: structuredCloneJSON(block.providerMetadata.pendingSafetyChecks),
							status: "completed",
						};
						if (model.supportsComputerUse !== true) {
							input.push(computerHistoryNote(computerCall));
							demotedComputerCallIds.add(normalized.callId);
							continue;
						}
						knownCallIds.add(normalized.callId);
						computerCallIds.add(normalized.callId);
						input.push(computerCall);
						continue;
					}
					let itemId: string | undefined = normalized.itemId;
					if (
						isDifferentModel &&
						(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
					) {
						itemId = undefined;
					}
					knownCallIds.add(normalized.callId);
					if (block.customWireName) {
						const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
						customCallIds.add(normalized.callId);
						input.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: normalized.callId,
							name: block.customWireName,
							input: rawInput,
						});
						continue;
					}
					input.push({
						type: "function_call",
						id: itemId,
						call_id: normalized.callId,
						name: block.name,
						arguments: stringifyJson(block.arguments) ?? "null",
					});
				}
			}

			msgIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			const normalized = normalizeResponsesToolCallId(message.toolCallId);
			const { output, outputText } = encodeResponsesToolResultOutput(message, model, supportsImageDetailOriginal);
			if (demotedComputerCallIds.has(normalized.callId)) {
				const resultItem =
					message.providerMetadata?.type === "computer"
						? {
								type: "computer_call_output",
								call_id: normalized.callId,
								output: structuredCloneJSON(message.providerMetadata.screenshot),
								acknowledged_safety_checks: structuredCloneJSON(
									message.providerMetadata.acknowledgedSafetyChecks,
								),
							}
						: { type: "computer_call_output", call_id: normalized.callId, error: outputText };
				input.push(computerHistoryNote(resultItem));
				demotedComputerCallIds.delete(normalized.callId);
				msgIndex++;
				continue;
			}
			if (!knownCallIds.has(normalized.callId)) {
				msgIndex++;
				continue;
			}
			if (computerCallIds.has(normalized.callId)) {
				if (message.providerMetadata?.type === "computer") {
					input.push({
						type: "computer_call_output",
						call_id: normalized.callId,
						output: structuredCloneJSON(message.providerMetadata.screenshot),
						acknowledged_safety_checks: structuredCloneJSON(message.providerMetadata.acknowledgedSafetyChecks),
					});
					msgIndex++;
					continue;
				}

				const callIndex = input.findLastIndex(
					item => item.type === "computer_call" && item.call_id === normalized.callId,
				);
				if (callIndex >= 0) {
					const [call] = input.splice(callIndex, 1);
					if (call) input.splice(callIndex, 0, computerFailureNote(call, outputText));
				}
				knownCallIds.delete(normalized.callId);
				computerCallIds.delete(normalized.callId);
				msgIndex++;
				continue;
			}

			input.push({
				type: customCallIds.has(normalized.callId) ? "custom_tool_call_output" : "function_call_output",
				call_id: normalized.callId,
				output,
			});
		}

		msgIndex++;
	}

	return stripOpenAIResponsesOutputOnlyStatusesForReplay(hoistInterleavedResponsesToolBatchMessages(input));
}

// ============================================================================
// Endpoint requests
// ============================================================================
export async function requestOpenAiRemoteCompaction(
	model: Model,
	apiKey: string,
	compactInput: Array<Record<string, unknown>>,
	instructions: string,
	signal?: AbortSignal,
	opts?: {
		fetch?: FetchImpl;
		timeoutMs?: number;
		sessionId?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
		codexCompaction?: CodexCompactionContext;
	},
): Promise<OpenAiRemoteCompactionResponse> {
	const endpoint = resolveOpenAiCompactEndpoint(model);
	const requestModel = resolveOpenAiCompactModel(model);
	const trimmed = trimRemoteCompactionInputToContextWindow(
		compactInput,
		new Tokenizer(model),
		model.contextWindow,
		instructions,
	);
	if (trimmed.rewrittenOutputs > 0) {
		logger.info("Rewrote trailing tool outputs before OpenAI remote compaction", {
			model: model.id,
			provider: model.provider,
			rewrittenOutputs: trimmed.rewrittenOutputs,
			estimatedTokensBefore: trimmed.estimatedTokensBefore,
			estimatedTokensAfter: trimmed.estimatedTokensAfter,
			contextWindow: model.contextWindow,
		});
	}
	const request: OpenAiRemoteCompactionRequest = {
		model: requestModel,
		// Preserve the native transcript. Only oversized trailing tool outputs are
		// rewritten above, reducing the request without losing assistant turns,
		// reasoning, or call/result pairing.
		input: trimmed.input,
		instructions,
	};
	const isAzureOpenAiResponses = (model.remoteCompaction?.api ?? model.api) === "azure-openai-responses";
	const isCodexResponses =
		model.provider === "openai-codex" || (model.remoteCompaction?.api ?? model.api) === "openai-codex-responses";
	const headers: Record<string, string> = isAzureOpenAiResponses
		? {
				"content-type": "application/json",
				"api-key": apiKey,
				...(model.headers ?? {}),
			}
		: {
				"content-type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				...(model.headers ?? {}),
			};

	// Codex endpoints require additional auth headers
	if (isCodexResponses) {
		const accountId = getCodexAccountId(apiKey);
		if (accountId) {
			headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
		}
		applyCodexResidencyHeader(headers, apiKey);
		const attestation = await getCodexAttestationHeader(accountId);
		if (attestation) {
			headers[OPENAI_HEADERS.ATTESTATION] = attestation;
		}
		headers[OPENAI_HEADERS.BETA] = OPENAI_HEADER_VALUES.BETA_RESPONSES;
		headers[OPENAI_HEADERS.ORIGINATOR] = OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
		Object.assign(
			headers,
			createOpenAICodexCompatibilityMetadata({
				sessionId: opts?.sessionId,
				providerSessionState: opts?.providerSessionState,
				requestKind: "compaction",
				compaction: createOpenAICodexCompactionRequestContext({
					context: opts?.codexCompaction,
					implementation: "responses_compact",
				}),
				includeInstallationHeader: true,
			}).headers,
		);
		// Responses Lite models take the same rewrite on `/responses/compact`:
		// instructions ride as an input item and the lite marker header is set
		// (codex-rs routes compaction through `build_responses_request`).
		if (model.useResponsesLite) {
			applyCodexResponsesLiteShape(request);
			headers[OPENAI_HEADERS.RESPONSES_LITE] = "true";
			request.reasoning = {
				...request.reasoning,
				context: "all_turns",
			};
			request.include = Array.from(new Set([...(request.include ?? []), "reasoning.encrypted_content"]));
		}
	}

	const response = await (opts?.fetch ?? fetch)(endpoint, {
		method: "POST",
		headers,
		body: stringifyJson(request),
		signal: withRequestTimeout(signal, opts?.timeoutMs ?? REMOTE_COMPACTION_TIMEOUT_MS),
	});

	if (!response.ok) {
		const cause = await captureOpenAIHttpError(response);
		logger.warn("OpenAI remote compaction failed", {
			endpoint,
			status: response.status,
			statusText: response.statusText,
			errorText: cause.captured.bodyText ?? "",
		});
		throw new ProviderHttpError(
			`Remote compaction failed (${response.status} ${response.statusText})`,
			response.status,
			{
				headers: response.headers,
				cause,
			},
		);
	}

	const data = (await response.json()) as { output?: unknown[] } | undefined;
	const rawOutput = data?.output ?? [];
	const replacementHistory = rawOutput.filter(
		(item): item is Record<string, unknown> =>
			!!item && typeof item === "object" && shouldKeepOpenAiCompactOutputItem(item as Record<string, unknown>),
	);
	const compactionItem = replacementHistory.findLast((item): item is OpenAiRemoteCompactionItem => {
		if (item.type === "compaction" && typeof item.encrypted_content === "string") return true;
		if (item.type === "compaction_summary") return true;
		return false;
	});
	if (!compactionItem) {
		const outputTypes = rawOutput.map(item =>
			typeof item === "object" && item !== null ? (item as Record<string, unknown>).type : typeof item,
		);
		logger.warn("Remote compaction response missing compaction item", {
			endpoint,
			model: model.id,
			provider: model.provider,
			rawOutputLength: rawOutput.length,
			outputTypes,
			replacementHistoryLength: replacementHistory.length,
		});
		throw new Error("Remote compaction response missing compaction item");
	}
	return { provider: model.provider, replacementHistory, compactionItem };
}

/**
 * Generic remote-compaction POST. Two wire shapes are auto-selected by
 * endpoint suffix so a single `compaction.remoteEndpoint` setting can point at
 * either a purpose-built omp summarizer (`{systemPrompt, prompt}` → `{summary}`)
 * or any OpenAI-compatible chat-completions server (`/chat/completions`,
 * `/v1/chat/completions`, …) as reported for llama.cpp / vLLM / etc. in
 * issue #4630: without this, the omp payload was rejected with
 * HTTP 400 `"'messages' is required"`, compaction silently fell back to
 * local summarization, and context grew unbounded.
 *
 * When `context.model` is provided the chat-completions body is tagged with
 * that model's wire id (llama.cpp requires the field) and `context.apiKey` is
 * forwarded as `Authorization: Bearer`. Callers wrap this in `withAuth` so
 * 401s force-refresh through the standard credential rotation policy.
 */
export async function requestRemoteCompaction(
	endpoint: string,
	request: RemoteCompactionRequest,
	signal?: AbortSignal,
	opts?: { fetch?: FetchImpl; timeoutMs?: number; model?: Model; apiKey?: string },
): Promise<RemoteCompactionResponse> {
	let endpointPath = endpoint;
	try {
		endpointPath = new URL(endpoint).pathname;
	} catch {
		// Keep the raw endpoint for relative/custom fetch implementations.
	}
	const isChatCompletions = /\/chat\/completions\/?$/.test(endpointPath);
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (isChatCompletions) {
		if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
		if (opts?.model?.headers) Object.assign(headers, opts.model.headers);
	}

	const body: Record<string, unknown> = isChatCompletions
		? {
				model: opts?.model ? resolveOpenAiCompactModel(opts.model) : undefined,
				messages: [
					{ role: "system", content: request.systemPrompt },
					{ role: "user", content: request.prompt },
				],
				stream: false,
				max_tokens: request.maxTokens,
			}
		: { systemPrompt: request.systemPrompt, prompt: request.prompt, maxTokens: request.maxTokens };

	const response = await (opts?.fetch ?? fetch)(endpoint, {
		method: "POST",
		headers,
		body: stringifyJson(body),
		signal: withRequestTimeout(signal, opts?.timeoutMs ?? REMOTE_COMPACTION_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		logger.warn("Remote compaction failed", {
			endpoint,
			status: response.status,
			statusText: response.statusText,
			errorText,
		});
		throw new ProviderHttpError(
			`Remote compaction failed (${response.status} ${response.statusText})`,
			response.status,
			{
				headers: response.headers,
			},
		);
	}

	if (isChatCompletions) {
		type ChatCompletionsResponse = {
			choices?: Array<{
				message?: {
					content?: string | Array<{ type?: string; text?: string }> | null;
				};
			}>;
		};
		const data = (await response.json()) as ChatCompletionsResponse | undefined;
		const choice = data?.choices?.[0]?.message?.content;
		let summary: string | undefined;
		if (typeof choice === "string") {
			summary = choice;
		} else if (Array.isArray(choice)) {
			summary = choice
				.filter((part): part is { type?: string; text: string } => typeof part?.text === "string")
				.map(part => part.text)
				.join("");
		}
		if (typeof summary !== "string" || summary.length === 0) {
			throw new Error("Remote compaction response missing choices[0].message.content");
		}
		return { summary };
	}

	const data = (await response.json()) as RemoteCompactionResponse | undefined;
	if (!data || typeof data.summary !== "string") {
		throw new Error("Remote compaction response missing summary");
	}

	return data;
}
