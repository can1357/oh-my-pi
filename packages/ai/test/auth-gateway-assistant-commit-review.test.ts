import { expect, it } from "bun:test";
import { observeAssistantCommit, StreamCommitGate } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

function message(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "review",
		model: "review",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function observeOne(event: Parameters<AssistantMessageEventStream["push"]>[0]): Promise<StreamCommitGate> {
	const source = new AssistantMessageEventStream();
	const gate = new StreamCommitGate();
	const observed = observeAssistantCommit(source, gate);
	const iterator = observed[Symbol.asyncIterator]();
	source.push({ type: "start", partial: message() });
	await iterator.next();
	source.push(event);
	await iterator.next();
	return gate;
}

it("commits non-SSE streams only after actual assistant output events", async () => {
	const partial = message();
	const textGate = await observeOne({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
	expect(textGate.state).toBe("committed");

	const thinkingGate = await observeOne({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial });
	expect(thinkingGate.state).toBe("committed");

	const toolGate = await observeOne({
		type: "toolcall_end",
		contentIndex: 0,
		toolCall: { type: "toolCall", id: "call_review", name: "read", arguments: {} },
		partial,
	});
	expect(toolGate.state).toBe("committed");
});
