import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, FetchImpl, Message, ModelSpec, ToolCall } from "@oh-my-pi/pi-ai/types";
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
	| { type: "message"; field: "thinking_signature" | "thought_signature" | "reasoning_signature" };

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
	const toolResult: Message = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "README contents" }],
		isError: false,
		timestamp: 2,
	};
	const restoredMessages: Message[] = JSON.parse(JSON.stringify([userMessage, assistant, toolResult]));
	await streamOpenAICompletions(
		model,
		{ messages: restoredMessages },
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
		if (signature.field === "reasoning_signature") {
			expect(replayedAssistant).not.toHaveProperty("thinking_signature");
			expect(replayedAssistant).not.toHaveProperty("thought_signature");
		}
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

	it("replays a signature-only reasoning_signature after restoring tool-call history", async () => {
		await expectThoughtSignatureRoundTrip({ type: "message", field: "reasoning_signature" });
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

// A fallback hop or a model switch inside a tool loop leaves another model's tool calls in the turn
// Gemini continues. transformMessages strips that model's signatures, and Gemini 3+ answers a turn
// of the current exchange whose function calls are all unsigned with 400 "Function call is missing
// a thought_signature".
describe("OpenAI-compatible Gemini replay of unsigned tool calls", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const bypass = { google: { thought_signature: "skip_thought_signature_validator" } };
	const storedSignature = (signature: string) =>
		JSON.stringify({ perCall: { google: { thought_signature: signature } } });
	const call = (id: string, thoughtSignature?: string): ToolCall => ({
		type: "toolCall",
		id,
		name: "read",
		arguments: { path: `${id}.md` },
		...(thoughtSignature ? { thoughtSignature } : {}),
	});
	const turn = (source: Pick<AssistantMessage, "provider" | "api" | "model">, calls: ToolCall[]): Message[] => [
		{ role: "assistant", content: calls, ...source, usage, stopReason: "toolUse", timestamp: 2 },
		...calls.map((c): Message => ({
			role: "toolResult",
			toolCallId: c.id,
			toolName: c.name,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		})),
	];
	const claude = { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" } as const;
	const own = { provider: model.provider, api: model.api, model: model.id };

	// One exchange, four authors: a turn before the latest user message (outside what Gemini
	// validates), then another vendor's model, the same model id on another host, and this model
	// itself (signed first call, unsigned parallel second call, as Gemini emits them).
	const history: Message[] = [
		userMessage,
		...turn(claude, [call("toolu_older")]),
		{ role: "user", content: "Now read CONTRIBUTING.md", timestamp: 4 },
		...turn(claude, [call("toolu_claude_a"), call("toolu_claude_b")]),
		...turn({ provider: "vertex", api: "openai-completions", model: model.id }, [
			call("call_other_host", storedSignature("other-host-sig")),
		]),
		...turn(own, [call("call_own_a", storedSignature("own-sig")), call("call_own_b")]),
	];

	async function replayedToolCalls(
		target: typeof model,
		messages: Message[] = history,
	): Promise<Record<string, unknown>> {
		let payload: unknown;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				if (typeof init?.body === "string") payload = JSON.parse(init.body);
				return sseResponse({ role: "assistant", content: "done" }, "stop");
			},
			{ preconnect: fetch.preconnect },
		);
		await streamOpenAICompletions(target, { messages }, { apiKey: "key", fetch: fetchMock }).result();
		const sent = typeof payload === "object" && payload !== null ? Reflect.get(payload, "messages") : undefined;
		if (!Array.isArray(sent)) throw new Error("request messages missing");
		const byId: Record<string, unknown> = {};
		for (const message of sent) {
			for (const toolCall of Reflect.get(message, "tool_calls") ?? []) {
				byId[Reflect.get(toolCall, "id")] = Reflect.get(toolCall, "extra_content");
			}
		}
		return byId;
	}

	it("marks one call per unsigned turn of the current exchange and keeps every surviving signature", async () => {
		expect(await replayedToolCalls(model)).toEqual({
			toolu_older: undefined,
			toolu_claude_a: bypass,
			toolu_claude_b: undefined,
			call_other_host: bypass,
			call_own_a: { google: { thought_signature: "own-sig" } },
			call_own_b: undefined,
		});
	});

	it("marks the model's own turn when it carries no signature either", async () => {
		expect(
			await replayedToolCalls(model, [userMessage, ...turn(own, [call("call_bare_a"), call("call_bare_b")])]),
		).toEqual({
			call_bare_a: bypass,
			call_bare_b: undefined,
		});
	});

	// The encoder replays a turn's signature from three carriers; a turn that kept any of them is
	// signed already, and sending the bypass value beside it would cost the model that reasoning.
	it("leaves a turn alone when its signature rode a reasoning detail or the message level", async () => {
		const encrypted = JSON.stringify({ perCall: { type: "reasoning.encrypted", data: "real-enc" } });
		const messageLevel = JSON.stringify({ message: { field: "thinking_signature", signature: "real-msg-sig" } });
		expect(await replayedToolCalls(model, [userMessage, ...turn(own, [call("call_enc", encrypted)])])).toEqual({
			call_enc: undefined,
		});
		expect(await replayedToolCalls(model, [userMessage, ...turn(own, [call("call_msg", messageLevel)])])).toEqual({
			call_msg: undefined,
		});
	});

	// The turn boundary is what the request sends as a user message, not what the history holds.
	it("ends the turn at a user message this request actually sends", async () => {
		const unsigned = turn(claude, [call("call_bounded")]);
		// A blank user message is dropped before the wire, so it does not end the turn.
		expect(
			await replayedToolCalls(model, [userMessage, ...unsigned, { role: "user", content: "   ", timestamp: 9 }]),
		).toEqual({ call_bounded: bypass });
		// A developer message rides the user role on a host without one, so it does.
		expect(
			await replayedToolCalls(model, [
				userMessage,
				...unsigned,
				{ role: "developer", content: "note", timestamp: 9 },
			]),
		).toEqual({ call_bounded: undefined });
	});

	it("sends no bypass signature to a model outside the Gemini rule", async () => {
		const other = buildModel({
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-completions",
			provider: "openai-compatible",
			baseUrl: "https://llm.example/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 65_536,
		} satisfies ModelSpec<"openai-completions">);
		expect(Object.values(await replayedToolCalls(other))).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("sends no bypass signature to a Gemini older than the revision the rule covers", async () => {
		const gemini25 = buildModel({
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "openai-completions",
			provider: "gemini",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		} satisfies ModelSpec<"openai-completions">);
		// Every turn of this history is foreign to a 2.5 target, so its signatures are stripped and
		// nothing replaces them: the rule covers revision 3 and newer.
		expect(Object.values(await replayedToolCalls(gemini25))).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});
