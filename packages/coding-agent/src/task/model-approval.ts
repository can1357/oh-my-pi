/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may only pick a chat model the operator already
 * routes to: a configured chat role's value, the selected agent's own
 * frontmatter model (only when that agent is bundled or user-level), or the
 * parent's live model. Catalog membership, credentials, built-in role
 * defaults, project agent frontmatter, other agents' frontmatter and saved
 * transcripts grant nothing. `task.perCallModelAllow`, when set, narrows the
 * result to the models its exact, `@role` or glob entries match. Under
 * `task.perCallModelFallbacks: runtime` a running worker may also send to
 * concrete `retry.fallbackChains` entries; those are never requestable.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	type ModelMatchPreferences,
	normalizeModelPatternList,
	resolveExplicitModelRole,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { isKindRole } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "../session/settings";
import { cfgTaskDisabledAgents, cfgTaskPerCallModelAllow, cfgTaskPerCallModelFallbacks } from "./settings";

/** A per-call model was rejected: not approved by the operator's configuration. */
export class PerCallModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelError";
	}
}

/**
 * Inputs that grant per-call models; nothing here is persisted as a grant. `settings` is read live,
 * so configuration changes apply to the next request; the agent, parent and match preferences
 * are captured when the child spawns (or is revived).
 */
export interface PerCallModelGrants {
	settings: Settings;
	agentName: string;
	agentSource?: AgentSource;
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The selected agent is no longer discovered (cold revival): its frontmatter grants nothing. */
	agentRemoved?: boolean;
	/** The parent session's live model, as `provider/model-id` plus any `@upstream` pin. */
	parentModelPattern?: string;
	/** Spawn-time selector preferences; unrelated later model usage cannot change a grant. */
	matchPreferences?: ModelMatchPreferences;
}

type ApprovalRegistry = Pick<ModelRegistry, "getAll" | "getAvailable">;

/**
 * The one model an exact entry names: a literal catalog id wins over a `:level`
 * split, and an `@upstream` pin stays part of the identity. Undefined when the
 * entry is not an exact selector in the full catalog, including unavailable models.
 */
function exactIdentity(entry: string, catalog: Model<Api>[]): string | undefined {
	const model = resolveModelOverride([entry], { getAvailable: () => catalog }, undefined, { exactOnly: true }).model;
	return model ? formatModelStringWithRouting(model) : undefined;
}

/** A parent only grants a route that an exact selector can represent without discarding routing policy. */
export function parentModelGrantPattern(model: Model<Api>): string | undefined {
	const selector = formatModelStringWithRouting(model);
	const compat = model.compat;
	if (!compat || typeof compat !== "object") return selector;
	for (const key of ["openRouterRouting", "vercelGatewayRouting"] as const) {
		const routing: unknown = (compat as Readonly<Record<string, unknown>>)[key];
		if (routing === undefined) continue;
		if (
			!routing ||
			typeof routing !== "object" ||
			Object.keys(routing).length !== 1 ||
			!("only" in routing) ||
			!Array.isArray(routing.only) ||
			routing.only.length !== 1 ||
			typeof routing.only[0] !== "string" ||
			!routing.only[0] ||
			selector !== `${formatModelString(model)}@${routing.only[0]}`
		) {
			return undefined;
		}
	}
	return selector;
}

/** Settings-only selectors advertised without resolving the model catalog or availability. */
export interface PerCallModelAdvertisement {
	roles: { role: string; patterns: string[] }[];
	allowlist: string[];
	/** True when the caller's live model cannot be written as one selector, so the own-model clause never grants. */
	parentModelWithheld: boolean;
}

/**
 * Operator-configured selectors that grant a per-call model. Role aliases are
 * skipped rather than expanded: a configured role's value is a grant of its
 * own, and an unconfigured role would only route through built-in defaults.
 */
function modelGrantPatterns(source: string | string[] | undefined, settings: Settings): string[] {
	const patterns = new Set<string>();
	for (const pattern of normalizeModelPatternList(source)) {
		const bare = pattern.toLowerCase();
		if (bare === "default" || bare === "inherit" || resolveExplicitModelRole(pattern, settings)) continue;
		patterns.add(pattern);
	}
	return [...patterns];
}

function configuredRoleGrantPatterns(settings: Settings): PerCallModelAdvertisement["roles"] {
	return Object.entries(settings.getModelRoles()).flatMap(([role, value]) => {
		if (isKindRole(role)) return [];
		const patterns = modelGrantPatterns(value, settings);
		return patterns.length > 0 ? [{ role, patterns }] : [];
	});
}

/**
 * Whether an allowlist entry could admit a model matched by this role's grant
 * pattern. Syntactic only, mirroring the dispatch checks: the advertisement is
 * built without a registry, so a glob pattern is kept whenever an entry could
 * name a model it matches.
 */
function allowEntryCouldAdmitPattern(role: string, pattern: string, entry: string): boolean {
	const selector = entry.trim().toLowerCase();
	if (selector.length === 0) return false;
	if (selector.startsWith("@")) return selector.slice(1) === role.toLowerCase();
	const source = pattern.toLowerCase();
	// A `:level` suffix narrows the spawn, never the model identity an entry names.
	const base = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base.toLowerCase();
	for (const candidate of base === source ? [source] : [source, base]) {
		if (candidate === selector) return true;
		if (!/[*?]/.test(candidate)) continue;
		// Two globs cannot be intersected syntactically; keep the pattern rather than hide it.
		if (/[*?]/.test(selector)) return true;
		const expression = candidate.replace(/[\\^$.*+?()[\]{}|]/g, char =>
			char === "*" ? "[^@]*" : char === "?" ? "[^@]" : `\\${char}`,
		);
		const slash = selector.indexOf("/");
		const target = candidate.includes("/") || slash < 0 ? selector : selector.slice(slash + 1);
		if (new RegExp(`^${expression}$`).test(target)) return true;
	}
	return false;
}

/** Stable prompt data: only operator-owned settings grant or narrow the advertised selectors. */
export function getPerCallModelAdvertisement(settings: Settings, parentModel?: Model<Api>): PerCallModelAdvertisement {
	const authority = settings.grantAuthority();
	const allow = cfgTaskPerCallModelAllow.get(authority);
	const roles = configuredRoleGrantPatterns(authority)
		.map(({ role, patterns }) => ({
			role,
			// Advertise only patterns the allowlist could admit, so the prompt never names a model dispatch refuses.
			patterns:
				allow.length === 0
					? patterns
					: patterns.filter(pattern => allow.some(entry => allowEntryCouldAdmitPattern(role, pattern, entry))),
		}))
		.filter(({ patterns }) => patterns.length > 0);
	return {
		roles,
		allowlist: [...new Set(allow.map(entry => entry.trim()))],
		parentModelWithheld: parentModel !== undefined && parentModelGrantPattern(parentModel) === undefined,
	};
}

function perCallModelGrantPatterns(grants: PerCallModelGrants): string[] {
	const settings = grants.settings.grantAuthority();
	const { agentName } = grants;
	const trustedAgent =
		(grants.agentSource === "bundled" || grants.agentSource === "user") &&
		!grants.agentRemoved &&
		!cfgTaskDisabledAgents.get(settings).includes(agentName);
	return [
		...new Set([
			...configuredRoleGrantPatterns(settings).flatMap(({ patterns }) => patterns),
			...modelGrantPatterns(trustedAgent ? grants.agentModel : undefined, settings),
			...modelGrantPatterns(grants.parentModelPattern, settings),
		]),
	];
}

/**
 * Approval globs are scoped to either the canonical identity or a bare id, never both. `*` spans
 * any characters except `@`, including `/` in aggregator ids; `?` matches one such character.
 * Brackets and all other punctuation are literal, and an upstream pin must be written explicitly.
 */
function globGrants(pattern: string, model: Model<Api>): boolean {
	const source = pattern
		.toLowerCase()
		.replace(/[\\^$.*+?()[\]{}|]/g, char => (char === "*" ? "[^@]*" : char === "?" ? "[^@]" : `\\${char}`));
	const identity = formatModelStringWithRouting(model);
	return new RegExp(`^${source}$`).test(
		(pattern.includes("/") ? identity : identity.slice(model.provider.length + 1)).toLowerCase(),
	);
}

/** Grant-value matching uses full-catalog literals and the spawn's frozen preferences. */
function patternGrants(
	pattern: string,
	model: Model<Api>,
	chat: Model<Api>[],
	catalog: Model<Api>[],
	matchPreferences?: ModelMatchPreferences,
): boolean {
	const target = formatModelStringWithRouting(model);
	const exact = exactIdentity(pattern, catalog);
	if (exact !== undefined) return exact === target;
	if (/[*?]/.test(pattern)) {
		const suffix = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
		const globPattern =
			suffix.level && !catalog.some(candidate => globGrants(pattern, candidate)) ? suffix.base : pattern;
		return globGrants(globPattern, model);
	}
	const knownLiteralId = catalog.some(candidate => candidate.id === pattern);
	const candidates = knownLiteralId ? chat.filter(candidate => candidate.id === pattern) : chat;
	const resolved = resolveModelRoleValue(pattern, candidates, { matchPreferences }).model;
	return resolved !== undefined && formatModelStringWithRouting(resolved) === target;
}

/** Exact allowlist entries stay literal; roles and globs only narrow the existing grants. */
function allowlistAdmits(
	model: Model<Api>,
	grants: PerCallModelGrants,
	chat: Model<Api>[],
	catalog: Model<Api>[],
): boolean {
	const settings = grants.settings.grantAuthority();
	const target = formatModelStringWithRouting(model);
	const allow = cfgTaskPerCallModelAllow.get(settings);
	return (
		allow.length === 0 ||
		allow.some(entry => {
			const selector = entry.trim();
			const role = resolveExplicitModelRole(selector, settings);
			if (role !== undefined) {
				return (
					!isKindRole(role) &&
					modelGrantPatterns(settings.getModelRole(role), settings).some(pattern =>
						patternGrants(pattern, model, chat, catalog, grants.matchPreferences),
					)
				);
			}
			return selector === target || (/[*?]/.test(selector) && globGrants(selector, model));
		})
	);
}

/** Whether the operator's current configuration names this available chat model itself. */
function isGranted(model: Model<Api>, grants: PerCallModelGrants, chat: Model<Api>[], catalog: Model<Api>[]): boolean {
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return false;
	if (!allowlistAdmits(model, grants, chat, catalog)) return false;
	return perCallModelGrantPatterns(grants).some(pattern =>
		patternGrants(pattern, model, chat, catalog, grants.matchPreferences),
	);
}

/**
 * Whether a running worker may switch to an available chat model named by a concrete chain entry.
 * The live grant authority and allowlist apply; an executor's derived chain never grants.
 */
function isRuntimeFallback(
	model: Model<Api>,
	grants: PerCallModelGrants,
	chat: Model<Api>[],
	catalog: Model<Api>[],
): boolean {
	const settings = grants.settings.grantAuthority();
	if (cfgTaskPerCallModelFallbacks.get(settings) !== "runtime") return false;
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return false;
	if (!allowlistAdmits(model, grants, chat, catalog)) return false;
	return modelGrantPatterns(concreteChainEntries(settings), settings).some(pattern =>
		patternGrants(pattern, model, chat, catalog, grants.matchPreferences),
	);
}
/** Throw {@link PerCallModelError} unless `model` is approved. */
export function assertPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	const chat = registry.getAvailable("chat");
	if (isGranted(model, grants, chat, registry.getAll())) return;
	const allowGuidance =
		cfgTaskPerCallModelAllow.get(grants.settings.grantAuthority()).length > 0
			? " It must also match an entry in task.perCallModelAllow."
			: "";
	throw new PerCallModelError(
		`Per-call model ${formatModelStringWithRouting(model)} is not approved for agent "${grants.agentName}": use a model named by a configured chat role, the selected agent's own frontmatter (bundled or user-level agents only), or the parent's model.${allowGuidance} Catalog or credentials alone do not approve a model.`,
	);
}

/** Concrete `retry.fallbackChains` entries; wildcard entries are relative provider swaps, not models the operator named. */
function concreteChainEntries(settings: Settings): string[] {
	return Object.entries(cfgRetryFallbackChains.get(settings))
		.filter(([key]) => !isKindRole(key))
		.flatMap(([, chain]) => (Array.isArray(chain) ? chain.filter(entry => !/[*?]/.test(entry)) : []));
}

/**
 * Throw {@link PerCallModelError} unless a running per-call worker may send to
 * `model`: an approved model, or under `task.perCallModelFallbacks: runtime` a
 * concrete `retry.fallbackChains` entry the allowlist admits. A Factory model
 * with an attached server-side fallback chain is eligible: the per-call request
 * omits the chain, and a served-model handoff fails the worker.
 */
export function assertPerCallDispatchModel(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	const settings = grants.settings.grantAuthority();
	const runtime = cfgTaskPerCallModelFallbacks.get(settings) === "runtime";
	if (!runtime) {
		try {
			assertPerCallModelApproved(model, grants, registry);
		} catch (error) {
			if (!(error instanceof PerCallModelError)) throw error;
			throw new PerCallModelError(`${error.message} Runtime fallbacks need task.perCallModelFallbacks: runtime.`);
		}
		return;
	}
	const chat = registry.getAvailable("chat");
	const catalog = registry.getAll();
	const target = formatModelStringWithRouting(model);
	if (isGranted(model, grants, chat, catalog) || isRuntimeFallback(model, grants, chat, catalog)) {
		return;
	}
	const allowGuidance =
		cfgTaskPerCallModelAllow.get(settings).length > 0
			? ", and it must also match an entry in task.perCallModelAllow"
			: "";
	throw new PerCallModelError(
		`Per-call subagent "${grants.agentName}" cannot send to ${target}: the model is not approved and not a concrete retry.fallbackChains entry${allowGuidance}.`,
	);
}
