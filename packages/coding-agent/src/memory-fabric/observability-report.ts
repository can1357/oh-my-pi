/**
 * Unified observability report — read-only composition of the three
 * observe-mode projections (O1 timeline, O2 agent tree, O3 token breakdown).
 *
 * `buildObservabilityReport(input)` folds one snapshot of lifecycle events,
 * token-telemetry events, and an optional injected agent roster into a single
 * `ObservabilityReport`, so a later surface can answer "what happened, who
 * did it, and what did it cost?" from one object — without touching the
 * journal, the hot path, or the running agent.
 *
 * Discipline, identical to every additive module in this fabric:
 *   - PURE: reads snapshots; never opens a journal, never writes, never
 *     mutates inputs, never executes anything. The clock is injectable
 *     (`options.now`) so reports are deterministic under test.
 *   - Observe-only: the output is a report (`mode: "observe"`) carrying no
 *     authority. The renderers return strings; nothing here prints, exits,
 *     or dispatches on argv.
 *   - Fail-open: malformed inputs are skipped by the underlying projections;
 *     this module never throws and degrades to an inert report.
 *
 * Honesty about the source model: this module adds NO new measurement. Every
 * number in the report is computed by `projectEventTimeline`,
 * `projectAgentActivity`, or `projectTokenBreakdown` from fields the events
 * actually carry. The summary is arithmetic over those projections — never a
 * new estimate, never a fabricated latency or cache statistic.
 */

import type { AgentActivityProjection, AgentRoster } from "./event-agent-tree";
import { projectAgentActivity } from "./event-agent-tree";
import type { EventTimeline, MemoryLifecycleEvent, TimelineOptions } from "./event-timeline";
import { projectEventTimeline } from "./event-timeline";
import type { TokenTelemetryEvent } from "./token-accounting/token-accounting";
import type { TokenBreakdown, TokenBreakdownOptions } from "./token-breakdown";
import { projectTokenBreakdown } from "./token-breakdown";

/** Snapshot inputs for one report. All optional; missing inputs project empty. */
export interface ObservabilityInput {
	/** Memory-lifecycle events (the shape the event gateway emits). */
	events?: readonly MemoryLifecycleEvent[];
	/** Token-telemetry events (emitted by `token-accounting`). */
	tokenEvents?: readonly TokenTelemetryEvent[];
	/** Injected agent hierarchy + role assignments (caller-owned ground truth). */
	roster?: AgentRoster;
}

export interface ObservabilityOptions {
	/** Filters forwarded to `projectEventTimeline`. */
	timeline?: TimelineOptions;
	/** Filters forwarded to `projectTokenBreakdown`. */
	tokens?: TokenBreakdownOptions;
	/** Depth cap forwarded to `projectAgentActivity`. */
	maxDepth?: number;
	/** Injectable clock for deterministic `generatedAt` under test. */
	now?: () => Date;
}

/** Headline numbers, all derived from the three projections below. */
export interface ObservabilitySummary {
	/** Timeline rows counted (after filters). */
	eventCount: number;
	/** Distinct sessions observed in the timeline. */
	sessionCount: number;
	/** Agents in the activity tree (observed plus roster-referenced). */
	agentCount: number;
	/** Observed agents absent from the injected roster. */
	unrosteredCount: number;
	/** Advisory role-drift findings. */
	roleDriftCount: number;
	/** Token-telemetry events counted (after filters). */
	tokenEventCount: number;
	/** Net tokens saved (negative on net growth). */
	tokensSaved: number;
	/** Rounded overall percent saved (0 when nothing was counted). */
	tokenPercentSaved: number;
}

export interface ObservabilityReport {
	mode: "observe";
	/** ISO timestamp from the injected clock (or wall clock). */
	generatedAt: string;
	summary: ObservabilitySummary;
	timeline: EventTimeline;
	agents: AgentActivityProjection;
	tokens: TokenBreakdown;
}

/** The renderable surfaces of a report. */
export const OBSERVABILITY_SURFACES = ["report", "tree", "drift", "timeline", "tokens"] as const;

export type ObservabilitySurface = (typeof OBSERVABILITY_SURFACES)[number];

const EMPTY_TIMELINE: EventTimeline = { mode: "observe", rowCount: 0, rows: [], sessions: [] };

const EMPTY_AGENTS: AgentActivityProjection = {
	mode: "observe",
	agents: [],
	roots: [],
	roleDrift: [],
	unrostered: [],
};

const EMPTY_TOKENS: TokenBreakdown = {
	mode: "observe",
	eventCount: 0,
	totalBefore: 0,
	totalAfter: 0,
	totalSaved: 0,
	percentSaved: 0,
	grewCount: 0,
	failedOpenCount: 0,
	avgRatio: 0,
	byStage: [],
	byFidelity: [],
};

function isoNow(now: (() => Date) | undefined): string {
	try {
		const clock = typeof now === "function" ? now : () => new Date();
		return clock().toISOString();
	} catch {
		return new Date().toISOString();
	}
}

function summarize(
	timeline: EventTimeline,
	agents: AgentActivityProjection,
	tokens: TokenBreakdown,
): ObservabilitySummary {
	return {
		eventCount: timeline.rowCount,
		sessionCount: timeline.sessions.length,
		agentCount: agents.agents.length,
		unrosteredCount: agents.unrostered.length,
		roleDriftCount: agents.roleDrift.length,
		tokenEventCount: tokens.eventCount,
		tokensSaved: tokens.totalSaved,
		tokenPercentSaved: tokens.percentSaved,
	};
}

/**
 * Compose the three observe-mode projections over one snapshot into a single
 * report. Pure and fail-open; the inputs are never mutated. Missing inputs
 * yield the corresponding inert projection, never an error.
 */
export function buildObservabilityReport(
	input: ObservabilityInput = {},
	options: ObservabilityOptions = {},
): ObservabilityReport {
	const generatedAt = isoNow(options.now);
	try {
		const timeline = projectEventTimeline(input.events ?? [], options.timeline ?? {});
		const agentOptions =
			typeof options.maxDepth === "number"
				? { roster: input.roster, maxDepth: options.maxDepth }
				: { roster: input.roster };
		const agents = projectAgentActivity(timeline, agentOptions);
		const tokens = projectTokenBreakdown(input.tokenEvents ?? [], options.tokens ?? {});
		return {
			mode: "observe",
			generatedAt,
			summary: summarize(timeline, agents, tokens),
			timeline,
			agents,
			tokens,
		};
	} catch {
		return {
			mode: "observe",
			generatedAt,
			summary: summarize(EMPTY_TIMELINE, EMPTY_AGENTS, EMPTY_TOKENS),
			timeline: EMPTY_TIMELINE,
			agents: EMPTY_AGENTS,
			tokens: EMPTY_TOKENS,
		};
	}
}

/** Serialize a report as pretty JSON. Fail-open: returns "{}" on failure. */
export function exportObservabilityJson(report: ObservabilityReport): string {
	try {
		return JSON.stringify(report, null, 2);
	} catch {
		return "{}";
	}
}

function pct(value: number): string {
	return `${value}%`;
}

/** Render the agent activity tree as indented text. Pure; never throws. */
export function renderAgentTreeText(agents: AgentActivityProjection): string {
	try {
		const byId = new Map(agents.agents.map(a => [a.agentId, a] as const));
		const lines: string[] = ["agent activity (observe)"];
		const visit = (agentId: string, indent: number, seen: Set<string>): void => {
			if (seen.has(agentId) || indent > 64) return;
			seen.add(agentId);
			const node = byId.get(agentId);
			if (!node) return;
			const role = node.role ?? "no role";
			const status = node.observed ? `${node.eventCount} events` : "no observed activity";
			lines.push(`${"  ".repeat(indent)}- ${node.agentId} (${role}): ${status}`);
			for (const child of node.children) visit(child, indent + 1, seen);
		};
		const seen = new Set<string>();
		for (const root of agents.roots) visit(root, 1, seen);
		if (agents.unrostered.length > 0) {
			lines.push(`unrostered: ${agents.unrostered.join(", ")}`);
		}
		if (lines.length === 1) lines.push("(no agents)");
		return lines.join("\n");
	} catch {
		return "agent activity (observe)\n(no agents)";
	}
}

/** Render advisory role-drift findings as text. Pure; never throws. */
export function renderRoleDriftText(agents: AgentActivityProjection): string {
	try {
		const lines: string[] = ["role drift (advisory, observe)"];
		for (const flag of agents.roleDrift) {
			lines.push(`- [${flag.kind}] ${flag.reason}`);
		}
		if (lines.length === 1) lines.push("(no drift found)");
		return lines.join("\n");
	} catch {
		return "role drift (advisory, observe)\n(no drift found)";
	}
}

/** Render timeline rows as one line per event. Pure; never throws. */
export function renderTimelineText(timeline: EventTimeline): string {
	try {
		const lines: string[] = [`timeline (observe): ${timeline.rowCount} events, ${timeline.sessions.length} sessions`];
		for (const row of timeline.rows) {
			const delta = row.deltaMs === null ? "-" : `+${row.deltaMs}ms`;
			lines.push(`#${row.seq} [${row.category}] ${delta} ${row.sessionId} ${row.summary}`);
		}
		return lines.join("\n");
	} catch {
		return "timeline (observe): 0 events, 0 sessions";
	}
}

/** Render the token breakdown with per-stage rollups. Pure; never throws. */
export function renderTokenBreakdownText(tokens: TokenBreakdown): string {
	try {
		const lines: string[] = [
			`tokens (observe): ${tokens.eventCount} events, saved ${tokens.totalSaved}` +
				` (${pct(tokens.percentSaved)}), grew ${tokens.grewCount}, failed-open ${tokens.failedOpenCount}`,
		];
		for (const group of tokens.byStage) {
			const share = `saved ${group.saved} (${pct(group.percentSaved)})`;
			lines.push(`- stage ${group.key}: ${share} over ${group.eventCount} events`);
		}
		return lines.join("\n");
	} catch {
		return "tokens (observe): 0 events, saved 0 (0%), grew 0, failed-open 0";
	}
}

/** Render the full report headline plus every section. Pure; never throws. */
export function renderObservabilityText(report: ObservabilityReport): string {
	try {
		const s = report.summary;
		const headline =
			`observability report (observe) at ${report.generatedAt}: ` +
			`${s.eventCount} events, ${s.sessionCount} sessions, ${s.agentCount} agents` +
			` (${s.unrosteredCount} unrostered, ${s.roleDriftCount} drift), ` +
			`${s.tokenEventCount} token events, saved ${s.tokensSaved} (${pct(s.tokenPercentSaved)})`;
		return [
			headline,
			renderTimelineText(report.timeline),
			renderAgentTreeText(report.agents),
			renderRoleDriftText(report.agents),
			renderTokenBreakdownText(report.tokens),
		].join("\n\n");
	} catch {
		return "observability report (observe): unavailable";
	}
}

/**
 * Pure render dispatch: pick one surface of a report as text (or the whole
 * report). No argv, no printing, no process control — callers own I/O.
 */
export function renderObservability(report: ObservabilityReport, surface: ObservabilitySurface = "report"): string {
	switch (surface) {
		case "tree":
			return renderAgentTreeText(report.agents);
		case "drift":
			return renderRoleDriftText(report.agents);
		case "timeline":
			return renderTimelineText(report.timeline);
		case "tokens":
			return renderTokenBreakdownText(report.tokens);
		default:
			return renderObservabilityText(report);
	}
}
