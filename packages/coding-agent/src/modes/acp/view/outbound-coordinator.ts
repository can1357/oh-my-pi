/**
 * The per-session outbound coordinator.
 *
 * `AgentSession#emit` does not await async listeners and `AcpAgent#trackPromptEvent`
 * starts handlers concurrently, so one event that produces several frames can
 * interleave with the next event's frames unless something serializes whole
 * batches. The ACP subscriber therefore reduces **synchronously** before its first
 * `await` and hands the resulting batch to this coordinator, which drains batches
 * in registration order.
 *
 * Three behaviours here are load-bearing and were specified before implementation:
 *
 * 1. **Poisoning is executable state, not a comment.** The first failed send moves
 *    the coordinator to `poisoned`, rejects every queued batch and every pending
 *    permission reservation, and invokes the managed abort exactly once. Later
 *    enqueues fail without a wire attempt, so no frame can imply the client
 *    repaired an unknown state.
 * 2. **A permission request is never awaited inside the queue.** The SDK's
 *    `sendRequest` queues its write synchronously but resolves only when the user
 *    answers; awaiting that inside the sequencer would head-of-line-block every
 *    later update behind an open dialog. The slot invokes `requestPermission()`,
 *    captures the response promise in a **box**, and releases immediately. The box
 *    matters: returning `Promise<Promise<T>>` would be assimilated by JS promise
 *    resolution and silently recreate the block.
 * 3. **The reserved slot is dependency-aware.** A plain promise chain cannot
 *    express "hold everything except the one batch I am waiting for": the pending
 *    permission would sit at the head of the FIFO while its own `started` batch
 *    queued up behind it, and deadlock. So the queue is an explicit entry list and
 *    a slot for tool call T lets exactly T's start batch pass it.
 */

/** A boxed response promise, handed out without being awaited inside the queue. */
export interface PermissionResponseBox<T> {
	readonly response: Promise<T>;
}

type CoordinatorState = { readonly kind: "open" } | { readonly kind: "poisoned"; readonly error: unknown };

interface WriteEntry {
	readonly kind: "write";
	readonly toolCallId: string | undefined;
	readonly isStart: boolean;
	/**
	 * The last batch this tool call will ever register — its settlement.
	 *
	 * Release is a queue entry rather than a direct `delete` on purpose: a call's
	 * start batch can still be in flight when the reducer reaches `settled`, and an
	 * eager delete is undone by the start's own `#startsDelivered.add` when the
	 * slow write finally lands, leaking the id for the life of the session.
	 * Releasing in FIFO position makes "released" mean "after this call's own
	 * settlement reached the writer".
	 */
	readonly isFinal: boolean;
	readonly run: () => Promise<void>;
	readonly settle: (error?: unknown) => void;
}

interface PermissionEntry {
	readonly kind: "permission";
	readonly toolCallId: string;
	readonly invoke: () => Promise<unknown>;
	readonly deliver: (response: Promise<unknown>) => void;
	readonly fail: (error: unknown) => void;
}

type QueueEntry = WriteEntry | PermissionEntry;

/** Options for {@link AcpOutboundCoordinator}. */
export interface AcpOutboundCoordinatorOptions {
	/**
	 * Invoked exactly once when the coordinator poisons. The owner uses it to abort
	 * the prompt/session through the managed path — a caught-and-logged send
	 * failure that lets `agent_end` report success is the failure mode this exists
	 * to prevent.
	 */
	readonly onPoison: (error: unknown) => void;
	/**
	 * How long a reserved permission slot waits for its tool call's `started`
	 * batch before proceeding anyway.
	 *
	 * A bounded wait is mandatory, not defensive: a permission request can belong
	 * to a call the ACP layer never announces (a hidden/internal tool), and an
	 * unbounded barrier would fence that tool forever.
	 */
	readonly startBarrierTimeoutMs?: number;
}

const DEFAULT_START_BARRIER_TIMEOUT_MS = 10_000;

export class AcpOutboundCoordinator {
	#state: CoordinatorState = { kind: "open" };
	readonly #queue: QueueEntry[] = [];
	#draining = false;
	/** Tool calls whose start batch has been delivered, retained until settlement. */
	readonly #startsDelivered = new Set<string>();
	/** Timers armed for permission slots still waiting on a start barrier. */
	readonly #barrierTimers = new Map<PermissionEntry, NodeJS.Timeout>();
	readonly #barrierExpired = new Set<PermissionEntry>();
	/**
	 * Waiters registered by {@link AcpOutboundCoordinator.idle}.
	 *
	 * A real completion primitive, not a poll: the previous implementation spun on
	 * `while (this.#draining) await Promise.resolve()`, an unbroken microtask chain
	 * that starves the macrotask queue. A writer awaiting a timer (`Bun.sleep`) or
	 * an externally resolved promise could never make progress, and neither could
	 * the cancellation timeout that races this — `idle()` hung the process instead
	 * of resolving.
	 */
	readonly #idleWaiters = new Set<() => void>();
	readonly #onPoison: (error: unknown) => void;
	readonly #startBarrierTimeoutMs: number;
	#poisonNotified = false;

	constructor(options: AcpOutboundCoordinatorOptions) {
		this.#onPoison = options.onPoison;
		this.#startBarrierTimeoutMs = options.startBarrierTimeoutMs ?? DEFAULT_START_BARRIER_TIMEOUT_MS;
	}

	/** Whether the coordinator has poisoned. */
	get poisoned(): boolean {
		return this.#state.kind === "poisoned";
	}

	/** The error that poisoned the coordinator, if any. */
	get poisonError(): unknown {
		return this.#state.kind === "poisoned" ? this.#state.error : undefined;
	}

	/**
	 * Register a whole frame batch. Resolves once every send in the batch has been
	 * attempted and fulfilled; rejects if the coordinator is (or becomes) poisoned.
	 */
	enqueue(
		run: () => Promise<void>,
		options: {
			readonly toolCallId?: string;
			readonly isStart?: boolean;
			/** This batch is the call's settlement; release its ordering state after it lands. */
			readonly isFinal?: boolean;
		} = {},
	): Promise<void> {
		if (this.#state.kind === "poisoned") {
			return Promise.reject(this.#state.error);
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#queue.push({
			kind: "write",
			toolCallId: options.toolCallId,
			isStart: options.isStart === true,
			isFinal: options.isFinal === true,
			run,
			settle: error => {
				if (error === undefined) resolve();
				else reject(error);
			},
		});
		void this.#drain();
		return promise;
	}

	/**
	 * Reserve the permission slot for `toolCallId` **synchronously**, then wait for
	 * that call's start batch outside the caller's control flow.
	 *
	 * Returns a box holding the client's eventual answer. The caller awaits
	 * `box.response`; the coordinator does not.
	 */
	reservePermission<T>(toolCallId: string, invoke: () => Promise<T>): PermissionResponseBox<T> {
		if (this.#state.kind === "poisoned") {
			return { response: Promise.reject(this.#state.error) };
		}
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const entry: PermissionEntry = {
			kind: "permission",
			toolCallId,
			invoke: invoke as () => Promise<unknown>,
			deliver: response => {
				resolve(response as Promise<T>);
			},
			fail: reject,
		};
		this.#queue.push(entry);
		this.#armBarrierTimer(entry);
		void this.#drain();
		return { response: promise };
	}

	/**
	 * Release a settled call's ordering state, **in FIFO position**.
	 *
	 * Deliberately not a direct `delete`: the call's own start batch may still be in
	 * flight, and the start's completion re-adds the id after an eager delete, so
	 * the entry leaks for the life of the session. Queuing a zero-write final entry
	 * ties release to delivered settlement instead.
	 *
	 * The ACP agent only reaches this when a settlement produced no frames; a
	 * settlement batch carries `isFinal` and releases itself.
	 */
	releaseCall(toolCallId: string): void {
		if (this.#state.kind === "poisoned") {
			this.#startsDelivered.delete(toolCallId);
			return;
		}
		this.#queue.push({
			kind: "write",
			toolCallId,
			isStart: false,
			isFinal: true,
			run: () => Promise.resolve(),
			settle: () => undefined,
		});
		void this.#drain();
	}

	/**
	 * Poison the coordinator: reject everything queued, refuse later enqueues, and
	 * invoke the managed abort once.
	 */
	poison(error: unknown): void {
		if (this.#state.kind === "poisoned") return;
		this.#state = { kind: "poisoned", error };
		const pending = this.#queue.splice(0, this.#queue.length);
		// Nothing may be written again, so no call can ever have an ordering
		// prerequisite either. Dropping the delivered-start set here is what keeps a
		// poisoned coordinator from retaining per-call state for a session that is
		// being torn down.
		this.#startsDelivered.clear();
		for (const entry of pending) {
			if (entry.kind === "write") entry.settle(error);
			else {
				this.#clearBarrierTimer(entry);
				entry.fail(error);
			}
		}
		if (!this.#poisonNotified) {
			this.#poisonNotified = true;
			this.#onPoison(error);
		}
		this.#notifyIdle();
	}

	/**
	 * Reject any pending permission reservation without poisoning — used on abort
	 * and connection close so a tool is not left fenced.
	 */
	rejectPendingPermissions(error: unknown): void {
		for (let index = this.#queue.length - 1; index >= 0; index--) {
			const entry = this.#queue[index];
			if (entry?.kind !== "permission") continue;
			this.#queue.splice(index, 1);
			this.#clearBarrierTimer(entry);
			entry.fail(error);
		}
		void this.#drain();
	}

	/**
	 * Resolves once the queue has no runnable work left.
	 *
	 * Backed by a completion waiter, never a poll: an `await Promise.resolve()`
	 * spin is an unbroken microtask chain, which starves timers and I/O. A writer
	 * awaiting `Bun.sleep()` would never resume and the racing cancellation timeout
	 * would never fire, so the caller hung instead of timing out.
	 *
	 * "No runnable work" deliberately includes a permission slot still waiting on
	 * its start barrier: that entry is blocked on an event outside the queue, and
	 * treating it as work would make cancellation cleanup wait out the barrier.
	 */
	idle(): Promise<void> {
		if (this.#isIdle()) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#idleWaiters.add(resolve);
		return promise;
	}

	#isIdle(): boolean {
		return !this.#draining && this.#nextRunnable() === -1;
	}

	/** Settle idle waiters, but only once the queue really has nothing runnable. */
	#notifyIdle(): void {
		if (this.#idleWaiters.size === 0 || !this.#isIdle()) return;
		const waiters = Array.from(this.#idleWaiters);
		this.#idleWaiters.clear();
		for (const resolve of waiters) resolve();
	}

	#armBarrierTimer(entry: PermissionEntry): void {
		if (this.#startsDelivered.has(entry.toolCallId)) return;
		const timer = setTimeout(() => {
			this.#barrierTimers.delete(entry);
			this.#barrierExpired.add(entry);
			void this.#drain();
		}, this.#startBarrierTimeoutMs);
		// Do not hold the event loop open for an ordering nicety.
		timer.unref?.();
		this.#barrierTimers.set(entry, timer);
	}

	#clearBarrierTimer(entry: PermissionEntry): void {
		const timer = this.#barrierTimers.get(entry);
		if (timer !== undefined) clearTimeout(timer);
		this.#barrierTimers.delete(entry);
		this.#barrierExpired.delete(entry);
	}

	#permissionReady(entry: PermissionEntry): boolean {
		return this.#startsDelivered.has(entry.toolCallId) || this.#barrierExpired.has(entry);
	}

	/**
	 * Index of the next runnable entry, or `-1` when the queue is blocked.
	 *
	 * A permission slot that is not ready holds every later write **except** the
	 * start batch of the very call it waits for. Scanning past held writes to find
	 * that one batch preserves the relative order of everything else, which is what
	 * makes `started → permission → unrelated update` come out right.
	 */
	#nextRunnable(): number {
		const blocking = new Set<string>();
		for (let index = 0; index < this.#queue.length; index++) {
			const entry = this.#queue[index];
			if (entry === undefined) continue;
			if (entry.kind === "permission") {
				if (blocking.size === 0 && this.#permissionReady(entry)) return index;
				blocking.add(entry.toolCallId);
				continue;
			}
			if (blocking.size === 0) return index;
			if (entry.isStart && entry.toolCallId !== undefined && blocking.has(entry.toolCallId)) return index;
		}
		return -1;
	}

	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			for (;;) {
				if (this.#state.kind === "poisoned") return;
				const index = this.#nextRunnable();
				if (index === -1) return;
				const entry = this.#queue.splice(index, 1)[0];
				if (entry === undefined) return;
				if (entry.kind === "permission") {
					this.#clearBarrierTimer(entry);
					try {
						// `invoke()` queues the JSON-RPC write synchronously; its promise is
						// handed to the caller in a box and deliberately not awaited here.
						entry.deliver(entry.invoke());
					} catch (error) {
						entry.fail(error);
					}
					continue;
				}
				try {
					await entry.run();
					if (entry.toolCallId !== undefined) {
						// Order matters and is the point of tying both transitions to a
						// *delivered* write: a start marks the call ready for its permission
						// slot, and its settlement — which can only be queued after the start —
						// releases it again.
						if (entry.isStart) this.#startsDelivered.add(entry.toolCallId);
						if (entry.isFinal) this.#startsDelivered.delete(entry.toolCallId);
					}
					entry.settle();
				} catch (error) {
					entry.settle(error);
					this.poison(error);
					return;
				}
			}
		} finally {
			this.#draining = false;
			this.#notifyIdle();
		}
	}
}
