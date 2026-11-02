import { describe, expect, test } from "bun:test";
import { trackTestLifetime } from "./test-lifetime";

const lifetime = trackTestLifetime();

describe("trackTestLifetime", () => {
	test("permits a write by the test that captured the run, before and after an await", async () => {
		const run = lifetime.capture();

		expect(() => run.assertLive()).not.toThrow();
		await Bun.sleep(1);
		expect(() => run.assertLive()).not.toThrow();
	});

	// A timed-out body: it captures its run, suspends, and resumes while the next test is running.
	const release = Promise.withResolvers<void>();
	let resumedBody: Promise<string> | undefined;

	test("a body that outlives its test keeps a run captured before it suspended", () => {
		const run = lifetime.capture();
		resumedBody = release.promise.then(() => {
			try {
				run.assertLive();
				return "reached shared state";
			} catch (error) {
				return (error as Error).message;
			}
		});
		// The body stays suspended here, so this test ends while it is still running.
	});

	test("stops that body, although this later test is itself live", async () => {
		release.resolve();

		expect(await resumedBody).toBe(
			"this test body resumed after its test ended; it stopped before touching shared state",
		);
		expect(() => lifetime.capture().assertLive()).not.toThrow();
	});
});
