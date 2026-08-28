/**
 * Security & resilience — barrel.
 *
 * Disabled by default at the integration layer: this module is not re-exported
 * from any parent barrel (the same discipline as context-hygiene) so it stays
 * out of the hot path until a later observe → suggest → active rollout. Import
 * it and wrap a durable store explicitly to opt in.
 */

export * from "./constants";
export * from "./resilience";
export * from "./types";
