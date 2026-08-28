/**
 * Memory Fabric — rollout ladder vocabulary.
 *
 * Every capability in the fabric ships disabled by default and climbs a fixed
 * ladder before it is allowed to touch what the model sees:
 *
 *   observe  — measure everything, alter NOTHING. Fully safe.
 *   suggest  — propose a change; a human or agent confirms it.
 *   active   — apply the change, per project, once benchmarks clear.
 *   stable   — documented, calibrated, defaults reviewed.
 *
 * This module declares the ladder as a first-class type so every phase names
 * the same rungs, and pins the one rung that is actually implemented today:
 * `observe` (see ./observe). `suggest`, `active` and `stable` are declared here
 * as vocabulary only — no controller exists for them yet, and this module is
 * deliberately honest about that rather than implying otherwise.
 *
 * `stageMayAlterContext` encodes the ladder's safety gradient so callers can
 * assert, at any rung, whether context mutation is permitted. The observe
 * controller asserts it is NOT, and enforces that structurally.
 *
 * Pure declaration plus two total functions: no imports, no side effects,
 * nothing wired into the hot path, nothing re-exported from
 * `memory-fabric/index.ts`.
 */

/** The rollout ladder, ordered from safest (measure-only) to fully live. */
export type RolloutStage = "observe" | "suggest" | "active" | "stable";

/** The ladder in order. Index = how far along the rollout a stage sits. */
export const ROLLOUT_STAGES: readonly RolloutStage[] = ["observe", "suggest", "active", "stable"];

/** The only rung with a controller in this package today. */
export const OBSERVE_STAGE: RolloutStage = "observe";

/**
 * Whether a stage is permitted to alter the context that reaches the model.
 * Only `observe` is guaranteed non-altering; that is the invariant the observe
 * controller enforces by construction. The later rungs MAY alter (each behind
 * its own confirmation or benchmark gate), so they return true here.
 */
export function stageMayAlterContext(stage: RolloutStage): boolean {
	return stage !== "observe";
}

/** Position of a stage on the ladder (0-based); -1 if unknown. */
export function rolloutStageIndex(stage: RolloutStage): number {
	return ROLLOUT_STAGES.indexOf(stage);
}

/**
 * Is `candidate` at least as far along the ladder as `required`? Unknown
 * stages are treated as "not yet reached" so a typo can never open a gate.
 */
export function rolloutStageAtLeast(candidate: RolloutStage, required: RolloutStage): boolean {
	const c = rolloutStageIndex(candidate);
	const r = rolloutStageIndex(required);
	if (c === -1 || r === -1) return false;
	return c >= r;
}

export const OBSERVER_NAME = "acf-rollout-observer";
export const OBSERVER_VERSION = "ch14-1";
