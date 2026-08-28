/**
 * Adaptive Context Fidelity — token-accounting barrel (ACF CH0).
 *
 * The foundation phase: shared token counting + before/after delta + fail-open
 * telemetry + model-aware budgets. Disabled by default and NOT re-exported from
 * memory-fabric/index.ts (same discipline as context-hygiene / output-
 * distillation). Import and call explicitly; back the sink with the Event
 * Gateway only in a later observe → suggest → active rollout phase.
 */

export * from "./token-accounting";
