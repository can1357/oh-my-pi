import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import type { ModelIdentity } from "@oh-my-pi/pi-catalog/compat/types";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { clearStreamingPartialJson, setStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { notifyProviderResponse } from "../utils/provider-response";
import { toolWireSchema } from "../utils/schema/wire";
import {
	clearGrokbotTokenCache,
	createGrokbotChecksum,
	GROKBOT_BACKEND,
	grokbotClientHeaders,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	mergeGrokbotHeaders,
	mintGrokbotAccessToken,
} from "./grokbot/auth";
import { AUTHENTICATED_SENTINEL } from "../registry/types";
import { resolveGrokbotRequestedModel, type GrokbotRequestedModel } from "./grokbot/model-request";
import {
	applyAnthropicSandToolWire,
	resolveAnthropicSandToolsWire,
	type AnthropicSandToolsWire,
	type AnthropicSandToolWireResult,
} from "./grokbot/anthropic-sand-wire";
import {
	advertisedNamesForJsonTextToolCall,
	assistantTextForJsonPromotion,
	parseGeminiInbandToolCall,
	parseJsonTextToolCall,
} from "./grokbot/json-text-tool-call";
import { nativeToolParametersForIdentity } from "./grokbot/tool-policy";
import {
	augmentToolIndexForProductWire,
	parseSendToUserContent,
	type ProductWireToolIndexMeta,
	rewriteInferenceMessagesForProductWire,
	SEND_TO_USER_WIRE_NAME,
} from "./grokbot/product-wire";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	frameConnectProto,
} from "./grokbot/proto";

export {
	formatGrokbotStatus,
	GROKBOT_BACKEND,
	getAccessTokenExpiryMs,
	mergeGrokbotHeaders,
	resolveGrokbotClientVersion,
	stampedVersionBaseOf,
} from "./grokbot/auth";
export { resolveGrokbotRequestedModel, toSandEffortValue } from "./grokbot/model-request";

export const GROKBOT_API = "grokbot-sand" as const;
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
const DEFAULT_IMAGE_MIME = "image/png";

export interface GrokbotOptions extends StreamOptions {
	/** Optional sand conversation id; preferred over sessionId, else a fresh UUID. */
	conversationId?: string;
	/** Sand effort parameter; when set from mapOptionsForApi, overrides the default `high`. */
	effort?: Effort | string;
	/**
	 * Sand `fast` parameter. When omitted, `resolveGrokbotRequestedModel` picks
	 * a catalog-aware default (`false` if `thinking` is advertised, else `true`).
	 */
	fast?: boolean;
	/** Sand `thinking` boolean; when omitted, defaults to true iff effort is sent. */
	thinking?: boolean;
	/** Sand `context` tier (`300k` / `1m`); when omitted, follows sandMaxMode. */
	context?: string;
	/**
	 * Anthropic + tools sand wire. Default `auto` resolves to `keep-model`
	 * (product PascalCase+jsonSchema tools, original requestedModel).
	 * Non-Anthropic families resolve to `native` (raw omp bash/read/write).
	 * `automation` still rewrites to sand-automation. `error` throws on Anthropic;
	 * `sand-default-fallback` rewrites to bare sand-default (tools work; model not guaranteed Opus).
	 */
	anthropicToolsWire?: AnthropicSandToolsWire;
}

const ROLE = {
	user: 1,
	assistant: 2,
	tool: 3,
	system: 4,
	developer: 4,
} as const;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "type" in part && (part as { type: string }).type === "text") {
				return String((part as { text?: string }).text ?? "");
			}
			return "";
		})
		.join("");
}

/** Sand InferenceImagePart.data: data URL, http(s) URL, or raw base64 → data URL. */
export function toSandImageDataUrl(image: Pick<ImageContent, "data" | "mimeType" | "url">): string {
	if (typeof image.url === "string" && /^(https?:|data:)/i.test(image.url)) return image.url;
	const raw = typeof image.data === "string" ? image.data : "";
	if (/^(https?:|data:)/i.test(raw)) return raw;
	const mime =
		typeof image.mimeType === "string" && image.mimeType.trim() ? image.mimeType.trim() : DEFAULT_IMAGE_MIME;
	return `data:${mime};base64,${raw}`;
}

function asImagePart(part: unknown): ImageContent | undefined {
	if (!part || typeof part !== "object") return undefined;
	const p = part as Record<string, unknown>;
	if (p.type !== "image") return undefined;
	const data = typeof p.data === "string" ? p.data : "";
	const url = typeof p.url === "string" ? p.url : undefined;
	if (!data && !url) return undefined;
	return {
		type: "image",
		data,
		mimeType: typeof p.mimeType === "string" ? p.mimeType : DEFAULT_IMAGE_MIME,
		url,
	};
}

type SandContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function userPartsFromContent(content: unknown): SandContentPart[] {
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) return [];
	const parts: SandContentPart[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			if (part) parts.push({ type: "text", text: part });
			continue;
		}
		if (!part || typeof part !== "object") continue;
		const typed = part as { type?: string; text?: string };
		if (typed.type === "text" && typed.text) {
			parts.push({ type: "text", text: typed.text });
			continue;
		}
		const image = asImagePart(part);
		if (image) {
			parts.push({
				type: "image",
				data: toSandImageDataUrl(image),
				mimeType: image.mimeType || DEFAULT_IMAGE_MIME,
			});
		}
	}
	return parts;
}

function jsonClone<T>(value: T): T | undefined {
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return undefined;
	}
}

function toolParametersToJson(tool: Tool): Record<string, unknown> {
	try {
		return toolWireSchema(tool);
	} catch {
		return { type: "object", properties: {} };
	}
}

function toInferenceTools(tools: Context["tools"], identity?: Pick<ModelIdentity, "class">) {
	if (!Array.isArray(tools)) return [];
	const out: Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		customToolFormat?: { type: string; definition: string; syntax: string };
	}> = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const wireName =
			typeof tool.customWireName === "string" && tool.customWireName.trim() ? tool.customWireName.trim() : name;
		const parameters = identity
			? nativeToolParametersForIdentity(toolParametersToJson(tool), identity)
			: toolParametersToJson(tool);
		const entry: (typeof out)[number] = {
			name: wireName,
			description: typeof tool.description === "string" ? tool.description : "",
			parameters,
		};
		if (tool.customFormat && typeof tool.customFormat === "object") {
			entry.customToolFormat = {
				type: "grammar",
				definition: tool.customFormat.definition || "",
				syntax: tool.customFormat.syntax || "",
			};
		}
		out.push(entry);
	}
	return out;
}

/** Map wire tool names (incl. customWireName / productWireName) back to internal tool metadata. */
function buildGrammarToolIndex(tools: Context["tools"]): Map<string, ProductWireToolIndexMeta> {
	const index = new Map<string, ProductWireToolIndexMeta>();
	if (!Array.isArray(tools)) return index;
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const customWireName =
			typeof tool.customWireName === "string" && tool.customWireName.trim() ? tool.customWireName.trim() : undefined;
		const isGrammar = Boolean(tool.customFormat && typeof tool.customFormat === "object");
		const meta: ProductWireToolIndexMeta = { name, customWireName, isGrammar };
		index.set(name, meta);
		if (customWireName) index.set(customWireName, meta);
	}
	return index;
}

/**
 * Parse completed tool args. Grammar/customFormat tools emit raw text (patch,
 * hashline, or even JSON-shaped grammar output); always wrap as `{ input }` —
 * never JSON-decode, or agent dispatch / history replay lose the raw field-4 path.
 */
function parseCompletedToolArgs(raw: unknown, isGrammar: boolean): Record<string, unknown> {
	if (isGrammar) {
		const text = raw == null ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
		return { input: text };
	}
	return parseToolArgs(raw, true);
}

function toolCallFromPart(part: unknown, grammarTools?: Map<string, ProductWireToolIndexMeta>) {
	if (!part || typeof part !== "object") return undefined;
	const p = part as Record<string, unknown>;
	const type = p.type;
	if (type !== "toolCall" && type !== "tool-call" && type !== "tool_call") return undefined;
	const id = String(p.id || p.toolCallId || p.tool_call_id || "");
	const name = String(p.name || p.toolName || p.tool_name || "");
	const customWireName =
		typeof p.customWireName === "string" && p.customWireName.trim() ? p.customWireName.trim() : "";
	if (!id && !name && !customWireName) return undefined;
	const args = p.arguments ?? p.args ?? {};
	const meta =
		(name ? grammarTools?.get(name) : undefined) ?? (customWireName ? grammarTools?.get(customWireName) : undefined);
	// Grammar/customFormat tools (apply_patch, hashline, sloppy) replay as wire
	// name + raw input (protobuf field 4), not Struct args. hashline/sloppy omit
	// customWireName on the tool definition — use context.tools or a stored marker.
	const isGrammar = Boolean(customWireName) || Boolean(meta?.isGrammar);
	const wireName = customWireName || meta?.customWireName || name;
	const tc: { toolCallId: string; toolName: string; args?: Record<string, unknown>; rawToolCallArgs?: string } = {
		toolCallId: id,
		toolName: wireName,
	};
	if (isGrammar) {
		if (typeof args === "string") {
			tc.rawToolCallArgs = args;
		} else if (args && typeof args === "object") {
			const input = (args as Record<string, unknown>).input;
			if (typeof input === "string") {
				tc.rawToolCallArgs = input;
			} else {
				tc.args = args as Record<string, unknown>;
			}
		} else {
			tc.rawToolCallArgs = "";
		}
		return tc;
	}
	if (typeof args === "string") {
		try {
			tc.args = JSON.parse(args) as Record<string, unknown>;
		} catch {
			tc.rawToolCallArgs = args;
		}
	} else if (args && typeof args === "object") {
		tc.args = args as Record<string, unknown>;
	} else {
		tc.args = {};
	}
	return tc;
}

function reasoningFromPart(part: unknown) {
	if (!part || typeof part !== "object") return undefined;
	const p = part as Record<string, unknown>;
	if (p.type === "thinking") {
		return {
			isRedacted: false,
			text: String(p.thinking || p.text || ""),
			signature: typeof p.thinkingSignature === "string" ? p.thinkingSignature : undefined,
		};
	}
	if (p.type === "redactedThinking" || p.type === "redacted-thinking") {
		return { isRedacted: true, redactedData: String(p.data || ""), text: "" };
	}
	if (p.type === "reasoning") {
		return {
			isRedacted: false,
			text: String(p.text || ""),
			signature: typeof p.signature === "string" ? p.signature : undefined,
		};
	}
	return undefined;
}

function toolResultExperimentalContent(msg: Record<string, unknown>): SandContentPart[] | undefined {
	if (!Array.isArray(msg.content)) return undefined;
	const experimental: SandContentPart[] = [];
	for (const part of msg.content) {
		const image = asImagePart(part);
		if (image) {
			experimental.push({
				type: "image",
				data: toSandImageDataUrl(image),
				mimeType: image.mimeType || DEFAULT_IMAGE_MIME,
			});
			continue;
		}
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = String((part as { text?: string }).text || "");
			if (text) experimental.push({ type: "text", text });
		}
	}
	return experimental.some(p => p.type === "image") ? experimental : undefined;
}

function toolResultPayload(msg: Record<string, unknown>): unknown {
	const texts: string[] = [];
	if (typeof msg.content === "string") texts.push(msg.content);
	else if (Array.isArray(msg.content)) {
		for (const part of msg.content) {
			if (typeof part === "string") texts.push(part);
			else if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				texts.push(String((part as { text?: string }).text || ""));
			}
		}
	}
	const joined = texts.join("\n");
	if (joined) return joined;
	if (msg.details !== undefined) {
		if (typeof msg.details === "string" || typeof msg.details === "number" || typeof msg.details === "boolean") {
			return String(msg.details);
		}
		const cloned = jsonClone(msg.details);
		if (cloned !== undefined) return cloned;
	}
	return "";
}

/** @internal Exported for Grok Bot message-conversion contract tests. */
export function toInferenceMessages(context: Context) {
	const out: Array<Record<string, unknown>> = [];
	const system = context.systemPrompt;
	if (Array.isArray(system)) {
		const joined = system.filter((s): s is string => typeof s === "string").join("\n");
		if (joined.trim()) out.push({ role: ROLE.system, text: joined });
	}

	type InferenceToolCall = {
		toolCallId: string;
		toolName: string;
		args?: Record<string, unknown>;
		rawToolCallArgs?: string;
	};
	type InferenceReasoning = {
		isRedacted: boolean;
		text: string;
		redactedData?: string;
		signature?: string;
	};

	const toolWireIndex = buildGrammarToolIndex(context.tools);
	// Prefer the wire name from the preceding assistant call with the same
	// toolCallId — edit.mode / tool set can change after a grammar call is in
	// history, so looking up the current context.tools would mismatch names.
	const wireNameByCallId = new Map<string, string>();

	for (const msg of context.messages ?? []) {
		if (!msg || typeof msg !== "object") continue;
		const roleName = msg.role;
		const record = msg as unknown as Record<string, unknown>;

		if (roleName === "toolResult") {
			const callId = String(record.toolCallId || record.tool_call_id || "");
			const internalName = String(record.toolName || record.tool_name || "");
			const meta = internalName ? toolWireIndex.get(internalName) : undefined;
			const wireName = (callId ? wireNameByCallId.get(callId) : undefined) || meta?.customWireName || internalName;
			const part: Record<string, unknown> = {
				toolCallId: callId,
				toolName: wireName,
				result: toolResultPayload(record),
			};
			if (record.isError) part.isError = true;
			const experimental = toolResultExperimentalContent(record);
			if (experimental) part.experimentalContent = experimental;
			out.push({ role: ROLE.tool, toolContent: { parts: [part] } });
			continue;
		}

		if (roleName === "assistant") {
			const toolCalls: InferenceToolCall[] = [];
			const reasoningParts: InferenceReasoning[] = [];
			const texts: string[] = [];
			const content = msg.content;
			if (typeof content === "string") {
				if (content) texts.push(content);
			} else if (Array.isArray(content)) {
				for (const part of content) {
					const tc = toolCallFromPart(part, toolWireIndex);
					if (tc) {
						if (tc.toolCallId) wireNameByCallId.set(tc.toolCallId, tc.toolName);
						toolCalls.push(tc);
						continue;
					}
					const thinking = reasoningFromPart(part);
					if (thinking) {
						reasoningParts.push(thinking);
						continue;
					}
					const t = textOf(part && typeof part === "object" && "type" in part ? [part] : part);
					if (t) texts.push(t);
				}
			}
			const proto: Record<string, unknown> = { role: ROLE.assistant };
			const text = texts.join("");
			if (text) proto.text = text;
			if (toolCalls.length) proto.toolCalls = toolCalls;
			if (reasoningParts.length) proto.reasoningParts = reasoningParts;
			if (proto.text || proto.toolCalls || proto.reasoningParts) out.push(proto);
			continue;
		}

		const role = ROLE[roleName as keyof typeof ROLE] || ROLE.user;
		const parts = userPartsFromContent(msg.content);
		if (!parts.length) continue;
		const hasImage = parts.some(p => p.type === "image");
		if (hasImage) {
			out.push({ role, parts: { parts } });
		} else {
			const text = parts.map(p => (p.type === "text" ? p.text : "")).join("");
			if (text) out.push({ role, text });
		}
	}
	return out;
}

function buildModelConfig(model: Model<"grokbot-sand">, options?: GrokbotOptions) {
	const cfgOut: Record<string, unknown> = {};
	const maxTokens = options?.maxTokens ?? model.maxTokens;
	if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
		cfgOut.maxTokens = maxTokens;
	}
	if (typeof options?.temperature === "number" && Number.isFinite(options.temperature)) {
		cfgOut.temperature = options.temperature;
	}
	if (typeof options?.topP === "number" && Number.isFinite(options.topP)) {
		cfgOut.topP = options.topP;
	}
	const stops = options?.stopSequences;
	if (Array.isArray(stops) && stops.length) {
		cfgOut.stopSequences = stops.filter((s): s is string => typeof s === "string");
	}
	return Object.keys(cfgOut).length ? cfgOut : undefined;
}

function parseToolArgs(raw: unknown, requireValid = false): Record<string, unknown> {
	if (raw == null || raw === "") return {};
	if (typeof raw === "object") {
		// Arrays are typeof "object" but are not valid function-tool argument maps.
		if (Array.isArray(raw)) {
			if (requireValid) {
				throw new AIError.ProviderResponseError("Grok Bot completed tool call arguments must be a JSON object", {
					provider: "grokbot",
					kind: "envelope",
				});
			}
			return {};
		}
		return raw as Record<string, unknown>;
	}
	if (typeof raw !== "string") {
		if (requireValid) {
			throw new AIError.ProviderResponseError("Grok Bot completed tool call has non-JSON arguments", {
				provider: "grokbot",
				kind: "envelope",
			});
		}
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		if (requireValid) {
			throw new AIError.ProviderResponseError("Grok Bot completed tool call arguments must be a JSON object", {
				provider: "grokbot",
				kind: "envelope",
			});
		}
		return {};
	} catch (err) {
		if (err instanceof AIError.ProviderResponseError) throw err;
		if (requireValid) {
			throw new AIError.ProviderResponseError("Grok Bot completed tool call has malformed JSON arguments", {
				provider: "grokbot",
				kind: "envelope",
			});
		}
		return {};
	}
}

function applyUsage(output: AssistantMessage, usage: Record<string, unknown>) {
	const input = Number(
		usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? usage.input ?? 0,
	);
	const outTok = Number(
		usage.completionTokens ??
			usage.completion_tokens ??
			usage.outputTokens ??
			usage.output_tokens ??
			usage.output ??
			0,
	);
	const total = Number(usage.totalTokens ?? usage.total_tokens ?? input + outTok);
	const cacheRead = Number(
		usage.cachedTokens ??
			usage.cached_tokens ??
			usage.cacheReadTokens ??
			usage.cache_read_tokens ??
			usage.cacheRead ??
			0,
	);
	const cacheWrite = Number(usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cacheWrite ?? 0);
	output.usage.input = Number.isFinite(input) ? input : 0;
	output.usage.output = Number.isFinite(outTok) ? outTok : 0;
	output.usage.totalTokens = Number.isFinite(total) ? total : 0;
	output.usage.cacheRead = Number.isFinite(cacheRead) ? cacheRead : 0;
	output.usage.cacheWrite = Number.isFinite(cacheWrite) ? cacheWrite : 0;
}

function canFinalizeIncompleteToolArgs(argsText: string, isGrammar: boolean): boolean {
	if (isGrammar) return argsText.trim().length > 0;
	const trimmed = argsText.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
	} catch {
		return false;
	}
}

type GrokbotToolState = {
	key: string;
	index: number;
	block: ToolCall;
	argsText: string;
	ended: boolean;
	isGrammar: boolean;
};

/** True when the immediately preceding message is a toolResult (current tool turn). */
function contextEndsWithToolResult(context: Context): boolean {
	const messages = context.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") continue;
		return msg.role === "toolResult";
	}
	return false;
}

/** Gemini/Cursor Write often emits `contents` instead of omp `content`. */
function normalizeProductWriteArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	if (!/^(write|Write)$/i.test(name)) return args;
	if (typeof args.content === "string") return args;
	if (typeof args.contents === "string") return { ...args, content: args.contents };
	return args;
}

function uniqueToolStates(toolStates: Map<string, GrokbotToolState>): GrokbotToolState[] {
	const seen = new Set<GrokbotToolState>();
	const out: GrokbotToolState[] = [];
	for (const state of toolStates.values()) {
		if (seen.has(state)) continue;
		seen.add(state);
		out.push(state);
	}
	return out;
}

function firstPresent(obj: Record<string, unknown> | undefined, keys: string[]): unknown {
	if (!obj) return undefined;
	for (const key of keys) {
		if (obj[key] != null) return obj[key];
	}
	return undefined;
}

/**
 * Connect end-stream errors often use opaque `message` values (`Error`,
 * `internal error`) while the actionable Anthropic/OpenAI status lives under
 * `details[].debug` (`ERROR_PROVIDER_ERROR`, `providerStatusCode`, detail).
 */
export function formatGrokbotConnectTrailerError(parsedEnd: Record<string, unknown>): string {
	const errObj = parsedEnd.error as Record<string, unknown> | undefined;
	const bare =
		(errObj && (errObj.message || errObj.code)) || parsedEnd.message || JSON.stringify(parsedEnd).slice(0, 200);
	const bareText = String(bare || "unknown error");

	const details = errObj?.details;
	if (!Array.isArray(details) || details.length === 0) {
		return `Grok Bot connect error: ${bareText}`;
	}

	const parts: string[] = [];
	for (const entry of details) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		const debug = (row.debug && typeof row.debug === "object" ? row.debug : undefined) as
			| Record<string, unknown>
			| undefined;
		if (!debug) continue;
		const providerError = typeof debug.error === "string" ? debug.error : "";
		const nested =
			debug.details && typeof debug.details === "object" ? (debug.details as Record<string, unknown>) : undefined;
		const title = nested && typeof nested.title === "string" ? nested.title : "";
		const detail = nested && typeof nested.detail === "string" ? nested.detail : "";
		const info =
			nested?.additionalInfo && typeof nested.additionalInfo === "object"
				? (nested.additionalInfo as Record<string, unknown>)
				: undefined;
		const status =
			info && (typeof info.providerStatusCode === "string" || typeof info.providerStatusCode === "number")
				? String(info.providerStatusCode)
				: "";
		const chunk = [providerError, title, status ? `HTTP ${status}` : "", detail].filter(s => s.length > 0).join(": ");
		if (chunk) parts.push(chunk);
	}

	if (parts.length === 0) {
		return `Grok Bot connect error: ${bareText}`;
	}
	// Prefer structured detail when the bare connect message is opaque.
	const opaque = /^(error|internal error)$/i.test(bareText.trim());
	if (opaque) {
		return `Grok Bot connect error: ${parts.join("; ")}`;
	}
	return `Grok Bot connect error: ${bareText} (${parts.join("; ")})`;
}

export const streamGrokBot: StreamFunction<"grokbot-sand"> = (
	model: Model<"grokbot-sand">,
	context: Context,
	options?: GrokbotOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: GROKBOT_API as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const cfg = await loadGrokbotConfig();
			if (!cfg.machineId) {
				throw new Error("Grok Bot machine id missing (GROKBOT_MACHINE_ID or secrets/grokbot.env)");
			}
			const requestKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
			const renewal = requestKey && requestKey !== AUTHENTICATED_SENTINEL ? requestKey : cfg.renewal;
			if (!renewal) {
				throw new Error("Grok Bot renewer missing (GROKBOT_RENEWAL_CREDENTIAL or secrets/grokbot.env)");
			}
			const authCfg = { ...cfg, renewal };
			const fetchImpl = options?.fetch ?? fetch;
			const accessToken = await mintGrokbotAccessToken(
				authCfg,
				fetchImpl,
				model.baseUrl || GROKBOT_BACKEND,
				options?.signal,
				{ ...(model.headers ?? {}), ...(options?.headers ?? {}) },
			);
			const messages = toInferenceMessages(context);
			const identity = classifyModel("grokbot", model.id, { lenient: true });
			const tools = toInferenceTools(context.tools, identity);
			const grammarTools = buildGrammarToolIndex(context.tools);
			const conversationId = options?.conversationId || options?.sessionId || crypto.randomUUID();
			let emptyToolRetryUsed = false;
			let incompleteToolRetryUsed = false;
			let geminiProductRetryUsed = false;
			let started = false;
			let anthropicWire: AnthropicSandToolWireResult = {
				requestedModel: { modelId: model.id },
				tools,
				modelId: model.id,
			};
			let body: Record<string, unknown> = {};
			let routedResponseModel = "";
			/** Buffer first tool-enabled attempt until text/tool appears (or accept), so empty retries do not leak thinking_delta. */
			let attemptEventBuffer: AssistantMessageEvent[] = [];
			let attemptStreamingLive = false;
			const shouldBufferAttemptEvents = () =>
				tools.length > 0 && !emptyToolRetryUsed && !incompleteToolRetryUsed;
			const emitAttemptEvent = (event: AssistantMessageEvent) => {
				if (attemptStreamingLive || !shouldBufferAttemptEvents()) {
					stream.push(event);
					return;
				}
				attemptEventBuffer.push(event);
			};
			const flushAttemptEvents = () => {
				for (const event of attemptEventBuffer) stream.push(event);
				attemptEventBuffer = [];
				attemptStreamingLive = true;
			};
			const discardAttemptEvents = () => {
				attemptEventBuffer = [];
				attemptStreamingLive = false;
			};

			attempt: while (true) {
				const replayToolTurn = emptyToolRetryUsed || incompleteToolRetryUsed || geminiProductRetryUsed;
				const modelConfig = buildModelConfig(model, {
					...options,
					maxTokens: replayToolTurn ? Math.max(Number(options?.maxTokens) || 0, 4096) : options?.maxTokens,
				});
				const reqModel = resolveGrokbotRequestedModel(model.id, {
					effort: options?.effort,
					effortMap: model.thinking?.effortMap,
					fast: options?.fast,
					thinking: replayToolTurn ? false : options?.thinking,
					context: options?.context,
					sandParameterDefaults: model.sandParameterDefaults,
					sandParameterIds: replayToolTurn ? [] : model.sandParameterIds,
					sandMaxMode: model.sandMaxMode,
					canonicalModelId: model.requestModelId,
					sandVariantStringRepresentation: model.sandVariantStringRepresentation,
					sandWireModelId: model.sandWireModelId,
				});
				body = {
					messages,
					tools,
					requestedModel: reqModel,
					invocationId: crypto.randomUUID(),
					conversationId,
				};
				if (modelConfig) body.modelConfig = modelConfig;
				const retrySandWire = geminiProductRetryUsed ? "keep-model" : model.sandToolsWire;
				const resolvedWire = resolveAnthropicSandToolsWire(
					typeof process !== "undefined" ? process.env.GROKBOT_ANTHROPIC_TOOLS_WIRE : undefined,
					options?.anthropicToolsWire,
					{ modelId: model.id, toolCount: tools.length, sandToolsWire: retrySandWire },
				);
				anthropicWire = applyAnthropicSandToolWire(
					{
						requestedModel: reqModel,
						tools,
						modelId: model.id,
						ompTools: context.tools,
						sandToolsWire: retrySandWire,
					},
					resolvedWire,
				);
				if (anthropicWire.wireMode) {
					body.requestedModel = anthropicWire.requestedModel;
					body.tools = anthropicWire.tools;
					if (anthropicWire.subagentType) body.subagentType = anthropicWire.subagentType;
					if (anthropicWire.automationId) body.automationId = anthropicWire.automationId;
					if (anthropicWire.acceptedUnadvertisedToolNames?.length) {
						body.acceptedUnadvertisedToolNames = anthropicWire.acceptedUnadvertisedToolNames;
					}
					augmentToolIndexForProductWire(grammarTools, context.tools);
					if (
						anthropicWire.wireMode === "automation" ||
						anthropicWire.wireMode === "parent-chat" ||
						anthropicWire.wireMode === "keep-model"
					) {
						// History stores omp names (bash/read/write); product tools are
						// Shell/Read/Write — rewrite replayed call/result names to match.
						body.messages = rewriteInferenceMessagesForProductWire(
							(body.messages as Record<string, unknown>[]) ?? [],
						);
						logger.info("grokbot: product sand tool wire", {
							wireMode: anthropicWire.wireMode,
							originalModelId: anthropicWire.originalModelId,
							wireModelId: anthropicWire.requestedModel.modelId,
							subagentType: anthropicWire.subagentType,
							tools: anthropicWire.tools.length,
						});
					} else if (anthropicWire.wireMode === "sand-default-fallback") {
						logger.warn("grokbot: anthropic sand tool wire fallback", {
							originalModelId: anthropicWire.originalModelId,
							fallbackModelId: anthropicWire.requestedModel.modelId,
							tools: tools.length,
						});
					}
				}
				const replacementPayload = await options?.onPayload?.(body, model);
				if (replacementPayload !== undefined) {
					body = replacementPayload as Record<string, unknown>;
				}
				const protoBytes = encodeInferenceStreamRequest(body);
				const wireModel = body.requestedModel as GrokbotRequestedModel;
				const effort = (wireModel.parameters || []).find(p => p.id === "effort")?.value || "";
				const fast = (wireModel.parameters || []).find(p => p.id === "fast")?.value || "";

				// model.headers + options.headers first; provider-owned auth/client
				// headers win so reverse-proxy keys cannot override sand identity.
				// Case-insensitive merge prevents Authorization/authorization duplicates.
				const headers = mergeGrokbotHeaders(model.headers, options?.headers, grokbotClientHeaders(authCfg), {
					authorization: `Bearer ${accessToken}`,
					"x-cursor-checksum": createGrokbotChecksum(authCfg.machineId),
					"x-ghost-mode": "true",
					"x-request-id": crypto.randomUUID(),
					"content-type": "application/connect+proto",
					accept: "application/connect+proto",
					"connect-protocol-version": "1",
				});

				logger.debug("grokbot: stream request", {
					modelId: (body.requestedModel as GrokbotRequestedModel).modelId,
					maxMode: Boolean((body.requestedModel as GrokbotRequestedModel).maxMode),
					effort,
					fast,
					tools: tools.length,
					toolNames: tools.map(t => t.name),
					messages: messages.length,
					hasModelConfig: Boolean(modelConfig),
					anthropicWireMode: anthropicWire.wireMode,
					anthropicOriginalModelId: anthropicWire.originalModelId,
				});

				const backend = (model.baseUrl || GROKBOT_BACKEND).replace(/\/+$/, "");
				const response = await fetchImpl(joinGrokbotBackendUrl(backend, STREAM_PATH), {
					method: "POST",
					headers,
					body: frameConnectProto(protoBytes),
					signal: options?.signal,
				});
				await notifyProviderResponse(options, response, model, response.headers.get("x-request-id"));

				if (!response.ok || !response.body) {
					if (response.status === 401) clearGrokbotTokenCache();
					output.errorStatus = response.status;
					const errText = await response.text().catch(() => "");
					throw new Error(
						`Grok Bot stream failed (HTTP ${response.status})${errText ? `: ${errText.slice(0, 200)}` : ""}`,
					);
				}

				if (!started) {
					emitAttemptEvent({ type: "start", partial: output });
					started = true;
				}

				let openKind: "" | "text" | "thinking" = "";
				let openIndex = -1;
				let sendToUserArgsText = "";
				let sendToUserLastContent = "";
				const toolStates = new Map<
					string,
					{ key: string; index: number; block: ToolCall; argsText: string; ended: boolean; isGrammar: boolean }
				>();

				const closeOpen = () => {
					if (openKind === "text" && openIndex >= 0) {
						const block = output.content[openIndex] as TextContent;
						emitAttemptEvent({
							type: "text_end",
							contentIndex: openIndex,
							content: block?.text || "",
							partial: output,
						});
					} else if (openKind === "thinking" && openIndex >= 0) {
						const block = output.content[openIndex] as ThinkingContent;
						emitAttemptEvent({
							type: "thinking_end",
							contentIndex: openIndex,
							content: block?.thinking || "",
							partial: output,
						});
					}
					openKind = "";
					openIndex = -1;
				};

				const ensureText = () => {
					if (openKind === "text") return openIndex;
					closeOpen();
					openIndex = output.content.length;
					output.content.push({ type: "text", text: "" });
					openKind = "text";
					flushAttemptEvents();
					emitAttemptEvent({ type: "text_start", contentIndex: openIndex, partial: output });
					return openIndex;
				};

				const ensureThinking = () => {
					if (openKind === "thinking") return openIndex;
					closeOpen();
					openIndex = output.content.length;
					output.content.push({ type: "thinking", thinking: "" });
					openKind = "thinking";
					emitAttemptEvent({ type: "thinking_start", contentIndex: openIndex, partial: output });
					return openIndex;
				};

				const finishTool = (state: {
					ended: boolean;
					argsText: string;
					block: ToolCall;
					index: number;
					isGrammar: boolean;
				}) => {
					if (state.ended) return;
					// Parse before marking ended so malformed JSON does not leave a
					// "completed" state without a successful toolcall_end.
					state.block.arguments = normalizeProductWriteArgs(
						state.block.name,
						parseCompletedToolArgs(state.argsText, state.isGrammar),
					);
					clearStreamingPartialJson(state.block);
					state.ended = true;
					flushAttemptEvents();
					emitAttemptEvent({
						type: "toolcall_end",
						contentIndex: state.index,
						toolCall: state.block,
						partial: output,
					});
				};

				const handleSendToUser = (part: Record<string, unknown>) => {
					const argsText =
						part.args == null ? "" : typeof part.args === "string" ? part.args : JSON.stringify(part.args);
					if (argsText) sendToUserArgsText = argsText;
					const parsed = parseSendToUserContent(sendToUserArgsText);
					if (parsed !== undefined && parsed !== sendToUserLastContent) {
						const delta = parsed.startsWith(sendToUserLastContent)
							? parsed.slice(sendToUserLastContent.length)
							: parsed;
						sendToUserLastContent = parsed;
						if (delta) {
							const idx = ensureText();
							(output.content[idx] as TextContent).text += delta;
							emitAttemptEvent({ type: "text_delta", contentIndex: idx, delta, partial: output });
						}
					}
					if (part.isComplete ?? part.is_complete) closeOpen();
				};

				const upsertTool = (part: Record<string, unknown>) => {
					const id = String(part.toolCallId || part.tool_call_id || "");
					const name = String(part.toolName || part.tool_name || "");
					const argsText =
						part.args == null ? "" : typeof part.args === "string" ? part.args : JSON.stringify(part.args);
					const isComplete = Boolean(part.isComplete ?? part.is_complete);
					const indexHint = part.toolIndex ?? part.tool_index;
					const idxKey = typeof indexHint === "number" ? `idx:${indexHint}` : undefined;
					// Correlate chunks by id and/or index — frames may omit one of the two.
					let state =
						(id ? toolStates.get(id) : undefined) ?? (idxKey ? toolStates.get(idxKey) : undefined) ?? undefined;

					if (!state) {
						closeOpen();
						const meta = (name ? grammarTools.get(name) : undefined) ?? undefined;
						// Mark every grammar/customFormat call (hashline/sloppy have no
						// customWireName) so live preview + history replay stay on raw args.
						// Do not persist productWireName (Shell/Read/Write) — that alias is
						// lookup-only and must not flip OpenAI Responses into custom_tool_call.
						const grammarWire = meta?.isGrammar
							? meta.customWireName || meta.name || name || undefined
							: meta?.customWireName;
						const block: ToolCall = {
							type: "toolCall",
							id: id || `call_${output.content.length}`,
							name: meta?.name || name || "unknown",
							arguments: {},
							...(grammarWire ? { customWireName: grammarWire } : {}),
						};
						const index = output.content.length;
						output.content.push(block);
						const key = id || idxKey || `anon:${toolStates.size}`;
						state = {
							key,
							index,
							block,
							argsText: "",
							ended: false,
							isGrammar: Boolean(meta?.isGrammar),
						};
						toolStates.set(key, state);
						if (id) toolStates.set(id, state);
						if (idxKey) toolStates.set(idxKey, state);
						flushAttemptEvents();
						emitAttemptEvent({ type: "toolcall_start", contentIndex: index, partial: output });
					} else {
						if (id) toolStates.set(id, state);
						if (idxKey) toolStates.set(idxKey, state);
						if (name && (!state.block.name || state.block.name === "unknown")) {
							const meta = grammarTools.get(name);
							state.block.name = meta?.name || name;
							if (meta?.isGrammar) {
								state.isGrammar = true;
								state.block.customWireName = meta.customWireName || meta.name || name;
							} else if (meta?.customWireName) {
								state.block.customWireName = meta.customWireName;
							}
						}
					}
					if (id && state.block.id.startsWith("call_")) state.block.id = id;

					if (argsText && argsText !== state.argsText) {
						let delta = argsText;
						if (argsText.startsWith(state.argsText)) delta = argsText.slice(state.argsText.length);
						state.argsText = argsText;
						// Keep ToolCall.arguments + streamed buffer current so live
						// message_update snapshots show bash/edit previews mid-stream.
						setStreamingPartialJson(state.block, argsText);
						state.block.arguments = state.isGrammar ? { input: argsText } : parseToolArgs(argsText, false);
						if (delta) {
							emitAttemptEvent({
								type: "toolcall_delta",
								contentIndex: state.index,
								delta,
								partial: output,
							});
						}
					}
					if (isComplete) finishTool(state);
				};

				let pending = Buffer.alloc(0);
				let sawEndStream = false;
				const reader = (response.body as ReadableStream<Uint8Array>).getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						if (pending.length > 0 || !sawEndStream) {
							throw new AIError.ProviderResponseError(
								pending.length > 0
									? "Grok Bot stream ended with a truncated connect frame"
									: "Grok Bot stream ended without a connect end-stream trailer",
								{ provider: model.provider, kind: "incomplete-stream" },
							);
						}
						break;
					}
					pending = Buffer.concat([pending, Buffer.from(value)]);
					const frames: Array<{ flags: number; bytes: Buffer }> = [];
					let offset = 0;
					while (offset + 5 <= pending.length) {
						const flags = pending[offset]!;
						const len = pending.readUInt32BE(offset + 1);
						if (len > MAX_CONNECT_FRAME_PAYLOAD) {
							throw new Error(`Grok Bot connect frame too large (${len} bytes)`);
						}
						if (offset + 5 + len > pending.length) break;
						frames.push({ flags, bytes: pending.subarray(offset + 5, offset + 5 + len) });
						offset += 5 + len;
					}
					pending = pending.subarray(offset);

					for (const frame of frames) {
						if (frame.flags & CONNECT_END_STREAM_FLAG) {
							sawEndStream = true;
							const jsonText = Buffer.from(frame.bytes).toString("utf8").trim();
							let parsedEnd: Record<string, unknown> = {};
							if (jsonText) {
								try {
									parsedEnd = JSON.parse(jsonText) as Record<string, unknown>;
								} catch {
									throw new AIError.ProviderResponseError(
										"Grok Bot connect end-stream trailer is not valid JSON",
										{ provider: model.provider, kind: "envelope" },
									);
								}
							}
							const errObj = parsedEnd.error as Record<string, unknown> | undefined;
							const code = errObj ? String(errObj.code ?? "").toLowerCase() : "";
							if (errObj) {
								// Connect often reports revoked JWTs as end-stream
								// `unauthenticated` on HTTP 200; treat like HTTP 401.
								if (code === "unauthenticated") {
									clearGrokbotTokenCache();
									throw new Error(`${formatGrokbotConnectTrailerError(parsedEnd)} (HTTP 401)`);
								}
								throw new Error(formatGrokbotConnectTrailerError(parsedEnd));
							}
							continue;
						}

						let parsed: Record<string, unknown>;
						try {
							parsed = decodeInferenceStreamResponse(frame.bytes) as Record<string, unknown>;
						} catch (err) {
							if (frame.bytes.length === 0) continue;
							throw new AIError.ProviderResponseError(
								`Grok Bot stream frame decode failed: ${err instanceof Error ? err.message : String(err)}`,
								{ provider: model.provider, kind: "envelope" },
							);
						}

						const errObj = firstPresent(parsed, ["error"]);
						if (errObj && typeof errObj === "object") {
							const e = errObj as Record<string, unknown>;
							if (e.isOutputTokenLimitError || e.is_output_token_limit_error) {
								output.stopReason = "length";
								continue;
							}
							if (e.isInputTokenLimitError || e.is_input_token_limit_error) {
								throw new AIError.ProviderResponseError(
									"Grok Bot input token count exceeds the maximum context length",
									{ provider: model.provider, kind: "output" },
								);
							}
							if (e.message || e.code) throw new Error(String(e.message || e.code));
						}
						if (typeof errObj === "string" && errObj) throw new Error(errObj);

						const thinkingPart = firstPresent(parsed, ["thinkingPart", "thinking_part"]) as
							| Record<string, unknown>
							| undefined;
						if (thinkingPart) {
							const delta = String(thinkingPart.text || "");
							const signature =
								typeof thinkingPart.signature === "string" && thinkingPart.signature
									? thinkingPart.signature
									: undefined;
							if (delta || signature) {
								const idx = ensureThinking();
								const block = output.content[idx] as ThinkingContent;
								if (delta) {
									block.thinking += delta;
									emitAttemptEvent({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
								}
								if (signature) block.thinkingSignature = signature;
							}
							if (thinkingPart.isFinal || thinkingPart.is_final) closeOpen();
						}

						const textPart = firstPresent(parsed, ["textPart", "text_part"]) as
							| Record<string, unknown>
							| undefined;
						const textDelta =
							(textPart ? String(textPart.text || "") : "") ||
							(typeof parsed.text === "string" && !textPart && !thinkingPart ? parsed.text : "");
						if (textDelta) {
							const idx = ensureText();
							(output.content[idx] as TextContent).text += textDelta;
							emitAttemptEvent({ type: "text_delta", contentIndex: idx, delta: textDelta, partial: output });
						}
						if (textPart && (textPart.isFinal || textPart.is_final)) closeOpen();

						const toolPart = firstPresent(parsed, ["toolCallPart", "tool_call_part"]);
						if (toolPart && typeof toolPart === "object") {
							const wireToolName = String(
								(toolPart as Record<string, unknown>).toolName ||
									(toolPart as Record<string, unknown>).tool_name ||
									"",
							);
							if (wireToolName === SEND_TO_USER_WIRE_NAME) {
								handleSendToUser(toolPart as Record<string, unknown>);
							} else {
								upsertTool(toolPart as Record<string, unknown>);
							}
						}

						const usage = firstPresent(parsed, ["usage", "extendedUsage", "extended_usage"]);
						if (usage && typeof usage === "object") applyUsage(output, usage as Record<string, unknown>);

						const info = firstPresent(parsed, ["responseInfo", "response_info"]) as
							| Record<string, unknown>
							| undefined;
						if (info) {
							const errorMessage =
								(typeof info.errorMessage === "string" && info.errorMessage) ||
								(typeof info.error_message === "string" && info.error_message) ||
								"";
							if (errorMessage) {
								throw new Error(errorMessage);
							}
							if (typeof info.id === "string" && info.id) output.responseId = info.id;
							const routedModel =
								(typeof info.model === "string" && info.model) ||
								(typeof (info as { modelId?: string }).modelId === "string" &&
									(info as { modelId?: string }).modelId) ||
								"";
							if (routedModel) {
								routedResponseModel = routedModel;
								output.upstreamModel = routedModel;
							}
						}
					}
				}

				closeOpen();
				// Finalize incomplete ToolCallParts that already have a complete JSON
				// object (stream ended before isComplete). Drop leftover fragments
				// when the turn already has a completed tool or visible text so a
				// parent-chat Read/Write follow-up does not fail the whole id.
				const states = uniqueToolStates(toolStates);
				for (const state of states) {
					if (!state.ended && canFinalizeIncompleteToolArgs(state.argsText, state.isGrammar)) {
						finishTool(state);
					}
				}
				const leftovers = states.filter(s => !s.ended);
				if (leftovers.length > 0) {
					const hasComplete = states.some(s => s.ended);
					const hasText = output.content.some(
						b => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
					);
					if (hasComplete || hasText) {
						const drop = new Set(leftovers.map(s => s.index));
						output.content = output.content.filter((_, i) => !drop.has(i));
						for (const state of leftovers) state.ended = true;
						logger.info("grokbot: dropped incomplete leftover tool call", {
							count: leftovers.length,
							wireMode: anthropicWire.wireMode,
						});
					} else if (!incompleteToolRetryUsed && tools.length > 0) {
						incompleteToolRetryUsed = true;
						discardAttemptEvents();
						output.content = [];
						output.usage = {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						output.stopReason = "stop";
						logger.info("grokbot: retrying incomplete tool turn", { modelId: model.id });
						continue attempt;
					} else {
						throw new AIError.ProviderResponseError("Grok Bot stream ended with incomplete tool call", {
							provider: model.provider,
							kind: "incomplete-stream",
						});
					}
				}

				// sand-automation → cursor-grok-4.5-high often dumps a fenced
				// `{"name":"Shell","arguments":{…}}` instead of toolCallPart.
				// Gemini/GPT-mini thought-only turns hide the same JSON in thinking,
				// or emit ```tool_code / default_api.bash(...) instead.
				if (!output.content.some(b => b.type === "toolCall")) {
					const text = assistantTextForJsonPromotion(output.content);
					const advertised = advertisedNamesForJsonTextToolCall(body.tools, context.tools);
					const promoted = parseJsonTextToolCall(text, advertised) ?? parseGeminiInbandToolCall(text, advertised);
					if (promoted) {
						output.content = output.content.filter(b => b.type !== "text" && b.type !== "thinking");
						upsertTool({
							toolCallId: `call_json_${crypto.randomUUID()}`,
							toolName: promoted.name,
							args: JSON.stringify(promoted.arguments),
							isComplete: true,
						});
						logger.info("grokbot: promoted JSON-as-text tool call", {
							toolName: promoted.name,
							wireMode: anthropicWire.wireMode,
							routedResponseModel: routedResponseModel || undefined,
						});
					}
				}

				const hasVisibleText = output.content.some(
					b => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
				);
				const hasToolCall = output.content.some(b => b.type === "toolCall");
				// Trailer-only / thinking-only completions leave the agent with nothing to
				// retry or show — require visible text or a completed tool call, unless the
				// caller opted into empty responses (passive/zero-output advisors).
				if (!hasVisibleText && !hasToolCall && options?.acceptEmptyResponse !== true) {
					// Gemini 3 flash / GPT-5-mini often spend a low maxTokens budget on
					// thinking and emit nothing. One replay with thinking off + a larger
					// cap is enough for native bash/read/write to appear.
					if (!emptyToolRetryUsed && tools.length > 0) {
						emptyToolRetryUsed = true;
						if (
							identity.class === "gemini" &&
							anthropicWire.wireMode !== "keep-model" &&
							anthropicWire.wireMode !== "parent-chat" &&
							anthropicWire.wireMode !== "automation"
						) {
							geminiProductRetryUsed = true;
						}
						discardAttemptEvents();
						output.content = [];
						output.usage = {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						output.stopReason = "stop";
						logger.info("grokbot: retrying empty tool turn", {
							modelId: model.id,
							class: identity.class,
							geminiProductRetry: geminiProductRetryUsed,
						});
						continue attempt;
					}
					// Some Gemini turns empty-stop after Write (bash/read already
					// succeeded). Only accept when this request is the immediate
					// follow-up to a toolResult — not when an older result sits
					// earlier in an otherwise unanswered user turn.
					if (identity.class === "gemini" && contextEndsWithToolResult(context)) {
						logger.info("grokbot: accepting empty follow-up after tool result", {
							modelId: model.id,
							class: identity.class,
							wireMode: anthropicWire.wireMode,
						});
						flushAttemptEvents();
						break;
					}
					throw new AIError.ProviderResponseError("Grok Bot stream completed with no text or tool call", {
						provider: model.provider,
						kind: "empty-body",
					});
				}
				flushAttemptEvents();
				break;
			}
			const hasToolCall = output.content.some(b => b.type === "toolCall");
			if (output.stopReason !== "length") {
				output.stopReason = hasToolCall ? "toolUse" : "stop";
			}
			output.duration = Math.round(performance.now() - startTime);
			calculateCost(model, output.usage);
			logger.debug("grokbot: stream done", {
				stopReason: output.stopReason,
				contentTypes: output.content.map(b => b.type),
				upstreamProvider: output.upstreamProvider,
				routedResponseModel: routedResponseModel || undefined,
				anthropicWireMode: anthropicWire.wireMode,
				anthropicOriginalModelId: anthropicWire.originalModelId,
				usage: {
					input: output.usage.input,
					output: output.usage.output,
					totalTokens: output.usage.totalTokens,
				},
			});
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end(output);
		} catch (error) {
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				signal: options?.signal,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = Math.round(performance.now() - startTime);
			const httpMatch = /HTTP (\d{3})/.exec(output.errorMessage);
			if (httpMatch && output.errorStatus === undefined) {
				output.errorStatus = Number(httpMatch[1]);
			}
			if (output.errorStatus === 401) clearGrokbotTokenCache();
			logger.warn("grokbot: stream error", {
				message: output.errorMessage,
				errorStatus: output.errorStatus,
				stopReason: output.stopReason,
			});
			stream.push({ type: "error", reason: result.stopReason, error: output });
			stream.end(output);
		}
	})();

	return stream;
};
