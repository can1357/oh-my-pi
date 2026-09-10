/**
 * In-memory exclusive credential reservations for the auth-broker.
 *
 * One holder per `credentialId`. Tokens never appear on this surface.
 */

interface ReservationHold {
	requestId: string;
	expiresAtMs: number;
}

export class ReservationBook {
	#holds = new Map<number, ReservationHold>();

	tryAcquire(requestId: string, credentialId: number, ttlMs: number): boolean {
		const nowMs = Date.now();
		const held = this.#activeHold(credentialId, nowMs);
		if (held && held.requestId !== requestId) {
			return false;
		}
		this.#holds.set(credentialId, {
			requestId,
			expiresAtMs: nowMs + ttlMs,
		});
		return true;
	}

	release(requestId: string): void {
		for (const [credentialId, held] of this.#holds) {
			if (held.requestId === requestId) {
				this.#holds.delete(credentialId);
			}
		}
	}

	#activeHold(credentialId: number, nowMs: number): ReservationHold | undefined {
		const held = this.#holds.get(credentialId);
		if (!held) return undefined;
		if (held.expiresAtMs <= nowMs) {
			this.#holds.delete(credentialId);
			return undefined;
		}
		return held;
	}
}
