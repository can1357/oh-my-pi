/**
 * Memory fabric — per-project calibration.
 *
 * Closes the feedback loop of the adaptive-fidelity pipeline: reads a window of
 * per-project **utilization samples** — the already-measured "did the injected
 * context actually get used?" signal — and proposes small, BOUNDED adjustments
 * to the four tunable knobs of the pipeline:
 *
 *   - **ranker**  — decision-importance emphasis (anti-burial).
 *   - **budget**  — how much of the model window to actually fill.
 *   - **gate**    — how aggressively near-duplicates may collapse.
 *   - **density** — how much detail replies warrant.
 *
 * It is NOT a new source of truth and does not itself rank, budget, gate, or
 * write replies. It only emits calibrated *parameters* that those modules may
 * read — and only in `active` mode. The knobs it moves are all OPTIONAL
 * aggressiveness dials; preservation, secret redaction, never-worse and
 * required-need coverage are enforced by the individual modules regardless of
 * any value here.
 *
 * The controller has exactly three regimes, and safety strictly dominates:
 *
 *   1. under-provisioned — coverage below the floor OR any safety incident.
 *      The pipeline is starving the model of truth. The ONLY permitted move is
 *      toward MORE fidelity: fill more budget, collapse LESS, add detail, and
 *      push important items up. (Fail toward preservation.)
 *
 *   2. over-provisioned — coverage safely above the floor, no safety incidents,
 *      and a large share of injected tokens went unused. Only THEN may we
 *      tighten toward efficiency: fill less, collapse a little more (never past
 *      the safe floor), and trim detail.
 *
 *   3. balanced — leave the knobs where they are.
 *
 * With too few samples the regime is `insufficient-data` and nothing moves.
 * The whole pass is fail-open, deterministic, non-mutating, and disabled by
 * default (observe/suggest apply nothing).
 */

export const CALIBRATOR_NAME = "memory-fabric-per-project-calibrator";
export const CALIBRATOR_VERSION = "1";

/**
 * Effective mode. observe = measure only (default, no behavior change);
 * suggest = surface the proposal for human/agent confirmation but still apply
 * nothing; active = the calibrated parameters become effective. Rollout order
 * is observe → suggest → active.
 */
export type CalibrationMode = "observe" | "suggest" | "active";

/**
 * One per-project utilization observation. This is a deliberately decoupled,
 * structural mirror of the packet-utilization record shape so the calibrator
 * has no hard upstream dependency (dependency inversion). Use
 * {@link sampleFromPacketUtilization} to adapt a real packet-utilization
 * record. All rates are in [0, 1].
 */
export interface CalibrationSample {
	/** Project this sample belongs to (calibration is strictly per-project). */
	projectId: string;
	/** Fraction of injected TOKENS that materially supported the decision. */
	tokenUtilizationRate: number;
	/** Fraction of injected RECORDS that were used or partially used. */
	recordUtilizationRate: number;
	/** Fraction of required information-needs that were satisfied. */
	needCoverageRate: number;
	/** Fraction of expansion tokens that were actually used (optional). */
	expansionUtilizationRate?: number;
	/** Did the task succeed on this turn? (optional outcome signal). */
	taskSucceeded?: boolean;
	/**
	 * A safety incident occurred on this turn — e.g. a known failure was
	 * repeated, a warning was ignored, or the user had to correct authoritative
	 * output. Any true value forces the safety-first regime.
	 */
	safetyIncident?: boolean;
	/** Optional turn/packet id, retained for audit only. */
	sampleId?: string;
}

/** Ranker knob — decision-importance emphasis (anti-burial). */
export interface RankerParameters {
	/** Weight on decision-importance ordering. 1 = baseline; higher = stronger. */
	decisionImportanceWeight: number;
}

/** Budget knob — target fill of the model context window. */
export interface BudgetParameters {
	/** Target fraction of the model window to fill. */
	targetFillRatio: number;
}

/** Gate knob — near-duplicate collapse aggressiveness. */
export interface GateParameters {
	/**
	 * Similarity at/above which two items are treated as near-duplicates.
	 * HIGHER = collapse LESS (more conservative). Clamped to a safe floor so
	 * calibration can never make collapse reckless.
	 */
	semanticSimilarityThreshold: number;
}

/**
 * Density knob — response-detail thresholds on the complexity ladder.
 * A reply of complexity c is placed: c ≥ detailed → detailed; ≥ standard →
 * standard; ≥ compact → compact; else minimal. LOWER thresholds ⇒ MORE detail.
 * Invariant: detailed > standard > compact (kept separated by a minimum gap).
 */
export interface DensityParameters {
	detailedThreshold: number;
	standardThreshold: number;
	compactThreshold: number;
}

/** The full set of calibrated knobs the pipeline may read. */
export interface CalibrationParameters {
	ranker: RankerParameters;
	budget: BudgetParameters;
	gate: GateParameters;
	density: DensityParameters;
}

/** Inclusive numeric range with a per-calibration maximum step. */
export interface KnobRange {
	min: number;
	max: number;
	/** Largest absolute change allowed in a single calibration pass. */
	maxStep: number;
}

/**
 * Safe envelopes for every knob. These bounds — not the utilization stream —
 * are the guarantee that calibration stays safe. In particular the gate
 * similarity floor keeps near-duplicate collapse conservative no matter what
 * the data says.
 */
export interface CalibrationBounds {
	rankerDecisionImportanceWeight: KnobRange;
	budgetTargetFillRatio: KnobRange;
	gateSemanticSimilarityThreshold: KnobRange;
	densityDetailedThreshold: KnobRange;
	densityStandardThreshold: KnobRange;
	densityCompactThreshold: KnobRange;
	/** Minimum gap kept between adjacent density thresholds. */
	densityMinGap: number;
}

/** Which way the observed utilization pushes the pipeline. */
export type CalibrationRegime = "insufficient-data" | "under-provisioned" | "over-provisioned" | "balanced";

/** Aggregated, smoothed metrics over the sample window. */
export interface CalibrationMetrics {
	sampleCount: number;
	meanTokenUtilization: number;
	meanRecordUtilization: number;
	meanNeedCoverage: number;
	meanExpansionUtilization: number;
	successRate: number;
	safetyIncidentRate: number;
	/** How far coverage is BELOW the floor (0 when at/above the floor). */
	coverageShortfall: number;
	/** How far token utilization is BELOW the efficiency target (0 when at/above). */
	utilizationShortfall: number;
}

/** What limited a requested knob change, when anything did. */
export type KnobClamp = "min" | "max" | "maxStep" | "gap" | "floor";

/** A single knob's before/after change, with any clamping that was applied. */
export interface KnobAdjustment {
	knob: string;
	before: number;
	after: number;
	/** after - before (0 when unchanged). */
	delta: number;
	direction: "increase" | "decrease" | "none";
	/** Set when a safe-envelope bound limited the requested change. */
	clampedBy?: KnobClamp;
}

/** The result of one calibration pass. */
export interface CalibrationResult {
	calibrator: string;
	calibratorVersion: string;
	projectId: string;
	mode: CalibrationMode;
	regime: CalibrationRegime;
	/** The parameters currently in force (the input baseline). */
	baseline: CalibrationParameters;
	/** What the utilization signal recommends (bounded), regardless of mode. */
	proposed: CalibrationParameters;
	/**
	 * The parameters callers should USE:
	 *   - observe / suggest: the baseline, unchanged (disabled by default).
	 *   - active: the proposed, calibrated parameters.
	 */
	effective: CalibrationParameters;
	/** Per-knob before/after audit (baseline → proposed). */
	adjustments: KnobAdjustment[];
	metrics: CalibrationMetrics;
	/** Confidence in the proposal, in [0, 1]; scales with sample count. */
	confidence: number;
	/** True in suggest mode when the proposal differs from the baseline. */
	awaitingApproval: boolean;
	rationale: string;
	calibratedAt: string;
	/** True when calibration errored and the baseline was returned unchanged. */
	failedOpen: boolean;
}

export interface CalibrationOptions {
	mode?: CalibrationMode;
	/** Current parameters to calibrate FROM. Defaults to {@link DEFAULT_CALIBRATION_PARAMETERS}. */
	baseline?: CalibrationParameters;
	/** Safe envelopes. Defaults to {@link DEFAULT_CALIBRATION_BOUNDS}. */
	bounds?: CalibrationBounds;
	/** Minimum samples before any change is proposed. Default {@link DEFAULT_MIN_SAMPLES}. */
	minSamples?: number;
	/** Sample count at which confidence saturates to 1. Default {@link DEFAULT_CONFIDENT_SAMPLES}. */
	confidentSamples?: number;
	/** Proportional gain applied to each nudge, in (0, 1]. Default {@link DEFAULT_LEARNING_RATE}. */
	learningRate?: number;
	/** EWMA smoothing factor for the newest samples, in (0, 1]. Default {@link DEFAULT_SMOOTHING}. */
	smoothing?: number;
	/** Coverage at/below which the safety-first regime engages. Default {@link DEFAULT_COVERAGE_FLOOR}. */
	coverageFloor?: number;
	/** Token-utilization target below which context is over-provisioned. Default {@link DEFAULT_UTILIZATION_TARGET}. */
	utilizationTarget?: number;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

/** Baseline knobs: the documented defaults of the fidelity pipeline. */
export const DEFAULT_CALIBRATION_PARAMETERS: CalibrationParameters = {
	ranker: { decisionImportanceWeight: 1 },
	budget: { targetFillRatio: 0.7 },
	gate: { semanticSimilarityThreshold: 0.9 },
	density: { detailedThreshold: 0.68, standardThreshold: 0.45, compactThreshold: 0.22 },
};

/**
 * Safe envelopes. The gate similarity floor (0.75) is deliberately high so
 * that calibration can never turn near-duplicate collapse reckless; density
 * and budget ranges keep detail and fill within sane, reversible bounds.
 */
export const DEFAULT_CALIBRATION_BOUNDS: CalibrationBounds = {
	rankerDecisionImportanceWeight: { min: 0.5, max: 2, maxStep: 0.25 },
	budgetTargetFillRatio: { min: 0.3, max: 0.95, maxStep: 0.1 },
	gateSemanticSimilarityThreshold: { min: 0.75, max: 0.99, maxStep: 0.05 },
	densityDetailedThreshold: { min: 0.5, max: 0.85, maxStep: 0.08 },
	densityStandardThreshold: { min: 0.3, max: 0.65, maxStep: 0.08 },
	densityCompactThreshold: { min: 0.1, max: 0.4, maxStep: 0.08 },
	densityMinGap: 0.05,
};

export const DEFAULT_MIN_SAMPLES = 5;
export const DEFAULT_CONFIDENT_SAMPLES = 25;
export const DEFAULT_LEARNING_RATE = 0.5;
export const DEFAULT_SMOOTHING = 0.4;
export const DEFAULT_COVERAGE_FLOOR = 0.98;
export const DEFAULT_UTILIZATION_TARGET = 0.6;

function clamp01(x: number): number {
	if (!Number.isFinite(x)) return 0;
	return Math.max(0, Math.min(1, x));
}

function clampRange(x: number, range: KnobRange): { value: number; clampedBy?: "min" | "max" } {
	if (x < range.min) return { value: range.min, clampedBy: "min" };
	if (x > range.max) return { value: range.max, clampedBy: "max" };
	return { value: x };
}

/**
 * Exponentially-weighted mean, newest-last. Recent samples count more so the
 * calibrator tracks a drifting project without overreacting to one turn.
 */
function ewma(values: number[], smoothing: number): number {
	const first = values[0];
	if (first === undefined) return 0;
	const alpha = Math.max(0.01, Math.min(1, smoothing));
	let acc = first;
	for (let i = 1; i < values.length; i++) {
		const value = values[i];
		if (value === undefined) continue;
		acc = alpha * value + (1 - alpha) * acc;
	}
	return acc;
}

function rate(values: boolean[]): number {
	if (values.length === 0) return 0;
	let n = 0;
	for (const v of values) if (v) n++;
	return n / values.length;
}

function deepCloneParameters(p: CalibrationParameters): CalibrationParameters {
	return {
		ranker: { decisionImportanceWeight: p.ranker.decisionImportanceWeight },
		budget: { targetFillRatio: p.budget.targetFillRatio },
		gate: { semanticSimilarityThreshold: p.gate.semanticSimilarityThreshold },
		density: {
			detailedThreshold: p.density.detailedThreshold,
			standardThreshold: p.density.standardThreshold,
			compactThreshold: p.density.compactThreshold,
		},
	};
}

/**
 * Aggregate a per-project sample window into smoothed metrics. Samples are
 * assumed newest-last; rates are clamped to [0, 1] defensively.
 */
export function aggregateMetrics(
	samples: CalibrationSample[],
	options: { smoothing?: number; coverageFloor?: number; utilizationTarget?: number } = {},
): CalibrationMetrics {
	const smoothing = options.smoothing ?? DEFAULT_SMOOTHING;
	const coverageFloor = clamp01(options.coverageFloor ?? DEFAULT_COVERAGE_FLOOR);
	const utilizationTarget = clamp01(options.utilizationTarget ?? DEFAULT_UTILIZATION_TARGET);

	const token = samples.map(s => clamp01(s.tokenUtilizationRate));
	const record = samples.map(s => clamp01(s.recordUtilizationRate));
	const coverage = samples.map(s => clamp01(s.needCoverageRate));
	const expansion: number[] = [];
	for (const s of samples) {
		if (typeof s.expansionUtilizationRate === "number") expansion.push(clamp01(s.expansionUtilizationRate));
	}

	const meanNeedCoverage = ewma(coverage, smoothing);
	const meanTokenUtilization = ewma(token, smoothing);

	return {
		sampleCount: samples.length,
		meanTokenUtilization,
		meanRecordUtilization: ewma(record, smoothing),
		meanNeedCoverage,
		meanExpansionUtilization: expansion.length > 0 ? ewma(expansion, smoothing) : 0,
		successRate: rate(samples.filter(s => s.taskSucceeded !== undefined).map(s => s.taskSucceeded === true)),
		safetyIncidentRate: rate(samples.map(s => s.safetyIncident === true)),
		coverageShortfall: Math.max(0, coverageFloor - meanNeedCoverage),
		utilizationShortfall: Math.max(0, utilizationTarget - meanTokenUtilization),
	};
}

/** Decide the regime. Safety (coverage/incidents) strictly dominates efficiency. */
export function decideRegime(metrics: CalibrationMetrics, minSamples: number): CalibrationRegime {
	if (metrics.sampleCount < minSamples) return "insufficient-data";
	// Safety-first: any coverage shortfall or safety incident ⇒ add fidelity.
	if (metrics.coverageShortfall > 0 || metrics.safetyIncidentRate > 0) return "under-provisioned";
	// Only tighten when truth is safely covered AND tokens are being wasted.
	if (metrics.utilizationShortfall > 0) return "over-provisioned";
	return "balanced";
}

/**
 * Move one knob by `desiredDelta`, clamped to its max step and safe range.
 * `floorHint` marks the gate similarity floor specifically for auditability.
 */
function nudge(
	knob: string,
	before: number,
	desiredDelta: number,
	range: KnobRange,
	floorHint = false,
): KnobAdjustment {
	let clampedBy: KnobClamp | undefined;
	let step = desiredDelta;
	if (Math.abs(step) > range.maxStep) {
		step = Math.sign(step) * range.maxStep;
		clampedBy = "maxStep";
	}
	const raw = before + step;
	const bounded = clampRange(raw, range);
	let after = bounded.value;
	if (bounded.clampedBy) clampedBy = floorHint && bounded.clampedBy === "min" ? "floor" : bounded.clampedBy;
	// Guard against FP dust so an untouched knob reports exactly "none".
	const delta = Math.abs(after - before) < 1e-9 ? 0 : after - before;
	if (delta === 0) after = before;
	return {
		knob,
		before,
		after,
		delta,
		direction: delta > 0 ? "increase" : delta < 0 ? "decrease" : "none",
		...(delta !== 0 && clampedBy !== undefined ? { clampedBy } : {}),
	};
}

/**
 * Keep density thresholds ordered detailed > standard > compact with the
 * configured minimum gap, without violating each knob's own range.
 */
function enforceDensityOrdering(
	params: CalibrationParameters,
	bounds: CalibrationBounds,
	adjustments: Map<string, KnobAdjustment>,
): void {
	const gap = bounds.densityMinGap;
	const d = params.density;
	// standard must sit at least `gap` below detailed.
	const maxStandard = d.detailedThreshold - gap;
	if (d.standardThreshold > maxStandard) {
		const capped = Math.max(bounds.densityStandardThreshold.min, maxStandard);
		markGapClamp("density.standardThreshold", capped, d, "standardThreshold", adjustments);
		d.standardThreshold = capped;
	}
	// compact must sit at least `gap` below standard.
	const maxCompact = d.standardThreshold - gap;
	if (d.compactThreshold > maxCompact) {
		const capped = Math.max(bounds.densityCompactThreshold.min, maxCompact);
		markGapClamp("density.compactThreshold", capped, d, "compactThreshold", adjustments);
		d.compactThreshold = capped;
	}
}

function markGapClamp(
	knob: string,
	newValue: number,
	density: CalibrationParameters["density"],
	field: "standardThreshold" | "compactThreshold",
	adjustments: Map<string, KnobAdjustment>,
): void {
	const existing = adjustments.get(knob);
	const before = existing ? existing.before : density[field];
	const delta = Math.abs(newValue - before) < 1e-9 ? 0 : newValue - before;
	adjustments.set(knob, {
		knob,
		before,
		after: delta === 0 ? before : newValue,
		delta,
		direction: delta > 0 ? "increase" : delta < 0 ? "decrease" : "none",
		...(delta === 0 ? {} : { clampedBy: "gap" as const }),
	});
}

interface KnobDeltas {
	ranker: number;
	budget: number;
	gate: number;
	densityDetailed: number;
	densityStandard: number;
	densityCompact: number;
}

function applyDeltas(
	proposed: CalibrationParameters,
	audit: Map<string, KnobAdjustment>,
	deltas: KnobDeltas,
	bounds: CalibrationBounds,
): void {
	const rankerAdjustment = nudge(
		"ranker.decisionImportanceWeight",
		proposed.ranker.decisionImportanceWeight,
		deltas.ranker,
		bounds.rankerDecisionImportanceWeight,
	);
	proposed.ranker.decisionImportanceWeight = rankerAdjustment.after;
	audit.set(rankerAdjustment.knob, rankerAdjustment);

	const budgetAdjustment = nudge(
		"budget.targetFillRatio",
		proposed.budget.targetFillRatio,
		deltas.budget,
		bounds.budgetTargetFillRatio,
	);
	proposed.budget.targetFillRatio = budgetAdjustment.after;
	audit.set(budgetAdjustment.knob, budgetAdjustment);

	const gateAdjustment = nudge(
		"gate.semanticSimilarityThreshold",
		proposed.gate.semanticSimilarityThreshold,
		deltas.gate,
		bounds.gateSemanticSimilarityThreshold,
		true,
	);
	proposed.gate.semanticSimilarityThreshold = gateAdjustment.after;
	audit.set(gateAdjustment.knob, gateAdjustment);

	const detailedAdjustment = nudge(
		"density.detailedThreshold",
		proposed.density.detailedThreshold,
		deltas.densityDetailed,
		bounds.densityDetailedThreshold,
	);
	proposed.density.detailedThreshold = detailedAdjustment.after;
	audit.set(detailedAdjustment.knob, detailedAdjustment);

	const standardAdjustment = nudge(
		"density.standardThreshold",
		proposed.density.standardThreshold,
		deltas.densityStandard,
		bounds.densityStandardThreshold,
	);
	proposed.density.standardThreshold = standardAdjustment.after;
	audit.set(standardAdjustment.knob, standardAdjustment);

	const compactAdjustment = nudge(
		"density.compactThreshold",
		proposed.density.compactThreshold,
		deltas.densityCompact,
		bounds.densityCompactThreshold,
	);
	proposed.density.compactThreshold = compactAdjustment.after;
	audit.set(compactAdjustment.knob, compactAdjustment);
}

/**
 * Produce the bounded target parameters and the per-knob audit for a regime.
 * Severity in [0, 1] scales how hard we push (bigger shortfall ⇒ bigger step).
 */
export function proposeParameters(
	baseline: CalibrationParameters,
	metrics: CalibrationMetrics,
	regime: CalibrationRegime,
	bounds: CalibrationBounds,
	learningRate: number,
): { proposed: CalibrationParameters; adjustments: KnobAdjustment[] } {
	const proposed = deepCloneParameters(baseline);
	const audit = new Map<string, KnobAdjustment>();

	if (regime === "insufficient-data" || regime === "balanced") {
		return { proposed, adjustments: [] };
	}

	const lr = Math.max(0.01, Math.min(1, learningRate));

	if (regime === "under-provisioned") {
		// Severity from the WORST safety signal. More fidelity in every dimension.
		const severity = clamp01(Math.max(metrics.coverageShortfall * 2, metrics.safetyIncidentRate));
		const gain = lr * severity;
		const deltas: KnobDeltas = {
			ranker: gain * bounds.rankerDecisionImportanceWeight.maxStep * 4, // push important items up
			budget: gain * bounds.budgetTargetFillRatio.maxStep * 4, // allow more context
			gate: gain * bounds.gateSemanticSimilarityThreshold.maxStep * 4, // collapse LESS
			densityDetailed: -gain * bounds.densityDetailedThreshold.maxStep * 4, // MORE detail
			densityStandard: -gain * bounds.densityStandardThreshold.maxStep * 4,
			densityCompact: -gain * bounds.densityCompactThreshold.maxStep * 4,
		};
		applyDeltas(proposed, audit, deltas, bounds);
	} else {
		// over-provisioned: tighten toward efficiency, gently.
		const severity = clamp01(metrics.utilizationShortfall * 1.5);
		const gain = lr * severity;
		const deltas: KnobDeltas = {
			ranker: gain * bounds.rankerDecisionImportanceWeight.maxStep * 4, // still surface the useful few
			budget: -gain * bounds.budgetTargetFillRatio.maxStep * 4, // fill less
			gate: -gain * bounds.gateSemanticSimilarityThreshold.maxStep * 4, // collapse a little MORE (floored)
			densityDetailed: gain * bounds.densityDetailedThreshold.maxStep * 4, // LESS detail
			densityStandard: gain * bounds.densityStandardThreshold.maxStep * 4,
			densityCompact: gain * bounds.densityCompactThreshold.maxStep * 4,
		};
		applyDeltas(proposed, audit, deltas, bounds);
	}

	enforceDensityOrdering(proposed, bounds, audit);

	// Emit only the knobs that actually moved, in a stable order.
	const order = [
		"ranker.decisionImportanceWeight",
		"budget.targetFillRatio",
		"gate.semanticSimilarityThreshold",
		"density.detailedThreshold",
		"density.standardThreshold",
		"density.compactThreshold",
	];
	const adjustments = order
		.map(k => audit.get(k))
		.filter((a): a is KnobAdjustment => a !== undefined && a.delta !== 0);
	return { proposed, adjustments };
}

function computeConfidence(metrics: CalibrationMetrics, regime: CalibrationRegime, confidentSamples: number): number {
	if (regime === "insufficient-data") return 0;
	const bySamples = clamp01(metrics.sampleCount / Math.max(1, confidentSamples));
	// Sharper signals (bigger shortfalls / incident rates) read as more confident.
	const signal =
		regime === "under-provisioned"
			? clamp01(Math.max(metrics.coverageShortfall * 3, metrics.safetyIncidentRate))
			: regime === "over-provisioned"
				? clamp01(metrics.utilizationShortfall * 2)
				: 0.5;
	return clamp01(bySamples * (0.5 + 0.5 * signal));
}

function rationaleFor(regime: CalibrationRegime, metrics: CalibrationMetrics): string {
	switch (regime) {
		case "insufficient-data":
			return `Only ${metrics.sampleCount} sample(s); holding parameters until more utilization is observed.`;
		case "under-provisioned":
			return `Coverage shortfall ${metrics.coverageShortfall.toFixed(3)} / safety-incident rate ${metrics.safetyIncidentRate.toFixed(3)} — adding fidelity (more budget, less collapse, more detail).`;
		case "over-provisioned":
			return `Coverage safe (${metrics.meanNeedCoverage.toFixed(3)}) but token utilization ${metrics.meanTokenUtilization.toFixed(3)} below target — tightening toward efficiency within safe bounds.`;
		default:
			return "Coverage and utilization within target bands — parameters unchanged.";
	}
}

/**
 * Calibrate the pipeline knobs for ONE project from its utilization samples.
 * Deterministic, non-mutating, fail-open. `effective` equals the baseline in
 * observe/suggest mode (disabled by default) and the proposal in active mode.
 */
export function calibrate(samples: CalibrationSample[], options: CalibrationOptions = {}): CalibrationResult {
	const now = options.now ?? (() => new Date());
	const calibratedAt = now().toISOString();
	const mode: CalibrationMode = options.mode ?? "observe";
	const baseline = options.baseline
		? deepCloneParameters(options.baseline)
		: deepCloneParameters(DEFAULT_CALIBRATION_PARAMETERS);
	const bounds = options.bounds ?? DEFAULT_CALIBRATION_BOUNDS;
	const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
	const confidentSamples = options.confidentSamples ?? DEFAULT_CONFIDENT_SAMPLES;
	const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE;

	try {
		const list = Array.isArray(samples) ? samples.filter(s => s && typeof s === "object") : [];
		const projectId = list[0]?.projectId ?? "unknown";

		const metrics = aggregateMetrics(list, {
			...(options.smoothing !== undefined ? { smoothing: options.smoothing } : {}),
			...(options.coverageFloor !== undefined ? { coverageFloor: options.coverageFloor } : {}),
			...(options.utilizationTarget !== undefined ? { utilizationTarget: options.utilizationTarget } : {}),
		});
		const regime = decideRegime(metrics, minSamples);
		const { proposed, adjustments } = proposeParameters(baseline, metrics, regime, bounds, learningRate);
		const confidence = computeConfidence(metrics, regime, confidentSamples);
		const changed = adjustments.length > 0;
		const effective = mode === "active" ? deepCloneParameters(proposed) : deepCloneParameters(baseline);

		return {
			calibrator: CALIBRATOR_NAME,
			calibratorVersion: CALIBRATOR_VERSION,
			projectId,
			mode,
			regime,
			baseline,
			proposed,
			effective,
			adjustments,
			metrics,
			confidence,
			awaitingApproval: mode === "suggest" && changed,
			rationale: rationaleFor(regime, metrics),
			calibratedAt,
			failedOpen: false,
		};
	} catch {
		// Fail open: keep the pipeline exactly where it is.
		const safe = deepCloneParameters(baseline);
		return {
			calibrator: CALIBRATOR_NAME,
			calibratorVersion: CALIBRATOR_VERSION,
			projectId: "unknown",
			mode,
			regime: "insufficient-data",
			baseline: safe,
			proposed: deepCloneParameters(safe),
			effective: deepCloneParameters(safe),
			adjustments: [],
			metrics: {
				sampleCount: 0,
				meanTokenUtilization: 0,
				meanRecordUtilization: 0,
				meanNeedCoverage: 0,
				meanExpansionUtilization: 0,
				successRate: 0,
				safetyIncidentRate: 0,
				coverageShortfall: 0,
				utilizationShortfall: 0,
			},
			confidence: 0,
			awaitingApproval: false,
			rationale: "Calibration failed; baseline parameters retained (fail-open).",
			calibratedAt,
			failedOpen: true,
		};
	}
}

/** Build a drop-in calibrator with options pre-bound. */
export function makeCalibrator(options: CalibrationOptions = {}): (samples: CalibrationSample[]) => CalibrationResult {
	return samples => calibrate(samples, options);
}

/**
 * Group mixed samples by `projectId` and calibrate each project independently
 * (calibration is strictly per-project). Returns a map keyed by project id.
 * Never throws.
 */
export function calibratePerProject(
	samples: CalibrationSample[],
	options: CalibrationOptions = {},
): Map<string, CalibrationResult> {
	const byProject = new Map<string, CalibrationSample[]>();
	for (const s of Array.isArray(samples) ? samples : []) {
		if (!s || typeof s !== "object") continue;
		const key = s.projectId ?? "unknown";
		const bucket = byProject.get(key);
		if (bucket) bucket.push(s);
		else byProject.set(key, [s]);
	}
	const out = new Map<string, CalibrationResult>();
	for (const [projectId, projectSamples] of byProject) {
		out.set(projectId, calibrate(projectSamples, options));
	}
	return out;
}

/**
 * Structural mirror of a packet-utilization record. Duck-typed so calibration
 * keeps no hard import on the tiered-retrieval types (dependency inversion).
 */
export interface PacketUtilizationLike {
	taskId?: string;
	projectId?: string;
	turnId?: string;
	packetId?: string;
	weightedUtilizationRate?: number;
	recordUtilizationRate?: number;
	needCoverageRate?: number;
	expansionUtilizationRate?: number;
	taskSucceeded?: boolean;
	knownFailureRepeated?: boolean;
}

/**
 * Adapt a packet-utilization-shaped record into a {@link CalibrationSample}.
 * Missing fields are treated conservatively (rates default to 0; a repeated
 * known failure counts as a safety incident). Never throws.
 */
export function sampleFromPacketUtilization(packet: PacketUtilizationLike, projectId?: string): CalibrationSample {
	const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
	const sampleId = packet.packetId ?? packet.turnId;
	return {
		projectId: projectId ?? packet.projectId ?? packet.taskId ?? "unknown",
		tokenUtilizationRate: num(packet.weightedUtilizationRate),
		recordUtilizationRate: num(packet.recordUtilizationRate),
		needCoverageRate: num(packet.needCoverageRate),
		...(typeof packet.expansionUtilizationRate === "number"
			? { expansionUtilizationRate: packet.expansionUtilizationRate }
			: {}),
		...(packet.taskSucceeded === undefined ? {} : { taskSucceeded: packet.taskSucceeded }),
		safetyIncident: packet.knownFailureRepeated === true,
		...(sampleId === undefined ? {} : { sampleId }),
	};
}
