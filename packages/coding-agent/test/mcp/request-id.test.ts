import { describe, expect, it } from "bun:test";

import { RequestIdAllocator } from "../../src/mcp/request-id";

describe("RequestIdAllocator", () => {
	it("defaults to sequential integer ids", () => {
		const allocator = new RequestIdAllocator();

		expect([allocator.next(undefined), allocator.next(undefined), allocator.next("number")]).toEqual([1, 2, 3]);
	});

	it("issues unique snowflake strings for servers opting into string ids", () => {
		const allocator = new RequestIdAllocator();
		const ids = [allocator.next("string"), allocator.next("string"), allocator.next("string")];

		expect(ids.every(id => typeof id === "string")).toBe(true);
		expect(new Set(ids).size).toBe(3);
	});

	it("counts independently per transport instance", () => {
		const first = new RequestIdAllocator();
		const second = new RequestIdAllocator();

		first.next("number");
		first.next("number");

		expect(second.next("number")).toBe(1);
	});

	it("reads the format at call time so a reconfigured server takes effect", () => {
		const allocator = new RequestIdAllocator();

		expect(typeof allocator.next("string")).toBe("string");
		expect(allocator.next(undefined)).toBe(1);
	});

	it("never reuses a numeric id, so a reconnect cannot collide with a late reply", () => {
		const allocator = new RequestIdAllocator();
		const before = allocator.next("number");
		allocator.next("string");

		expect(allocator.next("number")).toBeGreaterThan(before as number);
	});
});
