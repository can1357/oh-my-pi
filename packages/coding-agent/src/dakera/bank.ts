/**
 * Agent-id derivation for the Dakera backend.
 *
 * Dakera has no bank: the isolation unit is the `agent_id`, so Hindsight's
 * bank-id scheme collapses to an agent-id scheme. Three modes, matching
 * `dakera.scoping`:
 *   - `global`             — one shared agent_id, every project's memories mix.
 *   - `per-project`        — one agent_id per repository, hard isolation.
 *   - `per-project-tagged` — one shared agent_id; retains carry a
 *     `project:<name>` tag and recall filters on it, but also surfaces
 *     `global:`-tagged memories alongside (ANY-match).
 *
 * The base id is `agentIdPrefix-agentId` (default `omp`); per-project mode
 * appends `-<project>`.
 *
 * No setup call is needed: storing against an unseen `agent_id` creates it,
 * which is why this module has no `ensureBankExists` counterpart.
 */

import { projectLabel } from "../hindsight/bank";
import { resolveDakeraAgentIdOverride } from "./agent-override";
import type { DakeraConfig } from "./config";
const PROJECT_TAG_PREFIX = "project:";
const DEFAULT_AGENT_NAME = "omp";
/** Resolved agent target for a session. */
export interface AgentScope {
	agentId: string;
	/** Tags attached to every retain. Set in `global` and `per-project-tagged`
	 * modes, where the agent_id alone cannot say which project a memory came
	 * from. */
	retainTags?: string[];
	/** Tag filter for every recall: ANY-match, so untagged memories never
	 * surface while `global:`-tagged ones mix with the project scope. Set only
	 * in `per-project-tagged` mode. */
	recallTags?: string[];
}

/** Compose the prefixed base agent id (no project segment). */
function baseAgentId(config: DakeraConfig): string {
	const base = config.agentId?.trim() || DEFAULT_AGENT_NAME;
	const prefix = config.agentIdPrefix?.trim() || "";
	return prefix ? `${prefix}-${base}` : base;
}

/**
 * Resolve the active agent target for a working directory.
 *
 * Async because a per-repo `.omp/config.yml` `dakera.agentId` override is
 * consulted first (see `agent-override.ts`): when present it replaces the base
 * id — no prefix, no project segment — so every repo, subfolder and worktree
 * that opts in converges on one agent id. The scoping mode still applies to
 * that shared id: a tagged mode keeps tagging retains per project, so recall
 * and `/memory clear` stay project-scoped inside the converged agent instead
 * of an untagged all-or-nothing pool.
 */
export async function computeAgentScope(config: DakeraConfig, directory: string): Promise<AgentScope> {
	const override = await resolveDakeraAgentIdOverride(directory);
	const base = override ?? baseAgentId(config);
	const tag = `${PROJECT_TAG_PREFIX}${projectLabel(directory)}`;
	switch (config.scoping) {
		case "global":
			return { agentId: base, retainTags: [tag] };
		case "per-project":
			// The override replaces the whole id verbatim (no project segment):
			// converging repos on one agent is its documented purpose.
			return { agentId: override ?? `${base}-${projectLabel(directory)}` };
		case "per-project-tagged": {
			// Empty globalTag disables global mixing: strict project isolation.
			// Tagged modes keep their tags under an override too, so recall and
			// `/memory clear` stay project-scoped inside the converged agent
			// instead of an untagged all-or-nothing pool.
			const recallTags = config.globalTag ? [tag, config.globalTag] : [tag];
			return { agentId: base, retainTags: [tag], recallTags };
		}
	}
}
