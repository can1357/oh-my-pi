import { describe, expect, spyOn, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { completeSimple, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { THINKING_LOOP_ERROR_MARKER } from "@oh-my-pi/pi-ai/utils/thinking-loop";

const SOURCE_ID = "service-tier-raw-stream";

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "tier-probe",
		provider: "test",
		model: "test-model",
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
		...overrides,
	};
}

function probeModel(api: string): Model<Api> {
	return {
		api,
		provider: "test",
		id: "test-model",
		name: "Test model",
		baseUrl: "test://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	} as unknown as Model<Api>;
}

function syncDoneStream(tail: AssistantMessage): AssistantMessageEventStream {
	const inner = new AssistantMessageEventStream();
	inner.push({ type: "start", partial: tail });
	inner.push({ type: "done", reason: "stop", message: tail });
	return inner;
}

function syncErrorStream(error: AssistantMessage): AssistantMessageEventStream {
	const inner = new AssistantMessageEventStream();
	inner.push({ type: "error", reason: "error", error });
	return inner;
}

async function collect(s: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of s) events.push(event);
	return events;
}

function terminalMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const last = events.at(-1);
	if (!last || (last.type !== "done" && last.type !== "error")) throw new Error("stream ended without terminal event");
	return last.type === "done" ? last.message : last.error;
}

describe("requested service tier on raw streams", () => {
	test("stream() records requested tiers on synchronously-queued events and results", async () => {
		const api = "tier-sync-stream";
		const done = message();
		registerCustomApi(
			api,
			() => syncDoneStream(done),
			SOURCE_ID,
			() => syncDoneStream(done),
		);
		try {
			const s = stream(probeModel(api), context(), { serviceTier: "priority" });
			const events = await collect(s);
			const result = await s.result();
			expect(terminalMessage(events).serviceTier).toBe("priority");
			expect(result.serviceTier).toBe("priority");
		} finally {
			unregisterCustomApis(SOURCE_ID);
		}
	});

	test("streamSimple() records an explicit null tier when none is requested", async () => {
		const api = "tier-null-simple";
		const done = message();
		registerCustomApi(api, () => syncDoneStream(done), SOURCE_ID);
		try {
			const s = streamSimple(probeModel(api), context());
			const events = await collect(s);
			const result = await s.result();
			expect(terminalMessage(events).serviceTier).toBeNull();
			expect(result.serviceTier).toBeNull();
		} finally {
			unregisterCustomApis(SOURCE_ID);
		}
	});

	test("streamSimple() stamps a stream that ended via end(result) with no terminal event", async () => {
		const api = "tier-end-result";
		const done = message();
		registerCustomApi(
			api,
			() => {
				const inner = new AssistantMessageEventStream();
				inner.push({ type: "start", partial: done });
				inner.end(done);
				return inner;
			},
			SOURCE_ID,
		);
		try {
			const s = streamSimple(probeModel(api), context(), { serviceTier: "flex" });
			const result = await s.result();
			expect(result.serviceTier).toBe("flex");
		} finally {
			unregisterCustomApis(SOURCE_ID);
		}
	});

	test("stream() stamps terminal error messages with the requested tier", async () => {
		const api = "tier-error-stream";
		const error = message({ stopReason: "error", errorMessage: "upstream exploded" });
		registerCustomApi(
			api,
			() => syncErrorStream(error),
			SOURCE_ID,
			() => syncErrorStream(error),
		);
		try {
			const s = stream(probeModel(api), context(), { serviceTier: "priority" });
			const events = await collect(s);
			const result = await s.result();
			expect(terminalMessage(events).serviceTier).toBe("priority");
			expect(result.serviceTier).toBe("priority");
		} finally {
			unregisterCustomApis(SOURCE_ID);
		}
	});

	test("a provider-echoed served tier never masquerades as requested", async () => {
		const api = "tier-echo";
		registerCustomApi(api, () => syncDoneStream(message({ serviceTier: "flex" })), SOURCE_ID);
		try {
			const requested = await stream(probeModel(api), context(), { serviceTier: "priority" }).result();
			expect(requested.serviceTier).toBe("priority");
			const unrequested = await stream(probeModel(api), context()).result();
			expect(unrequested.serviceTier).toBeNull();
		} finally {
			unregisterCustomApis(SOURCE_ID);
		}
	});

	test("auth retries stamp the requested tier across rotated credentials", async () => {
		const api = "tier-auth-retry";
		let attempts = 0;
		registerCustomApi(
			api,
			() => {
				attempts += 1;
				if (attempts === 1) {
					// Auth failures carry no content: contentful terminal events are
					// replay-unsafe and the auth path must never rotate on those.
					return syncErrorStream(
						message({ content: [], stopReason: "error", errorMessage: "invalid api key", errorStatus: 401 }),
					);
				}
				return syncDoneStream(message());
			},
			SOURCE_ID,
		);
		try {
			const result = await streamSimple(probeModel(api), context(), {
				serviceTier: "priority",
				apiKey: ({ error }) => (error === undefined ? "key-1" : "key-2"),
			}).result();
			expect(attempts).toBe(2);
			expect(result.stopReason).toBe("stop");
			expect(result.serviceTier).toBe("priority");
		} finally {
			unregisterCustomApis(SOURCE_ID);
		}
	});

	test("completeSimple() keeps stamping every attempt, including loop retries", async () => {
		const api = "tier-loop-complete";
		let attempts = 0;
		registerCustomApi(
			api,
			() => {
				attempts += 1;
				if (attempts === 1) {
					return syncErrorStream(
						message({
							content: [],
							stopReason: "error",
							errorMessage: `${THINKING_LOOP_ERROR_MARKER}: stalled`,
							errorId: AIError.create(AIError.Flag.ThinkingLoop),
						}),
					);
				}
				return syncDoneStream(message());
			},
			SOURCE_ID,
		);
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const attemptTiers: Array<string | null | undefined> = [];
		try {
			const result = await completeSimple(probeModel(api), context(), {
				serviceTier: "priority",
				onAttempt: attempt => attemptTiers.push(attempt.serviceTier),
			});
			expect(attempts).toBe(2);
			expect(attemptTiers).toEqual(["priority", "priority"]);
			expect(result.serviceTier).toBe("priority");
		} finally {
			waitSpy.mockRestore();
			unregisterCustomApis(SOURCE_ID);
		}
	});
});
