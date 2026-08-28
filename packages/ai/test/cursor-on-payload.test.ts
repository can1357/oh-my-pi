// Regression: cursor ignored the onPayload replacement return value
// (fire-and-forget), so the hook could never change the request actually sent
// upstream. The replacement contract matches anthropic / openai-responses /
// google: await the hook and use its non-undefined return as the request.
// buildGrpcRequest is exercised directly (the transport is HTTP/2), and the
// serialized run request is decoded back from the wire bytes.
import { describe, expect, it } from "bun:test";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const model: Model<"cursor-agent"> = buildModel({
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function decodeRunRequest(requestBytes: Uint8Array): { case: string; value: Record<string, any> } {
	const decoded = fromBinary(AgentClientMessageSchema, requestBytes);
	return decoded.message as unknown as { case: string; value: Record<string, any> };
}

describe("cursor onPayload replacement", () => {
	it("sends an async onPayload replacement body", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{
				onPayload: async payload => ({
					...(payload as Record<string, unknown>),
					customSystemPrompt: "replacement",
				}),
			},
			{ conversationId: "conv-1", blobStore: new Map() },
		);

		const message = decodeRunRequest(requestBytes);
		expect(message.case).toBe("runRequest");
		expect(message.value.customSystemPrompt).toBe("replacement");
	});

	it("keeps the original body when onPayload returns undefined", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{ onPayload: async () => undefined },
			{ conversationId: "conv-1", blobStore: new Map() },
		);

		const message = decodeRunRequest(requestBytes);
		expect(message.case).toBe("runRequest");
		expect(message.value.customSystemPrompt).toBeUndefined();
	});

	it("applies customSystemPrompt when onPayload returns undefined", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{ customSystemPrompt: "from-options", onPayload: async () => undefined },
			{ conversationId: "conv-1", blobStore: new Map() },
		);

		const message = decodeRunRequest(requestBytes);
		expect(message.value.customSystemPrompt).toBe("from-options");
	});

	it("lets the onPayload replacement drop customSystemPrompt (replacement is final)", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{
				customSystemPrompt: "from-options",
				onPayload: async payload => {
					const { customSystemPrompt: _dropped, ...rest } = payload as Record<string, unknown>;
					return rest;
				},
			},
			{ conversationId: "conv-1", blobStore: new Map() },
		);

		const message = decodeRunRequest(requestBytes);
		// The hook saw customSystemPrompt already applied (set before the hook) and
		// returned a replacement that does not carry it — that replacement is final.
		expect(message.value.customSystemPrompt).toBeUndefined();
	});

	it("lets the onPayload replacement override customSystemPrompt", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{
				customSystemPrompt: "from-options",
				onPayload: async payload => ({
					...(payload as Record<string, unknown>),
					customSystemPrompt: "from-hook",
				}),
			},
			{ conversationId: "conv-1", blobStore: new Map() },
		);

		const message = decodeRunRequest(requestBytes);
		expect(message.value.customSystemPrompt).toBe("from-hook");
	});
});
