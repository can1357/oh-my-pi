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
import { assistantMessageIdentity } from "@oh-my-pi/pi-agent-core/types";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Context, Message } from "@oh-my-pi/pi-ai";
import { wrapInbandToolStream } from "@oh-my-pi/pi-ai/dialect/owned-stream";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage, createHarmonyMitigationModel, createUserMessage } from "./helpers";

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

describe("trailing finalization of a transient stream error after completed tool calls", () => {
	const STREAM_READ_ERROR = "Error Code stream_read_error: stream_read_error";

	function createPingHarness() {
		const toolSchema = type({});
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema> = {
			name: "ping",
			label: "Ping",
			description: "Records executed tool calls",
			parameters: toolSchema,
			async execute(toolCallId) {
				executed.push(toolCallId);
				return { content: [{ type: "text", text: "pong" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		return { context, executed };
	}

	/**
	 * First call streams `ping` tool calls, then settles the stream via
	 * `end(result)` with a transient stream-read error and no terminal
	 * `done`/`error` event. Calls listed in `unfinished` get `toolcall_start`
	 * but never `toolcall_end`. The second call ends the loop normally.
	 */
	function makeResultOnlyErrorStreamFn(finished: string[], unfinished: string[] = []) {
		let calls = 0;
		const streamFn = (): AssistantMessageEventStream => {
			calls += 1;
			const stream = new AssistantMessageEventStream();
			if (calls > 1) {
				const finalMessage = createAssistantMessage([{ type: "text", text: "wrapped up" }], "stop");
				stream.push({ type: "start", partial: finalMessage });
				stream.push({ type: "done", reason: "stop", message: finalMessage });
				return stream;
			}
			const output = createAssistantMessage([], "toolUse");
			stream.push({ type: "start", partial: output });
			for (const id of [...finished, ...unfinished]) {
				const toolCall = { type: "toolCall" as const, id, name: "ping", arguments: {} };
				output.content.push(toolCall);
				const contentIndex = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				if (finished.includes(id)) stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
			output.stopReason = "error";
			output.errorMessage = STREAM_READ_ERROR;
			stream.end(output);
			return stream;
		};
		return { streamFn, callCount: () => calls };
	}

	async function runLoop(context: AgentContext, streamFn: () => AssistantMessageEventStream) {
		const config: AgentLoopConfig = {
			model: createMockModel({ responses: [] }).model,
			convertToLlm: identityConverter,
		};
		const stream = agentLoop([createUserMessage("run the tool")], context, config, undefined, streamFn as never);
		for await (const _event of stream) {
			// drain
		}
		return stream.result();
	}

	it("dispatches completed tool calls like the done/error-event path", async () => {
		const { context, executed } = createPingHarness();
		const provider = makeResultOnlyErrorStreamFn(["call-1"]);

		const messages = await runLoop(context, provider.streamFn);

		expect(executed).toEqual(["call-1"]);
		expect(provider.callCount()).toBe(2);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const recoveredTurn = messages[1] as AssistantMessage;
		expect(recoveredTurn.stopReason).toBe("toolUse");
		expect(recoveredTurn.errorMessage).toBeUndefined();
		expect(recoveredTurn.stopDetails?.type).toBe("stream_interrupted_after_content");
	});

	it("drops a tool call that never finished streaming instead of dispatching it", async () => {
		const { context, executed } = createPingHarness();
		const provider = makeResultOnlyErrorStreamFn(["call-1"], ["call-2"]);

		const messages = await runLoop(context, provider.streamFn);

		expect(executed).toEqual(["call-1"]);
		const recoveredTurn = messages[1] as AssistantMessage;
		expect(recoveredTurn.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual([
			"call-1",
		]);
	});
});

for (const trailing of [false, true]) {
	it(`keeps detached-final identity across ${trailing ? "trailing" : "normal"} finalization but not discarded attempts`, async () => {
		let attempts = 0;
		const streamFn = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			const partial = createAssistantMessage([]);
			const final = createAssistantMessage([
				{
					type: "text",
					text:
						++attempts === 1
							? "Some prose. analysis to=functions.edit code " + "\u0e48\u0e32\u0e31\u0e49"
							: "clean reply",
				},
			]);
			stream.push({ type: "start", partial });
			if (trailing) stream.end(final);
			else stream.push({ type: "done", reason: "stop", message: final });
			return stream;
		};
		const starts: AssistantMessage[] = [];
		const ends: AssistantMessage[] = [];
		const stream = agentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: [""], messages: [], tools: [] },
			{ model: createHarmonyMitigationModel(), convertToLlm: identityConverter },
			undefined,
			streamFn,
		);
		for await (const event of stream) {
			if (event.type === "message_start" && event.message.role === "assistant") starts.push(event.message);
			if (event.type === "message_end" && event.message.role === "assistant") ends.push(event.message);
		}
		expect(attempts).toBe(2);
		expect(starts).toHaveLength(2);
		expect(ends).toHaveLength(2);
		expect(ends[0]!.stopReason).toBe("error");
		expect(ends[1]!.content).toEqual([{ type: "text", text: "clean reply" }]);
		expect(assistantMessageIdentity(starts[0]!)).not.toBe(assistantMessageIdentity(starts[1]!));
		expect(assistantMessageIdentity(ends[0]!)).not.toBe(assistantMessageIdentity(ends[1]!));
		expect(starts.map(assistantMessageIdentity)).toEqual(ends.map(assistantMessageIdentity));
	});
}

const restartSettlements: AssistantMessage["stopReason"][] = ["stop", "error", "aborted"];
for (const settlement of restartSettlements) {
	it(`keeps repeated-start identity through real inband ${settlement} settlement`, async () => {
		const controller = new AbortController();
		const inner = new AssistantMessageEventStream();
		const partial = createAssistantMessage([]);
		inner.push({ type: "start", partial });
		inner.push({ type: "start", partial });
		if (settlement !== "aborted") {
			const final = createAssistantMessage([{ type: "text", text: "recovered reply" }]);
			if (settlement === "error") {
				final.stopReason = "error";
				final.errorMessage = "terminal failure";
				inner.push({ type: "error", reason: "error", error: final });
			} else {
				inner.push({ type: "done", reason: "stop", message: final });
			}
		}
		const starts: AssistantMessage[] = [];
		const updates: AssistantMessage[] = [];
		const ends: AssistantMessage[] = [];
		const stream = agentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: [""], messages: [], tools: [] },
			{ model: createMockModel(), convertToLlm: identityConverter },
			controller.signal,
			() => wrapInbandToolStream(inner, [], "glm"),
		);
		for await (const event of stream) {
			if (event.type === "message_start" && event.message.role === "assistant") starts.push(event.message);
			if (event.type === "message_update" && event.message.role === "assistant") {
				updates.push(event.message);
				if (settlement === "aborted") controller.abort();
			}
			if (event.type === "message_end" && event.message.role === "assistant") ends.push(event.message);
		}
		inner.end(partial);
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]!.stopReason).toBe(settlement);
		expect(starts.map(assistantMessageIdentity)).toEqual(ends.map(assistantMessageIdentity));
		for (const update of updates) {
			expect(assistantMessageIdentity(update)).toBe(assistantMessageIdentity(starts[0]!));
		}
	});
}
