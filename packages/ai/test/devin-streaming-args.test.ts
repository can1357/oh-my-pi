import { describe, expect, it } from "bun:test";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	ChatToolCallSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
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

function toolCallDelta(argumentsJson: string, stopReason = StopReason.UNSPECIFIED): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, {
		messageId: "msg-1",
		stopReason,
		deltaToolCalls: [create(ChatToolCallSchema, { id: "call-1", name: "task", argumentsJson })],
	});
	return frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg));
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

const context: Context = { messages: [{ role: "user", content: "call tool", timestamp: 1 }] };

describe("streamDevin args streaming", () => {
	it("throttles tiny mid-stream arg reparses but flushes final args", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const chunks = [
			toolCallDelta(`{"agent":"task","note":"initial"`),
			toolCallDelta(`{"agent":"task","note":"initial","step":1`),
			toolCallDelta(`{"agent":"task","note":"initial","step":12`, StopReason.FUNCTION_CALL),
		];
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) return new Response(authPayload);
			let index = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						await Bun.sleep(1);
						const chunk = chunks[index++];
						if (chunk) controller.enqueue(chunk);
						else controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		const snapshots: unknown[] = [];
		for await (const event of stream) {
			if (event.type === "toolcall_delta") {
				const block = event.partial.content.find(item => item.type === "toolCall") as ToolCall | undefined;
				snapshots.push(block?.arguments);
			}
		}
		const result = await stream.result();

		expect(snapshots[0]).toEqual({ agent: "task", note: "initial" });
		expect(snapshots[1]).toBe(snapshots[0]);
		expect(snapshots[2]).toBe(snapshots[0]);
		expect(result.content[0]?.type).toBe("toolCall");
		expect((result.content[0] as ToolCall).arguments).toEqual({ agent: "task", note: "initial", step: 12 });
	});
});
