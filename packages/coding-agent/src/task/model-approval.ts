/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may only pick a model the operator already routes
 * to: a configured chat role value, a retry fallback chain entry, the
 * selected agent's frontmatter model or `task.agentModelOverrides` entry, or
 * the parent's live model. A model that is only in the catalog, authenticated,
 * enabled, picked by a built-in role default, or of another kind (image, web,
 * speech, dictation, judge) is not approved. Matching reuses the resolver that
 * `enabledModels` uses, so role aliases, fuzzy ids and globs behave the same
 * way here as they do everywhere else.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	modelSelectionInheritsSessionModel,
	normalizeModelPatternList,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	splitRoleAliasThinkingSuffix,
} from "../config/model-resolver";
import { KIND_ROLE_IDS } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "../session/settings";
import {
	cfgTaskAgentModelOverrides,
	cfgTaskDisabledAgents,
	cfgTaskPerCallModelAllow,
	cfgTaskPerCallModelFallbacks,
} from "./settings";

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
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The parent session's live model selector. */
	parentModelPattern?: string;
}

/** `@default` in any spelling (`*`, `pi/default`, `:level`) names the session's model, never a grant; a bare `*` would otherwise match every model as a glob. */
function isSessionToken(pattern: string): boolean {
	const base = splitRoleAliasThinkingSuffix(pattern).base.toLowerCase();
	return base === "default" || base === "inherit" || modelSelectionInheritsSessionModel(pattern);
}

/**
 * `select`: a model the caller may name in `model`. `dispatch`: a model the
 * running subagent may send to, which also covers retry fallbacks.
 */
export type PerCallModelUse = "select" | "dispatch";

/** Roles that select non-chat models; a subagent cannot run on them. */
export function isNonChatRole(role: string | undefined): boolean {
	return role !== undefined && (KIND_ROLE_IDS as readonly string[]).includes(role);
}

/** `@default` means the parent's live model, as it does in `model`; a set allowlist must name it. */
export function perCallModelAllowsParent(settings: Settings): boolean {
	const allow = cfgTaskPerCallModelAllow.get(settings);
	return allow.length === 0 || allow.some(entry => resolveExplicitModelRole(entry, settings) === "default");
}

/** Operator-configured selectors that approve a per-call model. */
export function perCallModelGrantPatterns(grants: PerCallModelGrants, use: PerCallModelUse): string[] {
	const { settings, agentName } = grants;
	const fallbackMode = cfgTaskPerCallModelFallbacks.get(settings);
	const withFallbacks = fallbackMode === "select" || (fallbackMode === "runtime" && use === "dispatch");
	const chains = Object.entries(withFallbacks ? cfgRetryFallbackChains.get(settings) : {}).filter(
		([key]) => !isNonChatRole(key),
	);
	// Wildcard chain entries are relative provider swaps, not models the operator named.
	const concrete = (chain: readonly string[] | undefined) => (chain ?? []).filter(entry => !entry.includes("*"));
	const allow = cfgTaskPerCallModelAllow.get(settings);
	const overrides = cfgTaskAgentModelOverrides.get(settings);
	const parentAllowed = perCallModelAllowsParent(settings);
	// A disabled agent's own model and override stop granting, like a removed one.
	const agentEnabled = !cfgTaskDisabledAgents.get(settings).includes(agentName);
	const sources: Array<string | string[] | undefined> =
		allow.length > 0
			? // An explicit list replaces the derived grants; a listed role brings its values and fallback chain.
				allow.flatMap(entry => {
					const role = resolveExplicitModelRole(entry, settings);
					if (role === "default") return [];
					if (isNonChatRole(role)) return [];
					if (!role) return [entry];
					return [
						...resolveConfiguredModelPatterns(entry, settings),
						...concrete(chains.find(([key]) => key === role)?.[1]),
					];
				})
			: [
					// Values, not aliases: an alias resolves to one model, but every listed candidate is a grant.
					...Object.entries(settings.getModelRoles())
						.filter(([role]) => !isNonChatRole(role))
						.map(([, value]) => value),
					...chains.map(([, chain]) => concrete(chain)),
					agentEnabled ? grants.agentModel : undefined,
					agentEnabled && Object.hasOwn(overrides, agentName) ? overrides[agentName] : undefined,
				];
	if (parentAllowed) sources.push(grants.parentModelPattern);
	const patterns = new Set<string>();
	for (const source of sources) {
		for (const pattern of normalizeModelPatternList(source)) {
			if (!isSessionToken(pattern)) patterns.add(pattern);
		}
	}
	return [...patterns];
}

function identity(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Whether `model` is one the operator routes to under the current configuration. */
export function isPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: Pick<ModelRegistry, "getAvailable">,
	use: PerCallModelUse,
): boolean {
	const patterns = perCallModelGrantPatterns(grants, use);
	// An empty list means "no restriction" to the resolver; here it means no grant.
	if (patterns.length === 0) return false;
	const target = identity(model);
	// Subagents run chat models only; a grant matching an image, search, speech or judge model does not count.
	return filterAvailableModelsByEnabledPatterns(registry.getAvailable("chat"), patterns, grants.settings).some(
		granted => identity(granted) === target,
	);
}

/** Throw {@link PerCallModelError} unless `model` is approved. */
export function assertPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: Pick<ModelRegistry, "getAvailable">,
	use: PerCallModelUse,
): void {
	if (isPerCallModelApproved(model, grants, registry, use)) return;
	throw new PerCallModelError(
		use === "select"
			? `Per-call model ${identity(model)} is not configured for agent "${grants.agentName}": use a configured role, agent model, task.agentModelOverrides entry, or the parent's model (fallback chain models count only with task.perCallModelFallbacks: select; task.perCallModelAllow narrows the set). Catalog or credentials alone do not approve a model.`
			: `Per-call subagent "${grants.agentName}" cannot switch to ${identity(model)}: it is not an approved model (task.perCallModelAllow / task.perCallModelFallbacks).`,
	);
}
