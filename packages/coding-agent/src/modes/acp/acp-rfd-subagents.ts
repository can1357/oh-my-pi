/**
 * Upstream-RFD child-session tracking for ACP standard clients.
 *
 * Mirrors codex-acp's standard router (`StandardSubagentEventRouter`): the
 * parent announces each child with a `subagent_update` patch, the child's own
 * traffic carries the child id as the outer `sessionId`, and settling emits a
 * final state patch. Entry is kept after settle (reusable-child model):
 * `parked` clears the activity without asserting idle, revival re-emits
 * `running`. No `session_message` emission — codex never emits it.
 *
 * Installed only when the client advertises `subagents` as an object in
 * `initialize` (`isStandardSubagentClient`). Unstable and experimental.
 */

import type { SessionNotification } from "@oh-my-pi/pi-utils/acp";
import type { EventBus } from "../../utils/event-bus";
import type { SubagentLifecyclePayload } from "../../task/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../task/types";

/** Sender for typed `subagent_update` notifications on the parent session. */
export type RfdUpdateSender = (notification: SessionNotification) => Promise<void>;

/** Minimal RFD client detection: `subagents` advertised as an object. */
export function isStandardSubagentClient(clientCapabilities: { subagents?: unknown } | undefined): boolean {
	const subagents = clientCapabilities?.subagents;
	return typeof subagents === "object" && subagents !== null && !Array.isArray(subagents);
}

/** Idle `stopReason` per RFD `IdleStateUpdate` from the executor lifecycle status. */
function idleStopReason(status: SubagentLifecyclePayload["status"]): string {
	switch (status) {
		case "aborted":
			return "cancelled";
		case "failed":
			return "error";
		default:
			return "end_turn";
	}
}

interface RfdChild {
	/** Registry id, sent as the RFD child `sessionId`. */
	id: string;
	announced: boolean;
	/** Last state patch sent (`running` / `idle` / cleared). Guards duplicate running patches. */
	lastState: "running" | "idle" | null;
	/** Whether a terminal patch already revoked the cancel capability. Revival restores it. */
	settled: boolean;
	/**
	 * Outer session id for this child's association patches: the immediate
	 * parent's child session when the spawner is itself a tracked child,
	 * else the root ACP session. Grandchildren associate under their spawner.
	 */
	parentSessionId: string;
}

/**
 * Lifecycle table keyed by subagent registry id, projecting executor frames
 * onto the upstream RFD `subagent_update` contract.
 */
export class RfdSubagentTracker {
	readonly #children = new Map<string, RfdChild>();
	readonly #parentSessionId: string;
	readonly #send: RfdUpdateSender;
	readonly #resolveSpawner: ((id: string) => string | undefined) | undefined;
	#unsubscribers: Array<() => void> = [];
	#disposed = false;
	/** Per-child send chains: every frame for one child applies in arrival order. */
	readonly #queues = new Map<string, Promise<void>>();

	constructor(options: {
		parentSessionId: string;
		send: RfdUpdateSender;
		resolveSpawner?: (id: string) => string | undefined;
	}) {
		this.#parentSessionId = options.parentSessionId;
		this.#send = options.send;
		this.#resolveSpawner = options.resolveSpawner;
	}

	/** Run `work` after the child's pending sends; concurrent frames serialize per child. */
	#serialize(id: string, work: () => Promise<void>): Promise<void> {
		const tail = this.#queues.get(id) ?? Promise.resolve();
		const next = tail.then(work, work);
		this.#queues.set(id, next);
		void next
			.catch(() => {})
			.finally(() => {
				if (this.#queues.get(id) === next) this.#queues.delete(id);
			});
		return next;
	}

	/** Tracked child entries (announced, live or settled). */
	get children(): ReadonlyMap<string, RfdChild> {
		return this.#children;
	}

	/**
	 * Outer session for a child's association patches: the spawner's own
	 * child session when the spawner is tracked, else the root session.
	 * Read live so a parent announced after its child still nests correctly.
	 */
	#resolveParentSession(id: string): string {
		const spawner = this.#resolveSpawner?.(id);
		if (spawner !== undefined && this.#children.has(spawner)) return spawner;
		return this.#parentSessionId;
	}

	/** Subscribe to the session tree's subagent bus. */
	subscribe(bus: EventBus | undefined): void {
		if (!bus || this.#disposed) return;
		this.#unsubscribers.push(
			bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				void this.handleLifecycle(data as SubagentLifecyclePayload).catch(() => {});
			}),
		);
	}

	dispose(): void {
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#children.clear();
	}

	async handleLifecycle(payload: SubagentLifecyclePayload): Promise<void> {
		if (!payload || typeof payload.id !== "string" || payload.id.length === 0) return;
		return this.#serialize(payload.id, () => this.#applyLifecycle(payload));
	}

	/**
	 * Apply one lifecycle frame for a child. Runs inside the per-child send
	 * chain, so announce always precedes running, and a terminal settle always
	 * precedes any later revival frame.
	 */
	async #applyLifecycle(payload: SubagentLifecyclePayload): Promise<void> {
		if (payload.status === "started") {
			let child = this.#children.get(payload.id);
			if (!child) {
				child = {
					id: payload.id,
					announced: false,
					lastState: null,
					settled: false,
					parentSessionId: this.#resolveParentSession(payload.id),
				};
				this.#children.set(payload.id, child);
			}
			if (child.announced) return;
			child.announced = true;
			await this.#send({
				sessionId: child.parentSessionId,
				update: {
					sessionUpdate: "subagent_update",
					sessionId: child.id,
					title: payload.agent?.trim() || undefined,
					description: payload.description?.trim() || undefined,
					capabilities: { cancel: {} },
				},
			});
			child.lastState = "running";
			await this.#send({
				sessionId: child.parentSessionId,
				update: {
					sessionUpdate: "subagent_update",
					sessionId: child.id,
					state: { state: "running" },
				},
			});
			return;
		}
		if (payload.status !== "completed" && payload.status !== "failed" && payload.status !== "aborted") return;
		const child = this.#children.get(payload.id);
		if (!child) return;
		if (child.lastState === "idle") return;
		child.lastState = "idle";
		child.settled = true;
		await this.#send({
			sessionId: child.parentSessionId,
			update: {
				sessionUpdate: "subagent_update",
				sessionId: child.id,
				state: { state: "idle", stopReason: idleStopReason(payload.status) },
				capabilities: { cancel: null },
			},
		});
	}

	/**
	 * Mirror registry run-state transitions for reusable children: `parked`
	 * clears the activity without asserting idle; a later `running` revives it.
	 * No-ops for unknown ids and duplicate states.
	 */
	handleRegistryStatus(ref: { id: string; status: string }): void {
		const child = this.#children.get(ref.id);
		if (!child || !child.announced) return;
		if (ref.status === "parked" && child.lastState !== null) {
			child.lastState = null;
			void this.#send({
				sessionId: child.parentSessionId,
				update: { sessionUpdate: "subagent_update", sessionId: child.id, state: null },
			});
		} else if (ref.status === "running" && child.lastState !== "running") {
			child.lastState = "running";
			// A revival after settle must also restore the cancel capability
			// the terminal patch revoked; the announce path already carries it.
			const capabilities = child.settled ? { cancel: {} } : undefined;
			child.settled = false;
			void this.#send({
				sessionId: child.parentSessionId,
				update: {
					sessionUpdate: "subagent_update",
					sessionId: child.id,
					state: { state: "running" },
					...(capabilities !== undefined ? { capabilities } : {}),
				},
			});
		}
	}
}
