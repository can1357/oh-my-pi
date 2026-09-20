import { randomUUID } from "node:crypto";
import { RlmBudgetError, type RlmStore } from "./store";

export type RlmLeaseStatus =
	| "reserved"
	| "completed"
	| "cancelled"
	| "failed"
	| "overshoot";

export interface RlmLease {
	id: string;
	reservedTokens: number;
	reservedCost: number;
	deadlineAt?: number;
	signal: AbortSignal;
	startedAt: number;
	status: RlmLeaseStatus;
	/** Provider usage after reconcile (if any). */
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cost?: number;
	closedAt?: number;
}

export interface RlmLedgerBegin {
	estimatedTokens: number;
	estimatedCost?: number;
	/** Optional hard deadline for this lease (ms epoch). */
	deadlineAt?: number;
	/** External signal (e.g. parent abort); combined with store cancel/wall-clock. */
	signal?: AbortSignal;
}

export interface RlmLedgerUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cost?: number;
}

export interface RlmLedgerReconcileResult {
	lease: RlmLease;
	tokens: number;
	cost: number;
	overBudget: boolean;
}

/**
 * Authoritative call admission + usage accounting (RFC v3).
 * Calls increment once at {@link begin}; provider usage never re-counts calls.
 */
export class RlmLedger {
	readonly #store: RlmStore;
	readonly #leases = new Map<string, RlmLease>();
	readonly #leaseControllers = new Map<string, AbortController>();

	/** Aggregate counters beyond store.budget (failed/cancelled). */
	failedCalls = 0;
	cancelledCalls = 0;

	constructor(store: RlmStore) {
		this.#store = store;
	}

	get activeLeaseCount(): number {
		let n = 0;
		for (const lease of this.#leases.values()) {
			if (lease.status === "reserved") n += 1;
		}
		return n;
	}

	/**
	 * Admit one provider inference. Increments store.budget.calls exactly once.
	 * Throws {@link RlmBudgetError} when admission is blocked.
	 */
	begin(opts: RlmLedgerBegin): RlmLease {
		const estimated = Math.max(0, Math.floor(opts.estimatedTokens));
		const estimatedCost = Math.max(0, opts.estimatedCost ?? 0);
		// Preflight cost reservation against remaining maxCost when set.
		if (
			this.#store.budget.maxCost > 0 &&
			estimatedCost > 0 &&
			this.#store.budget.cost + estimatedCost > this.#store.budget.maxCost
		) {
			throw new RlmBudgetError(`rlm maxCost ${this.#store.budget.maxCost} exhausted (admission)`);
		}
		this.#store.beginCall(estimated);

		const ctrl = new AbortController();
		const storeSignal = this.#store.createCallSignal();
		const onStoreAbort = () => {
			if (!ctrl.signal.aborted) {
				ctrl.abort(storeSignal.reason ?? new DOMException("rlm cancelled", "AbortError"));
			}
		};
		if (storeSignal.aborted) onStoreAbort();
		else storeSignal.addEventListener("abort", onStoreAbort, { once: true });

		if (opts.signal) {
			const onExt = () => {
				if (!ctrl.signal.aborted) {
					ctrl.abort(opts.signal!.reason ?? new DOMException("rlm parent abort", "AbortError"));
				}
			};
			if (opts.signal.aborted) onExt();
			else opts.signal.addEventListener("abort", onExt, { once: true });
		}

		let deadlineAt = opts.deadlineAt;
		if (deadlineAt === undefined && this.#store.budget.wallClockMs > 0) {
			deadlineAt = this.#store.budget.startedAt + this.#store.budget.wallClockMs;
		}
		if (deadlineAt !== undefined) {
			const remaining = deadlineAt - Date.now();
			if (remaining <= 0) {
				ctrl.abort(new DOMException("rlm lease deadline exhausted", "AbortError"));
			} else {
				const t = setTimeout(() => {
					ctrl.abort(new DOMException("rlm lease deadline exhausted", "AbortError"));
				}, remaining);
				ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
			}
		}

		const lease: RlmLease = {
			id: `lease:${randomUUID()}`,
			reservedTokens: estimated,
			reservedCost: estimatedCost,
			deadlineAt,
			signal: ctrl.signal,
			startedAt: Date.now(),
			status: "reserved",
		};
		this.#leases.set(lease.id, lease);
		this.#leaseControllers.set(lease.id, ctrl);
		this.#store.note("lease", `begin ${lease.id} reserved=${estimated}`);
		return lease;
	}

	/**
	 * Reconcile provider usage. Does not increment calls.
	 * Overshoot is recorded honestly on the store + lease status.
	 */
	reconcile(lease: RlmLease, usage: RlmLedgerUsage): RlmLedgerReconcileResult {
		const live = this.#leases.get(lease.id) ?? lease;
		const total =
			usage.totalTokens !== undefined
				? Math.max(0, Math.floor(usage.totalTokens))
				: usage.inputTokens !== undefined || usage.outputTokens !== undefined
					? Math.max(0, Math.floor(usage.inputTokens ?? 0) + Math.floor(usage.outputTokens ?? 0))
					: live.reservedTokens;
		const cost = usage.cost === undefined ? 0 : Math.max(0, usage.cost);
		const result = this.#store.reconcileUsage({
			estimatedTokens: live.reservedTokens,
			actualTokens: total,
			actualCost: cost,
		});
		live.inputTokens = usage.inputTokens;
		live.outputTokens = usage.outputTokens;
		live.totalTokens = total;
		live.cost = cost;
		live.status = result.overBudget ? "overshoot" : "completed";
		live.closedAt = Date.now();
		this.#leaseControllers.delete(lease.id);
		this.#store.note(
			"lease",
			`reconcile ${live.id} tokens=${total} cost=${cost} status=${live.status}`,
			result.overBudget,
		);
		return { lease: live, tokens: result.tokens, cost: result.cost, overBudget: result.overBudget };
	}

	/** Close without provider success (cancel / failure). Retains any known partial usage. */
	close(lease: RlmLease, status: "cancelled" | "failed", partial?: RlmLedgerUsage): RlmLease {
		const live = this.#leases.get(lease.id) ?? lease;
		if (partial && (partial.totalTokens !== undefined || partial.cost !== undefined)) {
			this.#store.reconcileUsage({
				estimatedTokens: live.reservedTokens,
				actualTokens: partial.totalTokens ?? live.reservedTokens,
				actualCost: partial.cost ?? 0,
			});
			live.totalTokens = partial.totalTokens ?? live.reservedTokens;
			live.cost = partial.cost ?? 0;
			live.inputTokens = partial.inputTokens;
			live.outputTokens = partial.outputTokens;
		}
		live.status = status;
		live.closedAt = Date.now();
		if (status === "cancelled") this.cancelledCalls += 1;
		if (status === "failed") this.failedCalls += 1;
		const ctrl = this.#leaseControllers.get(lease.id);
		if (ctrl && !ctrl.signal.aborted) {
			ctrl.abort(new DOMException(`rlm lease ${status}`, "AbortError"));
		}
		this.#leaseControllers.delete(lease.id);
		this.#store.note("lease", `close ${live.id} status=${status}`, true);
		return live;
	}

	/** Abort every reserved lease (runtime cancel / dispose). */
	abortAll(reason = "ledger-abort"): void {
		for (const [id, ctrl] of this.#leaseControllers) {
			if (!ctrl.signal.aborted) {
				ctrl.abort(new DOMException(reason, "AbortError"));
			}
			const lease = this.#leases.get(id);
			if (lease && lease.status === "reserved") {
				lease.status = "cancelled";
				lease.closedAt = Date.now();
				this.cancelledCalls += 1;
			}
		}
		this.#leaseControllers.clear();
	}

	snapshot(): {
		calls: number;
		tokens: number;
		cost: number;
		failedCalls: number;
		cancelledCalls: number;
		activeLeases: number;
		overBudget: boolean;
	} {
		return {
			calls: this.#store.budget.calls,
			tokens: this.#store.budget.tokens,
			cost: this.#store.budget.cost,
			failedCalls: this.failedCalls,
			cancelledCalls: this.cancelledCalls,
			activeLeases: this.activeLeaseCount,
			overBudget: this.#store.budget.overBudget === true,
		};
	}
}
