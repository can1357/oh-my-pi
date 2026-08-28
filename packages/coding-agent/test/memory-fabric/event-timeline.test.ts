import { describe, expect, it } from "bun:test";
import type { MemoryLifecycleEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-timeline";
import { projectEventTimeline } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-timeline";
import { createMemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";

function writeEvent(seq: number, overrides: Partial<MemoryLifecycleEvent> = {}): MemoryLifecycleEvent {
	const record = createMemoryRecord({
		type: "fact",
		projectId: "proj-1",
		agentId: "agent-a",
		taskId: "task-1",
		content: `fact ${seq}`,
		sourceRefs: [{ type: "manual", id: `src-${seq}` }],
	});
	return {
		seq,
		type: "memory-write",
		timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
		sessionId: "sess-1",
		recordId: record.id,
		record,
		...overrides,
	};
}

describe("projectEventTimeline", () => {
	it("returns an empty observe report for no events", () => {
		const timeline = projectEventTimeline([]);
		expect(timeline.mode).toBe("observe");
		expect(timeline.rowCount).toBe(0);
		expect(timeline.rows).toEqual([]);
		expect(timeline.sessions).toEqual([]);
	});

	it("orders rows by seq with a stable index tiebreak", () => {
		const timeline = projectEventTimeline([writeEvent(3), writeEvent(1), writeEvent(2)]);
		expect(timeline.rows.map(r => r.seq)).toEqual([1, 2, 3]);
	});

	it("computes delta and elapsed timing from timestamps", () => {
		const timeline = projectEventTimeline([writeEvent(1), writeEvent(2), writeEvent(3)]);
		expect(timeline.rows[0]?.deltaMs).toBeNull();
		expect(timeline.rows[0]?.elapsedMs).toBe(0);
		expect(timeline.rows[1]?.deltaMs).toBe(1000);
		expect(timeline.rows[2]?.elapsedMs).toBe(2000);
	});

	it("skips malformed events instead of throwing", () => {
		const bad = [null, 42, { seq: "x" }, { seq: 1, type: "bogus", timestamp: "t", sessionId: "s" }];
		const timeline = projectEventTimeline([...(bad as unknown as MemoryLifecycleEvent[]), writeEvent(5)]);
		expect(timeline.rowCount).toBe(1);
		expect(timeline.rows[0]?.seq).toBe(5);
	});

	it("categorizes and summarizes each lifecycle kind", () => {
		const events: MemoryLifecycleEvent[] = [
			writeEvent(1),
			writeEvent(2, { type: "memory-update" }),
			{
				seq: 3,
				type: "memory-delete",
				timestamp: "2024-01-01T00:00:03Z",
				sessionId: "sess-1",
				recordId: "mem-x",
			},
			{
				seq: 4,
				type: "checkpoint",
				timestamp: "2024-01-01T00:00:04Z",
				sessionId: "sess-1",
				checkpoint: { currentStep: "compile", testStatus: "passing" },
			},
			{
				seq: 5,
				type: "maintenance",
				timestamp: "2024-01-01T00:00:05Z",
				sessionId: "sess-1",
				maintenance: { operation: "decay", affectedIds: ["a", "b"] },
			},
		];
		const timeline = projectEventTimeline(events);
		expect(timeline.rows.map(r => r.category)).toEqual(["memory", "memory", "memory", "checkpoint", "maintenance"]);
		expect(timeline.rows[0]?.summary).toMatch(/^wrote fact /);
		expect(timeline.rows[1]?.summary).toMatch(/^updated fact /);
		expect(timeline.rows[2]?.summary).toBe("deleted mem-x");
		expect(timeline.rows[3]?.summary).toBe("checkpoint: compile");
		expect(timeline.rows[3]?.result).toBe("passing");
		expect(timeline.rows[4]?.summary).toBe("maintenance: decay (2 affected)");
		expect(timeline.rows[4]?.result).toBe("decay");
	});

	it("filters by session and by category", () => {
		const events = [
			writeEvent(1),
			writeEvent(2, { sessionId: "sess-2" }),
			{
				seq: 3,
				type: "maintenance",
				timestamp: "2024-01-01T00:00:03Z",
				sessionId: "sess-1",
				maintenance: { operation: "dedup" },
			} satisfies MemoryLifecycleEvent,
		];
		const bySession = projectEventTimeline(events, { sessionIds: ["sess-2"] });
		expect(bySession.rows.map(r => r.seq)).toEqual([2]);
		const byCategory = projectEventTimeline(events, { categories: ["maintenance"] });
		expect(byCategory.rows.map(r => r.seq)).toEqual([3]);
	});

	it("rolls up sessions with counts, spans, and distinct scopes", () => {
		const timeline = projectEventTimeline([writeEvent(1), writeEvent(2), writeEvent(10, { sessionId: "sess-2" })]);
		expect(timeline.sessions.length).toBe(2);
		const first = timeline.sessions[0];
		expect(first?.sessionId).toBe("sess-1");
		expect(first?.eventCount).toBe(2);
		expect(first?.firstSeq).toBe(1);
		expect(first?.lastSeq).toBe(2);
		expect(first?.durationMs).toBe(1000);
		expect(first?.agents).toEqual(["agent-a"]);
		expect(first?.projects).toEqual(["proj-1"]);
		expect(first?.byCategory.memory).toBe(2);
	});

	it("marks unparseable timestamps as null timing without failing", () => {
		const timeline = projectEventTimeline([writeEvent(1, { timestamp: "not-a-date" })]);
		expect(timeline.rows[0]?.epochMs).toBeNull();
		expect(timeline.rows[0]?.deltaMs).toBeNull();
		expect(timeline.rows[0]?.elapsedMs).toBeNull();
	});

	it("does not mutate its input", () => {
		const events = [writeEvent(2), writeEvent(1)];
		const before = JSON.stringify(events);
		projectEventTimeline(events);
		expect(JSON.stringify(events)).toBe(before);
	});
});
