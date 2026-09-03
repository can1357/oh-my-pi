import { describe, expect, it } from "bun:test";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
	ModelUsageStatsSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

describe("streamDevin usage", () => {
	it("includes cached tokens in totalTokens", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const response = create(GetChatMessageResponseSchema, {
			messageId: "msg-1",
			stopReason: StopReason.STOP_PATTERN,
			usage: create(ModelUsageStatsSchema, {
				inputTokens: 11n,
				outputTokens: 7n,
				cacheReadTokens: 100n,
				cacheWriteTokens: 13n,
			}),
		});
		const responseFrame = frameConnectMessage(toBinary(GetChatMessageResponseSchema, response));
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("GetUserJwt")) return new Response(authPayload);
			return new Response(responseFrame);
		}) as typeof fetch;

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.usage).toMatchObject({
			input: 11,
			output: 7,
			cacheRead: 100,
			cacheWrite: 13,
			totalTokens: 131,
		});
	});
});
