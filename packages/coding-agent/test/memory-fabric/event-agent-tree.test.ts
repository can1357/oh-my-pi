import { describe, expect, it } from "bun:test";
import type { AgentRoster } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-agent-tree";
import { projectAgentActivity } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-agent-tree";
import type { EventTimeline, TimelineRow } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-timeline";

function row(seq: number, overrides: Partial<TimelineRow> = {}): TimelineRow {
	return {
		seq,
		timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
		epochMs: 1700000000000 + seq * 1000,
		deltaMs: null,
		elapsedMs: null,
		kind: "memory-write",
		category: "memory",
		sessionId: "sess-1",
		sessionEventIndex: 0,
		recordId: `mem-${seq}`,
		projectId: "proj-1",
		agentId: "agent-a",
		taskId: null,
		memoryType: "fact",
		result: null,
		summary: `wrote fact mem-${seq}`,
		...overrides,
	};
}

function timelineOf(rows: TimelineRow[]): EventTimeline {
	return { mode: "observe", rowCount: rows.length, rows, sessions: [] };
}

describe("projectAgentActivity", () => {
	it("returns the empty projection for missing or empty timelines", () => {
		expect(projectAgentActivity(undefined).agents).toEqual([]);
		const empty = projectAgentActivity(timelineOf([]));
		expect(empty.mode).toBe("observe");
		expect(empty.roots).toEqual([]);
		expect(empty.roleDrift).toEqual([]);
	});

	it("accumulates observed activity per agent", () => {
		const projection = projectAgentActivity(
			timelineOf([
				row(1),
				row(2, { memoryType: "decision", projectId: "proj-2" }),
				row(3, { agentId: "agent-b", sessionId: "sess-2" }),
			]),
		);
		const a = projection.agents.find(n => n.agentId === "agent-a");
		expect(a?.eventCount).toBe(2);
		expect(a?.projects).toEqual(["proj-1", "proj-2"]);
		expect(a?.memoryTypes).toEqual(["decision", "fact"]);
		expect(a?.firstSeq).toBe(1);
		expect(a?.lastSeq).toBe(2);
		expect(a?.observed).toBe(true);
		const b = projection.agents.find(n => n.agentId === "agent-b");
		expect(b?.sessions).toEqual(["sess-2"]);
	});

	it("builds the assigned hierarchy from the injected roster", () => {
		const roster: AgentRoster = {
			"agent-root": { role: "planner" },
			"agent-a": { role: "coder", parentId: "agent-root" },
			"agent-b": { role: "reviewer", parentId: "agent-root" },
		};
		const projection = projectAgentActivity(timelineOf([row(1)]), { roster });
		const root = projection.agents.find(n => n.agentId === "agent-root");
		expect(root?.children).toEqual(["agent-a", "agent-b"]);
		expect(root?.depth).toBe(0);
		expect(projection.agents.find(n => n.agentId === "agent-a")?.depth).toBe(1);
		expect(projection.roots).toEqual(["agent-root"]);
	});

	it("is cycle-safe when the roster's parent chain loops", () => {
		const roster: AgentRoster = {
			"agent-a": { parentId: "agent-b" },
			"agent-b": { parentId: "agent-a" },
		};
		const projection = projectAgentActivity(timelineOf([row(1)]), { roster });
		const a = projection.agents.find(n => n.agentId === "agent-a");
		expect(a?.depth).toBe(1);
	});

	it("flags memory-type and project drift only against declared constraints", () => {
		const roster: AgentRoster = {
			"agent-a": { role: "coder", allowedMemoryTypes: ["fact"], allowedProjects: ["proj-1"] },
			"agent-b": {},
		};
		const projection = projectAgentActivity(
			timelineOf([
				row(1, { memoryType: "decision" }),
				row(2, { projectId: "proj-2" }),
				row(3, { agentId: "agent-b", memoryType: "episode", projectId: "proj-9" }),
			]),
			{ roster },
		);
		const kinds = projection.roleDrift.map(f => f.kind).sort();
		expect(kinds).toEqual(["memory-type", "project"]);
		const memDrift = projection.roleDrift.find(f => f.kind === "memory-type");
		expect(memDrift?.agentId).toBe("agent-a");
		expect(memDrift?.observed).toBe("decision");
		expect(memDrift?.allowed).toEqual(["fact"]);
		expect(memDrift?.reason).toContain("agent-a");
		// agent-b declared no constraints, so its activity is never drift.
		expect(projection.roleDrift.some(f => f.agentId === "agent-b")).toBe(false);
	});

	it("lists observed-but-unrostered agents", () => {
		const projection = projectAgentActivity(timelineOf([row(1), row(2, { agentId: "agent-x" })]), {
			roster: { "agent-a": { role: "coder" } },
		});
		expect(projection.unrostered).toEqual(["agent-x"]);
	});

	it("skips rows without a usable agent id", () => {
		const projection = projectAgentActivity(timelineOf([row(1, { agentId: null }), row(2)]));
		expect(projection.agents.length).toBe(1);
		expect(projection.agents[0]?.agentId).toBe("agent-a");
	});

	it("tolerates a hostile roster object without throwing", () => {
		const roster = { "agent-a": "garbage", "": { role: "x" } } as unknown as AgentRoster;
		const projection = projectAgentActivity(timelineOf([row(1)]), { roster });
		expect(projection.mode).toBe("observe");
		expect(projection.agents.find(n => n.agentId === "agent-a")?.role).toBeNull();
	});
});
