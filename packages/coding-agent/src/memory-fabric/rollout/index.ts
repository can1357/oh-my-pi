/**
 * Memory Fabric — rollout ladder barrel.
 *
 * Vocabulary for the observe → suggest → active → stable ladder, plus the one
 * rung with a controller today: the measure-only observe pass. Disabled by
 * default and NOT re-exported from `memory-fabric/index.ts`, matching the
 * discipline used by context-hygiene and token-accounting. Import and call
 * explicitly.
 *
 * Note for callers inside this package: the `@oh-my-pi/pi-coding-agent/...`
 * alias resolves FILE subpaths only, so import from `rollout/observe` or
 * `rollout/types` directly rather than through this barrel.
 */

export * from "./observe";
export * from "./types";
