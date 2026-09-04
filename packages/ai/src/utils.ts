import { $env } from "@oh-my-pi/pi-utils";
import type { ResponseInput, ResponseInputItem } from "./providers/openai-responses-wire";
import { redactSensitiveCredentials } from "./providers/transform-messages";
import type { CacheRetention, OpenAIResponsesHistoryPayload, ProviderPayload } from "./types";

type OpenAIResponsesReplayItem = ResponseInput[number];
const NON_WHITESPACE_RE = /\S/;

export { isRecord } from "@oh-my-pi/pi-utils";
/**
 * Read a header value ignoring key casing. HTTP header names are
 * case-insensitive, but `Record<string, string>` header bags are not, so a
 * config-authored `User-Agent` and a caller-authored `user-agent` are the same
 * header to every provider that lowercases before merging.
 */
export function getHeaderCaseInsensitive(
	headers: Record<string, string> | undefined,
	headerName: string,
): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

export function normalizeSystemPrompts(systemPrompt: readonly string[] | string | undefined | null): string[] {
	if (systemPrompt === undefined || systemPrompt === null) return [];
	const prompts = Array.isArray(systemPrompt) ? systemPrompt : typeof systemPrompt === "string" ? [systemPrompt] : [];
	return prompts
		.map(prompt => redactSensitiveCredentials(prompt.toWellFormed()))
		.filter(prompt => prompt.trim().length > 0);
}

export function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

type ResponsesToolItemIdPrefix = "fc" | "ctc";

/** Preserve opaque call IDs for Responses replay while normalizing or generating the separate item ID. */
export function normalizeResponsesToolCallId(
	id: string,
	itemPrefix: ResponsesToolItemIdPrefix = "fc",
): { callId: string; itemId: string } {
	const [callId, itemId] = id.split("|");
	if (callId && itemId) {
		return { callId, itemId: normalizeResponsesItemId(itemId, itemPrefix) };
	}
	const hash = Bun.hash(id).toString(36);
	return { callId: id, itemId: `${itemPrefix}_${hash}` };
}

function getExplicitIdPrefix(id: string): string | undefined {
	return id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
}

function normalizeResponsesItemId(itemId: string, fallbackPrefix: ResponsesToolItemIdPrefix): string {
	const prefix = getExplicitIdPrefix(itemId);
	const isAllowedPrefix = prefix
		? fallbackPrefix === "ctc"
			? prefix === "ctc"
			: prefix === "fc" || prefix === "fcr"
		: false;
	if (!prefix || !isAllowedPrefix) {
		return `${fallbackPrefix}_${Bun.hash(itemId).toString(36)}`;
	}
	return truncateResponseItemId(itemId, prefix);
}

/**
 * Truncate an OpenAI Responses API item ID to 64 characters.
 * IDs exceeding the limit are replaced with a hash-based ID using the given prefix.
 */
export function truncateResponseItemId(id: string, prefix: string): string {
	if (id.length <= 64) return id;
	return `${prefix}_${Bun.hash(id).toString(36)}`;
}

interface OpenAIResponsesReplaySanitizeOptions {
	supportsImageDetailOriginal?: boolean;
	supportsComputerUse?: boolean;
}
/**
 * Removes response-only lifecycle status from item types that reject it when replayed as input.
 *
 * Returns the original array when no item needs sanitization.
 */
export function stripOpenAIResponsesOutputOnlyStatusesForReplay<TItem extends { type?: unknown; status?: unknown }>(
	items: TItem[],
): TItem[] {
	let sanitized: TItem[] | undefined;
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const rejectsOutputStatus =
			item.type === "message" ||
			item.type === "function_call" ||
			item.type === "custom_tool_call" ||
			item.type === "compaction" ||
			item.type === "compaction_summary";
		if (!rejectsOutputStatus || !Object.hasOwn(item, "status")) {
			sanitized?.push(item);
			continue;
		}
		if (!sanitized) sanitized = items.slice(0, index);
		const withoutStatus = { ...item };
		delete withoutStatus.status;
		sanitized.push(withoutStatus);
	}
	return sanitized ?? items;
}

/**
 * Clamp `detail: "original"` only where Responses input_image parts live —
 * top-level items and `message.content[]`. Avoids a deep tree walk/clone of
 * every history node on providers that reject native-resolution images.
 */
function clampReplayItemImageDetail(
	item: Record<string, unknown>,
	supportsImageDetailOriginal: boolean,
): Record<string, unknown> {
	if (supportsImageDetailOriginal) return item;

	if (item.type === "input_image" && item.detail === "original") {
		return { ...item, detail: "auto" };
	}

	if (item.type !== "message" || !Array.isArray(item.content)) return item;

	let changed = false;
	const content = item.content.map(part => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return part;
		const record = part as Record<string, unknown>;
		if (record.type !== "input_image" || record.detail !== "original") return part;
		changed = true;
		return { ...record, detail: "auto" };
	});
	return changed ? { ...item, content } : item;
}

function isOpenAIResponsesClientInputBoundary(item: Record<string, unknown>): boolean {
	if (item.type === "message") return item.role !== "assistant";
	if (item.type === undefined && typeof item.role === "string") return item.role !== "assistant";

	switch (item.type) {
		case "input_text":
		case "input_image":
		case "input_file":
		case "input_audio":
		case "function_call_output":
		case "custom_tool_call_output":
		case "computer_call_output":
		case "local_shell_call_output":
		case "shell_call_output":
		case "apply_patch_call_output":
		case "mcp_approval_response":
		case "compaction":
		case "compaction_summary":
		case "compaction_trigger":
		case "item_reference":
			return true;
		case "additional_tools":
			return item.role !== "assistant";
		case "tool_search_output":
			return item.execution !== "server";
		default:
			return false;
	}
}

function collectOpenAIResponsesComputerLinkedReasoningItems(
	items: Array<Record<string, unknown>>,
	requireLaterOutput: boolean,
): Set<Record<string, unknown>> {
	let computerCallsWithLaterOutputs: Set<Record<string, unknown>> | undefined;
	if (requireLaterOutput) {
		computerCallsWithLaterOutputs = new Set();
		const laterComputerOutputCallIds = new Set<string>();
		for (let index = items.length - 1; index >= 0; index--) {
			const item = items[index]!;
			if (item.type === "computer_call_output" && typeof item.call_id === "string") {
				laterComputerOutputCallIds.add(item.call_id);
			} else if (
				item.type === "computer_call" &&
				typeof item.id === "string" &&
				typeof item.call_id === "string" &&
				laterComputerOutputCallIds.has(item.call_id)
			) {
				computerCallsWithLaterOutputs.add(item);
			}
		}
	}

	const computerLinkedReasoningItems = new Set<Record<string, unknown>>();
	const responseReasoningItems: Array<Record<string, unknown>> = [];
	for (const item of items) {
		if (isOpenAIResponsesClientInputBoundary(item)) {
			responseReasoningItems.length = 0;
		} else if (item.type === "reasoning") {
			responseReasoningItems.push(item);
		} else if (
			item.type === "computer_call" &&
			typeof item.id === "string" &&
			(!computerCallsWithLaterOutputs || computerCallsWithLaterOutputs.has(item))
		) {
			for (const reasoningItem of responseReasoningItems) computerLinkedReasoningItems.add(reasoningItem);
		}
	}
	return computerLinkedReasoningItems;
}

const provisionalOpenAIResponsesComputerReasoningItems = new WeakSet<object>();

export function sanitizeOpenAIResponsesHistoryItemsForReplay(
	items: Array<Record<string, unknown>>,
	options: OpenAIResponsesReplaySanitizeOptions = {},
): ResponseInput {
	const supportsImageDetailOriginal = options.supportsImageDetailOriginal !== false;
	const computerLinkedReasoningItems =
		options.supportsComputerUse === false
			? undefined
			: collectOpenAIResponsesComputerLinkedReasoningItems(items, false);
	const sanitized = items.flatMap(item => {
		const preserveForComputer = computerLinkedReasoningItems?.has(item) === true;
		const sanitizedItem = sanitizeOpenAIResponsesHistoryItemForReplay(
			item,
			supportsImageDetailOriginal,
			preserveForComputer,
		);
		if (preserveForComputer && sanitizedItem?.type === "reasoning") {
			provisionalOpenAIResponsesComputerReasoningItems.add(sanitizedItem);
		}
		return sanitizedItem ? [sanitizedItem] : [];
	});
	return stripOpenAIResponsesOutputOnlyStatusesForReplay(sanitized);
}

function collectOpenAIResponsesReasoningItemsWithSurvivingOutputIds(
	items: Array<Record<string, unknown>>,
): Set<Record<string, unknown>> {
	const retainedReasoningItems = new Set<Record<string, unknown>>();
	let responseReasoningItems: Array<Record<string, unknown>> = [];
	let hasSurvivingOutputId = false;
	const finishResponse = (): void => {
		if (hasSurvivingOutputId) {
			for (const reasoningItem of responseReasoningItems) retainedReasoningItems.add(reasoningItem);
		}
		responseReasoningItems = [];
		hasSurvivingOutputId = false;
	};

	for (const item of items) {
		if (isOpenAIResponsesClientInputBoundary(item)) {
			finishResponse();
		} else if (item.type === "reasoning") {
			responseReasoningItems.push(item);
		} else if (item.type !== "computer_call" && typeof item.id === "string") {
			hasSurvivingOutputId = true;
		}
	}
	finishResponse();
	return retainedReasoningItems;
}

/** Strip reasoning IDs whose only linked native output is a computer call that will be demoted. */
export function stripOpenAIResponsesComputerLinkedReasoningIdsForReplay(items: ResponseInput): ResponseInput {
	const records = items as unknown as Array<Record<string, unknown>>;
	const linkedReasoningItems = collectOpenAIResponsesComputerLinkedReasoningItems(records, false);
	const retainedReasoningItems = collectOpenAIResponsesReasoningItemsWithSurvivingOutputIds(records);
	let sanitized: ResponseInput | undefined;

	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const record = records[index]!;
		if (
			item.type !== "reasoning" ||
			typeof record.id !== "string" ||
			!linkedReasoningItems.has(record) ||
			retainedReasoningItems.has(record)
		) {
			sanitized?.push(item);
			continue;
		}
		if (!sanitized) sanitized = items.slice(0, index);
		const { id: _id, ...withoutId } = record;
		sanitized.push(withoutId as unknown as ResponseInput[number]);
	}
	return sanitized ?? items;
}

/**
 * Finalize provisional native-computer reasoning IDs after the complete
 * Responses input has been rebuilt, model-adapted, and orphan-repaired.
 */
export function stripUnpairedOpenAIResponsesComputerReasoningIdsForReplay(items: ResponseInput): ResponseInput {
	const records = items as unknown as Array<Record<string, unknown>>;
	const linkedReasoningItems = collectOpenAIResponsesComputerLinkedReasoningItems(records, true);
	let sanitized: ResponseInput | undefined;

	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const record = records[index]!;
		if (
			item.type !== "reasoning" ||
			!provisionalOpenAIResponsesComputerReasoningItems.has(item) ||
			typeof record.id !== "string" ||
			linkedReasoningItems.has(record)
		) {
			sanitized?.push(item);
			continue;
		}
		if (!sanitized) sanitized = items.slice(0, index);
		const { id: _id, ...withoutId } = record;
		sanitized.push(withoutId as unknown as ResponseInput[number]);
	}
	return sanitized ?? items;
}

/**
 * Sanitize assistant-native Responses history for replay.
 *
 * Returns `undefined` for hidden-empty turns that only contain reasoning and an
 * empty assistant message, allowing callers to rebuild visible transcript
 * history instead of replaying stale native state.
 */
export function sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
	items: Array<Record<string, unknown>>,
	options: OpenAIResponsesReplaySanitizeOptions = {},
): ResponseInput | undefined {
	const sanitized = sanitizeOpenAIResponsesHistoryItemsForReplay(items, options);
	let hasReplayableAssistantOutput = false;

	for (const item of sanitized) {
		if (item.type === "reasoning") continue;
		if (item.type !== "message" || item.role !== "assistant") {
			hasReplayableAssistantOutput = true;
			break;
		}
		if (typeof item.content === "string") {
			if (NON_WHITESPACE_RE.test(item.content)) {
				hasReplayableAssistantOutput = true;
				break;
			}
			continue;
		}
		for (const part of item.content) {
			if (part.type === "output_text" && NON_WHITESPACE_RE.test(part.text)) {
				hasReplayableAssistantOutput = true;
				break;
			}
			if (part.type === "refusal" && NON_WHITESPACE_RE.test(part.refusal)) {
				hasReplayableAssistantOutput = true;
				break;
			}
		}
		if (hasReplayableAssistantOutput) break;
	}

	return hasReplayableAssistantOutput ? sanitized : undefined;
}

/**
 * Drop hidden-only fallback assistant replay after a native Responses snapshot is rejected.
 */
export function sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(items: ResponseInput): ResponseInput {
	const sanitized: ResponseInput = [];

	for (const item of items) {
		if (item.type === "reasoning") continue;
		if (item.type !== "message" || item.role !== "assistant") {
			sanitized.push(item);
			continue;
		}

		let hasVisibleText = false;
		if (typeof item.content === "string") {
			hasVisibleText = NON_WHITESPACE_RE.test(item.content);
		} else {
			for (const part of item.content) {
				if (part.type === "output_text" && NON_WHITESPACE_RE.test(part.text)) {
					hasVisibleText = true;
					break;
				}
				if (part.type === "refusal" && NON_WHITESPACE_RE.test(part.refusal)) {
					hasVisibleText = true;
					break;
				}
			}
		}

		if (hasVisibleText) sanitized.push(item);
	}

	return sanitized;
}

function sanitizeOpenAIResponsesHistoryItemForReplay(
	item: Record<string, unknown>,
	supportsImageDetailOriginal: boolean,
	preserveReasoningItemIds: boolean,
): OpenAIResponsesReplayItem | undefined {
	if (item.type === "function_call") {
		if (typeof item.arguments !== "string" || item.arguments.trim().length === 0) return undefined;
		try {
			JSON.parse(item.arguments);
		} catch {
			return undefined;
		}
	}
	if (item.type === "item_reference") return undefined;
	if (item.type === "image_generation_call") return sanitizeOpenAIResponsesImageGenerationCallForReplay(item);
	if (item.type === "reasoning") {
		return sanitizeOpenAIResponsesReasoningItemForReplay(item, preserveReasoningItemIds);
	}
	const { id: _id, ...sanitizedItem } = item;
	if (item.type === "computer_call" && typeof item.id === "string") sanitizedItem.id = item.id;

	return clampReplayItemImageDetail(
		sanitizedItem,
		supportsImageDetailOriginal,
	) as unknown as OpenAIResponsesReplayItem;
}

function sanitizeOpenAIResponsesReasoningItemForReplay(
	item: Record<string, unknown>,
	preserveItemId: boolean,
): OpenAIResponsesReplayItem {
	const sanitizedItem: Record<string, unknown> = { type: "reasoning" };
	if (preserveItemId && typeof item.id === "string") sanitizedItem.id = item.id;
	if (Array.isArray(item.summary)) sanitizedItem.summary = item.summary;
	if (Array.isArray(item.content)) sanitizedItem.content = item.content;
	if (typeof item.encrypted_content === "string" || item.encrypted_content === null) {
		sanitizedItem.encrypted_content = item.encrypted_content;
	}
	return sanitizedItem as unknown as OpenAIResponsesReplayItem;
}

function sanitizeOpenAIResponsesImageGenerationCallForReplay(
	item: Record<string, unknown>,
): ResponseInputItem.ImageGenerationCall | undefined {
	if (typeof item.id !== "string" || typeof item.result !== "string" || item.result.length === 0) {
		return undefined;
	}
	return {
		id: truncateResponseItemId(item.id, "ig"),
		type: "image_generation_call",
		status: "completed",
		result: item.result,
	};
}

export function createOpenAIResponsesHistoryPayload(
	provider: string,
	items: Array<Record<string, unknown>>,
	incremental = true,
): OpenAIResponsesHistoryPayload {
	return {
		type: "openaiResponsesHistory",
		provider,
		...(incremental ? { dt: true } : {}),
		items,
	};
}

export function getOpenAIResponsesHistoryPayload(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): OpenAIResponsesHistoryPayload | undefined {
	if (providerPayload?.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) {
		return undefined;
	}
	const payloadProvider = providerPayload.provider ?? fallbackProvider ?? currentProvider;
	if (payloadProvider !== currentProvider) return undefined;
	return { ...providerPayload, provider: payloadProvider };
}

export function getOpenAIResponsesHistoryItems(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): Array<Record<string, unknown>> | undefined {
	return getOpenAIResponsesHistoryPayload(providerPayload, currentProvider, fallbackProvider)?.items;
}

/**
 * Resolve cache retention preference: explicit request option first, then the
 * `PI_CACHE_RETENTION` env override (`long` | `short` | `none`), then the
 * provider-supplied fallback.
 */
export function resolveCacheRetention(
	cacheRetention?: CacheRetention,
	fallback: CacheRetention = "short",
): CacheRetention {
	if (cacheRetention) return cacheRetention;
	const env = $env.PI_CACHE_RETENTION;
	if (env === "long" || env === "short" || env === "none") return env;
	return fallback;
}
