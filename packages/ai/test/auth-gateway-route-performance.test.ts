import { describe, expect, it } from "bun:test";
import type { RouteAttemptRecord } from "@oh-my-pi/pi-ai/auth-gateway/route-performance";
import { RoutePerformanceStore } from "@oh-my-pi/pi-ai/auth-gateway/route-performance";

function record(
	store: RoutePerformanceStore,
	overrides: Partial<RouteAttemptRecord> & Pick<RouteAttemptRecord, "routeId" | "target" | "durationMs">,
): void {
	const attempt: RouteAttemptRecord = {
		success: true,
		...overrides,
	};
	store.record(attempt);
}

describe("RoutePerformanceStore", () => {
	it("averages meanDurationMs across two successes", () => {
		const store = new RoutePerformanceStore();
		record(store, { routeId: "r1", target: "openai", durationMs: 100 });
		record(store, { routeId: "r1", target: "openai", durationMs: 200 });
		expect(store.summary("r1", "openai")).toEqual({
			attempts: 2,
			successes: 2,
			meanDurationMs: 150,
		});
	});

	it("returns undefined for an unknown route (negative)", () => {
		const store = new RoutePerformanceStore();
		record(store, { routeId: "r1", target: "openai", durationMs: 100 });
		expect(store.summary("missing", "openai")).toBeUndefined();
	});

	it("returns undefined when the store has no rows (negative)", () => {
		const store = new RoutePerformanceStore();
		expect(store.summary("r1", "openai")).toBeUndefined();
	});

	it("returns undefined for a known route with an unknown target (negative)", () => {
		const store = new RoutePerformanceStore();
		record(store, { routeId: "r1", target: "openai", durationMs: 100 });
		expect(store.summary("r1", "anthropic")).toBeUndefined();
	});

	it("counts failures in attempts but not successes", () => {
		const store = new RoutePerformanceStore();
		record(store, { routeId: "r1", target: "openai", durationMs: 100, success: true });
		record(store, { routeId: "r1", target: "openai", durationMs: 300, success: false });
		expect(store.summary("r1", "openai")).toEqual({
			attempts: 2,
			successes: 1,
			meanDurationMs: 200,
		});
	});

	it("evicts the oldest record once the FIFO cap of 10000 is exceeded", () => {
		const store = new RoutePerformanceStore();
		record(store, { routeId: "first", target: "t", durationMs: 1 });
		for (let i = 0; i < 10_000; i += 1) {
			record(store, { routeId: "later", target: "t", durationMs: 2 });
		}
		expect(store.summary("first", "t")).toBeUndefined();
		expect(store.summary("later", "t")).toEqual({
			attempts: 10_000,
			successes: 10_000,
			meanDurationMs: 2,
		});
	});
});
