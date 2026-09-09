/**
 * Background OAuth refresh loop for the auth-broker server.
 *
 * Iterates active OAuth credentials at `refreshIntervalMs` cadence, refreshing
 * any whose `expires - Date.now() < refreshSkewMs`. Refresh single-flight
 * lives in {@link AuthStorage} so manual and background refreshes share the
 * same upstream attempt.
 * Definitively-failed credentials (invalid_grant / bare 401, not a network
 * blip) are torn down inside {@link AuthStorage.refreshCredentialById} via a
 * compare-and-set disable — only when no peer/login rotated the row first — so
 * the next snapshot pull surfaces a clean delete on the client.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { type AuthStorage, isDefinitiveOAuthFailure } from "../auth-storage";
import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types";

export interface AuthBrokerRefresherOptions {
	storage: AuthStorage;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Loop cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Override clock (tests). */
	now?: () => number;
}

export interface AuthBrokerRefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepAt: number;
}

export class AuthBrokerRefresher {
	readonly #storage: AuthStorage;
	readonly #refreshSkewMs: number;
	readonly #refreshIntervalMs: number;
	readonly #now: () => number;
	#timer: NodeJS.Timeout | undefined;
	#running = false;
	#nextSweepAt: number;
	constructor(opts: AuthBrokerRefresherOptions) {
		this.#storage = opts.storage;
		this.#refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#now = opts.now ?? Date.now;
		this.#nextSweepAt = this.#now();
	}

	start(): void {
		if (this.#timer !== undefined) return;
		// Refresh sweep is best-effort; kick once immediately so freshly-booted
		// brokers don't hand out near-expired tokens for the first interval.
		this.#nextSweepAt = this.#now();
		void this.tick();
		this.#timer = setInterval(() => {
			void this.tick();
		}, this.#refreshIntervalMs);
	}

	stop(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	getSchedule(): AuthBrokerRefresherSchedule {
		return {
			enabled: true,
			intervalMs: this.#refreshIntervalMs,
			skewMs: this.#refreshSkewMs,
			nextSweepAt: this.#nextSweepAt,
		};
	}

	/** Run one sweep. Exposed for tests. */
	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#nextSweepAt = this.#now();
		try {
			await this.#storage.reload();
			const snapshot = this.#storage.exportSnapshot();
			const now = this.#now();
			const deadline = now + this.#refreshSkewMs;
			const targets: number[] = [];
			for (const entry of snapshot.credentials) {
				if (entry.credential.type !== "oauth") continue;
				const expires = entry.credential.expires;
				if (typeof expires !== "number" || !Number.isFinite(expires)) continue;
				if (expires > deadline) continue;
				targets.push(entry.id);
			}
			await Promise.all(targets.map(id => this.#refreshOne(id)));
		} finally {
			this.#running = false;
			this.#nextSweepAt = this.#now() + this.#refreshIntervalMs;
		}
	}

	async #refreshOne(id: number): Promise<void> {
		try {
			await this.#storage.refreshCredentialById(id);
		} catch (error) {
			const errorMsg = String(error);
			if (isDefinitiveOAuthFailure(errorMsg)) {
				// AuthStorage.refreshCredentialById already CAS-disabled the row
				// (unless a peer/login rotated it first, in which case the live
				// credential is intentionally kept). Nothing to do here but record it.
				logger.warn("auth-broker refresh failed definitively", { id, error: errorMsg });
			} else {
				logger.debug("auth-broker refresh failed (transient)", { id, error: errorMsg });
			}
		}
	}
}
