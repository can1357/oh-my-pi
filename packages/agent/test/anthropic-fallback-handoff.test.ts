/**
 * A tool call the primary Claude model streams before declining and handing the
 * response to its server-side fallback model must never run: not speculatively
 * while the response streams, not after it ends, and not when the response
 * breaks or the user aborts after the handoff.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { FetchImpl, Message, Model } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createUserMessage } from "./helpers";

const fable: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

type WireEvent = Record<string, unknown>;
const usage = { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** The primary reasons and calls `read`, then declines; the fallback model starts answering. */
const handoffEvents: WireEvent[] = [
	{ type: "message_start", message: { id: "msg_turn", model: "claude-fable-5", usage } },
	{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "primary plan" } },
	{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-primary" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "content_block_start",
		index: 1,
		content_block: { type: "tool_use", id: "toolu_declined", name: "read", input: {} },
	},
	{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
	{ type: "content_block_stop", index: 1 },
	{
		type: "content_block_start",
		index: 2,
		content_block: { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
	},
	{ type: "content_block_stop", index: 2 },
	{ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Checking the notes." } },
	{ type: "content_block_stop", index: 3 },
];

const servedTurnEvents: WireEvent[] = [
	...handoffEvents,
	{
		type: "content_block_start",
		index: 4,
		content_block: { type: "tool_use", id: "toolu_served", name: "read", input: {} },
	},
	{ type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"path":"notes.txt"}' } },
	{ type: "content_block_stop", index: 4 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
	{ type: "message_stop" },
];

const plainTurnEvents: WireEvent[] = [
	{ type: "message_start", message: { id: "msg_next", model: "claude-fable-5", usage } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
	{ type: "message_stop" },
];

const encodeSse = (events: WireEvent[]): string =>
	events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/** Serves each request the next scripted turn; `hang` keeps the last turn's body open until the request aborts. */
function scriptedFetch(turns: WireEvent[][], hang = false): FetchImpl {
	let served = 0;
	return async (_input, init) => {
		const index = served++;
		const events = turns[Math.min(index, turns.length - 1)]!;
		const keepOpen = hang && index === turns.length - 1;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(encodeSse(events)));
				if (!keepOpen) {
					controller.close();
					return;
				}
				init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req" } });
	};
}

const readParameters = type({ path: "string" });

function recordingReadTool(calls: string[]): AgentTool<typeof readParameters> {
	return {
		name: "read",
		label: "Read",
		description: "Reads a file",
		parameters: readParameters,
		speculation: {
			stream: {
				open: ({ parentToolCallId }) => {
					calls.push(`open:${parentToolCallId}`);
					return { update() {}, finalize() {}, commit() {}, discard() {} };
				},
			},
		},
		async execute(toolCallId) {
			calls.push(`execute:${toolCallId}`);
			return { content: [{ type: "text", text: "contents" }] };
		},
	};
}

const toLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);

function runLoop(fetch: FetchImpl, calls: string[], signal?: AbortSignal) {
	return agentLoop(
		[createUserMessage("Read a.txt")],
		{ systemPrompt: [""], messages: [], tools: [recordingReadTool(calls)] },
		{
			model: createMockModel({ responses: [] }).model,
			convertToLlm: toLlm,
			getToolContext: () => ({}),
			speculativeToolExecution: { enabled: true },
		},
		signal,
		(_model, context, options) =>
			streamAnthropic(fable, context, {
				apiKey: "sk-ant-test",
				thinkingEnabled: true,
				fallbacks: [{ model: "claude-opus-4-8" }],
				fetch,
				signal: options?.signal,
			}),
	);
}

describe("agent loop after a server-side fallback handoff", () => {
	it("never opens speculation for or runs the declined call, and runs the serving model's", async () => {
		const calls: string[] = [];
		await runLoop(scriptedFetch([servedTurnEvents, plainTurnEvents]), calls).result();

		expect(calls).toContain("execute:toolu_served");
		expect(calls.filter(call => call.endsWith("toolu_declined"))).toEqual([]);
	});

	it("runs nothing when the response breaks after the handoff", async () => {
		const calls: string[] = [];
		const messages = await runLoop(scriptedFetch([handoffEvents, plainTurnEvents]), calls).result();

		expect(calls).toEqual([]);
		const turn = messages.find(message => message.role === "assistant");
		expect(turn?.role === "assistant" && turn.content.some(block => block.type === "toolCall")).toBe(false);
	});

	it("keeps the declined call out of a turn the user aborts after the handoff", async () => {
		const calls: string[] = [];
		const controller = new AbortController();
		const loop = runLoop(scriptedFetch([handoffEvents], true), calls, controller.signal);
		for await (const event of loop) {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta" &&
				event.assistantMessageEvent.delta.includes("notes")
			) {
				controller.abort();
			}
		}
		const messages = await loop.result();

		expect(calls).toEqual([]);
		const turn = messages.find(message => message.role === "assistant");
		expect(turn?.role === "assistant" && turn.stopReason).toBe("aborted");
		expect(turn?.role === "assistant" && turn.content.some(block => block.type === "toolCall")).toBe(false);
	});
});
