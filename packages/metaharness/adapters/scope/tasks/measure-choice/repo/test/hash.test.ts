import { expect, test } from "bun:test";
import { HASHES, type HashName } from "../src/config";
import { fnv1a } from "../src/hash/fnv1a";
import { KeyTable } from "../src/table";

test("fnv1a matches the published test vectors", () => {
	expect(fnv1a("")).toBe(0x811c9dc5);
	expect(fnv1a("a")).toBe(0xe40c292c);
	expect(fnv1a("foobar")).toBe(0xbf9cf968);
});

test.each(Object.keys(HASHES) as HashName[])("%s is a stable unsigned 32-bit hash", name => {
	const hash = HASHES[name];
	for (const key of ["", "a", "order:1042", "ключ", "x".repeat(300)]) {
		expect(hash(key)).toBe(hash(key));
		expect(hash(key)).toBeGreaterThanOrEqual(0);
		expect(hash(key)).toBeLessThanOrEqual(0xffffffff);
	}
	expect(hash("order:1042")).not.toBe(hash("order:1043"));
});

test("the table stores, overwrites, and misses", () => {
	const table = new KeyTable<number>(8);
	for (let n = 0; n < 100; n++) table.set(`key-${n}`, n);
	table.set("key-7", 700);
	expect(table.get("key-7")).toBe(700);
	expect(table.get("key-99")).toBe(99);
	expect(table.get("absent")).toBeUndefined();
});
