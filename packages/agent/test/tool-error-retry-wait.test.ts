import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { assistantTurnError, type Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

const failSchema = type({ value: type("string") });

/** The text of the tool result the model is shown for a tool that throws `error`. */
async function toolResultTextFor(error: Error): Promise<string> {
	const mock = createMockModel({
		id: "mock-model",
		provider: "mock-provider",
		responses: [
			{ content: [{ type: "toolCall", id: "tc-1", name: "fail", arguments: { value: "x" } }] },
			{ content: ["done"] },
		],
	});
	const failTool: AgentTool<typeof failSchema> = {
		name: "fail",
		label: "Fail",
		description: "throws",
		parameters: failSchema,
		execute: async () => {
			throw error;
		},
	};
	const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [failTool] };
	const stream = agentLoop(
		[createUserMessage("hi")],
		ctx,
		{
			model: mock.model,
			convertToLlm: (messages: AgentMessage[]) =>
				messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[],
		},
		undefined,
		mock.stream,
	);
	let text: string | undefined;
	for await (const event of stream) {
		if (event.type !== "message_end" || event.message.role !== "toolResult") continue;
		const block = event.message.content[0];
		if (block?.type === "text") text ??= block.text;
	}
	if (text === undefined) throw new Error("Expected a tool result message");
	return text;
}

describe("a tool error shown to the model", () => {
	it("renders the server's wait that a failed turn's error carries", async () => {
		const text = await toolResultTextFor(
			assistantTurnError({ errorMessage: "429 rate_limit_error", errorRetryAfterMs: 30_000 }),
		);
		expect(text).toBe("429 rate_limit_error (retry after 30.0s)");
	});

	it("adds no wait for a plain error, even when its text names one", async () => {
		const text = await toolResultTextFor(new Error("429 rate_limit_error retry-after-ms=9000"));
		expect(text).toBe("429 rate_limit_error retry-after-ms=9000");
	});
});
