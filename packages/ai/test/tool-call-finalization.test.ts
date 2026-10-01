import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamAppleFoundationModels } from "@oh-my-pi/pi-ai/providers/apple-foundation-models";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as natives from "@oh-my-pi/pi-natives";
import { BEDROCK_TEST_CONTEXT, bedrockEvent, bedrockTestModel } from "./helpers/bedrock-stream";

const raw = '{"path":"repaired.txt","content":"hello';
const tool = { name: "write", description: "Write a file", parameters: { type: "object" } };

describe("final JSON tool-call boundaries", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["contentBlockStop", "messageStop", "eof"])("refuses truncated Bedrock input at %s", async finalizer => {
		const frames = [
			bedrockEvent("messageStart", JSON.stringify({ role: "assistant" })),
			bedrockEvent(
				"contentBlockStart",
				JSON.stringify({ contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "write" } } }),
			),
			bedrockEvent(
				"contentBlockDelta",
				JSON.stringify({ contentBlockIndex: 0, delta: { toolUse: { input: raw } } }),
			),
			...(finalizer === "contentBlockStop"
				? [bedrockEvent("contentBlockStop", JSON.stringify({ contentBlockIndex: 0 }))]
				: []),
			...(finalizer !== "eof" ? [bedrockEvent("messageStop", JSON.stringify({ stopReason: "tool_use" }))] : []),
		];
		const result = await streamBedrock(bedrockTestModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "test-token",
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const frame of frames) controller.enqueue(frame);
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
				),
		}).result();
		if (finalizer !== "eof") expect(result.stopReason).toBe("toolUse");
		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("Expected tool call");
		expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
		expect(() => validateToolArguments(tool, call)).toThrow("Tool call arguments are not valid JSON");
	});

	it("refuses truncated Apple Foundation Models arguments when the bridge finishes", async () => {
		vi.spyOn(natives, "appleFmGenerate").mockImplementation((_request, callback) => {
			callback(null, JSON.stringify({ type: "toolCall", callId: "call_1", name: "write", arguments: raw }));
			callback(null, JSON.stringify({ type: "done" }));
			return 1;
		});
		const model = buildModel({
			id: "on-device",
			name: "On-device",
			api: "apple-foundation-models",
			provider: "apple",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const result = await streamAppleFoundationModels(model, BEDROCK_TEST_CONTEXT, {}).result();
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("Expected tool call");
		expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
		expect(() => validateToolArguments(tool, call)).toThrow("Tool call arguments are not valid JSON");
	});
});
