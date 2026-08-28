/**
 * Adaptive Context Hygiene — barrel (ACF CH2 + CH3 + CH4 + CH5 + CH6 + CH9 + CH10 + gate wiring).
 *
 * Disabled by default at the integration layer; import and call the classifier,
 * deduper, coverage gate, orderer, projector, expander, semantic-redundancy
 * collapser, and composed pipeline explicitly. Not re-exported from
 * memory-fabric/index.ts on purpose (same discipline as output-distillation /
 * ADR-GI-001) so it stays out of the hot path until a later observe → suggest →
 * active rollout phase.
 *
 * Star re-exports only (AGENTS.md barrel rule). Every module below owns a
 * disjoint set of exported names — `types` owns the shared vocabulary
 * (ContextItem, FidelityClass, ALLOWED_TRANSFORMS, PRESERVED_CLASSES, …) and
 * the transform modules import it rather than re-exporting it — so there is no
 * ambiguous star export here.
 */

export * from "./classify";
export * from "./coverage";
export * from "./dedup";
export * from "./hot-cold";
export * from "./order";
export * from "./pipeline";
export * from "./project";
export * from "./semantic-redundancy";
export * from "./types";
