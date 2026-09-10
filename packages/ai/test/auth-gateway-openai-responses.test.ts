import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { encodeResponse, encodeStream, parseRequest } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	return out;
}

interface SseFrame {
	event: string;
	data: Record<string, unknown> | string;
}

function parseSse(raw: string): SseFrame[] {
	const frames: SseFrame[] = [];
	for (const chunk of raw.split("\n\n")) {
		if (!chunk.trim()) continue;
		let event = "";
		let dataLine = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice("event: ".length);
			else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
		}
		if (dataLine === "[DONE]") {
			frames.push({ event: event || "done_sentinel", data: "[DONE]" });
		} else if (dataLine) {
			const parsed: unknown = JSON.parse(dataLine);
			if (parsed && typeof parsed === "object") {
				frames.push({ event, data: parsed as Record<string, unknown> });
			}
		}
	}
	return frames;
}

describe("openai-responses parseRequest", () => {
	it("parses an input array with mixed message + reasoning + function_call + function_call_output", () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_abc",
			summary: [{ type: "summary_text", text: "The user wants arithmetic." }],
		};
		const parsed = parseRequest({
			model: "gpt-5.3-codex-spark",
			instructions: "You are X",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "what's 2+2?" }] },
				{
					type: "message",
					role: "assistant",
					id: "msg_commentary",
					phase: "commentary",
					content: [
						{ type: "output_text", text: "Let me " },
						{ type: "output_text", text: "think." },
					],
				},
				reasoningItem,
				{
					type: "function_call",
					id: "fc_item_999",
					call_id: "call_42",
					name: "math",
					arguments: '{"a":2,"b":2}',
				},
				{ type: "function_call_output", call_id: "call_42", output: "4" },
			],
			tools: [
				{
					type: "function",
					name: "math",
					description: "Do arithmetic",
					parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
					strict: true,
				},
			],
			tool_choice: { type: "function", name: "math" },
			max_output_tokens: 1024,
			temperature: 0.1,
			top_p: 0.9,
			reasoning: { effort: "high", summary: "detailed" },
			store: true,
			previous_response_id: "resp_prev",
			stream: true,
		});

		expect(parsed.modelId).toBe("gpt-5.3-codex-spark");
		expect(parsed.stream).toBe(true);
		expect(parsed.context.systemPrompt).toEqual(["You are X"]);

		const msgs = parsed.context.messages;
		expect(msgs).toHaveLength(3);

		// 1. user
		expect(msgs[0]!.role).toBe("user");
		const u = msgs[0]!;
		if (u.role !== "user") throw new Error("expected user");
		expect(u.content).toBe("what's 2+2?");

		// 2. assistant with text + reasoning + toolCall
		const a = msgs[1]!;
		if (a.role !== "assistant") throw new Error("expected assistant");
		expect(a.api).toBe("openai-responses");
		expect(a.provider).toBe("openai");
		expect(a.model).toBe("gpt-5.3-codex-spark");
		expect(a.content).toHaveLength(3);
		expect(a.content[0]).toMatchObject({ type: "text", text: "Let me think." });
		const commentary = a.content[0];
		if (commentary?.type !== "text") throw new Error("expected commentary text");
		expect(commentary.textSignature).toBe(JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }));
		expect(a.content[1]).toMatchObject({
			type: "thinking",
			thinking: "The user wants arithmetic.",
			thinkingSignature: JSON.stringify(reasoningItem),
			itemId: "rs_abc",
		});
		// Critical: call_id and item id are distinct.
		expect(a.content[2]).toMatchObject({
			type: "toolCall",
			id: "call_42",
			name: "math",
			arguments: { a: 2, b: 2 },
			thoughtSignature: "fc_item_999",
		});

		// 3. toolResult
		const tr = msgs[2]!;
		if (tr.role !== "toolResult") throw new Error("expected toolResult");
		expect(tr.toolCallId).toBe("call_42");
		expect(tr.toolName).toBe("math");
		expect(tr.content).toEqual([{ type: "text", text: "4" }]);
		expect(tr.isError).toBe(false);

		expect(parsed.context.tools).toHaveLength(1);
		expect(parsed.context.tools![0]).toMatchObject({ name: "math", strict: true });

		expect(parsed.options.maxOutputTokens).toBe(1024);
		expect(parsed.options.temperature).toBe(0.1);
		expect(parsed.options.topP).toBe(0.9);
		expect(parsed.options.toolChoice).toEqual({ name: "math" });
		expect(parsed.options.reasoning).toBe(Effort.High);
		// `reasoning.summary: "detailed"` is treated as the default visible-summary
		// case (only "none" toggles hideThinkingSummary).
		expect(parsed.options.hideThinkingSummary).toBeUndefined();
		// `store` and `previous_response_id` are accepted by the schema but not
		// plumbed through pi-ai — they no longer leak into options.extra.
		expect(parsed.options.extra).toBeUndefined();
	});

	it("preserves canonical multimodal order and nullable fallback sources", () => {
		const imageData = Buffer.from("tool image").toString("base64");
		const parsed = parseRequest({
			model: "gpt-5.6-sol",
			input: [
				{
					type: "function_call",
					id: "fc_read",
					call_id: "call_read",
					name: "read",
					arguments: '{"path":"image.png"}',
				},
				{
					type: "function_call_output",
					call_id: "call_read",
					output: [
						{
							type: "input_image",
							image_url: `data:image/png;base64,${imageData}`,
							file_id: null,
							detail: "original",
						},
						{ type: "input_text", text: "Read image file [image/png]" },
						{ type: "input_image", image_url: "", file_id: "file_image_123", detail: null },
						{ type: "input_text", text: "done" },
					],
				},
			],
		});

		const result = parsed.context.messages[1];
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		expect(result.content).toEqual([
			{ type: "image", data: imageData, mimeType: "image/png", detail: "original" },
			{ type: "text", text: "Read image file [image/png]" },
			{
				type: "image",
				data: "",
				mimeType: "application/octet-stream",
				providerFile: { provider: "openai", id: "file_image_123" },
			},
			{ type: "text", text: "done" },
		]);
	});

	it("rejects function output images with an empty source", () => {
		expect(() =>
			parseRequest({
				model: "gpt-5.6-sol",
				input: [
					{
						type: "function_call_output",
						call_id: "call_read",
						output: [{ type: "input_image", image_url: "", file_id: null, detail: null }],
					},
				],
			}),
		).toThrow(/at least one of `image_url` or `file_id`/);
	});

	it("rejects file blocks in tool outputs instead of flattening their content", () => {
		expect(() =>
			parseRequest({
				model: "gpt-5.6-sol",
				input: [
					{
						type: "function_call_output",
						call_id: "call_read",
						output: [{ type: "input_file", filename: "report.pdf", file_data: "opaque" }],
					},
				],
			}),
		).toThrow(/input_file/);
	});

	it("concatenates legacy function output text while retaining inline images", () => {
		const imageData = Buffer.from("legacy image").toString("base64");
		const parsed = parseRequest({
			model: "gpt-5.6-sol",
			input: [
				{
					type: "function_call_output",
					call_id: "call_legacy",
					output: [
						{ type: "output_text", text: "foo" },
						{ type: "text", text: "bar" },
						{ type: "refusal", refusal: "no" },
						{ type: "input_image", image_url: `data:image/png;base64,${imageData}` },
					],
				},
			],
		});

		const result = parsed.context.messages[0];
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		expect(result.content).toEqual([
			{ type: "text", text: "foobar[refusal: no]" },
			{ type: "image", data: imageData, mimeType: "image/png" },
		]);
	});

	it("round-trips Pi image-read image forms as native function output blocks", () => {
		const imageData = Buffer.from("read tool image").toString("base64");
		const imageUrl = "https://blob.example.invalid/read-image.png";
		const providerFileId = "file_read_image_123";
		const model = buildModel({
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		} satisfies ModelSpec<"openai-responses">);
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "image.png" } }],
					api: "openai-responses",
					provider: "openai",
					model: model.id,
					usage: zeroUsage(),
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_read",
					toolName: "read",
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: imageData, mimeType: "image/png", detail: "original" },
						{ type: "image", data: imageData, mimeType: "image/png", detail: "high", url: imageUrl },
						{
							type: "image",
							data: imageData,
							mimeType: "image/png",
							detail: "low",
							providerFile: { provider: "openai", id: providerFileId },
						},
					],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const wireInput = buildResponsesInput({
			model,
			context,
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});
		const wireOutput = wireInput.find(item => item.type === "function_call_output");
		if (wireOutput?.type !== "function_call_output") throw new Error("expected function output");
		expect(wireOutput.output).toEqual([
			{ type: "input_text", text: "Read image file [image/png]" },
			{
				type: "input_image",
				detail: "original",
				image_url: `data:image/png;base64,${imageData}`,
			},
			{ type: "input_image", detail: "high", image_url: imageUrl },
			{ type: "input_image", detail: "low", file_id: providerFileId },
		]);
		expect(wireInput.some(item => "role" in item && item.role === "user")).toBe(false);

		const parsed = parseRequest({ model: model.id, input: wireInput });
		const result = parsed.context.messages.find(message => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: imageData, mimeType: "image/png", detail: "original" },
			{
				type: "image",
				data: "",
				mimeType: "application/octet-stream",
				detail: "high",
				url: imageUrl,
			},
			{
				type: "image",
				data: "",
				mimeType: "application/octet-stream",
				detail: "low",
				providerFile: { provider: "openai", id: providerFileId },
			},
		]);

		const replayInput = buildResponsesInput({
			model,
			context: parsed.context,
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});
		const replayOutput = replayInput.find(item => item.type === "function_call_output");
		if (replayOutput?.type !== "function_call_output") throw new Error("expected replayed function output");
		expect(replayOutput.output).toEqual(wireOutput.output);
	});

	it("round-trips array-valued custom tool outputs without demoting them", () => {
		const imageData = Buffer.from("custom tool image").toString("base64");
		const model = buildModel({
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			applyPatchToolType: "freeform",
		} satisfies ModelSpec<"openai-responses">);
		const parsed = parseRequest({
			model: model.id,
			input: [
				{
					type: "custom_tool_call",
					call_id: "call_patch",
					name: "apply_patch",
					input: "*** Begin Patch",
				},
				{
					type: "custom_tool_call_output",
					call_id: "call_patch",
					output: [
						{ type: "input_text", text: "Rendered patch preview" },
						{ type: "input_image", image_url: `data:image/png;base64,${imageData}`, detail: "high" },
					],
				},
			],
		});

		const result = parsed.context.messages[1];
		if (result?.role !== "toolResult") throw new Error("expected custom tool result");
		expect(result.toolName).toBe("apply_patch");
		expect(result.content).toEqual([
			{ type: "text", text: "Rendered patch preview" },
			{ type: "image", data: imageData, mimeType: "image/png", detail: "high" },
		]);

		const replay = buildResponsesInput({
			model,
			context: parsed.context,
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});
		const replayOutput = replay.find(item => item.type === "custom_tool_call_output");
		if (replayOutput?.type !== "custom_tool_call_output") throw new Error("expected custom tool output");
		expect(replayOutput.output).toEqual([
			{ type: "input_text", text: "Rendered patch preview" },
			{ type: "input_image", detail: "high", image_url: `data:image/png;base64,${imageData}` },
		]);
		expect(replay.some(item => item.type === "function_call_output")).toBe(false);
	});

	it("rejects raw explicit prompt-cache controls instead of silently dropping them", () => {
		expect(() =>
			parseRequest({
				model: "gpt-5.6",
				input: "hi",
				prompt_cache_options: { mode: "explicit", ttl: "30m" },
			}),
		).toThrow("prompt_cache_options and prompt_cache_breakpoint are unsupported");
		expect(() =>
			parseRequest({
				model: "gpt-5.6",
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }],
					},
				],
			}),
		).toThrow("prompt_cache_options and prompt_cache_breakpoint are unsupported");
	});

	it("accepts a bare string input and rejects a missing model", () => {
		const parsed = parseRequest({ model: "m", input: "hi" });
		expect(parsed.context.messages).toHaveLength(1);
		const m = parsed.context.messages[0]!;
		if (m.role !== "user") throw new Error("expected user");
		expect(m.content).toBe("hi");

		expect(() => parseRequest({ input: "hi" })).toThrow(/model/);
	});

	it("preserves string message content and system input items", () => {
		const parsed = parseRequest({
			model: "m",
			instructions: "top-level instructions",
			input: [
				{ role: "system", content: "system from easy input" },
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi there" },
				{
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: "structured system" }],
				},
			],
		});

		expect(parsed.context.systemPrompt).toEqual([
			"top-level instructions",
			"system from easy input",
			"structured system",
		]);
		expect(parsed.context.messages).toHaveLength(2);
		const user = parsed.context.messages[0]!;
		const assistant = parsed.context.messages[1]!;
		if (user.role !== "user") throw new Error("expected user");
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		expect(user.content).toBe("hello");
		expect(assistant.content).toEqual([{ type: "text", text: "hi there" }]);
	});

	it("creates a synthetic assistant when reasoning comes before any assistant message", () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_x",
			content: [{ type: "reasoning_text", text: "hmm" }],
		};
		const parsed = parseRequest({
			model: "m",
			input: [reasoningItem],
		});
		expect(parsed.context.messages).toHaveLength(1);
		const a = parsed.context.messages[0]!;
		if (a.role !== "assistant") throw new Error("expected synthetic assistant");
		expect(a.content).toHaveLength(1);
		expect(a.content[0]).toMatchObject({
			type: "thinking",
			thinking: "hmm",
			thinkingSignature: JSON.stringify(reasoningItem),
			itemId: "rs_x",
		});
	});

	it("parses GA computer tools, calls, screenshot refs, forced choice, and include losslessly", () => {
		const fileId = "file_电脑_01/%2F";
		const imageUrl = "https://example.invalid/capture/%E2%98%83.png?sig=a%2Fb+c&raw=✓";
		const pendingSafetyChecks = [{ id: "safe_1", code: "confirm_domain", message: "Open example.invalid?" }];
		const acknowledgedSafetyChecks = [{ id: "safe_1", code: "confirm_domain", message: "Open example.invalid?" }];
		const parsed = parseRequest({
			model: "gpt-5.4",
			tools: [{ type: "computer" }],
			tool_choice: { type: "computer" },
			include: ["computer_call_output.output.image_url", "reasoning.encrypted_content"],
			input: [
				{
					type: "computer_call",
					id: "item_computer_1",
					call_id: "call_computer_1",
					action: { type: "click", button: "left", x: 17, y: 29, keys: ["SHIFT"] },
					pending_safety_checks: pendingSafetyChecks,
					status: "completed",
				},
				{
					type: "computer_call_output",
					call_id: "call_computer_1",
					output: { type: "computer_screenshot", file_id: fileId },
					acknowledged_safety_checks: acknowledgedSafetyChecks,
					status: "failed",
				},
				{
					type: "computer_call",
					id: "item_computer_2",
					call_id: "call_computer_2",
					actions: [
						{ type: "keypress", keys: ["CTRL", "L"] },
						{ type: "type", text: imageUrl },
					],
					pending_safety_checks: [],
					status: "completed",
				},
				{
					type: "computer_call_output",
					call_id: "call_computer_2",
					output: { type: "computer_screenshot", image_url: imageUrl },
					acknowledged_safety_checks: [],
				},
			],
		});

		expect(parsed.context.tools).toEqual([
			{ name: "computer", description: "", parameters: {}, native: { type: "computer" } },
		]);
		expect(parsed.options.toolChoice).toEqual({ type: "computer" });
		expect(parsed.options.include).toEqual(["computer_call_output.output.image_url", "reasoning.encrypted_content"]);

		const [firstAssistant, fileResult, secondAssistant, urlResult] = parsed.context.messages;
		if (firstAssistant?.role !== "assistant" || secondAssistant?.role !== "assistant") {
			throw new Error("expected computer calls to be assistant messages");
		}
		if (fileResult?.role !== "toolResult" || urlResult?.role !== "toolResult") {
			throw new Error("expected computer outputs to be tool results");
		}
		expect(firstAssistant.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_computer_1",
			name: "computer",
			arguments: { actions: [{ type: "click", button: "left", x: 17, y: 29, keys: ["SHIFT"] }] },
			providerMetadata: {
				type: "computer",
				providerItemId: "item_computer_1",
				actions: [{ type: "click", button: "left", x: 17, y: 29, keys: ["SHIFT"] }],
				pendingSafetyChecks,
			},
		});
		expect(fileResult.content).toEqual([]);
		expect(fileResult.isError).toBe(true);
		expect(fileResult.providerMetadata).toEqual({
			type: "computer",
			screenshot: { type: "computer_screenshot", file_id: fileId },
			acknowledgedSafetyChecks,
		});
		expect(secondAssistant.content[0]).toMatchObject({
			providerMetadata: {
				type: "computer",
				providerItemId: "item_computer_2",
				actions: [
					{ type: "keypress", keys: ["CTRL", "L"] },
					{ type: "type", text: imageUrl },
				],
				pendingSafetyChecks: [],
			},
		});
		expect(urlResult.content).toEqual([]);
		expect(urlResult.providerMetadata).toEqual({
			type: "computer",
			screenshot: { type: "computer_screenshot", image_url: imageUrl },
			acknowledgedSafetyChecks: [],
		});
	});

	it("uses the singular GA action when an explicitly empty actions batch is also present", () => {
		const action = { type: "click" as const, button: "left" as const, x: 41, y: 73 };
		const parsed = parseRequest({
			model: "gpt-5.4",
			input: [
				{
					type: "computer_call",
					id: "item_empty_batch",
					call_id: "call_empty_batch",
					actions: [],
					action,
					pending_safety_checks: [],
					status: "completed",
				},
			],
		});
		const message = parsed.context.messages[0];
		if (message?.role !== "assistant" || message.content[0]?.type !== "toolCall") {
			throw new Error("expected computer call");
		}
		expect(message.content[0].arguments).toEqual({ actions: [action] });
		expect(message.content[0].providerMetadata).toEqual({
			type: "computer",
			providerItemId: "item_empty_batch",
			actions: [action],
			pendingSafetyChecks: [],
		});
	});

	it("preserves input image and file refs as replayable native payload without placeholders", () => {
		const nativeItem = {
			type: "message" as const,
			role: "user" as const,
			content: [
				{ type: "input_text" as const, text: "inspect these" },
				{ type: "input_image" as const, file_id: "file_image_电脑/%2F", detail: "original" as const },
				{
					type: "input_image" as const,
					image_url: "https://example.invalid/image?sig=a%2Fb+✓",
					detail: "auto" as const,
				},
				{ type: "input_file" as const, file_url: "https://example.invalid/context/%E9%9B%AA.pdf?sig=a%2Fb+✓" },
			],
		};
		const parsed = parseRequest({ model: "gpt-5.4", input: [nativeItem] });
		const message = parsed.context.messages[0];
		if (message?.role !== "user") throw new Error("expected user message");
		expect(message.content).toBe("inspect these");
		expect(message.providerPayload).toEqual({ type: "openaiResponsesHistory", items: [nativeItem], dt: true });
		expect(JSON.stringify(message.content)).not.toContain("[image:");
		expect(JSON.stringify(message.content)).not.toContain("[file:");

		const replayModel = buildModel({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		} satisfies ModelSpec<"openai-responses">);
		const replay = buildResponsesInput({
			model: replayModel,
			context: parsed.context,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		expect(replay).toEqual([nativeItem]);

		const nativeSystemItem = {
			type: "message" as const,
			role: "system" as const,
			content: [
				{ type: "input_text" as const, text: "Inspect this policy image" },
				{ type: "input_image" as const, file_id: "file_system_image_雪", detail: "auto" as const },
				{ type: "input_file" as const, file_id: "file_system_document_电脑" },
			],
		};
		const systemParsed = parseRequest({ model: "gpt-5.4", input: [nativeSystemItem] });
		expect(systemParsed.context.systemPrompt).toBeUndefined();
		const carrier = systemParsed.context.messages[0];
		if (carrier?.role !== "developer") throw new Error("expected native system payload carrier");
		expect(carrier.content).toBe("Inspect this policy image");
		expect(carrier.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			items: [nativeSystemItem],
			dt: true,
		});
		const systemReplay = buildResponsesInput({
			model: replayModel,
			context: systemParsed.context,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		expect(systemReplay).toEqual([nativeSystemItem]);
	});

	it("rejects malformed known computer items instead of accepting them as opaque hosted items", () => {
		expect(() =>
			parseRequest({
				model: "gpt-5.4",
				input: [{ type: "computer_call", id: "item_only" }],
			}),
		).toThrow(/computer_call|call_id|valid bridged Responses input item/);
	});
});

describe("openai-responses encodeResponse", () => {
	it("encodes reasoning + message + function_call output items", () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_signed",
			summary: [{ type: "summary_text", text: "thinking aloud" }],
		};
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [
				{
					type: "thinking",
					thinking: "thinking aloud",
					thinkingSignature: JSON.stringify(reasoningItem),
					itemId: "rs_signed",
				},
				{ type: "text", text: "Hello " },
				{ type: "text", text: "world" },
				{
					type: "toolCall",
					id: "call_t1",
					name: "math",
					arguments: { a: 1, b: 2 },
					thoughtSignature: "fc_item_t1",
				},
			],
			usage: {
				...zeroUsage(),
				input: 10,
				output: 20,
				cacheRead: 4,
				cacheWrite: 6,
				reasoningTokens: 5,
			},
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};

		const body = encodeResponse(message, "gpt-5-requested");

		expect(body.object).toBe("response");
		expect(body.status).toBe("completed");
		expect(Object.hasOwn(body, "incomplete_details")).toBe(true);
		expect(body.incomplete_details).toBeNull();
		expect(body.model).toBe("gpt-5-requested");
		expect(body.created_at).toBe(1_700_000_000);
		expect(typeof body.id).toBe("string");
		expect((body.id as string).startsWith("resp_")).toBe(true);

		const output = body.output as Array<Record<string, unknown>>;
		expect(output).toHaveLength(3);

		expect(output[0]).toEqual(reasoningItem);

		// Consecutive text collapses into one message item with two parts.
		expect(output[1]!.type).toBe("message");
		expect(output[1]!.role).toBe("assistant");
		const parts = output[1]!.content as Array<{ type: string; text: string; annotations: never[] }>;
		expect(parts).toEqual([
			{ type: "output_text", text: "Hello ", annotations: [] },
			{ type: "output_text", text: "world", annotations: [] },
		]);

		// function_call: wire id (thoughtSignature) and call_id are distinct.
		expect(output[2]).toMatchObject({
			type: "function_call",
			id: "fc_item_t1",
			call_id: "call_t1",
			name: "math",
			arguments: '{"a":1,"b":2}',
			status: "completed",
		});

		expect(body.usage).toEqual({
			input_tokens: 20,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens: 20,
			output_tokens_details: { reasoning_tokens: 5 },
			total_tokens: 40,
		});
	});

	it("encodes assistant message phase from text signatures", () => {
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [
				{
					type: "text",
					text: "Intermediate update",
					textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
				},
				{
					type: "text",
					text: "Final answer",
					textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
				},
			],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		const body = encodeResponse(message, "gpt-5-requested");
		const output = body.output as Array<Record<string, unknown>>;

		expect(output).toHaveLength(2);
		expect(output[0]).toMatchObject({
			type: "message",
			id: "msg_commentary",
			role: "assistant",
			status: "completed",
			phase: "commentary",
			content: [{ type: "output_text", text: "Intermediate update", annotations: [] }],
		});
		expect(output[1]).toMatchObject({
			type: "message",
			id: "msg_final",
			role: "assistant",
			status: "completed",
			phase: "final_answer",
			content: [{ type: "output_text", text: "Final answer", annotations: [] }],
		});
	});

	it("builds a GA computer_call output item from typed metadata", () => {
		const actions = [
			{ type: "move" as const, x: 400, y: 250, keys: null },
			{ type: "click" as const, button: "left" as const, x: 400, y: 250 },
		];
		const pendingSafetyChecks = [{ id: "safe_click", code: null, message: "Confirm click" }];
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			content: [
				{
					type: "toolCall",
					id: "call_computer_9",
					name: "computer",
					arguments: { actions },
					providerMetadata: {
						type: "computer",
						providerItemId: "item_computer_9",
						actions,
						pendingSafetyChecks,
					},
				},
			],
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};

		const body = encodeResponse(message, "gpt-5.4-requested");
		expect(body.output).toEqual([
			{
				type: "computer_call",
				id: "item_computer_9",
				call_id: "call_computer_9",
				actions,
				pending_safety_checks: pendingSafetyChecks,
				status: "completed",
			},
		]);
	});

	it("marks length-limited responses incomplete", () => {
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "partial" }],
			usage: zeroUsage(),
			stopReason: "length",
			timestamp: 1_700_000_000_000,
		};

		const body = encodeResponse(message, "gpt-5-requested");

		expect(body.status).toBe("incomplete");
		expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
	});
});

describe("openai-responses encodeStream", () => {
	it("emits response.created, reasoning_summary_text.delta, output_text.delta, function_call_arguments.delta, response.completed, [DONE]", async () => {
		const stream = new AssistantMessageEventStream();

		const partial: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		const finalMessage: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [
				{ type: "thinking", thinking: "step 1", thinkingSignature: "rs_s1", itemId: "rs_s1" },
				{ type: "text", text: "Hi!" },
				{
					type: "toolCall",
					id: "call_x",
					name: "math",
					arguments: { a: 1 },
					thoughtSignature: "fc_x",
				},
			],
			usage: { ...zeroUsage(), input: 1, output: 2 },
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};

		// Push events asynchronously while consumer reads.
		const partialWithThinking: AssistantMessage = {
			...partial,
			content: [{ type: "thinking", thinking: "", thinkingSignature: "rs_s1", itemId: "rs_s1" }],
		};
		const partialWithToolCall: AssistantMessage = {
			...partial,
			content: [
				{ type: "thinking", thinking: "step 1", thinkingSignature: "rs_s1", itemId: "rs_s1" },
				{ type: "text", text: "Hi!" },
				{ type: "toolCall", id: "call_x", name: "math", arguments: {}, thoughtSignature: "fc_x" },
			],
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial });
			stream.push({ type: "thinking_start", contentIndex: 0, partial: partialWithThinking });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "step ", partial: partialWithThinking });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "1", partial: partialWithThinking });
			stream.push({ type: "thinking_end", contentIndex: 0, content: "step 1", partial: partialWithThinking });
			stream.push({ type: "text_start", contentIndex: 1, partial });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "Hi", partial });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "!", partial });
			stream.push({ type: "text_end", contentIndex: 1, content: "Hi!", partial });
			stream.push({ type: "toolcall_start", contentIndex: 2, partial: partialWithToolCall });
			stream.push({ type: "toolcall_delta", contentIndex: 2, delta: '{"a":', partial: partialWithToolCall });
			stream.push({ type: "toolcall_delta", contentIndex: 2, delta: "1}", partial: partialWithToolCall });
			stream.push({
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: {
					type: "toolCall",
					id: "call_x",
					name: "math",
					arguments: { a: 1 },
					thoughtSignature: "fc_x",
				},
				partial: partialWithToolCall,
			});
			stream.push({ type: "done", reason: "toolUse", message: finalMessage });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const names = frames.map(f => f.event);

		// Ordering: created → thinking flow → message flow → tool-call flow → completed → [DONE]
		expect(names[0]).toBe("response.created");
		expect(names[names.length - 1]).toBe("done_sentinel");
		expect(frames[frames.length - 1]!.data).toBe("[DONE]");

		// Spot-check critical events appear in the expected order.
		const idxCreated = names.indexOf("response.created");
		const idxReasoningDelta = names.indexOf("response.reasoning_summary_text.delta");
		const idxReasoningDone = names.indexOf("response.reasoning_summary_text.done");
		const idxTextDelta = names.indexOf("response.output_text.delta");
		const idxTextDone = names.indexOf("response.output_text.done");
		const idxArgsDelta = names.indexOf("response.function_call_arguments.delta");
		const idxMessageDone = frames.findIndex(
			f =>
				f.event === "response.output_item.done" &&
				(f.data as Record<string, unknown>).item &&
				((f.data as Record<string, unknown>).item as Record<string, unknown>).type === "message",
		);
		const idxArgsDone = names.indexOf("response.function_call_arguments.done");
		const idxCompleted = names.indexOf("response.completed");

		expect(idxCreated).toBeGreaterThanOrEqual(0);
		expect(idxReasoningDelta).toBeGreaterThan(idxCreated);
		expect(idxReasoningDone).toBeGreaterThan(idxReasoningDelta);
		expect(idxTextDelta).toBeGreaterThan(idxReasoningDone);
		expect(idxTextDone).toBeGreaterThan(idxTextDelta);
		expect(idxArgsDelta).toBeGreaterThan(idxTextDone);
		expect(idxArgsDone).toBeGreaterThan(idxArgsDelta);
		expect(idxCompleted).toBeGreaterThan(idxArgsDone);

		// reasoning_summary_text.delta must carry item_id matching the signature, and output_index 0.
		const reasoningDelta = frames[idxReasoningDelta]!.data as Record<string, unknown>;
		expect(reasoningDelta.item_id).toBe("rs_s1");
		expect(reasoningDelta.output_index).toBe(0);
		expect(reasoningDelta.delta).toBe("step ");

		// output_text.delta's item_id is a new msg_*, output_index moved on past the reasoning item.
		const textDelta = frames[idxTextDelta]!.data as Record<string, unknown>;
		expect(typeof textDelta.item_id).toBe("string");
		expect((textDelta.item_id as string).startsWith("msg_")).toBe(true);
		expect(textDelta.output_index).toBe(1);
		expect(textDelta.delta).toBe("Hi");
		expect(textDelta.logprobs).toEqual([]);

		const textDone = frames[idxTextDone]!.data as Record<string, unknown>;
		expect(textDone.text).toBe("Hi!");
		expect(textDone.logprobs).toEqual([]);

		const messageDone = frames[idxMessageDone]!.data as Record<string, unknown>;
		expect(messageDone.output_index).toBe(1);
		expect(messageDone.item).toMatchObject({
			type: "message",
			status: "completed",
			content: [{ type: "output_text", text: "Hi!", annotations: [] }],
		});

		// function_call_arguments.delta uses the fc_* wire id, NOT call_x.
		const argsDelta = frames[idxArgsDelta]!.data as Record<string, unknown>;
		expect(argsDelta.item_id).toBe("fc_x");
		expect(argsDelta.output_index).toBe(2);
		expect(argsDelta.delta).toBe('{"a":');

		const argsDone = frames[idxArgsDone]!.data as Record<string, unknown>;
		expect(argsDone.item_id).toBe("fc_x");
		expect(argsDone.arguments).toBe('{"a":1}');
		expect(argsDone.name).toBe("math");

		// response.completed: assert the final response object carries the full output items
		// and that call_id ≠ id for the function_call item.
		const completed = frames[idxCompleted]!.data as Record<string, unknown>;
		const response = completed.response as Record<string, unknown>;
		expect(response.status).toBe("completed");
		expect(response.model).toBe("gpt-5-requested");
		const output = response.output as Array<Record<string, unknown>>;
		expect(output).toHaveLength(3);
		expect(output[0]!.type).toBe("reasoning");
		expect(output[1]!.type).toBe("message");
		expect(output[2]).toMatchObject({
			type: "function_call",
			id: "fc_x",
			call_id: "call_x",
			name: "math",
			arguments: '{"a":1}',
		});
		// Critical gotcha: id and call_id are distinct.
		expect(output[2]!.id).not.toBe(output[2]!.call_id);
	});

	it("streams a GA computer_call with provider item id, actions, and safety checks", async () => {
		const stream = new AssistantMessageEventStream();
		const actions = [{ type: "scroll" as const, x: 120, y: 240, scroll_x: 0, scroll_y: 650, keys: [] }];
		const pendingSafetyChecks = [{ id: "safe_scroll", code: "scroll_page", message: null }];
		const computerCall = {
			type: "toolCall" as const,
			id: "call_stream_computer",
			name: "computer",
			arguments: actions[0],
			providerMetadata: {
				type: "computer" as const,
				providerItemId: "item_stream_computer",
				actions,
				pendingSafetyChecks,
			},
		};
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			content: [computerCall],
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: computerCall, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		});

		const frames = parseSse(await collectStream(encodeStream(stream, "gpt-5.4-requested")));
		const computerEvents = frames
			.filter(f => f.event === "response.output_item.added" || f.event === "response.output_item.done")
			.map(f => (f.data as Record<string, unknown>).item as Record<string, unknown>)
			.filter(item => item.type === "computer_call");
		expect(computerEvents).toEqual([
			{
				type: "computer_call",
				id: "item_stream_computer",
				call_id: "call_stream_computer",
				actions,
				pending_safety_checks: pendingSafetyChecks,
				status: "in_progress",
			},
			{
				type: "computer_call",
				id: "item_stream_computer",
				call_id: "call_stream_computer",
				actions,
				pending_safety_checks: pendingSafetyChecks,
				status: "completed",
			},
		]);
		expect(frames.map(f => f.event)).not.toContain("response.function_call_arguments.delta");
		const completed = frames.find(f => f.event === "response.completed")?.data as Record<string, unknown> | undefined;
		const response = completed?.response as Record<string, unknown> | undefined;
		expect(response?.output).toEqual([computerEvents[1]]);
	});

	it("keeps interleaved reasoning, text, and computer items open by content index", async () => {
		const stream = new AssistantMessageEventStream();
		const computerCall = {
			type: "toolCall" as const,
			id: "call_interleaved_server",
			name: "computer",
			arguments: {},
			providerMetadata: {
				type: "computer" as const,
				providerItemId: "item_interleaved_server",
				actions: [{ type: "screenshot" as const }],
				pendingSafetyChecks: [],
			},
		};
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			content: [
				{ type: "thinking", thinking: "think", itemId: "rs_interleaved_server" },
				computerCall,
				{ type: "text", text: "answer" },
			],
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
			stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
			stream.push({ type: "text_start", contentIndex: 2, partial: message });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "think", partial: message });
			stream.push({ type: "text_delta", contentIndex: 2, delta: "answer", partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: computerCall, partial: message });
			stream.push({ type: "thinking_end", contentIndex: 0, content: "think", partial: message });
			stream.push({ type: "text_end", contentIndex: 2, content: "answer", partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		});

		const frames = parseSse(await collectStream(encodeStream(stream, "gpt-5.4-requested")));
		expect(
			frames.some(
				frame =>
					frame.event === "response.reasoning_summary_text.delta" &&
					(frame.data as Record<string, unknown>).delta === "think",
			),
		).toBe(true);
		expect(
			frames.some(
				frame =>
					frame.event === "response.output_text.delta" &&
					(frame.data as Record<string, unknown>).delta === "answer",
			),
		).toBe(true);
		expect(
			frames.some(
				frame =>
					frame.event === "response.output_item.done" &&
					((frame.data as Record<string, unknown>).item as Record<string, unknown>)?.type === "computer_call",
			),
		).toBe(true);
	});

	it("streams assistant message phase from text signatures", async () => {
		const stream = new AssistantMessageEventStream();
		const textSignature = JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" });
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "Working", textSignature }],
			usage: { ...zeroUsage(), input: 1, output: 1 },
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Working", partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "Working", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const messageItems = frames
			.filter(f => f.event === "response.output_item.added" || f.event === "response.output_item.done")
			.map(f => (f.data as Record<string, unknown>).item as Record<string, unknown>)
			.filter(item => item.type === "message");
		const completed = frames.find(f => f.event === "response.completed")?.data as Record<string, unknown> | undefined;
		const response = completed?.response as Record<string, unknown> | undefined;
		const output = response?.output as Array<Record<string, unknown>> | undefined;

		expect(messageItems).toHaveLength(2);
		expect(messageItems[0]).toMatchObject({ id: "msg_commentary", phase: "commentary" });
		expect(messageItems[1]).toMatchObject({ id: "msg_commentary", phase: "commentary" });
		expect(output?.[0]).toMatchObject({ id: "msg_commentary", phase: "commentary" });
	});

	it("routes late tool-call deltas by contentIndex after later parallel starts", async () => {
		const stream = new AssistantMessageEventStream();
		const base: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [],
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};
		const callA = { type: "toolCall" as const, id: "call_a", name: "edit", arguments: {} };
		const callB = { type: "toolCall" as const, id: "call_b", name: "read", arguments: {} };
		const partialA: AssistantMessage = { ...base, content: [callA] };
		const partialBoth: AssistantMessage = { ...base, content: [callA, callB] };
		const finalMessage: AssistantMessage = {
			...base,
			content: [
				{ ...callA, arguments: { input: "first" } },
				{ ...callB, arguments: { path: "second" } },
			],
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: base });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: partialA });
			stream.push({ type: "toolcall_start", contentIndex: 1, partial: partialBoth });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"input":"first"}', partial: partialBoth });
			stream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { ...callA, arguments: { input: "first" } },
				partial: partialBoth,
			});
			stream.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"second"}', partial: partialBoth });
			stream.push({
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { ...callB, arguments: { path: "second" } },
				partial: partialBoth,
			});
			stream.push({ type: "done", reason: "toolUse", message: finalMessage });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const argumentDeltas = frames.filter(f => f.event === "response.function_call_arguments.delta");
		expect(argumentDeltas.map(f => (f.data as Record<string, unknown>).output_index)).toEqual([0, 1]);
		expect(argumentDeltas.map(f => (f.data as Record<string, unknown>).delta)).toEqual([
			'{"input":"first"}',
			'{"path":"second"}',
		]);

		const argumentDone = frames.filter(f => f.event === "response.function_call_arguments.done");
		expect(argumentDone.map(f => (f.data as Record<string, unknown>).output_index)).toEqual([0, 1]);
		expect(argumentDone.map(f => (f.data as Record<string, unknown>).arguments)).toEqual([
			'{"input":"first"}',
			'{"path":"second"}',
		]);

		const doneItems = frames
			.filter(f => f.event === "response.output_item.done")
			.map(f => (f.data as Record<string, unknown>).item as Record<string, unknown>)
			.filter(item => item.type === "function_call");

		expect(doneItems).toHaveLength(2);
		expect(doneItems[0]).toMatchObject({ call_id: "call_a", name: "edit", arguments: '{"input":"first"}' });
		expect(doneItems[1]).toMatchObject({ call_id: "call_b", name: "read", arguments: '{"path":"second"}' });
	});
	it("emits response.incomplete for length-limited streams", async () => {
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "partial" }],
			usage: { ...zeroUsage(), output: 1 },
			stopReason: "length",
			timestamp: 1_700_000_000_000,
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "partial", partial: message });
			stream.push({ type: "done", reason: "length", message });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const names = frames.map(f => f.event);
		const idxIncomplete = names.indexOf("response.incomplete");

		expect(idxIncomplete).toBeGreaterThan(-1);
		expect(names).not.toContain("response.completed");
		const incomplete = frames[idxIncomplete]!.data as Record<string, unknown>;
		const response = incomplete.response as Record<string, unknown>;
		expect(response.status).toBe("incomplete");
		expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
	});
});

describe("auth-gateway OpenAI Responses multimodal tool outputs", () => {
	it("rejects OpenAI image file IDs before dispatching to a non-Responses upstream", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-responses-file-id-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openai", "test-key");
		const mock = createMockModel({ provider: "openai", id: "mock/file-id" });
		mock.push({ content: ["unexpected provider call"] });
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});

		try {
			const response = await fetch(`${gateway.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
				body: JSON.stringify({
					model: "mock/file-id",
					input: [
						{
							type: "function_call_output",
							call_id: "call_read",
							output: [{ type: "input_image", file_id: "file_image_123" }],
						},
					],
				}),
			});
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: { message: string } };
			expect(body.error.message).toContain("require a Responses-compatible upstream model");
			expect(mock.calls).toHaveLength(0);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			clearCustomApis();
		}
	});
});
describe("auth-gateway OpenAI Responses computer option bridge", () => {
	it("preserves the native tool, forced choice, and include in stream options", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-computer-options-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openai", "test-key");
		const mock = createMockModel({ provider: "openai", id: "mock/computer-options" });
		mock.push({ content: ["ok"] });
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});

		try {
			const response = await fetch(`${gateway.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
				body: JSON.stringify({
					model: "mock/computer-options",
					input: "inspect the desktop",
					tools: [{ type: "computer" }],
					tool_choice: { type: "computer" },
					include: ["computer_call_output.output.image_url", "reasoning.encrypted_content"],
				}),
			});
			expect(response.status).toBe(200);
			await response.text();
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0]!.context.tools).toEqual([
				{ name: "computer", description: "", parameters: {}, native: { type: "computer" } },
			]);
			expect(mock.calls[0]!.options?.toolChoice).toEqual({ type: "computer" });
			expect((mock.calls[0]!.options as { include?: string[] } | undefined)?.include).toEqual([
				"computer_call_output.output.image_url",
				"reasoning.encrypted_content",
			]);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			clearCustomApis();
		}
	});
});
