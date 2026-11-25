import { expect, test } from "bun:test";
import { Store } from "../src/store";

test("reads back a copy of what it wrote", async () => {
	const store = new Store();
	const doc = { n: 1 };
	await store.write("a", doc);
	doc.n = 2;
	expect(await store.read("a")).toEqual({ n: 1 });
});

test("scans by prefix in key order, then removes", async () => {
	const store = new Store();
	await store.write("x:2", "b");
	await store.write("y:1", "c");
	await store.write("x:1", "a");
	expect(await store.scan("x:")).toEqual([
		["x:1", "a"],
		["x:2", "b"],
	]);
	expect(await store.remove("x:1")).toBe(true);
	expect(await store.remove("x:1")).toBe(false);
});

test("fails only the next operation on request", async () => {
	const store = new Store();
	store.failNext(new Error("disk full"));
	await expect(store.write("a", 1)).rejects.toThrow("disk full");
	await store.write("a", 1);
	expect(await store.read("a")).toBe(1);
});

test("callback API reports results and errors", done => {
	const store = new Store();
	store.set("k", "v", error => {
		expect(error).toBeNull();
		store.get("k", (_, value) => {
			expect(value).toBe("v");
			store.failNext(new Error("boom"));
			store.del("k", error => {
				expect(error?.message).toBe("boom");
				done();
			});
		});
	});
});
