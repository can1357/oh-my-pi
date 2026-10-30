/**
 * `StreamOptions.beforeDispatch`: the hold a caller puts on every request this
 * layer puts on the wire. It runs at the provider-dispatch chokepoint
 * (`withProviderInFlightLimit`), after the credential, any command-backed
 * headers and the in-flight slot, and before the transport — the retries this
 * layer makes itself (thinking-loop re-sample, rotated credential) pass
 * through it, and a throw from it fails that attempt instead of hanging.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { clearCustomApis, registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as duoWorkflow from "@oh-my-pi/pi-ai/providers/gitlab-duo-workflow";
import { createMockModel, type MockContent, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { __providerInFlightForTesting, completeSimple, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, ModelSpec, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const SOURCE_ID = "before-dispatch-test";
const API = "before-dispatch-test" as Api;

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };
}

/** A degenerate near-duplicate reasoning loop: what the thinking-loop guard re-samples. */
function loopResponse(): { content: MockContent[] } {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const paragraphs: string[] = [];
	for (let i = 0; i < 12; i++) paragraphs.push(variants[i % variants.length]!);
	return { content: [{ type: "thinking", thinking: paragraphs.join("\n\n") }] };
}

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: API,
		provider: "test-provider",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: API,
		provider: "test-provider",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

let limiterRoot: string | undefined;

afterEach(async () => {
	unregisterCustomApis(SOURCE_ID);
	clearCustomApis();
	__providerInFlightForTesting.setRoot(undefined);
	__providerInFlightForTesting.setWaitObserver(undefined);
	if (limiterRoot !== undefined) {
		await fs.rm(limiterRoot, { recursive: true, force: true });
		limiterRoot = undefined;
	}
});

describe("beforeDispatch", () => {
	test("runs after command-backed headers resolve and before the transport", async () => {
		const order: string[] = [];
		registerCustomApi(
			API,
			() => {
				order.push("dispatch");
				const stream = new AssistantMessageEventStream();
				const message = reply();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);
		const headerModel = {
			...model(),
			resolveHeaders: async () => {
				order.push("headers");
				return { "x-test": "1" };
			},
		} as Model<Api>;

		const message = await streamSimple(headerModel, context(), {
			beforeDispatch: () => {
				order.push("hold");
			},
		}).result();

		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
		expect(order).toEqual(["headers", "hold", "dispatch"]);
	});

	test("runs after the in-flight slot is acquired, not before the wait", async () => {
		limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-before-dispatch-"));
		__providerInFlightForTesting.setRoot(limiterRoot);
		registerMockApi();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				calls += 1;
				if (calls === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return { content: [`reply ${calls}`] };
			},
		});

		const first = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });
		const firstResult = first.result();
		await firstStarted.promise;

		let holds = 0;
		const waiting = Promise.withResolvers<void>();
		__providerInFlightForTesting.setWaitObserver(provider => {
			if (provider === "tests") waiting.resolve();
		});
		const second = streamSimple(mock.model, context(), {
			maxInFlightRequests: { tests: 1 },
			beforeDispatch: () => {
				holds += 1;
			},
		});
		await waiting.promise;

		// The slot wait is an await of this layer's own: the hold must follow it.
		expect(holds).toBe(0);

		releaseFirst.resolve();
		await Promise.all([firstResult, second.result()]);
		expect(holds).toBe(1);
		expect(calls).toBe(2);
	});

	test("holds a thinking-loop re-sample until the hold resolves", async () => {
		registerMockApi();
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			for (let i = 0; i < 4; i++) mock.push(loopResponse());
			const held = Promise.withResolvers<void>();
			let holds = 0;

			const result = completeSimple(mock.model, context(), {
				beforeDispatch: async () => {
					holds += 1;
					if (holds === 2) await held.promise;
				},
			});
			await Bun.sleep(5);

			// One sample taken, the guard wants another, and the hold has it.
			expect(holds).toBe(2);
			expect(mock.calls).toHaveLength(1);

			held.resolve();
			const message = await result;
			expect(mock.calls).toHaveLength(3);
			expect(holds).toBe(3); // one per dispatch, re-samples included
			expect(message.stopReason).toBe("error");
		} finally {
			waitSpy.mockRestore();
		}
	});

	test("holds an attempt with a rotated credential until the hold resolves", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.fail(authError());
						return;
					}
					const message = reply();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);
		const held = Promise.withResolvers<void>();
		let holds = 0;

		const stream = streamSimple(model(), context(), {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "refresh-key"),
			beforeDispatch: async () => {
				holds += 1;
				if (holds === 2) await held.promise;
			},
		});
		const drained = (async () => {
			for await (const _event of stream) {
				// drain
			}
			return stream.result();
		})();
		await Bun.sleep(5);

		// The 401 rotated a key; that second attempt waits on the hold.
		expect(holds).toBe(2);
		expect(keys).toEqual(["old-key"]);

		held.resolve();
		const message = await drained;
		expect(keys).toEqual(["old-key", "refresh-key"]);
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
	});

	test("fails the attempt when the hold throws, instead of leaving the stream open", async () => {
		registerCustomApi(
			API,
			() => {
				throw new Error("the transport must never be reached");
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context(), {
			apiKey: async () => "old-key",
			beforeDispatch: () => {
				throw new Error("held and refused");
			},
		});
		const settled = await Promise.race([
			stream.result().then(
				message => message.errorMessage ?? "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			Bun.sleep(1_000).then(() => "hung"),
		]);

		expect(settled).toBe("held and refused");
	});

	// `gitlab-duo-agent` dispatched outside `withProviderInFlightLimit` and
	// healed leaked thinking itself, so it was the one request on the wire the
	// chokepoint never saw.
	test("holds the gitlab-duo-agent dispatch, which bypassed the chokepoint", async () => {
		const order: string[] = [];
		const duoSpy = spyOn(duoWorkflow, "streamGitLabDuoWorkflow").mockImplementation((() => {
			order.push("dispatch");
			const events = new AssistantMessageEventStream();
			queueMicrotask(() => {
				events.push({ type: "start", partial: reply() });
				events.push({ type: "done", reason: "stop", message: reply() });
			});
			return events;
		}) as never);
		try {
			const duoModel = {
				...model(),
				api: "gitlab-duo-agent" as Api,
				provider: "gitlab-duo-agent",
			} as Model<Api>;
			const stream = streamSimple(duoModel, context(), {
				apiKey: "duo-token",
				beforeDispatch: () => {
					order.push("hold");
				},
			});
			await stream.result();
		} finally {
			duoSpy.mockRestore();
		}

		expect(order).toEqual(["hold", "dispatch"]);
	});

	// Every other test here takes a custom, mock or GitLab branch, none of which
	// goes through `mapOptionsForApi`; an ordinary provider does, and the hold
	// has to survive that mapping.
	test("survives the option mapping an ordinary provider goes through", async () => {
		const order: string[] = [];
		const anthropic = buildModel({
			id: "claude-test",
			name: "Claude Test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000,
			maxTokens: 16,
		} satisfies ModelSpec<"anthropic-messages">);

		await streamSimple(anthropic, context(), {
			apiKey: "test-key",
			maxHttpAttempts: 1,
			fetch: async () => {
				order.push("request");
				return new Response("{}", { status: 400 });
			},
			beforeDispatch: () => {
				order.push("hold");
			},
		}).result();

		expect(order).toEqual(["hold", "request"]);
	});
});
