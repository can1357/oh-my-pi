import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type RequestHolds, type RequestHoldView, runOutsideRequestHolds, runWithRequestHolds } from "@oh-my-pi/pi-ai";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { __providerInFlightForTesting, stream } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, Model, StreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { bedrockHappyPathFrames, bedrockTestModel } from "./helpers/bedrock-stream";

class Hold implements RequestHolds {
	readonly checked = Promise.withResolvers<void>();
	readonly released = Promise.withResolvers<void>();
	#held: boolean;
	constructor(held = true) {
		this.#held = held;
	}
	arm(): void {
		this.#held = true;
	}
	open(): RequestHoldView {
		return {
			check: () => {
				if (this.#held) this.checked.resolve();
				return this.#held ? this.released.promise : undefined;
			},
			release() {},
		};
	}
	let(): void {
		this.#held = false;
		this.released.resolve();
	}
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const watchdogMs = 100;

function ollamaModel(baseUrl: string): Model<"ollama-chat"> {
	return buildModel({
		id: "test-model",
		name: "Test model",
		api: "ollama-chat",
		provider: "held-capacity-test",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 512,
	});
}

function ollamaReply(): Response {
	return new Response(
		`${JSON.stringify({ model: "test-model", message: { role: "assistant", content: "hi" }, done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 })}\n`,
		{ headers: { "content-type": "application/x-ndjson" } },
	);
}

/** Uses the platform clock for Bun's real HTTP abort behavior; fake timers do not advance socket I/O. */
async function exceedWatchdog(): Promise<void> {
	const elapsed = Promise.withResolvers<void>();
	const timer = setTimeout(elapsed.resolve, watchdogMs * 2);
	try {
		await elapsed.promise;
	} finally {
		clearTimeout(timer);
	}
}

interface WatchdogProvider {
	name: string;
	start(baseUrl: string, options: StreamOptions): Promise<AssistantMessage>;
	reply(): Response;
}

const providers: WatchdogProvider[] = [
	{
		name: "Bedrock",
		start: (baseUrl, options) =>
			streamBedrock(bedrockTestModel({ baseUrl }), context, {
				...options,
				apiKey: "held-test-bearer",
				region: "us-east-1",
			}).result(),
		reply: () =>
			new Response(new Blob(bedrockHappyPathFrames()), {
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
	},
	{
		name: "Ollama",
		start: (baseUrl, options) => streamOllama(ollamaModel(baseUrl), context, { ...options, apiKey: "test" }).result(),
		reply: ollamaReply,
	},
	{
		name: "Bedrock through shared stream wrapper",
		start: (baseUrl, options) =>
			stream(bedrockTestModel({ baseUrl }), context, {
				...options,
				apiKey: "held-test-bearer",
				region: "us-east-1",
			}).result(),
		reply: () =>
			new Response(new Blob(bedrockHappyPathFrames()), {
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
	},
	{
		name: "Ollama through shared stream wrapper",
		start: (baseUrl, options) => stream(ollamaModel(baseUrl), context, { ...options, apiKey: "test" }).result(),
		reply: ollamaReply,
	},
];

afterEach(() => vi.restoreAllMocks());

describe("request holds do not spend network capacity or time", () => {
	for (const retry of [false, true]) {
		it(
			retry
				? "releases a retry's slot while its next attempt is held"
				: "lets an exempt same-provider request release a held request at capacity one",
			async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-held-capacity-"));
				__providerInFlightForTesting.setRoot(root);
				const hold = new Hold(!retry);
				const controller = new AbortController();
				const order: string[] = [];
				const server = Bun.serve({
					port: 0,
					hostname: "127.0.0.1",
					fetch(request) {
						if (retry && order.length === 0) {
							order.push("first");
							hold.arm();
							return Response.json({ error: "retry me" }, { status: 429, headers: { "retry-after": "0" } });
						}
						order.push(request.headers.get("x-request") ?? "missing");
						return ollamaReply();
					},
				});
				let deadlineHit = false;
				const deadline = setTimeout(() => {
					deadlineHit = true;
					controller.abort(new Error("held request deadlocked"));
				}, 2000);
				try {
					const model = ollamaModel(server.url.href);
					const options = {
						apiKey: "test",
						maxInFlightRequests: { [model.provider]: 1 },
						signal: controller.signal,
					};
					const held = runWithRequestHolds(hold, () =>
						stream(model, context, { ...options, headers: { "x-request": "held" } }).result(),
					);
					await hold.checked.promise;
					const exempt = await runWithRequestHolds(hold, () =>
						runOutsideRequestHolds(hold, () =>
							stream(model, context, { ...options, headers: { "x-request": "exempt" } }).result(),
						),
					);
					hold.let();
					const result = await held;
					expect(deadlineHit).toBe(false);
					expect(exempt.stopReason).toBe("stop");
					expect(result.stopReason).toBe("stop");
					expect(order).toEqual(retry ? ["first", "exempt", "held"] : ["exempt", "held"]);
				} finally {
					clearTimeout(deadline);
					controller.abort();
					hold.let();
					server.stop(true);
					__providerInFlightForTesting.setRoot(undefined);
					await fs.rm(root, { recursive: true, force: true });
				}
			},
		);
	}

	for (const provider of providers) {
		it(`${provider.name} sends once after a hold outlasts its first-event budget`, async () => {
			const hold = new Hold();
			let sends = 0;
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch() {
					sends++;
					return provider.reply();
				},
			});
			try {
				const result = runWithRequestHolds(hold, () =>
					provider.start(server.url.href, { streamFirstEventTimeoutMs: watchdogMs }),
				);
				await hold.checked.promise;
				await exceedWatchdog();
				expect(sends).toBe(0);
				hold.let();
				const message = await result;
				expect(message.errorMessage).toBeUndefined();
				expect(message.stopReason).toBe("stop");
				expect(sends).toBe(1);
			} finally {
				hold.let();
				server.stop(true);
			}
		});

		it(`${provider.name} still times out a real server after release without response headers`, async () => {
			const hold = new Hold();
			const received = Promise.withResolvers<void>();
			const reply = Promise.withResolvers<Response>();
			let sends = 0;
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch() {
					sends++;
					received.resolve();
					return reply.promise;
				},
			});
			try {
				const result = runWithRequestHolds(hold, () =>
					provider.start(server.url.href, { streamFirstEventTimeoutMs: watchdogMs }),
				);
				await hold.checked.promise;
				await exceedWatchdog();
				hold.let();
				const message = await result;
				expect(sends).toBe(1);
				await received.promise;
				expect(message.stopReason).toBe("error");
				expect(message.errorMessage).toMatch(/timed out|timeout/i);
			} finally {
				hold.let();
				reply.resolve(provider.reply());
				server.stop(true);
			}
		});

		it(`${provider.name} preserves caller cancellation during an over-budget hold without sending`, async () => {
			const hold = new Hold();
			const controller = new AbortController();
			let sends = 0;
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch() {
					sends++;
					return provider.reply();
				},
			});
			try {
				const result = runWithRequestHolds(hold, () =>
					provider.start(server.url.href, { signal: controller.signal, streamFirstEventTimeoutMs: watchdogMs }),
				);
				await hold.checked.promise;
				await exceedWatchdog();
				controller.abort(new Error("caller cancelled held request"));
				const message = await result;
				expect(message.stopReason).toBe("aborted");
				expect(message.errorMessage).not.toMatch(/timed out|timeout/i);
				expect(sends).toBe(0);
			} finally {
				controller.abort();
				hold.let();
				server.stop(true);
			}
		});
	}
});
