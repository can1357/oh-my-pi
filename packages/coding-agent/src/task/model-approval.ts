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
 * result to the models its exact, `@role` or glob entries match.
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
import { cfgTaskDisabledAgents, cfgTaskPerCallModelAllow } from "./settings";

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

/** Whether the operator's current configuration names this available chat model itself. */
function isGranted(model: Model<Api>, grants: PerCallModelGrants, chat: Model<Api>[], catalog: Model<Api>[]): boolean {
	const settings = grants.settings.grantAuthority();
	const target = formatModelStringWithRouting(model);
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return false;
	const patternGrants = (pattern: string): boolean => {
		// Full-catalog literals win even when unavailable, so :low and [1m] never broaden a grant.
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
		const resolved = resolveModelRoleValue(pattern, candidates, { matchPreferences: grants.matchPreferences }).model;
		return resolved !== undefined && formatModelStringWithRouting(resolved) === target;
	};
	const allow = cfgTaskPerCallModelAllow.get(settings);
	if (
		allow.length > 0 &&
		!allow.some(entry => {
			const selector = entry.trim();
			const role = resolveExplicitModelRole(selector, settings);
			if (role !== undefined) {
				return !isKindRole(role) && modelGrantPatterns(settings.getModelRole(role), settings).some(patternGrants);
			}
			// Exact allowlist entries are literal identities, never suffix or fuzzy selectors.
			return selector === target || (/[*?]/.test(selector) && globGrants(selector, model));
		})
	) {
		return false;
	}
	return perCallModelGrantPatterns(grants).some(patternGrants);
}

/** Whether a saved seance selector may run under the same grants and transport limits as an explicit model. */
export function isPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): boolean {
	return isGranted(model, grants, registry.getAvailable("chat"), registry.getAll());
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
