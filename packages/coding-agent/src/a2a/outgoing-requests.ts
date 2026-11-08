/**
 * Process-wide registry of outgoing A2A reply expectations.
 *
 * One main-thread instance owns every pending reply. Workers reach it through
 * the `a2a-outgoing` thread service; they do not keep a registry of their own.
 * Settlement is serialized so a reply, a deadline, and a cancel cannot each
 * succeed. A result that arrives before `wait` is held until that one waiter
 * observes it, then dropped. Cancel removes the entry in every state and
 * reports success only while it was still open. A waiter detached by abort
 * marks the entry so a later result is not retained. `hasOwner` is synchronous
 * and counts a kept unread result, so a lifecycle check can call it without a turn.
 */
export const A2A_REPLY_TIMEOUT_REASON = "reply timeout";

/** Absolute epoch milliseconds, or `null` when the request has no deadline. */
export interface OutgoingRequest {
	readonly messageId: string;
	readonly peer: string;
	readonly ownerId: string;
	readonly jobId: string;
	readonly deadline: number | null;
}

/**
 * Main-owned outgoing registry. `wait`'s optional signal aborts only that
 * parked waiter; it does not settle the request, but a later result is not retained.
 */
export interface OutgoingRequestsApi {
	register(request: OutgoingRequest): Promise<void>;
	wait(messageId: string, signal?: AbortSignal): Promise<string>;
	resolve(messageId: string, from: string, text: string): Promise<boolean>;
	fail(messageId: string, reason: string): Promise<boolean>;
	cancel(messageId: string): Promise<boolean>;
	hasOwner(ownerId: string): boolean;
}

/** Test-only knobs. Production constructs the registry with none of these set. */
export interface OutgoingRequestsOptions {
	/**
	 * Awaited inside the serialized transition after a settlement has claimed an
	 * open entry and before it commits. Lets a test queue the losing transition
	 * behind the winner.
	 */
	beforeCommit?: () => Promise<void>;
}

const CANCELLED_REASON = "cancelled";
const OWNER_EXITED_REASON = "owner exited";
/** `setTimeout` stores the delay as a signed 32-bit int; a larger value fires in about 1ms. */
const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

interface Waiter {
	settled: boolean;
	detach: () => void;
	resolve: (text: string) => void;
	reject: (error: unknown) => void;
}

type Outcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: Error };

interface Entry {
	readonly request: OutgoingRequest;
	readonly home?: string;
	clearTimer?: () => void;
	outcome?: Outcome;
	waiter?: Waiter;
	/** Set when a parked waiter aborts, so a later result is not retained. */
	waiterDetached?: boolean;
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string" && reason.length > 0) return new Error(reason);
	return new Error("wait aborted");
}

function settleWaiter(waiter: Waiter, outcome: Outcome): void {
	if (waiter.settled) return;
	waiter.settled = true;
	waiter.detach();
	if (outcome.ok) waiter.resolve(outcome.text);
	else waiter.reject(outcome.error);
}

/**
 * The main-thread outgoing registry. {@link OutgoingRequests.global} is that
 * instance unless a worker installed a proxy with {@link OutgoingRequests.installGlobal}.
 */
export class OutgoingRequests implements OutgoingRequestsApi {
	static #global: OutgoingRequestsApi | undefined;

	/** The installed registry; lazily a local instance unless a worker installed a proxy. */
	static global(): OutgoingRequestsApi {
		if (!OutgoingRequests.#global) OutgoingRequests.#global = new OutgoingRequests();
		return OutgoingRequests.#global;
	}

	/** Install the process-global registry. Worker bootstrap only. */
	static installGlobal(api: OutgoingRequestsApi): void {
		OutgoingRequests.#global = api;
	}

	/** Drop the installed registry. Test-only. */
	static resetGlobalForTests(): void {
		OutgoingRequests.#global = undefined;
	}

	readonly #beforeCommit: (() => Promise<void>) | undefined;
	readonly #entries = new Map<string, Entry>();
	readonly #homes = new Map<string, Set<string>>();
	/** Homes whose link just closed. Cleared once registers already queued have seen it. */
	readonly #deadHomes = new Set<string>();
	#tail: Promise<void> = Promise.resolve();

	constructor(options?: OutgoingRequestsOptions) {
		this.#beforeCommit = options?.beforeCommit;
	}

	register(request: OutgoingRequest, home?: string): Promise<void> {
		return this.#enqueue(() => {
			if (home !== undefined && this.#deadHomes.has(home)) throw new Error(OWNER_EXITED_REASON);
			if (this.#entries.has(request.messageId)) {
				throw new Error(`outgoing request already registered: ${request.messageId}`);
			}
			const entry: Entry = { request, home };
			this.#entries.set(request.messageId, entry);
			if (home !== undefined) this.#noteHome(home, request.messageId);
			this.#arm(entry);
		});
	}

	wait(messageId: string, signal?: AbortSignal): Promise<string> {
		let parked: Promise<string> | undefined;
		return this.#enqueue(() => {
			parked = this.#park(messageId, signal);
		}).then(() => {
			if (!parked) throw new Error(`outgoing wait was not armed: ${messageId}`);
			return parked;
		});
	}

	resolve(messageId: string, from: string, text: string): Promise<boolean> {
		return this.#enqueue(() => this.#resolve(messageId, from, text));
	}

	fail(messageId: string, reason: string): Promise<boolean> {
		return this.#enqueue(() => this.#fail(messageId, reason));
	}

	cancel(messageId: string): Promise<boolean> {
		return this.#enqueue(() => this.#cancel(messageId));
	}

	/** True while `ownerId` has an open request or a result no waiter has read. */
	hasOwner(ownerId: string): boolean {
		for (const entry of this.#entries.values()) {
			if (entry.request.ownerId === ownerId) return true;
		}
		return false;
	}

	/** Whether a waiter is parked. Tests use this to observe remote-wait cancellation. */
	hasWaiter(messageId: string): boolean {
		const waiter = this.#entries.get(messageId)?.waiter;
		return waiter !== undefined && !waiter.settled;
	}

	/**
	 * Drop every request registered by `home` and reject a parked waiter.
	 * A register already queued for this home fails instead of recreating the entry.
	 * The dead-home mark is cleared once that queued register has observed it.
	 */
	dropHome(home: string): void {
		this.#deadHomes.add(home);
		const ids = this.#homes.get(home);
		this.#homes.delete(home);
		if (ids) {
			for (const id of ids) {
				const entry = this.#entries.get(id);
				if (!entry || entry.home !== home) continue;
				this.#entries.delete(id);
				this.#clearTimer(entry);
				const waiter = entry.waiter;
				entry.waiter = undefined;
				if (waiter) settleWaiter(waiter, { ok: false, error: new Error(OWNER_EXITED_REASON) });
			}
		}
		void this.#enqueue(() => this.#deadHomes.delete(home));
	}

	/**
	 * Run `op` after every earlier transition. The parked `wait` promise is not
	 * part of this chain, so a reply can settle while a waiter is blocked.
	 */
	#enqueue<T>(op: () => T | Promise<T>): Promise<T> {
		const run = this.#tail.then(op, op);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#noteHome(home: string, messageId: string): void {
		let ids = this.#homes.get(home);
		if (!ids) {
			ids = new Set();
			this.#homes.set(home, ids);
		}
		ids.add(messageId);
	}

	#forgetHome(entry: Entry): void {
		if (entry.home === undefined) return;
		const ids = this.#homes.get(entry.home);
		if (!ids) return;
		ids.delete(entry.request.messageId);
		if (ids.size === 0) this.#homes.delete(entry.home);
	}

	#arm(entry: Entry): void {
		const deadline = entry.request.deadline;
		if (deadline === null) return;
		this.#scheduleDeadline(entry, deadline);
	}

	/** Re-arm in chunks of at most {@link MAX_TIMEOUT_DELAY_MS} until `deadline`. */
	#scheduleDeadline(entry: Entry, deadline: number): void {
		this.#clearTimer(entry);
		const delay = Math.min(MAX_TIMEOUT_DELAY_MS, Math.max(0, deadline - Date.now()));
		const timer = setTimeout(() => {
			void this.#enqueue(() => {
				if (this.#entries.get(entry.request.messageId) !== entry || entry.outcome) return false;
				if (Date.now() < deadline) {
					this.#scheduleDeadline(entry, deadline);
					return false;
				}
				return this.#commit(entry, { ok: false, error: new Error(A2A_REPLY_TIMEOUT_REASON) });
			});
		}, delay);
		timer.unref();
		entry.clearTimer = () => clearTimeout(timer);
	}

	#clearTimer(entry: Entry): void {
		entry.clearTimer?.();
		entry.clearTimer = undefined;
	}

	#remove(entry: Entry): void {
		if (this.#entries.get(entry.request.messageId) !== entry) return;
		this.#entries.delete(entry.request.messageId);
		this.#clearTimer(entry);
		this.#forgetHome(entry);
	}

	#park(messageId: string, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) return Promise.reject(abortError(signal.reason));
		const entry = this.#entries.get(messageId);
		if (!entry) return Promise.reject(new Error(`unknown outgoing request: ${messageId}`));
		if (entry.outcome) {
			const outcome = entry.outcome;
			this.#remove(entry);
			if (outcome.ok) return Promise.resolve(outcome.text);
			return Promise.reject(outcome.error);
		}
		if (entry.waiter) return Promise.reject(new Error(`outgoing request already awaited: ${messageId}`));
		const parked = Promise.withResolvers<string>();
		const waiter: Waiter = {
			settled: false,
			detach: () => {},
			resolve: parked.resolve,
			reject: parked.reject,
		};
		entry.waiter = waiter;
		if (signal) {
			const onAbort = (): void => {
				void this.#enqueue(() => {
					if (waiter.settled || entry.waiter !== waiter) return;
					entry.waiter = undefined;
					entry.waiterDetached = true;
					settleWaiter(waiter, { ok: false, error: abortError(signal.reason) });
				}).catch(() => {});
			};
			signal.addEventListener("abort", onAbort, { once: true });
			waiter.detach = () => signal.removeEventListener("abort", onAbort);
		}
		return parked.promise;
	}

	async #resolve(messageId: string, from: string, text: string): Promise<boolean> {
		const entry = this.#entries.get(messageId);
		if (!entry || entry.outcome || entry.request.peer !== from) return false;
		return this.#commit(entry, { ok: true, text });
	}

	async #fail(messageId: string, reason: string): Promise<boolean> {
		const entry = this.#entries.get(messageId);
		if (!entry || entry.outcome) return false;
		return this.#commit(entry, { ok: false, error: new Error(reason) });
	}

	async #cancel(messageId: string): Promise<boolean> {
		const entry = this.#entries.get(messageId);
		if (!entry) return false;
		if (entry.outcome) {
			this.#remove(entry);
			return false;
		}
		const open = await this.#commit(entry, { ok: false, error: new Error(CANCELLED_REASON) });
		if (this.#entries.get(messageId) === entry) this.#remove(entry);
		return open;
	}

	async #commit(entry: Entry, outcome: Outcome): Promise<boolean> {
		if (this.#entries.get(entry.request.messageId) !== entry || entry.outcome) return false;
		if (this.#beforeCommit) await this.#beforeCommit();
		if (this.#entries.get(entry.request.messageId) !== entry || entry.outcome) return false;
		this.#apply(entry, outcome);
		return true;
	}

	#apply(entry: Entry, outcome: Outcome): void {
		if (entry.outcome || this.#entries.get(entry.request.messageId) !== entry) return;
		entry.outcome = outcome;
		this.#clearTimer(entry);
		const waiter = entry.waiter;
		if (!waiter) {
			// Nobody is parked. Keep the result unless the waiter already left via abort.
			if (entry.waiterDetached) this.#remove(entry);
			return;
		}
		entry.waiter = undefined;
		this.#remove(entry);
		settleWaiter(waiter, outcome);
	}
}
