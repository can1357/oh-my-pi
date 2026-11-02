import { describe, expect } from "bun:test";
import { TestCleanup } from "./test-cleanup";
import { trackTestLifetime } from "./test-lifetime";

const { test } = trackTestLifetime();

describe("TestCleanup", () => {
	test("runs every release before it awaits a disposal, so a disposal that hangs cannot keep a registration alive", async () => {
		const cleanup = new TestCleanup();
		const released: string[] = [];
		await cleanup.add(() => Promise.withResolvers<void>().promise);
		cleanup.release(() => released.push("api"));

		void cleanup.end();

		expect(released).toEqual(["api"]);
	});

	test("disposes newest first after the releases and reports every failure instead of stopping at the first", async () => {
		const cleanup = new TestCleanup();
		const order: string[] = [];
		await cleanup.add(() => {
			order.push("first");
			throw new Error("first disposal failed");
		});
		await cleanup.add(() => order.push("second"));
		cleanup.release(() => {
			order.push("release");
			throw new Error("release failed");
		});

		const failures = await cleanup.end();

		expect(order).toEqual(["release", "second", "first"]);
		expect(failures.map(String)).toEqual(["Error: release failed", "Error: first disposal failed"]);
	});

	test("a body that resumes after its test ended disposes what it creates at once and stops", async () => {
		const cleanup = new TestCleanup();
		await cleanup.end();
		let disposed = false;

		await expect(
			cleanup.add(() => {
				disposed = true;
			}),
		).rejects.toThrow("resumed after its test ended");
		expect(disposed).toBe(true);
	});

	test("lets a live test write shared state and stops a body that resumed after its test ended", async () => {
		const cleanup = new TestCleanup();
		cleanup.assertLive();

		const ending = cleanup.end();

		expect(() => cleanup.assertLive()).toThrow("resumed after its test ended");
		await ending;
	});
});

describe("a body that outlives its test and reaches the next test's cleanup", () => {
	const nextCleanup = Promise.withResolvers<TestCleanup>();
	const disposals: string[] = [];
	let stale: Promise<string> | undefined;

	test("ends with a registration on another test's cleanup still pending", () => {
		stale = (async () => {
			const cleanup = await nextCleanup.promise;
			try {
				await cleanup.add(() => disposals.push("stale body's resource"));
				return "registered";
			} catch (error) {
				return (error as Error).message;
			}
		})();
		// The body returns here with its registration pending, so this test ends while it waits.
	});

	test("sees that body dispose its own resource at once and stop, and never runs that disposal again", async () => {
		const cleanup = new TestCleanup();
		nextCleanup.resolve(cleanup);

		expect(await stale).toBe("this test body resumed after its test ended; it cleaned up and stopped");
		expect(disposals).toEqual(["stale body's resource"]);

		expect(await cleanup.end()).toEqual([]);
		expect(disposals).toEqual(["stale body's resource"]);
	});
});
