import { describe, expect, test, vi } from "bun:test";
import { LRUCache } from "../src/lru";

describe("LRUCache", () => {
	test("matches recency, eviction, deletion, and dispose ordering", () => {
		const disposed: [number, string, string][] = [];
		const cache = new LRUCache<string, number>({
			max: 3,
			dispose: (value, key, reason) => disposed.push([value, key, reason]),
		});
		cache.set("a", 1).set("b", 2).set("c", 3);
		const initial = [...cache.keys()];
		cache.get("a");
		const touched = [...cache.keys()];
		cache.set("a", 4);
		cache.set("d", 5);
		cache.delete("a");
		cache.clear();

		// Goldens retain the values formerly supplied by the upstream lru-cache runtime comparison.
		expect({ initial, touched, disposed, size: cache.size }).toEqual({
			initial: ["c", "b", "a"],
			touched: ["a", "c", "b"],
			disposed: [
				[1, "a", "set"],
				[2, "b", "evict"],
				[4, "a", "delete"],
				[3, "c", "delete"],
				[5, "d", "delete"],
			],
			size: 0,
		});
	});

	test("matches calculated-size eviction and oversized-entry rejection", () => {
		const disposed: [number, string, string][] = [];
		const cache = new LRUCache<string, number>({
			max: 5,
			maxSize: 5,
			maxEntrySize: 4,
			sizeCalculation: value => value,
			dispose: (value, key, reason) => disposed.push([value, key, reason]),
		});
		cache.set("a", 2).set("b", 2).set("c", 2);
		const afterEviction = { keys: [...cache.keys()], size: cache.size, calculatedSize: cache.calculatedSize };
		cache.set("b", 9);
		cache.set("x", 9);
		const afterOversized = { keys: [...cache.keys()], size: cache.size, calculatedSize: cache.calculatedSize };
		cache.set("c", 3);

		// Goldens retain the values formerly supplied by the upstream lru-cache runtime comparison.
		expect({ afterEviction, afterOversized, disposed, calculatedSize: cache.calculatedSize }).toEqual({
			afterEviction: { keys: ["c", "b"], size: 2, calculatedSize: 4 },
			afterOversized: { keys: ["c"], size: 1, calculatedSize: 2 },
			disposed: [
				[2, "a", "evict"],
				[2, "b", "set"],
				[2, "c", "set"],
			],
			calculatedSize: 3,
		});
	});

	test("matches stale has and peek behavior", async () => {
		const disposed: [number, string, string][] = [];
		const cache = new LRUCache<string, number>({
			max: 2,
			ttl: 8,
			dispose: (value, key, reason) => disposed.push([value, key, reason]),
		});
		cache.set("a", 1);
		// Integration against the cache's performance-based clock requires real elapsed time.
		await Bun.sleep(20);
		const has = cache.has("a");
		const peek = cache.peek("a");
		const sizeBeforeGet = cache.size;
		const get = cache.get("a");

		// Golden retains the values formerly supplied by the upstream lru-cache runtime comparison.
		expect({ has, peek, sizeBeforeGet, get, disposed }).toEqual({
			has: false,
			peek: undefined,
			sizeBeforeGet: 1,
			get: undefined,
			disposed: [[1, "a", "expire"]],
		});
	});

	test("matches updateAgeOnGet", () => {
		// Drive the cache's performance.now() clock deterministically — the real
		// clock version (30ms TTL, 20ms sleeps) raced CI load and flaked.
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const cache = new LRUCache<string, number>({ max: 2, ttl: 30, updateAgeOnGet: true });
			cache.set("a", 1);
			now = 20;
			expect(cache.get("a")).toBe(1); // refreshes the entry's age to t=20
			now = 40;
			expect(cache.has("a")).toBe(true); // 20ms since refresh < 30ms TTL
			now = 60;
			expect(cache.has("a")).toBe(false); // 40ms since refresh > 30ms TTL
		} finally {
			clock.mockRestore();
		}
	});
});
