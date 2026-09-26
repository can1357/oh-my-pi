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
/** Retain tag for memories meant to surface in every project's tagged recall. */
export const DAKERA_GLOBAL_TAG = "global:shared";
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
 * consulted first (see `agent-override.ts`): when present it names the agent
 * outright — no prefix, no project segment — so every repo, subfolder and
 * worktree that opts in converges on one agent id.
 */
export async function computeAgentScope(config: DakeraConfig, directory: string): Promise<AgentScope> {
	const override = await resolveDakeraAgentIdOverride(directory);
	if (override) return { agentId: override };
	const base = baseAgentId(config);
	switch (config.scoping) {
		case "global":
			return { agentId: base, retainTags: [`${PROJECT_TAG_PREFIX}${projectLabel(directory)}`] };
		case "per-project":
			return { agentId: `${base}-${projectLabel(directory)}` };
		case "per-project-tagged": {
			const tag = `${PROJECT_TAG_PREFIX}${projectLabel(directory)}`;
			return { agentId: base, retainTags: [tag], recallTags: [tag, DAKERA_GLOBAL_TAG] };
		}
	}
}
