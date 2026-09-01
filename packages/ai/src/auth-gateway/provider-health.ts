/**
 * Per-(provider, model) consecutive-failure circuit for auth-gateway target
 * selection. Credential failures never trip the circuit; provider and model
 * failures degrade then open. An open circuit expires to degraded after 30s
 * and returns to healthy only on a later success.
 */

export type TargetHealthState = "healthy" | "degraded" | "open";

export type ProviderHealthFailureKind = "provider" | "model" | "credential";

const OPEN_AFTER_FAILURES = 3;
const DEGRADED_AFTER_FAILURES = 1;
const OPEN_EXPIRE_MS = 30_000;

interface TargetHealthEntry {
	consecutiveFailures: number;
	openedAtMs: number | undefined;
}

function targetKey(provider: string, model: string): string {
	return `${provider}\0${model}`;
}

/**
 * In-memory health book keyed by `provider\\0model`. No I/O, no logging.
 */
export class ProviderHealthBook {
	#targets = new Map<string, TargetHealthEntry>();

	recordSuccess(provider: string, model: string, _nowMs?: number): void {
		this.#targets.delete(targetKey(provider, model));
	}

	recordFailure(provider: string, model: string, kind: ProviderHealthFailureKind, nowMs?: number): void {
		if (kind === "credential") return;
		const now = nowMs ?? Date.now();
		const key = targetKey(provider, model);
		const entry = this.#targets.get(key) ?? { consecutiveFailures: 0, openedAtMs: undefined };
		entry.consecutiveFailures += 1;
		if (entry.consecutiveFailures >= OPEN_AFTER_FAILURES) {
			const expired = entry.openedAtMs !== undefined && now - entry.openedAtMs >= OPEN_EXPIRE_MS;
			if (entry.openedAtMs === undefined || expired) {
				entry.openedAtMs = now;
			}
		}
		this.#targets.set(key, entry);
	}

	state(provider: string, model: string, nowMs?: number): TargetHealthState {
		const entry = this.#targets.get(targetKey(provider, model));
		if (!entry || entry.consecutiveFailures < DEGRADED_AFTER_FAILURES) return "healthy";
		if (entry.consecutiveFailures >= OPEN_AFTER_FAILURES) {
			const now = nowMs ?? Date.now();
			if (entry.openedAtMs !== undefined && now - entry.openedAtMs >= OPEN_EXPIRE_MS) {
				return "degraded";
			}
			return "open";
		}
		return "degraded";
	}
}
