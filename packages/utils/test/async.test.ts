import { describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { MAX_TIMER_DELAY_MS, sleepLong } from "@oh-my-pi/pi-utils/async";

describe("sleepLong", () => {
	it("exposes the signed 32-bit timer ceiling", () => {
		expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
	});

	it("sleeps sub-ceiling delays in a single timer wait", async () => {
		const spy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			await sleepLong(60_000);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0]).toBe(60_000);
		} finally {
			spy.mockRestore();
		}
	});

	it("chunks over-ceiling delays so no single timer overflows", async () => {
		const spy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			await sleepLong(MAX_TIMER_DELAY_MS + 1_000);
			expect(spy).toHaveBeenCalledTimes(2);
			expect(spy.mock.calls[0]?.[0]).toBe(MAX_TIMER_DELAY_MS);
			expect(spy.mock.calls[1]?.[0]).toBe(1_000);
		} finally {
			spy.mockRestore();
		}
	});

	it("propagates aborts without arming a timer", async () => {
		const spy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const controller = new AbortController();
			controller.abort();
			await expect(sleepLong(MAX_TIMER_DELAY_MS + 1_000, controller.signal)).rejects.toThrow(
				"The operation was aborted",
			);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("rejects a pre-aborted zero-length sleep", async () => {
		const spy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const controller = new AbortController();
			controller.abort();
			await expect(sleepLong(0, controller.signal)).rejects.toThrow("The operation was aborted");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
