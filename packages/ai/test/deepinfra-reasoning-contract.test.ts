/**
 * Wire-contract tests for DeepInfra's OpenAI-compatible chat endpoint, pinned
 * to the request/response payloads captured against production in
 * oh-my-pi#9522 (`deepseek-ai/DeepSeek-V4-Flash-0731`, representative of the
 * whole DeepSeek family DeepInfra hosts):
 *
 *  - The endpoint is plain OpenAI format: the server owns all DeepSeek
 *    encoding (think tags, DSML tool markup), so no DeepSeek-shaped request
 *    fields may be emitted — thinking is gated by `reasoning_effort` alone.
 *  - `reasoning_effort` omitted or `"none"` = thinking off (off is the model
 *    default); named tiers = thinking on; `"max"` = DeepSeek's max-effort
 *    mode (`"xhigh"` alias).
 *  - Reasoning streams back as `delta.reasoning_content`; `content` never
 *    carries `<think>` markup.
 *  - Assistant tool-call turns must replay `reasoning_content` (the server
 *    preserves it when a `tools` array is present — the load-bearing case for
 *    agentic loops — and strips it in plain chat, so replaying everywhere is
 *    safe). DeepSeek-family models reject synthetic placeholders (`"."`), so
 *    missing reasoning must fall back to the empty string.
 */
import { describe, expect, it } from "bun:test";
import { convertMessages, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

/**
 * Mirrors the spec DeepInfra catalog discovery produces for the V4 Flash
 * entry. The compat engine owns the reviewed DeepSeek wire ladder.
 */
function deepinfraDeepseekModel(): Model<"openai-completions"> {
	return buildModel({
		id: "deepseek-ai/DeepSeek-V4-Flash-0731",
		name: "deepseek-ai/DeepSeek-V4-Flash-0731",
		api: "openai-completions",
		provider: "deepinfra",
		baseUrl: DEEPINFRA_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.27, output: 0.4, cacheRead: 0.054, cacheWrite: 0 },
		contextWindow: 163_840,
		maxTokens: 65_536,
	});
}

const capturedUserTurn: Context = {
	messages: [{ role: "user", content: "What is 2+2? Answer with just the number.", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function deltaChunk(model: Model<"openai-completions">, delta: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-deepinfra-contract",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta }],
	};
}

function finishChunk(model: Model<"openai-completions">): unknown {
	return {
		id: "chatcmpl-deepinfra-contract",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
}

async function captureRequestPayload(
	model: Model<"openai-completions">,
	options: { reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" },
): Promise<{ url: string; payload: Record<string, unknown> }> {
	let url = "";
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			url = input.toString();
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([deltaChunk(model, { content: "4" }), finishChunk(model), "[DONE]"]);
		},
		{ preconnect: fetch.preconnect },
	);
	const result = await streamOpenAICompletions(model, capturedUserTurn, {
		apiKey: "test-key",
		fetch: fetchMock,
		...options,
	}).result();
	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected a captured request payload");
	return { url, payload };
}

function assistantTurn(model: Model<"openai-completions">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

interface AssistantWireMessage {
	role: "assistant";
	content?: unknown;
	reasoning_content?: unknown;
}

function findAssistantWireMessage(messages: readonly unknown[] | undefined): AssistantWireMessage | undefined {
	return messages?.find(
		(message): message is AssistantWireMessage =>
			typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant",
	);
}

describe("DeepInfra reasoning wire contract (oh-my-pi#9522)", () => {
	it("resolves the DeepSeek replay contract on the deepinfra host", () => {
		const compat = deepinfraDeepseekModel().compat;
		// Plain OpenAI dialect — the server owns DeepSeek-specific encoding.
		expect(compat.thinkingFormat).toBe("openai");
		expect(compat.supportsReasoningEffort).toBe(true);
		// Tool-turn replay is the load-bearing client behavior; synthetic
		// placeholders are rejected upstream.
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(compat.reasoningContentField).toBe("reasoning_content");
	});

	it("carries the contract on the bundled slice that seeds dynamic discovery", () => {
		// `mapDeepinfraModel` spreads the bundled reference (baked compat
		// included) into every discovered spec, so the generated slice must
		// agree with the live resolver — a stale bake here would override the
		// host detection at runtime.
		const bundled = getBundledModel<"openai-completions">("deepinfra", "deepseek-ai/DeepSeek-V4-Flash-0731");
		expect(bundled.compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(bundled.compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(bundled.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	it("resolves DeepSeek's wire-exact low/high/max tiers through the compat engine", () => {
		const model = deepinfraDeepseekModel();
		// V4 Flash's real tiers are low/high (default thinking mode) and max
		// (max-effort mode). The wire literals pass through unmapped —
		// DeepInfra accepts them verbatim (`max` aliases `xhigh`).
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
	});

	it("gates thinking on via bare reasoning_effort with no DeepSeek-dialect fields", async () => {
		const { url, payload } = await captureRequestPayload(deepinfraDeepseekModel(), { reasoning: "high" });
		// The captured accepted request: POST /v1/openai/chat/completions with
		// messages + reasoning_effort only.
		expect(url).toBe(`${DEEPINFRA_BASE_URL}/chat/completions`);
		expect(payload.reasoning_effort).toBe("high");
		// No alternate thinking dialects may leak onto the wire.
		expect(payload.thinking).toBeUndefined();
		expect(payload.reasoning).toBeUndefined();
		expect(payload.enable_thinking).toBeUndefined();
		expect(payload.chat_template_kwargs).toBeUndefined();
	});

	it("sends the max-effort tier as the literal `max`", async () => {
		const { payload } = await captureRequestPayload(deepinfraDeepseekModel(), { reasoning: "max" });
		expect(payload.reasoning_effort).toBe("max");
	});

	it("omits reasoning_effort entirely when no effort is requested (off is the model default)", async () => {
		const { payload } = await captureRequestPayload(deepinfraDeepseekModel(), {});
		expect(payload.reasoning_effort).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
		expect(payload.reasoning).toBeUndefined();
	});

	it("parses streamed delta.reasoning_content into a thinking block ahead of content", async () => {
		const model = deepinfraDeepseekModel();
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				createSseResponse([
					// Captured response shape, thinking on: reasoning_content
					// streams first, content carries only the final answer.
					deltaChunk(model, { reasoning_content: '1. The user asks "What is 2+2?"' }),
					deltaChunk(model, { reasoning_content: " Trivial arithmetic." }),
					deltaChunk(model, { content: "4" }),
					finishChunk(model),
					"[DONE]",
				]),
			{ preconnect: fetch.preconnect },
		);
		const result = await streamOpenAICompletions(model, capturedUserTurn, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: '1. The user asks "What is 2+2?" Trivial arithmetic.',
				thinkingSignature: "reasoning_content",
			},
			{ type: "text", text: "4" },
		]);
	});

	it("replays reasoning_content verbatim on assistant tool-call turns", () => {
		const model = deepinfraDeepseekModel();
		const turn = assistantTurn(model, [
			{
				type: "thinking",
				thinking: "I should read the file before answering.",
				thinkingSignature: "reasoning_content",
			} as ThinkingContent,
			{
				type: "toolCall",
				id: "call_deepinfra_replay",
				name: "read",
				arguments: { path: "README.md" },
			} as ToolCall,
		]);
		const messages = convertMessages(model, { messages: [turn] }, model.compat);
		const assistant = findAssistantWireMessage(messages);
		expect(assistant).toBeDefined();
		expect(assistant?.reasoning_content).toBe("I should read the file before answering.");
	});

	it("falls back to empty-string reasoning_content on tool-call turns, never the synthetic placeholder", () => {
		const model = deepinfraDeepseekModel();
		const turn = assistantTurn(model, [
			{
				type: "toolCall",
				id: "call_deepinfra_stripped",
				name: "read",
				arguments: { path: "README.md" },
			} as ToolCall,
		]);
		const messages = convertMessages(model, { messages: [turn] }, model.compat);
		const assistant = findAssistantWireMessage(messages);
		expect(assistant).toBeDefined();
		expect(assistant?.reasoning_content).toBe("");
	});
});
