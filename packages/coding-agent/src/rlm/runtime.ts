import { RlmLedger } from "./ledger";
import { RlmStore, type RlmBudget } from "./store";
import type { RlmTrajectoryRecord } from "./broker";
import { resolveRlmView, type RlmGrant, type RlmView } from "./view";

export interface RlmRuntimeOptions extends Partial<RlmBudget> {
	/** Stable owner id for diagnostics (eval kernel / session). */
	ownerId?: string;
	/** Adopt an existing store (legacy test wrappers). */
	store?: RlmStore;
}

/**
 * Session-owned RLM runtime (RFC v3).
 * One AgentSession → one RlmRuntime → one store + ledger.
 * Compaction must not dispose this; session dispose must.
 */
export class RlmRuntime {
	readonly store: RlmStore;
	readonly ledger: RlmLedger;
	readonly ownerId?: string;
	/** Normalized trajectory records for observability / E3–E4. */
	readonly records: RlmTrajectoryRecord[] = [];
	#disposed = false;

	constructor(options?: RlmRuntimeOptions) {
		this.ownerId = options?.ownerId;
		this.store = options?.store ?? new RlmStore(options);
		this.ledger = new RlmLedger(this.store);
	}

	/** Wrap a bare store so call sites can pass either store or runtime. */
	static fromStore(store: RlmStore, ownerId?: string): RlmRuntime {
		return new RlmRuntime({ store, ownerId });
	}
	get disposed(): boolean {
		return this.#disposed;
	}

	/** Resolve grants into an immutable capability view. */
	createView(grants: readonly RlmGrant[], options?: { maxGrants?: number; perGrantSlice?: number }): RlmView {
		this.#assertLive();
		return resolveRlmView(this.store, grants, options);
	}

	cancel(reason = "runtime-cancel"): void {
		this.ledger.abortAll(reason);
		this.store.cancel(reason);
	}

	/** Release corpus + abort leases. Idempotent. */
	dispose(reason = "runtime-dispose"): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.ledger.abortAll(reason);
		this.store.dispose(reason);
	}

	status(): string {
		const snap = this.ledger.snapshot();
		return [
			this.store.status(),
			`leases_active=${snap.activeLeases}`,
			`failed=${snap.failedCalls}`,
			`cancelled_calls=${snap.cancelledCalls}`,
			`records=${this.records.length}`,
			this.ownerId ? `owner=${this.ownerId}` : undefined,
		]
			.filter(Boolean)
			.join(" ");
	}

	#assertLive(): void {
		if (this.#disposed) throw new Error("rlm runtime disposed");
	}
}
