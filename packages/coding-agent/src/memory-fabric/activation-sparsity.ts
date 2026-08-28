/**
 * Activation sparsity metric.
 *
 * Turns multi-scale, on-demand sparsity (event-driven + modular activation)
 * into a measurable, reviewable signal. Given plain activation counts — or a
 * bounded fidelity-state object `{ full, summarized, evicted }` — it reports
 * the sparsity ratios at each scale (subsystem, record, capability, fidelity)
 * plus a required-need coverage summary.
 *
 * The one rule that matters: HIGH SPARSITY IS NOT ALWAYS GOOD. Skipping work
 * is only a win if no *required* need was missed. `starved` therefore fires
 * whenever a required need was left uncovered, no matter how high the
 * sparsity looks.
 *
 * Discipline: pure + imports nothing; observe-only (it only measures);
 * disabled-by-default (inert unless `options.enabled === true`); fail-open
 * (never throws); deterministic (pure arithmetic; every ratio is
 * divide-by-zero-safe and clamped to [0, 1]).
 *
 * Precedence rule: explicitly supplied counts always win; fidelity-derived
 * values only fill fields that were left undefined. (The original draft
 * unconditionally overwrote `admittedItems`/`fullFidelityItems` and used
 * falsy checks that clobbered an explicit 0 — both fixed here.)
 */

/** Structural subset of a bounded fidelity state (no import required). */
export interface FidelityLike {
	full?: string[];
	summarized?: string[];
	evicted?: string[];
}

export interface SparsityInput {
	/** Subsystems that were eligible to run this event. */
	eligibleSubsystems?: number;
	/** Subsystems that actually activated. */
	activatedSubsystems?: number;
	/** Records that were eligible for injection. */
	availableRecords?: number;
	/** Records actually injected. */
	injectedRecords?: number;
	/** Items admitted to the bounded context (full + summarized). */
	admittedItems?: number;
	/** Admitted items carried at full fidelity. */
	fullFidelityItems?: number;
	/** Capabilities available to route among. */
	availableCapabilities?: number;
	/** Capabilities selected into the bundle. */
	selectedCapabilities?: number;
	/** Total required needs for the task. */
	requiredNeedsTotal?: number;
	/** Required needs actually satisfied. */
	requiredNeedsMet?: number;
	/**
	 * Optional bounded fidelity state. When present, it fills in any of
	 * `admittedItems`, `fullFidelityItems`, `availableRecords` and
	 * `injectedRecords` that were left undefined. Explicit values always win.
	 */
	fidelity?: FidelityLike;
}

export interface SparsityOptions {
	/** Disabled by default. When not true an inert report is returned. */
	enabled?: boolean;
}

export interface SparsityReport {
	mode: "observe";
	enabled: boolean;
	/** activated / eligible subsystems, in [0, 1]. */
	subsystemActivationRatio: number;
	/** 1 - subsystemActivationRatio. */
	subsystemSparsity: number;
	/** injected / available records, in [0, 1]. */
	recordActivationRatio: number;
	/** 1 - recordActivationRatio. */
	recordSparsity: number;
	/** selected / available capabilities, in [0, 1]. */
	capabilityActivationRatio: number;
	/** full-fidelity / admitted items, in [0, 1]. */
	fullFidelityRatio: number;
	/** met / total required needs, in [0, 1]. 1 when nothing was required. */
	requiredNeedCoverage: number;
	/** How many required needs went unmet (>= 0). */
	missedRequiredNeeds: number;
	/** True when a required need was missed — a failure regardless of sparsity. */
	starved: boolean;
}

function clamp01(value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return value > 1 ? 1 : value;
}

function nonNeg(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** activated / eligible, guarded against a zero (or missing) denominator. */
function safeRatio(numerator: unknown, denominator: unknown): number {
	const n = nonNeg(numerator);
	const d = nonNeg(denominator);
	if (d <= 0) return 0;
	return clamp01(n / d);
}

function count(list: string[] | undefined): number {
	return Array.isArray(list) ? list.length : 0;
}

function inert(): SparsityReport {
	return {
		mode: "observe",
		enabled: false,
		subsystemActivationRatio: 0,
		subsystemSparsity: 0,
		recordActivationRatio: 0,
		recordSparsity: 0,
		capabilityActivationRatio: 0,
		fullFidelityRatio: 0,
		requiredNeedCoverage: 1,
		missedRequiredNeeds: 0,
		starved: false,
	};
}

/**
 * Measure activation sparsity across scales. Observe-only, disabled-by-default,
 * fail-open, deterministic. Inert when disabled.
 */
export function measureActivationSparsity(input: SparsityInput, options: SparsityOptions = {}): SparsityReport {
	if (options.enabled !== true) return inert();

	try {
		const i = input ?? {};

		let admitted = nonNeg(i.admittedItems);
		let fullItems = nonNeg(i.fullFidelityItems);
		let injected = nonNeg(i.injectedRecords);
		let available = nonNeg(i.availableRecords);

		// Fill from a bounded fidelity state, but only where nothing explicit
		// was supplied — an explicit 0 must never be clobbered.
		if (i.fidelity && typeof i.fidelity === "object") {
			const f = count(i.fidelity.full);
			const s = count(i.fidelity.summarized);
			const e = count(i.fidelity.evicted);
			if (i.admittedItems === undefined) admitted = f + s;
			if (i.fullFidelityItems === undefined) fullItems = f;
			if (i.availableRecords === undefined) available = f + s + e;
			if (i.injectedRecords === undefined) injected = f + s;
		}

		const subsystemActivationRatio = safeRatio(i.activatedSubsystems, i.eligibleSubsystems);
		const recordActivationRatio = safeRatio(injected, available);
		const capabilityActivationRatio = safeRatio(i.selectedCapabilities, i.availableCapabilities);
		const fullFidelityRatio = safeRatio(fullItems, admitted);

		const total = nonNeg(i.requiredNeedsTotal);
		const met = Math.min(nonNeg(i.requiredNeedsMet), total);
		const requiredNeedCoverage = total <= 0 ? 1 : clamp01(met / total);
		const missedRequiredNeeds = Math.max(0, total - met);

		return {
			mode: "observe",
			enabled: true,
			subsystemActivationRatio,
			subsystemSparsity: clamp01(1 - subsystemActivationRatio),
			recordActivationRatio,
			recordSparsity: clamp01(1 - recordActivationRatio),
			capabilityActivationRatio,
			fullFidelityRatio,
			requiredNeedCoverage,
			missedRequiredNeeds,
			starved: missedRequiredNeeds > 0,
		};
	} catch {
		return inert();
	}
}

/** A short deterministic one-line summary (for logs/telemetry). */
export function summarizeSparsity(report: SparsityReport): string {
	if (report?.enabled !== true) return "sparsity: disabled";
	const parts = [
		`subsys=${report.subsystemSparsity.toFixed(2)}`,
		`records=${report.recordSparsity.toFixed(2)}`,
		`fullFidelity=${report.fullFidelityRatio.toFixed(2)}`,
		`coverage=${report.requiredNeedCoverage.toFixed(2)}`,
	];
	if (report.starved) parts.push(`STARVED(${report.missedRequiredNeeds})`);
	return `sparsity: ${parts.join(" ")}`;
}
