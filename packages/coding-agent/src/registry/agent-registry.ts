/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`irc`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import { type CollaborationPolicy, canDiscoverPeer } from "../orchestration/collaboration-policy";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

function sessionCollaborationPolicy(session: AgentSession | null | undefined): CollaborationPolicy | undefined {
	return typeof session?.getCollaborationPolicy === "function" ? session.getCollaborationPolicy() : undefined;
}

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`irc`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	color?: string;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	/** Collaboration authorization used for agent-facing roster and IRC filtering. */
	collaborationPolicy?: CollaborationPolicy;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Working directory for this agent. Enables CWD-aware spawning where agents can operate in different directories. */
	cwd?: string;
	/** When true, the agent is blocked waiting for user input (e.g. ask tool pending). Surfaces in the Agent Hub. */
	needsAttention?: boolean;
	/** Human-readable reason for the attention flag (e.g. "ask: Which auth method?"). */
	attentionReason?: string;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef }
	| { type: "renamed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	color?: string;
	cwd?: string;
	collaborationPolicy?: CollaborationPolicy;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			color: input.color,
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			collaborationPolicy: input.collaborationPolicy ?? sessionCollaborationPolicy(input.session),
			createdAt: now,
			lastActivity: now,
			cwd: input.cwd,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	setStatus(id: string, status: AgentStatus): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === status) return;
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	setAttention(id: string, reason?: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.needsAttention && ref.attentionReason === reason) return;
		ref.needsAttention = true;
		ref.attentionReason = reason;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	clearAttention(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref?.needsAttention) return;
		ref.needsAttention = false;
		ref.attentionReason = undefined;
		this.#emit({ type: "status_changed", ref });
	}

	attachSession(id: string, session: AgentSession, sessionFile?: string | null): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.collaborationPolicy = sessionCollaborationPolicy(session) ?? ref.collaborationPolicy;
		ref.lastActivity = Date.now();
	}

	detachSession(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = null;
	}

	setCollaborationPolicy(id: string, policy: CollaborationPolicy | undefined): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.collaborationPolicy = policy;
	}

	setDisplayName(id: string, displayName: string): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.displayName === displayName) return;
		ref.displayName = displayName;
		ref.lastActivity = Date.now();
		this.#emit({ type: "renamed", ref });
	}

	unregister(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	/** List raw refs for process-internal observability, or policy-filtered peers for a viewer. */
	list(viewerId?: string): AgentRef[] {
		const refs = [...this.#refs.values()];
		if (!viewerId) return refs;
		const viewer = this.#refs.get(viewerId);
		const policy = viewer?.collaborationPolicy ?? sessionCollaborationPolicy(viewer?.session);
		return refs.filter(
			ref => ref.id !== viewerId && ref.kind !== "advisor" && canDiscoverPeer(policy, viewerId, ref.id),
		);
	}

	/**
	 * Returns every live peer (running | idle) discoverable by the caller.
	 * Advisor refs remain observability-only and are never exposed as peers.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list(id).filter(ref => ref.status === "running" || ref.status === "idle");
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
