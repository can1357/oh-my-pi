import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
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
	mintGrokbotAccessToken,
} from "./grokbot/auth";
import { resolveGrokbotRequestedModel } from "./grokbot/model-request";
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
	/** Sand `fast` parameter; defaults to true for parameterized models. */
	fast?: boolean;
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

function toInferenceTools(tools: Context["tools"]) {
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
		const entry: (typeof out)[number] = {
			name: wireName,
			description: typeof tool.description === "string" ? tool.description : "",
			parameters: toolParametersToJson(tool),
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

/** Map wire tool names (incl. customWireName) back to internal tool metadata. */
function buildGrammarToolIndex(
	tools: Context["tools"],
): Map<string, { name: string; customWireName?: string; isGrammar: boolean }> {
	const index = new Map<string, { name: string; customWireName?: string; isGrammar: boolean }>();
	if (!Array.isArray(tools)) return index;
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const customWireName =
			typeof tool.customWireName === "string" && tool.customWireName.trim() ? tool.customWireName.trim() : undefined;
		const isGrammar = Boolean(tool.customFormat && typeof tool.customFormat === "object");
		const meta = { name, customWireName, isGrammar };
		index.set(name, meta);
		if (customWireName) index.set(customWireName, meta);
	}
	return index;
}

/**
 * Parse completed tool args. Grammar/customFormat tools may emit raw patch text
 * (not JSON); wrap that as `{ input: raw }` like OpenAI freeform custom tools.
 */
function parseCompletedToolArgs(raw: unknown, isGrammar: boolean): Record<string, unknown> {
	if (isGrammar) {
		const text = raw == null ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
		if (text.trim()) {
			try {
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
			} catch {
				/* intentional raw grammar payload */
			}
		}
		return { input: text };
	}
	return parseToolArgs(raw, true);
}

function toolCallFromPart(part: unknown) {
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
	const wireName = customWireName || name;
	const tc: { toolCallId: string; toolName: string; args?: Record<string, unknown>; rawToolCallArgs?: string } = {
		toolCallId: id,
		toolName: wireName,
	};
	// Grammar/custom tools replay as wire name + raw input (protobuf field 4),
	// not internal name + Struct args.
	if (customWireName) {
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

	for (const msg of context.messages ?? []) {
		if (!msg || typeof msg !== "object") continue;
		const roleName = msg.role;
		const record = msg as unknown as Record<string, unknown>;

		if (roleName === "toolResult") {
			const internalName = String(record.toolName || record.tool_name || "");
			const meta = internalName ? toolWireIndex.get(internalName) : undefined;
			const wireName = meta?.customWireName || internalName;
			const part: Record<string, unknown> = {
				toolCallId: record.toolCallId || record.tool_call_id || "",
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
					const tc = toolCallFromPart(part);
					if (tc) {
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
	if (typeof raw === "object") return raw as Record<string, unknown>;
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
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
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

function firstPresent(obj: Record<string, unknown> | undefined, keys: string[]): unknown {
	if (!obj) return undefined;
	for (const key of keys) {
		if (obj[key] != null) return obj[key];
	}
	return undefined;
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
			const renewal = requestKey || cfg.renewal;
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
			const tools = toInferenceTools(context.tools);
			const grammarTools = buildGrammarToolIndex(context.tools);
			const modelConfig = buildModelConfig(model, options);
			const conversationId = options?.conversationId || options?.sessionId || crypto.randomUUID();
			const reqModel = resolveGrokbotRequestedModel(model.id, {
				effort: options?.effort,
				effortMap: model.thinking?.effortMap,
				fast: options?.fast,
				sandParameterIds: model.sandParameterIds,
				sandMaxMode: model.sandMaxMode,
				canonicalModelId: model.requestModelId,
			});
			let body: Record<string, unknown> = {
				messages,
				tools,
				requestedModel: reqModel,
				invocationId: crypto.randomUUID(),
				conversationId,
			};
			if (modelConfig) body.modelConfig = modelConfig;
			const replacementPayload = await options?.onPayload?.(body, model);
			if (replacementPayload !== undefined) {
				body = replacementPayload as Record<string, unknown>;
			}
			const protoBytes = encodeInferenceStreamRequest(body);
			const effort = (reqModel.parameters || []).find(p => p.id === "effort")?.value || "";
			const fast = (reqModel.parameters || []).find(p => p.id === "fast")?.value || "";

			// model.headers + options.headers first; provider-owned auth/client
			// headers win so reverse-proxy keys cannot override sand identity.
			const headers: Record<string, string> = {
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
				...grokbotClientHeaders(authCfg),
				authorization: `Bearer ${accessToken}`,
				"x-cursor-checksum": createGrokbotChecksum(authCfg.machineId),
				"x-ghost-mode": "true",
				"x-request-id": crypto.randomUUID(),
				"content-type": "application/connect+proto",
				accept: "application/connect+proto",
				"connect-protocol-version": "1",
			};

			logger.debug("grokbot: stream request", {
				modelId: reqModel.modelId,
				maxMode: Boolean(reqModel.maxMode),
				effort,
				fast,
				tools: tools.length,
				toolNames: tools.map(t => t.name),
				messages: messages.length,
				hasModelConfig: Boolean(modelConfig),
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

			stream.push({ type: "start", partial: output });

			let openKind: "" | "text" | "thinking" = "";
			let openIndex = -1;
			const toolStates = new Map<
				string,
				{ key: string; index: number; block: ToolCall; argsText: string; ended: boolean; isGrammar: boolean }
			>();

			const closeOpen = () => {
				if (openKind === "text" && openIndex >= 0) {
					const block = output.content[openIndex] as TextContent;
					stream.push({
						type: "text_end",
						contentIndex: openIndex,
						content: block?.text || "",
						partial: output,
					});
				} else if (openKind === "thinking" && openIndex >= 0) {
					const block = output.content[openIndex] as ThinkingContent;
					stream.push({
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
				stream.push({ type: "text_start", contentIndex: openIndex, partial: output });
				return openIndex;
			};

			const ensureThinking = () => {
				if (openKind === "thinking") return openIndex;
				closeOpen();
				openIndex = output.content.length;
				output.content.push({ type: "thinking", thinking: "" });
				openKind = "thinking";
				stream.push({ type: "thinking_start", contentIndex: openIndex, partial: output });
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
				state.block.arguments = parseCompletedToolArgs(state.argsText, state.isGrammar);
				clearStreamingPartialJson(state.block);
				state.ended = true;
				stream.push({
					type: "toolcall_end",
					contentIndex: state.index,
					toolCall: state.block,
					partial: output,
				});
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
					const block: ToolCall = {
						type: "toolCall",
						id: id || `call_${output.content.length}`,
						name: meta?.name || name || "unknown",
						arguments: {},
						...(meta?.customWireName ? { customWireName: meta.customWireName } : {}),
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
					stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				} else {
					if (id) toolStates.set(id, state);
					if (idxKey) toolStates.set(idxKey, state);
					if (name && (!state.block.name || state.block.name === "unknown")) {
						const meta = grammarTools.get(name);
						state.block.name = meta?.name || name;
						if (meta?.customWireName) state.block.customWireName = meta.customWireName;
						if (meta?.isGrammar) state.isGrammar = true;
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
						stream.push({
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
						const message =
							(errObj && (errObj.message || errObj.code)) || parsedEnd.message || jsonText.slice(0, 200);
						if (errObj) {
							throw new Error(`Grok Bot connect error: ${String(message)}`);
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
								stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
							}
							if (signature) block.thinkingSignature = signature;
						}
						if (thinkingPart.isFinal || thinkingPart.is_final) closeOpen();
					}

					const textPart = firstPresent(parsed, ["textPart", "text_part"]) as Record<string, unknown> | undefined;
					const textDelta =
						(textPart ? String(textPart.text || "") : "") ||
						(typeof parsed.text === "string" && !textPart && !thinkingPart ? parsed.text : "");
					if (textDelta) {
						const idx = ensureText();
						(output.content[idx] as TextContent).text += textDelta;
						stream.push({ type: "text_delta", contentIndex: idx, delta: textDelta, partial: output });
					}
					if (textPart && (textPart.isFinal || textPart.is_final)) closeOpen();

					const toolPart = firstPresent(parsed, ["toolCallPart", "tool_call_part"]);
					if (toolPart && typeof toolPart === "object") upsertTool(toolPart as Record<string, unknown>);

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
						// responseInfo.model is a routed model id (e.g. grok-4.5), not a
						// provider name — leave upstreamProvider unset unless wire exposes one.
					}
				}
			}

			closeOpen();
			// Only finalize tools that received isComplete. Incomplete ToolCallPart
			// states must not be parsed as {} / emitted as successful toolUse.
			for (const state of toolStates.values()) {
				if (!state.ended) {
					throw new AIError.ProviderResponseError("Grok Bot stream ended with incomplete tool call", {
						provider: model.provider,
						kind: "incomplete-stream",
					});
				}
			}

			const hasToolCall = output.content.some(b => b && b.type === "toolCall");
			if (output.stopReason !== "length") {
				output.stopReason = hasToolCall ? "toolUse" : "stop";
			}
			output.duration = Math.round(performance.now() - startTime);
			calculateCost(model, output.usage);
			logger.debug("grokbot: stream done", {
				stopReason: output.stopReason,
				contentTypes: output.content.map(b => b.type),
				upstreamProvider: output.upstreamProvider,
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
