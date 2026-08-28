import { describe, expect, test } from "bun:test";
import { coalesce } from "../src/shell/coalesce";

/** A job you can finish on demand, so the interleavings are exact, not timed. */
function deferrable() {
	const finishers: Array<() => void> = [];
	let started = 0;
	const run = () => {
		started++;
		return new Promise<void>(resolve => finishers.push(resolve));
	};
	return {
		run,
		get started() {
			return started;
		},
		finish() {
			finishers.shift()?.();
		},
	};
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("coalesce", () => {
	test("runs immediately when idle", async () => {
		const job = deferrable();
		coalesce(job.run)();
		expect(job.started).toBe(1);
	});

	test("a call during a run is not dropped — it runs once, afterwards", async () => {
		// This is the whole point. A plain in-flight skip would settle the result
		// on the world the running job already read past.
		const job = deferrable();
		const refresh = coalesce(job.run);

		refresh();
		expect(job.started).toBe(1);

		refresh();
		refresh();
		refresh();
		expect(job.started).toBe(1); // still just the one in flight

		job.finish();
		await settle();
		expect(job.started).toBe(2); // three requests collapsed into one repeat

		job.finish();
		await settle();
		expect(job.started).toBe(2); // and it stops there
	});

	test("a failed run still releases the queue", async () => {
		let started = 0;
		const refresh = coalesce(async () => {
			started++;
			throw new Error("listing failed");
		});

		refresh();
		await settle();
		refresh();
		await settle();

		expect(started).toBe(2);
	});

	test("a rejection never escapes as an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			coalesce(() => Promise.reject(new Error("boom")))();
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("sequential calls each run", async () => {
		const job = deferrable();
		const refresh = coalesce(job.run);

		refresh();
		job.finish();
		await settle();
		refresh();
		job.finish();
		await settle();

		expect(job.started).toBe(2);
	});
});
