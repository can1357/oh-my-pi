import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { FetchImpl, Message, ModelSpec, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "gemini-3.7-flash",
	name: "Gemini 3.7 Flash",
	api: "openai-completions",
	provider: "gemini",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
} satisfies ModelSpec<"openai-completions">);

const userMessage: Message = {
	role: "user",
	content: "Read README.md",
	timestamp: 1,
};

type SignatureShape =
	| { type: "tool"; namespace: "google" | "vertex" }
	| { type: "message"; field: "thinking_signature" | "thought_signature" };

function sseResponse(delta: Record<string, unknown>, finishReason: "stop" | "tool_calls"): Response {
	const chunks = [
		{
			id: "chatcmpl-gemini",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta }],
		},
		{
			id: "chatcmpl-gemini",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
		},
	];
	const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function createFetch(signature: SignatureShape, payloads: unknown[]): FetchImpl {
	let requestIndex = 0;
	async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
		if (requestIndex++ === 0) {
			const toolCall: Record<string, unknown> = {
				index: 0,
				id: "call_1",
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
			};
			const delta: Record<string, unknown> = { role: "assistant", tool_calls: [toolCall] };
			if (signature.type === "tool") {
				toolCall.extra_content = {
					[signature.namespace]: { thought_signature: "opaque-signature" },
				};
			} else {
				delta[signature.field] = "opaque-signature";
			}
			return sseResponse(delta, "tool_calls");
		}
		return sseResponse({ role: "assistant", content: "done" }, "stop");
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function findToolCall(messages: Message[]): ToolCall {
	const assistant = messages.find(message => message.role === "assistant");
	const toolCall = assistant?.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("streamed tool call missing");
	return toolCall;
}

async function expectThoughtSignatureRoundTrip(signature: SignatureShape): Promise<void> {
	const payloads: unknown[] = [];
	const fetchMock = createFetch(signature, payloads);
	const assistant = await streamOpenAICompletions(
		model,
		{ messages: [userMessage] },
		{ apiKey: "test-key", fetch: fetchMock },
	).result();
	const toolCall = findToolCall([assistant]);
	const capturedSignature =
		signature.type === "tool"
			? JSON.stringify({ perCall: { [signature.namespace]: { thought_signature: "opaque-signature" } } })
			: JSON.stringify({ message: { [signature.field]: "opaque-signature" } });

	expect(toolCall.thoughtSignature).toBe(capturedSignature);

	const toolResult: Message = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "README contents" }],
		isError: false,
		timestamp: 2,
	};
	await streamOpenAICompletions(
		model,
		{ messages: [userMessage, assistant, toolResult] },
		{ apiKey: "test-key", fetch: fetchMock },
	).result();

	const replayPayload = payloads[1];
	if (typeof replayPayload !== "object" || replayPayload === null) {
		throw new Error("continuation payload missing");
	}
	const replayMessages = Reflect.get(replayPayload, "messages");
	if (!Array.isArray(replayMessages)) throw new Error("continuation messages missing");
	const replayedAssistant = replayMessages.find(
		message => typeof message === "object" && message !== null && Reflect.get(message, "role") === "assistant",
	);
	if (typeof replayedAssistant !== "object" || replayedAssistant === null) {
		throw new Error("replayed assistant message missing");
	}
	if (signature.type === "tool") {
		expect(replayedAssistant).toMatchObject({
			role: "assistant",
			tool_calls: [
				{
					id: "call_1",
					extra_content: {
						[signature.namespace]: { thought_signature: "opaque-signature" },
					},
				},
			],
		});
	} else {
		expect(Reflect.get(replayedAssistant, signature.field)).toBe("opaque-signature");
	}
}

describe("OpenAI-compatible Gemini thought signatures", () => {
	it("round-trips the google signature namespace", async () => {
		await expectThoughtSignatureRoundTrip({ type: "tool", namespace: "google" });
	});

	it("round-trips the vertex signature namespace", async () => {
		await expectThoughtSignatureRoundTrip({ type: "tool", namespace: "vertex" });
	});

	it("round-trips a message-level thinking_signature", async () => {
		await expectThoughtSignatureRoundTrip({ type: "message", field: "thinking_signature" });
	});

	it("round-trips a message-level thought_signature alias", async () => {
		await expectThoughtSignatureRoundTrip({ type: "message", field: "thought_signature" });
	});

	it("preserves both extra_content and a message-level signature together", async () => {
		const payloads: unknown[] = [];
		let requestIndex = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
				if (requestIndex++ === 0) {
					return sseResponse(
						{
							role: "assistant",
							thinking_signature: "message-sig",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"path":"README.md"}' },
									extra_content: { google: { thought_signature: "per-call-sig" } },
								},
							],
						},
						"tool_calls",
					);
				}
				return sseResponse({ role: "assistant", content: "done" }, "stop");
			},
			{ preconnect: fetch.preconnect },
		);

		const assistant = await streamOpenAICompletions(
			model,
			{ messages: [userMessage] },
			{ apiKey: "test-key", fetch: fetchMock },
		).result();
		const toolCall = findToolCall([assistant]);
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "README contents" }],
			isError: false,
			timestamp: 2,
		};
		await streamOpenAICompletions(
			model,
			{ messages: [userMessage, assistant, toolResult] },
			{ apiKey: "test-key", fetch: fetchMock },
		).result();

		const replayPayload = payloads[1];
		if (typeof replayPayload !== "object" || replayPayload === null) {
			throw new Error("continuation payload missing");
		}
		const replayMessages = Reflect.get(replayPayload, "messages");
		if (!Array.isArray(replayMessages)) throw new Error("continuation messages missing");
		const replayedAssistant = replayMessages.find(
			message => typeof message === "object" && message !== null && Reflect.get(message, "role") === "assistant",
		);
		if (typeof replayedAssistant !== "object" || replayedAssistant === null) {
			throw new Error("replayed assistant message missing");
		}
		expect(replayedAssistant).toMatchObject({
			role: "assistant",
			thinking_signature: "message-sig",
			tool_calls: [{ id: "call_1", extra_content: { google: { thought_signature: "per-call-sig" } } }],
		});
	});
});
