export interface PromptCacheHit {
	provider: string;
	model: string;
	accountId: string;
}

interface PromptCacheRecord {
	hit: PromptCacheHit;
	storedAtMs: number;
}

const PROMPT_CACHE_TTL_MS = 30 * 60 * 1000;
const PROMPT_CACHE_MAX_ENTRIES = 4096;

function cloneHit(hit: PromptCacheHit): PromptCacheHit {
	return {
		provider: hit.provider,
		model: hit.model,
		accountId: hit.accountId,
	};
}

/**
 * Bounded in-memory prompt-cache affinity. Keys are fingerprints only —
 * never prompt text, bodies, tokens, or raw headers.
 */
export class PromptCacheAffinityStore {
	#entries = new Map<string, PromptCacheRecord>();

	remember(fingerprint: string, hit: PromptCacheHit, nowMs: number = Date.now()): void {
		if (fingerprint.length === 0) return;
		this.#purgeExpired(nowMs);
		this.#entries.delete(fingerprint);
		this.#entries.set(fingerprint, { hit: cloneHit(hit), storedAtMs: nowMs });
		this.#evictOldest();
	}

	lookup(fingerprint: string, nowMs: number = Date.now()): PromptCacheHit | undefined {
		if (fingerprint.length === 0) return undefined;
		const record = this.#entries.get(fingerprint);
		if (!record) return undefined;
		if (record.storedAtMs <= nowMs - PROMPT_CACHE_TTL_MS) {
			this.#entries.delete(fingerprint);
			return undefined;
		}
		return cloneHit(record.hit);
	}

	#purgeExpired(nowMs: number): void {
		const cutoff = nowMs - PROMPT_CACHE_TTL_MS;
		for (const [fingerprint, record] of this.#entries) {
			if (record.storedAtMs <= cutoff) this.#entries.delete(fingerprint);
		}
	}

	#evictOldest(): void {
		while (this.#entries.size > PROMPT_CACHE_MAX_ENTRIES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) return;
			this.#entries.delete(oldest);
		}
	}
}
