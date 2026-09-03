import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetChatMessageRequestSchema, GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
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

async function captureRequest(context: Context) {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	let requestPayload: Uint8Array | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		requestPayload = new Uint8Array(init?.body as ArrayBuffer);
		return new Response(new Uint8Array());
	}) as typeof fetch;

	await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();
	if (!requestPayload) throw new Error("Devin chat request was not captured");
	const length = new DataView(requestPayload.buffer, requestPayload.byteOffset, requestPayload.byteLength).getUint32(
		1,
		false,
	);
	const compressed = requestPayload.subarray(5, 5 + length);
	return fromBinary(GetChatMessageRequestSchema, gunzipSync(compressed));
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
		expect(foreign?.messageId).toMatch(/^bot-[0-9a-f-]{36}$/);
		expect(foreign?.prompt).toContain("foreign reasoning");
		expect(foreign?.prompt).toContain("foreign answer");
		expect(foreign?.thinking).toBe("");
		expect(foreign?.signature).toBe("");
		expect(native?.messageId).toBe("bot-12345678-1234-4234-8234-123456789abc");
		expect(native?.thinking).toBe("native reasoning");
		expect(native?.signature).toBe("native-signature");
	});

	it("accepts a bare-string system prompt", async () => {
		const request = await captureRequest({
			systemPrompt: "You are a test." as unknown as string[],
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		});

		expect(request.prompt).toBe("You are a test.");
	});
});
