import { expect, test } from "bun:test";
import { sleepFor } from "../src/sleep";

test("sleeps for the parsed duration", async () => {
	const started = performance.now();
	await sleepFor("3s");
	expect(performance.now() - started).toBeGreaterThanOrEqual(2_990);
}, 10_000);

test("accepts milliseconds", async () => {
	const started = performance.now();
	await sleepFor("1500ms");
	expect(performance.now() - started).toBeGreaterThanOrEqual(1_490);
}, 10_000);
