function probeKey(credentialId: number, blockScope: string): string {
	return `${credentialId}\0${blockScope}`;
}

/**
 * Per-(credential, blockScope) cooldown generation + probe leases.
 *
 * A leased 2xx clears only when the lease id matches *and* the lease was
 * minted at the current cooldown generation. A later 429 bumps the generation
 * so a stale probe cannot clear the new cooldown. Retry-After sourced blocks
 * never grant a probe lease *while the wait is active*; once `untilMs` elapses
 * (or the persisted block is gone) probing is allowed again. Timeout/5xx is a
 * separate soft-avoid timestamp, not a hard cooldown.
 */
export class QuotaProbeLeaseBook {
	#generation = new Map<string, number>();
	#leases = new Map<string, { id: string; generation: number }>();
	#retryAfterUntil = new Map<string, number>();
	#softUntil = new Map<string, number>();

	noteHardCooldown(credentialId: number, blockScope: string): void {
		const key = probeKey(credentialId, blockScope);
		this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
		this.#retryAfterUntil.delete(key);
		this.#leases.delete(key);
	}

	noteRetryAfterBlock(credentialId: number, blockScope: string, untilMs: number): void {
		this.noteHardCooldown(credentialId, blockScope);
		this.#retryAfterUntil.set(probeKey(credentialId, blockScope), untilMs);
	}

	noteSoftAvoid(credentialId: number, blockScope: string, untilMs: number): void {
		this.#softUntil.set(probeKey(credentialId, blockScope), untilMs);
	}

	tryAcquire(credentialId: number, blockScope: string, nowMs: number = Date.now()): string | null {
		const key = probeKey(credentialId, blockScope);
		const retryUntil = this.#retryAfterUntil.get(key);
		if (retryUntil !== undefined) {
			if (retryUntil > nowMs) return null;
			this.#retryAfterUntil.delete(key);
		}
		const softUntil = this.#softUntil.get(key);
		if (softUntil !== undefined && softUntil > nowMs) return null;
		// Single-flight: a live lease must not be overwritten by a concurrent probe.
		if (this.#leases.has(key)) return null;
		const generation = this.#generation.get(key) ?? 0;
		const id = crypto.randomUUID();
		this.#leases.set(key, { id, generation });
		return id;
	}

	/**
	 * Drop a live lease without clearing cooldown. Used when a probe attempt is
	 * abandoned (fallback / request end) so a later request can probe again.
	 */
	release(credentialId: number, blockScope: string, leaseId: string): boolean {
		const key = probeKey(credentialId, blockScope);
		const lease = this.#leases.get(key);
		if (!lease || lease.id !== leaseId) return false;
		this.#leases.delete(key);
		return true;
	}

	/**
	 * Clear the hard cooldown only for a live matching lease. `leaseId === null`
	 * is an unleased 2xx and must not clear.
	 */
	recordSuccess(credentialId: number, blockScope: string, leaseId: string | null): boolean {
		if (leaseId === null) return false;
		const key = probeKey(credentialId, blockScope);
		const lease = this.#leases.get(key);
		const generation = this.#generation.get(key) ?? 0;
		if (!lease || lease.id !== leaseId || lease.generation !== generation) return false;
		this.#leases.delete(key);
		this.#retryAfterUntil.delete(key);
		return true;
	}

	isRetryAfterSourced(credentialId: number, blockScope: string, nowMs: number = Date.now()): boolean {
		const until = this.#retryAfterUntil.get(probeKey(credentialId, blockScope));
		return until !== undefined && until > nowMs;
	}

	softAvoidUntil(credentialId: number, blockScope: string): number | undefined {
		return this.#softUntil.get(probeKey(credentialId, blockScope));
	}

	cooldownGeneration(credentialId: number, blockScope: string): number {
		return this.#generation.get(probeKey(credentialId, blockScope)) ?? 0;
	}

	purgeCredential(credentialId: number): void {
		const prefix = `${credentialId}\0`;
		for (const key of [...this.#generation.keys()]) {
			if (key.startsWith(prefix)) this.#generation.delete(key);
		}
		for (const key of [...this.#leases.keys()]) {
			if (key.startsWith(prefix)) this.#leases.delete(key);
		}
		for (const key of [...this.#softUntil.keys()]) {
			if (key.startsWith(prefix)) this.#softUntil.delete(key);
		}
		for (const key of [...this.#retryAfterUntil.keys()]) {
			if (key.startsWith(prefix)) this.#retryAfterUntil.delete(key);
		}
	}
}
