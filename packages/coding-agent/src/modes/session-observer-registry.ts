import type { AgentProgress, SubagentLifecyclePayload, SubagentProgressPayload } from "../task";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task";
import type { EventBus } from "../utils/event-bus";

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
	 * The anchored subagent HUD only lists detached spawns: sync task spawns
	 * and eval `agent()` spawns are already rendered live by their own inline
	 * tool block / eval cell.
	 */
	detached?: boolean;
	index?: number;
	lastUpdate: number;
	/** Latest progress snapshot from the subagent executor */
	progress?: AgentProgress;
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
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#notifyListeners("reset");
	}

	dispose(): void {
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];
		this.#sessions.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#listeners.clear();
	}

	subscribeToEventBus(eventBus: EventBus, subagentEventBus: EventBus): void {
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
						const progress = payload.progress;
						const id = progress.id;
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
}
