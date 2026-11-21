/**
 * A server-side fallback handoff mid-response: the primary model reasons and
 * starts a tool call, declines, and the fallback model finishes the turn. The
 * declining model's reasoning and tool calls must not reach the finished turn,
 * the stream's tool-call events, a gateway client, or the next request.
 */
import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { encodeStream } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import type { AnthropicOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageParam } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { AssistantMessageEvent, FetchImpl, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
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

/** Primary output up to and including the handoff, then the fallback model's text. */
const handoffEvents: WireEvent[] = [
	{ type: "message_start", message: { id: "msg_turn", model: "claude-fable-5", usage } },
	{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "primary plan" } },
	{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-primary" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque-primary" } },
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Let me look." } },
	{ type: "content_block_stop", index: 2 },
	{
		type: "content_block_start",
		index: 3,
		content_block: { type: "tool_use", id: "toolu_declined", name: "read", input: {} },
	},
	{ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
	{ type: "content_block_stop", index: 3 },
	{
		type: "content_block_start",
		index: 4,
		content_block: {
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-opus-4-8" },
			trigger: { type: "refusal", category: "cyber" },
		},
	},
	{ type: "content_block_stop", index: 4 },
	{ type: "content_block_start", index: 5, content_block: { type: "thinking", thinking: "" } },
	{ type: "content_block_delta", index: 5, delta: { type: "thinking_delta", thinking: "fallback plan" } },
	{ type: "content_block_delta", index: 5, delta: { type: "signature_delta", signature: "sig-fallback" } },
	{ type: "content_block_stop", index: 5 },
	{ type: "content_block_start", index: 6, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 6, delta: { type: "text_delta", text: "Checking the notes." } },
	{ type: "content_block_stop", index: 6 },
];

/** The fallback model also calls a tool and the turn ends normally. */
const servedTurnEvents: WireEvent[] = [
	...handoffEvents,
	{
		type: "content_block_start",
		index: 7,
		content_block: { type: "tool_use", id: "toolu_served", name: "read", input: {} },
	},
	{ type: "content_block_delta", index: 7, delta: { type: "input_json_delta", partial_json: '{"path":"notes.txt"}' } },
	{ type: "content_block_stop", index: 7 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
	{ type: "message_stop" },
];

const plainTurnEvents: WireEvent[] = [
	{ type: "message_start", message: { id: "msg_next", model: "claude-fable-5", usage } },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
	{ type: "message_stop" },
];

/** Serves each request the next scripted turn and records the bodies omp sends. */
function scriptedAnthropic(turns: WireEvent[][]) {
	const requests: Array<{ messages: MessageParam[] }> = [];
	let served = 0;
	const fetch: FetchImpl = async () => {
		const events = turns[Math.min(served++, turns.length - 1)]!;
		const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": "req_mock" },
		});
	};
	const options: AnthropicOptions = {
		apiKey: "sk-ant-test",
		thinkingEnabled: true,
		fetch,
		onPayload: payload => {
			requests.push(structuredClone(payload) as { messages: MessageParam[] });
			return undefined;
		},
	};
	return { options, requests };
}

const user = { role: "user", content: "Read a.txt", timestamp: 0 } as const;
const fallbacks = [{ model: "claude-opus-4-8" }];

async function collect(options: AnthropicOptions) {
	const stream = streamAnthropic(model, { messages: [user] }, options);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

function toolCallIds(events: AssistantMessageEvent[]): string[] {
	return events.flatMap(event => {
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end")
			return [];
		const block = event.partial.content[event.contentIndex];
		return block?.type === "toolCall" ? [block.id] : [];
	});
}

describe("server-side fallback handoff", () => {
	it("keeps only the serving model's output in the finished turn", async () => {
		const { options } = scriptedAnthropic([servedTurnEvents]);
		const { message } = await collect({ ...options, fallbacks });

		expect(message.stopReason).toBe("toolUse");
		expect(message.content.map(block => block.type)).toEqual(["text", "fallback", "thinking", "text", "toolCall"]);
		expect(message.content[2]).toMatchObject({ thinking: "fallback plan", thinkingSignature: "sig-fallback" });
		expect(message.content[4]).toMatchObject({ id: "toolu_served", arguments: { path: "notes.txt" } });
	});

	it("emits tool-call events only for the serving model's calls, once the turn ends", async () => {
		const { options } = scriptedAnthropic([servedTurnEvents]);
		const { events } = await collect({ ...options, fallbacks });

		const ids = toolCallIds(events);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids)).toEqual(new Set(["toolu_served"]));
		const firstToolEvent = events.findIndex(event => event.type.startsWith("toolcall_"));
		expect(events.slice(firstToolEvent).some(event => event.type.startsWith("text_"))).toBe(false);
		const end = events.find(event => event.type === "toolcall_end");
		expect(end?.type === "toolcall_end" && end.toolCall).toMatchObject({ id: "toolu_served" });
	});

	it("streams tool-call events as they arrive when the request does not opt into fallbacks", async () => {
		const { options } = scriptedAnthropic([servedTurnEvents]);
		const { events } = await collect(options);

		const declinedStart = events.findIndex(
			event => event.type === "toolcall_start" && toolCallIds([event])[0] === "toolu_declined",
		);
		const laterText = events.findIndex((event, index) => index > declinedStart && event.type === "text_start");
		expect(declinedStart).toBeGreaterThan(-1);
		expect(laterText).toBeGreaterThan(declinedStart);
	});

	it("drops the declining model's tool call when the stream breaks after the handoff", async () => {
		const { options } = scriptedAnthropic([handoffEvents]);
		const { events, message } = await collect({ ...options, fallbacks });

		expect(message.stopReason).toBe("error");
		expect(message.content.some(block => block.type === "toolCall")).toBe(false);
		expect(toolCallIds(events)).toEqual([]);
	});

	it("never forwards the declined call to a gateway client", async () => {
		const { options } = scriptedAnthropic([servedTurnEvents]);
		const sse = await new Response(
			encodeStream(streamAnthropic(model, { messages: [user] }, { ...options, fallbacks }), "claude-fable-5"),
		).text();

		expect(sse).toContain("toolu_served");
		expect(sse).not.toContain("toolu_declined");
	});

	it.each([
		{
			label: "with the boundary when the request opts in",
			withFallbacks: true,
			expected: ["text", "fallback", "thinking", "text", "tool_use"],
		},
		{
			label: "without the boundary when it does not",
			withFallbacks: false,
			expected: ["text", "thinking", "text", "tool_use"],
		},
	])("replays only the retained output $label", async ({ withFallbacks, expected }) => {
		const { options, requests } = scriptedAnthropic([servedTurnEvents, plainTurnEvents]);
		const requestOptions = withFallbacks ? { ...options, fallbacks } : options;
		const turn = await streamAnthropic(model, { messages: [user] }, requestOptions).result();
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_served",
			toolName: "read",
			content: [{ type: "text", text: "notes" }],
			isError: false,
			timestamp: 0,
		};
		await streamAnthropic(model, { messages: [user, turn, result] }, requestOptions).result();

		const replayed = requests[1]?.messages.find(message => message.role === "assistant")?.content;
		if (!Array.isArray(replayed)) throw new Error("expected the handoff turn on the wire");
		expect(replayed.map(block => block.type)).toEqual([...expected]);
		expect(replayed).toContainEqual(expect.objectContaining({ type: "thinking", signature: "sig-fallback" }));
		expect(JSON.stringify(replayed)).not.toContain("toolu_declined");
	});

	it("streams tool-call events at their own blocks on a fallback-credit continuation", async () => {
		const creditTurn: WireEvent[] = [
			{ type: "message_start", message: { id: "msg_credit", model: "claude-opus-4-8", usage } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading it." } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "toolu_credit", name: "read", input: {} },
			},
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
			},
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
			{ type: "message_stop" },
		];
		const { options } = scriptedAnthropic([creditTurn]);
		const stream = streamAnthropic(
			model,
			{ messages: [user] },
			{
				...options,
				fallbacks,
				fallbackCreditRedemption: {
					token: "fct_credit",
					prefillClaim: true,
					params: {
						model: "claude-fable-5",
						messages: [{ role: "user", content: "Read a.txt" }],
						max_tokens: 1024,
						stream: true,
						fallbacks,
					},
					betas: ["fallback-credit-2026-06-01"],
					expiresAt: Date.now() + 60_000,
					refusedContent: [
						{ type: "thinking", thinking: "primary plan", thinkingSignature: "sig-primary" },
						{ type: "text", text: "Partial " },
					],
				},
			},
		);

		// Resolve each event's block when it is consumed, as the agent loop does.
		const ids: string[] = [];
		for await (const event of stream) ids.push(...toolCallIds([event]));
		const toolEventCount = ids.length;
		expect(toolEventCount).toBeGreaterThan(0);
		expect(ids).toEqual(Array(toolEventCount).fill("toolu_credit"));
	});
});
