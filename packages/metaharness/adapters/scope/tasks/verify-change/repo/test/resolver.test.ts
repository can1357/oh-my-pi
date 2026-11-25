import { expect, test } from "bun:test";
import { resolveWithRetry } from "../src/resolver";
import { Upstream } from "../src/upstream";

test("retries through an outage with exponential backoff", async () => {
	const upstream = new Upstream(250, 4);
	const started = Date.now();
	expect(await resolveWithRetry(upstream, "launch-notes")).toBe("https://go.example/launch-notes");
	expect(upstream.calls).toBe(5);
	expect(Date.now() - started).toBeGreaterThanOrEqual(3_750);
}, 15_000);

test("gives up after the last attempt", async () => {
	const upstream = new Upstream(250, 9);
	await expect(resolveWithRetry(upstream, "launch-notes")).rejects.toThrow("upstream unavailable");
	expect(upstream.calls).toBe(5);
}, 15_000);
