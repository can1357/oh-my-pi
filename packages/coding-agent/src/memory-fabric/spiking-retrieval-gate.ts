/**
 * Adaptive-threshold "spiking" retrieval gate.
 *
 * Models adaptive-threshold spiking at the agent-control layer: a subsystem
 * or retrieval candidate only "fires" (activates) when its need signal
 * crosses a firing threshold — and that threshold ADAPTS to the situation
 * (risk, uncertainty, contradiction, coverage gaps, recent failures,
 * latency/token pressure, health, historical utility). Most work is
 * therefore *skipped*, which is the whole point of sparsity.
 *
 * Three decision regions:
 *     signal >= threshold           -> activate
 *     signal >= threshold - margin  -> shadow   (observe-only, no real influence)
 *     signal <  threshold - margin  -> suppress
 *
 * Deterministic safety overrides ALWAYS beat the numeric score (deny-first):
 *   - forceSuppress / blocked -> suppress
 *   - needsUser               -> shadow   (human-gated: NEVER auto-activated)
 *   - forceActivate           -> activate (safety-required, e.g. crash/rollback)
 * A blocked or human-gated candidate can never be auto-approved, even at a
 * signal of 1.0 — the same "never auto-approve blocked/needs-user" rule the
 * capability retrieval gate enforces.
 *
 * Discipline: imports nothing; observe-only (it recommends decisions; it
 * executes nothing); disabled-by-default (inert unless
 * `options.enabled === true`); fail-open (never throws); deterministic
 * (id-sorted output; no clocks, no randomness).
 */

export type ActivationDecision = "activate" | "shadow" | "suppress";

/** Per-candidate signal + adaptive-threshold inputs + deterministic overrides. */
export interface ActivationSignalInput {
	/** Stable candidate/subsystem id. */
	id: string;
	/** 0..1 need/salience signal for this candidate. */
	signal: number;
	/** Base firing threshold before adaptation. Default 0.5. */
	baseThreshold?: number;
	/** 0..1 — lowers the bar (more likely to activate). */
	operationRisk?: number;
	/** 0..1 — lowers the bar. */
	uncertainty?: number;
	/** 0..1 — lowers the bar. */
	contradictionLevel?: number;
	/** 0..1 — lowers the bar. */
	contextCoverageGap?: number;
	/** count (capped at 2) — lowers the bar. */
	repeatedFailureCount?: number;
	/** 0..1 — RAISES the bar (cost pressure). */
	latencyPressure?: number;
	/** 0..1 — RAISES the bar (cost pressure). */
	tokenPressure?: number;
	/** 0..1 — lowers the bar (proven useful before). */
	historicalUtility?: number;
	/** 0..1 health (1 = healthy). Poor health RAISES the bar. Default 1. */
	subsystemHealth?: number;
	/** Deterministic override: safety-required activation (crash/rollback/...). */
	forceActivate?: boolean;
	/** Deterministic override: scope/privacy/circuit-breaker/duplicate. */
	forceSuppress?: boolean;
	/** Deterministic override: policy blocked — never activate. */
	blocked?: boolean;
	/** Deterministic override: human-gated — never auto-activate (shadow). */
	needsUser?: boolean;
}

export interface GateOptions {
	/** Disabled by default. When not true an inert result is returned. */
	enabled?: boolean;
	/** Width of the shadow band below the threshold. Default 0.1. */
	shadowMargin?: number;
	/** Optional target activation rate for the rate-control diagnostic. */
	targetActivationRate?: number;
}

export interface GateDecision {
	id: string;
	decision: ActivationDecision;
	signal: number;
	threshold: number;
	margin: number;
	reason: string;
	/** True when a deterministic override (not the numeric score) drove it. */
	override: boolean;
}

export interface GateResult {
	mode: "observe";
	enabled: boolean;
	/** Every decision, id-sorted. */
	decisions: GateDecision[];
	/** Ids to activate (sorted). */
	activate: string[];
	/** Ids to shadow (sorted). */
	shadow: string[];
	/** Ids to suppress (sorted). */
	suppress: string[];
	/** activate / total decisions, in [0, 1]. */
	activationRate: number;
	/** True when a target rate was given and the current rate exceeds it. */
	rateExceeded: boolean;
}

const DEFAULT_BASE_THRESHOLD = 0.5;
const DEFAULT_SHADOW_MARGIN = 0.1;
const THRESHOLD_MIN = 0.2;
const THRESHOLD_MAX = 0.9;

function unit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return value > 1 ? 1 : value;
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

/**
 * Compute the adaptive firing threshold in [0.20, 0.90]. Risk/uncertainty/
 * contradiction/coverage-gap/failures/historical-utility LOWER the bar (make
 * activation easier); latency/token pressure and poor health RAISE it.
 */
export function calculateActivationThreshold(input: ActivationSignalInput): number {
	const i = input ?? ({} as ActivationSignalInput);
	const rawBase = i.baseThreshold;
	const base = typeof rawBase === "number" && Number.isFinite(rawBase) ? rawBase : DEFAULT_BASE_THRESHOLD;
	const failures = Math.min(Math.max(0, Math.floor(i.repeatedFailureCount ?? 0)), 2);
	const t =
		base -
		0.15 * unit(i.operationRisk) -
		0.1 * unit(i.uncertainty) -
		0.15 * unit(i.contradictionLevel) -
		0.12 * unit(i.contextCoverageGap) -
		0.06 * failures +
		0.08 * unit(i.latencyPressure) +
		0.06 * unit(i.tokenPressure) -
		0.08 * unit(i.historicalUtility) +
		0.1 * (1 - unit(i.subsystemHealth ?? 1));
	return clamp(t, THRESHOLD_MIN, THRESHOLD_MAX);
}

function inert(): GateResult {
	return {
		mode: "observe",
		enabled: false,
		decisions: [],
		activate: [],
		shadow: [],
		suppress: [],
		activationRate: 0,
		rateExceeded: false,
	};
}

/**
 * Gate a set of activation candidates into activate/shadow/suppress. Observe-
 * only, disabled-by-default, fail-open, deterministic. Deterministic overrides
 * always beat the numeric score (deny-first). Inert when disabled.
 */
export function gateActivations(inputs: ActivationSignalInput[], options: GateOptions = {}): GateResult {
	if (options.enabled !== true) return inert();

	try {
		const rawMargin = options.shadowMargin;
		const margin = typeof rawMargin === "number" && rawMargin >= 0 ? rawMargin : DEFAULT_SHADOW_MARGIN;

		const seen = new Set<string>();
		const decisions: GateDecision[] = [];
		for (const raw of inputs ?? []) {
			if (!raw || !isNonEmptyString(raw.id) || seen.has(raw.id)) continue;
			seen.add(raw.id);

			const signal = unit(raw.signal);
			const threshold = calculateActivationThreshold(raw);

			let decision: ActivationDecision;
			let reason: string;
			let override = false;

			if (raw.forceSuppress === true) {
				decision = "suppress";
				reason = "override: forced suppress (scope/privacy/circuit-breaker/duplicate)";
				override = true;
			} else if (raw.blocked === true) {
				decision = "suppress";
				reason = "override: policy blocked";
				override = true;
			} else if (raw.needsUser === true) {
				decision = "shadow";
				reason = "override: human-gated (never auto-activate)";
				override = true;
			} else if (raw.forceActivate === true) {
				decision = "activate";
				reason = "override: safety-required activation";
				override = true;
			} else if (signal >= threshold) {
				decision = "activate";
				reason = "signal >= threshold";
			} else if (signal >= threshold - margin) {
				decision = "shadow";
				reason = "within shadow margin";
			} else {
				decision = "suppress";
				reason = "signal below threshold - margin";
			}

			decisions.push({ id: raw.id, decision, signal, threshold, margin, reason, override });
		}

		decisions.sort((a, b) => a.id.localeCompare(b.id));
		const idsFor = (kind: ActivationDecision): string[] =>
			decisions
				.filter(d => d.decision === kind)
				.map(d => d.id)
				.sort();
		const activate = idsFor("activate");
		const shadow = idsFor("shadow");
		const suppress = idsFor("suppress");

		const total = decisions.length;
		const activationRate = total > 0 ? activate.length / total : 0;
		const target = options.targetActivationRate;
		const rateExceeded = typeof target === "number" && activationRate > target;

		return {
			mode: "observe",
			enabled: true,
			decisions,
			activate,
			shadow,
			suppress,
			activationRate,
			rateExceeded,
		};
	} catch {
		return inert();
	}
}

/** A short deterministic one-line summary (for logs/telemetry). */
export function summarizeGate(result: GateResult): string {
	if (result?.enabled !== true) return "gate: disabled";
	const parts = [
		`activate=${result.activate.length}`,
		`shadow=${result.shadow.length}`,
		`suppress=${result.suppress.length}`,
		`rate=${result.activationRate.toFixed(2)}`,
	];
	if (result.rateExceeded) parts.push("rate-exceeded");
	return `gate: ${parts.join(" ")}`;
}
