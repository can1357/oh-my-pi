import { describe, expect, it } from "bun:test";
import { RouteDecisionTraceLog } from "@oh-my-pi/pi-ai/auth-gateway";

describe("RouteDecisionTraceLog", () => {
	it("requires an allow-listed reason for skipped dispositions", () => {
		const log = new RouteDecisionTraceLog();
		expect(() =>
			log.record({
				requestId: "r1",
				routeId: "gpt-5",
				generation: 1,
				selectedTarget: "gpt-5",
				disposition: "skipped",
			}),
		).toThrow(/reason/);
	});

	it("evicts the oldest traces once the ring exceeds 2000", () => {
		const log = new RouteDecisionTraceLog();
		const now = 1_700_000_000_000;
		for (let i = 0; i < 2001; i += 1) {
			log.record(
				{
					requestId: `r${i}`,
					routeId: "m",
					generation: 1,
					selectedTarget: "m",
					disposition: "dispatched",
				},
				now,
			);
		}
		const traces = log.list(now);
		expect(traces.length).toBe(2000);
		expect(traces[0]?.requestId).toBe("r1");
		expect(traces[1999]?.requestId).toBe("r2000");
	});

	it("evicts traces older than the 30 minute TTL", () => {
		const log = new RouteDecisionTraceLog();
		const now = 1_700_000_000_000;
		log.record(
			{
				requestId: "old",
				routeId: "m",
				generation: 1,
				selectedTarget: "m",
				disposition: "dispatched",
			},
			now,
		);
		log.record(
			{
				requestId: "fresh",
				routeId: "m",
				generation: 1,
				selectedTarget: "m",
				disposition: "dispatched",
			},
			now + 60_000,
		);
		const traces = log.list(now + 30 * 60 * 1000 + 1);
		expect(traces.map(t => t.requestId)).toEqual(["fresh"]);
		expect(traces.some(t => t.requestId === "old")).toBe(false);
	});

	it("recorded payload has no prompt field", () => {
		const log = new RouteDecisionTraceLog();
		const trace = log.record({
			requestId: "r1",
			routeId: "gpt-5",
			generation: 1,
			selectedTarget: "gpt-5",
			disposition: "dispatched",
		});
		expect("prompt" in trace).toBe(false);
		expect(JSON.stringify(trace)).not.toContain("prompt");
	});

	it("does not accept a skipped record with a secret-looking reason (negative)", () => {
		const log = new RouteDecisionTraceLog();
		expect(() =>
			log.record({
				requestId: "r1",
				routeId: "gpt-5",
				generation: 1,
				selectedTarget: "gpt-5",
				disposition: "skipped",
				reason: "email_leak" as never,
			}),
		).toThrow(/reason/);
	});

	it("isolates traces for two request ids", () => {
		const log = new RouteDecisionTraceLog();
		const now = 1_700_000_000_000;
		log.record(
			{
				requestId: "req-a",
				routeId: "m-a",
				generation: 1,
				selectedTarget: "m-a",
				disposition: "dispatched",
			},
			now,
		);
		log.record(
			{
				requestId: "req-b",
				routeId: "m-b",
				generation: 2,
				selectedTarget: "m-b",
				disposition: "skipped",
				reason: "quota_cutoff",
			},
			now,
		);
		log.record(
			{
				requestId: "req-a",
				routeId: "m-a-fallback",
				generation: 1,
				selectedTarget: "m-a-fallback",
				disposition: "not_reached",
			},
			now,
		);
		const a = log.get("req-a", now);
		const b = log.get("req-b", now);
		expect(a.map(t => t.routeId)).toEqual(["m-a", "m-a-fallback"]);
		expect(b.map(t => t.routeId)).toEqual(["m-b"]);
		expect(a.every(t => t.requestId === "req-a")).toBe(true);
		expect(b.every(t => t.requestId === "req-b")).toBe(true);
	});

	it("returns an empty array for an unknown requestId", () => {
		const log = new RouteDecisionTraceLog();
		log.record({
			requestId: "req-a",
			routeId: "m",
			generation: 1,
			selectedTarget: "m",
			disposition: "dispatched",
		});
		expect(log.get("missing")).toEqual([]);
	});
});
