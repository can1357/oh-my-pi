/**
 * Agent activity tree + role-drift projection — read-only observability.
 *
 * Folds an `EventTimeline` (itself a pure projection over lifecycle events)
 * into an agent/subagent **activity tree** plus advisory **role-drift**
 * flags, so a later surface can answer "which agent did what, under whom,
 * and did any agent stray from its assigned role?" — without touching the
 * journal or the running agent.
 *
 * Discipline, identical to every additive module in this fabric:
 *   - PURE: reads a snapshot (an `EventTimeline`); never opens a journal,
 *     never writes, never mutates inputs, never executes anything.
 *   - Observe-only: output is a report (`mode: "observe"`) carrying no
 *     authority. Role-drift flags are advisory, never enforcement.
 *   - Fail-open: malformed rows/roster entries are skipped; never throws.
 *
 * Honesty about the source model (the crux of this module): lifecycle
 * events record **memory lifecycle** and do NOT carry parent/child
 * causation, `origin`, `depth`, or `causationId`. So this projection does
 * NOT fabricate a hierarchy from thin air. Instead:
 *   - The **hierarchy and assigned roles are injected** by the caller via an
 *     `AgentRoster` (who reports to whom, and each agent's expected scope).
 *     The caller owns that ground truth; we only shape and validate it.
 *   - The **observed activity** (event counts, sessions, projects, memory
 *     types, first/last seq) is projected honestly from the timeline rows —
 *     only fields the events actually carry.
 *   - **Role-drift** is computed by comparing each agent's *observed*
 *     activity against its *injected* assigned role (allowed memory types /
 *     projects). A drift flag is only emitted when the roster actually
 *     declares a constraint; absence of a constraint is never a violation.
 */

import type { EventTimeline, TimelineRow } from "./event-timeline";
import type { MemoryRecordType } from "./types";

/** Caller-supplied assignment for a single agent. All fields optional. */
export interface AgentRoleAssignment {
	/** Human-readable role label (e.g. "planner", "coder", "reviewer"). */
	role?: string;
	/** Parent agent id in the assigned hierarchy, if this is a subagent. */
	parentId?: string;
	/** Memory types this agent is expected to write. Omit = unconstrained. */
	allowedMemoryTypes?: readonly MemoryRecordType[];
	/** Project ids this agent is expected to touch. Omit = unconstrained. */
	allowedProjects?: readonly string[];
}

/** Injected ground-truth roster: agentId -> assignment. */
export type AgentRoster = Record<string, AgentRoleAssignment>;

export interface AgentActivityOptions {
	/**
	 * Injected hierarchy + role assignments. The journal cannot supply
	 * these, so without a roster every observed agent is a role-less root
	 * and no role-drift can be computed (that is the honest default).
	 */
	roster?: AgentRoster;
	/** Cap on tree depth walked when computing `depth` (cycle safety). */
	maxDepth?: number;
}

export interface AgentNode {
	agentId: string;
	/** Assigned role from the roster, or null if unrostered. */
	role: string | null;
	/** Assigned parent from the roster, or null if a root. */
	parentId: string | null;
	/** 0 for roots; parent depth + 1 otherwise (cycle-safe). */
	depth: number;
	/** Direct children (agents whose assigned `parentId` is this agent), sorted. */
	children: string[];
	/** Observed number of timeline events attributed to this agent. */
	eventCount: number;
	/** Distinct sessions the agent was observed in (sorted). */
	sessions: string[];
	/** Distinct projects the agent was observed touching (sorted). */
	projects: string[];
	/** Distinct memory types the agent was observed writing/updating (sorted). */
	memoryTypes: string[];
	/** Earliest observed journal seq for this agent, or null. */
	firstSeq: number | null;
	/** Latest observed journal seq for this agent, or null. */
	lastSeq: number | null;
	/** True when the agent appears in observed activity (not roster-only). */
	observed: boolean;
}

export type RoleDriftKind = "memory-type" | "project";

export interface RoleDriftFlag {
	agentId: string;
	role: string | null;
	kind: RoleDriftKind;
	/** The observed value that fell outside the assigned allow-list. */
	observed: string;
	/** The assigned allow-list it was checked against (sorted). */
	allowed: string[];
	/** Human-readable, advisory description. */
	reason: string;
}

export interface AgentActivityProjection {
	mode: "observe";
	/** All agents (observed plus roster-referenced), sorted by id. */
	agents: AgentNode[];
	/** Agent ids with no assigned parent (roots), sorted. */
	roots: string[];
	/** Advisory role-drift findings (empty when no roster constraints). */
	roleDrift: RoleDriftFlag[];
	/** Observed agents absent from the roster (sorted). */
	unrostered: string[];
}

const DEFAULT_MAX_DEPTH = 64;

const EMPTY: AgentActivityProjection = {
	mode: "observe",
	agents: [],
	roots: [],
	roleDrift: [],
	unrostered: [],
};

interface ObservedAccumulator {
	eventCount: number;
	sessions: Set<string>;
	projects: Set<string>;
	memoryTypes: Set<string>;
	firstSeq: number | null;
	lastSeq: number | null;
}

function newAccumulator(): ObservedAccumulator {
	return {
		eventCount: 0,
		sessions: new Set(),
		projects: new Set(),
		memoryTypes: new Set(),
		firstSeq: null,
		lastSeq: null,
	};
}

function isRow(value: unknown): value is TimelineRow {
	if (!value || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return typeof r.seq === "number" && typeof r.sessionId === "string";
}

function sanitizeRoster(roster: AgentRoster | undefined): Map<string, AgentRoleAssignment> {
	const out = new Map<string, AgentRoleAssignment>();
	if (!roster || typeof roster !== "object") return out;
	for (const [agentId, raw] of Object.entries(roster)) {
		if (typeof agentId !== "string" || agentId.length === 0) continue;
		if (!raw || typeof raw !== "object") {
			out.set(agentId, {});
			continue;
		}
		out.set(agentId, raw);
	}
	return out;
}

/**
 * Resolve `depth` for an agent by walking the assigned parent chain.
 * Cycle-safe: a repeated visit or an over-long chain stops at `maxDepth`.
 */
function resolveDepth(agentId: string, rosterMap: Map<string, AgentRoleAssignment>, maxDepth: number): number {
	let depth = 0;
	let cursor = rosterMap.get(agentId)?.parentId;
	const seen = new Set<string>([agentId]);
	while (typeof cursor === "string" && cursor.length > 0 && depth < maxDepth) {
		if (seen.has(cursor)) break; // cycle
		seen.add(cursor);
		depth += 1;
		cursor = rosterMap.get(cursor)?.parentId;
	}
	return depth;
}

function driftReason(node: AgentNode, kind: RoleDriftKind, observedValue: string): string {
	const roleLabel = node.role ? ` (role: ${node.role})` : "";
	const verb = kind === "memory-type" ? `wrote memory type "${observedValue}"` : `touched project "${observedValue}"`;
	return `agent "${node.agentId}"${roleLabel} ${verb} outside its assigned scope`;
}

/**
 * Project an `EventTimeline` plus an injected roster into an agent activity
 * tree and advisory role-drift flags. Pure and fail-open; the inputs are
 * never mutated.
 */
export function projectAgentActivity(
	timeline: EventTimeline | undefined,
	options: AgentActivityOptions = {},
): AgentActivityProjection {
	try {
		const rows: readonly TimelineRow[] = timeline && Array.isArray(timeline.rows) ? timeline.rows : [];
		const rosterMap = sanitizeRoster(options.roster);
		const maxDepth =
			typeof options.maxDepth === "number" && options.maxDepth > 0
				? Math.floor(options.maxDepth)
				: DEFAULT_MAX_DEPTH;

		// 1. Accumulate observed activity per agent from the timeline rows.
		const observed = new Map<string, ObservedAccumulator>();
		for (const row of rows) {
			if (!isRow(row)) continue;
			const agentId = row.agentId;
			if (typeof agentId !== "string" || agentId.length === 0) continue;
			let acc = observed.get(agentId);
			if (!acc) {
				acc = newAccumulator();
				observed.set(agentId, acc);
			}
			acc.eventCount += 1;
			if (row.sessionId) acc.sessions.add(row.sessionId);
			if (row.projectId) acc.projects.add(row.projectId);
			if (row.memoryType) acc.memoryTypes.add(row.memoryType);
			acc.firstSeq = acc.firstSeq === null ? row.seq : Math.min(acc.firstSeq, row.seq);
			acc.lastSeq = acc.lastSeq === null ? row.seq : Math.max(acc.lastSeq, row.seq);
		}

		// 2. Universe of agents = observed + roster keys + referenced parents.
		const universe = new Set<string>();
		for (const id of observed.keys()) universe.add(id);
		for (const [id, assignment] of rosterMap) {
			universe.add(id);
			if (typeof assignment.parentId === "string" && assignment.parentId.length > 0) {
				universe.add(assignment.parentId);
			}
		}

		// 3. Build children adjacency from assigned parents.
		const children = new Map<string, string[]>();
		for (const [id, assignment] of rosterMap) {
			const parentId = assignment.parentId;
			if (typeof parentId === "string" && parentId.length > 0 && parentId !== id) {
				const list = children.get(parentId);
				if (list) list.push(id);
				else children.set(parentId, [id]);
			}
		}

		// 4. Assemble nodes.
		const agents: AgentNode[] = [];
		const roots: string[] = [];
		const unrostered: string[] = [];
		for (const agentId of [...universe].sort()) {
			const assignment = rosterMap.get(agentId);
			const acc = observed.get(agentId);
			const parentId =
				assignment && typeof assignment.parentId === "string" && assignment.parentId.length > 0
					? assignment.parentId
					: null;
			if (parentId === null) roots.push(agentId);
			if (!rosterMap.has(agentId) && acc) unrostered.push(agentId);

			agents.push({
				agentId,
				role: assignment?.role ?? null,
				parentId,
				depth: resolveDepth(agentId, rosterMap, maxDepth),
				children: (children.get(agentId) ?? []).slice().sort(),
				eventCount: acc?.eventCount ?? 0,
				sessions: acc ? [...acc.sessions].sort() : [],
				projects: acc ? [...acc.projects].sort() : [],
				memoryTypes: acc ? [...acc.memoryTypes].sort() : [],
				firstSeq: acc?.firstSeq ?? null,
				lastSeq: acc?.lastSeq ?? null,
				observed: acc !== undefined,
			});
		}

		// 5. Role-drift: observed activity outside an *explicitly* assigned scope.
		const roleDrift: RoleDriftFlag[] = [];
		for (const node of agents) {
			const assignment = rosterMap.get(node.agentId);
			if (!assignment || !node.observed) continue;

			if (assignment.allowedMemoryTypes && assignment.allowedMemoryTypes.length > 0) {
				const allowed = new Set<string>(assignment.allowedMemoryTypes);
				for (const mt of node.memoryTypes) {
					if (!allowed.has(mt)) {
						roleDrift.push({
							agentId: node.agentId,
							role: node.role,
							kind: "memory-type",
							observed: mt,
							allowed: [...allowed].sort(),
							reason: driftReason(node, "memory-type", mt),
						});
					}
				}
			}

			if (assignment.allowedProjects && assignment.allowedProjects.length > 0) {
				const allowed = new Set<string>(assignment.allowedProjects);
				for (const proj of node.projects) {
					if (!allowed.has(proj)) {
						roleDrift.push({
							agentId: node.agentId,
							role: node.role,
							kind: "project",
							observed: proj,
							allowed: [...allowed].sort(),
							reason: driftReason(node, "project", proj),
						});
					}
				}
			}
		}

		return {
			mode: "observe",
			agents,
			roots: roots.sort(),
			roleDrift,
			unrostered: unrostered.sort(),
		};
	} catch {
		return EMPTY;
	}
}
