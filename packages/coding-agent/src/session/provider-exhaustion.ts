import * as fs from "node:fs";
import * as path from "node:path";
import { is402BillingCapBody, isDashScopeTokenLimitText, isUsageLimitOutcome } from "@oh-my-pi/pi-ai";
import { extractRetryHint, getProviderCooldownsPath, logger } from "@oh-my-pi/pi-utils";
import { withFileLockSync } from "@oh-my-pi/pi-utils/file-lock";

/**
 * Billing and quota failures keep a provider out of fallback chains and new
 * subagent spawns; without explicit retry timing the ban lasts one hour.
 */
export const PROVIDER_EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1_000;

/** One provider's persisted unavailability record. */
export interface ProviderExhaustionRecord {
	provider: string;
	reason: string;
	recordedAt: number;
	until: number;
}

/** Reason shown in spawn order/fallbacks when an exhausted provider is skipped. */
export interface ProviderExhaustionExclusion {
	provider: string;
	reason: string;
	until: number;
}

function statePath(): string {
	return getProviderCooldownsPath();
}

function readPersisted(now: number): Map<string, ProviderExhaustionRecord> {
	const live = new Map<string, ProviderExhaustionRecord>();
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(statePath(), "utf8"));
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (!entry || typeof entry !== "object") continue;
				const record = entry as Partial<ProviderExhaustionRecord>;
				if (typeof record.provider !== "string" || typeof record.until !== "number") continue;
				if (record.until <= now) continue;
				live.set(record.provider.toLowerCase(), {
					provider: record.provider,
					reason: typeof record.reason === "string" ? record.reason : "provider exhausted",
					recordedAt:
						typeof record.recordedAt === "number"
							? record.recordedAt
							: record.until - PROVIDER_EXHAUSTION_COOLDOWN_MS,
					until: record.until,
				});
			}
		}
	} catch {
		// Missing or corrupt state is treated as no recorded bans.
	}
	return live;
}

/** Temp file plus rename so concurrent sessions never observe partial state. */
function writePersisted(records: Iterable<ProviderExhaustionRecord>): void {
	const file = statePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify([...records], null, "\t"));
	fs.renameSync(tmp, file);
}

/**
 * Read-merge-write under the cross-process lock: the rename keeps readers from
 * seeing partial state, the lock keeps two processes cooling different
 * providers from overwriting each other's record.
 */
function persist(record: ProviderExhaustionRecord): void {
	withFileLockSync(statePath(), () => {
		const merged = readPersisted(Math.min(record.recordedAt, Date.now()));
		const key = record.provider.toLowerCase();
		// Preserve other providers already recorded by earlier sessions.
		const existing = merged.get(key);
		if (!existing || existing.recordedAt <= record.recordedAt) merged.set(key, record);
		writePersisted(merged.values());
	});
}

/** Mark a provider unavailable after a balance/billing/quota failure; shared by all omp processes. */
export function coolDownExhaustedProvider(provider: string, options?: { now?: number; reason?: string }): void {
	const now = options?.now ?? Date.now();
	const detail = options?.reason?.trim() || "provider exhausted";
	const reason = detail.startsWith("billing:") ? detail : `billing: ${detail}`;
	const wasCooling = isProviderExhausted(provider, now);
	const cooldownMs = extractRetryHint(undefined, detail) ?? PROVIDER_EXHAUSTION_COOLDOWN_MS;
	try {
		persist({ provider, reason, recordedAt: now, until: now + cooldownMs });
	} catch (error) {
		// The cooldown is an optimization: an unwritable state dir must not abort fallback recovery
		// or mask the original provider error.
		logger.warn("Failed to persist provider exhaustion cooldown", {
			provider,
			stateFile: statePath(),
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	if (!wasCooling) {
		logger.warn("Provider exhausted; cooling down fallback routes", {
			provider,
			reason,
			cooldownMs,
			stateFile: statePath(),
		});
	}
}

/** Whether this provider is inside its cross-process exhaustion cooldown. */
export function isProviderExhausted(provider: string, now = Date.now()): boolean {
	return readPersisted(now).has(provider.toLowerCase());
}

/** The live exhaustion record (with the reason surfaced in order/fallbacks), if any. */
export function providerExhaustionRecord(provider: string, now = Date.now()): ProviderExhaustionRecord | undefined {
	return readPersisted(now).get(provider.toLowerCase());
}

/** Explain an exclusion to callers without discarding the original provider error. */
export function providerExhaustionExclusion(provider: string): ProviderExhaustionExclusion | undefined {
	const record = providerExhaustionRecord(provider);
	if (!record) return undefined;
	return { provider, reason: `${record.reason} until ${new Date(record.until).toISOString()}`, until: record.until };
}

/** Billing and long-lived quota failures ban a provider; transient rate limits retain short retries. */
export function isProviderExhaustionError(status: number | undefined, message: string | undefined): boolean {
	const detail = message ?? "";
	// Defer to the established usage-limit classifier for what is NOT exhaustion: minute-scale token
	// throttles (DashScope `#token-limit`) and informative 402s such as "subscription required".
	if (isDashScopeTokenLimitText(detail)) return false;
	if (status === 402 && !is402BillingCapBody(message)) return false;
	// A 429 carried only inside the message (no structured status) counts too.
	if (status === 429 || (status === undefined && /\b429\b/u.test(detail))) {
		// `quota` wording must also be an account-scoped cap per the shared classifier: rolling TPM/RPM
		// windows are phrased with it too but self-heal within the minute.
		return (
			(/per[\s_-]+day|daily|quota/iu.test(detail) && isUsageLimitOutcome(429, detail)) ||
			(extractRetryHint(undefined, detail) ?? 0) >= 10 * 60 * 1_000
		);
	}
	if (status !== undefined && status >= 500 && status <= 599) return false;
	if (status === 402 || /insufficient\s+balance/iu.test(detail)) return true;
	return (
		(status === 403 || (status === undefined && /\b403\b/iu.test(detail))) &&
		/usage[\s_-]+limit|billing[\s_-]+cycle|quota/iu.test(detail)
	);
}
