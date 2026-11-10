import type { ThreadId } from "../thread/identity";
import type { A2aIncomingRequest } from "./rpc";
import type { AgentRegistryApi } from "../registry/agent-registry";

export interface IncomingRequestMatch {
	to: string;
	from?: string;
	messageId?: string;
}

/** A claimed request plus the opaque token that settles exactly that claim. */
export interface IncomingRequestLease {
	/** Opaque, single-use token; a fresh value on every claim. */
	leaseId: string;
	request: A2aIncomingRequest;
}

export interface IncomingRequestsApi {
	note(request: A2aIncomingRequest): Promise<void>;
	consume(match: IncomingRequestMatch): Promise<IncomingRequestLease | undefined>;
	/** Permanently remove the claimed request; false for a stale or foreign token. */
	confirm(leaseId: string): Promise<boolean>;
	/** Return the claimed request to its original FIFO position; false for a stale or foreign token. */
	release(leaseId: string): Promise<boolean>;
	/**
	 * Remove every matching record, open or leased. Unlike a lease settlement it
	 * targets bookkeeping, not one claim: the exact rollback of a refused
	 * delivery (`{to, from, messageId}`) or a recipient's whole queue
	 * (`{to}`). Discarded lease ids are spent; the records cannot resurrect.
	 */
	discard(match: IncomingRequestMatch): Promise<void>;
	list(to?: string): Promise<A2aIncomingRequest[]>;
}

interface LedgerEntry {
	/** Sequence key: open requests keep their original arrival position. */
	readonly seq: number;
	request: A2aIncomingRequest;
	/** The outstanding claim, absent while the request is open. */
	lease?: {
		readonly id: string;
		/** Worker thread that claimed it; `undefined` is a main-thread claim. */
		readonly home?: ThreadId;
	};
}

/**
 * Main-owned ledger; worker threads install a proxy to the same ledger.
 *
 * A claim (`consume`) moves the entry into a leased state carrying a fresh
 * opaque lease id instead of removing it, so a worker that dies before its
 * reply is acknowledged can have exactly its claims reopened (`dropHome`).
 * `confirm` removes the request permanently; `release` puts it back at its
 * original FIFO position with a new lease issued on the next claim, so a
 * spent token can never settle a reopened request.
 */
export class IncomingRequests implements IncomingRequestsApi {
	static #global: IncomingRequestsApi | undefined;

	static global(): IncomingRequestsApi {
		if (!IncomingRequests.#global) IncomingRequests.#global = new IncomingRequests();
		return IncomingRequests.#global;
	}

	static installGlobal(api: IncomingRequestsApi): void {
		IncomingRequests.#global = api;
	}

	static resetGlobalForTests(): void {
		IncomingRequests.#global = undefined;
	}

	/** Open and leased entries in stable arrival order (oldest first). */
	readonly #entries: LedgerEntry[] = [];
	#seq = 0;
	/** Expiry re-arms installed by `startCleanup`; watchers never throw into callers. */
	readonly #changeWatchers = new Set<() => void>();

	async note(request: A2aIncomingRequest): Promise<void> {
		this.#entries.push({ seq: this.#seq++, request });
		this.#notifyChanged();
	}

	async consume(match: IncomingRequestMatch, home?: ThreadId): Promise<IncomingRequestLease | undefined> {
		const entry = this.#entries.find(
			entry =>
				entry.lease === undefined &&
				entry.request.to === match.to &&
				(match.from === undefined || entry.request.from === match.from) &&
				(match.messageId === undefined || entry.request.messageId === match.messageId),
		);
		if (entry === undefined) return undefined;
		entry.lease = { id: newLeaseId(), home };
		return { leaseId: entry.lease.id, request: entry.request };
	}

	async confirm(leaseId: string, home?: ThreadId): Promise<boolean> {
		const index = this.#entries.findIndex(entry => entry.lease?.id === leaseId);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.lease === undefined || !ownsLease(entry.lease, home)) return false;
		this.#entries.splice(index, 1);
		this.#notifyChanged();
		return true;
	}

	async release(leaseId: string, home?: ThreadId): Promise<boolean> {
		const entry = this.#entries.find(entry => entry.lease?.id === leaseId);
		if (entry === undefined || entry.lease === undefined) return false;
		if (!ownsLease(entry.lease, home)) return false;
		entry.lease = undefined;
		this.#notifyChanged();
		return true;
	}

	async list(to?: string): Promise<A2aIncomingRequest[]> {
		return this.#entries
			.filter(entry => entry.lease === undefined && (to === undefined || entry.request.to === to))
			.map(entry => entry.request);
	}

	/**
	 * Remove every matching record, open or leased. Unlike a lease settlement
	 * this targets bookkeeping, not one claim: the exact rollback of a refused
	 * delivery (`{to, from, messageId}`) or a recipient's whole queue (`{to}`).
	 * Discarded lease ids are spent; the records cannot resurrect.
	 */
	async discard(match: IncomingRequestMatch): Promise<void> {
		// In-place removal keeps the arrival order of every kept record; leased
		// entries go too, so their tokens settle nothing afterwards.
		const kept: LedgerEntry[] = [];
		for (const entry of this.#entries) {
			const matches =
				entry.request.to === match.to &&
				(match.from === undefined || entry.request.from === match.from) &&
				(match.messageId === undefined || entry.request.messageId === match.messageId);
			if (!matches) kept.push(entry);
		}
		this.#entries.length = 0;
		this.#entries.push(...kept);
		this.#notifyChanged();
	}

	/**
	 * Release every lease claimed by `home` (a dead worker's thread), returning
	 * those requests to their original FIFO positions. Main-thread claims and
	 * other workers' claims stay untouched; a stale lease token from the dead
	 * home is spent and can no longer settle anything.
	 */
	dropHome(home: ThreadId): void {
		for (const entry of this.#entries) {
			if (entry.lease?.home === home) entry.lease = undefined;
		}
	}

	/**
	 * Main-only maintenance for this ledger, driven by the agent registry:
	 *
	 * - A `removed` recipient can never answer, so its whole queue — open
	 *   requests and outstanding leases alike — is discarded. Their lease ids
	 *   are spent; a worker exiting later cannot reopen what is already gone.
	 * - With `replyTimeoutMs > 0`, every request expires at its absolute
	 *   `at + replyTimeoutMs` deadline whether open or leased; the earliest
	 *   deadline is armed as one timer. `replyTimeoutMs <= 0` arms no expiry
	 *   timer but keeps the removal cleanup.
	 *
	 * The timer is re-evaluated on every note, confirmation, release, discard,
	 * and expiry, and is unref'd so it never pins the event loop. The returned
	 * stop is idempotent and unsubscribes plus clears the timer.
	 */
	startCleanup(registry: Pick<AgentRegistryApi, "onChange">, replyTimeoutMs: number): () => void {
		let timer: Timer | undefined;
		let stopped = false;
		const clearTimer = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};
		const armExpiry = (): void => {
			clearTimer();
			if (stopped || replyTimeoutMs <= 0) return;
			// The earliest deadline decides the next wake-up; a deadline
			// already in the past fires on the next tick.
			let earliest: number | undefined;
			for (const entry of this.#entries) {
				const deadline = entry.request.at + replyTimeoutMs;
				if (earliest === undefined || deadline < earliest) earliest = deadline;
			}
			if (earliest === undefined) return;
			timer = setTimeout(
				() => {
					timer = undefined;
					this.#expire(Date.now(), replyTimeoutMs);
					armExpiry();
				},
				Math.max(0, earliest - Date.now()),
			);
			timer.unref?.();
		};
		const unsubscribe = registry.onChange(event => {
			if (stopped || event.type !== "removed") return;
			void this.discard({ to: event.ref.id });
		});
		this.#changeWatchers.add(armExpiry);
		armExpiry();
		return () => {
			if (stopped) return;
			stopped = true;
			unsubscribe();
			this.#changeWatchers.delete(armExpiry);
			clearTimer();
		};
	}

	/** Remove every request whose reply deadline has passed (open or leased). */
	#expire(now: number, replyTimeoutMs: number): void {
		const kept: LedgerEntry[] = [];
		for (const entry of this.#entries) {
			if (entry.request.at + replyTimeoutMs > now) kept.push(entry);
		}
		this.#entries.length = 0;
		this.#entries.push(...kept);
		this.#notifyChanged();
	}

	/** Re-arm every installed expiry watcher; a throwing watcher is contained. */
	#notifyChanged(): void {
		for (const watcher of this.#changeWatchers) {
			try {
				watcher();
			} catch {
				// Maintenance must never break a caller's settlement.
			}
		}
	}
}

function ownsLease(lease: { home?: ThreadId }, home: ThreadId | undefined): boolean {
	// A caller-supplied home must match the claim's home exactly; an unowned
	// main claim belongs to main alone. An omitted home is a main-thread caller
	// and may settle only unowned claims.
	return home === undefined ? lease.home === undefined : lease.home === home;
}

function newLeaseId(): string {
	return `lease-${crypto.randomUUID()}`;
}
