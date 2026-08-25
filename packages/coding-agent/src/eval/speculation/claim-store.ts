export interface ShadowClaimKey {
	siteId: string;
	dynamicPath: string;
	name: string;
	fingerprint: string;
	occurrence: number;
}

export interface ShadowClaimOutcome<T> {
	kind: "result";
	value: T;
	virtualDurationMs: number;
}

function keyOf(key: ShadowClaimKey): string {
	return `${key.siteId}\0${key.dynamicPath}\0${key.name}\0${key.fingerprint}\0${key.occurrence}`;
}

function runtimeKeyOf(key: Pick<ShadowClaimKey, "siteId" | "name" | "fingerprint">): string {
	return `${key.siteId}\0${key.name}\0${key.fingerprint}`;
}

/**
 * Per-cell one-shot outcome store. Candidates are visible only after their
 * speculative execution settles; normal bridge calls consume each outcome at
 * most once and retain baseline behavior on a miss.
 */
export class ShadowClaimStore<T> {
	#outcomes = new Map<string, ShadowClaimOutcome<T>>();
	#runtimeKeys = new Map<string, Map<number, ShadowClaimKey>>();
	#pending = new Map<string, PromiseWithResolvers<ShadowClaimOutcome<T> | undefined>>();
	#closed = false;

	register(key: ShadowClaimKey, runtimeOccurrence: number): void {
		if (this.#closed) return;
		const encoded = keyOf(key);
		if (!this.#pending.has(encoded)) this.#pending.set(encoded, Promise.withResolvers());
		const runtimeKey = runtimeKeyOf(key);
		let occurrences = this.#runtimeKeys.get(runtimeKey);
		if (!occurrences) {
			occurrences = new Map();
			this.#runtimeKeys.set(runtimeKey, occurrences);
		}
		occurrences.set(runtimeOccurrence, key);
	}

	add(key: ShadowClaimKey, outcome: ShadowClaimOutcome<T>): void {
		if (this.#closed) return;
		this.#outcomes.set(keyOf(key), outcome);
		this.#pending.get(keyOf(key))?.resolve(outcome);
	}

	miss(key: ShadowClaimKey): void {
		if (this.#closed) return;
		const encoded = keyOf(key);
		this.#pending.get(encoded)?.resolve(undefined);
		this.#pending.delete(encoded);
	}

	claim(key: ShadowClaimKey, remainingTimeoutMs: number): ShadowClaimOutcome<T> | undefined {
		if (this.#closed) return undefined;
		const encoded = keyOf(key);
		const outcome = this.#outcomes.get(encoded);
		if (!outcome || outcome.virtualDurationMs > remainingTimeoutMs) return undefined;
		this.#pending.delete(encoded);
		this.#outcomes.delete(encoded);
		return outcome;
	}

	claimRuntime(
		key: Pick<ShadowClaimKey, "siteId" | "name" | "fingerprint"> & { occurrence: number },
		remainingTimeoutMs: number,
	): ShadowClaimOutcome<T> | undefined {
		const registered = this.#runtimeKeys.get(runtimeKeyOf(key))?.get(key.occurrence);
		if (!registered) return undefined;
		const outcome = this.claim(registered, remainingTimeoutMs);
		if (outcome) this.#runtimeKeys.get(runtimeKeyOf(key))?.delete(key.occurrence);
		return outcome;
	}

	async claimRuntimeAsync(
		key: Pick<ShadowClaimKey, "siteId" | "name" | "fingerprint"> & { occurrence: number },
		remainingTimeoutMs: number,
	): Promise<ShadowClaimOutcome<T> | undefined> {
		const registered = this.#runtimeKeys.get(runtimeKeyOf(key))?.get(key.occurrence);
		if (!registered) return undefined;
		const immediate = this.claim(registered, remainingTimeoutMs);
		if (immediate || remainingTimeoutMs <= 0) return immediate;
		const pending = this.#pending.get(keyOf(registered));
		if (!pending) return undefined;
		if (remainingTimeoutMs === Number.MAX_SAFE_INTEGER) {
			await pending.promise;
		} else {
			const timeout = Promise.withResolvers<void>();
			const timer = setTimeout(timeout.resolve, remainingTimeoutMs);
			try {
				await Promise.race([pending.promise, timeout.promise]);
			} finally {
				clearTimeout(timer);
			}
		}
		const outcome = this.claim(registered, remainingTimeoutMs);
		if (!outcome) this.#runtimeKeys.get(runtimeKeyOf(key))?.delete(key.occurrence);
		return outcome;
	}

	discard(): void {
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.resolve(undefined);
		this.#pending.clear();
		this.#outcomes.clear();
		this.#runtimeKeys.clear();
	}
}
