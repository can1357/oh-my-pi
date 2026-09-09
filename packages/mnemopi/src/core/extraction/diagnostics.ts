export const EXTRACTION_TIERS = ["host", "remote", "local", "cloud", "wrapper"] as const;
export type ExtractionTier = (typeof EXTRACTION_TIERS)[number];

const MAX_ERROR_SAMPLES_PER_TIER = 10;
const ERROR_MESSAGE_CAP = 200;

export interface ErrorSample {
	at: string;
	type: string;
	msg: string;
	reason?: string;
}

export interface TierStatsSnapshot {
	attempts: number;
	successes: number;
	no_output: number;
	failures: number;
	error_samples: ErrorSample[];
}

export interface ExtractionStatsSnapshot {
	created_at: string;
	snapshot_at: string;
	totals: {
		calls: number;
		successes: number;
		failures: number;
		empty: number;
		success_rate: number;
	};
	by_tier: Record<ExtractionTier, TierStatsSnapshot>;
}

interface MutableTierStats {
	attempts: number;
	successes: number;
	no_output: number;
	failures: number;
	error_samples: ErrorSample[];
}

export function safeForLog(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	const s = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
	let out = "";
	for (let i = 0; i < s.length && out.length < ERROR_MESSAGE_CAP; i += 1) {
		const code = s.charCodeAt(i);
		out += code >= 32 && code !== 127 && code !== 27 ? s.charAt(i) : " ";
	}
	return out;
}

function emptyTierStats(): Record<ExtractionTier, MutableTierStats> {
	return {
		host: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		remote: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		local: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		cloud: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		wrapper: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
	};
}

function isTier(tier: string): tier is ExtractionTier {
	return (EXTRACTION_TIERS as readonly string[]).includes(tier);
}

function truncateError(msg: string): string {
	return msg.length > ERROR_MESSAGE_CAP ? `${msg.slice(0, ERROR_MESSAGE_CAP)}...[truncated]` : msg;
}

function errorRepr(exc: unknown): string {
	if (exc instanceof Error) {
		return `${exc.name}: ${exc.message}`;
	}
	return String(exc);
}

export class ExtractionDiagnostics {
	private tierStats: Record<ExtractionTier, MutableTierStats> = emptyTierStats();
	private totalCalls = 0;
	private totalSuccesses = 0;
	private totalFailures = 0;
	private totalEmpty = 0;
	private createdAt = new Date().toISOString();

	private validateTier(tier: string): asserts tier is ExtractionTier {
		if (!isTier(tier)) {
			throw new Error(
				`unknown extraction tier ${JSON.stringify(tier)}; valid tiers: ${EXTRACTION_TIERS.join(", ")}`,
			);
		}
	}

	recordAttempt(tier: ExtractionTier): void {
		this.validateTier(tier);
		this.tierStats[tier].attempts += 1;
	}
	recordSuccess(tier: ExtractionTier, _factCount = 0): void {
		this.validateTier(tier);
		this.tierStats[tier].successes += 1;
	}
	recordNoOutput(tier: ExtractionTier): void {
		this.validateTier(tier);
		this.tierStats[tier].no_output += 1;
	}
	recordFailure(tier: ExtractionTier, exc?: unknown, reason?: string): void {
		this.validateTier(tier);
		const stats = this.tierStats[tier];
		stats.failures += 1;
		const sample: ErrorSample = { at: new Date().toISOString(), type: "unspecified", msg: "" };
		if (exc !== undefined && exc !== null) {
			sample.type = exc instanceof Error ? exc.name : typeof exc;
			sample.msg = truncateError(errorRepr(exc));
		} else if (reason !== undefined) {
			sample.type = "reason";
			sample.msg = truncateError(reason);
		}
		if (reason !== undefined) {
			sample.reason = reason;
		}
		stats.error_samples.push(sample);
		if (stats.error_samples.length > MAX_ERROR_SAMPLES_PER_TIER) {
			stats.error_samples.splice(0, stats.error_samples.length - MAX_ERROR_SAMPLES_PER_TIER);
		}
	}
	recordCall(opts: { succeeded: boolean; allEmpty?: boolean }): void {
		this.totalCalls += 1;
		if (opts.succeeded) {
			this.totalSuccesses += 1;
		} else if (opts.allEmpty === true) {
			this.totalEmpty += 1;
		} else {
			this.totalFailures += 1;
		}
	}
	successRate(): number {
		return this.totalCalls === 0 ? 0 : this.totalSuccesses / this.totalCalls;
	}
	snapshot(): ExtractionStatsSnapshot {
		const byTier = {} as Record<ExtractionTier, TierStatsSnapshot>;
		for (const tier of EXTRACTION_TIERS) {
			const stats = this.tierStats[tier];
			byTier[tier] = {
				attempts: stats.attempts,
				successes: stats.successes,
				no_output: stats.no_output,
				failures: stats.failures,
				error_samples: stats.error_samples.map(sample => ({ ...sample })),
			};
		}
		return {
			created_at: this.createdAt,
			snapshot_at: new Date().toISOString(),
			totals: {
				calls: this.totalCalls,
				successes: this.totalSuccesses,
				failures: this.totalFailures,
				empty: this.totalEmpty,
				success_rate: this.successRate(),
			},
			by_tier: byTier,
		};
	}

	reset(): void {
		this.tierStats = emptyTierStats();
		this.totalCalls = 0;
		this.totalSuccesses = 0;
		this.totalFailures = 0;
		this.totalEmpty = 0;
		this.createdAt = new Date().toISOString();
	}
}

let singleton: ExtractionDiagnostics | null = null;

export function getDiagnostics(): ExtractionDiagnostics {
	if (singleton === null) {
		singleton = new ExtractionDiagnostics();
	}
	return singleton;
}

export function getExtractionStats(): ExtractionStatsSnapshot {
	return getDiagnostics().snapshot();
}

export function resetExtractionStats(): void {
	getDiagnostics().reset();
}
