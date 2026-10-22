/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may only pick a chat model the operator already
 * routes to: a configured chat role's value, a bundled or user-level agent's
 * frontmatter model, or the parent's live model. Catalog membership,
 * credentials, built-in role defaults, project agent frontmatter and saved
 * transcripts grant nothing. `task.perCallModelAllow`, when set, narrows the
 * result to the exact models it lists.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	normalizeModelPatternList,
	resolveExplicitModelRole,
	resolveModelOverride,
} from "../config/model-resolver";
import { isKindRole } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { cfgTaskDisabledAgents, cfgTaskPerCallModelAllow } from "./settings";

/** A per-call model was rejected: not approved by the operator's configuration. */
export class PerCallModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelError";
	}
}

/** Inputs that grant per-call models. Read live; nothing here is persisted as a grant. */
export interface PerCallModelGrants {
	settings: Settings;
	agentName: string;
	agentSource?: AgentSource;
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The selected agent is no longer discovered (cold revival): its frontmatter grants nothing. */
	agentRemoved?: boolean;
	/** The parent session's live model, as `provider/model-id`. */
	parentModelPattern?: string;
}

type ApprovalRegistry = Pick<ModelRegistry, "getAvailable">;

function identity(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Operator-configured selectors that grant a per-call model. Role aliases are
 * skipped rather than expanded: a configured role's value is a grant of its
 * own, and an unconfigured role would only route through built-in defaults.
 */
export function perCallModelGrantPatterns(grants: PerCallModelGrants): string[] {
	const { settings, agentName } = grants;
	const trustedAgent =
		(grants.agentSource === "bundled" || grants.agentSource === "user") &&
		!grants.agentRemoved &&
		!cfgTaskDisabledAgents.get(settings).includes(agentName);
	const sources = [
		...Object.entries(settings.getModelRoles())
			.filter(([role]) => !isKindRole(role))
			.map(([, value]) => value),
		trustedAgent ? grants.agentModel : undefined,
		grants.parentModelPattern,
	];
	const patterns = new Set<string>();
	for (const source of sources) {
		for (const pattern of normalizeModelPatternList(source)) {
			const bare = pattern.toLowerCase();
			if (bare === "default" || bare === "inherit" || resolveExplicitModelRole(pattern, settings)) continue;
			patterns.add(pattern);
		}
	}
	return [...patterns];
}

/** Whether `model` is one the operator routes to under the current configuration. */
export function isPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): boolean {
	const target = identity(model);
	const allow = cfgTaskPerCallModelAllow.get(grants.settings);
	if (
		allow.length > 0 &&
		!allow.some(entry => splitThinkingSuffix(entry.trim(), -1, MAX_THINKING_SUFFIX_OPTIONS).base === target)
	) {
		return false;
	}
	// Subagents run chat models only; a grant naming an image, search, speech or judge model does not count.
	const chat = registry.getAvailable("chat");
	if (!chat.some(candidate => identity(candidate) === target)) return false;
	const chatRegistry = { getAvailable: () => chat };
	return perCallModelGrantPatterns(grants).some(pattern => {
		// A literal id wins, so brackets in real ids (`glm-5.2[1m]`) never act as a glob.
		const literal = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base;
		if (literal === target || pattern === target) return true;
		if (chat.some(candidate => identity(candidate) === literal || identity(candidate) === pattern)) return false;
		// Otherwise a grant approves what it routes to: every match of a glob, or the one model a selector resolves to.
		if (/[*?[]/.test(pattern)) {
			return filterAvailableModelsByEnabledPatterns(chat, [pattern], grants.settings).some(
				granted => identity(granted) === target,
			);
		}
		const resolved = resolveModelOverride([pattern], chatRegistry, grants.settings).model;
		return resolved !== undefined && identity(resolved) === target;
	});
}

/** Throw {@link PerCallModelError} unless `model` is approved. */
export function assertPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	if (isPerCallModelApproved(model, grants, registry)) return;
	const allowGuidance =
		cfgTaskPerCallModelAllow.get(grants.settings).length > 0
			? " It must also be listed in task.perCallModelAllow."
			: "";
	throw new PerCallModelError(
		`Per-call model ${identity(model)} is not approved for agent "${grants.agentName}": use a model named by a configured chat role, a bundled or user-level agent's frontmatter, or the parent's model.${allowGuidance} Catalog or credentials alone do not approve a model.`,
	);
}
