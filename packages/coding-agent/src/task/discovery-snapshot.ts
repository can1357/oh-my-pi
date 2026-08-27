/**
 * Shared discovery-snapshot store for the discovered agent roster, keyed by
 * the same composite cache key `TaskTool.create` / `refreshAgentDiscovery`
 * memoize discovery under (resolved cwd + effective extension roots) so two
 * sessions sharing a cwd with different extension lanes never read each
 * other's roster. `TaskTool.create` / `refreshAgentDiscovery` publish the
 * discovered definitions here; sibling surfaces that advertise the scout
 * shortcut (system prompt, grep/glob/ast-grep tool descriptions, session
 * plan-mode flags) read the scout definition's availability synchronously
 * without importing the task tool module (which would create an import cycle
 * through the tools barrel).
 */
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { AgentDefinition } from "./types";

const discoverySnapshots = new Map<string, AgentDefinition[]>();

/** Stable cache identity for the filesystem root and the full effective extension-root struct. */
export function discoveryCacheKey(cwd: string, extensionRoots?: EffectiveExtensionRoots): string {
	return `${path.resolve(cwd)}\0${JSON.stringify(extensionRoots ?? null)}`;
}

/** Publish the discovered roster for a cache key (replaces any prior snapshot). */
export function publishDiscoveredAgents(cacheKey: string, agents: AgentDefinition[]): void {
	discoverySnapshots.set(cacheKey, agents);
}

/** The published roster for a cache key, or `[]` when discovery has not run for it yet. */
export function getDiscoveredAgents(cacheKey: string): AgentDefinition[] {
	return discoverySnapshots.get(cacheKey) ?? [];
}

/**
 * The discovered `scout` definition for a cwd + extension-lane pair, or
 * `undefined` when discovery has not run for it yet (no TaskTool created / no
 * refresh). Surfaces that advertise the scout shortcut read this to honor a
 * project override that makes the bundled scout primary-only/unavailable.
 * Callers pass through their session's `effectiveExtensionRoots?.()` so the
 * lookup lands on the same lane the TaskTool would have discovered.
 */
export function getDiscoveredScoutAgent(
	cwd: string,
	extensionRoots?: EffectiveExtensionRoots,
): AgentDefinition | undefined {
	return getDiscoveredAgents(discoveryCacheKey(cwd, extensionRoots)).find(agent => agent.name === "scout");
}
