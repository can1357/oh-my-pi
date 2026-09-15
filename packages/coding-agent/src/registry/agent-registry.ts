/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/** Sidecar marker retained beside a child transcript after an explicit kill. */
const AGENT_TOMBSTONE_SUFFIX = ".tombstone";

export function getAgentTombstonePath(sessionFile: string): string {
	return `${sessionFile}${AGENT_TOMBSTONE_SUFFIX}`;
}

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/** Provenance of a displayed duration: active runtime, transcript span, or unavailable. */
type AgentDurationKind = "active" | "span" | "unknown";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`hub`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

/** Persisted per-agent totals reconstructed from the child session transcript. */
export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: AgentDurationKind;
	contextTokens?: number;
	contextWindow?: number;
}

/**
 * Run lifecycle milestones, stamped as they happen and scoped to the CURRENT
 * run: they are cleared when the ref re-enters `running` for a follow-up or
 * wake turn. Launch is the ref's `createdAt`; these are the post-launch
 * boundaries the parent needs to tell a genuinely working agent from one whose
 * accepted result never terminalized.
 */
export interface AgentRunLifecycle {
	/** When the run produced its final response (an accepted terminal `yield`). */
	responseAt?: number;
	/** When the run's final result was accepted by its driver. */
	acceptedAt?: number;
	/** When the ref last left `running` for a terminal status. */
	terminalAt?: number;
}

/** Historical identity and telemetry that remain available after the live session is disposed. */
export interface AgentHistorySummary {
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	/** Whether the last resolved model was selected by retry fallback routing. */
	resolvedModelIsFallback?: boolean;
	metrics?: AgentMetricsSummary;
	readOnly?: boolean;
	/** Durable task output artifact, when the executor wrote one. */
	outputPath?: string;
	/** Captured isolated-worktree patch, when patch capture succeeded. */
	patchPath?: string;
	/** Isolated branch identity, when branch-mode capture succeeded. */
	branchName?: string;
	/** Captured nested-repo patches (`<id>.nested-<n>-<path>.patch`), one per nested repository the agent changed. */
	nestedPatchPaths?: string[];
}

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
	/** Run lifecycle milestones (launch is {@link createdAt}). */
	lifecycle?: AgentRunLifecycle;
}

export type AgentRefExpectation = AgentRef | AgentSession;

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	/** Last persisted task summary, when restoring a historical agent. */
	activity?: string;
	/** Original registration timestamp, when known from persisted history. */
	createdAt?: number;
	/** Last transcript activity timestamp, when known from persisted history. */
	lastActivity?: number;
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
	/** Run lifecycle milestones restored from persisted history, when known. */
	lifecycle?: AgentRunLifecycle;
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

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	#rejectStatusUpdate(id: string, status: AgentStatus, reason: string): false {
		logger.debug("Agent registry status update rejected", { id, status, reason });
		return false;
	}

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: input.activity,
			history: input.history,
			lifecycle: input.lifecycle,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/**
	 * Register a new id only when it is absent, or reuse the exact detached
	 * `parked` ref a revival was authorized to revive. A missing, replaced, or
	 * terminal expected ref is a failed CAS: delayed revivers must never claim an
	 * id after its prior generation disappeared or was hard-killed.
	 */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	/** Attach transcript-derived identity and telemetry without changing lifecycle state. */
	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref = this.#refs.get(id);
		if (!ref || (expectedSessionFile !== undefined && ref.sessionFile !== expectedSessionFile)) return false;
		const definedHistory = Object.fromEntries(
			Object.entries(history).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (!this.#matchesExpected(ref, expected)) {
			return this.#rejectStatusUpdate(id, status, "session-ownership-changed");
		}
		// `aborted` is terminal: delayed progress/revival work from the killed
		// generation must never transition the tombstone back to a live status.
		if (ref.status === "aborted") {
			return status === "aborted" || this.#rejectStatusUpdate(id, status, "aborted-is-terminal");
		}
		if (ref.status === status) return true;
		const leftRunning = ref.status === "running";
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		if (status === "running") {
			// Milestones are run-scoped. A ref reused by a follow-up or wake
			// turn must not carry the previous run's response/acceptance into
			// the new run, or a later yield-less turn would look accepted.
			ref.lifecycle = undefined;
		} else if (leftRunning) {
			ref.lifecycle = { ...ref.lifecycle, terminalAt: ref.lastActivity };
		}
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/**
	 * Record that this agent's run produced and handed over its final result,
	 * and terminalize the ref when no turn is in flight. Acceptance is the
	 * executor's run boundary: the result is settled, so a ref still `running`
	 * with nothing streaming is a missed terminal transition the parent's
	 * `hub` wait would otherwise keep blocking on. A ref with a genuinely
	 * streaming session (a wake turn started at the boundary) stays `running`
	 * and is surfaced by {@link staleAcceptedRuns} instead.
	 *
	 * Milestones are run-scoped: `responseAt` is the CURRENT call's response
	 * time (never a previous run's, which {@link setStatus} cleared when the
	 * ref re-entered `running`).
	 *
	 * Returns false when the id is gone, aborted, or no longer owned by
	 * `expected`; those cases must not stamp a newer generation.
	 */
	markResultAccepted(id: string, expected?: AgentRefExpectation, responseAt?: number): boolean {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === "aborted" || !this.#matchesExpected(ref, expected)) return false;
		const now = Date.now();
		ref.lifecycle = {
			...ref.lifecycle,
			responseAt: responseAt ?? now,
			acceptedAt: now,
		};
		if (ref.status === "running" && ref.session?.isStreaming !== true) {
			this.setStatus(id, "idle", ref);
		} else {
			this.#emit({ type: "metadata_changed", ref });
		}
		return true;
	}

	/**
	 * Accepted-but-running refs: the run's final result was handed over but the
	 * ref never left `running`, and no turn is in flight. This is the lifecycle
	 * leak `hub`'s running-agents roster reports so the parent can cancel it
	 * instead of waiting on a run that already finished.
	 */
	staleAcceptedRuns(): AgentRef[] {
		return this.list().filter(
			ref => ref.status === "running" && ref.lifecycle?.acceptedAt !== undefined && !this.isRunning(ref),
		);
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

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		// Never attach a late-created session to a hard-killed tombstone. This
		// closes the race between a parked reviver claiming the ref and finishing
		// createAgentSession after an explicit kill.
		if (!ref || ref.status === "aborted" || !this.#matchesExpected(ref, expected)) return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every alive agent (running | idle) except the caller. Advisor refs
	 * are observability-only transcripts, never peers, so they are excluded.
	 * Flat namespace: every other agent is visible.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => ref.id !== id && ref.kind !== "advisor" && (ref.status === "running" || ref.status === "idle"),
		);
	}

	/** Whether a ref's claimed running state is corroborated by its attached live session. */
	isRunning(ref: AgentRef): boolean {
		if (ref.status !== "running") return false;
		return ref.session?.isStreaming === true;
	}

	/** Mirror a session's authoritative run-state notifications into its owned registry ref. */
	syncSessionStatus(id: string, session: AgentSession): () => void {
		const unsubscribe = session.subscribeRunState(status => {
			this.setStatus(id, status, session);
		});
		return unsubscribe;
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
