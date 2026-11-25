import { afterEach, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import {
	__providerInFlightForTesting,
	configureProviderMaxInFlightRequests,
	configureProviderSlotBroker,
	stream,
	streamSimple,
} from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, RawSseEvent } from "@oh-my-pi/pi-ai/types";

function context(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

afterEach(() => {
	clearCustomApis();
	configureProviderMaxInFlightRequests(undefined);
	configureProviderSlotBroker(undefined);
	__providerInFlightForTesting.setWaitObserver(undefined);
});

function nextLimiterWait(provider = "tests"): Promise<void> {
	const waiting = Promise.withResolvers<void>();
	__providerInFlightForTesting.setWaitObserver(waitingProvider => {
		if (waitingProvider === provider) waiting.resolve();
	});
	return waiting.promise;
}

describe("provider in-flight request limits", () => {
	test("serializes concurrent streamSimple calls for the same provider", async () => {
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		let callIndex = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				callIndex++;
				active++;
				maxActive = Math.max(maxActive, active);
				try {
					if (callIndex === 1) {
						firstStarted.resolve();
						await releaseFirst.promise;
					}
					return { content: [`reply ${callIndex}`] };
				} finally {
					active--;
				}
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		const secondWaiting = nextLimiterWait();
		const second = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		await secondWaiting;

		releaseFirst.resolve();
		const [firstMessage, secondMessage] = await Promise.all([firstResult, second.result()]);

		expect(firstMessage.content).toEqual([{ type: "text", text: "reply 1" }]);
		expect(secondMessage.content).toEqual([{ type: "text", text: "reply 2" }]);
		expect(maxActive).toBe(1);
		expect(mock.calls).toHaveLength(2);
	});

	test("refuses a queued non-fetch provider attempt when the cap closes before dispatch", async () => {
		registerMockApi();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				started.resolve();
				await release.promise;
				return { content: ["first"] };
			},
		});
		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } }).result();
		await started.promise;

		let capped = false;
		const waiting = nextLimiterWait();
		const second = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			beforeDispatch: () => {
				if (capped) throw new Error("Cost cap reached");
			},
		})
			.result()
			.then(
				message => message.errorMessage,
				error => String(error),
			);
		await waiting;
		capped = true;
		release.resolve();
		await first;

		expect(await second).toContain("Cost cap reached");
		expect(mock.calls).toHaveLength(1);
	});

	test("holds a completions permit until a trailing [DONE] reaches the gateway", async () => {
		configureProviderMaxInFlightRequests({ tests: 1 });
		const model: Model<"openai-completions"> = {
			...getBundledModel<"openai-completions">("openai", "gpt-4o-mini"),
			provider: "tests",
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
		};
		const encoder = new TextEncoder();
		const usageSeen = Promise.withResolvers<void>();
		const releaseDone = Promise.withResolvers<void>();
		let calls = 0;
		let doneSent = false;
		let overlapped = false;
		const chunk = (choices: unknown[], usage?: object) =>
			encoder.encode(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices, usage })}\n\n`);
		async function mockFetch(): Promise<Response> {
			calls++;
			if (calls === 2 && !doneSent) overlapped = true;
			if (calls === 1) {
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(chunk([{ index: 0, delta: { content: "first" } }]));
						controller.enqueue(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
						controller.enqueue(chunk([], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
						await releaseDone.promise;
						doneSent = true;
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					},
				});
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			}
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunk([{ index: 0, delta: { content: "second" }, finish_reason: "stop" }]));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		}
		const options = {
			apiKey: "test",
			fetch: mockFetch,
			onSseEvent: (event: RawSseEvent) => {
				if (event.data.includes('"choices":[]')) usageSeen.resolve();
			},
		};
		const firstResult = stream(model, context(), options).result();
		await usageSeen.promise;
		const secondResult = stream(model, context(), options).result();
		// Give the queued request time to start early while the first transport
		// is parked waiting for its terminal SSE frame.
		await Bun.sleep(150);
		releaseDone.resolve();
		const [first, second] = await Promise.all([firstResult, secondResult]);
		expect(first.content).toEqual([{ type: "text", text: "first" }]);
		expect(second.content).toEqual([{ type: "text", text: "second" }]);
		expect(overlapped).toBe(false);
	}, 10_000);

	test("holds an Anthropic permit until the body after message_stop reaches its end", async () => {
		configureProviderMaxInFlightRequests({ tests: 1 });
		const model: Model<"anthropic-messages"> = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet",
			api: "anthropic-messages",
			provider: "tests",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
		const encoder = new TextEncoder();
		const stopSeen = Promise.withResolvers<void>();
		const releaseTail = Promise.withResolvers<void>();
		let calls = 0;
		let tailSent = false;
		let overlapped = false;
		async function mockFetch(): Promise<Response> {
			calls++;
			if (calls === 2 && !tailSent) overlapped = true;
			const first = calls === 1;
			const text = first ? "first" : "second";
			const sse = [
				{
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: model.id,
						content: [],
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]
				.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				.join("");
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(encoder.encode(sse));
					if (first) {
						await releaseTail.promise;
						tailSent = true;
					}
					controller.close();
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		}
		const options = {
			apiKey: "test",
			fetch: mockFetch,
			onSseEvent: (event: RawSseEvent) => {
				if (event.event === "message_stop") stopSeen.resolve();
			},
		};
		const firstResult = stream(model, context(), options).result();
		await stopSeen.promise;
		const secondResult = stream(model, context(), options).result();
		// Give the queued request time to start early while the first transport
		// is still draining the body after message_stop.
		await Bun.sleep(150);
		releaseTail.resolve();
		const [first, second] = await Promise.all([firstResult, secondResult]);
		expect(first.content).toEqual([{ type: "text", text: "first" }]);
		expect(second.content).toEqual([{ type: "text", text: "second" }]);
		expect(overlapped).toBe(false);
	}, 10_000);

	test("frees its slot before the caller sees the result", async () => {
		registerMockApi();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["first"] }, { content: ["second"] }] });
		let waited = false;
		__providerInFlightForTesting.setWaitObserver(() => {
			waited = true;
		});

		await streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } }).result();
		// A follow-up issued from the result never queues behind the request that produced it.
		const second = await streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } }).result();

		expect(second.content).toEqual([{ type: "text", text: "second" }]);
		expect(waited).toBe(false);
	});

	test("dispatches once the slot broker grants the request and gives the slot back after", async () => {
		registerMockApi();
		const asked = Promise.withResolvers<void>();
		const grant = Promise.withResolvers<void>();
		const released: string[] = [];
		configureProviderSlotBroker({
			async acquire(provider, limit) {
				asked.resolve();
				await grant.promise;
				return () => released.push(`${provider}/${limit}`);
			},
		});
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });

		const result = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 2 } }).result();
		await asked.promise;
		expect(mock.calls).toHaveLength(0);
		grant.resolve();

		expect((await result).content).toEqual([{ type: "text", text: "reply" }]);
		expect(released).toEqual(["tests/2"]);
	});

	test("frees this process's slot when a request is aborted while the broker holds it back", async () => {
		registerMockApi();
		const asked = Promise.withResolvers<void>();
		configureProviderSlotBroker({
			acquire(_provider, _limit, signal) {
				asked.resolve();
				const held = Promise.withResolvers<() => void>();
				signal?.addEventListener("abort", () => held.reject(signal.reason), { once: true });
				return held.promise;
			},
		});
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const controller = new AbortController();
		const held = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		}).result();
		await asked.promise;
		controller.abort(new Error("cancel brokered request"));
		await expect(held).rejects.toThrow("cancel brokered request");

		configureProviderSlotBroker(undefined);
		let waited = false;
		__providerInFlightForTesting.setWaitObserver(() => {
			waited = true;
		});
		const next = await streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } }).result();
		expect(next.content).toEqual([{ type: "text", text: "reply" }]);
		expect(waited).toBe(false);
		expect(mock.calls).toHaveLength(1);
	});

	test("removes an aborted queued request without dispatching it", async () => {
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let callIndex = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				callIndex++;
				if (callIndex === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return { content: [`reply ${callIndex}`] };
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		const controller = new AbortController();
		const second = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});
		controller.abort(new Error("cancel queued request"));

		await expect(second.result()).rejects.toThrow("cancel queued request");
		expect(mock.calls).toHaveLength(1);

		releaseFirst.resolve();
		await firstResult;
		expect(mock.calls).toHaveLength(1);
	});

	test("does not dispatch when aborted immediately after slot acquisition", async () => {
		registerMockApi();
		const controller = new AbortController();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const stream = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			signal: controller.signal,
		});

		controller.abort(new Error("cancel acquired request"));

		await expect(stream.result()).rejects.toThrow("cancel acquired request");
		expect(mock.calls).toHaveLength(0);
	});
});
