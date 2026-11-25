import { expect, test } from "bun:test";
import { Upstream } from "../src/upstream";

test("answers every slug in turn at the configured latency", async () => {
	const upstream = new Upstream(250);
	const started = Date.now();
	for (let n = 0; n < 20; n++) expect(await upstream.resolve(`link-${n}`)).toBe(`https://go.example/link-${n}`);
	expect(Date.now() - started).toBeGreaterThanOrEqual(20 * 250 - 50);
}, 15_000);
