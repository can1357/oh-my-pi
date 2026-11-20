import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { AssistantMessage, Context, Model, StreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	ChatToolCallSchema,
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	type GetChatMessageResponse,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "devin-agent",
		provider: "devin",
		model: "devin-test",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

async function captureRequest(context: Context, onPayload?: StreamOptions["onPayload"]) {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	let requestPayload: Uint8Array | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		requestPayload = new Uint8Array(init?.body as ArrayBuffer);
		return new Response(new Uint8Array());
	}) as typeof fetch;

	await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl, onPayload }).result();
	if (!requestPayload) throw new Error("Devin chat request was not captured");
	const length = new DataView(requestPayload.buffer, requestPayload.byteOffset, requestPayload.byteLength).getUint32(
		1,
		false,
	);
	const message = requestPayload.subarray(5, 5 + length);
	return fromBinary(GetChatMessageRequestSchema, requestPayload[0] & 0x01 ? gunzipSync(message) : message);
}

/** Stream one Devin reply made of `frames` and return the finished assistant turn. */
async function streamReply(context: Context, frames: Partial<GetChatMessageResponse>[]) {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	const body = frames.map(fields => {
		const payload = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, fields));
		const frame = new Uint8Array(5 + payload.length);
		new DataView(frame.buffer).setUint32(1, payload.length, false);
		frame.set(payload, 5);
		return frame;
	});
	const fetchImpl = (async (input: string | URL | Request) =>
		new Response(String(input).includes("GetUserJwt") ? authPayload : new Blob(body))) as typeof fetch;
	return streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();
}

describe("streamDevin history handoff", () => {
	it("removes foreign provider metadata and empty aborted turns", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "start", timestamp: 1 },
				assistant({
					api: "openai-responses",
					provider: "openai-codex",
					model: "gpt-5.6-sol",
					responseId: "resp_foreign",
					content: [
						{ type: "thinking", thinking: "foreign reasoning", thinkingSignature: '{"type":"reasoning"}' },
						{ type: "text", text: "foreign answer" },
					],
				}),
				{ role: "user", content: "continue", timestamp: 2 },
				assistant({
					responseId: "bot-12345678-1234-4234-8234-123456789abc",
					content: [{ type: "thinking", thinking: "native reasoning", thinkingSignature: "native-signature" }],
				}),
				{ role: "user", content: "interrupt", timestamp: 3 },
				assistant({
					api: "openai-responses",
					provider: "openai-codex",
					model: "gpt-5.6-sol",
					stopReason: "aborted",
				}),
				{ role: "user", content: "resume", timestamp: 4 },
			],
		};

		const request = await captureRequest(context);
		const foreign = request.chatMessagePrompts[1];
		const native = request.chatMessagePrompts[3];

		expect(request.chatMessagePrompts).toHaveLength(6);
		expect(foreign?.messageId).not.toBe("resp_foreign");
		// Replayed assistant rows use bare UUIDs, as the native CLI sends them.
		expect(foreign?.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(foreign?.prompt).toContain("foreign reasoning");
		expect(foreign?.prompt).toContain("foreign answer");
		expect(foreign?.thinking).toBe("");
		expect(foreign?.signature).toBe("");
		expect(native?.messageId).toBe("bot-12345678-1234-4234-8234-123456789abc");
		expect(native?.thinking).toBe("native reasoning");
		expect(native?.signature).toBe("native-signature");
	});

	it.each([`call_${"a".repeat(32)}`, `call_${"a".repeat(80)}`])(
		"replays foreign Responses composite tool-call ids as capped call ids paired with their results: %s",
		async callId => {
			const compositeId = `${callId}|fc_${"b".repeat(50)}`;
			const request = await captureRequest({
				messages: [
					{ role: "user", content: "start", timestamp: 1 },
					assistant({
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: compositeId, name: "read", arguments: { path: "a.ts" } }],
					}),
					{
						role: "toolResult",
						toolCallId: compositeId,
						toolName: "read",
						content: [{ type: "text", text: "contents" }],
						isError: false,
						timestamp: 2,
					},
					{ role: "user", content: "continue", timestamp: 3 },
				],
			});

			const [, call, result] = request.chatMessagePrompts;
			expect(call?.toolCalls.map(toolCall => toolCall.id)).toEqual([callId.slice(0, 40)]);
			expect(result?.toolCallId).toBe(callId.slice(0, 40));
		},
	);

	it("keeps distinct opaque pipe-bearing ids from non-Responses sources paired with their own results", async () => {
		const request = await captureRequest({
			messages: [
				{ role: "user", content: "start", timestamp: 1 },
				assistant({
					api: "openai-completions",
					provider: "openrouter",
					model: "some-model",
					stopReason: "toolUse",
					content: [
						{ type: "toolCall", id: "call_A|first", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "call_A|second", name: "read", arguments: { path: "b.ts" } },
					],
				}),
				{
					role: "toolResult",
					toolCallId: "call_A|second",
					toolName: "read",
					content: [{ type: "text", text: "second contents" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "continue", timestamp: 3 },
			],
		});

		const call = request.chatMessagePrompts[1];
		const results = request.chatMessagePrompts.filter(prompt => prompt.toolCallId);
		const [firstId, secondId] = call?.toolCalls.map(toolCall => toolCall.id) ?? [];
		expect(firstId).not.toBe(secondId);
		expect(results.find(result => result.toolCallId === secondId)?.prompt).toBe("second contents");
		expect(results.find(result => result.toolCallId === firstId)?.prompt).not.toBe("second contents");
	});

	it("accepts a bare-string system prompt", async () => {
		const request = await captureRequest({
			systemPrompt: "You are a test." as unknown as string[],
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		});

		expect(request.prompt).toBe("You are a test.");
	});

	it("passes the chat request through onPayload and sends its replacement", async () => {
		let seenPrompt: string | undefined;
		const request = await captureRequest({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }, payload => {
			const original = payload as GetChatMessageRequest;
			seenPrompt = original.chatMessagePrompts.at(-1)?.prompt;
			return create(GetChatMessageRequestSchema, { ...original, prompt: "replaced" });
		});

		expect(seenPrompt).toBe("hi");
		expect(request.prompt).toBe("replaced");
	});

	it.each<{ name: string; frames: Partial<GetChatMessageResponse>[]; thinking: string }>([
		{
			name: "a tool call signed by signature-only frames",
			frames: [
				{ deltaToolCalls: [create(ChatToolCallSchema, { id: "call_1", name: "read", argumentsJson: "{}" })] },
				{ deltaSignature: "SIG-A" },
				{ deltaSignature: "SIG-B", deltaSignatureType: "gemini" },
			],
			thinking: "",
		},
		{
			name: "thinking whose signature continues past it",
			frames: [
				{ deltaThinking: "plan", deltaSignature: "SIG-A" },
				{ deltaText: "done", deltaSignature: "SIG-B", deltaSignatureType: "gemini" },
			],
			thinking: "plan",
		},
	])("replays the signature of $name with its type and model", async ({ frames, thinking }) => {
		const start = { role: "user" as const, content: "start", timestamp: 1 };
		const reply = await streamReply({ messages: [start] }, frames);
		const request = await captureRequest({
			messages: [start, reply, { role: "user", content: "continue", timestamp: 2 }],
		});

		const replayed = request.chatMessagePrompts[1];
		expect(replayed?.thinking).toBe(thinking);
		expect(replayed?.signature).toBe("SIG-ASIG-B");
		expect(replayed?.signatureType).toBe("gemini");
		expect(replayed?.signatureModelUid).toBe(request.chatModelUid);
	});
});
