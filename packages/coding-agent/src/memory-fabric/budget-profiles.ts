/**
 * Per-Project Budget Profiles
 *
 * Learns, per project and task category, how many memory tokens were
 * actually useful, and recommends conservative initial/maximum budgets
 * for future packets. Also provides the benchmark selection rule that
 * picks the smallest safe budget among near-best configurations.
 *
 * Fixes over the original private-fabric store:
 *  - Honest field names: the original stored a running MEAN in a field
 *    called `medianUsefulTokens` and a running MAX in `p90UsefulTokens`.
 *    Here they are `meanUsefulTokens` and `maxUsefulTokens`.
 *  - No filesystem access: the original constructed with an optional
 *    storage key and silently no-opped persistence when it was omitted,
 *    and fired an unawaited `loadFromDisk()` from the constructor. Here
 *    the caller owns IO via `exportAll()` / `loadProfiles()` round-trips
 *    (the persistence lane owns the disk, as everywhere else in the
 *    fabric).
 *  - No `as any` task profiles, no non-null `.get(key)!` assertions, and
 *    an injectable clock for deterministic tests.
 *  - `selectBestConfiguration` is a pure function instead of a
 *    static-only class.
 */

import type { ContextNeedCategory } from "./adaptive-fidelity/types";

/** Learned budget statistics for one project + task-category pair. */
export interface ProjectBudgetProfile {
	projectId: string;
	taskCategory: ContextNeedCategory;
	sampleCount: number;
	successfulRuns: number;
	/** Running mean of useful tokens across evaluated runs. */
	meanUsefulTokens: number;
	/** Largest useful-token count observed so far. */
	maxUsefulTokens: number;
	recommendedInitialTokens: number;
	recommendedMaximumTokens: number;
	lastUpdatedAt: string;
}

/** Tunables for profile learning. */
export interface BudgetProfileConfig {
	/** Starting recommendation before any samples. Default 2500. */
	defaultInitialTokens: number;
	/** Starting maximum before any samples. Default 12000. */
	defaultMaximumTokens: number;
	/** Recommendations never drop below this. Default 500. */
	minimumTokens: number;
	/** Recommendations never exceed this. Default 32000. */
	absoluteMaxTokens: number;
	/** Largest relative change per evaluated run. Default 0.1 (10%). */
	maxUpdateFraction: number;
	/** Maximum = initial * this multiplier (capped). Default 4. */
	maximumMultiplier: number;
}

export const DEFAULT_BUDGET_PROFILE_CONFIG: BudgetProfileConfig = {
	defaultInitialTokens: 2500,
	defaultMaximumTokens: 12000,
	minimumTokens: 500,
	absoluteMaxTokens: 32000,
	maxUpdateFraction: 0.1,
	maximumMultiplier: 4,
};

const VALID_CATEGORIES: readonly ContextNeedCategory[] = [
	"trivial",
	"normal",
	"debugging",
	"architecture",
	"recovery",
	"repository-wide",
];

function isValidCategory(value: unknown): value is ContextNeedCategory {
	return typeof value === "string" && (VALID_CATEGORIES as readonly string[]).includes(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * In-memory store of learned budget profiles.
 *
 * Deliberately does NOT touch the filesystem: callers persist via
 * `exportAll()` and restore via `loadProfiles()` using whatever lane
 * they own. The clock is injectable so tests are deterministic.
 */
export class ProjectBudgetProfileStore {
	private profiles = new Map<string, ProjectBudgetProfile>();
	private config: BudgetProfileConfig;
	private now: () => Date;

	constructor(config?: Partial<BudgetProfileConfig>, now?: () => Date) {
		this.config = { ...DEFAULT_BUDGET_PROFILE_CONFIG, ...config };
		this.now = now ?? (() => new Date());
	}

	/**
	 * Restore profiles from a JSON-parsed array. Entries with missing or
	 * invalid fields are skipped. Loaded entries overwrite in-memory ones
	 * with the same key (a restore represents newer durable truth).
	 * Returns the number of profiles accepted.
	 */
	loadProfiles(profiles: readonly ProjectBudgetProfile[]): number {
		if (!Array.isArray(profiles)) return 0;
		let accepted = 0;
		for (const profile of profiles) {
			if (!profile || typeof profile.projectId !== "string" || profile.projectId === "") continue;
			if (!isValidCategory(profile.taskCategory)) continue;
			if (!isFiniteNonNegative(profile.sampleCount)) continue;
			if (!isFiniteNonNegative(profile.successfulRuns)) continue;
			if (!isFiniteNonNegative(profile.meanUsefulTokens)) continue;
			if (!isFiniteNonNegative(profile.maxUsefulTokens)) continue;
			if (!isFiniteNonNegative(profile.recommendedInitialTokens)) continue;
			if (!isFiniteNonNegative(profile.recommendedMaximumTokens)) continue;
			this.profiles.set(this.key(profile.projectId, profile.taskCategory), { ...profile });
			accepted += 1;
		}
		return accepted;
	}

	/** Get an existing profile, or create a default one. */
	getProfile(projectId: string, taskCategory: ContextNeedCategory): ProjectBudgetProfile {
		const key = this.key(projectId, taskCategory);
		const existing = this.profiles.get(key);
		if (existing) return existing;
		const created: ProjectBudgetProfile = {
			projectId,
			taskCategory,
			sampleCount: 0,
			successfulRuns: 0,
			meanUsefulTokens: 0,
			maxUsefulTokens: 0,
			recommendedInitialTokens: this.config.defaultInitialTokens,
			recommendedMaximumTokens: this.config.defaultMaximumTokens,
			lastUpdatedAt: this.now().toISOString(),
		};
		this.profiles.set(key, created);
		return created;
	}

	/**
	 * Record one evaluated run. The recommendation moves toward the
	 * observed useful-token count, but never by more than
	 * `maxUpdateFraction` of its current value per run, and always stays
	 * within [minimumTokens, absoluteMaxTokens].
	 */
	updateProfile(
		projectId: string,
		taskCategory: ContextNeedCategory,
		usefulTokens: number,
		success: boolean,
	): ProjectBudgetProfile {
		const profile = this.getProfile(projectId, taskCategory);
		const observed = Math.max(0, usefulTokens);

		profile.sampleCount += 1;
		if (success) profile.successfulRuns += 1;
		profile.meanUsefulTokens = Math.round(
			(profile.meanUsefulTokens * (profile.sampleCount - 1) + observed) / profile.sampleCount,
		);
		profile.maxUsefulTokens = Math.max(profile.maxUsefulTokens, observed);

		const target = Math.min(Math.max(observed, this.config.minimumTokens), this.config.absoluteMaxTokens);
		const delta = target - profile.recommendedInitialTokens;
		const maxStep = profile.recommendedInitialTokens * this.config.maxUpdateFraction;
		const cappedDelta = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
		profile.recommendedInitialTokens = Math.round(profile.recommendedInitialTokens + cappedDelta);
		profile.recommendedMaximumTokens = Math.min(
			Math.round(profile.recommendedInitialTokens * this.config.maximumMultiplier),
			this.config.absoluteMaxTokens,
		);
		profile.lastUpdatedAt = this.now().toISOString();
		return profile;
	}

	/** Export all profiles for persistence by the caller. */
	exportAll(): ProjectBudgetProfile[] {
		return Array.from(this.profiles.values(), profile => ({ ...profile }));
	}

	/** Number of stored profiles. */
	size(): number {
		return this.profiles.size;
	}

	private key(projectId: string, taskCategory: ContextNeedCategory): string {
		return `${projectId}:${taskCategory}`;
	}
}

/** One benchmarked budget configuration with its measured outcomes. */
export interface BudgetBenchmarkResult {
	budgetTokens: number;
	taskSuccessRate: number;
	precisionAt5: number;
	hasCrossProjectLeakage: boolean;
	hasSecretLeakage: boolean;
	hasFalseVerifiedPromotion: boolean;
	p95LatencyMs: number;
	harmfulMemoryInfluenceRate: number;
}

/** Thresholds for the selection rule. */
export interface SelectionRuleOptions {
	/** Keep configs whose success ≥ best * this margin. Default 0.98. */
	minSuccessMargin?: number;
	/** Reject configs slower than this at p95. Default 30000 ms. */
	maxLatencyMs?: number;
	/** Reject configs with a harm rate above this. Default 0.02. */
	maxHarmRate?: number;
}

/**
 * Selection rule: among configurations whose task success is within the
 * margin of the best, drop any with leakage, false-verified promotion,
 * excessive latency, or excessive harm, then pick the SMALLEST budget.
 * Returns null when no configuration is both near-best and safe.
 */
export function selectBestConfiguration(
	results: readonly BudgetBenchmarkResult[],
	options?: SelectionRuleOptions,
): number | null {
	if (results.length === 0) return null;

	const minMargin = options?.minSuccessMargin ?? 0.98;
	const maxLatency = options?.maxLatencyMs ?? 30000;
	const maxHarm = options?.maxHarmRate ?? 0.02;

	const bestTaskSuccess = Math.max(...results.map(result => result.taskSuccessRate));
	const safe = results.filter(
		result =>
			result.taskSuccessRate >= bestTaskSuccess * minMargin &&
			!result.hasCrossProjectLeakage &&
			!result.hasSecretLeakage &&
			!result.hasFalseVerifiedPromotion &&
			result.p95LatencyMs <= maxLatency &&
			result.harmfulMemoryInfluenceRate <= maxHarm,
	);
	if (safe.length === 0) return null;

	return safe.reduce((smallest, result) => Math.min(smallest, result.budgetTokens), Number.POSITIVE_INFINITY);
}
