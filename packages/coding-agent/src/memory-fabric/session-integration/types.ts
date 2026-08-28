/**
 * Memory Fabric — session lifecycle vocabulary.
 *
 * The event and packet shapes every session participant speaks. This module is
 * pure declaration: it has no imports and no runtime code, so it can be adopted
 * (or read) without pulling in any part of the fabric.
 *
 * Two invariants worth noting, because the rest of the layer relies on them:
 *
 *   - Every event carries `metadata.depth` and `metadata.origin`. Together they
 *     let the bus refuse to re-enter itself: work performed *by* the memory
 *     layer is tagged `memory-guardian`, and re-entrant guardian events are
 *     dropped rather than fanned out again.
 *   - Every event carries a `scope`. Memory is never global; it is addressed by
 *     project + session, optionally narrowed to a worktree, branch, task or
 *     agent, so a subagent cannot silently read or write another's memory.
 */

export type MemoryEventOrigin = "user" | "main-agent" | "tool" | "memory-guardian" | "subagent";

export interface MemoryEventMetadata {
	origin: MemoryEventOrigin;
	correlationId: string;
	causationId?: string;
	depth: number;
	sequence: number;
	turnId?: string;
	toolCallId?: string;
	timestamp: number;
}

export interface MemorySessionScope {
	projectId: string;
	sessionId: string;
	cwd: string;
	worktreeId?: string;
	branchId?: string;
	taskId?: string;
	agentId?: string;
}

export interface BaseMemoryLifecycleEvent {
	metadata: MemoryEventMetadata;
	scope: MemorySessionScope;
	sequence: number;
}

export interface SessionStartEvent extends BaseMemoryLifecycleEvent {
	type: "session_start";
	resumed: boolean;
}

export interface UserPromptEvent extends BaseMemoryLifecycleEvent {
	type: "user_prompt";
	text: string;
}

export interface BeforeModelEvent extends BaseMemoryLifecycleEvent {
	type: "before_model";
	userText: string;
	activeContextText?: string;
}

export interface BeforeToolCallEvent extends BaseMemoryLifecycleEvent {
	type: "before_tool_call";
	toolName: string;
	input: unknown;
}

export interface AfterToolCallEvent extends BaseMemoryLifecycleEvent {
	type: "after_tool_call";
	toolName: string;
	input: unknown;
	output: unknown;
	success: boolean;
	durationMs: number;
}

export interface BeforeCompactionEvent extends BaseMemoryLifecycleEvent {
	type: "before_compaction";
	reason: string;
}

export interface SessionResumeEvent extends BaseMemoryLifecycleEvent {
	type: "session_resume";
}

export interface SessionStopEvent extends BaseMemoryLifecycleEvent {
	type: "session_stop";
	reason: string;
}

export type MemoryLifecycleEvent =
	| SessionStartEvent
	| UserPromptEvent
	| BeforeModelEvent
	| BeforeToolCallEvent
	| AfterToolCallEvent
	| BeforeCompactionEvent
	| SessionResumeEvent
	| SessionStopEvent;

export interface MemoryContextPacket {
	id: string;
	text: string;
	memoryIds: string[];
	tokenEstimate: number;
	createdAt: number;
	latencyMs: number;
}

export interface MemoryToolAdvisory {
	text: string;
	memoryIds: string[];
	severity: "info" | "warning" | "critical";
}

export interface ContinuationCapsule {
	id: string;
	text: string;
	createdAt: number;
}

/**
 * Ephemeral agent message type for memory context injection.
 *
 * This message is created at the boundary between history and user messages and
 * injected into the LLM message pipeline. It does NOT persist to session.jsonl —
 * it only exists in the ephemeral provider-request view.
 *
 * Provider ordering: system → history → memory → user
 */
export interface MemoryContextAgentMessage {
	role: "memory_context";
	type: "memory_context";
	packet: MemoryContextPacket;
	turnId: string;
	createdAt: number;
	timestamp: number;
}

/**
 * Marker for anything that can participate in the session memory lifecycle.
 *
 * Deliberately structural and deliberately empty: every hook is optional, so a
 * participant implements only the points it cares about and the composite fans
 * out to whatever is present. `ParticipantLike` in `composite-participant.ts`
 * describes the hooks themselves.
 */
export interface SessionMemoryParticipant {}
