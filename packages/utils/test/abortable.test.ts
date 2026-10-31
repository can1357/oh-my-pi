import { afterEach, describe, expect, test } from "bun:test";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";

describe("untilAborted with an already-aborted signal", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		unhandled.length = 0;
	});

	test("keeps observing a passed promise that rejects after the caller left", async () => {
		process.on("unhandledRejection", onUnhandled);
		const work = Promise.withResolvers<never>();
		const raced = untilAborted(AbortSignal.abort(new Error("stop")), work.promise);
		work.reject(new Error("late failure"));
		await expect(raced).rejects.toThrow("Aborted: stop");
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(unhandled).toEqual([]);
	});

	test("never starts work passed as a function", async () => {
		let started = false;
		const raced = untilAborted(AbortSignal.abort(new Error("stop")), async () => {
			started = true;
		});
		await expect(raced).rejects.toThrow("Aborted: stop");
		expect(started).toBe(false);
	});
});
