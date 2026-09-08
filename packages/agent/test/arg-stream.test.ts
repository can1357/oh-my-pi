import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function createStreamingTool(callbacks: {
	pushes: string[];
	ends: unknown[];
	cancelled: { count: number };
}): AgentTool {
	return {
		name: "streaming-tool",
		label: "Streaming tool",
		description: "Streams its arguments",
		parameters: type({ value: "string" }),
		openArgStream(init) {
			return {
				push(delta) {
					callbacks.pushes.push(delta);
					init.emit({ delta });
				},
				end(args) {
					callbacks.ends.push(args);
				},
				cancel() {
					callbacks.cancelled.count++;
				},
			};
		},
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

describe("streamed tool arguments", () => {
	it("forwards deltas, final arguments, and projected updates", async () => {
		const callbacks = { pushes: [] as string[], ends: [] as unknown[], cancelled: { count: 0 } };
		const tool = createStreamingTool(callbacks);
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({ responses: [{ content: ["finished"] }] });
		let calls = 0;
		const streamFn: typeof mock.stream = (model, callContext, options) => {
			if (calls++ > 0) return mock.stream(model, callContext, options);
			const response = new AssistantMessageEventStream();
			const toolCall = {
				type: "toolCall" as const,
				id: "call-1",
				name: tool.name,
				arguments: { value: "hello" },
			};
			const partial = createAssistantMessage([toolCall], "toolUse");
			response.push({ type: "start", partial });
			response.push({ type: "toolcall_start", contentIndex: 0, partial });
			for (const delta of ['{"value":', '"hello"', "}"]) {
				response.push({ type: "toolcall_delta", contentIndex: 0, delta, partial });
			}
			response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
			response.push({ type: "done", reason: "toolUse", message: partial });
			return response;
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const events: AgentEvent[] = [];
		const run = agentLoop([createUserMessage("run")], context, config, undefined, streamFn);
		for await (const event of run) events.push(event);
		await run.result();

		expect(callbacks.pushes).toEqual(['{"value":', '"hello"', "}"]);
		expect(callbacks.ends).toEqual([{ value: "hello" }]);
		expect(callbacks.cancelled.count).toBe(0);
		expect(events.filter(event => event.type === "tool_stream_update")).toEqual([
			{ type: "tool_stream_update", toolCallId: "call-1", toolName: tool.name, update: { delta: '{"value":' } },
			{ type: "tool_stream_update", toolCallId: "call-1", toolName: tool.name, update: { delta: '"hello"' } },
			{ type: "tool_stream_update", toolCallId: "call-1", toolName: tool.name, update: { delta: "}" } },
		]);
	});

	it("cancels an unfinished receiver exactly once on a stream error", async () => {
		const callbacks = { pushes: [] as string[], ends: [] as unknown[], cancelled: { count: 0 } };
		const tool = createStreamingTool(callbacks);
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel();
		const streamFn: typeof mock.stream = () => {
			const response = new AssistantMessageEventStream();
			const toolCall = { type: "toolCall" as const, id: "call-error", name: tool.name, arguments: {} };
			const partial: AssistantMessage = {
				...createAssistantMessage([toolCall], "error"),
				errorMessage: "provider failed",
			};
			response.push({ type: "start", partial });
			response.push({ type: "toolcall_start", contentIndex: 0, partial });
			response.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"half', partial });
			response.push({ type: "error", reason: "error", error: partial });
			return response;
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const run = agentLoop([createUserMessage("run")], context, config, undefined, streamFn);
		for await (const _event of run) {
			// Drain the event stream.
		}
		await run.result();

		expect(callbacks.pushes).toEqual(['{"value":"half']);
		expect(callbacks.ends).toEqual([]);
		expect(callbacks.cancelled.count).toBe(1);
	});
});
