import { describe, expect, test } from "bun:test";
import { TestCleanup } from "./test-cleanup";

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
});
