import * as crypto from "node:crypto";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { hasOpus47ApiRestrictions } from "@oh-my-pi/pi-catalog/identity";
import { mapEffortToGoogleThinkingLevel } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { parseZedCredentials, ZED_APP_VERSION, ZED_CLOUD_URL, ZED_HEADERS } from "@oh-my-pi/pi-catalog/wire/zed";
import { AbortError, finalize, ProviderHttpError, ProviderResponseError } from "../../src/error";
import { OAuthError } from "../../src/error/oauth";
import { renderDemotedThinking } from "../dialect/demotion";
import { getOrMintZedLlmToken, invalidateZedLlmToken } from "../registry/oauth/zed-token-pool";
import { ANTHROPIC_THINKING } from "../stream";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	RedactedThinkingContent,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolChoice,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { notifyProviderResponse } from "../utils/provider-response";
import { normalizeSchemaForCCA } from "../utils/schema";
import { mapToOpenAICompletionsToolChoice, mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import {
	convertGoogleImagePart,
	isThinkingPart,
	mapStopReasonString,
	resolveThoughtSignature,
	retainThoughtSignature,
	supportsMultimodalFunctionResponse,
} from "./google-shared";
import type { Part } from "./google-types";
import { encodeResponsesToolResultOutput, parseResponseReasoningReplayItem } from "./openai-shared";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export interface ZedOptions extends StreamOptions {
	threadId?: string;
	promptId?: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
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
function extractToolChoiceFunctionName(choice: ToolChoice | undefined): string | undefined {
	if (!choice || typeof choice === "string") return undefined;
	if (choice.type === "tool" && "name" in choice && typeof choice.name === "string") {
		return choice.name;
	}
	if (choice.type === "function") {
		if ("function" in choice && choice.function && typeof choice.function === "object" && "name" in choice.function) {
			const fnName = choice.function.name;
			if (typeof fnName === "string") return fnName;
		}
		if ("name" in choice && typeof choice.name === "string") {
			return choice.name;
		}
	}
	return undefined;
}

function convertChatImagePart(image: ImageContent): { type: "image_url"; image_url: { url: string } } {
	return {
		type: "image_url",
		image_url: {
			url: image.url ?? `data:${image.mimeType};base64,${image.data}`,
		},
	};
}

function mapContextToAnthropic(context: Context, model: Model<"zed-agent">, options?: ZedOptions) {
	const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
	const effectiveMaxTokens = options?.maxTokens ?? model.maxTokens ?? 8192;

	for (let i = 0; i < context.messages.length; i++) {
		const msg = context.messages[i];
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
			const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
			for (const block of msg.content) {
				if (block.type === "text") {
					contentBlocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					if (isSameModel && block.thinkingSignature && block.thinkingSignature.trim().length > 0) {
						contentBlocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
					} else if (block.thinking && block.thinking.trim().length > 0) {
						contentBlocks.push({
							type: "text",
							text: renderDemotedThinking(model.id, block.thinking),
						});
					}
				} else if (block.type === "redactedThinking") {
					if (isSameModel && block.data && block.data.trim().length > 0) {
						contentBlocks.push({
							type: "redacted_thinking",
							data: block.data,
						});
					}
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
			const toolResults: unknown[] = [];
			const hoistedImages: unknown[] = [];

			let j = i;
			for (; j < context.messages.length; j++) {
				const toolMsg = context.messages[j];
				if (toolMsg.role !== "toolResult") break;

				const hasImages = toolMsg.content.some(block => block.type === "image");
				let toolResultContent: unknown;

				if (toolMsg.isError) {
					const textBlocks = toolMsg.content.filter((b): b is TextContent => b.type === "text");
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							hoistedImages.push({
								type: "image",
								source: {
									type: "base64",
									media_type: block.mimeType,
									data: block.data,
								},
							});
						}
					}
					if (textBlocks.length === 0) {
						toolResultContent = "Tool failed with no output.";
					} else {
						toolResultContent = textBlocks.map(b => ({ type: "text", text: b.text }));
					}
				} else if (hasImages) {
					toolResultContent = toolMsg.content.map(block => {
						if (block.type === "text") {
							return { type: "text", text: block.text };
						}
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: block.mimeType,
								data: block.data,
							},
						};
					});
				} else {
					toolResultContent = toolMsg.content
						.filter((block): block is TextContent => block.type === "text")
						.map(block => block.text)
						.join("\n");
				}

				toolResults.push({
					type: "tool_result",
					tool_use_id: toolMsg.toolCallId,
					content: toolResultContent,
					is_error: toolMsg.isError,
				});
			}

			i = j - 1;

			if (hoistedImages.length > 0) {
				toolResults.push(
					{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
					...hoistedImages,
				);
			}

			messages.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	const tools =
		options?.toolChoice === "none"
			? undefined
			: context.tools?.map(t => ({
					name: t.name,
					description: t.description,
					input_schema: t.parameters ?? { type: "object", properties: {} },
				}));

	let toolChoiceParam: Record<string, unknown> | undefined;
	let isForcedToolChoice = false;

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			if (options.toolChoice === "required" || options.toolChoice === "any") {
				toolChoiceParam = { type: "any" };
				isForcedToolChoice = true;
			} else {
				toolChoiceParam = { type: options.toolChoice };
			}
		} else {
			const toolName = extractToolChoiceFunctionName(options.toolChoice);
			if (toolName) {
				toolChoiceParam = { type: "tool", name: toolName };
				isForcedToolChoice = true;
			}
		}
	}

	const isClaudeBudgetThinking = model.id.includes("4-5");
	const isReasoning = model.reasoning && !options?.disableReasoning && !isForcedToolChoice;

	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		max_tokens: effectiveMaxTokens,
	};

	if (context.systemPrompt && context.systemPrompt.length > 0) {
		body.system = context.systemPrompt.join("\n\n");
	}

	if (tools && tools.length > 0) {
		body.tools = tools;
	}

	if (toolChoiceParam) {
		body.tool_choice = toolChoiceParam;
	}

	if (isForcedToolChoice) {
		// Forced tool choice disables Anthropic thinking; neither thinking nor
		// adaptive effort is emitted.
	} else if (isReasoning) {
		if (isClaudeBudgetThinking) {
			const effort = options?.reasoning ?? Effort.Medium;
			const targetBudget = ANTHROPIC_THINKING[effort] ?? 8192;
			body.thinking = {
				type: "enabled",
				budget_tokens: Math.max(1, Math.min(targetBudget, effectiveMaxTokens - 1)),
			};
		} else {
			body.thinking = {
				type: "adaptive",
			};
			body.output_config = {
				effort: options?.reasoning ?? "medium",
				include: ["summary"],
			};
		}
	} else if (model.reasoning && options?.disableReasoning) {
		// Adaptive-only Claude models cannot be disabled by omission: pin the
		// lowest fixed effort instead. Budget-based Claude uses the explicit
		// disabled thinking mode and must not receive output_config.effort.
		if (isClaudeBudgetThinking) {
			body.thinking = { type: "disabled" };
		} else {
			body.output_config = { effort: "low" };
		}
	}

	const allowSamplingParams = !isReasoning && !hasOpus47ApiRestrictions(model.id);
	if (allowSamplingParams) {
		if (options?.temperature !== undefined) {
			body.temperature = options.temperature;
		}
		if (options?.topP !== undefined) {
			body.top_p = options.topP;
		}
		if (options?.topK !== undefined) {
			body.top_k = options.topK;
		}
	}

	if (options?.stopSequences && options.stopSequences.length > 0) {
		body.stop_sequences = options.stopSequences.slice(0, 4);
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
						const detail = block.detail ?? "auto";
						if (block.providerFile?.provider === "openai" && block.providerFile.id) {
							parts.push({
								type: "input_image",
								detail,
								file_id: block.providerFile.id,
							});
						} else {
							parts.push({
								type: "input_image",
								detail,
								image_url: block.url ?? `data:${block.mimeType};base64,${block.data}`,
							});
						}
					}
				}
			}
			input.push({ type: "message", role: msg.role, content: parts });
		} else if (msg.role === "assistant") {
			let assistantMessage:
				| { type: "message"; role: "assistant"; content: Array<Record<string, unknown>> }
				| undefined;
			const flushAssistantMessage = () => {
				if (assistantMessage && assistantMessage.content.length > 0) {
					input.push(assistantMessage);
				}
				assistantMessage = undefined;
			};
			const isSameOpenAiResponsesModel =
				msg.provider === model.provider &&
				msg.api === model.api &&
				msg.model === model.id &&
				resolveProviderKind(msg.model) === "open_ai";

			for (const block of msg.content) {
				if (block.type === "text") {
					assistantMessage ??= { type: "message", role: "assistant", content: [] };
					assistantMessage.content.push({ type: "output_text", text: block.text });
				} else if (block.type === "thinking") {
					const replayItem = isSameOpenAiResponsesModel
						? parseResponseReasoningReplayItem(block.thinkingSignature)
						: undefined;
					if (replayItem) {
						flushAssistantMessage();
						input.push({ ...replayItem });
					} else if (block.thinking) {
						const demotedThinking = renderDemotedThinking(model.id, block.thinking);
						if (demotedThinking) {
							assistantMessage ??= { type: "message", role: "assistant", content: [] };
							assistantMessage.content.push({ type: "output_text", text: demotedThinking });
						}
					}
				} else if (block.type === "toolCall") {
					flushAssistantMessage();
					input.push({
						type: "function_call",
						call_id: block.id,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}
			flushAssistantMessage();
		} else if (msg.role === "toolResult") {
			const { output } = encodeResponsesToolResultOutput(msg, model, false);
			input.push({
				type: "function_call_output",
				call_id: msg.toolCallId,
				output,
			});
		}
	}

	const tools =
		options?.toolChoice === "none"
			? undefined
			: context.tools?.map(t => ({
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
		max_output_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
	};

	if (context.systemPrompt && context.systemPrompt.length > 0) {
		body.instructions = context.systemPrompt.join("\n\n");
	}

	if (tools && tools.length > 0) {
		body.tools = tools;
	}

	if (options?.toolChoice) {
		const toolChoice = mapToOpenAIResponsesToolChoice(options.toolChoice);
		if (toolChoice) {
			body.tool_choice = toolChoice;
		}
	}

	if (isReasoning) {
		body.reasoning = {
			effort: options?.reasoning ?? "medium",
			summary: "auto",
		};
	}

	return body;
}
function mapContextToGoogle(context: Context, model: Model<"zed-agent">, options?: ZedOptions) {
	const contents: Array<{ role: string; parts: Part[] }> = [];
	let pendingFunctionResponses: Part[] = [];
	let pendingToolImageParts: Part[] = [];
	const flushFunctionResponses = () => {
		if (pendingFunctionResponses.length === 0) return;
		contents.push({ role: "user", parts: pendingFunctionResponses });
		pendingFunctionResponses = [];
	};
	const flushPendingToolImages = () => {
		if (pendingToolImageParts.length === 0) return;
		contents.push({ role: "user", parts: pendingToolImageParts });
		pendingToolImageParts = [];
	};

	for (const msg of context.messages) {
		if (msg.role === "toolResult") {
			const supportsImages = model.input.includes("image");
			const textContent = msg.content.filter((b): b is TextContent => b.type === "text");
			const textResult = textContent.map(b => b.text).join("\n");
			const imageContent = supportsImages ? msg.content.filter((b): b is ImageContent => b.type === "image") : [];
			const omittedImages = !supportsImages && msg.content.some(b => b.type === "image");

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			const responseValue = omittedImages
				? [hasText ? textResult : "", NON_VISION_IMAGE_PLACEHOLDER].filter(Boolean).join("\n")
				: hasText
					? textResult
					: hasImages
						? "(see attached image)"
						: "";

			const imageParts = imageContent.map(convertGoogleImagePart);

			pendingFunctionResponses.push({
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
				},
			});

			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				pendingToolImageParts.push({ text: "Tool result image:" }, ...imageParts);
			}
			continue;
		}

		flushFunctionResponses();
		flushPendingToolImages();
		if (msg.role === "user" || msg.role === "developer") {
			const parts: Part[] = [];
			if (typeof msg.content === "string") {
				parts.push({ text: msg.content });
			} else {
				const supportsImages = model.input.includes("image");
				let omittedImages = false;
				for (const block of msg.content) {
					if (block.type === "text") {
						parts.push({ text: block.text });
					} else if (block.type === "image") {
						if (supportsImages) {
							parts.push(convertGoogleImagePart(block));
						} else {
							omittedImages = true;
						}
					}
				}
				if (omittedImages) {
					parts.push({ text: NON_VISION_IMAGE_PLACEHOLDER });
				}
			}
			contents.push({ role: "user", parts });
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			const isSameProviderAndModel =
				msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ text: block.text });
				} else if (block.type === "thinking") {
					if (block.thinking && block.thinking.trim().length > 0) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						if (thoughtSignature) {
							parts.push({
								thought: true,
								text: block.thinking,
								thoughtSignature,
							});
						} else {
							parts.push({
								text: renderDemotedThinking(model.id, block.thinking),
							});
						}
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments,
						},
						...(thoughtSignature ? { thoughtSignature } : {}),
					});
				}
			}
			contents.push({ role: "model", parts });
		}
	}
	flushFunctionResponses();
	flushPendingToolImages();
	const generationConfig: Record<string, unknown> = {
		maxOutputTokens: options?.maxTokens ?? model.maxTokens ?? 8192,
	};
	const body: Record<string, unknown> = {
		contents,
		generationConfig,
	};
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		body.systemInstruction = {
			parts: [{ text: context.systemPrompt.join("\n\n") }],
		};
	}

	if (options?.toolChoice !== "none" && context.tools && context.tools.length > 0) {
		body.tools = [
			{
				functionDeclarations: context.tools.map(t => ({
					name: t.name,
					description: t.description,
					parameters: normalizeSchemaForCCA(t.parameters ?? { type: "object", properties: {} }),
				})),
			},
		];
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			switch (options.toolChoice) {
				case "auto":
					body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
					break;
				case "none":
					body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
					break;
				case "any":
				case "required":
					body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
					break;
			}
		} else {
			const toolName = extractToolChoiceFunctionName(options.toolChoice);
			if (toolName) {
				body.toolConfig = {
					functionCallingConfig: {
						mode: "ANY",
						allowedFunctionNames: [toolName],
					},
				};
			}
		}
	}

	if (options?.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		generationConfig.topP = options.topP;
	}
	if (options?.topK !== undefined) {
		generationConfig.topK = options.topK;
	}
	if (options?.minP !== undefined) {
		generationConfig.minP = options.minP;
	}
	if (options?.presencePenalty !== undefined) {
		generationConfig.presencePenalty = options.presencePenalty;
	}
	if (options?.repetitionPenalty !== undefined) {
		generationConfig.repetitionPenalty = options.repetitionPenalty;
	}

	if (model.reasoning) {
		if (options?.disableReasoning) {
			generationConfig.thinkingConfig = {
				thinkingBudget: 0,
			};
		} else {
			generationConfig.thinkingConfig = {
				thinkingLevel:
					options?.reasoning === undefined ? "MEDIUM" : mapEffortToGoogleThinkingLevel(options.reasoning, model),
			};
		}
	}

	return body;
}
function mapContextToOpenAiChat(context: Context, model: Model<"zed-agent">, options?: ZedOptions) {
	const messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }> = [];
	const supportsImages = model.input.includes("image");

	if (context.systemPrompt && context.systemPrompt.length > 0) {
		messages.push({ role: "system", content: context.systemPrompt.join("\n\n") });
	}

	for (let i = 0; i < context.messages.length; i++) {
		const msg = context.messages[i];
		if (msg.role === "user" || msg.role === "developer") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: msg.content });
			} else {
				const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
				let omittedImages = false;
				for (const b of msg.content) {
					if (b.type === "text") {
						parts.push({ type: "text", text: b.text });
					} else if (b.type === "image") {
						if (supportsImages) {
							parts.push(convertChatImagePart(b));
						} else {
							omittedImages = true;
						}
					}
				}
				if (omittedImages) {
					parts.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
				}
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
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < context.messages.length; j++) {
				const toolMsg = context.messages[j];
				if (toolMsg.role !== "toolResult") break;

				const textResult = toolMsg.content
					.filter(b => b.type === "text")
					.map(b => (b as TextContent).text)
					.join("\n");
				const hasImages = toolMsg.content.some(b => b.type === "image");
				const omittedImages = hasImages && !supportsImages;
				const toolResultContent = omittedImages
					? [textResult, NON_VISION_IMAGE_PLACEHOLDER].filter(Boolean).join("\n")
					: textResult || (hasImages ? "(see attached image)" : "");

				messages.push({ role: "tool", tool_call_id: toolMsg.toolCallId, content: toolResultContent });

				if (hasImages && supportsImages) {
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							imageBlocks.push(convertChatImagePart(block));
						}
					}
				}
			}

			i = j - 1;
			if (imageBlocks.length > 0) {
				messages.push({
					role: "user",
					content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
				});
			}
		}
	}

	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
		max_completion_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
	};

	if (options?.toolChoice !== "none" && context.tools && context.tools.length > 0) {
		body.tools = context.tools.map(t => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters ?? { type: "object", properties: {} },
			},
		}));
	}

	if (options?.toolChoice) {
		const toolChoice = mapToOpenAICompletionsToolChoice(options.toolChoice);
		if (toolChoice) {
			body.tool_choice = toolChoice;
		}
	}

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		body.top_p = options.topP;
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
		return mapContextToGoogle(context, model, options);
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

		if (!accessToken) {
			throw new OAuthError("Missing Zed credentials. Run /login zed-agent to authenticate your Zed account.", {
				kind: "configuration",
				provider: "zed-agent",
			});
		}

		let llmToken = userId
			? await getOrMintZedLlmToken(userId, accessToken, options.signal, options.fetch)
			: accessToken;
		const providerKind = resolveProviderKind(model.id);
		const providerRequest = buildZedProviderRequest(providerKind, context, model, options);

		let completionBody: unknown = {
			thread_id: options.threadId ?? crypto.randomUUID(),
			prompt_id: options.promptId ?? crypto.randomUUID(),
			provider: providerKind,
			model: model.id,
			provider_request: providerRequest,
		};

		const replacementBody = await options.onPayload?.(completionBody, model);
		if (replacementBody !== undefined) {
			completionBody = replacementBody;
		}

		const fetcher = options.fetch ?? fetch;
		const sendRequest = async (token: string) => {
			const response = await fetcher(`${ZED_CLOUD_URL}/completions`, {
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
			await notifyProviderResponse(
				options,
				response,
				model,
				response.headers.get("x-request-id") ?? response.headers.get("request-id"),
			);
			return response;
		};

		let response = await sendRequest(llmToken);
		// Handle expired/outdated token auto-refresh & retry
		if (
			userId &&
			(response.status === 401 ||
				response.headers.has(ZED_HEADERS.EXPIRED_TOKEN) ||
				response.headers.has(ZED_HEADERS.OUTDATED_TOKEN))
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
		let sawStreamEnded = false;
		let responsesStreamIncomplete = false;

		// Stream block state tracking
		let activeTextBlock: TextContent | null = null;
		let activeThinkingBlock: ThinkingContent | null = null;

		const closeActiveText = () => {
			if (!activeTextBlock) return;
			const contentIndex = outputMessage.content.indexOf(activeTextBlock);
			if (contentIndex >= 0) {
				stream.push({
					type: "text_end",
					contentIndex,
					content: activeTextBlock.text,
					partial: outputMessage,
				});
			}
			activeTextBlock = null;
		};

		const closeActiveThinking = () => {
			if (!activeThinkingBlock) return;
			const contentIndex = outputMessage.content.indexOf(activeThinkingBlock);
			if (contentIndex >= 0) {
				stream.push({
					type: "thinking_end",
					contentIndex,
					content: activeThinkingBlock.thinking,
					partial: outputMessage,
				});
			}
			activeThinkingBlock = null;
		};

		const startOrAppendText = (delta: string) => {
			closeActiveThinking();
			if (!activeTextBlock) {
				activeTextBlock = { type: "text", text: "" };
				outputMessage.content.push(activeTextBlock);
				const contentIndex = outputMessage.content.length - 1;
				stream.push({ type: "text_start", contentIndex, partial: outputMessage });
			}
			activeTextBlock.text += delta;
			const contentIndex = outputMessage.content.indexOf(activeTextBlock);
			stream.push({
				type: "text_delta",
				contentIndex,
				delta,
				partial: outputMessage,
			});
		};

		const startOrAppendThinking = (delta: string, signature?: string) => {
			closeActiveText();
			if (!activeThinkingBlock) {
				activeThinkingBlock = { type: "thinking", thinking: "" };
				if (signature) activeThinkingBlock.thinkingSignature = signature;
				outputMessage.content.push(activeThinkingBlock);
				const contentIndex = outputMessage.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex, partial: outputMessage });
			}
			if (signature) {
				activeThinkingBlock.thinkingSignature = retainThoughtSignature(
					activeThinkingBlock.thinkingSignature,
					signature,
				);
			}
			if (delta.length > 0) {
				activeThinkingBlock.thinking += delta;
				const contentIndex = outputMessage.content.indexOf(activeThinkingBlock);
				stream.push({
					type: "thinking_delta",
					contentIndex,
					delta,
					partial: outputMessage,
				});
			}
		};

		// OpenAI Responses reasoning tracking (keyed by item_id / output_index)
		type ResponsesReasoningState = {
			block: ThinkingContent;
			contentIndex: number;
			itemId?: string;
			outputIndex?: number;
			ended?: boolean;
		};
		const openResponsesReasoningsByItemId = new Map<string, ResponsesReasoningState>();
		const openResponsesReasoningsByOutputIndex = new Map<number, ResponsesReasoningState>();
		const endedResponsesReasoningsByItemId = new Map<string, ResponsesReasoningState>();
		const endedResponsesReasoningsByOutputIndex = new Map<number, ResponsesReasoningState>();
		const openResponsesReasonings: ResponsesReasoningState[] = [];
		let lastAddedResponsesReasoning: ResponsesReasoningState | null = null;

		const getResponsesReasoningIdentity = (rawEvent: Record<string, unknown>) => {
			const item =
				typeof rawEvent.item === "object" && rawEvent.item !== null
					? (rawEvent.item as Record<string, unknown>)
					: typeof rawEvent.output_item === "object" && rawEvent.output_item !== null
						? (rawEvent.output_item as Record<string, unknown>)
						: undefined;
			const itemId =
				typeof rawEvent.item_id === "string"
					? rawEvent.item_id
					: typeof item?.id === "string"
						? item.id
						: undefined;
			const outputIndex =
				typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
					? Math.trunc(rawEvent.output_index)
					: typeof item?.output_index === "number" && Number.isFinite(item.output_index)
						? Math.trunc(item.output_index)
						: undefined;
			return {
				item,
				itemId,
				outputIndex,
				hasExplicitKey: itemId !== undefined || outputIndex !== undefined,
			};
		};

		const findResponsesReasoning = (rawEvent: Record<string, unknown>): ResponsesReasoningState | null => {
			const { itemId, outputIndex, hasExplicitKey } = getResponsesReasoningIdentity(rawEvent);
			if (itemId) {
				const found = openResponsesReasoningsByItemId.get(itemId) ?? endedResponsesReasoningsByItemId.get(itemId);
				if (found) return found;
			}
			if (outputIndex !== undefined) {
				const found =
					openResponsesReasoningsByOutputIndex.get(outputIndex) ??
					endedResponsesReasoningsByOutputIndex.get(outputIndex);
				if (found) return found;
			}
			if (hasExplicitKey) return null;
			return lastAddedResponsesReasoning ?? openResponsesReasonings[openResponsesReasonings.length - 1] ?? null;
		};

		const extractReasoningSummaryText = (item: Record<string, unknown> | undefined): string => {
			if (!item) return "";
			if (Array.isArray(item.summary)) {
				return item.summary
					.map(part =>
						typeof part === "object" && part !== null && typeof part.text === "string" ? part.text : "",
					)
					.filter(t => t.length > 0)
					.join("\n\n");
			}
			if (Array.isArray(item.content)) {
				return item.content
					.map(part =>
						typeof part === "object" &&
						part !== null &&
						part.type === "reasoning_text" &&
						typeof part.text === "string"
							? part.text
							: "",
					)
					.filter(t => t.length > 0)
					.join("\n\n");
			}
			return "";
		};

		const removeOpenResponsesReasoning = (state: ResponsesReasoningState) => {
			const idx = openResponsesReasonings.indexOf(state);
			if (idx >= 0) openResponsesReasonings.splice(idx, 1);
			if (lastAddedResponsesReasoning === state) lastAddedResponsesReasoning = null;
			if (state.itemId && openResponsesReasoningsByItemId.get(state.itemId) === state) {
				openResponsesReasoningsByItemId.delete(state.itemId);
			}
			if (state.outputIndex !== undefined && openResponsesReasoningsByOutputIndex.get(state.outputIndex) === state) {
				openResponsesReasoningsByOutputIndex.delete(state.outputIndex);
			}
		};

		const finishResponsesReasoning = (state: ResponsesReasoningState, doneItem?: Record<string, unknown>) => {
			if (state.ended) {
				if (!doneItem) return;
				const summaryText = extractReasoningSummaryText(doneItem);
				if (summaryText) state.block.thinking = summaryText;
				state.block.thinkingSignature = JSON.stringify(doneItem);
				if (state.itemId && endedResponsesReasoningsByItemId.get(state.itemId) === state) {
					endedResponsesReasoningsByItemId.delete(state.itemId);
				}
				if (
					state.outputIndex !== undefined &&
					endedResponsesReasoningsByOutputIndex.get(state.outputIndex) === state
				) {
					endedResponsesReasoningsByOutputIndex.delete(state.outputIndex);
				}
				return;
			}
			state.ended = true;
			const finalItem = doneItem ?? (state.itemId ? { type: "reasoning", id: state.itemId } : undefined);
			if (finalItem) {
				const summaryText = extractReasoningSummaryText(finalItem);
				if (summaryText) {
					state.block.thinking = summaryText;
				}
				state.block.thinkingSignature = JSON.stringify(finalItem);
			}
			removeOpenResponsesReasoning(state);
			if (state.itemId) endedResponsesReasoningsByItemId.set(state.itemId, state);
			if (state.outputIndex !== undefined) endedResponsesReasoningsByOutputIndex.set(state.outputIndex, state);
			if (activeThinkingBlock === state.block) activeThinkingBlock = null;
			stream.push({
				type: "thinking_end",
				contentIndex: state.contentIndex,
				content: state.block.thinking,
				partial: outputMessage,
			});
		};

		const finishAllPendingReasonings = () => {
			for (const state of [...openResponsesReasonings]) {
				finishResponsesReasoning(state);
			}
		};

		// OpenAI Responses tool-call tracking (keyed by item_id / output_index)
		type ResponsesToolCallState = {
			toolCall: ToolCall;
			rawArgs: string;
			contentIndex: number;
			itemId?: string;
			callId?: string;
			outputIndex?: number;
			ended?: boolean;
		};
		const openResponsesToolCallsByItemId = new Map<string, ResponsesToolCallState>();
		const openResponsesToolCallsByOutputIndex = new Map<number, ResponsesToolCallState>();
		const openResponsesToolCalls: ResponsesToolCallState[] = [];
		let lastAddedResponsesToolCall: ResponsesToolCallState | null = null;

		const getResponsesToolCallIdentity = (rawEvent: Record<string, unknown>) => {
			const item =
				typeof rawEvent.item === "object" && rawEvent.item !== null
					? (rawEvent.item as Record<string, unknown>)
					: typeof rawEvent.output_item === "object" && rawEvent.output_item !== null
						? (rawEvent.output_item as Record<string, unknown>)
						: undefined;
			const itemId =
				typeof rawEvent.item_id === "string"
					? rawEvent.item_id
					: typeof item?.id === "string"
						? item.id
						: undefined;
			const callId =
				typeof rawEvent.call_id === "string"
					? rawEvent.call_id
					: typeof item?.call_id === "string"
						? item.call_id
						: undefined;
			const outputIndex =
				typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
					? Math.trunc(rawEvent.output_index)
					: typeof item?.output_index === "number" && Number.isFinite(item.output_index)
						? Math.trunc(item.output_index)
						: undefined;
			return {
				item,
				itemId,
				callId,
				outputIndex,
				hasExplicitKey: itemId !== undefined || callId !== undefined || outputIndex !== undefined,
			};
		};

		const findResponsesToolCall = (rawEvent: Record<string, unknown>): ResponsesToolCallState | null => {
			const { itemId, callId, outputIndex, hasExplicitKey } = getResponsesToolCallIdentity(rawEvent);
			if (itemId) {
				const found = openResponsesToolCallsByItemId.get(itemId);
				if (found) return found;
			}
			if (callId) {
				const found = openResponsesToolCallsByItemId.get(callId);
				if (found) return found;
			}
			if (outputIndex !== undefined) {
				const found = openResponsesToolCallsByOutputIndex.get(outputIndex);
				if (found) return found;
			}
			if (hasExplicitKey) return null;
			return lastAddedResponsesToolCall ?? openResponsesToolCalls[openResponsesToolCalls.length - 1] ?? null;
		};

		const finishResponsesToolCall = (state: ResponsesToolCallState, doneItem?: Record<string, unknown>) => {
			if (state.ended) return;
			state.ended = true;
			const idx = openResponsesToolCalls.indexOf(state);
			if (idx >= 0) openResponsesToolCalls.splice(idx, 1);
			if (
				!doneItem &&
				(responsesStreamIncomplete || outputMessage.stopReason === "length" || outputMessage.stopReason === "error")
			) {
				const contentIdx = outputMessage.content.indexOf(state.toolCall);
				if (contentIdx >= 0) {
					outputMessage.content.splice(contentIdx, 1);
				}
				return;
			}
			const rawArgs = typeof doneItem?.arguments === "string" ? doneItem.arguments : state.rawArgs;
			let parsedArgs: Record<string, unknown> | null = null;
			if (rawArgs && rawArgs.trim().length > 0) {
				try {
					parsedArgs = JSON.parse(rawArgs);
				} catch {
					parsedArgs = null;
				}
			} else if (doneItem) {
				parsedArgs = {};
			}

			if (parsedArgs !== null && typeof parsedArgs === "object") {
				state.toolCall.arguments = parsedArgs;
				stream.push({
					type: "toolcall_end",
					contentIndex: state.contentIndex,
					toolCall: state.toolCall,
					partial: outputMessage,
				});
			} else {
				const contentIdx = outputMessage.content.indexOf(state.toolCall);
				if (contentIdx >= 0) {
					outputMessage.content.splice(contentIdx, 1);
				}
			}
		};

		// OpenAI Chat / xAI tool-call tracking (keyed by delta index)
		type ChatToolCallState = {
			toolCall: ToolCall;
			rawArgs: string;
			contentIndex: number;
			index?: number;
		};
		const chatToolCallsByIndex = new Map<number, ChatToolCallState>();
		const pendingChatToolCalls: ChatToolCallState[] = [];
		let lastChatToolCall: ChatToolCallState | null = null;

		const finishChatToolCall = (state: ChatToolCallState) => {
			if (state.index !== undefined) chatToolCallsByIndex.delete(state.index);
			const idx = pendingChatToolCalls.indexOf(state);
			if (idx >= 0) pendingChatToolCalls.splice(idx, 1);
			if (lastChatToolCall === state) lastChatToolCall = null;
			if (outputMessage.stopReason === "length" || outputMessage.stopReason === "error") {
				const contentIdx = outputMessage.content.indexOf(state.toolCall);
				if (contentIdx >= 0) {
					outputMessage.content.splice(contentIdx, 1);
				}
				return;
			}
			let parsedArgs: Record<string, unknown> | null = null;
			if (state.rawArgs && state.rawArgs.trim().length > 0) {
				try {
					parsedArgs = JSON.parse(state.rawArgs);
				} catch {
					parsedArgs = null;
				}
			}
			if (parsedArgs !== null && typeof parsedArgs === "object") {
				state.toolCall.arguments = parsedArgs;
				stream.push({
					type: "toolcall_end",
					contentIndex: state.contentIndex,
					toolCall: state.toolCall,
					partial: outputMessage,
				});
			} else {
				const contentIdx = outputMessage.content.indexOf(state.toolCall);
				if (contentIdx >= 0) {
					outputMessage.content.splice(contentIdx, 1);
				}
			}
		};

		const discardOpenResponsesToolCalls = () => {
			for (const state of [...openResponsesToolCalls]) {
				state.ended = true;
				const contentIdx = outputMessage.content.indexOf(state.toolCall);
				if (contentIdx >= 0) {
					outputMessage.content.splice(contentIdx, 1);
				}
			}
			openResponsesToolCalls.length = 0;
			openResponsesToolCallsByItemId.clear();
			openResponsesToolCallsByOutputIndex.clear();
			lastAddedResponsesToolCall = null;
		};

		const finishAllPendingToolCalls = () => {
			if (
				responsesStreamIncomplete ||
				outputMessage.stopReason === "length" ||
				outputMessage.stopReason === "error"
			) {
				discardOpenResponsesToolCalls();
			} else {
				for (const state of [...openResponsesToolCalls]) {
					finishResponsesToolCall(state);
				}
			}
			for (const state of [...pendingChatToolCalls]) {
				finishChatToolCall(state);
			}
		};

		// Anthropic singleton block tracking
		let anthropicCurrentIndex = -1;
		let anthropicToolCall: ToolCall | null = null;
		let anthropicToolArgsJson = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				const lines = buffer.split("\n");
				buffer = done ? "" : (lines.pop() ?? "");
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
							sawStreamEnded = true;
							break;
						}
						if (typeof chunk.status === "object" && chunk.status !== null) {
							const statusObj = chunk.status as Record<string, unknown>;
							const failedObj = statusObj.failed as { message?: string } | undefined;
							if (failedObj?.message) {
								throw new ProviderResponseError(failedObj.message, { kind: "envelope" });
							}
							const incompleteObj = statusObj.incomplete as { reason?: string; message?: string } | undefined;
							if (incompleteObj) {
								responsesStreamIncomplete = true;
								const reason = incompleteObj.reason ?? incompleteObj.message;
								if (reason === "content_filter") {
									throw new ProviderResponseError("incomplete: content_filter", { kind: "content-blocked" });
								}
								outputMessage.stopReason = "length";
							}
						}
						continue;
					}
					const event = (typeof chunk.event === "object" && chunk.event !== null ? chunk.event : chunk) as Record<
						string,
						unknown
					>;

					const eventType = event.type as string | undefined;
					const promptFeedback =
						typeof event.promptFeedback === "object" && event.promptFeedback !== null
							? (event.promptFeedback as { blockReason?: unknown; blockReasonMessage?: unknown })
							: undefined;
					if (typeof promptFeedback?.blockReason === "string" && promptFeedback.blockReason.length > 0) {
						const detail =
							typeof promptFeedback.blockReasonMessage === "string"
								? promptFeedback.blockReasonMessage
								: undefined;
						throw new ProviderResponseError(
							`Request blocked by Google (${promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
							{ provider: model.provider, kind: "content-blocked" },
						);
					}

					// ─── ANTHROPIC EVENT FLAVOR ───
					if (eventType === "content_block_start") {
						const contentBlock = event.content_block as Record<string, unknown> | undefined;
						if (contentBlock && typeof contentBlock === "object") {
							const blockType = contentBlock.type;

							if (blockType === "text") {
								anthropicCurrentIndex++;
								const block: TextContent = { type: "text", text: "" };
								outputMessage.content.push(block);
								stream.push({
									type: "text_start",
									contentIndex: anthropicCurrentIndex,
									partial: outputMessage,
								});
							} else if (blockType === "thinking") {
								anthropicCurrentIndex++;
								const block: ThinkingContent = { type: "thinking", thinking: "" };
								outputMessage.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: anthropicCurrentIndex,
									partial: outputMessage,
								});
							} else if (blockType === "redacted_thinking") {
								anthropicCurrentIndex++;
								const block: RedactedThinkingContent = {
									type: "redactedThinking",
									data: typeof contentBlock.data === "string" ? contentBlock.data : "",
								};
								outputMessage.content.push(block);
							} else if (blockType === "tool_use") {
								anthropicCurrentIndex++;
								anthropicToolArgsJson = "";
								anthropicToolCall = {
									type: "toolCall",
									id: typeof contentBlock.id === "string" ? contentBlock.id : crypto.randomUUID(),
									name: typeof contentBlock.name === "string" ? contentBlock.name : "",
									arguments: {},
								};
								outputMessage.content.push(anthropicToolCall);
								stream.push({
									type: "toolcall_start",
									contentIndex: anthropicCurrentIndex,
									partial: outputMessage,
								});
							}
						}
					} else if (eventType === "content_block_delta") {
						const delta = event.delta as Record<string, unknown> | undefined;
						if (delta && typeof delta === "object") {
							const deltaType = delta.type;

							if (deltaType === "text_delta" && typeof delta.text === "string") {
								const textBlock = outputMessage.content[anthropicCurrentIndex] as TextContent | undefined;
								if (textBlock && textBlock.type === "text") {
									textBlock.text += delta.text;
								}
								stream.push({
									type: "text_delta",
									contentIndex: anthropicCurrentIndex,
									delta: delta.text,
									partial: outputMessage,
								});
							} else if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
								const thinkBlock = outputMessage.content[anthropicCurrentIndex] as ThinkingContent | undefined;
								if (thinkBlock && thinkBlock.type === "thinking") {
									thinkBlock.thinking += delta.thinking;
								}
								stream.push({
									type: "thinking_delta",
									contentIndex: anthropicCurrentIndex,
									delta: delta.thinking,
									partial: outputMessage,
								});
							} else if (deltaType === "signature_delta" && typeof delta.signature === "string") {
								const thinkBlock = outputMessage.content[anthropicCurrentIndex] as ThinkingContent | undefined;
								if (thinkBlock && thinkBlock.type === "thinking") {
									thinkBlock.thinkingSignature = (thinkBlock.thinkingSignature ?? "") + delta.signature;
								}
							} else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
								anthropicToolArgsJson += delta.partial_json;
								stream.push({
									type: "toolcall_delta",
									contentIndex: anthropicCurrentIndex,
									delta: delta.partial_json,
									partial: outputMessage,
								});
							}
						}
					} else if (eventType === "content_block_stop") {
						const currentBlock = outputMessage.content[anthropicCurrentIndex];
						if (currentBlock?.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: anthropicCurrentIndex,
								content: currentBlock.text,
								partial: outputMessage,
							});
						} else if (currentBlock?.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: anthropicCurrentIndex,
								content: currentBlock.thinking,
								partial: outputMessage,
							});
						} else if (anthropicToolCall) {
							let parsedArgs: Record<string, unknown> | null = null;
							if (anthropicToolArgsJson && anthropicToolArgsJson.trim().length > 0) {
								try {
									parsedArgs = JSON.parse(anthropicToolArgsJson);
								} catch {
									parsedArgs = null;
								}
							} else {
								parsedArgs = {};
							}
							if (parsedArgs !== null && typeof parsedArgs === "object") {
								anthropicToolCall.arguments = parsedArgs;
								stream.push({
									type: "toolcall_end",
									contentIndex: anthropicCurrentIndex,
									toolCall: anthropicToolCall,
									partial: outputMessage,
								});
							} else {
								const contentIdx = outputMessage.content.indexOf(anthropicToolCall);
								if (contentIdx >= 0) {
									outputMessage.content.splice(contentIdx, 1);
								}
							}
							anthropicToolCall = null;
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
						if (item?.type === "reasoning") {
							closeActiveText();
							closeActiveThinking();
							const itemId = typeof item.id === "string" ? item.id : undefined;
							const wireItemId = typeof event.item_id === "string" ? event.item_id : undefined;
							const effectiveItemId = itemId ?? wireItemId;
							const outputIndex =
								typeof event.output_index === "number" && Number.isFinite(event.output_index)
									? Math.trunc(event.output_index)
									: undefined;
							const initialSummary = extractReasoningSummaryText(item);
							const thinkingBlock: ThinkingContent = {
								type: "thinking",
								thinking: initialSummary,
								...(effectiveItemId ? { itemId: effectiveItemId } : {}),
							};
							outputMessage.content.push(thinkingBlock);
							const contentIndex = outputMessage.content.length - 1;
							const state: ResponsesReasoningState = {
								block: thinkingBlock,
								contentIndex,
								itemId: effectiveItemId,
								outputIndex,
							};
							if (effectiveItemId) openResponsesReasoningsByItemId.set(effectiveItemId, state);
							if (outputIndex !== undefined) openResponsesReasoningsByOutputIndex.set(outputIndex, state);
							openResponsesReasonings.push(state);
							lastAddedResponsesReasoning = state;
							activeThinkingBlock = thinkingBlock;
							stream.push({
								type: "thinking_start",
								contentIndex,
								partial: outputMessage,
							});
						} else if (item?.type === "function_call") {
							closeActiveText();
							closeActiveThinking();
							const itemId = typeof item.id === "string" ? item.id : undefined;
							const callId = typeof item.call_id === "string" ? item.call_id : undefined;
							const wireItemId = typeof event.item_id === "string" ? event.item_id : undefined;
							const wireCallId = typeof event.call_id === "string" ? event.call_id : undefined;
							const effectiveItemId = itemId ?? wireItemId;
							const effectiveCallId = callId ?? wireCallId;
							const outputIndex =
								typeof event.output_index === "number" && Number.isFinite(event.output_index)
									? Math.trunc(event.output_index)
									: undefined;
							const toolCall: ToolCall = {
								type: "toolCall",
								id: effectiveCallId || effectiveItemId || crypto.randomUUID(),
								name: (item.name as string) || "",
								arguments: {},
							};
							outputMessage.content.push(toolCall);
							const contentIndex = outputMessage.content.length - 1;
							const state: ResponsesToolCallState = {
								toolCall,
								rawArgs: (typeof item.arguments === "string" ? item.arguments : "") || "",
								contentIndex,
								itemId: effectiveItemId,
								callId: effectiveCallId,
								outputIndex,
							};
							if (effectiveItemId) openResponsesToolCallsByItemId.set(effectiveItemId, state);
							if (effectiveCallId) openResponsesToolCallsByItemId.set(effectiveCallId, state);
							if (outputIndex !== undefined) openResponsesToolCallsByOutputIndex.set(outputIndex, state);
							openResponsesToolCalls.push(state);
							lastAddedResponsesToolCall = state;
							stream.push({
								type: "toolcall_start",
								contentIndex,
								partial: outputMessage,
							});
						}
					} else if (
						(eventType === "response.output_text.delta" ||
							eventType === "response.text.delta" ||
							eventType === "response.refusal.delta") &&
						typeof event.delta === "string"
					) {
						startOrAppendText(event.delta);
					} else if (
						(eventType === "response.reasoning_summary_text.delta" ||
							eventType === "response.reasoning.delta" ||
							eventType === "response.reasoning_text.delta") &&
						typeof event.delta === "string"
					) {
						closeActiveText();
						const target = findResponsesReasoning(event);
						if (target) {
							target.block.thinking += event.delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: target.contentIndex,
								delta: event.delta,
								partial: outputMessage,
							});
						} else {
							startOrAppendThinking(event.delta);
						}
					} else if (eventType === "response.function_call_arguments.delta" && typeof event.delta === "string") {
						closeActiveText();
						closeActiveThinking();
						const target = findResponsesToolCall(event);
						if (target) {
							target.rawArgs += event.delta;
							stream.push({
								type: "toolcall_delta",
								contentIndex: target.contentIndex,
								delta: event.delta,
								partial: outputMessage,
							});
						}
					} else if (
						eventType === "response.output_item.done" ||
						eventType === "response.function_call_arguments.done"
					) {
						const item = (event.item ?? event.output_item) as Record<string, unknown> | undefined;
						if (item?.type === "reasoning") {
							const target = findResponsesReasoning(event);
							if (target) {
								finishResponsesReasoning(target, item);
							} else {
								closeActiveThinking();
							}
						} else if (item?.type === "function_call" || eventType === "response.function_call_arguments.done") {
							const target = findResponsesToolCall(event);
							if (target) {
								finishResponsesToolCall(
									target,
									item ?? (typeof event.arguments === "string" ? event : undefined),
								);
							}
						} else if (
							item?.type === "message" ||
							item?.type === "refusal" ||
							eventType === "response.output_item.done"
						) {
							closeActiveText();
							closeActiveThinking();
						}
					} else if (
						eventType === "response.output_text.done" ||
						eventType === "response.text.done" ||
						eventType === "response.refusal.done"
					) {
						closeActiveText();
					} else if (
						eventType === "response.reasoning_summary_text.done" ||
						eventType === "response.reasoning.done"
					) {
						const target = findResponsesReasoning(event);
						if (target) {
							finishResponsesReasoning(target);
						} else {
							closeActiveThinking();
						}
					}

					// ─── OPENAI RESPONSES TERMINAL EVENT FLAVOR ───
					else if (eventType === "response.incomplete") {
						responsesStreamIncomplete = true;
						const responseObj = (event.response ?? event) as {
							id?: string;
							status?: string;
							incomplete_details?: { reason?: string };
							error?: { code?: string; message?: string };
						};
						if (responseObj.id) {
							outputMessage.responseId = responseObj.id;
						}
						const reason = responseObj.incomplete_details?.reason;
						if (reason === "content_filter") {
							throw new ProviderResponseError("incomplete: content_filter", { kind: "content-blocked" });
						}
						outputMessage.stopReason = "length";
					} else if (eventType === "response.failed") {
						const responseObj = (event.response ?? event) as {
							id?: string;
							incomplete_details?: { reason?: string };
							error?: { code?: string; message?: string };
							status_details?: {
								reason?: string;
								error?: { code?: string; message?: string };
							};
						};
						if (responseObj.id) {
							outputMessage.responseId = responseObj.id;
						}
						const error = responseObj.error ?? responseObj.status_details?.error;
						const details = responseObj.incomplete_details;
						const statusDetailsReason = responseObj.status_details?.reason;
						const message = error
							? `${error.code || "unknown"}: ${error.message || "no message"}`
							: details?.reason
								? `incomplete: ${details.reason}`
								: statusDetailsReason
									? `status_details: ${statusDetailsReason}`
									: "Unknown error (no error details in response)";
						throw new ProviderResponseError(message, { provider: model.provider, kind: "output" });
					}

					// ─── OPENAI CHAT & GOOGLE GEMINI EVENT FLAVORS ───
					else if (Array.isArray(event.choices) && event.choices.length > 0) {
						const choice = event.choices[0] as {
							delta?: {
								content?: string;
								reasoning_content?: string;
								tool_calls?: Array<{
									index?: number;
									id?: string;
									type?: string;
									function?: { name?: string; arguments?: string };
								}>;
							};
							finish_reason?: string;
						};
						if (choice.finish_reason) {
							const fr = String(choice.finish_reason).toLowerCase();
							if (fr === "content_filter") {
								throw new ProviderResponseError("Provider finish_reason: content_filter", {
									kind: "content-blocked",
								});
							}
							if (fr === "length" || fr === "max_tokens") {
								outputMessage.stopReason = "length";
							} else if (fr === "tool_calls" || fr === "function_call") {
								outputMessage.stopReason = "toolUse";
							} else if (fr === "stop" || fr === "end") {
								outputMessage.stopReason = "stop";
							} else {
								outputMessage.stopReason = "error";
								outputMessage.errorMessage = `Provider finish_reason: ${choice.finish_reason}`;
							}
						}
						if (
							typeof choice.delta?.reasoning_content === "string" &&
							choice.delta.reasoning_content.length > 0
						) {
							startOrAppendThinking(choice.delta.reasoning_content);
						}
						if (typeof choice.delta?.content === "string" && choice.delta.content.length > 0) {
							startOrAppendText(choice.delta.content);
						}
						if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
							closeActiveText();
							closeActiveThinking();
							for (const tcDelta of choice.delta.tool_calls) {
								const streamIndex = typeof tcDelta.index === "number" ? tcDelta.index : undefined;
								let state = streamIndex !== undefined ? chatToolCallsByIndex.get(streamIndex) : undefined;
								if (!state && tcDelta.id) {
									state = pendingChatToolCalls.find(c => c.toolCall.id === tcDelta.id);
								}
								if (!state && !tcDelta.id && streamIndex === undefined) {
									state = lastChatToolCall ?? undefined;
								}

								if (!state) {
									const toolCall: ToolCall = {
										type: "toolCall",
										id: tcDelta.id || crypto.randomUUID(),
										name: tcDelta.function?.name || "",
										arguments: {},
									};
									outputMessage.content.push(toolCall);
									const contentIndex = outputMessage.content.length - 1;
									state = {
										toolCall,
										rawArgs: "",
										contentIndex,
										index: streamIndex,
									};
									if (streamIndex !== undefined) chatToolCallsByIndex.set(streamIndex, state);
									pendingChatToolCalls.push(state);
									lastChatToolCall = state;
									stream.push({
										type: "toolcall_start",
										contentIndex,
										partial: outputMessage,
									});
								} else {
									if (tcDelta.id) state.toolCall.id = tcDelta.id;
									if (tcDelta.function?.name && !state.toolCall.name)
										state.toolCall.name = tcDelta.function.name;
									if (streamIndex !== undefined && state.index === undefined) {
										state.index = streamIndex;
										chatToolCallsByIndex.set(streamIndex, state);
									}
									lastChatToolCall = state;
								}

								if (tcDelta.function?.arguments) {
									state.rawArgs += tcDelta.function.arguments;
									stream.push({
										type: "toolcall_delta",
										contentIndex: state.contentIndex,
										delta: tcDelta.function.arguments,
										partial: outputMessage,
									});
								}
							}
						}
					} else if (Array.isArray(event.candidates) && event.candidates.length > 0) {
						const candidate = event.candidates[0] as {
							finish_reason?: string;
							finishReason?: string;
							content?: {
								parts?: Array<{
									text?: string;
									thought?: boolean;
									thoughtSignature?: string;
									functionCall?: { name?: string; args?: Record<string, unknown> };
								}>;
							};
						};
						const gfr = candidate.finish_reason ?? candidate.finishReason;
						let candidateHasError = false;
						if (gfr) {
							const mapped = mapStopReasonString(gfr);
							if (mapped === "stop" || mapped === "length") {
								outputMessage.stopReason = mapped;
							} else {
								candidateHasError = true;
								outputMessage.stopReason = "error";
								outputMessage.errorMessage = `Generation failed with finish reason: ${gfr}`;
							}
						}
						const parts = candidate.content?.parts ?? [];
						for (const part of parts) {
							if (isThinkingPart(part)) {
								startOrAppendThinking(part.text ?? "", part.thoughtSignature);
							} else if (typeof part.text === "string" && part.text.length > 0) {
								startOrAppendText(part.text);
							} else if (part.thoughtSignature && !part.functionCall) {
								for (let i = outputMessage.content.length - 1; i >= 0; i--) {
									const thinkBlock = outputMessage.content[i];
									if (thinkBlock?.type !== "thinking") continue;
									thinkBlock.thinkingSignature = retainThoughtSignature(
										thinkBlock.thinkingSignature,
										part.thoughtSignature,
									);
									break;
								}
							}
							if (part.functionCall?.name && !candidateHasError) {
								closeActiveText();
								closeActiveThinking();
								const toolCall: ToolCall = {
									type: "toolCall",
									id: crypto.randomUUID(),
									name: part.functionCall.name,
									arguments: part.functionCall.args ?? {},
									...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
								};
								outputMessage.content.push(toolCall);
								const contentIndex = outputMessage.content.length - 1;
								stream.push({
									type: "toolcall_start",
									contentIndex,
									partial: outputMessage,
								});
								stream.push({
									type: "toolcall_end",
									contentIndex,
									toolCall,
									partial: outputMessage,
								});
							}
						}
					}

					// ─── USAGE METRICS ───
					if (
						eventType === "message_delta" ||
						eventType === "response.completed" ||
						eventType === "response.incomplete" ||
						eventType === "response.done"
					) {
						const responseObj = (event.response ?? event) as {
							id?: string;
							status?: string;
							incomplete_details?: { reason?: string };
							error?: { code?: string; message?: string };
						};
						if (responseObj.id) {
							outputMessage.responseId = responseObj.id;
						}
						if (responseObj.status === "incomplete") {
							responsesStreamIncomplete = true;
							const reason = responseObj.incomplete_details?.reason;
							if (reason === "content_filter") {
								throw new ProviderResponseError("incomplete: content_filter", { kind: "content-blocked" });
							}
							outputMessage.stopReason = "length";
						} else if (responseObj.status === "failed" || responseObj.status === "cancelled") {
							const error = responseObj.error;
							throw new ProviderResponseError(
								error
									? `${error.code || "unknown"}: ${error.message || "no message"}`
									: `Response ${responseObj.status}`,
								{ kind: "output" },
							);
						}

						const usage = (event.usage ?? (event.response as { usage?: unknown })?.usage) as
							| {
									output_tokens?: number;
									output?: number;
									input_tokens?: number;
									input?: number;
									cached_tokens?: number;
									input_tokens_details?: {
										cached_tokens?: number;
									};
									output_tokens_details?: {
										reasoning_tokens?: number;
									};
									cache_creation_input_tokens?: number;
									cache_read_input_tokens?: number;
							  }
							| undefined;
						if (usage && outputMessage.usage) {
							outputMessage.usage.output = usage.output_tokens ?? usage.output ?? outputMessage.usage.output;
							const cachedTokens =
								usage.cache_read_input_tokens ??
								usage.input_tokens_details?.cached_tokens ??
								usage.cached_tokens ??
								outputMessage.usage.cacheRead;
							outputMessage.usage.cacheRead = cachedTokens;
							const rawInput = usage.input_tokens ?? usage.input;
							if (rawInput !== undefined) {
								outputMessage.usage.input = Math.max(
									0,
									rawInput - (usage.input_tokens_details?.cached_tokens ?? 0),
								);
							}
							outputMessage.usage.cacheWrite =
								usage.cache_creation_input_tokens ?? outputMessage.usage.cacheWrite;
						}
					} else if (event.usageMetadata && typeof event.usageMetadata === "object" && outputMessage.usage) {
						const um = event.usageMetadata as {
							promptTokenCount?: number;
							candidatesTokenCount?: number;
							thoughtsTokenCount?: number;
							cachedContentTokenCount?: number;
							totalTokenCount?: number;
						};
						const cached = um.cachedContentTokenCount || 0;
						const thinkingTokens = um.thoughtsTokenCount || 0;
						if (um.promptTokenCount !== undefined) {
							outputMessage.usage.input = Math.max(0, um.promptTokenCount - cached);
							outputMessage.usage.cacheRead = cached;
						} else if (um.cachedContentTokenCount !== undefined) {
							outputMessage.usage.cacheRead = cached;
						}
						if (um.candidatesTokenCount !== undefined || um.thoughtsTokenCount !== undefined) {
							outputMessage.usage.output = (um.candidatesTokenCount || 0) + thinkingTokens;
						}
						if (thinkingTokens > 0) {
							outputMessage.usage.reasoningTokens = thinkingTokens;
						}
					} else if (event.usage && typeof event.usage === "object" && outputMessage.usage) {
						const u = event.usage as {
							prompt_tokens?: number;
							completion_tokens?: number;
							cached_tokens?: number;
							prompt_tokens_details?: {
								cached_tokens?: number;
							};
							input_tokens_details?: {
								cached_tokens?: number;
							};
							completion_tokens_details?: {
								reasoning_tokens?: number;
							};
						};
						const cached =
							u.prompt_tokens_details?.cached_tokens ??
							u.input_tokens_details?.cached_tokens ??
							u.cached_tokens ??
							0;
						if (cached > 0) {
							outputMessage.usage.cacheRead = cached;
						}
						if (u.prompt_tokens !== undefined) {
							outputMessage.usage.input = Math.max(0, u.prompt_tokens - cached);
						}
						if (u.completion_tokens !== undefined) {
							outputMessage.usage.output = u.completion_tokens;
						}
						const reasoningTokens = u.completion_tokens_details?.reasoning_tokens;
						if (reasoningTokens !== undefined && reasoningTokens > 0) {
							outputMessage.usage.reasoningTokens = reasoningTokens;
						}
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
				if (sawStreamEnded) break;
				if (done) {
					throw new ProviderResponseError("Zed stream closed before stream_ended status was received", {
						kind: "incomplete-stream",
					});
				}
			}

			closeActiveText();
			closeActiveThinking();
			if (anthropicToolCall && (outputMessage.stopReason === "length" || outputMessage.stopReason === "error")) {
				const contentIdx = outputMessage.content.indexOf(anthropicToolCall);
				if (contentIdx >= 0) {
					outputMessage.content.splice(contentIdx, 1);
				}
				anthropicToolCall = null;
			}
			finishAllPendingReasonings();
			finishAllPendingToolCalls();

			if (outputMessage.stopReason === "error") {
				throw new ProviderResponseError(outputMessage.errorMessage ?? "Generation failed with provider error", {
					kind: "output",
				});
			}

			if (
				!responsesStreamIncomplete &&
				outputMessage.content.some(b => b.type === "toolCall") &&
				outputMessage.stopReason === "stop"
			) {
				outputMessage.stopReason = "toolUse";
			}

			if (outputMessage.usage) {
				outputMessage.usage.totalTokens =
					outputMessage.usage.input +
					outputMessage.usage.output +
					outputMessage.usage.cacheRead +
					outputMessage.usage.cacheWrite;
				calculateCost(model, outputMessage.usage);
			}

			const doneReason =
				outputMessage.stopReason === "length" || outputMessage.stopReason === "toolUse"
					? outputMessage.stopReason
					: "stop";
			stream.push({ type: "done", reason: doneReason, message: outputMessage });
			stream.end(outputMessage);
		} catch (err) {
			const normalizedError = options.signal?.aborted ? new AbortError() : err;
			const finalized = await finalize(normalizedError, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				signal: options.signal,
			});
			const errorMsg: AssistantMessage = {
				role: "assistant",
				api: "zed-agent",
				provider: "zed-agent",
				model: model.id,
				content: [{ type: "text", text: `Error: ${finalized.message}` }],
				stopReason: finalized.stopReason,
				errorMessage: finalized.message,
				errorStatus: finalized.status,
				errorId: finalized.id,
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
			stream.push({ type: "error", reason: finalized.stopReason, error: errorMsg });
			stream.end(errorMsg);
		}
	})().catch(async err => {
		const normalizedError = options.signal?.aborted ? new AbortError() : err;
		const finalized = await finalize(normalizedError, {
			api: model.api,
			provider: model.provider,
			model: model.id,
			signal: options.signal,
		});
		const errorMsg: AssistantMessage = {
			role: "assistant",
			api: "zed-agent",
			provider: "zed-agent",
			model: model.id,
			content: [{ type: "text", text: `Fatal Error: ${finalized.message}` }],
			stopReason: finalized.stopReason,
			errorMessage: finalized.message,
			errorStatus: finalized.status,
			errorId: finalized.id,
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
		stream.push({ type: "error", reason: finalized.stopReason, error: errorMsg });
		stream.end(errorMsg);
	});

	return stream;
}
