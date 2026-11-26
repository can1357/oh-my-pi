import { expect, test } from "bun:test";
import { TtlCache } from "../src/cache";

test("expires entries after the ttl", async () => {
	const cache = new TtlCache<number>(3_000);
	cache.set("a", 1);
	expect(cache.get("a")).toBe(1);
	await Bun.sleep(3_100);
	expect(cache.get("a")).toBeUndefined();
}, 10_000);

test("keeps entries until the ttl", async () => {
	const cache = new TtlCache<number>(5_000);
	cache.set("a", 1);
	await Bun.sleep(4_000);
	expect(cache.get("a")).toBe(1);
}, 10_000);
