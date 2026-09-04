export interface PendingAttachToken {
	canceled: boolean;
	canceledAtEpoch: number | null;
}

/** Tracks overlapping attach operations without letting one clear another's state. */
export class PendingAttaches {
	readonly #byTab = new Map<number, Set<PendingAttachToken>>();

	begin(tabId: number): PendingAttachToken {
		const token = { canceled: false, canceledAtEpoch: null };
		const pending = this.#byTab.get(tabId) ?? new Set<PendingAttachToken>();
		pending.add(token);
		this.#byTab.set(tabId, pending);
		return token;
	}

	finish(tabId: number, token: PendingAttachToken): void {
		const pending = this.#byTab.get(tabId);
		if (!pending) return;
		pending.delete(token);
		if (pending.size === 0) this.#byTab.delete(tabId);
	}

	cancel(tabId: number, attachmentEpoch: number): void {
		for (const token of this.#byTab.get(tabId) ?? []) {
			token.canceled = true;
			token.canceledAtEpoch = attachmentEpoch;
		}
	}

	has(tabId: number): boolean {
		return (this.#byTab.get(tabId)?.size ?? 0) > 0;
	}
}
