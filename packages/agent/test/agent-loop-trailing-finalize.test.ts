/**
 * Regression tests for issue #12543.
 *
 * When the provider event iterator completes without ever yielding a
 * `done`/`error` event, `streamAssistantResponse` finalizes via the trailing
 * path. With zero events received (`addedPartial === false`), the trailing
 * message must still be appended to `context.messages` and announced with
 * `message_start`/`message_end` — symmetric with the done/error-event path.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** A provider stream that ends immediately: zero events, but result() resolves. */
function makeZeroEventStreamFn(trailing: AssistantMessage) {
	return (): AssistantMessageEventStream => {
		return {
			result: async () => trailing,
			[Symbol.asyncIterator]: () => ({
				next: async (): Promise<IteratorResult<AssistantMessageEvent>> => ({ done: true, value: undefined }),
			}),
		} as AssistantMessageEventStream;
	};
}

describe("trailing finalization without done/error events (#12543)", () => {
	it("emits message_start and message_end for a zero-event trailing turn", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const trailing = createAssistantMessage([{ type: "text", text: "final answer" }], "stop");
		const config: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("hello")],
			context,
			config,
			undefined,
			makeZeroEventStreamFn(trailing) as never,
		);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// The caller still receives the trailing message.
		expect(messages.some(m => m.role === "assistant")).toBe(true);

		// Subscribers must see the full lifecycle for that turn.
		const assistantStart = events.find(
			e => e.type === "message_start" && (e.message as AssistantMessage).role === "assistant",
		);
		const assistantEnd = events.find(
			e => e.type === "message_end" && (e.message as AssistantMessage).role === "assistant",
		);
		expect(assistantStart).toBeDefined();
		expect(assistantEnd).toBeDefined();
	});

	it("keeps the zero-event trailing turn in the provider-replay context", async () => {
		const toolSchema = type({});
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema> = {
			name: "ping",
			label: "Ping",
			description: "Records the replayed history",
			parameters: toolSchema,
			async execute(toolCallId) {
				executed.push(toolCallId);
				return { content: [{ type: "text", text: "pong" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };

		const trailing = createAssistantMessage(
			[{ type: "toolCall", id: "call-1", name: "ping", arguments: {} }],
			"toolUse",
		);

		// Capture the wire history each provider call receives.
		const seenContexts: Context[] = [];
		let calls = 0;
		const streamFn = (_model: unknown, llmContext: Context): AssistantMessageEventStream => {
			calls += 1;
			seenContexts.push(llmContext);
			if (calls === 1) {
				return {
					result: async () => trailing,
					[Symbol.asyncIterator]: () => ({
						next: async (): Promise<IteratorResult<AssistantMessageEvent>> => ({ done: true, value: undefined }),
					}),
				} as AssistantMessageEventStream;
			}
			// Second call: a normal done-event turn that ends the loop.
			const finalMessage = createAssistantMessage([{ type: "text", text: "wrapped up" }], "stop");
			return {
				result: async () => finalMessage,
				[Symbol.asyncIterator]: () => {
					let yielded = false;
					return {
						next: async (): Promise<IteratorResult<AssistantMessageEvent>> => {
							if (!yielded) {
								yielded = true;
								return { done: false, value: { type: "done", reason: "stop", message: finalMessage } };
							}
							return { done: true, value: undefined };
						},
					};
				},
			} as AssistantMessageEventStream;
		};

		const config: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
		};
		const stream = agentLoop([createUserMessage("run the tool")], context, config, undefined, streamFn as never);
		for await (const _event of stream) {
			// drain
		}
		await stream.result();

		expect(executed).toEqual(["call-1"]);
		expect(calls).toBe(2);

		// The second provider call replays history that must include the
		// assistant toolUse turn before its tool result — otherwise the
		// tool_use/tool_result pairing is broken for the next request.
		const replayRoles = seenContexts[1]!.messages.map(m => m.role);
		const toolResultIndex = replayRoles.indexOf("toolResult" as never);
		expect(toolResultIndex).toBeGreaterThan(-1);
		const assistantBeforeToolResult = seenContexts[1]!.messages
			.slice(0, toolResultIndex === -1 ? undefined : toolResultIndex)
			.some(m => m.role === "assistant");
		expect(assistantBeforeToolResult).toBe(true);
	});
});
