import * as AIError from "../error";
import type { CredentialCacheStore } from "./store";

/** Default provider-wide pause after an unattributed refusal (30 min). */
export const DEFAULT_PROVIDER_COOLDOWN_MS = 30 * 60 * 1000;

const CACHE_KEY_PREFIX = "provider-cooldown:";

/** Pause length new trips use (see {@link setProviderCooldownMs}). */
let providerCooldownMs = DEFAULT_PROVIDER_COOLDOWN_MS;

/**
 * Sets how long an unattributed refusal pauses its provider, process-wide; `0`
 * turns the pause off (the refusal still stays on the account that received
 * it). Applies to trips from now on; running pauses keep their deadline.
 */
export function setProviderCooldownMs(ms: number): void {
	providerCooldownMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
}

interface CooldownEntry {
	untilMs: number;
	reason: string;
}

/**
 * Provider-wide request latch. After a provider refuses a request in a way
 * that implicates the client rather than one account (an unattributed
 * Antigravity 429), every account of that provider is held back until the
 * cooldown expires, so retries, subagents, and new turns do not fan the
 * refusal out across the pool. Entries live in memory and in the credential
 * store's cache table; every check re-reads the store and honors the later
 * deadline, so processes sharing the store see each other's trips and
 * extensions at once.
 */
export class ProviderCooldowns {
	readonly #store: CredentialCacheStore;
	readonly #cooldownMs: number | undefined;
	readonly #entries = new Map<string, CooldownEntry>();

	/** `cooldownMs` pins the pause length; omitted, trips follow {@link setProviderCooldownMs}. */
	constructor(store: CredentialCacheStore, cooldownMs?: number) {
		this.#store = store;
		this.#cooldownMs = cooldownMs;
	}

	/** Start (or extend) the provider's cooldown; a no-op while the pause length is `0`. */
	trip(provider: string, reason: string): void {
		const cooldownMs = this.#cooldownMs ?? providerCooldownMs;
		if (cooldownMs <= 0) return;
		const untilMs = Math.max(Date.now() + cooldownMs, this.#active(provider)?.untilMs ?? 0);
		const entry = { untilMs, reason };
		this.#entries.set(provider, entry);
		this.#store.setCache(`${CACHE_KEY_PREFIX}${provider}`, JSON.stringify(entry), Math.ceil(untilMs / 1000));
	}

	/** Throws {@link AIError.ProviderCooldownError} while the provider is cooling down. */
	assertReady(provider: string): void {
		const entry = this.#active(provider);
		if (entry) throw new AIError.ProviderCooldownError(provider, entry.untilMs, entry.reason);
	}

	/** Whether the provider is currently cooling down. */
	isCooling(provider: string): boolean {
		return this.#active(provider) !== undefined;
	}

	#active(provider: string): CooldownEntry | undefined {
		const now = Date.now();
		const memory = this.#entries.get(provider);
		const persisted = parseEntry(this.#store.getCache(`${CACHE_KEY_PREFIX}${provider}`));
		const latest = !persisted || (memory && memory.untilMs >= persisted.untilMs) ? memory : persisted;
		if (!latest || latest.untilMs <= now) {
			this.#entries.delete(provider);
			return undefined;
		}
		this.#entries.set(provider, latest);
		return latest;
	}
}

function parseEntry(raw: string | null): CooldownEntry | undefined {
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as Partial<CooldownEntry>;
		return typeof value.untilMs === "number" && typeof value.reason === "string"
			? { untilMs: value.untilMs, reason: value.reason }
			: undefined;
	} catch {
		return undefined;
	}
}
