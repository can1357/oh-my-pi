import type { AgentProgress, AgentSource } from "../tools/task";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** EventBus channel for subagent lifecycle (start/end) */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	/** See {@link SubagentLifecyclePayload.detached}. */
	detached?: boolean;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	/**
	 * Spawn runs as a detached background job: the parent turn keeps working
	 * while this agent runs. Sync task spawns (parent blocked on the call) and
	 * eval `agent()` bridge spawns (rendered inside their eval cell) leave this
	 * unset — surfaces like the subagent HUD only list detached spawns.
	 */
	detached?: boolean;
}

/** Minimal event subscription surface supplied by the host. */
export interface EventBusLike {
	on(channel: string, listener: (data: unknown) => void): () => void;
}

export interface ObservableSession {
	id: string;
	kind: "main" | "subagent";
	label: string;
	agent?: string;
	description?: string;
	status: "active" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * Sync task spawns and eval `agent()` spawns additionally render live in
	 * their own inline tool block / eval cell; the pinned HUD jump-lists every
	 * active subagent either way.
	 */
	detached?: boolean;
	index?: number;
	lastUpdate: number;
	/**
	 * Latest progress snapshot from the subagent executor. Usage counters
	 * (`tokens`, `requests`, `toolCount`, `cost`, `durationMs`) are lifetime
	 * totals across every run of this agent id, so a follow-up turn on a kept-alive
	 * or revived agent adds to the earlier runs instead of restarting at zero.
	 */
	progress?: AgentProgress;
}

/** Usage counters the executor restarts at zero on every run of an agent. */
type RunUsage = Pick<AgentProgress, "tokens" | "requests" | "toolCount" | "cost" | "durationMs">;

function addRunUsage(base: RunUsage | undefined, run: RunUsage): RunUsage {
	if (!base)
		return {
			tokens: run.tokens,
			requests: run.requests,
			toolCount: run.toolCount,
			cost: run.cost,
			durationMs: run.durationMs,
		};
	return {
		tokens: base.tokens + run.tokens,
		requests: base.requests + run.requests,
		toolCount: base.toolCount + run.toolCount,
		cost: base.cost + run.cost,
		durationMs: base.durationMs + run.durationMs,
	};
}

/** Coarse source of an observer change; callers use it to separate lifecycle work from high-frequency progress. */
export type SessionObserverChangeKind = "main" | "reset" | "lifecycle" | "progress";

const STATUS_MAP: Record<string, ObservableSession["status"]> = {
	started: "active",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

export class SessionObserverRegistry {
	#sessions = new Map<string, ObservableSession>();
	/** Summed usage of an agent's settled runs. */
	#settledUsageById = new Map<string, RunUsage>();
	/** Raw executor snapshot of an agent's current, not yet settled run. */
	#runProgressById = new Map<string, AgentProgress>();
	#listeners = new Set<(kind: SessionObserverChangeKind) => void>();
	#eventBusUnsubscribers: Array<() => void> = [];
	#sortOrderById = new Map<string, number>();
	#parentSortOrderById = new Map<string, number>();
	#nextSortOrder = 0;

	/** Add a change listener. Returns unsubscribe function. */
	onChange(cb: (kind: SessionObserverChangeKind) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	#notifyListeners(kind: SessionObserverChangeKind): void {
		for (const cb of this.#listeners) cb(kind);
	}

	#ensureSortOrder(id: string): number {
		const existing = this.#sortOrderById.get(id);
		if (existing !== undefined) return existing;
		const order = this.#nextSortOrder++;
		this.#sortOrderById.set(id, order);
		return order;
	}

	#ensureParentSortOrder(parentToolCallId: string | undefined, order: number): void {
		if (!parentToolCallId) return;
		if (this.#parentSortOrderById.has(parentToolCallId)) return;
		this.#parentSortOrderById.set(parentToolCallId, order);
	}

	#getStableOrder(session: ObservableSession): number {
		return this.#sortOrderById.get(session.id) ?? Number.MAX_SAFE_INTEGER;
	}

	#getGroupOrder(session: ObservableSession): number {
		const parentOrder = session.parentToolCallId
			? this.#parentSortOrderById.get(session.parentToolCallId)
			: undefined;
		return parentOrder ?? this.#getStableOrder(session);
	}

	setMainSession(sessionFile?: string): void {
		const existing = this.#sessions.get("main");
		this.#ensureSortOrder("main");
		this.#sessions.set("main", {
			id: "main",
			kind: "main",
			label: "Main Session",
			status: "active",
			sessionFile: sessionFile ?? existing?.sessionFile,
			lastUpdate: Date.now(),
		});
		this.#notifyListeners("main");
	}

	/** Return one tracked session without copying or sorting the registry. */
	getSession(id: string): ObservableSession | undefined {
		return this.#sessions.get(id);
	}

	getSessions(): ObservableSession[] {
		const sessions = [...this.#sessions.values()];
		sessions.sort((a, b) => {
			if (a.kind === "main" && b.kind !== "main") return -1;
			if (b.kind === "main" && a.kind !== "main") return 1;
			if (a.kind === "main" || b.kind === "main") return 0;

			const groupDiff = this.#getGroupOrder(a) - this.#getGroupOrder(b);
			if (groupDiff !== 0) return groupDiff;

			const aIndex = a.index ?? Number.MAX_SAFE_INTEGER;
			const bIndex = b.index ?? Number.MAX_SAFE_INTEGER;
			if (aIndex !== bIndex) return aIndex - bIndex;

			return this.#getStableOrder(a) - this.#getStableOrder(b);
		});
		return sessions;
	}

	getActiveSubagentCount(): number {
		let count = 0;
		for (const s of this.#sessions.values()) {
			if (s.kind === "subagent" && s.status === "active") count++;
		}
		return count;
	}

	/** Clear all tracked sessions (e.g. on session switch). Keeps EventBus subscriptions and listeners. */
	resetSessions(): void {
		this.#sessions.clear();
		this.#settledUsageById.clear();
		this.#runProgressById.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#notifyListeners("reset");
	}

	dispose(): void {
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];
		this.#sessions.clear();
		this.#settledUsageById.clear();
		this.#runProgressById.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#listeners.clear();
	}

	subscribeToEventBus(eventBus: EventBusLike, subagentEventBus: EventBusLike): void {
		// Dispose previous EventBus subscriptions if called again
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];

		// The task executor dual-publishes every frame on the spawning session's
		// bus and on the session tree's observability bus. Subscribe to both so
		// producers that only emit on the injected session bus still land —
		// dual-published payloads share one object reference, so each is handled
		// exactly once.
		const seen = new WeakSet<object>();
		const dedupe =
			(handle: (data: unknown) => void) =>
			(data: unknown): void => {
				if (data !== null && typeof data === "object") {
					if (seen.has(data as object)) return;
					seen.add(data as object);
				}
				handle(data);
			};

		for (const bus of [eventBus, subagentEventBus]) {
			this.#eventBusUnsubscribers.push(
				bus.on(
					TASK_SUBAGENT_LIFECYCLE_CHANNEL,
					dedupe(data => {
						const payload = data as SubagentLifecyclePayload;
						const status = STATUS_MAP[payload.status];
						if (!status) return;

						const sortOrder = this.#ensureSortOrder(payload.id);
						this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
						const existing = this.#sessions.get(payload.id);
						if (status !== "active") this.#settleRun(payload.id);
						if (existing) {
							existing.status = status;
							existing.lastUpdate = Date.now();
							existing.index = payload.index;
							existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
							existing.detached = payload.detached ?? existing.detached;
							if (payload.description) existing.description = payload.description;
							if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
						} else {
							this.#sessions.set(payload.id, {
								id: payload.id,
								kind: "subagent",
								label: payload.description ?? `Subagent #${payload.index}`,
								agent: payload.agent,
								description: payload.description,
								status,
								sessionFile: payload.sessionFile,
								parentToolCallId: payload.parentToolCallId,
								detached: payload.detached,
								index: payload.index,
								lastUpdate: Date.now(),
							});
						}
						this.#notifyListeners("lifecycle");
					}),
				),
			);

			this.#eventBusUnsubscribers.push(
				bus.on(
					TASK_SUBAGENT_PROGRESS_CHANNEL,
					dedupe(data => {
						const payload = data as SubagentProgressPayload;
						const id = payload.progress.id;
						this.#runProgressById.set(id, payload.progress);
						const progress = this.#withSettledUsage(id, payload.progress);
						const existing = this.#sessions.get(id);

						const sortOrder = this.#ensureSortOrder(id);
						this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
						if (existing) {
							existing.lastUpdate = Date.now();
							existing.index = payload.index;
							existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
							existing.detached = payload.detached ?? existing.detached;
							existing.progress = progress;
							if (progress.description) existing.description = progress.description;
							if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
						} else {
							this.#sessions.set(id, {
								id,
								kind: "subagent",
								label: progress.description ?? `Subagent #${payload.index}`,
								agent: payload.agent,
								description: progress.description,
								status: "active",
								sessionFile: payload.sessionFile,
								parentToolCallId: payload.parentToolCallId,
								detached: payload.detached,
								index: payload.index,
								lastUpdate: Date.now(),
								progress,
							});
						}
						this.#notifyListeners("progress");
					}),
				),
			);
		}
	}

	/**
	 * Fold a finished run into the agent's settled totals. The executor flushes
	 * its final progress before the settled lifecycle frame, and a follow-up
	 * turn starts a fresh monitor at zero, so later snapshots add on top.
	 */
	#settleRun(id: string): void {
		const run = this.#runProgressById.get(id);
		if (!run) return;
		this.#runProgressById.delete(id);
		this.#settledUsageById.set(id, addRunUsage(this.#settledUsageById.get(id), run));
	}

	#withSettledUsage(id: string, progress: AgentProgress): AgentProgress {
		const settled = this.#settledUsageById.get(id);
		return settled ? { ...progress, ...addRunUsage(settled, progress) } : progress;
	}
}
