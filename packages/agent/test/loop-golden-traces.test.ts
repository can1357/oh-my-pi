import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Message, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockCall } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream, type EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createUserMessage } from "./helpers";

/**
 * Golden traces for the observable contract of the agent loop body.
 *
 * Every scenario drives the real loop (through the scripted mock provider, or a
 * provider stream the test owns when it needs to abort mid-stream) and pins the
 * three surfaces a structural rewrite of `runLoopBody` must preserve byte for
 * byte:
 *
 *   1. the ordered `AgentEvent` sequence — `type`, plus the payload fields that
 *      carry meaning (`stopReason`, `toolCallId`, `toolName`, error state);
 *      consecutive `message_update` deltas collapse to a count;
 *   2. the committed messages as `role:stopReason:contentKind`;
 *   3. what each provider call received — the roles handed over and the
 *      trailing message's role/content.
 *
 * Timestamps, usage numbers, and generated tool-call ids are normalized away, so
 * the goldens are deterministic and a failure diff names the exact line.
 */

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const echoSchema = type({ value: "string" });

function echoTool(executed: string[]): AgentTool<typeof echoSchema> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: { value: params.value } };
		},
	};
}

/** Identity conversion: the loop's own messages are already provider messages. */
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

async function collect(stream: EventStream<AgentEvent, AgentMessage[]>) {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, messages: await stream.result() };
}

/** Single-line, whitespace-flattened excerpt so one golden line stays one line. */
function clip(text: string, limit = 48): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Content block kinds for a committed message; compaction entries carry a summary instead. */
function contentKind(message: AgentMessage): string {
	if (message.role === "branchSummary" || message.role === "compactionSummary") return "summary";
	const { content } = message;
	if (typeof content === "string") return content.length > 0 ? "text" : "empty";
	return content.length === 0 ? "empty" : content.map(block => block.type).join("+");
}

function messageTag(message: AgentMessage): string {
	if (message.role === "assistant") {
		const error = message.errorMessage ? ` "${clip(message.errorMessage, 32)}"` : "";
		return `assistant:${message.stopReason}${error}`;
	}
	if (message.role === "toolResult") {
		return `toolResult:${message.toolCallId}:${message.isError ? "error" : "ok"}`;
	}
	return message.role;
}

function eventTrace(events: readonly AgentEvent[]): string[] {
	const lines: string[] = [];
	for (let index = 0; index < events.length; index++) {
		const event = events[index]!;
		if (event.type === "message_update") {
			let run = 0;
			while (events[index + run]?.type === "message_update") run++;
			lines.push(`message_update x${run}`);
			index += run - 1;
			continue;
		}
		switch (event.type) {
			case "message_start":
			case "message_end":
				lines.push(`${event.type}:${messageTag(event.message)}`);
				break;
			case "tool_execution_start":
				lines.push(`${event.type}:${event.toolCallId}:${event.toolName}`);
				break;
			case "tool_execution_end":
				lines.push(`${event.type}:${event.toolCallId}:${event.toolName}:${event.isError ? "error" : "ok"}`);
				break;
			case "turn_end":
				lines.push(`${event.type}:${messageTag(event.message)}:toolResults=${event.toolResults.length}`);
				break;
			case "agent_end":
				lines.push(`${event.type}:messages=${event.messages.length}`);
				break;
			default:
				lines.push(event.type);
		}
	}
	return lines;
}

function messageTrace(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => `${messageTag(message)}:${contentKind(message)}`);
}

/** Provider-visible excerpt: text verbatim, tool calls as `<toolCall name>`. */
function providerContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map(block => {
			if (block.type === "text") return block.text;
			if (block.type === "toolCall") return `<toolCall ${block.name}>`;
			return `<${block.type}>`;
		})
		.join("");
}

function callTrace(calls: readonly MockCall[]): string[] {
	return calls.map((call, index) => {
		const messages = call.context.messages;
		const last = messages.at(-1);
		const trailing = last ? `${last.role}(${clip(providerContent(last.content))})` : "none";
		return `#${index + 1} roles=[${messages.map(message => message.role).join(",")}] last=${trailing}`;
	});
}

describe("agentLoop golden traces", () => {
	it("plain turn: one assistant answer, no tools", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["Hello there."] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		expect(eventTrace(events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant:stop",
			"message_update x3",
			"message_end:assistant:stop",
			"turn_end:assistant:stop:toolResults=0",
			"agent_end:messages=2",
		]);
		expect(messageTrace(messages)).toEqual(["user:text", "assistant:stop:text"]);
		expect(callTrace(mock.calls)).toEqual(["#1 roles=[user] last=user(hi)"]);
	});

	it("tool batch then answer: the toolResult is committed between turns and replayed", async () => {
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool(executed)] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "alpha" } }] },
				{ content: ["The tool said alpha."] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("call the tool")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		expect(executed).toEqual(["alpha"]);
		expect(eventTrace(events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant:toolUse",
			"message_update x3",
			"message_end:assistant:toolUse",
			"tool_execution_start:tc-1:echo",
			"tool_execution_end:tc-1:echo:ok",
			"message_start:toolResult:tc-1:ok",
			"message_end:toolResult:tc-1:ok",
			"turn_end:assistant:toolUse:toolResults=1",
			"turn_start",
			"message_start:assistant:stop",
			"message_update x3",
			"message_end:assistant:stop",
			"turn_end:assistant:stop:toolResults=0",
			"agent_end:messages=4",
		]);
		expect(messageTrace(messages)).toEqual([
			"user:text",
			"assistant:toolUse:toolCall",
			"toolResult:tc-1:ok:text",
			"assistant:stop:text",
		]);
		// The second provider call replays the assistant tool_use turn and the
		// matching toolResult, and nothing else.
		expect(callTrace(mock.calls)).toEqual([
			"#1 roles=[user] last=user(call the tool)",
			"#2 roles=[user,assistant,toolResult] last=toolResult(ok:alpha)",
		]);
	});

	it("length truncation: the tool call is paired with a placeholder and the model is asked again", async () => {
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool(executed)] };
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "truncated" } }],
					stopReason: "length",
				},
				{ content: ["Retrying in smaller chunks."] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("call the tool")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		// A truncated turn's arguments may be cut mid-string, so the call never runs.
		expect(executed).toEqual([]);
		expect(eventTrace(events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant:length",
			"message_update x3",
			"message_end:assistant:length",
			"tool_execution_start:tc-1:echo",
			"tool_execution_end:tc-1:echo:error",
			"message_start:toolResult:tc-1:error",
			"message_end:toolResult:tc-1:error",
			"turn_end:assistant:length:toolResults=1",
			"turn_start",
			"message_start:assistant:stop",
			"message_update x3",
			"message_end:assistant:stop",
			"turn_end:assistant:stop:toolResults=0",
			"agent_end:messages=4",
		]);
		expect(messageTrace(messages)).toEqual([
			"user:text",
			"assistant:length:toolCall",
			"toolResult:tc-1:error:text",
			"assistant:stop:text",
		]);
		// The placeholder pairs the abandoned call, then a second provider call asks
		// the model to retry — it does happen, with the error result replayed.
		expect(callTrace(mock.calls)).toEqual([
			"#1 roles=[user] last=user(call the tool)",
			"#2 roles=[user,assistant,toolResult] last=toolResult(Tool call was not executed because the assistan…)",
		]);
	});

	it("pause_turn: the turn re-samples with the paused assistant message replayed", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({
			responses: [
				{ content: ["Still working."], stopReason: "stop", stopDetails: { type: "pause_turn" } },
				{ content: ["All done."] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		expect(eventTrace(events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant:stop",
			"message_update x3",
			"message_end:assistant:stop",
			"turn_end:assistant:stop:toolResults=0",
			"turn_start",
			"message_start:assistant:stop",
			"message_update x3",
			"message_end:assistant:stop",
			"turn_end:assistant:stop:toolResults=0",
			"agent_end:messages=3",
		]);
		// Both commentary turns commit; the continuation runs as its own turn.
		expect(messageTrace(messages)).toEqual(["user:text", "assistant:stop:text", "assistant:stop:text"]);
		// No user or toolResult message sits between the paused turn and the resample.
		expect(callTrace(mock.calls)).toEqual([
			"#1 roles=[user] last=user(hi)",
			"#2 roles=[user,assistant] last=assistant(Still working.)",
		]);
	});

	it("error stop: the tool call is paired with a not-executed placeholder and the run ends", async () => {
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool(executed)] };
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "beta" } }],
					stopReason: "error",
					errorMessage: "upstream transport died",
				},
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("call the tool")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		expect(executed).toEqual([]);
		expect(eventTrace(events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			`message_start:assistant:error "upstream transport died"`,
			"message_update x3",
			`message_end:assistant:error "upstream transport died"`,
			"tool_execution_start:tc-1:echo",
			"tool_execution_end:tc-1:echo:error",
			"message_start:toolResult:tc-1:error",
			"message_end:toolResult:tc-1:error",
			`turn_end:assistant:error "upstream transport died":toolResults=1`,
			"agent_end:messages=3",
		]);
		expect(messageTrace(messages)).toEqual([
			"user:text",
			`assistant:error "upstream transport died":toolCall`,
			"toolResult:tc-1:error:text",
		]);
		// One call only: an errored turn never continues to another provider request.
		expect(callTrace(mock.calls)).toEqual(["#1 roles=[user] last=user(call the tool)"]);
	});

	it("abort mid-stream: the partial assistant message commits as aborted and the run still ends", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const controller = new AbortController();
		const providerStream = new AssistantMessageEventStream();
		const providerCalls: MockCall[] = [];
		const model = createMockModel().model;
		// The abort has to land between two deltas, which the scripted mock provider
		// cannot express: it pushes a whole response in one burst. Drive the loop
		// with a hand-controlled provider stream instead and abort from the loop's
		// own per-delta hook, so the interleaving is deterministic.
		const streamFn: StreamFn = (_model, providerContext) => {
			providerCalls.push({ context: providerContext });
			return providerStream;
		};
		const config: AgentLoopConfig = {
			model,
			convertToLlm: identityConverter,
			onAssistantMessageEvent: (_message, event) => {
				if (event.type === "text_delta") controller.abort("Interrupted by user");
			},
		};
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "half a sen" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, controller.signal, streamFn);
		providerStream.push({ type: "start", partial: { ...partial, content: [] } });
		providerStream.push({ type: "text_start", contentIndex: 0, partial });
		providerStream.push({ type: "text_delta", contentIndex: 0, delta: "half a sen", partial });
		const { events, messages } = await collect(stream);

		expect(eventTrace(events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant:stop",
			"message_update x2",
			`message_end:assistant:aborted "Interrupted by user"`,
			`turn_end:assistant:aborted "Interrupted by user":toolResults=0`,
			"agent_end:messages=2",
		]);
		// The streamed text survives on the committed aborted message.
		expect(messageTrace(messages)).toEqual(["user:text", `assistant:aborted "Interrupted by user":text`]);
		expect(callTrace(providerCalls)).toEqual(["#1 roles=[user] last=user(hi)"]);
	});

	it("deadline already exceeded: no provider call, no turn, just the echoed prompt", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["too late"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			deadline: Date.now() - 1,
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		expect(eventTrace(events)).toEqual([
			"agent_start",
			"message_start:user",
			"message_end:user",
			"agent_end:messages=1",
		]);
		expect(messageTrace(messages)).toEqual(["user:text"]);
		expect(callTrace(mock.calls)).toEqual([]);
	});

	it("deadline already exceeded: the steering queue is never polled, so it keeps its messages", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["too late"] }] });
		const getSteeringMessages = vi.fn(async () => [createUserMessage("queued before the deadline")]);
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			deadline: Date.now() - 1,
			getSteeringMessages,
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		const { messages } = await collect(stream);

		// Dequeuing here would strand the message: the run it was handed to is already
		// dead and can never deliver it. The queue keeps owning it until a live turn.
		expect(getSteeringMessages).not.toHaveBeenCalled();
		expect(messageTrace(messages)).toEqual(["user:text"]);
		expect(callTrace(mock.calls)).toEqual([]);
	});

	it("pre-model-call gate stop: the provider is never called and the unopened turn emits no stop message", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["never reached"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeModelCall: () => ({ stop: true, reason: "budget exhausted" }),
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		// The gate fires before the turn is opened (`turnOpen` is still false), so
		// the loop takes the early return: no `turn_start`, no gate-stop assistant
		// message, no `turn_end` — the prompt is echoed and the run ends.
		expect(eventTrace(events)).toEqual([
			"agent_start",
			"message_start:user",
			"message_end:user",
			"agent_end:messages=1",
		]);
		expect(messageTrace(messages)).toEqual(["user:text"]);
		expect(callTrace(mock.calls)).toEqual([]);
	});

	it("steering at the yield boundary: one extra turn with the steer committed once", async () => {
		const steer = createUserMessage("steer: focus on the tests");
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const mock = createMockModel({ responses: [{ content: ["First answer."] }, { content: ["Second answer."] }] });
		let steered = false;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			// Delivered only once the first response is in flight, i.e. at the
			// boundary where the agent would otherwise stop.
			getSteeringMessages: async () => {
				if (steered || mock.calls.length === 0) return [];
				steered = true;
				return [steer];
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		const { events, messages } = await collect(stream);

		expect(eventTrace(events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant:stop",
			"message_update x3",
			"message_end:assistant:stop",
			"turn_end:assistant:stop:toolResults=0",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant:stop",
			"message_update x3",
			"message_end:assistant:stop",
			"turn_end:assistant:stop:toolResults=0",
			"agent_end:messages=4",
		]);
		// The steer is committed exactly once, between the two answers.
		expect(messageTrace(messages)).toEqual(["user:text", "assistant:stop:text", "user:text", "assistant:stop:text"]);
		expect(callTrace(mock.calls)).toEqual([
			"#1 roles=[user] last=user(hi)",
			"#2 roles=[user,assistant,user] last=user(steer: focus on the tests)",
		]);
	});
});
