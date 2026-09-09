import { describe, expect, it } from "bun:test";
import { RingBuffer } from "@oh-my-pi/pi-utils/ring";

describe("construction", () => {
	it("starts empty", () => {
		const rb = new RingBuffer<number>(4);
		expect(rb.length).toBe(0);
		expect(rb.capacity).toBe(4);
		expect(rb.isEmpty).toBe(true);
		expect(rb.isFull).toBe(false);
	});
});

describe("push", () => {
	it("adds items and tracks length", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		expect(rb.length).toBe(2);
		expect(rb.toArray()).toEqual([1, 2]);
	});

	it("returns undefined when not full", () => {
		const rb = new RingBuffer<number>(4);
		expect(rb.push(1)).toBeUndefined();
	});

	it("overwrites oldest and returns it when full", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		expect(rb.push(4)).toBe(1);
		expect(rb.push(5)).toBe(2);
		expect(rb.toArray()).toEqual([3, 4, 5]);
		expect(rb.length).toBe(3);
	});

	it("wraps around multiple times", () => {
		const rb = new RingBuffer<number>(2);
		for (let i = 0; i < 10; i++) rb.push(i);
		expect(rb.toArray()).toEqual([8, 9]);
	});
});

describe("shift", () => {
	it("removes from front in FIFO order", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		expect(rb.shift()).toBe(1);
		expect(rb.shift()).toBe(2);
		expect(rb.length).toBe(1);
		expect(rb.toArray()).toEqual([3]);
	});

	it("returns undefined when empty", () => {
		const rb = new RingBuffer<number>(4);
		expect(rb.shift()).toBeUndefined();
	});

	it("works after wraparound", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.push(4); // overwrites 1, head moves
		expect(rb.shift()).toBe(2);
		expect(rb.toArray()).toEqual([3, 4]);
	});
});

describe("pop", () => {
	it("removes from back", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		expect(rb.pop()).toBe(3);
		expect(rb.pop()).toBe(2);
		expect(rb.toArray()).toEqual([1]);
	});

	it("returns undefined when empty", () => {
		const rb = new RingBuffer<number>(4);
		expect(rb.pop()).toBeUndefined();
	});

	it("works after wraparound", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.push(4); // [4, 2, 3] head=1
		expect(rb.pop()).toBe(4);
		expect(rb.toArray()).toEqual([2, 3]);
	});
});

describe("unshift", () => {
	it("adds to front", () => {
		const rb = new RingBuffer<number>(4);
		rb.unshift(1);
		rb.unshift(2);
		expect(rb.toArray()).toEqual([2, 1]);
	});

	it("returns undefined when not full", () => {
		const rb = new RingBuffer<number>(4);
		expect(rb.unshift(1)).toBeUndefined();
	});

	it("overwrites newest and returns it when full", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		expect(rb.unshift(0)).toBe(3);
		expect(rb.toArray()).toEqual([0, 1, 2]);
	});
});

describe("at", () => {
	it("accesses by logical index", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(10);
		rb.push(20);
		rb.push(30);
		expect(rb.at(0)).toBe(10);
		expect(rb.at(1)).toBe(20);
		expect(rb.at(2)).toBe(30);
	});

	it("supports negative indices", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(10);
		rb.push(20);
		rb.push(30);
		expect(rb.at(-1)).toBe(30);
		expect(rb.at(-3)).toBe(10);
	});

	it("returns undefined for out of bounds", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		expect(rb.at(1)).toBeUndefined();
		expect(rb.at(-2)).toBeUndefined();
	});

	it("correct after wraparound", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.push(4);
		rb.push(5);
		expect(rb.at(0)).toBe(3);
		expect(rb.at(1)).toBe(4);
		expect(rb.at(2)).toBe(5);
	});
});

describe("peek / peekBack", () => {
	it("returns first and last without removing", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		expect(rb.peek()).toBe(1);
		expect(rb.peekBack()).toBe(3);
		expect(rb.length).toBe(3);
	});

	it("returns undefined when empty", () => {
		const rb = new RingBuffer<number>(4);
		expect(rb.peek()).toBeUndefined();
		expect(rb.peekBack()).toBeUndefined();
	});
});

describe("clear", () => {
	it("resets to empty", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.clear();
		expect(rb.length).toBe(0);
		expect(rb.isEmpty).toBe(true);
		expect(rb.toArray()).toEqual([]);
	});

	it("works normally after clear", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.clear();
		rb.push(10);
		rb.push(20);
		expect(rb.toArray()).toEqual([10, 20]);
	});
});

describe("iterator", () => {
	it("iterates in logical order", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.push(4); // wraps
		expect([...rb]).toEqual([2, 3, 4]);
	});

	it("yields nothing when empty", () => {
		const rb = new RingBuffer<number>(4);
		expect([...rb]).toEqual([]);
	});

	it("works with for-of", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(10);
		rb.push(20);
		const result: number[] = [];
		for (const v of rb) result.push(v);
		expect(result).toEqual([10, 20]);
	});
});

describe("toArray", () => {
	it("contiguous case", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		expect(rb.toArray()).toEqual([1, 2]);
	});

	it("wrapped case", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.push(4);
		rb.push(5);
		rb.push(6); // head=2, buf=[5,6,3,4]
		expect(rb.toArray()).toEqual([3, 4, 5, 6]);
	});

	it("returns new array each time", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		expect(rb.toArray()).not.toBe(rb.toArray());
	});
});

describe("mixed operations", () => {
	it("push/shift as a queue", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		expect(rb.shift()).toBe(1);
		rb.push(3);
		expect(rb.shift()).toBe(2);
		rb.push(4);
		expect(rb.shift()).toBe(3);
		rb.push(5);
		expect(rb.toArray()).toEqual([4, 5]);
	});

	it("push/pop as a stack", () => {
		const rb = new RingBuffer<number>(4);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		expect(rb.pop()).toBe(3);
		expect(rb.pop()).toBe(2);
		rb.push(10);
		expect(rb.toArray()).toEqual([1, 10]);
	});

	it("drain completely then refill", () => {
		const rb = new RingBuffer<number>(3);
		rb.push(1);
		rb.push(2);
		rb.push(3);
		rb.shift();
		rb.shift();
		rb.shift();
		expect(rb.isEmpty).toBe(true);
		rb.push(4);
		rb.push(5);
		expect(rb.toArray()).toEqual([4, 5]);
	});

	it("unshift then shift round-trips", () => {
		const rb = new RingBuffer<string>(4);
		rb.unshift("a");
		rb.unshift("b");
		rb.unshift("c");
		expect(rb.shift()).toBe("c");
		expect(rb.shift()).toBe("b");
		expect(rb.shift()).toBe("a");
		expect(rb.isEmpty).toBe(true);
	});

	it("works with non-primitive types", () => {
		const rb = new RingBuffer<{ id: number }>(2);
		const a = { id: 1 };
		const b = { id: 2 };
		rb.push(a);
		rb.push(b);
		expect(rb.shift()).toBe(a);
		expect(rb.shift()).toBe(b);
	});
});

describe("capacity 1 edge case", () => {
	it("single-element buffer", () => {
		const rb = new RingBuffer<number>(1);
		expect(rb.push(1)).toBeUndefined();
		expect(rb.push(2)).toBe(1);
		expect(rb.peek()).toBe(2);
		expect(rb.length).toBe(1);
		expect(rb.isFull).toBe(true);
		expect(rb.shift()).toBe(2);
		expect(rb.isEmpty).toBe(true);
	});
});
