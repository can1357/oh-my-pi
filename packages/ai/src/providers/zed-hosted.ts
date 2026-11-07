/**
 * Zed Hosted Models provider — cloud.zed.dev aggregator transport.
 *
 * Zed multiplexes Claude, Gemini, and GPT via cloud.zed.dev/completions using
 * short-lived LLM bearer tokens exchanged from Zed user credentials.
 */

import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	ImageContent,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolChoice,
} from "../types";
import { clearStreamingPartialJson, kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { normalizeSystemPrompts } from "../utils";

export const ZED_WEB_BASE_URL = "https://zed.dev";
export const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev";
export const ZED_LLM_TOKEN_PATH = "/client/llm_tokens";
export const ZED_COMPLETIONS_PATH = "/completions";
export const ZED_MODELS_PATH = "/models";
export const ZED_USERS_ME_PATH = "/client/users/me";

export const ZED_HEADERS = {
	expiredToken: "x-zed-expired-token",
	outdatedToken: "x-zed-outdated-token",
	clientSupportsStatus: "x-zed-client-supports-status-messages",
	clientSupportsStreamEnded: "x-zed-client-supports-stream-ended-request-completion-status",
	serverSupportsStatus: "x-zed-server-supports-status-messages",
	clientSupportsXai: "x-zed-client-supports-x-ai",
	systemId: "x-zed-system-id",
} as const;

const LLM_TOKEN_TTL_MS = 50 * 60 * 1000;
// ponytail: memory cache for short-lived LLM tokens, TTL 50 minutes
const llmTokenCache = new Map<string, { token: string; expiresAt: number }>();

export type ZedCredentials = {
	userId: string;
	accessToken: string;
	organizationId?: string;
	defaultOrganizationId?: string;
	email?: string;
	systemId?: string;
};

export interface ZedHostedOptions extends StreamOptions {
	userId?: string;
	accessToken?: string;
	organizationId?: string;
	sessionId?: string;
	toolChoice?: ToolChoice;
}

export function clearZedLlmTokenCache(): void {
	llmTokenCache.clear();
}

/**
 * Resolves Zed user credentials from OAuth or env or apiKey string.
 */
export function resolveZedCredentials(source?: string | Record<string, unknown> | null): ZedCredentials | null {
	if (!source) {
		const envToken = process.env.ZED_ACCESS_TOKEN || process.env.ZED_API_KEY;
		const envUserId = process.env.ZED_USER_ID;
		if (envToken && envUserId) {
			return {
				userId: envUserId.trim(),
				accessToken: envToken.trim(),
				organizationId: process.env.ZED_ORGANIZATION_ID?.trim(),
			};
		}
		return null;
	}

	if (typeof source === "string") {
		const str = source.trim();
		if (str.includes(":")) {
			const idx = str.indexOf(":");
			return { userId: str.slice(0, idx), accessToken: str.slice(idx + 1) };
		}
		if (str.includes(" ")) {
			const idx = str.indexOf(" ");
			return { userId: str.slice(0, idx), accessToken: str.slice(idx + 1) };
		}
		const envUserId = process.env.ZED_USER_ID;
		if (envUserId) {
			return { userId: envUserId.trim(), accessToken: str };
		}
		return null;
	}

	const rec = source;
	const accessToken = (rec.access || rec.accessToken || rec.apiKey) as string | undefined;
	const userId = (rec.accountId || rec.userId || rec.id) as string | undefined;
	const organizationId = (rec.orgId || rec.organizationId || rec.defaultOrganizationId) as string | undefined;

	if (accessToken && userId) {
		return {
			userId: String(userId).trim(),
			accessToken: String(accessToken).trim(),
			organizationId: organizationId ? String(organizationId).trim() : undefined,
			email: typeof rec.email === "string" ? rec.email : undefined,
			systemId: typeof rec.systemId === "string" ? rec.systemId : undefined,
		};
	}

	return null;
}

export function buildZedUserAuthHeader(credentials: ZedCredentials): string {
	return `${credentials.userId} ${credentials.accessToken}`;
}

export function resolveZedOrganizationId(
	credentials: ZedCredentials,
	userInfo?: Record<string, unknown> | null,
): string | undefined {
	if (credentials.organizationId) return credentials.organizationId;
	if (credentials.defaultOrganizationId) return credentials.defaultOrganizationId;
	if (!userInfo) return undefined;

	const defaultOrg = userInfo.default_organization_id || userInfo.defaultOrganizationId;
	if (typeof defaultOrg === "string" && defaultOrg) return defaultOrg;

	const orgs = Array.isArray(userInfo.organizations) ? (userInfo.organizations as Record<string, unknown>[]) : [];
	const personal = orgs.find(o => o.is_personal || o.isPersonal);
	const first = personal || orgs[0];
	if (first && typeof first.id === "string") return first.id;
	if (first && typeof first.id === "number") return String(first.id);
	return undefined;
}

export async function fetchZedAuthenticatedUser(
	credentials: ZedCredentials,
	options: { fetch?: FetchImpl; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
	const fetchImpl = options.fetch ?? fetch;
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: buildZedUserAuthHeader(credentials),
	};
	if (credentials.systemId) headers[ZED_HEADERS.systemId] = credentials.systemId;

	const res = await fetchImpl(`${ZED_CLOUD_BASE_URL}${ZED_USERS_ME_PATH}`, {
		method: "GET",
		headers,
		signal: options.signal,
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new AIError.OAuthError(`Failed to fetch Zed user profile: ${res.status} ${detail}`.trim(), {
			kind: "http",
			provider: "zed-hosted",
			status: res.status,
		});
	}

	return (await res.json()) as Record<string, unknown>;
}

export async function fetchZedLlmToken(
	credentials: ZedCredentials,
	options: { forceRefresh?: boolean; signal?: AbortSignal; fetch?: FetchImpl } = {},
): Promise<string> {
	let organizationId = credentials.organizationId;
	if (!organizationId) {
		const userInfo = await fetchZedAuthenticatedUser(credentials, options);
		organizationId = resolveZedOrganizationId(credentials, userInfo);
		if (organizationId) credentials.organizationId = organizationId;
	}
	if (!organizationId) {
		throw new AIError.OAuthError("No Zed organization found for account", {
			kind: "validation",
			provider: "zed-hosted",
		});
	}

	const cacheKey = `${credentials.userId}:${organizationId}:${credentials.accessToken.slice(-16)}`;
	const cached = llmTokenCache.get(cacheKey);
	if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) {
		return cached.token;
	}

	const fetchImpl = options.fetch ?? fetch;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		Authorization: buildZedUserAuthHeader(credentials),
	};
	if (credentials.systemId) headers[ZED_HEADERS.systemId] = credentials.systemId;

	const res = await fetchImpl(`${ZED_CLOUD_BASE_URL}${ZED_LLM_TOKEN_PATH}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ organization_id: organizationId }),
		signal: options.signal,
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new AIError.OAuthError(`Failed to exchange Zed LLM token: ${res.status} ${detail}`.trim(), {
			kind: "token-exchange",
			provider: "zed-hosted",
			status: res.status,
		});
	}

	const data = (await res.json()) as { token?: string };
	if (!data.token) {
		throw new AIError.OAuthError("Zed LLM token exchange returned empty token", {
			kind: "token-exchange",
			provider: "zed-hosted",
		});
	}

	llmTokenCache.set(cacheKey, { token: data.token, expiresAt: Date.now() + LLM_TOKEN_TTL_MS });
	return data.token;
}

export function shouldRefreshZedLlmToken(response: Response): boolean {
	return (
		response.status === 401 ||
		response.headers.has(ZED_HEADERS.expiredToken) ||
		response.headers.has(ZED_HEADERS.outdatedToken)
	);
}

export type ZedProviderName = "anthropic" | "google" | "openai";

export function normalizeZedProvider(value: unknown, model: unknown): ZedProviderName {
	const raw = String(value || "").toLowerCase();
	if (raw === "anthropic" || raw === "claude") return "anthropic";
	if (raw === "google" || raw === "gemini") return "google";
	if (raw === "openai" || raw === "chatgpt" || raw === "gpt") return "openai";
	const m = String(model || "").toLowerCase();
	if (m.includes("claude") || m.includes("anthropic")) return "anthropic";
	if (m.includes("gemini")) return "google";
	return "openai";
}

export type ZedLine = { done: true } | { status: Record<string, unknown> } | { event: unknown } | null;

export function unwrapZedLine(line: string): ZedLine {
	let text = line.replace(/\r$/, "").trim();
	if (!text) return null;
	if (text.startsWith("data:")) text = text.slice(5).trimStart();
	if (text === "[DONE]") return { done: true };
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed)) {
			if ("event" in parsed) return { event: parsed.event };
			if ("status" in parsed) {
				const status = parsed.status;
				if (typeof status === "string") return { status: { type: status } };
				if (isRecord(status)) {
					const [key] = Object.keys(status);
					if (key && isRecord(status[key])) {
						return { status: { type: key, ...(status[key] as Record<string, unknown>) } };
					}
					return { status };
				}
				return { status: { raw: status } };
			}
			return { event: parsed };
		}
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Provider request formatting
// ---------------------------------------------------------------------------
function extractMessageText(content: string | readonly (ImageContent | TextContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map(b => (b.type === "text" ? b.text : ""))
		.filter(Boolean)
		.join("\n\n");
}

function formatAnthropicRequest(model: string, context: Context, options?: ZedHostedOptions): Record<string, unknown> {
	let systemPrompt = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	const messages: Array<{ role: string; content: unknown }> = [];

	for (const msg of context.messages) {
		if (msg.role === "developer") {
			const text = extractMessageText(msg.content);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
			continue;
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: msg.content });
			} else {
				const blocks = msg.content.map(block => {
					if (block.type === "text") return { type: "text", text: block.text };
					if (block.type === "image") {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: block.mimeType || "image/png",
								data: block.data,
							},
						};
					}
					return block;
				});
				messages.push({ role: "user", content: blocks });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const blocks: unknown[] = [];
			for (const block of msg.content) {
				if (block.type === "text") blocks.push({ type: "text", text: block.text });
				else if (block.type === "thinking") blocks.push({ type: "thinking", thinking: block.thinking });
				else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: isRecord(block.arguments) ? block.arguments : {},
					});
				}
			}
			messages.push({ role: "assistant", content: blocks.length ? blocks : "" });
			continue;
		}

		if (msg.role === "toolResult") {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: msg.toolCallId,
						content,
						is_error: msg.isError,
					},
				],
			});
		}
	}

	const tools = context.tools?.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));

	return {
		model,
		messages,
		system: systemPrompt || undefined,
		max_tokens: options?.maxTokens ?? 8192,
		temperature: options?.temperature,
		stream: true,
		tools: tools?.length ? tools : undefined,
	};
}

function formatGoogleRequest(model: string, context: Context, options?: ZedHostedOptions): Record<string, unknown> {
	let systemPrompt = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

	for (const msg of context.messages) {
		if (msg.role === "developer") {
			const text = extractMessageText(msg.content);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
			continue;
		}

		if (msg.role === "user") {
			const parts: Array<Record<string, unknown>> = [];
			if (typeof msg.content === "string") {
				parts.push({ text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") parts.push({ text: block.text });
					else if (block.type === "image") {
						parts.push({
							inlineData: { mimeType: block.mimeType || "image/png", data: block.data },
						});
					}
				}
			}
			contents.push({ role: "user", parts });
			continue;
		}

		if (msg.role === "assistant") {
			const parts: Array<Record<string, unknown>> = [];
			for (const block of msg.content) {
				if (block.type === "text") parts.push({ text: block.text });
				else if (block.type === "thinking") parts.push({ text: block.thinking });
				else if (block.type === "toolCall") {
					parts.push({ functionCall: { name: block.name, args: block.arguments } });
				}
			}
			contents.push({ role: "model", parts });
			continue;
		}

		if (msg.role === "toolResult") {
			let response: unknown = {};
			try {
				response = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
			} catch {
				response = { output: msg.content };
			}
			contents.push({
				role: "function",
				parts: [{ functionResponse: { name: msg.toolName, response } }],
			});
		}
	}

	const tools = context.tools?.length
		? [
				{
					functionDeclarations: context.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
				},
			]
		: undefined;

	return {
		contents,
		systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
		generationConfig: {
			maxOutputTokens: options?.maxTokens,
			temperature: options?.temperature,
		},
		tools,
	};
}

function formatOpenAIRequest(model: string, context: Context, options?: ZedHostedOptions): Record<string, unknown> {
	const messages: Array<Record<string, unknown>> = [];
	const systemText = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	if (systemText) {
		messages.push({ role: "developer", content: systemText });
	}

	for (const msg of context.messages) {
		if (msg.role === "developer") {
			messages.push({ role: "developer", content: extractMessageText(msg.content) });
			continue;
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: msg.content });
			} else {
				const parts = msg.content.map(block => {
					if (block.type === "text") return { type: "text", text: block.text };
					if (block.type === "image") {
						const url = block.data.startsWith("data:")
							? block.data
							: `data:${block.mimeType || "image/png"};base64,${block.data}`;
						return { type: "image_url", image_url: { url } };
					}
					return block;
				});
				messages.push({ role: "user", content: parts });
			}
			continue;
		}

		if (msg.role === "assistant") {
			let content = "";
			const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
			for (const block of msg.content) {
				if (block.type === "text") content += block.text;
				else if (block.type === "toolCall") {
					toolCalls.push({
						id: block.id,
						type: "function",
						function: {
							name: block.name,
							arguments:
								typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments || {}),
						},
					});
				}
			}
			messages.push({
				role: "assistant",
				content: content || null,
				tool_calls: toolCalls.length ? toolCalls : undefined,
			});
			continue;
		}

		if (msg.role === "toolResult") {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content,
			});
		}
	}

	const tools = context.tools?.map(tool => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));

	return {
		model,
		messages,
		max_tokens: options?.maxTokens,
		temperature: options?.temperature,
		stream: true,
		tools: tools?.length ? tools : undefined,
	};
}

export function buildZedProviderRequest(
	provider: ZedProviderName,
	model: string,
	context: Context,
	options?: ZedHostedOptions,
): Record<string, unknown> {
	if (provider === "anthropic") return formatAnthropicRequest(model, context, options);
	if (provider === "google") return formatGoogleRequest(model, context, options);
	return formatOpenAIRequest(model, context, options);
}

// ---------------------------------------------------------------------------
// Stream implementation
// ---------------------------------------------------------------------------

export const streamZedHosted: StreamFunction<"zed-hosted"> = (
	model: Model<"zed-hosted">,
	context: Context,
	options?: ZedHostedOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const abortController = new AbortController();
		if (options?.signal) {
			options.signal.addEventListener("abort", () => abortController.abort(options.signal?.reason), { once: true });
		}

		const outputMessage: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
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
			const creds = resolveZedCredentials(options?.apiKey || (options as unknown as Record<string, unknown>));
			if (!creds) {
				throw new AIError.MissingApiKeyError(
					undefined,
					"Zed Hosted requires Zed credentials (run /login zed-hosted or set ZED_USER_ID and ZED_ACCESS_TOKEN).",
				);
			}
			if (options?.organizationId && !creds.organizationId) {
				creds.organizationId = options.organizationId;
			}
			const provider = normalizeZedProvider(model.providerType || model.headers?.["x-provider"], model.id);
			const providerRequest = buildZedProviderRequest(provider, model.id, context, options);

			let llmToken = await fetchZedLlmToken(creds, { signal: abortController.signal, fetch: options?.fetch });

			const payload = {
				thread_id: options?.sessionId || crypto.randomUUID(),
				prompt_id: crypto.randomUUID(),
				provider,
				model: model.id,
				provider_request: providerRequest,
			};

			const fetchImpl = options?.fetch ?? fetch;
			const requestHeaders: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "application/x-ndjson, text/event-stream, */*",
				Authorization: `Bearer ${llmToken}`,
				"User-Agent": "OMP/zed-hosted",
				[ZED_HEADERS.clientSupportsStatus]: "true",
				[ZED_HEADERS.clientSupportsStreamEnded]: "true",
				[ZED_HEADERS.clientSupportsXai]: "true",
				...model.headers,
				...options?.headers,
			};

			let response = await fetchImpl(`${ZED_CLOUD_BASE_URL}${ZED_COMPLETIONS_PATH}`, {
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify(payload),
				signal: abortController.signal,
			});

			if (shouldRefreshZedLlmToken(response)) {
				llmToken = await fetchZedLlmToken(creds, {
					forceRefresh: true,
					signal: abortController.signal,
					fetch: options?.fetch,
				});
				requestHeaders.Authorization = `Bearer ${llmToken}`;
				response = await fetchImpl(`${ZED_CLOUD_BASE_URL}${ZED_COMPLETIONS_PATH}`, {
					method: "POST",
					headers: requestHeaders,
					body: JSON.stringify(payload),
					signal: abortController.signal,
				});
			}

			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new AIError.ProviderHttpError(
					`Zed completions request failed: ${response.status} ${detail}`.trim(),
					response.status,
				);
			}

			if (!response.body) {
				throw new AIError.ProviderResponseError("Zed completions returned empty response body", {
					kind: "empty-body",
				});
			}

			stream.push({ type: "start", partial: outputMessage });

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			let currentBlock: TextContent | ThinkingContent | ToolCall | null = null;
			let currentBlockIndex = -1;

			const finishBlock = () => {
				if (!currentBlock || currentBlockIndex < 0) return;
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: currentBlockIndex,
						content: currentBlock.text,
						partial: outputMessage,
					});
				} else if (currentBlock.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: currentBlockIndex,
						content: currentBlock.thinking,
						partial: outputMessage,
					});
				} else if (currentBlock.type === "toolCall") {
					const raw = currentBlock[kStreamingPartialJson];
					if (raw) {
						try {
							currentBlock.arguments = JSON.parse(raw);
						} catch {
							currentBlock.arguments = {};
						}
					}
					clearStreamingPartialJson(currentBlock);
					stream.push({
						type: "toolcall_end",
						contentIndex: currentBlockIndex,
						toolCall: currentBlock,
						partial: outputMessage,
					});
				}
				currentBlock = null;
				currentBlockIndex = -1;
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const parsed = unwrapZedLine(line);
					if (!parsed) continue;

					if ("done" in parsed && parsed.done) {
						finishBlock();
						break;
					}

					if ("status" in parsed) {
						const status = parsed.status;
						const isFailed =
							status.type === "failed" || status.failed !== undefined || status.error !== undefined;
						if (isFailed) {
							let msg = "Zed status failed";
							if (isRecord(status.failed) && typeof status.failed.message === "string") {
								msg = status.failed.message;
							} else if (isRecord(status.error) && typeof status.error.message === "string") {
								msg = status.error.message;
							} else if (typeof status.message === "string") {
								msg = status.message;
							}
							throw new AIError.ProviderResponseError(msg, { kind: "output" });
						}
						continue;
					}

					if (!("event" in parsed) || !parsed.event || typeof parsed.event !== "object") continue;
					const event = parsed.event as Record<string, unknown>;

					// ─── 1. Anthropic Event Format ───
					if (provider === "anthropic") {
						const anthropicEvent = event;
						const type = anthropicEvent.type;

						if (type === "message_start") {
							const msg = anthropicEvent.message as Record<string, unknown> | undefined;
							const usage = msg?.usage as Record<string, number> | undefined;
							if (usage?.input_tokens) {
								outputMessage.usage.input += usage.input_tokens;
								outputMessage.usage.cacheRead += usage.cache_read_input_tokens || 0;
								outputMessage.usage.cacheWrite += usage.cache_creation_input_tokens || 0;
							}
						} else if (type === "content_block_start") {
							finishBlock();
							const block = anthropicEvent.content_block as Record<string, unknown> | undefined;
							if (block?.type === "text") {
								const textBlock: TextContent = { type: "text", text: (block.text as string) || "" };
								outputMessage.content.push(textBlock);
								currentBlockIndex = outputMessage.content.length - 1;
								currentBlock = textBlock;
								stream.push({
									type: "text_start",
									contentIndex: currentBlockIndex,
									partial: outputMessage,
								});
							} else if (block?.type === "thinking") {
								const thinkingBlock: ThinkingContent = {
									type: "thinking",
									thinking: (block.thinking as string) || "",
								};
								outputMessage.content.push(thinkingBlock);
								currentBlockIndex = outputMessage.content.length - 1;
								currentBlock = thinkingBlock;
								stream.push({
									type: "thinking_start",
									contentIndex: currentBlockIndex,
									partial: outputMessage,
								});
							} else if (block?.type === "tool_use") {
								const toolCallBlock: ToolCall = {
									type: "toolCall",
									id: (block.id as string) || crypto.randomUUID(),
									name: (block.name as string) || "",
									arguments: {},
									[kStreamingPartialJson]: "",
								};
								outputMessage.content.push(toolCallBlock);
								currentBlockIndex = outputMessage.content.length - 1;
								currentBlock = toolCallBlock;
								stream.push({
									type: "toolcall_start",
									contentIndex: currentBlockIndex,
									partial: outputMessage,
								});
							}
						} else if (type === "content_block_delta") {
							const delta = anthropicEvent.delta as Record<string, unknown> | undefined;
							if (delta?.type === "text_delta" && currentBlock?.type === "text") {
								const text = (delta.text as string) || "";
								currentBlock.text += text;
								stream.push({
									type: "text_delta",
									contentIndex: currentBlockIndex,
									delta: text,
									partial: outputMessage,
								});
							} else if (delta?.type === "thinking_delta" && currentBlock?.type === "thinking") {
								const thinking = (delta.thinking as string) || "";
								currentBlock.thinking += thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: currentBlockIndex,
									delta: thinking,
									partial: outputMessage,
								});
							} else if (delta?.type === "input_json_delta" && currentBlock?.type === "toolCall") {
								const part = (delta.partial_json as string) || "";
								currentBlock[kStreamingPartialJson] = (currentBlock[kStreamingPartialJson] || "") + part;
								stream.push({
									type: "toolcall_delta",
									contentIndex: currentBlockIndex,
									delta: part,
									partial: outputMessage,
								});
							}
						} else if (type === "content_block_stop") {
							finishBlock();
						} else if (type === "message_delta") {
							const delta = anthropicEvent.delta as Record<string, unknown> | undefined;
							if (delta?.stop_reason) {
								const stopReason = String(delta.stop_reason);
								if (stopReason === "tool_use") outputMessage.stopReason = "toolUse";
								else if (stopReason === "max_tokens") outputMessage.stopReason = "length";
								else outputMessage.stopReason = "stop";
							}
							const usage = anthropicEvent.usage as Record<string, number> | undefined;
							if (usage?.output_tokens) {
								outputMessage.usage.output += usage.output_tokens;
							}
						}
					}
					// ─── 2. Google Event Format ───
					else if (provider === "google") {
						const geminiEvent = event;
						const candidates = geminiEvent.candidates as Array<Record<string, unknown>> | undefined;
						const candidate = candidates?.[0];
						const parts = (candidate?.content as Record<string, unknown>)?.parts as
							| Array<Record<string, unknown>>
							| undefined;

						if (parts) {
							for (const part of parts) {
								if (typeof part.text === "string" && part.text) {
									const isThinking = !!part.thought;
									if (isThinking) {
										if (currentBlock?.type !== "thinking") {
											finishBlock();
											const thinkingBlock: ThinkingContent = { type: "thinking", thinking: "" };
											outputMessage.content.push(thinkingBlock);
											currentBlockIndex = outputMessage.content.length - 1;
											currentBlock = thinkingBlock;
											stream.push({
												type: "thinking_start",
												contentIndex: currentBlockIndex,
												partial: outputMessage,
											});
										}
										currentBlock.thinking += part.text;
										stream.push({
											type: "thinking_delta",
											contentIndex: currentBlockIndex,
											delta: part.text,
											partial: outputMessage,
										});
									} else {
										if (currentBlock?.type !== "text") {
											finishBlock();
											const textBlock: TextContent = { type: "text", text: "" };
											outputMessage.content.push(textBlock);
											currentBlockIndex = outputMessage.content.length - 1;
											currentBlock = textBlock;
											stream.push({
												type: "text_start",
												contentIndex: currentBlockIndex,
												partial: outputMessage,
											});
										}
										currentBlock.text += part.text;
										stream.push({
											type: "text_delta",
											contentIndex: currentBlockIndex,
											delta: part.text,
											partial: outputMessage,
										});
									}
								} else if (part.functionCall) {
									finishBlock();
									const fc = part.functionCall as { name?: string; args?: unknown };
									const args = isRecord(fc.args) ? fc.args : {};
									const toolCallBlock: ToolCall = {
										type: "toolCall",
										id: crypto.randomUUID(),
										name: fc.name || "",
										arguments: args,
									};
									outputMessage.content.push(toolCallBlock);
									currentBlockIndex = outputMessage.content.length - 1;
									currentBlock = toolCallBlock;
									stream.push({
										type: "toolcall_start",
										contentIndex: currentBlockIndex,
										partial: outputMessage,
									});
									stream.push({
										type: "toolcall_delta",
										contentIndex: currentBlockIndex,
										delta: JSON.stringify(args),
										partial: outputMessage,
									});
									finishBlock();
								}
							}
						}

						if (candidate?.finishReason) {
							const fr = String(candidate.finishReason);
							if (fr === "MAX_TOKENS") outputMessage.stopReason = "length";
							else outputMessage.stopReason = "stop";
						}

						const usage = geminiEvent.usageMetadata as Record<string, number> | undefined;
						if (usage) {
							outputMessage.usage.input = usage.promptTokenCount || outputMessage.usage.input;
							outputMessage.usage.output = usage.candidatesTokenCount || outputMessage.usage.output;
						}
					}
					// ─── 3. OpenAI Event Format ───
					else {
						const openaiEvent = event;
						const choices = openaiEvent.choices as Array<Record<string, unknown>> | undefined;
						const choice = choices?.[0];
						const delta = choice?.delta as Record<string, unknown> | undefined;

						if (delta) {
							// Thinking / reasoning delta
							const reasoning = (delta.reasoning_content || delta.reasoning || delta.thinking) as
								| string
								| undefined;
							if (typeof reasoning === "string" && reasoning) {
								if (currentBlock?.type !== "thinking") {
									finishBlock();
									const thinkingBlock: ThinkingContent = { type: "thinking", thinking: "" };
									outputMessage.content.push(thinkingBlock);
									currentBlockIndex = outputMessage.content.length - 1;
									currentBlock = thinkingBlock;
									stream.push({
										type: "thinking_start",
										contentIndex: currentBlockIndex,
										partial: outputMessage,
									});
								}
								currentBlock.thinking += reasoning;
								stream.push({
									type: "thinking_delta",
									contentIndex: currentBlockIndex,
									delta: reasoning,
									partial: outputMessage,
								});
							}

							// Text content delta
							const text = delta.content as string | undefined;
							if (typeof text === "string" && text) {
								if (currentBlock?.type !== "text") {
									finishBlock();
									const textBlock: TextContent = { type: "text", text: "" };
									outputMessage.content.push(textBlock);
									currentBlockIndex = outputMessage.content.length - 1;
									currentBlock = textBlock;
									stream.push({
										type: "text_start",
										contentIndex: currentBlockIndex,
										partial: outputMessage,
									});
								}
								currentBlock.text += text;
								stream.push({
									type: "text_delta",
									contentIndex: currentBlockIndex,
									delta: text,
									partial: outputMessage,
								});
							}

							// Tool calls delta
							const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
							if (Array.isArray(toolCalls)) {
								for (const tc of toolCalls) {
									const fn = tc.function as { name?: string; arguments?: string } | undefined;
									if (currentBlock?.type !== "toolCall" || (tc.id && currentBlock.id !== tc.id)) {
										finishBlock();
										const toolCallBlock: ToolCall = {
											type: "toolCall",
											id: (tc.id as string) || crypto.randomUUID(),
											name: fn?.name || "",
											arguments: {},
											[kStreamingPartialJson]: "",
										};
										outputMessage.content.push(toolCallBlock);
										currentBlockIndex = outputMessage.content.length - 1;
										currentBlock = toolCallBlock;
										stream.push({
											type: "toolcall_start",
											contentIndex: currentBlockIndex,
											partial: outputMessage,
										});
									}
									if (fn?.name && !currentBlock.name) currentBlock.name = fn.name;
									if (fn?.arguments) {
										currentBlock[kStreamingPartialJson] =
											(currentBlock[kStreamingPartialJson] || "") + fn.arguments;
										stream.push({
											type: "toolcall_delta",
											contentIndex: currentBlockIndex,
											delta: fn.arguments,
											partial: outputMessage,
										});
									}
								}
							}
						}

						if (choice?.finish_reason) {
							const fr = String(choice.finish_reason);
							if (fr === "tool_calls") outputMessage.stopReason = "toolUse";
							else if (fr === "length") outputMessage.stopReason = "length";
							else outputMessage.stopReason = "stop";
						}

						const usage = openaiEvent.usage as Record<string, number> | undefined;
						if (usage) {
							outputMessage.usage.input = usage.prompt_tokens || outputMessage.usage.input;
							outputMessage.usage.output = usage.completion_tokens || outputMessage.usage.output;
						}
					}
				}
			}

			finishBlock();

			outputMessage.usage.totalTokens = outputMessage.usage.input + outputMessage.usage.output;
			outputMessage.usage.cost = calculateCost(model, outputMessage.usage);

			const finalReason: Extract<StopReason, "stop" | "length" | "toolUse"> =
				outputMessage.stopReason === "toolUse" || outputMessage.stopReason === "length"
					? outputMessage.stopReason
					: "stop";

			stream.push({
				type: "done",
				reason: finalReason,
				message: outputMessage,
			});
			stream.end(outputMessage);
		} catch (error) {
			const isAbort = abortController.signal.aborted || (error instanceof Error && error.name === "AbortError");
			outputMessage.stopReason = isAbort ? "aborted" : "error";
			outputMessage.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason: isAbort ? "aborted" : "error",
				error: outputMessage,
			});
			stream.end(outputMessage);
		}
	})();

	return stream;
};
