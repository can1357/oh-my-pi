/**
 * Memory Fabric — composition root.
 *
 * This barrel is deliberately thin. It re-exports exactly one thing: the
 * canonical record vocabulary in `types.ts` (record shapes, verification and
 * sensitivity ladders, `createMemoryRecord` / `validateMemoryRecord`, and the
 * `MemoryFabricConfig` shape). Everything else in this folder follows the
 * explicit-import discipline its own barrels document: disabled by default,
 * NOT re-exported from here, and off the hot path until a caller constructs
 * and wires it on purpose.
 *
 * Why thin, instead of star-exporting the whole folder:
 *  - Every subsystem barrel (`context-hygiene/`, `session-integration/`,
 *    `token-accounting/`, `rollout/`, `security/`, and the flat lanes such as
 *    `output-distillation`) already promises callers it is not re-exported
 *    from this file. A fat root would break that written contract and put
 *    dormant layers one accidental import away from the hot path.
 *  - The `@oh-my-pi/pi-coding-agent/...` alias resolves FILE subpaths only,
 *    so in-package callers import concrete files directly (for example
 *    `memory-fabric/git-intelligence` or `memory-fabric/rollout/observe`);
 *    a root barrel earns nothing there and star-exports would only invite
 *    symbol collisions across forty-plus modules.
 *
 * Runtime composition does not live here. The lifecycle seam is
 * `session-integration/activation` — `activateMemoryFabric` assembles the
 * participant stack behind its feature flag and returns `null` unless the
 * flag is on. That function, not this barrel, is the fabric's entry point.
 *
 * Map of the folder (import each directly):
 *  - Retrieval: `rrf-fusion`, `tiered-retrieval-types` / `tiered-retrieval-broker`,
 *    `spiking-retrieval-gate`, `lane-selection`, `lane-adapters`, and the
 *    `capability-*` family (discovery, graph, ranking, retrieval, policy,
 *    orchestration, conflict/cycle analysis, seed fusion, planner adapter).
 *  - Context shaping: `progressive-context`, `context-composer`,
 *    `contextual-coverage`, `coverage-expansion-builder`, `response-density`,
 *    `solution-minimality`, `output-distillation`, `context-hygiene/`.
 *  - Budgets & fidelity: `budget-profiles`, `token-breakdown`,
 *    `activation-sparsity`, `expansion-thresholds`, `hybrid-fidelity-router`,
 *    `capability-fidelity`, `adaptive-fidelity/`, `token-accounting/`.
 *  - Events: `event-gateway`, `event-timeline`, `event-agent-tree`.
 *  - Durability & safety: `persistence/`, `guardian/`, `security/`,
 *    `redaction`, `scoping`, `retention`.
 *  - Behavioral intelligence: `git-intelligence`, `calibration`.
 *  - Quality & rollout: `quality-auditing`, `usefulness-feedback`,
 *    `utilization`, `release-manifest`, `rollout/`.
 *  - Lifecycle integration: `session-integration/`.
 */

export * from "./types";
