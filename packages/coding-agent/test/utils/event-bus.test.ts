import { afterEach, describe, expect, it, vi } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("EventBus", () => {
	it("serializes and coalesces latest-state delivery independently per observer", async () => {
		const eventBus = new EventBus();
		const releaseSlow = Promise.withResolvers<void>();
		const slowReachedLatest = Promise.withResolvers<void>();
		const fastReachedLatest = Promise.withResolvers<void>();
		const slowCalls: number[] = [];
		const fastCalls: number[] = [];
		let slowActive = 0;
		let maxSlowActive = 0;

		eventBus.on("state", async value => {
			if (typeof value !== "number") throw new Error("expected numeric state");
			slowCalls.push(value);
			slowActive += 1;
			maxSlowActive = Math.max(maxSlowActive, slowActive);
			try {
				if (value === 1) await releaseSlow.promise;
				if (value === 3) slowReachedLatest.resolve();
			} finally {
				slowActive -= 1;
			}
		});
		eventBus.on("state", value => {
			if (typeof value !== "number") throw new Error("expected numeric state");
			fastCalls.push(value);
			if (value === 3) fastReachedLatest.resolve();
		});

		eventBus.emitLatest("state", 1);
		eventBus.emitLatest("state", 2);
		eventBus.emitLatest("state", 3);

		expect(slowCalls).toEqual([1]);
		await fastReachedLatest.promise;
		expect(fastCalls).toEqual([1, 3]);
		expect(slowCalls).toEqual([1]);

		releaseSlow.resolve();
		await slowReachedLatest.promise;
		expect(slowCalls).toEqual([1, 3]);
		expect(maxSlowActive).toBe(1);
	});

	it("drops a pending latest-state snapshot when its observer unsubscribes", async () => {
		const eventBus = new EventBus();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const calls: number[] = [];
		const unsubscribe = eventBus.on("state", async value => {
			if (typeof value !== "number") throw new Error("expected numeric state");
			calls.push(value);
			if (value === 1) await release.promise;
			finished.resolve();
		});

		eventBus.emitLatest("state", 1);
		eventBus.emitLatest("state", 2);
		unsubscribe();
		release.resolve();
		await finished.promise;
		await Promise.resolve();

		expect(calls).toEqual([1]);
	});

	it("continues latest-state delivery after an observer failure", async () => {
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const eventBus = new EventBus();
		const delivered = Promise.withResolvers<void>();
		const calls: number[] = [];
		eventBus.on("state", value => {
			if (typeof value !== "number") throw new Error("expected numeric state");
			calls.push(value);
			if (value === 1) throw new Error("observer failed");
			delivered.resolve();
		});

		eventBus.emitLatest("state", 1);
		eventBus.emitLatest("state", 2);
		await delivered.promise;

		expect(calls).toEqual([1, 2]);
		expect(error).toHaveBeenCalledWith("Event handler error", {
			channel: "state",
			error: "Error: observer failed",
		});
	});

	it("preserves normal emit delivery without coalescing", () => {
		const eventBus = new EventBus();
		const calls: number[] = [];
		eventBus.on("event", value => {
			if (typeof value !== "number") throw new Error("expected numeric event");
			calls.push(value);
		});

		eventBus.emit("event", 1);
		eventBus.emit("event", 2);

		expect(calls).toEqual([1, 2]);
	});
});
