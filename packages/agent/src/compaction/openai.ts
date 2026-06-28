/**
 * Remote compaction utilities.
 *
 * Provider-side conversation summarization endpoints. Two flavors:
 *
 * - **OpenAI remote compaction** (`/responses/compact`): preserves encrypted
 *   reasoning across compactions by submitting the full responses-API native
 *   history and storing the returned `compaction` / `compaction_summary`
 *   item in `preserveData` so future turns can replay the encrypted state.
 * - **Generic remote compaction**: a thin POST helper for self-hosted
 *   summarization endpoints that accept `{ systemPrompt, prompt }` and reply
 *   with `{ summary, shortSummary? }`.
 */

import { ProviderHttpError } from "@pk-nerdsaver-ai/pi-ai/error";
import { parseAzureDeploymentNameMap, parseTextSignature } from "@pk-nerdsaver-ai/pi-ai/providers/openai-shared";
import { transformMessages } from "@pk-nerdsaver-ai/pi-ai/providers/transform-messages";
import type { Api, AssistantMessage, FetchImpl, Message, Model } from "@pk-nerdsaver-ai/pi-ai/types";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
} from "@pk-nerdsaver-ai/pi-ai/utils";
import {
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@pk-nerdsaver-ai/pi-catalog/wire/codex";
import { $env, logger } from "@pk-nerdsaver-ai/pi-utils";

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
}

export interface OpenAiRemoteCompactionResponse extends OpenAiRemoteCompactionPreserveData {}

export interface RemoteCompactionRequest {
	systemPrompt: string;
	prompt: string;
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

function shouldTrimOpenAiCompactInputItem(item: Record<string, unknown>): boolean {
	return item.type === "function_call_output" || (item.type === "message" && item.role === "developer");
}

function shouldKeepOpenAiCompactOutputItem(item: Record<string, unknown>): boolean {
	if (item.type === "compaction" || item.type === "compaction_summary") return true;
	if (item.type !== "message") return false;
	return item.role === "assistant" || item.role === "user";
}

function trimOpenAiCompactInput(
	input: Array<Record<string, unknown>>,
	contextWindow: number,
	instructions: string,
): Array<Record<string, unknown>> {
	const trimmed = [...input];
	// Per-item serialized sizes are cached and decremented on removal.
	// Re-stringifying the whole input per popped item was O(N²) in total chars
	// — hundreds of MB of stringify churn on a 200k-token codex history,
	// blocking the event loop for seconds (same class as the addOpenAiCallIds
	// fix above).
	const sizes = trimmed.map(item => JSON.stringify(item).length);
	let chars = instructions.length;
	for (const size of sizes) chars += size;
	const removeAt = (index: number): void => {
		chars -= sizes[index] ?? 0;
		trimmed.splice(index, 1);
		sizes.splice(index, 1);
	};
	while (trimmed.length > 0 && Math.ceil(chars / 4) > contextWindow) {
		const last = trimmed[trimmed.length - 1];
		if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") {
			const callId = typeof last.call_id === "string" ? last.call_id : undefined;
			const callType = last.type === "custom_tool_call_output" ? "custom_tool_call" : "function_call";
			removeAt(trimmed.length - 1);
			if (callId) {
				const matchingCallIndex = trimmed.findLastIndex(item => item.type === callType && item.call_id === callId);
				if (matchingCallIndex >= 0) {
					removeAt(matchingCallIndex);
				}
			}
			continue;
		}
		if (!last || !shouldTrimOpenAiCompactInputItem(last)) {
			break;
		}
		removeAt(trimmed.length - 1);
	}
	return trimmed;
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
): void {
	for (const item of items) {
		if (typeof item.call_id !== "string") continue;
		if (item.type === "function_call") {
			knownCallIds.add(item.call_id);
		} else if (item.type === "custom_tool_call") {
			knownCallIds.add(item.call_id);
			customCallIds.add(item.call_id);
		}
	}
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
): Array<Record<string, unknown>> {
	const input: Array<Record<string, unknown>> = previousReplacementHistory ? [...previousReplacementHistory] : [];
	const transformedMessages = transformMessages(messages, model, id => normalizeOpenAiCompactionToolCallId(id));

	let msgIndex = 0;
	const knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	addOpenAiCallIds(input, knownCallIds, customCallIds);
	for (const message of transformedMessages) {
		if (message.role === "user" || message.role === "developer") {
			const providerPayload = (message as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider);
			if (historyItems) {
				input.push(...historyItems);
				addOpenAiCallIds(historyItems, knownCallIds, customCallIds);
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
				if (providerPayload.dt) {
					input.push(...providerPayload.items);
					addOpenAiCallIds(providerPayload.items, knownCallIds, customCallIds);
				} else {
					input.splice(0, input.length, ...providerPayload.items);
					knownCallIds.clear();
					customCallIds.clear();
					addOpenAiCallIds(input, knownCallIds, customCallIds);
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
						arguments: JSON.stringify(block.arguments),
					});
				}
			}

			msgIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			const normalized = normalizeResponsesToolCallId(message.toolCallId);
			if (!knownCallIds.has(normalized.callId)) {
				msgIndex++;
				continue;
			}

			const textOutput = message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const hasImages = message.content.some(block => block.type === "image");
			const outputText = textOutput.length > 0 ? textOutput : hasImages ? "(see attached image)" : "";
			input.push({
				type: customCallIds.has(normalized.callId) ? "custom_tool_call_output" : "function_call_output",
				call_id: normalized.callId,
				output: outputText.toWellFormed(),
			});

			if (hasImages && model.input.includes("image")) {
				const contentBlocks: Array<Record<string, unknown>> = [
					{ type: "input_text", text: "Attached image(s) from tool result:" },
				];
				for (const block of message.content) {
					if (block.type !== "image") continue;
					contentBlocks.push({
						type: "input_image",
						detail: "auto",
						image_url: `data:${block.mimeType};base64,${block.data}`,
					});
				}
				input.push({ type: "message", role: "user", content: contentBlocks });
			}
		}

		msgIndex++;
	}

	return input;
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
	opts?: { fetch?: FetchImpl; timeoutMs?: number },
): Promise<OpenAiRemoteCompactionResponse> {
	const endpoint = resolveOpenAiCompactEndpoint(model);
	const requestModel = resolveOpenAiCompactModel(model);
	const request: OpenAiRemoteCompactionRequest = {
		model: requestModel,
		input: trimOpenAiCompactInput(compactInput, model.contextWindow ?? Number.POSITIVE_INFINITY, instructions),
		instructions,
	};
	const isAzureOpenAiResponses = (model.remoteCompaction?.api ?? model.api) === "azure-openai-responses";
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
	if (model.provider === "openai-codex") {
		const accountId = getCodexAccountId(apiKey);
		if (accountId) {
			headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
		}
		headers[OPENAI_HEADERS.BETA] = OPENAI_HEADER_VALUES.BETA_RESPONSES;
		headers[OPENAI_HEADERS.ORIGINATOR] = OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	}

	const response = await (opts?.fetch ?? fetch)(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(request),
		signal: withRequestTimeout(signal, opts?.timeoutMs ?? REMOTE_COMPACTION_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		logger.warn("OpenAI remote compaction failed", {
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

export async function requestRemoteCompaction(
	endpoint: string,
	request: RemoteCompactionRequest,
	signal?: AbortSignal,
	opts?: { fetch?: FetchImpl; timeoutMs?: number },
): Promise<RemoteCompactionResponse> {
	const response = await (opts?.fetch ?? fetch)(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
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

	const data = (await response.json()) as RemoteCompactionResponse | undefined;
	if (!data || typeof data.summary !== "string") {
		throw new Error("Remote compaction response missing summary");
	}

	return data;
}
