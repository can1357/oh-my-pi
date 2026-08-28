import { describe, expect, it } from "bun:test";

import type { AgentRoster } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-agent-tree";
import type { MemoryLifecycleEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-timeline";
import {
	buildObservabilityReport,
	exportObservabilityJson,
	renderAgentTreeText,
	renderObservability,
	renderObservabilityText,
	renderRoleDriftText,
	renderTimelineText,
	renderTokenBreakdownText,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/observability-report";
import type { TokenTelemetryEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/token-accounting/token-accounting";
import { accountTokens } from "@oh-my-pi/pi-coding-agent/memory-fabric/token-accounting/token-accounting";
import { createMemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";

const NOW = () => new Date("2026-01-01T00:00:00.000Z");

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

function tokenEvent(stage: string, before: number, after: number): TokenTelemetryEvent {
	return accountTokens(before, after, { stage, now: NOW });
}

const ROSTER: AgentRoster = {
	"agent-a": { role: "coder", parentId: "agent-root", allowedMemoryTypes: ["decision"] },
	"agent-root": { role: "planner" },
};

describe("buildObservabilityReport", () => {
	it("returns an inert observe report for empty input", () => {
		const report = buildObservabilityReport({}, { now: NOW });
		expect(report.mode).toBe("observe");
		expect(report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(report.summary.eventCount).toBe(0);
		expect(report.summary.agentCount).toBe(0);
		expect(report.summary.tokenEventCount).toBe(0);
		expect(report.timeline.rows).toEqual([]);
		expect(report.tokens.byStage).toEqual([]);
	});

	it("composes timeline, agent tree, and token breakdown into one summary", () => {
		const report = buildObservabilityReport(
			{
				events: [writeEvent(1), writeEvent(2)],
				tokenEvents: [tokenEvent("distill", 100, 40), tokenEvent("dedup", 100, 60)],
				roster: ROSTER,
			},
			{ now: NOW },
		);
		expect(report.summary.eventCount).toBe(2);
		expect(report.summary.sessionCount).toBe(1);
		expect(report.summary.agentCount).toBe(2);
		expect(report.summary.unrosteredCount).toBe(0);
		// agent-a wrote "fact" but is only allowed "decision" -> drift.
		expect(report.summary.roleDriftCount).toBe(1);
		expect(report.summary.tokenEventCount).toBe(2);
		expect(report.summary.tokensSaved).toBe(100);
		expect(report.summary.tokenPercentSaved).toBe(50);
	});

	it("forwards timeline and token filters", () => {
		const report = buildObservabilityReport(
			{
				events: [writeEvent(1), writeEvent(2, { sessionId: "sess-2" })],
				tokenEvents: [tokenEvent("distill", 10, 5), tokenEvent("dedup", 20, 10)],
			},
			{ timeline: { sessionIds: ["sess-2"] }, tokens: { stages: ["dedup"] }, now: NOW },
		);
		expect(report.summary.eventCount).toBe(1);
		expect(report.timeline.rows[0]?.sessionId).toBe("sess-2");
		expect(report.summary.tokenEventCount).toBe(1);
		expect(report.summary.tokensSaved).toBe(10);
	});

	it("marks observed agents missing from the roster as unrostered", () => {
		const report = buildObservabilityReport({ events: [writeEvent(1)], roster: {} }, { now: NOW });
		expect(report.agents.unrostered).toEqual(["agent-a"]);
		expect(report.summary.unrosteredCount).toBe(1);
	});

	it("fails open on malformed input instead of throwing", () => {
		const junk = [null, 42, { seq: "x" }] as unknown as MemoryLifecycleEvent[];
		const report = buildObservabilityReport({ events: junk, tokenEvents: junk as unknown as TokenTelemetryEvent[] });
		expect(report.mode).toBe("observe");
		expect(report.summary.eventCount).toBe(0);
		expect(report.summary.tokenEventCount).toBe(0);
	});

	it("does not mutate its inputs", () => {
		const events = [writeEvent(2), writeEvent(1)];
		const tokens = [tokenEvent("a", 10, 5)];
		const before = JSON.stringify({ events, tokens });
		buildObservabilityReport({ events, tokenEvents: tokens, roster: ROSTER }, { now: NOW });
		expect(JSON.stringify({ events, tokens })).toBe(before);
	});
});

describe("observability renderers", () => {
	const report = buildObservabilityReport(
		{
			events: [writeEvent(1), writeEvent(2)],
			tokenEvents: [tokenEvent("distill", 100, 40)],
			roster: ROSTER,
		},
		{ now: NOW },
	);

	it("exports parseable JSON", () => {
		const parsed = JSON.parse(exportObservabilityJson(report)) as { mode: string; summary: { eventCount: number } };
		expect(parsed.mode).toBe("observe");
		expect(parsed.summary.eventCount).toBe(2);
	});

	it("renders the agent tree with roster hierarchy", () => {
		const text = renderAgentTreeText(report.agents);
		expect(text).toContain("agent-root (planner)");
		expect(text).toContain("agent-a (coder): 2 events");
	});

	it("renders advisory role drift", () => {
		const text = renderRoleDriftText(report.agents);
		expect(text).toContain("[memory-type]");
		expect(text).toContain('agent "agent-a"');
	});

	it("renders one timeline line per event", () => {
		const text = renderTimelineText(report.timeline);
		expect(text).toContain("2 events, 1 sessions");
		expect(text).toContain("#1 [memory]");
		expect(text).toContain("#2 [memory]");
	});

	it("renders token totals with per-stage rollups", () => {
		const text = renderTokenBreakdownText(report.tokens);
		expect(text).toContain("saved 60 (60%)");
		expect(text).toContain("- stage distill:");
	});

	it("renders the full report with a headline", () => {
		const text = renderObservabilityText(report);
		expect(text).toContain("observability report (observe) at 2026-01-01T00:00:00.000Z");
		expect(text).toContain("2 events, 1 sessions, 2 agents");
	});

	it("dispatches surfaces purely", () => {
		expect(renderObservability(report, "tree")).toBe(renderAgentTreeText(report.agents));
		expect(renderObservability(report, "drift")).toBe(renderRoleDriftText(report.agents));
		expect(renderObservability(report, "timeline")).toBe(renderTimelineText(report.timeline));
		expect(renderObservability(report, "tokens")).toBe(renderTokenBreakdownText(report.tokens));
		expect(renderObservability(report)).toBe(renderObservabilityText(report));
	});
});
