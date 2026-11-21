// Regression: a ConverseStream body that ends before `messageStop` (connection
// dropped or a gateway closing mid-generation at a frame boundary) finished as a
// successful `stop`, so the agent ended the turn on a cut-off reply instead of
// retrying it.
import { describe, expect, it } from "bun:test";
import { retriable } from "@oh-my-pi/pi-ai/error";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { BEDROCK_TEST_CONTEXT, bedrockEvent, bedrockTestModel } from "./helpers/bedrock-stream";

async function run(frames: Uint8Array[]): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const stream = streamBedrock(bedrockTestModel(), BEDROCK_TEST_CONTEXT, {
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
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

describe("bedrock stream cut off before messageStop", () => {
	it("fails the turn as a retryable incomplete stream and never finalizes the cut-off tool call", async () => {
		const { events, result } = await run([
			bedrockEvent("messageStart", JSON.stringify({ role: "assistant" })),
			bedrockEvent(
				"contentBlockDelta",
				JSON.stringify({ contentBlockIndex: 0, delta: { text: "Writing it now." } }),
			),
			bedrockEvent("contentBlockStop", JSON.stringify({ contentBlockIndex: 0 })),
			bedrockEvent(
				"contentBlockStart",
				JSON.stringify({ contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "write" } } }),
			),
			bedrockEvent(
				"contentBlockDelta",
				JSON.stringify({ contentBlockIndex: 1, delta: { toolUse: { input: '{"path":"a.txt","content":"hel' } } }),
			),
		]);

		expect(events.some(event => event.type === "done")).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorId !== undefined && retriable(result.errorId)).toBe(true);
		// Turn recovery continues a reply that already rendered only for this premature-close wording.
		expect(result.errorMessage).toMatch(/stream closed before a terminal response event/);
		// The agent dispatches only calls that reached `toolcall_end`.
		expect(events.some(event => event.type === "toolcall_end")).toBe(false);
	});

	it("keeps a stream that reached messageStop without the trailing metadata event", async () => {
		const { result } = await run([
			bedrockEvent("messageStart", JSON.stringify({ role: "assistant" })),
			bedrockEvent("contentBlockDelta", JSON.stringify({ contentBlockIndex: 0, delta: { text: "Done." } })),
			bedrockEvent("contentBlockStop", JSON.stringify({ contentBlockIndex: 0 })),
			bedrockEvent("messageStop", JSON.stringify({ stopReason: "end_turn" })),
		]);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "Done." }]);
	});
});
