import { expect, test } from "bun:test";
import { MAX_RETRIES } from "../src/config";
import { withRetry } from "../src/retry";

test("gives up after MAX_RETRIES attempts", async () => {
	let calls = 0;
	const failing = async () => {
		calls++;
		throw new Error("down");
	};
	await expect(withRetry(failing)).rejects.toThrow("down");
	expect(calls).toBe(MAX_RETRIES);
});

test("returns once a later attempt succeeds", async () => {
	let calls = 0;
	const flaky = async () => {
		calls++;
		if (calls < 3) throw new Error("flaky");
		return "ok";
	};
	expect(await withRetry(flaky)).toBe("ok");
});

test("backs off exponentially under sustained failure", async () => {
	const started = Date.now();
	const failing = async () => {
		throw new Error("down");
	};
	await expect(withRetry(failing, 6)).rejects.toThrow("down");
	expect(Date.now() - started).toBeGreaterThanOrEqual(7_750);
}, 15_000);
