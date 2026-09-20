/**
 * Grok Bot provider (`grokbot` / `grokbot-sand` API id).
 *
 * Speaks Cursor's sand `aiserver.v1.InferenceService/Stream` endpoint directly:
 * Connect-RPC with protobuf payloads, one request per turn carrying the full
 * conversation history plus tool schemas, streamed response parts assembled
 * into omp's AssistantMessage event model. omp owns the agentic loop — the
 * endpoint is used purely as an inference provider.
 *
 * Wire behavior (field maps, delta semantics, error shapes) is pinned by
 * deterministic synthetic fixtures in test/grokbot-wire.test.ts.
 */
import type { ReadableStreamDefaultReader as NodeReadableStreamDefaultReader } from "node:stream/web";
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
import { withReplaySafeStreamRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { notifyProviderResponse } from "../utils/provider-response";
import { toolWireSchema } from "../utils/schema/wire";
import { readBoundedGrokbotResponseText, redactGrokbotSecrets } from "./grokbot/body";
import { ToolCallAssembler } from "./grokbot/assemble";
import {
	clearGrokbotTokenCache,
	createGrokbotChecksum,
	GROKBOT_BACKEND,
	grokbotClientHeaders,
	joinGrokbotBackendUrl,
	mergeGrokbotHeaders,
	mergeGrokbotProviderHeaders,
	loadGrokbotConfig,
	mintGrokbotAccessToken,
} from "./grokbot/auth";
import { resolveGrokbotRequestedModel } from "./grokbot/model-request";
import {
	CONNECT_END_STREAM_FLAG,
	ConnectFrameReader,
	frameConnectProto,
	parseEndStreamTrailer,
} from "./grokbot/connect";
import {
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	INFERENCE_ROLE,
	type InferenceContentPart,
	type InferenceCoreMessage,
	type InferenceModelConfig,
	type InferenceReasoningPart,
	type InferenceStreamRequest,
	type InferenceTool,
	type InferenceToolCall,
	type InferenceToolResultPart,
} from "./grokbot/wire";

export {
	GROKBOT_BACKEND,
	getAccessTokenExpiryMs,
	resolveGrokbotClientVersion,
	stampedVersionBaseOf,
} from "./grokbot/auth";
export { resolveGrokbotRequestedModel, toSandEffortValue } from "./grokbot/model-request";

export const GROKBOT_API = "grokbot-sand" as const;
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";
const DEFAULT_IMAGE_MIME = "image/png";

export interface GrokbotOptions extends StreamOptions {
	/** Optional sand conversation id; preferred over sessionId, else a fresh UUID. */
	conversationId?: string;
	/** Sand effort parameter; when set from mapOptionsForApi, overrides the default `high`. */
	effort?: Effort | string;
	/** Sand `fast` parameter; defaults to true when the model advertises it. */
	fast?: boolean;
	/** Explicit sand `thinking` parameter; only sent for models that advertise it. */
	thinking?: boolean;
}

// ---------------------------------------------------------------------------
// Context → wire message conversion
// ---------------------------------------------------------------------------

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

function textPartsFromContent(content: unknown): string[] {
	if (typeof content === "string") return content ? [content] : [];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			if (part) out.push(part);
		} else if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = String((part as { text?: string }).text ?? "");
			if (text) out.push(text);
		}
	}
	return out;
}

/** User/system content → wire parts; images become data-URL image parts. */
function userPartsFromContent(content: unknown): InferenceContentPart[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: InferenceContentPart[] = [];
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

function customWireNameFromContentPart(part: unknown): string | undefined {
	if (!part || typeof part !== "object") return undefined;
	const p = part as Record<string, unknown>;
	if (p.type !== "toolCall" && p.type !== "tool-call" && p.type !== "tool_call") return undefined;
	return typeof p.customWireName === "string" && p.customWireName.trim() ? p.customWireName.trim() : undefined;
}

function toolCallFromContentPart(part: unknown): InferenceToolCall | undefined {
	if (!part || typeof part !== "object") return undefined;
	const p = part as Record<string, unknown>;
	if (p.type !== "toolCall" && p.type !== "tool-call" && p.type !== "tool_call") return undefined;
	const id = String(p.id ?? p.toolCallId ?? p.tool_call_id ?? "");
	const name = String(p.name ?? p.toolName ?? p.tool_name ?? "");
	const customWireName = customWireNameFromContentPart(part) ?? "";
	if (!id && !name && !customWireName) return undefined;
	const args = p.arguments ?? p.args ?? {};
	const wireName = customWireName || name;
	const tc: InferenceToolCall = { toolCallId: id, toolName: wireName };
	// Grammar/custom tools replay as wire name + raw input, not Struct args.
	if (customWireName) {
		if (typeof args === "string") {
			tc.rawToolCallArgs = args;
		} else if (args && typeof args === "object") {
			const input = (args as Record<string, unknown>).input;
			tc.rawToolCallArgs = typeof input === "string" ? input : JSON.stringify(args);
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
	}
	return tc;
}

function reasoningFromContentPart(part: unknown): InferenceReasoningPart | undefined {
	if (!part || typeof part !== "object") return undefined;
	const p = part as Record<string, unknown>;
	if (p.type === "thinking") {
		return {
			isRedacted: false,
			text: String(p.thinking ?? p.text ?? ""),
			signature: typeof p.thinkingSignature === "string" ? p.thinkingSignature : undefined,
		};
	}
	if (p.type === "redactedThinking" || p.type === "redacted-thinking") {
		return { isRedacted: true, text: "", redactedData: String(p.data ?? "") };
	}
	if (p.type === "reasoning") {
		return {
			isRedacted: false,
			text: String(p.text ?? ""),
			signature: typeof p.signature === "string" ? p.signature : undefined,
		};
	}
	return undefined;
}

function toolResultPayload(msg: Record<string, unknown>): unknown {
	const joined = textPartsFromContent(msg.content).join("\n");
	if (joined) return joined;
	if (msg.details !== undefined) {
		if (typeof msg.details === "string" || typeof msg.details === "number" || typeof msg.details === "boolean") {
			return String(msg.details);
		}
		try {
			return JSON.parse(JSON.stringify(msg.details));
		} catch {
			return "";
		}
	}
	return "";
}

/** Images inside tool results ride `experimentalContent` on the wire. */
function toolResultExperimentalContent(msg: Record<string, unknown>): InferenceContentPart[] | undefined {
	if (!Array.isArray(msg.content)) return undefined;
	const parts: InferenceContentPart[] = [];
	for (const part of msg.content) {
		const image = asImagePart(part);
		if (image) {
			parts.push({ type: "image", data: toSandImageDataUrl(image), mimeType: image.mimeType || DEFAULT_IMAGE_MIME });
		}
	}
	return parts.length ? parts : undefined;
}

/** @internal Exported for Grok Bot message-conversion contract tests. */
export function toInferenceMessages(context: Context): InferenceCoreMessage[] {
	const out: InferenceCoreMessage[] = [];
	const grammarTools = buildGrammarToolIndex(context.tools);
	const historicalCustomWireNames = new Map<string, string>();
	const system = context.systemPrompt;
	if (Array.isArray(system)) {
		const joined = system.filter((s): s is string => typeof s === "string").join("\n");
		if (joined.trim()) out.push({ role: INFERENCE_ROLE.system, text: joined });
	}

	for (const msg of context.messages ?? []) {
		if (!msg || typeof msg !== "object") continue;
		const record = msg as unknown as Record<string, unknown>;

		if (msg.role === "toolResult") {
			const internalToolName = String(record.toolName ?? record.tool_name ?? "");
			const toolCallId = String(record.toolCallId ?? record.tool_call_id ?? "");
			const historicalCustomWireName = historicalCustomWireNames.get(toolCallId);
			const tool = grammarTools.get(internalToolName);
			const part: InferenceToolResultPart = {
				toolCallId,
				toolName:
					historicalCustomWireName ??
					(tool?.isGrammar && tool.customWireName ? tool.customWireName : internalToolName),
				result: toolResultPayload(record),
			};
			if (record.isError) part.isError = true;
			const experimental = toolResultExperimentalContent(record);
			if (experimental) part.experimentalContent = experimental;
			out.push({ role: INFERENCE_ROLE.tool, toolContent: { parts: [part] } });
			continue;
		}

		if (msg.role === "assistant") {
			const toolCalls: InferenceToolCall[] = [];
			const reasoningParts: InferenceReasoningPart[] = [];
			const texts: string[] = [];
			const content = msg.content;
			if (typeof content === "string") {
				if (content) texts.push(content);
			} else if (Array.isArray(content)) {
				for (const part of content) {
					const tc = toolCallFromContentPart(part);
					if (tc) {
						toolCalls.push(tc);
						const customWireName = customWireNameFromContentPart(part);
						if (tc.toolCallId && customWireName) historicalCustomWireNames.set(tc.toolCallId, customWireName);
						continue;
					}
					const reasoning = reasoningFromContentPart(part);
					if (reasoning) {
						reasoningParts.push(reasoning);
						continue;
					}
					texts.push(...textPartsFromContent([part]));
				}
			}
			const text = texts.join("");
			const proto: InferenceCoreMessage = { role: INFERENCE_ROLE.assistant };
			if (text) proto.text = text;
			if (toolCalls.length) proto.toolCalls = toolCalls;
			if (reasoningParts.length) proto.reasoningParts = reasoningParts;
			if (text || toolCalls.length || reasoningParts.length) out.push(proto);
			continue;
		}

		const role = INFERENCE_ROLE[msg.role as keyof typeof INFERENCE_ROLE] ?? INFERENCE_ROLE.user;
		const parts = userPartsFromContent(msg.content);
		if (!parts.length) continue;
		if (parts.some(p => p.type === "image")) {
			out.push({ role, parts: { parts } });
		} else {
			const text = parts.map(p => (p.type === "text" ? p.text : "")).join("");
			if (text) out.push({ role, text });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

function toolParametersToJson(tool: Tool): Record<string, unknown> {
	try {
		return toolWireSchema(tool);
	} catch {
		return { type: "object", properties: {} };
	}
}

export function toInferenceTools(tools: Context["tools"]): InferenceTool[] {
	if (!Array.isArray(tools)) return [];
	const out: InferenceTool[] = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const entry: InferenceTool = {
			name:
				typeof tool.customWireName === "string" && tool.customWireName.trim() ? tool.customWireName.trim() : name,
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
		const meta = {
			name,
			customWireName,
			isGrammar: Boolean(tool.customFormat && typeof tool.customFormat === "object"),
		};
		index.set(name, meta);
		if (customWireName) index.set(customWireName, meta);
	}
	return index;
}

// ---------------------------------------------------------------------------
// Options → wire scalars
// ---------------------------------------------------------------------------

function buildModelConfig(model: Model<"grokbot-sand">, options?: GrokbotOptions): InferenceModelConfig | undefined {
	const cfg: InferenceModelConfig = {};
	const maxTokens = options?.maxTokens ?? model.maxTokens;
	if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) cfg.maxTokens = maxTokens;
	if (typeof options?.temperature === "number" && Number.isFinite(options.temperature))
		cfg.temperature = options.temperature;
	if (typeof options?.topP === "number" && Number.isFinite(options.topP)) cfg.topP = options.topP;
	if (Array.isArray(options?.stopSequences) && options.stopSequences.length) {
		cfg.stopSequences = options.stopSequences.filter((s): s is string => typeof s === "string");
	}
	return Object.keys(cfg).length ? cfg : undefined;
}

// ---------------------------------------------------------------------------
// Tool argument parsing
// ---------------------------------------------------------------------------

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

/**
 * Parse completed tool args. Grammar/customFormat tools emit raw patch text
 * (not JSON); wrap that as `{ input: raw }` like OpenAI freeform custom tools.
 */
function parseCompletedToolArgs(raw: string, isGrammar: boolean): Record<string, unknown> {
	if (!isGrammar) return parseToolArgs(raw, true);
	if (raw.trim()) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			/* intentional raw grammar payload */
		}
	}
	return { input: raw };
}

function applyUsage(output: AssistantMessage, usage: { input: number; output: number; total?: number }): void {
	output.usage.input = usage.input;
	output.usage.output = usage.output;
	output.usage.totalTokens = usage.total ?? usage.input + usage.output;
}

function applyExtendedUsage(
	output: AssistantMessage,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
	output.usage.input = usage.input;
	output.usage.output = usage.output;
	output.usage.cacheRead = usage.cacheRead;
	output.usage.cacheWrite = usage.cacheWrite;
}

// ---------------------------------------------------------------------------
// Stream function
// ---------------------------------------------------------------------------

const streamGrokBotOnce = (
	model: Model<"grokbot-sand">,
	context: Context,
	options: GrokbotOptions = {},
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

		let openKind: "" | "text" | "thinking" = "";
		let openIndex = -1;
		const closeOpen = () => {
			if (openKind === "text" && openIndex >= 0) {
				const block = output.content[openIndex] as TextContent;
				stream.push({ type: "text_end", contentIndex: openIndex, content: block?.text || "", partial: output });
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
		const toolStates = new Map<
			string,
			{ index: number; block: ToolCall; argsText: string; isGrammar: boolean; ended: boolean }
		>();
		const clearPartialToolJson = () => {
			for (const entry of toolStates.values()) clearStreamingPartialJson(entry.block);
		};
		let response: Response | undefined;
		let chunkReader: NodeReadableStreamDefaultReader<Uint8Array> | undefined;
		let bodyReadCompletely = false;
		let activeAccessToken = "";

		try {
			// OAuth credentials keep the renewal credential and machine id in one
			// structured envelope. Those values mint the short-lived stream JWT.
			let requestKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
			let requestMachineId = "";
			if (requestKey.startsWith("{")) {
				try {
					const structured = JSON.parse(requestKey) as { renewal?: string; machineId?: string };
					if (structured.renewal) requestKey = structured.renewal.trim();
					requestMachineId = structured.machineId?.trim() ?? "";
				} catch {
					/* plain bearer string */
				}
			}
			const cfg = loadGrokbotConfig(requestKey || undefined);
			const machineId = requestMachineId || cfg.machineId;
			if (!machineId) {
				throw new Error(
					"Grok Bot machine id missing. Run `/login grokbot` — it stores the credential and machine id together.",
				);
			}
			const renewal = requestKey || cfg.renewal;
			if (!renewal) {
				throw new Error(
					"Grok Bot inference requires a renewal credential. Run `/login grokbot` — it signs in, bootstraps the box, " +
						"and stores everything. (A bare OAuth account token is not sufficient: InferenceService only accepts " +
						"the box-scoped renewer.)",
				);
			}
			const authCfg = { ...cfg, renewal, machineId };
			const fetchImpl = options?.fetch ?? fetch;
			const messages = toInferenceMessages(context);
			const tools = toInferenceTools(context.tools);
			const grammarTools = buildGrammarToolIndex(context.tools);
			const modelConfig = buildModelConfig(model, options);
			const conversationId = options?.conversationId || options?.sessionId || crypto.randomUUID();
			const reqModel = resolveGrokbotRequestedModel(model.id, {
				effort: options?.effort,
				fast: options?.fast,
				thinking: options?.thinking,
				sandParameterIds: model.sandParameterIds,
				sandEffortValues: model.sandEffortValues,
				sandMaxMode: model.sandMaxMode,
				canonicalModelId: model.requestModelId,
			});
			const request: InferenceStreamRequest = {
				messages,
				tools,
				requestedModel: reqModel,
				invocationId: crypto.randomUUID(),
				conversationId,
				...(modelConfig ? { modelConfig } : {}),
			};
			const replacementPayload = await options?.onPayload?.(request, model);
			const protoBytes = encodeInferenceStreamRequest(
				replacementPayload !== undefined ? (replacementPayload as InferenceStreamRequest) : request,
			);

			// model.headers + options.headers first; provider-owned auth/client
			// headers win so reverse-proxy keys cannot override sand identity.
			logger.debug("grokbot: stream request", {
				modelId: reqModel.modelId,
				maxMode: Boolean(reqModel.maxMode),
				tools: tools.length,
				messages: messages.length,
			});

			const backend = (model.baseUrl || GROKBOT_BACKEND).replace(/\/+$/, "");
			const callerHeaders = mergeGrokbotHeaders(model.headers, options?.headers);
			for (let attempt = 0; attempt < 2; attempt++) {
				activeAccessToken = await mintGrokbotAccessToken(
					authCfg,
					fetchImpl,
					model.baseUrl || GROKBOT_BACKEND,
					options?.signal,
					callerHeaders,
				);
				const headers = mergeGrokbotProviderHeaders([callerHeaders], {
					...grokbotClientHeaders(authCfg),
					authorization: `Bearer ${activeAccessToken}`,
					"x-cursor-checksum": createGrokbotChecksum(machineId),
					"x-ghost-mode": "true",
					"x-request-id": crypto.randomUUID(),
					"content-type": "application/connect+proto",
					accept: "application/connect+proto",
					"connect-protocol-version": "1",
				});
				response = await fetchImpl(joinGrokbotBackendUrl(backend, STREAM_PATH), {
					method: "POST",
					headers,
					body: frameConnectProto(protoBytes),
					signal: options?.signal,
				});
				await notifyProviderResponse(options, response, model, response.headers.get("x-request-id"));
				if (response.status !== 401 || attempt === 1) break;
				clearGrokbotTokenCache();
				await response.body?.cancel().catch(() => {});
				response = undefined;
			}
			if (!response) throw new Error("Grok Bot stream request did not return a response");
			if (!response.ok || !response.body) {
				output.errorStatus = response.status;
				const errText = await readBoundedGrokbotResponseText(response)
					.then(body => redactGrokbotSecrets(body.text, [activeAccessToken]).slice(0, 200))
					.catch(() => "");
				throw new AIError.ProviderResponseError(
					`Grok Bot stream failed (HTTP ${response.status})${errText ? `: ${errText}` : ""}`,
					{ provider: model.provider, kind: "envelope" },
				);
			}

			stream.push({ type: "start", partial: output });
			let lastVisibleThinking: ThinkingContent | undefined;

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

			const assembler = new ToolCallAssembler();

			const finishTool = (entry: {
				index: number;
				block: ToolCall;
				argsText: string;
				isGrammar: boolean;
				ended: boolean;
			}) => {
				if (entry.ended) return;
				// Parse before marking ended so malformed JSON does not leave a
				// "completed" state without a successful toolcall_end.
				entry.block.arguments = parseCompletedToolArgs(entry.argsText, entry.isGrammar);
				clearStreamingPartialJson(entry.block);
				entry.ended = true;
				stream.push({ type: "toolcall_end", contentIndex: entry.index, toolCall: entry.block, partial: output });
			};

			const reader = new ConnectFrameReader();
			const responseBody = response.body as ReadableStream<Uint8Array>;
			const responseReader = responseBody.getReader();
			chunkReader = responseReader;
			streamRead: while (true) {
				const { done, value } = await responseReader.read();
				if (done) {
					throw new AIError.ProviderResponseError(
						reader.buffered > 0
							? "Grok Bot stream ended with a truncated connect frame"
							: "Grok Bot stream ended without a connect end-stream trailer",
						{ provider: model.provider, kind: "incomplete-stream" },
					);
				}
				for (const frame of reader.push(value)) {
					if (frame.flags & CONNECT_END_STREAM_FLAG) {
						const trailer = parseEndStreamTrailer(frame.bytes);
						if (trailer.error) {
							const message = redactGrokbotSecrets(
								trailer.error.message || trailer.error.code || "unknown connect error",
								[activeAccessToken],
							);
							const hint =
								trailer.error.code === "resource_exhausted" && tools.length > 0
									? " — this model may not support agent tools; select a tool-capable Grok Bot model"
									: "";
							throw new AIError.ProviderResponseError(`Grok Bot connect error: ${message}${hint}`, {
								provider: model.provider,
								kind: "envelope",
							});
						}
						break streamRead;
					}

					for (const part of decodeInferenceStreamResponse(frame.bytes)) {
						switch (part.kind) {
							case "text": {
								if (part.text) {
									const idx = ensureText();
									(output.content[idx] as TextContent).text += part.text;
									stream.push({ type: "text_delta", contentIndex: idx, delta: part.text, partial: output });
								}
								if (part.isFinal) closeOpen();
								break;
							}
							case "thinking": {
								// Sand often ships opaque reasoning signatures with no
								// plaintext (grok-4.6). A textless block is transcript
								// noise, but its signature belongs to the most recently
								// emitted visible thinking block.
								if (part.text) {
									const idx = ensureThinking();
									const block = output.content[idx] as ThinkingContent;
									block.thinking += part.text;
									if (part.signature) block.thinkingSignature = part.signature;
									lastVisibleThinking = block;
									stream.push({
										type: "thinking_delta",
										contentIndex: idx,
										delta: part.text,
										partial: output,
									});
								} else if (part.signature && lastVisibleThinking) {
									lastVisibleThinking.thinkingSignature = part.signature;
								}
								if (part.isFinal) closeOpen();
								break;
							}
							case "toolCall": {
								const state = assembler.onToolCallPart(part);
								let entry = toolStates.get(part.toolCallId);
								if (!entry) {
									closeOpen();
									const meta = (part.toolName ? grammarTools.get(part.toolName) : undefined) ?? undefined;
									const customWireName = meta?.isGrammar
										? (meta.customWireName ?? part.toolName ?? meta.name)
										: undefined;
									const block: ToolCall = {
										type: "toolCall",
										id: part.toolCallId || `call_${output.content.length}`,
										name: meta?.name || part.toolName || "unknown",
										arguments: {},
										...(customWireName ? { customWireName } : {}),
									};
									const index = output.content.length;
									output.content.push(block);
									entry = { index, block, argsText: "", isGrammar: Boolean(meta?.isGrammar), ended: false };
									toolStates.set(part.toolCallId, entry);
									stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
								} else if (part.toolName && (entry.block.name === "unknown" || !entry.block.name)) {
									const meta = grammarTools.get(part.toolName);
									entry.block.name = meta?.name || part.toolName;
									if (meta?.isGrammar) {
										entry.block.customWireName = meta.customWireName ?? part.toolName ?? meta.name;
										entry.isGrammar = true;
									}
								}
								if (state.delta !== undefined && !entry.ended) {
									entry.argsText = state.argsText;
									setStreamingPartialJson(entry.block, state.argsText);
									if (entry.isGrammar) entry.block.arguments = { input: state.argsText };
									stream.push({
										type: "toolcall_delta",
										contentIndex: entry.index,
										delta: state.delta,
										partial: output,
									});
								}
								if (part.isComplete) finishTool(entry);
								break;
							}
							case "usage": {
								applyUsage(output, part);
								break;
							}
							case "extendedUsage": {
								applyExtendedUsage(output, part);
								break;
							}
							case "responseInfo": {
								if (part.errorMessage)
									throw new Error(redactGrokbotSecrets(part.errorMessage, [activeAccessToken]));
								if (part.messageId?.startsWith("msg_")) output.responseId = part.messageId;
								// responseInfo.model is a routed model id, not a provider
								// name — leave upstreamProvider unset unless the wire adds one.
								break;
							}
							case "error": {
								if (part.isOutputTokenLimitError) {
									output.stopReason = "length";
									break;
								}
								if (part.isInputTokenLimitError) {
									throw new AIError.ProviderResponseError(
										"Grok Bot input token count exceeds the maximum context length",
										{ provider: model.provider, kind: "output" },
									);
								}
								throw new Error(
									redactGrokbotSecrets(String(part.message || part.code || "Grok Bot stream error"), [
										activeAccessToken,
									]),
								);
							}
							case "invocationId":
							case "providerMetadata":
								break; // echo frames; nothing to apply
						}
					}
				}
			}
			await responseReader.cancel().catch(() => {});
			bodyReadCompletely = true;
			responseReader.releaseLock();
			chunkReader = undefined;

			closeOpen();
			// Only finalize tools that received isComplete. Incomplete ToolCallPart
			// states must not be parsed as {} / emitted as successful toolUse.
			for (const entry of toolStates.values()) {
				if (!entry.ended) {
					throw new AIError.ProviderResponseError("Grok Bot stream ended with incomplete tool call", {
						provider: model.provider,
						kind: "incomplete-stream",
					});
				}
			}

			const hasToolCall = output.content.some(block => block && block.type === "toolCall");
			if (output.stopReason !== "length") {
				output.stopReason = hasToolCall ? "toolUse" : "stop";
			}
			output.duration = Math.round(performance.now() - startTime);
			calculateCost(model, output.usage);
			logger.debug("grokbot: stream done", {
				stopReason: output.stopReason,
				contentTypes: output.content.map(block => block.type),
				usage: {
					input: output.usage.input,
					output: output.usage.output,
					totalTokens: output.usage.totalTokens,
				},
			});
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end(output);
		} catch (error) {
			closeOpen();
			clearPartialToolJson();
			if (chunkReader) {
				await chunkReader.cancel().catch(() => {});
				chunkReader.releaseLock();
			} else if (!bodyReadCompletely) {
				await response?.body?.cancel().catch(() => {});
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				signal: options?.signal,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = redactGrokbotSecrets(result.message, [activeAccessToken]);
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

/** Retry replay-safe empty Grok Bot completions before they reach the agent loop. */
export const streamGrokBot: StreamFunction<"grokbot-sand"> = (model, context, options) =>
	withReplaySafeStreamRetry(model, context, options, streamGrokBotOnce, {
		retryEmptyCompletion: true,
	});
