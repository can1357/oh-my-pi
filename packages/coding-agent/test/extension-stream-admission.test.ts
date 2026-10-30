/**
 * What an admitted call produces is declared by the call site, not guessed from the value.
 *
 * Two rounds were spent inspecting the returned value, and it was wrong in both directions: a
 * terminal `result()` that is a CALLABLE thenable was missed, so a restricted child's stream
 * outlived its credential restriction; and an ordinary async-iterable data collection carrying an
 * unrelated lazy `result()` was claimed as outstanding work, its method invoked for nothing. The
 * author chooses the shape; the host knows what it is starting.
 */
import { describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

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
			then: done.promise.then.bind(done.promise),
		});
		const stream = {
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
