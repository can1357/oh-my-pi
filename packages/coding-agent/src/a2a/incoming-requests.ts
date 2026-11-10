import type { ThreadId } from "../thread/identity";
import type { A2aIncomingRequest } from "./rpc";

/** Criteria for atomically claiming one request addressed to a local agent. */
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

	async note(request: A2aIncomingRequest): Promise<void> {
		this.#entries.push({ seq: this.#seq++, request });
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
		return true;
	}

	async release(leaseId: string, home?: ThreadId): Promise<boolean> {
		const entry = this.#entries.find(entry => entry.lease?.id === leaseId);
		if (entry === undefined || entry.lease === undefined) return false;
		if (!ownsLease(entry.lease, home)) return false;
		entry.lease = undefined;
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
