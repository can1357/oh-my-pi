import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamAnthropic } from "../src/providers/anthropic";
import type { AnthropicMessagesClientLike } from "../src/providers/anthropic-client";
import type { Context, Model } from "../src/types";
import { waitForDelayOrAbort } from "./helpers";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = {
	messages: [{ role: "user", content: "write a file", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;

/** `{ waitMs, event }` script step; `waitMs` elapses (fake clock) before the event is yielded. */
type ScriptStep = { waitMs: number; event: MockAnthropicEvent | "hang-with-pings" };

const writeToolCallOpening: MockAnthropicEvent[] = [
	{
		type: "message_start",
		message: {
			id: "msg_ping_keepalive",
			usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_ping_keepalive", name: "write", input: {} },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: '{"path":"notes.md",' },
	},
];

const writeToolCallClosing: MockAnthropicEvent[] = [
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: '"content":"hello world"}' },
	},
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "tool_use" },
		usage: { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
];

function createScriptedClient(
	script: ScriptStep[],
	counters: { pings: number },
	onIteratorStart: () => void,
): AnthropicMessagesClientLike {
	const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
		const signal = requestOptions?.signal;
		const response = new Response(null, { status: 200, headers: { "request-id": "req_ping_keepalive" } });
		const stream = {
			async *[Symbol.asyncIterator]() {
				onIteratorStart();
				for (const step of script) {
					if (step.event === "hang-with-pings") {
						// Wedged upstream: no semantic events ever again, but the edge
						// keeps the SSE connection alive with keepalive pings.
						while (true) {
							await waitForDelayOrAbort(step.waitMs, signal);
							counters.pings += 1;
							yield { type: "ping" };
						}
					}
					if (step.waitMs > 0) {
						await waitForDelayOrAbort(step.waitMs, signal);
					}
					if (step.event.type === "ping") counters.pings += 1;
					yield step.event;
				}
			},
		};
		return {
			async withResponse() {
				return { data: stream, response, request_id: "req_ping_keepalive" };
			},
		} as never;
	}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
	return { messages: { create } } as AnthropicMessagesClientLike;
}

async function drainMicrotasks(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(errorMessage);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("anthropic ping keepalive idle cap", () => {
	it("times out a stalled tool-call stream instead of letting pings extend it forever", async () => {
		vi.useFakeTimers();
		const counters = { pings: 0 };
		let iteratorStarted = false;
		const script: ScriptStep[] = [
			...writeToolCallOpening.map(event => ({ waitMs: 0, event })),
			{ waitMs: 500, event: "hang-with-pings" as const },
		];
		const client = createScriptedClient(script, counters, () => {
			iteratorStarted = true;
		});
		const providerRetryWait = vi.fn(async () => {});

		let settled = false;
		const resultPromise = streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 1_000,
			providerRetryWait,
		})
			.result()
			.then(message => {
				settled = true;
				return message;
			});

		await drainMicrotasksUntil(() => iteratorStarted, "Anthropic mock stream never started");
		await drainMicrotasks(30);

		// Pings arrive every 500 fake-ms while generation is wedged. Drive far
		// past the bounded keepalive window (3x idle = 3_000ms) plus one idle
		// budget; without the cap the idle deadline is reset by every ping and
		// this loop ends with the result still pending (issue #4900's hang).
		let stepsRun = 0;
		for (let step = 0; step < 40 && !settled; step++) {
			vi.advanceTimersByTime(500);
			await drainMicrotasks(30);
			stepsRun = step + 1;
		}

		expect(settled).toBe(true);
		// Cap (3_000ms) + idle budget (1_000ms) = fires at 3_500-4_000 fake ms.
		expect(stepsRun).toBeLessThanOrEqual(9);
		// Keepalives within the window were honored before the watchdog fired.
		expect(counters.pings).toBeGreaterThanOrEqual(5);

		const result = await resultPromise;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream stalled while waiting for the next event");
		// Mid-stream idle stalls are terminal for the provider loop (session-level
		// auto-retry owns recovery); the provider must not silently re-request.
		expect(providerRetryWait).not.toHaveBeenCalled();
	});

	it("keeps a slow-but-alive stream open across ping-bridged gaps within the cap", async () => {
		vi.useFakeTimers();
		const counters = { pings: 0 };
		let iteratorStarted = false;
		// Silent generation gap of 1_800ms (> 1_000ms idle budget) bridged by
		// pings at t=600 and t=1200, then semantic progress resumes and the
		// tool call completes. Pings within the cap must count as liveness.
		const script: ScriptStep[] = [
			...writeToolCallOpening.map(event => ({ waitMs: 0, event })),
			{ waitMs: 600, event: { type: "ping" } },
			{ waitMs: 600, event: { type: "ping" } },
			{ waitMs: 600, event: writeToolCallClosing[0]! },
			...writeToolCallClosing.slice(1).map(event => ({ waitMs: 0, event })),
		];
		const client = createScriptedClient(script, counters, () => {
			iteratorStarted = true;
		});
		const providerRetryWait = vi.fn(async () => {});

		let settled = false;
		const resultPromise = streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 1_000,
			providerRetryWait,
		})
			.result()
			.then(message => {
				settled = true;
				return message;
			});

		await drainMicrotasksUntil(() => iteratorStarted, "Anthropic mock stream never started");
		await drainMicrotasks(30);

		for (let step = 0; step < 30 && !settled; step++) {
			vi.advanceTimersByTime(200);
			await drainMicrotasks(30);
		}

		expect(settled).toBe(true);
		expect(counters.pings).toBe(2);

		const result = await resultPromise;
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("toolUse");
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{
				type: "toolCall",
				id: "toolu_ping_keepalive",
				name: "write",
				arguments: { path: "notes.md", content: "hello world" },
			},
		]);
	});
});
