import { createHash } from "node:crypto";
import { $env } from "@oh-my-pi/pi-utils";
import type { ResponseInput, ResponseInputItem } from "./providers/openai-responses-wire";
import { redactSensitiveCredentials } from "./providers/transform-messages";
import type { CacheRetention, Model, OpenAIResponsesHistoryPayload, ProviderPayload } from "./types";

type OpenAIResponsesReplayItem = ResponseInput[number];
const NON_WHITESPACE_RE = /\S/;

export { isRecord } from "@oh-my-pi/pi-utils";
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

export function normalizeResponsesToolCallId(
	id: string,
	itemPrefix: ResponsesToolItemIdPrefix = "fc",
): { callId: string; itemId: string } {
	const [callId, itemId] = id.split("|");
	if (callId && itemId) {
		const normalizedCallId = truncateResponseItemId(callId, getIdPrefix(callId, "call"));
		const normalizedItemId = normalizeResponsesItemId(itemId, itemPrefix);
		return { callId: normalizedCallId, itemId: normalizedItemId };
	}
	const hash = Bun.hash(id).toString(36);
	const normalizedCallId = id.startsWith("call_") ? truncateResponseItemId(id, "call") : `call_${hash}`;
	return { callId: normalizedCallId, itemId: `${itemPrefix}_${hash}` };
}

function getIdPrefix(id: string, fallback: string): string {
	const prefix = id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
	return prefix || fallback;
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
			item.type === "message" || item.type === "function_call" || item.type === "custom_tool_call";
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
	const normalizedCallIds = new Map<string, string>();
	const supportsImageDetailOriginal = options.supportsImageDetailOriginal !== false;
	const computerLinkedReasoningItems =
		options.supportsComputerUse === false
			? undefined
			: collectOpenAIResponsesComputerLinkedReasoningItems(items, false);
	const sanitized = items.flatMap(item => {
		const preserveForComputer = computerLinkedReasoningItems?.has(item) === true;
		const sanitizedItem = sanitizeOpenAIResponsesHistoryItemForReplay(
			item,
			normalizedCallIds,
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
	normalizedCallIds: Map<string, string>,
	supportsImageDetailOriginal: boolean,
	preserveReasoningItemIds: boolean,
): OpenAIResponsesReplayItem | undefined {
	if (item.type === "item_reference") return undefined;
	if (item.type === "image_generation_call") return sanitizeOpenAIResponsesImageGenerationCallForReplay(item);
	if (item.type === "reasoning") {
		return sanitizeOpenAIResponsesReasoningItemForReplay(item, preserveReasoningItemIds);
	}
	const { id: _id, ...sanitizedItem } = item;
	if (item.type === "computer_call" && typeof item.id === "string") sanitizedItem.id = item.id;
	if (typeof item.call_id === "string") {
		sanitizedItem.call_id = normalizeReplayedResponsesHistoryCallId(item.call_id, normalizedCallIds);
	}

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

function normalizeReplayedResponsesHistoryCallId(value: string, normalizedValues: Map<string, string>): string {
	const normalized = normalizedValues.get(value);
	if (normalized) return normalized;
	const next = truncateResponseItemId(value, getIdPrefix(value, "call"));
	normalizedValues.set(value, next);
	return next;
}

export function createOpenAIResponsesHistoryPayload(
	provider: string,
	items: Array<Record<string, unknown>>,
	incremental = true,
	referenceTarget?: string,
): OpenAIResponsesHistoryPayload {
	return {
		type: "openaiResponsesHistory",
		provider,
		...(referenceTarget ? { referenceTarget } : {}),
		...(incremental ? { dt: true } : {}),
		items,
	};
}

export function canonicalizeOpenAIResponsesReferenceBaseUrl(endpoint: string): string {
	const value = endpoint.trim();
	try {
		const url = new URL(value);
		const pathname = url.pathname.replace(/\/+$/, "");
		const officialCodexHost =
			url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
		url.hash = "";
		if (
			officialCodexHost &&
			(pathname === "/backend-api/codex/responses" || pathname === "/backend-api/codex/responses/compact")
		) {
			url.pathname = "/backend-api";
			return url.toString().replace(/\/$/, "");
		}
		for (const suffix of ["/responses/compact", "/responses"]) {
			if (pathname.endsWith(suffix)) {
				url.pathname = pathname.slice(0, -suffix.length) || "/";
				return url.toString().replace(/\/$/, "");
			}
		}
		url.pathname = pathname || "/";
		return url.toString().replace(/\/$/, "");
	} catch {
		return value;
	}
}

export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function resolveOpenAIResponsesRequestModel(
	model: Model,
	requestModel = model.requestModelId ?? model.id,
): string {
	if (model.api !== "azure-openai-responses") return requestModel;
	return parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(requestModel) ?? requestModel;
}

export interface AzureOpenAIEndpointOverrides {
	azureBaseUrl?: string;
	azureResourceName?: string;
}

export function resolveAzureOpenAIBaseUrl(model: Model, overrides?: AzureOpenAIEndpointOverrides): string | undefined {
	const baseUrl = overrides?.azureBaseUrl?.trim() || $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = overrides?.azureResourceName || $env.AZURE_OPENAI_RESOURCE_NAME;
	const resolvedBaseUrl =
		baseUrl ?? (resourceName ? `https://${resourceName}.openai.azure.com/openai/v1` : undefined) ?? model.baseUrl;
	return resolvedBaseUrl?.replace(/\/+$/, "");
}

/** Key-order-independent JSON so structurally equal routing configs hash alike. */
export function canonicalJsonString(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(normalize);
		if (!input || typeof input !== "object") return input;
		const entries = Object.entries(input as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Object.fromEntries(entries.map(([key, entryValue]) => [key, normalize(entryValue)]));
	};
	return JSON.stringify(normalize(value)) ?? "";
}

export interface OpenAIResponsesRoutingIdentityCompat<Router = unknown, Gateway = unknown> {
	isOpenRouterHost?: boolean;
	openRouterRouting?: Router;
	isVercelGatewayHost?: boolean;
	vercelGatewayRouting?: Gateway;
}

/**
 * Gateway routing configuration that actually reaches the wire, gating each
 * entry on the host flag the serializers use. Routing decides which upstream
 * serves the request, so it belongs to the replay target identity and to the
 * post-shaping wire check — one derivation keeps those in step.
 */
export function resolveOpenAIResponsesRoutingIdentity<Router, Gateway>(
	compat: OpenAIResponsesRoutingIdentityCompat<Router, Gateway> | undefined,
): { openRouterRouting?: Router; vercelGatewayRouting?: Gateway } | undefined {
	if (!compat) return undefined;
	const identity: { openRouterRouting?: Router; vercelGatewayRouting?: Gateway } = {};
	if (compat.isOpenRouterHost && compat.openRouterRouting !== undefined) {
		identity.openRouterRouting = compat.openRouterRouting;
	}
	if (compat.isVercelGatewayHost && compat.vercelGatewayRouting !== undefined) {
		identity.vercelGatewayRouting = compat.vercelGatewayRouting;
	}
	return identity.openRouterRouting === undefined && identity.vercelGatewayRouting === undefined
		? undefined
		: identity;
}

export interface OpenAIResponsesRoutingOverrides {
	provider?: unknown;
	providerOptions?: unknown;
}

const OPENAI_RESPONSES_ROUTING_FIELDS = ["provider", "providerOptions"] as const;

/**
 * Routing selectors an `extraBody` supplies, carried by key presence rather than
 * by value. The serializer merges `extraBody` with `Object.assign`, so an
 * explicitly `undefined` key overwrites the configured selector and
 * `JSON.stringify` then drops the field entirely — the request reaches the
 * gateway's default upstream. The identity hash has to drop it too, or the
 * response is stamped for the configured upstream that never served it.
 */
export function resolveOpenAIResponsesRoutingOverrides(
	extraBody: Record<string, unknown> | undefined,
): OpenAIResponsesRoutingOverrides {
	const overrides: OpenAIResponsesRoutingOverrides = {};
	if (!extraBody) return overrides;
	for (const field of OPENAI_RESPONSES_ROUTING_FIELDS) {
		if (Object.hasOwn(extraBody, field)) overrides[field] = extraBody[field];
	}
	return overrides;
}

interface OpenAIResponsesGatewayRoutingShape {
	only?: unknown;
	order?: unknown;
}

/**
 * Routing selectors in the exact shape the Responses serializer writes onto the
 * request body. Configured gateway routing is nested under `providerOptions
 * .gateway`, while an `extraBody` override supplies that field verbatim, so the
 * identity hash and the post-shaping wire check must both read the wire shape —
 * comparing the raw configuration would let two structurally different routes
 * share a fingerprint.
 */
export function resolveOpenAIResponsesWireRouting<Router, Gateway extends OpenAIResponsesGatewayRoutingShape>(
	compat: OpenAIResponsesRoutingIdentityCompat<Router, Gateway> | undefined,
): OpenAIResponsesRoutingOverrides {
	const identity = resolveOpenAIResponsesRoutingIdentity(compat);
	if (!identity) return {};
	if (compat?.isVercelGatewayHost) {
		const routing = identity.vercelGatewayRouting;
		if (!routing || (!routing.only && !routing.order)) return {};
		const gateway: OpenAIResponsesGatewayRoutingShape = {};
		if (routing.only) gateway.only = routing.only;
		if (routing.order) gateway.order = routing.order;
		return { providerOptions: { gateway } };
	}
	return identity.openRouterRouting !== undefined ? { provider: identity.openRouterRouting } : {};
}

export function getOpenAIResponsesReferenceTarget(
	model: Model,
	requestModel = resolveOpenAIResponsesRequestModel(model),
	referenceBaseUrl = model.api === "azure-openai-responses" ? resolveAzureOpenAIBaseUrl(model) : model.baseUrl,
	routingOverrides?: OpenAIResponsesRoutingOverrides,
): string {
	const supportsImageDetailOriginal =
		!!model.compat &&
		"supportsImageDetailOriginal" in model.compat &&
		model.compat.supportsImageDetailOriginal === true;
	const configuredRouting = resolveOpenAIResponsesWireRouting(
		model.compat as OpenAIResponsesRoutingIdentityCompat<unknown, OpenAIResponsesGatewayRoutingShape> | undefined,
	);
	const routing: Record<string, unknown> = {};
	if (configuredRouting.provider !== undefined) routing.provider = configuredRouting.provider;
	if (configuredRouting.providerOptions !== undefined) routing.providerOptions = configuredRouting.providerOptions;
	if (routingOverrides) {
		for (const field of OPENAI_RESPONSES_ROUTING_FIELDS) {
			if (!Object.hasOwn(routingOverrides, field)) continue;
			const override = routingOverrides[field];
			if (override === undefined) delete routing[field];
			else routing[field] = override;
		}
	}
	const identity = JSON.stringify({
		api: model.api,
		provider: model.provider,
		baseUrl: referenceBaseUrl ? canonicalizeOpenAIResponsesReferenceBaseUrl(referenceBaseUrl) : "",
		model: requestModel,
		input: [...model.input].sort(),
		supportsComputerUse: model.supportsComputerUse === true,
		supportsImageDetailOriginal,
		...(Object.keys(routing).length > 0 ? { routing: canonicalJsonString(routing) } : {}),
	});
	return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function getOpenAIResponsesHistoryPayload(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
	currentReferenceTarget?: string,
): OpenAIResponsesHistoryPayload | undefined {
	if (providerPayload?.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) {
		return undefined;
	}
	const payloadProvider = providerPayload.provider ?? fallbackProvider ?? currentProvider;
	if (payloadProvider !== currentProvider) return undefined;
	if (providerPayload.referenceTarget !== undefined && providerPayload.referenceTarget !== currentReferenceTarget) {
		return undefined;
	}
	return { ...providerPayload, provider: payloadProvider };
}

/** Assistant output items whose `id` is minted by the endpoint that served the turn. */
const ENDPOINT_OWNED_RESPONSES_ITEM_TYPES = new Set([
	"reasoning",
	"message",
	"function_call",
	"custom_tool_call",
	"computer_call",
]);

function containsEncryptedResponsesState(value: unknown): boolean {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		if (!current || typeof current !== "object") continue;
		const record = current as Record<string, unknown>;
		if (typeof record.encrypted_content === "string" && record.encrypted_content.length > 0) return true;
		pending.push(...Object.values(record));
	}
	return false;
}

/**
 * Whether assistant native history can only be resolved by the endpoint that
 * produced it. Reasoning items, encrypted reasoning state, and endpoint-minted
 * output-item ids are all opaque elsewhere, so history carrying any of them is
 * bound to its producing endpoint even when no `referenceTarget` stamp records
 * which endpoint that was.
 */
export function openAIResponsesHistoryItemsAreEndpointOwned(items: readonly unknown[]): boolean {
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "reasoning") return true;
		if (
			typeof record.type === "string" &&
			ENDPOINT_OWNED_RESPONSES_ITEM_TYPES.has(record.type) &&
			typeof record.id === "string" &&
			record.id.length > 0
		) {
			return true;
		}
		if (containsEncryptedResponsesState(record)) return true;
	}
	return false;
}

/**
 * Whether a stamped or legacy assistant payload belongs to an endpoint other
 * than the one about to be dispatched to. History persisted before reference
 * stamping existed carries no target at all, so a reroute cannot be detected by
 * comparing fingerprints; treat unstamped history that carries endpoint-owned
 * state as foreign instead of replaying it blind.
 */
export function isOpenAIResponsesAssistantHistoryTargetOwned(
	providerPayload: ProviderPayload | undefined,
	currentReferenceTarget?: string,
): boolean {
	if (providerPayload?.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) return false;
	if (providerPayload.referenceTarget !== undefined) {
		return providerPayload.referenceTarget !== currentReferenceTarget;
	}
	return openAIResponsesHistoryItemsAreEndpointOwned(providerPayload.items);
}

/**
 * Whether a canonical `textSignature` names an output item minted by the
 * endpoint that served the turn. Current producers encode the message id as a
 * versioned JSON envelope; pre-envelope history stored the raw `msg_…` id.
 */
function responsesTextSignatureIsEndpointOwned(signature: unknown): boolean {
	if (typeof signature !== "string" || signature.length === 0) return false;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown };
			return parsed?.v === 1 && typeof parsed.id === "string" && parsed.id.length > 0;
		} catch {
			return false;
		}
	}
	return signature.startsWith("msg_");
}

/**
 * Whether a canonical `thinkingSignature` carries a Responses reasoning item.
 * The serializer replays the parsed item verbatim, so its reasoning id and
 * encrypted content belong to the endpoint that minted them.
 */
function responsesReasoningSignatureIsEndpointOwned(signature: unknown): boolean {
	if (typeof signature !== "string" || signature.length === 0) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	return openAIResponsesHistoryItemsAreEndpointOwned([parsed]);
}

/**
 * Whether an assistant turn's canonical replay signatures are endpoint-owned.
 * The canonical fallback re-encodes those signatures into the same reasoning
 * item and output-item id the native payload would have carried, so history
 * that reaches it without a trusted target stamp is foreign whenever either
 * signature is present.
 */
export function openAIResponsesAssistantContentIsEndpointOwned(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "thinking" && responsesReasoningSignatureIsEndpointOwned(record.thinkingSignature)) {
			return true;
		}
		if (record.type === "text" && responsesTextSignatureIsEndpointOwned(record.textSignature)) return true;
	}
	return false;
}

/**
 * Whether the canonical fallback for `assistant` would replay state owned by
 * another endpoint. A stamped payload settles the question on its own; without
 * one, the canonical signatures are the only record of who minted the reasoning
 * item and output-item ids the fallback is about to re-emit.
 */
export function isOpenAIResponsesAssistantFallbackTargetOwned(
	assistant: { providerPayload?: ProviderPayload; content: unknown },
	currentReferenceTarget?: string,
): boolean {
	if (isOpenAIResponsesAssistantHistoryTargetOwned(assistant.providerPayload, currentReferenceTarget)) return true;
	const providerPayload = assistant.providerPayload;
	if (
		providerPayload?.type === "openaiResponsesHistory" &&
		Array.isArray(providerPayload.items) &&
		providerPayload.referenceTarget !== undefined
	) {
		return false;
	}
	return openAIResponsesAssistantContentIsEndpointOwned(assistant.content);
}

export function getOpenAIResponsesHistoryItems(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
	currentReferenceTarget?: string,
): Array<Record<string, unknown>> | undefined {
	return getOpenAIResponsesHistoryPayload(providerPayload, currentProvider, fallbackProvider, currentReferenceTarget)
		?.items;
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
