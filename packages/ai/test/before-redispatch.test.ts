/**
 * `StreamOptions.beforeRedispatch`: the hook a caller uses to keep the requests
 * this layer sends on its own — a thinking-loop re-sample, an attempt with a
 * rotated credential — under the same rule as its first one. Neither loop
 * re-enters the caller's own retry callback, so without the hook a caller that
 * gates paid requests (omp's `/pause`) has no say over them.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { clearCustomApis, registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockContent, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { completeSimple, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const SOURCE_ID = "before-redispatch-test";
const API = "before-redispatch-test" as Api;

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

describe("beforeRedispatch", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	test("holds a thinking-loop re-sample until the hook resolves", async () => {
		registerMockApi();
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			for (let i = 0; i < 4; i++) mock.push(loopResponse());
			const held = Promise.withResolvers<void>();
			let holds = 0;

			const result = completeSimple(mock.model, context(), {
				beforeRedispatch: async () => {
					holds += 1;
					if (holds === 1) await held.promise;
				},
			});
			await Bun.sleep(5);

			// The guard wanted a second sample; the hook has not let it go.
			expect(holds).toBe(1);
			expect(mock.calls).toHaveLength(1);

			held.resolve();
			const message = await result;
			expect(mock.calls).toHaveLength(3);
			expect(holds).toBe(2); // once per re-sample, never for the caller's own first dispatch
			expect(message.stopReason).toBe("error");
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});

	test("holds an attempt with a rotated credential until the hook resolves", async () => {
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
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: API,
						provider: "test-provider",
						model: "test-model",
						timestamp: 1,
						stopReason: "stop",
						usage: usage(),
					};
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
			beforeRedispatch: async () => {
				holds += 1;
				await held.promise;
			},
		});
		const drained = (async () => {
			for await (const _event of stream) {
				// drain
			}
			return stream.result();
		})();
		await Bun.sleep(5);

		// The 401 rotated a key, and the retry waits on the hook.
		expect(holds).toBe(1);
		expect(keys).toEqual(["old-key"]);

		held.resolve();
		const message = await drained;
		expect(keys).toEqual(["old-key", "refresh-key"]);
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
	});
});
