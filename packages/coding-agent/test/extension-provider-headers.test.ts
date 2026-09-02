import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { wrapStreamFnWithProviderHeaders } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/provider-headers";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { wrapStreamFnWithProviderConcurrency } from "@oh-my-pi/pi-coding-agent/task/provider-concurrency";

/** Minimal runner stand-in: only the two members the wrapper consumes. */
function fakeRunner(
	subscribed: boolean,
	edit?: (headers: Record<string, string>) => void,
): { runner: ExtensionRunner; seen: Record<string, string>[] } {
	const seen: Record<string, string>[] = [];
	const runner = {
		hasHandlers: (event: string) => subscribed && event === "before_provider_headers",
		emitBeforeProviderHeaders: async (headers: Record<string, string>) => {
			seen.push(headers);
			edit?.(headers);
			return headers;
		},
	} as unknown as ExtensionRunner;
	return { runner, seen };
}

/** Records the options each call receives, and returns an empty stream. */
function recordingBase(): { base: StreamFn; calls: (Record<string, string> | undefined)[] } {
	const calls: (Record<string, string> | undefined)[] = [];
	const base: StreamFn = (_model, _context, options) => {
		calls.push(options?.headers);
		return new AssistantMessageEventStream();
	};
	return { base, calls };
}

const model = { provider: "test", id: "test-model", api: "openai-completions" } as never;
const context = {} as never;

describe("wrapStreamFnWithProviderHeaders", () => {
	it("forwards to base untouched when nothing subscribes", async () => {
		const { runner, seen } = fakeRunner(false);
		const { base, calls } = recordingBase();
		const original = { "x-a": "1" };

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, { headers: original });

		expect(seen).toHaveLength(0);
		// No copy is made on this path, so base sees the caller's own object.
		expect(calls[0]).toBe(original);
	});

	it("applies handler edits to the headers base receives", async () => {
		const { runner } = fakeRunner(true, headers => {
			headers["x-added"] = "yes";
		});
		const { base, calls } = recordingBase();

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, { headers: { "x-a": "1" } });

		expect(calls[0]).toEqual({ "x-a": "1", "x-added": "yes" });
	});

	it("does not let handlers mutate the caller's options object", async () => {
		const { runner } = fakeRunner(true, headers => {
			headers["x-added"] = "yes";
		});
		const { base } = recordingBase();
		const original = { "x-a": "1" };

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, { headers: original });

		expect(original).toEqual({ "x-a": "1" });
	});

	it("supplies an object to handlers even when the caller sent no headers", async () => {
		const { runner, seen } = fakeRunner(true);
		const { base, calls } = recordingBase();

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, {});

		expect(seen[0]).toEqual({});
		expect(calls[0]).toEqual({});
	});

	// Ordering regression: the hook is composed INSIDE the concurrency limiter, so a
	// request that queues behind a busy provider runs its handlers when it wins the
	// slot — not when it joins the queue. Composed the other way round, a request
	// aborted while queued would still have run every handler, and a handler minting
	// a short-lived or timestamped header would have minted it at queue time.
	it("runs handlers only after the provider concurrency slot is won", async () => {
		const { runner, seen } = fakeRunner(true);
		const streams: AssistantMessageEventStream[] = [];
		const base: StreamFn = () => {
			const stream = new AssistantMessageEventStream();
			streams.push(stream);
			return stream;
		};
		// `ollama-cloud` is the provider that has a configured cap; 1 makes the
		// second request queue behind the first deterministically.
		const settings = { get: () => 1 } as unknown as Settings;
		const capped = { provider: "ollama-cloud", id: "test-model", api: "openai-completions" } as never;
		const wrapped = wrapStreamFnWithProviderConcurrency(settings, wrapStreamFnWithProviderHeaders(runner, base));

		const first = await wrapped(capped, context, { headers: { "x-a": "1" } });
		const second = wrapped(capped, context, { headers: { "x-b": "2" } });
		try {
			await Bun.sleep(10);

			// The queued request has not run its handlers, because it holds no slot yet.
			expect(seen).toHaveLength(1);
			expect(streams).toHaveLength(1);

			first.end();
			await second;

			expect(seen).toHaveLength(2);
			expect(seen[1]).toEqual({ "x-b": "2" });
		} finally {
			// BOTH streams must end, including on a failed assertion. The semaphore is
			// module-global and keyed by provider, so a slot left held here is held for
			// the whole Bun process: later files using `ollama-cloud` (issues #3749 and
			// #3751) then block on a cap this file never released.
			first.end();
			(await second)?.end();
		}
	});

	// Blob-url fallback retries the inner StreamFn before content is emitted.
	// That retry wrapper must sit INSIDE the header hook: if it wrapped the hook,
	// each fallback would re-run before_provider_headers and break the
	// once-per-request contract.
	it("runs handlers once when the inner transport retries before emitting content", async () => {
		const { runner, seen } = fakeRunner(true);
		const { base, calls } = recordingBase();
		const retryOnce =
			(inner: StreamFn): StreamFn =>
			async (model, context, options) => {
				await inner(model, context, options);
				return inner(model, context, options);
			};

		await wrapStreamFnWithProviderHeaders(runner, retryOnce(base))(model, context, { headers: { "x-a": "1" } });

		expect(seen).toHaveLength(1);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ "x-a": "1" });
		expect(calls[1]).toEqual({ "x-a": "1" });
	});
});
