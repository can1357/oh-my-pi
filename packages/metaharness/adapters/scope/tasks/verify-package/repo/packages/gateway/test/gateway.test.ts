import { expect, test } from "bun:test";
import { RateLimiter } from "../src/gateway";

test("a burst within capacity goes straight through", async () => {
	const limiter = new RateLimiter(5, 400);
	const started = Date.now();
	for (let call = 0; call < 5; call++) await limiter.acquire();
	expect(Date.now() - started).toBeLessThan(200);
});

test("calls past capacity wait for refills", async () => {
	const limiter = new RateLimiter(2, 400);
	const started = Date.now();
	for (let call = 0; call < 22; call++) await limiter.acquire();
	expect(Date.now() - started).toBeGreaterThanOrEqual(20 * 400 - 100);
}, 20_000);
