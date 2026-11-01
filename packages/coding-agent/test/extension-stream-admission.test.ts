/**
 * What an admitted call produces is declared by the call site, not guessed from the value.
 *
 * Two rounds were spent inspecting the returned value, and it was wrong in both directions: a
 * terminal `result()` that is a CALLABLE thenable was missed, so a restricted child's stream
 * outlived its credential restriction; and an ordinary async-iterable data collection carrying an
 * unrelated lazy `result()` was claimed as outstanding work, its method invoked for nothing. The
 * author chooses the shape; the host knows what it is starting.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import {
	type Api,
	type AssistantMessage,
	clearCustomApis,
	createAssistantMessageEventStream,
	type Model,
	registerCustomApi,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { providerCallGate } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/callback-ownership";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const tick = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await setImmediate();
};

describe("admitted work is tracked by its declared kind", () => {
	it("holds a declared stream open until a callable thenable completion settles", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const done = Promise.withResolvers<void>();
		// A terminal that is a function carrying `then`: as awaitable as a Promise, and the shape
		// the previous predicate rejected.
		const completion = Object.assign(function callableTerminal() {}, {
			// oxlint-disable-next-line unicorn/no-thenable -- the completion under test is a callable thenable
			then: done.promise.then.bind(done.promise),
		});
		const stream = {
			// oxlint-disable-next-line require-yield -- an empty stream: it ends when `done` settles
			async *[Symbol.asyncIterator]() {
				await done.promise;
			},
			result: () => completion,
		};

		expect(runtime.runOwned(() => stream, "stream")).toBe(stream);
		expect(runtime.hasPendingCallbacks()).toBe(true);
		done.resolve();
		await runtime.waitForPendingCallbacks();
		expect(runtime.hasPendingCallbacks()).toBe(false);
		release();
	});

	it("holds a declared stream open until it really ends", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const stream = createAssistantMessageEventStream();
		expect(runtime.runOwned(() => stream, "stream")).toBe(stream);
		await tick();
		expect(runtime.hasPendingCallbacks()).toBe(true);

		let drained = false;
		const waited = runtime.waitForPendingCallbacks().then(() => {
			drained = true;
		});
		await tick();
		expect(drained).toBe(false);

		stream.fail(new Error("stream ended"));
		await waited;
		expect(runtime.hasPendingCallbacks()).toBe(false);
		release();
	});

	it("follows a promise of a producer through to the producer", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const stream = createAssistantMessageEventStream();
		const produced = await runtime.runOwned(async () => stream, "stream");
		expect(produced).toBe(stream);
		await tick();
		// The promise settled long ago; what is still outstanding is the stream it resolved.
		expect(runtime.hasPendingCallbacks()).toBe(true);
		stream.fail(new Error("stream ended"));
		await runtime.waitForPendingCallbacks();
		release();
	});

	it("refuses a declared stream that cannot say when it is finished", () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		// Declared a stream by its call site, but it reports no terminal. Treating it as already
		// complete is how a producer outlives the session that owns it, so it is refused.
		expect(() => runtime.runOwned(() => ({ iterate: () => undefined }), "stream")).toThrow("reported no completion");
		expect(runtime.hasPendingCallbacks()).toBe(false);
		release();
	});

	it("leaves an ordinary callback's async-iterable data alone, `result` and all", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		let resultCalls = 0;
		let iteratorCalls = 0;
		// A handler returning a lazy collection: `result()` is its own unrelated operation, which
		// may never settle, and nobody has asked for it.
		const collection = {
			// oxlint-disable-next-line require-yield -- an empty collection: only the iteration is counted
			async *[Symbol.asyncIterator]() {
				iteratorCalls++;
			},
			result: () => {
				resultCalls++;
				return Promise.withResolvers<void>().promise;
			},
		};

		expect(runtime.runOwned(() => collection)).toBe(collection);
		await tick();
		expect({ resultCalls, iteratorCalls, pending: runtime.hasPendingCallbacks() }).toEqual({
			resultCalls: 0,
			iteratorCalls: 0,
			pending: false,
		});
		release();
	});
});

/** A thenable whose `then` getter answers with `then` on its first read and `undefined` after: the
 *  shape that tells a single read, as `await` makes, from a predicate read followed by another. */
function oneShotThenable(then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void) {
	const counts = { reads: 0, calls: 0 };
	const value = {
		// oxlint-disable-next-line unicorn/no-thenable -- the value under test is a thenable read once
		get then() {
			counts.reads++;
			if (counts.reads > 1) return undefined;
			return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
				counts.calls++;
				then(resolve, reject);
			};
		},
	};
	return { value, counts };
}

describe("a thenable is asked `await`'s question once", () => {
	it("reads a callback's `then` once and adopts the operation that read returned", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const work = Promise.withResolvers<string>();
		const { value, counts } = oneShotThenable((resolve, reject) => work.promise.then(resolve, reject));

		// The runtime hands back the operation it adopted in place of the thenable.
		const observed = runtime.runOwned(() => value) as unknown as Promise<unknown>;
		await tick();
		expect({ ...counts, pending: runtime.hasPendingCallbacks() }).toEqual({ reads: 1, calls: 1, pending: true });
		work.resolve("terminal");
		// What `await value` would have produced: the operation, not the object.
		expect(await observed).toBe("terminal");
		await runtime.waitForPendingCallbacks();
		expect(counts).toEqual({ reads: 1, calls: 1 });
		release();
	});

	it("calls the `then` it read on the value, and a `then` that throws rejects as assimilation does", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const failure = new Error("then threw");
		let receiver: unknown;
		const value = {
			// oxlint-disable-next-line unicorn/no-thenable -- the value under test is a thenable whose `then` throws
			then(this: unknown) {
				receiver = this;
				throw failure;
			},
		};

		const observed = runtime.runOwned(() => value) as unknown as Promise<unknown>;
		expect(observed).not.toBe(value);
		expect(
			await observed.then(
				() => "fulfilled",
				(error: unknown) => error,
			),
		).toBe(failure);
		expect(receiver).toBe(value);
		await runtime.waitForPendingCallbacks();
		expect(runtime.hasPendingCallbacks()).toBe(false);
		release();
	});

	it("reads a declared stream's `result` and its completion's `then` once each", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const done = Promise.withResolvers<void>();
		const { value: completion, counts } = oneShotThenable((resolve, reject) => done.promise.then(resolve, reject));
		let resultReads = 0;
		const stream = {
			get result() {
				resultReads++;
				return resultReads === 1 ? () => completion : undefined;
			},
		};

		expect(runtime.runOwned(() => stream, "stream")).toBe(stream);
		await tick();
		expect({ resultReads, ...counts, pending: runtime.hasPendingCallbacks() }).toEqual({
			resultReads: 1,
			reads: 1,
			calls: 1,
			pending: true,
		});
		done.resolve();
		await runtime.waitForPendingCallbacks();
		expect(runtime.hasPendingCallbacks()).toBe(false);
		release();
	});

	it("reads a promised producer's `then` once and follows the producer it resolves", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const stream = createAssistantMessageEventStream();
		const { value: promised, counts } = oneShotThenable(resolve => resolve(stream));

		const produced = await (runtime.runOwned(() => promised, "stream") as unknown as Promise<unknown>);
		expect(produced).toBe(stream);
		expect(counts).toEqual({ reads: 1, calls: 1 });
		await tick();
		expect(runtime.hasPendingCallbacks()).toBe(true);
		stream.fail(new Error("stream ended"));
		await runtime.waitForPendingCallbacks();
		release();
	});
});

describe("a session's custom API stream, held by the runtime's own gate", () => {
	const API = "stream-admission-api";
	// An official endpoint without the loop guard: nothing but the admitted consumer reads the stream.
	// The resolved compat flag, set as the ai package's own admission tests set it.
	const official = { compat: { officialEndpoint: true } } as Partial<Model<Api>>;
	const model: Model<Api> = { ...createMockModel().model, api: API, ...official };
	const options = { apiKey: "key", loopGuard: { enabled: false } };

	function reply(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "authored" }],
			api: API,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
	}

	afterEach(clearCustomApis);

	it("holds the session through the authored iterator's asynchronous finally, and lets go of the caller's signal with it", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const inside: boolean[] = [];
		registerCustomApi(
			API,
			() => {
				const output = createAssistantMessageEventStream();
				output[Symbol.asyncIterator] = async function* () {
					try {
						const message = reply();
						output.push({ type: "done", reason: "stop", message });
						yield { type: "done", reason: "stop", message };
					} finally {
						inside.push(extensionCallbackScope.getStore() === runtime);
						entered.resolve();
						await finish.promise;
						inside.push(extensionCallbackScope.getStore() === runtime);
					}
				};
				return output;
			},
			"stream-admission-test",
			undefined,
			providerCallGate(runtime),
		);
		const controller = new AbortController();
		const listening = new Set<unknown>();
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
			if (args[0] === "abort") listening.add(args[1]);
			add(...args);
		};
		controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
			if (args[0] === "abort") listening.delete(args[1]);
			remove(...args);
		};

		// The caller's result settles at the terminal, before the close the host starts there.
		await streamSimple(model, { messages: [] }, { ...options, signal: controller.signal }).result();
		await entered.promise;
		await tick();
		const duringFinally = { pending: runtime.hasPendingCallbacks(), listening: listening.size };
		finish.resolve();
		await runtime.waitForPendingCallbacks();
		await tick();

		expect(duringFinally).toEqual({ pending: true, listening: 1 });
		expect({ pending: runtime.hasPendingCallbacks(), listening: listening.size }).toEqual({
			pending: false,
			listening: 0,
		});
		expect(inside).toEqual([true, true]);
		release();
	});

	it("calls a producer's result() once when it ends without a terminal event", async () => {
		const runtime = new ExtensionRuntime();
		const release = runtime.beginSession();
		let resultCalls = 0;
		registerCustomApi(
			API,
			() => {
				const output = createAssistantMessageEventStream();
				const own = output.result.bind(output);
				output.result = () => {
					resultCalls++;
					return own();
				};
				queueMicrotask(() => output.end(reply()));
				return output;
			},
			"stream-admission-test",
			undefined,
			providerCallGate(runtime),
		);

		const message = await streamSimple(model, { messages: [] }, options).result();
		await runtime.waitForPendingCallbacks();

		expect(message.content).toEqual([{ type: "text", text: "authored" }]);
		expect(resultCalls).toBe(1);
		release();
	});
});
