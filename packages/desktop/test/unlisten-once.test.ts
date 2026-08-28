import { describe, expect, test } from "bun:test";
import { unlistenOnce } from "../src/rpc/transport";

/*
 * Tauri's unlisten is neither idempotent nor safe to call: its injected script
 * reads `listeners[eventId].handlerId` having checked only that the *event* has
 * a listener map, so a second call throws on `undefined` — and since `_unlisten`
 * is async, that throw surfaces as an unhandled rejection, which under `bun dev`
 * is a full-screen overlay. This is the wrapper that makes it a non-event.
 */
describe("unlistenOnce", () => {
	test("releases the listener exactly once, however many times it is called", () => {
		let calls = 0;
		const stop = unlistenOnce(() => {
			calls++;
		});

		stop();
		stop();
		stop();

		expect(calls).toBe(1);
	});

	test("a synchronous throw does not reach the caller", () => {
		const stop = unlistenOnce(() => {
			throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
		});

		expect(() => stop()).not.toThrow();
	});

	test("a rejected unlisten never reaches the unhandled-rejection handler", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const stop = unlistenOnce(() =>
				Promise.reject(new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")),
			);

			stop();
			// An unhandled rejection is reported after the microtask queue drains.
			await new Promise(resolve => setTimeout(resolve, 20));

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("a throw on the first call still marks it spent", () => {
		let calls = 0;
		const stop = unlistenOnce(() => {
			calls++;
			throw new Error("boom");
		});

		stop();
		stop();

		expect(calls).toBe(1);
	});
});
