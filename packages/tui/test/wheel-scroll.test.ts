import { describe, expect, it } from "bun:test";
import { WheelScrollAccelerator } from "@oh-my-pi/pi-tui/term/wheel-scroll";

describe("WheelScrollAccelerator", () => {
	it("keeps isolated and slow notches at one line", () => {
		const wheel = new WheelScrollAccelerator("auto", true);
		expect([0, 100, 250, 750].map(time => wheel.next(1, time))).toEqual([1, 1, 1, 1]);
	});

	it("accelerates a sustained spin without exceeding six lines per event", () => {
		const wheel = new WheelScrollAccelerator("auto", true);
		expect([0, 50, 100, 120, 140].map(time => wheel.next(1, time))).toEqual([1, 2, 2, 2, 4]);
		const fast = Array.from({ length: 30 }, (_, index) => wheel.next(1, 145 + index * 5));
		expect(fast.every(lines => Number.isInteger(lines) && lines >= 1 && lines <= 6)).toBe(true);
		expect(fast.at(-1)).toBe(6);
	});

	it("preserves fractional movement across notches instead of rounding it away", () => {
		const wheel = new WheelScrollAccelerator("auto", true);
		expect([0, 40, 80, 120, 160].map(time => wheel.next(1, time))).toEqual([1, 2, 3, 2, 3]);
	});

	it("does not accelerate high-resolution sub-five-millisecond bursts", () => {
		const wheel = new WheelScrollAccelerator("auto", true);
		expect([0, 4, 8, 12, 16].map(time => wheel.next(1, time))).toEqual([1, 1, 1, 1, 1]);
		expect(wheel.next(1, 21)).toBe(6);
	});

	it("resets velocity and fractional carry on direction reversal", () => {
		const wheel = new WheelScrollAccelerator("auto", true);
		expect(wheel.next(1, 0)).toBe(1);
		expect(wheel.next(1, 40)).toBe(2);
		expect(wheel.next(-1, 80)).toBe(1);
		expect(wheel.next(-1, 120)).toBe(2);
	});

	it("resets after a gesture pause rather than carrying fast-spin momentum", () => {
		const wheel = new WheelScrollAccelerator("auto", true);
		wheel.next(1, 0);
		expect(wheel.next(1, 40)).toBe(2);
		expect(wheel.next(1, 241)).toBe(1);
		expect(wheel.next(1, 281)).toBe(2);
	});

	it("avoids double acceleration when the terminal already accelerates events", () => {
		const wheel = new WheelScrollAccelerator("auto", false);
		expect([0, 20, 40, 60].map(time => wheel.next(1, time))).toEqual([1, 1, 1, 1]);
		wheel.setLines(3.9);
		expect(wheel.next(1, 80)).toBe(3);
	});

	it("normalizes fixed steps and ignores event velocity", () => {
		const wheel = new WheelScrollAccelerator(3.9, true);
		expect([0, 20, 21, 500].map(time => wheel.next(1, time))).toEqual([3, 3, 3, 3]);
		wheel.setLines(-2);
		expect(wheel.next(1, 520)).toBe(1);
		wheel.setLines(Number.NaN);
		expect(wheel.next(1, 540)).toBe(1);
	});

	it("starts a fresh gesture when changing the line-count policy", () => {
		const wheel = new WheelScrollAccelerator("auto", true);
		wheel.next(1, 0);
		expect(wheel.next(1, 40)).toBe(2);
		wheel.setLines(4);
		expect(wheel.next(1, 60)).toBe(4);
		wheel.setLines("auto");
		expect(wheel.next(1, 80)).toBe(1);
		expect(wheel.next(1, 120)).toBe(2);
	});
});
