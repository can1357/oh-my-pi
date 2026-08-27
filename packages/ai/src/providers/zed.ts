import * as crypto from "node:crypto";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { parseZedCredentials, ZED_APP_VERSION, ZED_CLOUD_URL, ZED_HEADERS } from "@oh-my-pi/pi-catalog/wire/zed";
import { ProviderHttpError, ProviderResponseError } from "../../src/error";
import { OAuthError } from "../../src/error/oauth";
import { getOrMintZedLlmToken, invalidateZedLlmToken } from "../registry/oauth/zed-token-pool";
import type {
	AssistantMessage,
	Context,
	Effort,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

export interface ZedOptions extends StreamOptions {
	threadId?: string;
	promptId?: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
}

export type ZedProviderKind = "anthropic" | "open_ai" | "google" | "x_ai";

export function resolveProviderKind(modelId: string): ZedProviderKind {
	const lower = modelId.toLowerCase();
	if (lower.startsWith("claude-")) return "anthropic";
	if (
		lower.startsWith("gpt-") ||
		lower.startsWith("o1") ||
		lower.startsWith("o3") ||
		lower.startsWith("codex") ||
		lower.includes("openai")
	) {
		return "open_ai";
	}
	if (lower.startsWith("gemini-")) return "google";
	if (lower.startsWith("grok-")) return "x_ai";
	return "anthropic";
}

function mapContextToAnthropic(context: Context, model: Model<"zed-agent">, options?: ZedOptions) {
	const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];

	for (const msg of context.messages) {
		if (msg.role === "user" || msg.role === "developer") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: msg.content });
			} else {
				const contentBlocks = msg.content.map(block => {
					if (block.type === "text") {
						return { type: "text", text: block.text };
					}
					if (block.type === "image") {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: block.mimeType,
								data: block.data,
							},
						};
					}
					return { type: "text", text: JSON.stringify(block) };
				});
				messages.push({ role: "user", content: contentBlocks });
			}
		} else if (msg.role === "assistant") {
			const contentBlocks: unknown[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					contentBlocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const thinkingBlock: Record<string, unknown> = {
						type: "thinking",
						thinking: block.thinking,
					};
					if (block.thinkingSignature) {
						thinkingBlock.signature = block.thinkingSignature;
					}
					contentBlocks.push(thinkingBlock);
				} else if (block.type === "toolCall") {
					contentBlocks.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: block.arguments,
					});
				}
			}
			messages.push({ role: "assistant", content: contentBlocks });
		} else if (msg.role === "toolResult") {
			const contentBlocks: unknown[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					contentBlocks.push({
						type: "tool_result",
						tool_use_id: msg.toolCallId,
						content: block.text,
						is_error: msg.isError,
					});
				} else if (block.type === "image") {
					contentBlocks.push({
						type: "tool_result",
						tool_use_id: msg.toolCallId,
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: block.mimeType,
									data: block.data,
								},
							},
						],
						is_error: msg.isError,
					});
				}
			}
			if (contentBlocks.length === 0) {
				contentBlocks.push({
					type: "tool_result",
					tool_use_id: msg.toolCallId,
					content: "",
					is_error: msg.isError,
				});
			}
			messages.push({ role: "user", content: contentBlocks });
		}
	}

	const tools = context.tools?.map(t => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters ?? { type: "object", properties: {} },
	}));

	const isReasoning = model.reasoning && !options?.disableReasoning;
	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		max_tokens: model.maxTokens || 8192,
	};

	if (context.systemPrompt && context.systemPrompt.length > 0) {
		body.system = context.systemPrompt.join("\n\n");
	}

	if (tools && tools.length > 0) {
		body.tools = tools;
	}

	if (isReasoning) {
		body.thinking = {
			type: "adaptive",
			display: "summarized",
		};
		body.output_config = {
			effort: options?.reasoning ?? "medium",
		};
	}

	return body;
}

function mapContextToOpenAiResponses(context: Context, model: Model<"zed-agent">, options?: ZedOptions) {
	const input: Array<Record<string, unknown>> = [];

	for (const msg of context.messages) {
		if (msg.role === "user" || msg.role === "developer") {
			const parts: Array<Record<string, unknown>> = [];
			if (typeof msg.content === "string") {
				parts.push({ type: "input_text", text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") {
						parts.push({ type: "input_text", text: block.text });
					} else if (block.type === "image") {
						parts.push({
							type: "input_image",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}
			}
			input.push({ type: "message", role: "user", content: parts });
		} else if (msg.role === "assistant") {
			const parts: Array<Record<string, unknown>> = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ type: "output_text", text: block.text });
				} else if (block.type === "toolCall") {
					input.push({
						type: "function_call",
						call_id: block.id,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}
			if (parts.length > 0) {
				input.push({ type: "message", role: "assistant", content: parts });
			}
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter(b => b.type === "text")
				.map(b => (b as TextContent).text)
				.join("\n");
			input.push({
				type: "function_call_output",
				call_id: msg.toolCallId,
				output: textResult,
			});
		}
	}

	const tools = context.tools?.map(t => ({
		type: "function",
		name: t.name,
		description: t.description,
		parameters: t.parameters ?? { type: "object", properties: {} },
	}));

	const isReasoning = model.reasoning && !options?.disableReasoning;
	const body: Record<string, unknown> = {
		model: model.id,
		input,
		stream: true,
	};

	if (context.systemPrompt && context.systemPrompt.length > 0) {
		body.instructions = context.systemPrompt.join("\n\n");
	}

	if (tools && tools.length > 0) {
		body.tools = tools;
	}

	if (isReasoning) {
		body.reasoning = {
			effort: options?.reasoning ?? "medium",
			summary: "auto",
		};
	}

	return body;
}

function mapContextToGoogle(context: Context, _model: Model<"zed-agent">) {
	const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

	for (const msg of context.messages) {
		if (msg.role === "user" || msg.role === "developer") {
			const parts: Array<Record<string, unknown>> = [];
			if (typeof msg.content === "string") {
				parts.push({ text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") {
						parts.push({ text: block.text });
					} else if (block.type === "image") {
						parts.push({
							inlineData: {
								mimeType: block.mimeType,
								data: block.data,
							},
						});
					}
				}
			}
			contents.push({ role: "user", parts });
		} else if (msg.role === "assistant") {
			const parts: Array<Record<string, unknown>> = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ text: block.text });
				} else if (block.type === "toolCall") {
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments,
						},
					});
				}
			}
			contents.push({ role: "model", parts });
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter(b => b.type === "text")
				.map(b => (b as TextContent).text)
				.join("\n");
			const parts: Array<Record<string, unknown>> = [
				{
					functionResponse: {
						name: msg.toolName,
						response: { content: textResult },
					},
				},
			];
			for (const block of msg.content) {
				if (block.type === "image") {
					parts.push({
						inlineData: {
							mimeType: block.mimeType,
							data: block.data,
						},
					});
				}
			}
			contents.push({ role: "user", parts });
		}
	}

	const body: Record<string, unknown> = {
		contents,
	};

	if (context.systemPrompt && context.systemPrompt.length > 0) {
		body.systemInstruction = {
			parts: [{ text: context.systemPrompt.join("\n\n") }],
		};
	}

	if (context.tools && context.tools.length > 0) {
		body.tools = [
			{
				functionDeclarations: context.tools.map(t => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters ?? { type: "object", properties: {} },
				})),
			},
		];
	}

	return body;
}

function mapContextToOpenAiChat(context: Context, model: Model<"zed-agent">, options?: ZedOptions) {
	const messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }> = [];

	if (context.systemPrompt && context.systemPrompt.length > 0) {
		messages.push({ role: "system", content: context.systemPrompt.join("\n\n") });
	}

	for (const msg of context.messages) {
		if (msg.role === "user" || msg.role === "developer") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: msg.content });
			} else {
				const parts = msg.content.map(b =>
					b.type === "text"
						? { type: "text", text: b.text }
						: { type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.data}` } },
				);
				messages.push({ role: "user", content: parts });
			}
		} else if (msg.role === "assistant") {
			const text = msg.content
				.filter(b => b.type === "text")
				.map(b => (b as TextContent).text)
				.join("\n");
			const toolCalls = msg.content
				.filter(b => b.type === "toolCall")
				.map(b => {
					const tc = b as ToolCall;
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			const assistantMsg: { role: string; content?: string; tool_calls?: unknown } = { role: "assistant" };
			if (text) assistantMsg.content = text;
			if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
			messages.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter(b => b.type === "text")
				.map(b => (b as TextContent).text)
				.join("\n");
			messages.push({ role: "tool", tool_call_id: msg.toolCallId, content: textResult });
		}
	}

	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
	};

	if (context.tools && context.tools.length > 0) {
		body.tools = context.tools.map(t => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters ?? { type: "object", properties: {} },
			},
		}));
	}

	if (model.reasoning && !options?.disableReasoning) {
		body.reasoning_effort = options?.reasoning ?? "medium";
	}

	return body;
}

export function buildZedProviderRequest(
	providerKind: ZedProviderKind,
	context: Context,
	model: Model<"zed-agent">,
	options?: ZedOptions,
) {
	if (providerKind === "anthropic") {
		return mapContextToAnthropic(context, model, options);
	}
	if (providerKind === "open_ai") {
		return mapContextToOpenAiResponses(context, model, options);
	}
	if (providerKind === "google") {
		return mapContextToGoogle(context, model);
	}
	return mapContextToOpenAiChat(context, model, options);
}

export function streamZed(
	model: Model<"zed-agent">,
	context: Context,
	options: ZedOptions = {},
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const parsed = parseZedCredentials(options.apiKey ?? "");
		const userId = parsed.userId;
		const accessToken = parsed.accessToken;

		if (!userId || !accessToken) {
			throw new OAuthError("Missing Zed credentials. Run /login zed-agent to authenticate your Zed account.", {
				kind: "configuration",
				provider: "zed-agent",
			});
		}

		let llmToken = await getOrMintZedLlmToken(userId, accessToken, options.signal, options.fetch);
		const providerKind = resolveProviderKind(model.id);
		const providerRequest = buildZedProviderRequest(providerKind, context, model, options);

		const completionBody = {
			thread_id: options.threadId ?? crypto.randomUUID(),
			prompt_id: options.promptId ?? crypto.randomUUID(),
			provider: providerKind,
			model: model.id,
			provider_request: providerRequest,
		};

		const fetcher = options.fetch ?? fetch;

		const sendRequest = async (token: string) => {
			return fetcher(`${ZED_CLOUD_URL}/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
					[ZED_HEADERS.CLIENT_STATUS]: "true",
					[ZED_HEADERS.CLIENT_STREAM_ENDED]: "true",
				},
				body: JSON.stringify(completionBody),
				signal: options.signal,
			});
		};

		let response = await sendRequest(llmToken);

		// Handle expired/outdated token auto-refresh & retry
		if (
			response.status === 401 ||
			response.headers.has(ZED_HEADERS.EXPIRED_TOKEN) ||
			response.headers.has(ZED_HEADERS.OUTDATED_TOKEN)
		) {
			invalidateZedLlmToken(userId, accessToken);
			llmToken = await getOrMintZedLlmToken(userId, accessToken, options.signal, options.fetch);
			response = await sendRequest(llmToken);
		}

		if (response.status === 402) {
			throw new ProviderHttpError(
				"Zed Pro subscription required or monthly token credit exhausted (HTTP 402).",
				402,
			);
		}

		if (!response.ok || !response.body) {
			const bodyText = await response.text().catch(() => "");
			throw new ProviderHttpError(
				`Zed Cloud request failed with status ${response.status}: ${bodyText}`,
				response.status,
			);
		}

		const outputMessage: AssistantMessage = {
			role: "assistant",
			api: "zed-agent",
			provider: "zed-agent",
			model: model.id,
			content: [],
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		stream.push({ type: "start", partial: outputMessage });

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentContentIndex = -1;
		let currentToolCall: ToolCall | null = null;
		let currentToolArgsJson = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let chunk: Record<string, unknown>;
					try {
						chunk = JSON.parse(trimmed) as Record<string, unknown>;
					} catch {
						continue;
					}

					if (chunk.status) {
						if (chunk.status === "stream_ended") {
							break;
						}
						if (typeof chunk.status === "object" && chunk.status !== null) {
							const failedObj = (chunk.status as Record<string, unknown>).failed as
								| { message?: string }
								| undefined;
							if (failedObj?.message) {
								throw new ProviderResponseError(failedObj.message, { kind: "envelope" });
							}
						}
						continue;
					}

					const event = (typeof chunk.event === "object" && chunk.event !== null ? chunk.event : chunk) as Record<
						string,
						unknown
					>;

					const eventType = event.type as string | undefined;

					// ─── ANTHROPIC EVENT FLAVOR ───
					if (eventType === "content_block_start") {
						const contentBlock = event.content_block as Record<string, unknown> | undefined;
						if (contentBlock && typeof contentBlock === "object") {
							const blockType = contentBlock.type;

							if (blockType === "text") {
								currentContentIndex++;
								const block: TextContent = { type: "text", text: "" };
								outputMessage.content.push(block);
								stream.push({ type: "text_start", contentIndex: currentContentIndex, partial: outputMessage });
							} else if (blockType === "thinking") {
								currentContentIndex++;
								const block: ThinkingContent = { type: "thinking", thinking: "" };
								outputMessage.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: currentContentIndex,
									partial: outputMessage,
								});
							} else if (blockType === "tool_use") {
								currentContentIndex++;
								currentToolArgsJson = "";
								currentToolCall = {
									type: "toolCall",
									id: typeof contentBlock.id === "string" ? contentBlock.id : crypto.randomUUID(),
									name: typeof contentBlock.name === "string" ? contentBlock.name : "",
									arguments: {},
								};
								outputMessage.content.push(currentToolCall);
								stream.push({
									type: "toolcall_start",
									contentIndex: currentContentIndex,
									partial: outputMessage,
								});
							}
						}
					} else if (eventType === "content_block_delta") {
						const delta = event.delta as Record<string, unknown> | undefined;
						if (delta && typeof delta === "object") {
							const deltaType = delta.type;

							if (deltaType === "text_delta" && typeof delta.text === "string") {
								const textBlock = outputMessage.content[currentContentIndex] as TextContent | undefined;
								if (textBlock && textBlock.type === "text") {
									textBlock.text += delta.text;
								}
								stream.push({
									type: "text_delta",
									contentIndex: currentContentIndex,
									delta: delta.text,
									partial: outputMessage,
								});
							} else if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
								const thinkBlock = outputMessage.content[currentContentIndex] as ThinkingContent | undefined;
								if (thinkBlock && thinkBlock.type === "thinking") {
									thinkBlock.thinking += delta.thinking;
								}
								stream.push({
									type: "thinking_delta",
									contentIndex: currentContentIndex,
									delta: delta.thinking,
									partial: outputMessage,
								});
							} else if (deltaType === "signature_delta" && typeof delta.signature === "string") {
								const thinkBlock = outputMessage.content[currentContentIndex] as ThinkingContent | undefined;
								if (thinkBlock && thinkBlock.type === "thinking") {
									thinkBlock.thinkingSignature = (thinkBlock.thinkingSignature ?? "") + delta.signature;
								}
							} else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
								currentToolArgsJson += delta.partial_json;
								stream.push({
									type: "toolcall_delta",
									contentIndex: currentContentIndex,
									delta: delta.partial_json,
									partial: outputMessage,
								});
							}
						}
					} else if (eventType === "content_block_stop") {
						const currentBlock = outputMessage.content[currentContentIndex];
						if (currentBlock?.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: currentContentIndex,
								content: currentBlock.text,
								partial: outputMessage,
							});
						} else if (currentBlock?.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: currentContentIndex,
								content: currentBlock.thinking,
								partial: outputMessage,
							});
						} else if (currentToolCall) {
							try {
								currentToolCall.arguments = JSON.parse(currentToolArgsJson || "{}");
							} catch {
								currentToolCall.arguments = {};
							}
							stream.push({
								type: "toolcall_end",
								contentIndex: currentContentIndex,
								toolCall: currentToolCall,
								partial: outputMessage,
							});
							currentToolCall = null;
						}
					} else if (eventType === "message_delta") {
						const delta = event.delta as Record<string, unknown> | undefined;
						if (delta?.stop_reason) {
							const sr = String(delta.stop_reason);
							if (sr === "max_tokens") outputMessage.stopReason = "length";
							else if (sr === "tool_use") outputMessage.stopReason = "toolUse";
							else outputMessage.stopReason = "stop";
						}
						const usage = event.usage as { output_tokens?: number } | undefined;
						if (usage?.output_tokens && outputMessage.usage) {
							outputMessage.usage.output = usage.output_tokens;
						}
					}

					// ─── OPENAI RESPONSES EVENT FLAVOR ───
					else if (eventType === "response.output_item.added") {
						const item = (event.item ?? event.output_item) as Record<string, unknown> | undefined;
						if (item?.type === "function_call") {
							currentContentIndex++;
							currentToolArgsJson = "";
							currentToolCall = {
								type: "toolCall",
								id: (item.call_id as string) || (item.id as string) || crypto.randomUUID(),
								name: (item.name as string) || "",
								arguments: {},
							};
							outputMessage.content.push(currentToolCall);
							stream.push({
								type: "toolcall_start",
								contentIndex: currentContentIndex,
								partial: outputMessage,
							});
						}
					} else if (
						(eventType === "response.output_text.delta" || eventType === "response.text.delta") &&
						typeof event.delta === "string"
					) {
						if (currentContentIndex === -1 || outputMessage.content[currentContentIndex]?.type !== "text") {
							currentContentIndex++;
							const block: TextContent = { type: "text", text: "" };
							outputMessage.content.push(block);
							stream.push({ type: "text_start", contentIndex: currentContentIndex, partial: outputMessage });
						}
						const textBlock = outputMessage.content[currentContentIndex] as TextContent;
						textBlock.text += event.delta;
						stream.push({
							type: "text_delta",
							contentIndex: currentContentIndex,
							delta: event.delta,
							partial: outputMessage,
						});
					} else if (
						(eventType === "response.reasoning_summary_text.delta" ||
							eventType === "response.reasoning.delta" ||
							eventType === "response.reasoning_text.delta") &&
						typeof event.delta === "string"
					) {
						if (currentContentIndex === -1 || outputMessage.content[currentContentIndex]?.type !== "thinking") {
							currentContentIndex++;
							const block: ThinkingContent = { type: "thinking", thinking: "" };
							outputMessage.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: currentContentIndex, partial: outputMessage });
						}
						const thinkBlock = outputMessage.content[currentContentIndex] as ThinkingContent;
						thinkBlock.thinking += event.delta;
						stream.push({
							type: "thinking_delta",
							contentIndex: currentContentIndex,
							delta: event.delta,
							partial: outputMessage,
						});
					} else if (eventType === "response.function_call_arguments.delta" && typeof event.delta === "string") {
						currentToolArgsJson += event.delta;
						stream.push({
							type: "toolcall_delta",
							contentIndex: currentContentIndex,
							delta: event.delta,
							partial: outputMessage,
						});
					} else if (
						eventType === "response.output_item.done" ||
						eventType === "response.function_call_arguments.done"
					) {
						if (currentToolCall) {
							try {
								currentToolCall.arguments = JSON.parse(currentToolArgsJson || "{}");
							} catch {
								currentToolCall.arguments = {};
							}
							stream.push({
								type: "toolcall_end",
								contentIndex: currentContentIndex,
								toolCall: currentToolCall,
								partial: outputMessage,
							});
							currentToolCall = null;
						}
					} else if (
						eventType === "response.output_text.done" ||
						eventType === "response.text.done" ||
						eventType === "response.reasoning_summary_text.done" ||
						eventType === "response.reasoning.done"
					) {
						const currentBlock = outputMessage.content[currentContentIndex];
						if (currentBlock?.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: currentContentIndex,
								content: currentBlock.text,
								partial: outputMessage,
							});
						} else if (currentBlock?.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: currentContentIndex,
								content: currentBlock.thinking,
								partial: outputMessage,
							});
						}
					}

					// ─── OPENAI CHAT & GOOGLE GEMINI EVENT FLAVORS ───
					else if (Array.isArray(event.choices) && event.choices.length > 0) {
						const choice = event.choices[0] as {
							delta?: { content?: string; reasoning_content?: string };
							finish_reason?: string;
						};
						if (choice.finish_reason) {
							if (choice.finish_reason === "length") outputMessage.stopReason = "length";
							else if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call")
								outputMessage.stopReason = "toolUse";
						}
						if (typeof choice.delta?.content === "string" && choice.delta.content.length > 0) {
							if (currentContentIndex === -1 || outputMessage.content[currentContentIndex]?.type !== "text") {
								currentContentIndex++;
								const block: TextContent = { type: "text", text: "" };
								outputMessage.content.push(block);
								stream.push({ type: "text_start", contentIndex: currentContentIndex, partial: outputMessage });
							}
							const textBlock = outputMessage.content[currentContentIndex] as TextContent;
							textBlock.text += choice.delta.content;
							stream.push({
								type: "text_delta",
								contentIndex: currentContentIndex,
								delta: choice.delta.content,
								partial: outputMessage,
							});
						}
						if (
							typeof choice.delta?.reasoning_content === "string" &&
							choice.delta.reasoning_content.length > 0
						) {
							if (
								currentContentIndex === -1 ||
								outputMessage.content[currentContentIndex]?.type !== "thinking"
							) {
								currentContentIndex++;
								const block: ThinkingContent = { type: "thinking", thinking: "" };
								outputMessage.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: currentContentIndex,
									partial: outputMessage,
								});
							}
							const thinkBlock = outputMessage.content[currentContentIndex] as ThinkingContent;
							thinkBlock.thinking += choice.delta.reasoning_content;
							stream.push({
								type: "thinking_delta",
								contentIndex: currentContentIndex,
								delta: choice.delta.reasoning_content,
								partial: outputMessage,
							});
						}
					} else if (Array.isArray(event.candidates) && event.candidates.length > 0) {
						const candidate = event.candidates[0] as {
							finish_reason?: string;
							finishReason?: string;
							content?: {
								parts?: Array<{
									text?: string;
									functionCall?: { name?: string; args?: Record<string, unknown> };
								}>;
							};
						};
						const gfr = candidate.finish_reason ?? candidate.finishReason;
						if (gfr) {
							if (gfr === "MAX_TOKENS") outputMessage.stopReason = "length";
							else outputMessage.stopReason = "stop";
						}
						const parts = candidate.content?.parts ?? [];
						for (const part of parts) {
							if (typeof part.text === "string" && part.text.length > 0) {
								if (currentContentIndex === -1 || outputMessage.content[currentContentIndex]?.type !== "text") {
									currentContentIndex++;
									const block: TextContent = { type: "text", text: "" };
									outputMessage.content.push(block);
									stream.push({
										type: "text_start",
										contentIndex: currentContentIndex,
										partial: outputMessage,
									});
								}
								const textBlock = outputMessage.content[currentContentIndex] as TextContent;
								textBlock.text += part.text;
								stream.push({
									type: "text_delta",
									contentIndex: currentContentIndex,
									delta: part.text,
									partial: outputMessage,
								});
							}
							if (part.functionCall?.name) {
								currentContentIndex++;
								const toolCall: ToolCall = {
									type: "toolCall",
									id: crypto.randomUUID(),
									name: part.functionCall.name,
									arguments: part.functionCall.args ?? {},
								};
								outputMessage.content.push(toolCall);
								stream.push({
									type: "toolcall_start",
									contentIndex: currentContentIndex,
									partial: outputMessage,
								});
								stream.push({
									type: "toolcall_end",
									contentIndex: currentContentIndex,
									toolCall,
									partial: outputMessage,
								});
							}
						}
					}

					// ─── USAGE METRICS ───
					if (eventType === "message_delta" || eventType === "response.completed") {
						const usage = (event.usage ?? (event.response as { usage?: unknown })?.usage) as
							| {
									output_tokens?: number;
									output?: number;
									input_tokens?: number;
									input?: number;
									cached_tokens?: number;
									cache_creation_input_tokens?: number;
									cache_read_input_tokens?: number;
							  }
							| undefined;
						if (usage && outputMessage.usage) {
							outputMessage.usage.output = usage.output_tokens ?? usage.output ?? outputMessage.usage.output;
							outputMessage.usage.input = usage.input_tokens ?? usage.input ?? outputMessage.usage.input;
							outputMessage.usage.cacheRead =
								usage.cache_read_input_tokens ?? usage.cached_tokens ?? outputMessage.usage.cacheRead;
							outputMessage.usage.cacheWrite =
								usage.cache_creation_input_tokens ?? outputMessage.usage.cacheWrite;
						}
					} else if (event.usageMetadata && typeof event.usageMetadata === "object" && outputMessage.usage) {
						const um = event.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number };
						if (um.promptTokenCount) outputMessage.usage.input = um.promptTokenCount;
						if (um.candidatesTokenCount) outputMessage.usage.output = um.candidatesTokenCount;
					} else if (event.usage && typeof event.usage === "object" && outputMessage.usage) {
						const u = event.usage as { prompt_tokens?: number; completion_tokens?: number };
						if (u.prompt_tokens) outputMessage.usage.input = u.prompt_tokens;
						if (u.completion_tokens) outputMessage.usage.output = u.completion_tokens;
					} else if (eventType === "message_start") {
						const message = event.message as
							| {
									usage?: {
										input_tokens?: number;
										cache_read_input_tokens?: number;
										cache_creation_input_tokens?: number;
									};
							  }
							| undefined;
						if (message?.usage && outputMessage.usage) {
							if (message.usage.input_tokens) outputMessage.usage.input = message.usage.input_tokens;
							if (message.usage.cache_read_input_tokens)
								outputMessage.usage.cacheRead = message.usage.cache_read_input_tokens;
							if (message.usage.cache_creation_input_tokens)
								outputMessage.usage.cacheWrite = message.usage.cache_creation_input_tokens;
						}
					}
				}
			}

			if (outputMessage.usage) {
				outputMessage.usage.totalTokens = outputMessage.usage.input + outputMessage.usage.output;
				calculateCost(model, outputMessage.usage);
			}

			const doneReason =
				outputMessage.stopReason === "length" || outputMessage.stopReason === "toolUse"
					? outputMessage.stopReason
					: "stop";
			stream.push({ type: "done", reason: doneReason, message: outputMessage });
			stream.end(outputMessage);
		} catch (err) {
			const errorMsg: AssistantMessage = {
				role: "assistant",
				api: "zed-agent",
				provider: "zed-agent",
				model: model.id,
				content: [{ type: "text", text: `Error: ${String(err)}` }],
				stopReason: "error",
				errorMessage: err instanceof Error ? err.message : String(err),
				errorStatus: err instanceof ProviderHttpError ? err.status : undefined,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "error", error: errorMsg });
			stream.end(errorMsg);
		}
	})().catch(err => {
		const errorMsg: AssistantMessage = {
			role: "assistant",
			api: "zed-agent",
			provider: "zed-agent",
			model: model.id,
			content: [{ type: "text", text: `Fatal Error: ${String(err)}` }],
			stopReason: "error",
			errorMessage: err instanceof Error ? err.message : String(err),
			errorStatus: err instanceof ProviderHttpError ? err.status : undefined,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: errorMsg });
		stream.end(errorMsg);
	});

	return stream;
}
