import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, Effort, Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	formatModelSelectorValue,
	MAX_THINKING_SUFFIX_OPTIONS,
	splitThinkingSuffix,
	splitUpstreamRouting,
} from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	AUTO_THINKING,
	concreteThinkingLevel,
	toReasoningEffort,
	type ConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	normalizeModelPatternList,
	parseModelPattern,
	splitRoleAliasThinkingSuffix,
} from "../config/model-resolver";
import { cfgDisabledProviders, cfgEnabledModels } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains, cfgRetryModelFallback } from "../session/settings";
import { cfgTaskAgentModelOverrides } from "./settings";

/** Operator grants, independent of the model-facing requested selection. */
export interface TaskModelAuthority {
	settings: Settings;
	agentName: string;
	agentModel?: string | string[];
	/** Refresh the current discovered definition before dispatch, without granting transcript authority. */
	getAgentModel?(): Promise<string | string[] | undefined>;
	getParentSelector?(): string | undefined;
	getParentModel?(): Model | undefined;
}

/** Process-local capability. Serialized metadata cannot recreate one. */
export interface RoleRoutePermit {
	readonly __roleRoutePermit?: never;
}

interface RoleDependency {
	role: string;
	value: string;
	fallbacks?: string[];
	fallbacksConfigured?: boolean;
}

export interface RoleRouteOccurrence {
	pattern: string;
	role?: string;
	parent?: boolean;
	thinkingLevel?: ConfiguredThinkingLevel;
	fixedEffort: boolean;
	identity?: string;
	api?: Api;
	baseUrl?: string;
	transport?: Model["transport"];
	/** Role-qualified effort is separate from literal model-id text. */
	effortOverride?: ConfiguredThinkingLevel;
	/** Serving-wire policy snapshot; limits/pricing changes do not affect identity. */
	wirePolicy?: string;
}

/** Diagnostic selection contract, not a persisted authorization grant. */
export interface RoleRouteMetadata {
	selectors: string[];
	occurrences: RoleRouteOccurrence[];
	dependencies: RoleDependency[];
	explicit: boolean;
	requiresVision: boolean;
	/** Captured only for role-derived chains; changing it revokes those chains. */
	fallbacksAllowed?: boolean;
	selectedOccurrence?: number;
	role?: string;
}

export interface RoleRouteResult {
	permit: RoleRoutePermit;
	metadata: RoleRouteMetadata;
}

export interface RoleRouteModelSelection {
	model: Model;
	selector: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	fixedEffort: boolean;
	role?: string;
	occurrence: number;
}

interface HostRoleRoute {
	authority: TaskModelAuthority;
	registry: ModelRegistry;
	metadata: RoleRouteMetadata;
	candidates: RoleRouteOccurrence[];
	selected?: RoleRouteModelSelection;
}

export const ROLE_ROUTE_BLOCKED_PREFIX = "Host role preflight blocked:";
export const ROLE_ROUTE_UNAVAILABLE_PREFIX = "Host role preflight unavailable:";

export class RoleRouteUnavailableError extends Error {
	constructor(message: string) {
		super(`${ROLE_ROUTE_UNAVAILABLE_PREFIX} ${message}`);
		this.name = "RoleRouteUnavailableError";
	}
}

const routeByPermit = new WeakMap<RoleRoutePermit, HostRoleRoute>();

function blocked(message: string): never {
	throw new Error(`${ROLE_ROUTE_BLOCKED_PREFIX} ${message}`);
}

function routeFor(permit: RoleRoutePermit): HostRoleRoute {
	const route = routeByPermit.get(permit);
	if (!route) blocked("Invalid dispatch permit; only the host can authorize a route.");
	return route;
}

function alias(pattern: string): { role: string; level?: ConfiguredThinkingLevel } | undefined {
	if (!pattern.startsWith("@") && !pattern.startsWith("pi/") && pattern !== "*" && !pattern.startsWith("*:")) return;
	const { base, level } = splitRoleAliasThinkingSuffix(pattern);
	const role = base === "*" ? "default" : base.slice(base.startsWith("@") ? 1 : 3);
	if (!role || role.includes(":")) blocked(`Invalid model role selector ${JSON.stringify(pattern)}.`);
	if (role.toLowerCase() === "inherit")
		blocked("@inherit is not a per-call model selector; use @default for the live parent.");
	return { role, level };
}

function parse(
	pattern: string,
	catalog: Model[],
): { model?: Model; thinkingLevel?: ConfiguredThinkingLevel; explicitThinkingLevel: boolean } {
	const resolved = parseModelPattern(pattern, catalog, undefined, { allowInvalidThinkingSelectorFallback: false });
	if (!resolved.model) return resolved;
	const { model } = resolved;
	const identity = formatModelStringWithRouting(model);
	const routed = splitUpstreamRouting(pattern);
	const recognized = [
		pattern,
		resolved.explicitThinkingLevel ? splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base : pattern,
	];
	if (routed) recognized.push(routed.base, splitThinkingSuffix(routed.base, -1, MAX_THINKING_SUFFIX_OPTIONS).base);
	if (
		!recognized.some(
			value =>
				value.toLowerCase() === model.id.toLowerCase() ||
				value.toLowerCase() === `${model.provider}/${model.id}`.toLowerCase() ||
				value.toLowerCase() === identity.toLowerCase(),
		)
	)
		return { explicitThinkingLevel: false };
	return resolved;
}

function qualityRole(settings: Settings): string | undefined {
	return ["best", "slow", "review"].find(role => settings.getModelRole(role)?.trim());
}

function expandRole(
	role: string,
	settings: Settings,
	dependencies: RoleDependency[],
	visiting: ReadonlySet<string> = new Set(),
	level?: ConfiguredThinkingLevel,
	includeFallbacks = true,
): Array<{ pattern: string; thinkingLevel?: ConfiguredThinkingLevel }> {
	if (role === "best" && !settings.getModelRole(role)?.trim()) {
		const selected = qualityRole(settings);
		for (const candidate of ["best", "slow", "review"]) {
			dependencies.push({ role: candidate, value: settings.getModelRole(candidate)?.trim() ?? "" });
			if (candidate === selected) break;
		}
		role = selected ?? role;
	}
	if (visiting.has(role)) blocked(`Configured model roles contain a cycle at @${role}.`);
	const value = settings.getModelRole(role)?.trim();
	if (!value) blocked(`Model role @${role} is not configured.`);
	const fallbacks = includeFallbacks ? cfgRetryFallbackChains.get(settings)[role] : undefined;
	dependencies.push({
		role,
		value,
		...(includeFallbacks ? { fallbacks: [...(fallbacks ?? [])], fallbacksConfigured: fallbacks !== undefined } : {}),
	});
	const next = new Set(visiting);
	next.add(role);
	const sources = [
		...normalizeModelPatternList(value),
		...(includeFallbacks && cfgRetryModelFallback.get(settings) ? (fallbacks ?? []) : []),
	];
	return sources.flatMap(pattern => {
		const nested = alias(pattern);
		const expanded = nested
			? expandRole(nested.role, settings, dependencies, next, nested.level, includeFallbacks)
			: [{ pattern }];
		return level === undefined ? expanded : expanded.map(candidate => ({ ...candidate, thinkingLevel: level }));
	});
}

function dependencySnapshot(settings: Settings, dependencies: readonly RoleDependency[]): RoleDependency[] {
	return dependencies.map(({ role, fallbacks }) => ({
		role,
		value: settings.getModelRole(role)?.trim() ?? "",
		...(fallbacks !== undefined
			? {
					fallbacks: [...(cfgRetryFallbackChains.get(settings)[role] ?? [])],
					fallbacksConfigured: cfgRetryFallbackChains.get(settings)[role] !== undefined,
				}
			: {}),
	}));
}

function assertCurrent(route: HostRoleRoute): void {
	if (
		!Bun.deepEquals(
			route.metadata.dependencies,
			dependencySnapshot(route.authority.settings, route.metadata.dependencies),
		)
	)
		blocked("The requested role configuration changed; retry the task under the current configuration.");
	if (
		route.metadata.fallbacksAllowed !== undefined &&
		route.metadata.fallbacksAllowed !== cfgRetryModelFallback.get(route.authority.settings)
	)
		blocked("The configured role fallback policy changed; retry the task.");
}

function liveParent(
	authority: TaskModelAuthority,
	catalog: Model[],
): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const selector = authority.getParentSelector?.()?.trim();
	if (!selector) return;
	const model = authority.getParentModel?.();
	if (model) {
		const identity = formatModelStringWithRouting(model);
		if (selector === identity) return { model };
		if (!selector.startsWith(`${identity}:`)) blocked("The live parent model and effort selector disagree.");
		const suffix = splitThinkingSuffix(`x:${selector.slice(identity.length + 1)}`, -1, MAX_THINKING_SUFFIX_OPTIONS);
		if (!suffix.level) blocked("The live parent has an invalid effort selector.");
		return { model, thinkingLevel: suffix.level };
	}
	const resolved = parse(selector, catalog);
	if (!resolved.model) return;
	const canonical = formatModelSelectorValue(formatModelStringWithRouting(resolved.model), resolved.thinkingLevel);
	if (canonical !== selector) blocked("Parent inheritance requires the exact live parent selector.");
	return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

function authorityPatterns(authority: TaskModelAuthority, catalog: Model[]): string[] {
	const { settings, agentName, agentModel } = authority;
	const sources = [
		...Object.values(settings.getModelRoles()),
		...Object.values(cfgRetryFallbackChains.get(settings)).flat(),
		...normalizeModelPatternList(agentModel),
		...normalizeModelPatternList(
			Object.hasOwn(cfgTaskAgentModelOverrides.get(settings), agentName)
				? cfgTaskAgentModelOverrides.get(settings)[agentName]
				: undefined,
		),
	];
	const concrete: string[] = [];
	for (const source of sources) {
		for (const pattern of normalizeModelPatternList(source)) {
			try {
				const named = alias(pattern);
				const expanded = named
					? expandRole(named.role, settings, [], new Set(), named.level, false).map(candidate => candidate.pattern)
					: [pattern];
				concrete.push(
					...expanded.filter(
						value =>
							!/[*?[]/.test(value) ||
							catalog.some(model => formatModelStringWithRouting(model) === value || model.id === value),
					),
				);
			} catch {
				// A broken, unrelated role is not a grant and cannot disable independent grants.
			}
		}
	}
	return concrete;
}

export function assertTaskModelAuthority(
	authority: TaskModelAuthority,
	registry: Pick<ModelRegistry, "getAll">,
	model: Model,
): void {
	const catalog = registry.getAll("all");
	const identity = formatModelStringWithRouting(model);
	const parent = liveParent(authority, catalog);
	if (parent && formatModelStringWithRouting(parent.model) === identity) return;
	for (const pattern of authorityPatterns(authority, catalog)) {
		const resolved = parse(pattern, catalog);
		if (resolved.model && formatModelStringWithRouting(resolved.model) === identity) return;
	}
	blocked(
		`${identity} is not authorized by actual configured roles/fallbacks, agent "${authority.agentName}" frontmatter/exact task override, or the live parent. Catalog/auth/enabled scope alone is not authority.`,
	);
}

function assertDeferredAuthority(authority: TaskModelAuthority, pattern: string, catalog: Model[]): void {
	const base = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base;
	if (
		authorityPatterns(authority, catalog).some(
			grant => grant === pattern || splitThinkingSuffix(grant, -1, MAX_THINKING_SUFFIX_OPTIONS).base === base,
		)
	)
		return;
	blocked(`Unresolved selector ${JSON.stringify(pattern)} has no current operator grant.`);
}

function occurrence(
	pattern: string,
	catalog: Model[],
	role?: string,
	effortOverride?: ConfiguredThinkingLevel,
): RoleRouteOccurrence {
	const resolved = parse(pattern, catalog);
	if (!resolved.model) {
		const recovered = parseModelPattern(pattern, catalog);
		if (recovered.model && recovered.warning)
			blocked(`Invalid thinking suffix in selector ${JSON.stringify(pattern)}.`);
		const thinkingLevel = effortOverride ?? splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).level;
		return {
			pattern,
			role,
			effortOverride,
			thinkingLevel,
			fixedEffort: thinkingLevel !== undefined && thinkingLevel !== AUTO_THINKING,
		};
	}
	return {
		pattern: formatModelSelectorValue(
			formatModelStringWithRouting(resolved.model),
			effortOverride ?? resolved.thinkingLevel,
		),
		role,
		effortOverride,
		thinkingLevel: effortOverride ?? (resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined),
		fixedEffort:
			effortOverride !== undefined
				? effortOverride !== AUTO_THINKING
				: resolved.explicitThinkingLevel && resolved.thinkingLevel !== AUTO_THINKING,
		identity: formatModelStringWithRouting(resolved.model),
		api: resolved.model.api,
		baseUrl: resolved.model.baseUrl,
		transport: resolved.model.transport,
		wirePolicy: JSON.stringify({
			requestModelId: resolved.model.requestModelId,
			thinking: resolved.model.thinking,
			compat: resolved.model.compat,
			cursorModelRoutes: resolved.model.cursorModelRoutes,
		}),
	};
}

function supported(candidate: RoleRouteOccurrence, model: Model): void {
	const effort = toReasoningEffort(concreteThinkingLevel(candidate.thinkingLevel));
	if (candidate.fixedEffort && effort !== undefined && !getSupportedEfforts(model).includes(effort))
		blocked(
			`Requested effort ${effort} is not supported by ${formatModelStringWithRouting(model)}; no downgrade is permitted.`,
		);
}

function resolvedOccurrence(
	route: HostRoleRoute,
	index: number,
	registry: ModelRegistry,
): RoleRouteModelSelection | undefined {
	assertCurrent(route);
	const candidate = route.candidates[index];
	const catalog = registry.getAll("all");
	const resolved = candidate.identity === undefined ? parse(candidate.pattern, catalog) : undefined;
	const model =
		candidate.identity === undefined
			? resolved?.model
			: (catalog.find(model => formatModelStringWithRouting(model) === candidate.identity) ??
				parse(candidate.identity, catalog).model);
	if (!model) return;
	if (candidate.identity === undefined) {
		const discovered = occurrence(candidate.pattern, catalog, candidate.role, candidate.effortOverride);
		Object.assign(candidate, discovered);
	}
	const identity = formatModelStringWithRouting(model);
	if (
		candidate.identity !== identity ||
		candidate.api !== model.api ||
		candidate.baseUrl !== model.baseUrl ||
		candidate.transport !== model.transport
	)
		blocked("Model discovery changed an already-admitted identity or transport.");
	if (
		candidate.wirePolicy &&
		candidate.wirePolicy !==
			JSON.stringify({
				requestModelId: model.requestModelId,
				thinking: model.thinking,
				compat: model.compat,
				cursorModelRoutes: model.cursorModelRoutes,
			})
	)
		blocked("Model discovery changed an already-admitted wire model/effort policy.");
	assertTaskModelAuthority(route.authority, registry, model);
	supported(candidate, model);
	const settings = route.authority.settings;
	const scoped = filterAvailableModelsByEnabledPatterns(catalog, cfgEnabledModels.get(settings), settings);
	if (
		cfgDisabledProviders.get(settings).includes(model.provider) ||
		!scoped.some(entry => entry.provider === model.provider && entry.id === model.id)
	)
		return;
	if (modelKind(model) !== "chat") return;
	if (model.supportsTools === false || (route.metadata.requiresVision && !model.input.includes("image"))) return;
	if (
		!registry.hasConfiguredAuth(model) ||
		!registry.getAvailable().some(entry => entry.provider === model.provider && entry.id === model.id)
	)
		return;
	if (registry.isSelectorSuppressed(formatModelSelectorValue(identity, candidate.thinkingLevel))) return;
	return Object.freeze({
		model,
		selector: formatModelSelectorValue(identity, candidate.thinkingLevel),
		thinkingLevel: candidate.thinkingLevel,
		fixedEffort: candidate.fixedEffort,
		role: candidate.role,
		occurrence: index,
	});
}

export async function createTaskModelRoute(options: {
	authority: TaskModelAuthority;
	modelRegistry: ModelRegistry;
	selectors: string[];
	explicit: boolean;
	/** Host-only implicit fallback to a configured role, never a model-facing alias. */
	configuredRole?: string;
	requiresVision?: boolean;
	signal?: AbortSignal;
}): Promise<RoleRouteResult> {
	options.signal?.throwIfAborted();
	const { authority, modelRegistry, selectors } = options;
	const catalog = modelRegistry.getAll("all");
	const dependencies: RoleDependency[] = [];
	const candidates: RoleRouteOccurrence[] = [];
	for (const selector of selectors) {
		const { base } = splitThinkingSuffix(selector, -1, MAX_THINKING_SUFFIX_OPTIONS);
		if (["default", "inherit"].includes(base.toLowerCase()))
			blocked("Bare default/inherit selectors are ambiguous; use @default for the live parent.");
		const named = alias(selector);
		if (named?.role === "default" && options.configuredRole === undefined) {
			const parent = liveParent(authority, catalog);
			if (!parent) blocked("@default requires an actual live parent model and effort, not modelRoles.default.");
			const level = named.level ?? parent.thinkingLevel;
			candidates.push({
				pattern: formatModelSelectorValue(formatModelStringWithRouting(parent.model), level),
				role: "default",
				parent: true,
				thinkingLevel: level,
				fixedEffort: level !== AUTO_THINKING,
				identity: formatModelStringWithRouting(parent.model),
				api: parent.model.api,
				baseUrl: parent.model.baseUrl,
				transport: parent.model.transport,
				wirePolicy: JSON.stringify({
					requestModelId: parent.model.requestModelId,
					thinking: parent.model.thinking,
					compat: parent.model.compat,
					cursorModelRoutes: parent.model.cursorModelRoutes,
				}),
			});
			continue;
		}
		const selectedRole = options.configuredRole ?? named?.role;
		const patterns: Array<{ pattern: string; thinkingLevel?: ConfiguredThinkingLevel }> = selectedRole
			? expandRole(selectedRole, authority.settings, dependencies, new Set(), named?.level)
			: [{ pattern: selector }];
		for (const entry of patterns) {
			const { pattern } = entry;
			const provider = pattern.slice(0, pattern.indexOf("/"));
			const candidate = occurrence(
				pattern,
				catalog,
				selectedRole === "best" ? qualityRole(authority.settings) : selectedRole,
				entry.thinkingLevel,
			);
			const resolved = parse(pattern, catalog);
			if (resolved.model) {
				try {
					assertTaskModelAuthority(authority, modelRegistry, resolved.model);
				} catch (error) {
					if (!options.explicit && selectedRole === undefined) continue;
					throw error;
				}
				supported(candidate, resolved.model);
			} else {
				try {
					assertDeferredAuthority(authority, pattern, catalog);
				} catch (error) {
					if (!options.explicit && selectedRole === undefined) continue;
					throw error;
				}
			}
			if (
				!named &&
				selectors.length === 1 &&
				provider &&
				cfgDisabledProviders.get(authority.settings).includes(provider)
			)
				blocked(`Requested provider ${provider} is disabled; no model substitution is permitted.`);
			candidates.push(candidate);
		}
	}
	if (candidates.length === 0) blocked("Model selection has no configured candidates.");
	const metadata: RoleRouteMetadata = {
		selectors: [...selectors],
		occurrences: candidates,
		dependencies,
		explicit: options.explicit,
		requiresVision: options.requiresVision === true,
		...(dependencies.length > 0 ? { fallbacksAllowed: cfgRetryModelFallback.get(authority.settings) } : {}),
	};
	const permit: RoleRoutePermit = {};
	const route: HostRoleRoute = { authority, registry: modelRegistry, metadata, candidates };
	routeByPermit.set(permit, route);
	assertCurrent(route);
	const unresolved = candidates.some(candidate => candidate.identity === undefined);
	try {
		resolveRoleRoute(permit);
	} catch (error) {
		if (!(error instanceof RoleRouteUnavailableError) || !unresolved) throw error;
	}
	options.signal?.throwIfAborted();
	return { permit, metadata: roleRouteMetadata(permit)! };
}

export function resolveRoleRoute(permit: RoleRoutePermit, registry?: ModelRegistry): RoleRouteModelSelection {
	const route = routeFor(permit);
	const lookup = registry ?? route.registry;
	assertCurrent(route);
	if (route.selected) {
		const current = resolvedOccurrence(route, route.selected.occurrence, lookup);
		if (!current)
			throw new RoleRouteUnavailableError(
				"The selected occurrence is unavailable; automatic substitution is prohibited.",
			);
		route.selected = current;
		return current;
	}
	const start = 0;
	for (let index = start; index < route.candidates.length; index++) {
		const selected = resolvedOccurrence(route, index, lookup);
		if (!selected) continue;
		route.selected = selected;
		route.metadata.selectedOccurrence = index;
		route.metadata.role = selected.role;
		return selected;
	}
	throw new RoleRouteUnavailableError(
		"No usable model remains inside the approved selection; do not drop model or substitute another route.",
	);
}

export function roleRouteMetadata(permit: RoleRoutePermit | undefined): RoleRouteMetadata | undefined {
	const route = permit ? routeByPermit.get(permit) : undefined;
	return route ? structuredClone(route.metadata) : undefined;
}

/** Nested workers retain the operator's grant scope, not child-owned role overlays. */
export function taskModelAuthoritySettings(permit: RoleRoutePermit): Settings {
	return routeFor(permit).authority.settings;
}

export function roleRouteCandidateSelectors(permit: RoleRoutePermit): readonly string[] {
	const route = routeFor(permit);
	assertCurrent(route);
	return route.candidates.map(candidate => candidate.pattern);
}

/** Actual model identities avoid ambiguous literal-colon selector reparsing. */
export function roleRouteFallbackCandidates(
	permit: RoleRoutePermit,
	registry?: ModelRegistry,
): readonly RoleRouteModelSelection[] {
	const route = routeFor(permit);
	assertCurrent(route);
	const candidates: RoleRouteModelSelection[] = [];
	for (let index = (route.selected?.occurrence ?? -1) + 1; index < route.candidates.length; index++) {
		const selected = resolvedOccurrence(route, index, registry ?? route.registry);
		if (selected) candidates.push(selected);
	}
	return candidates;
}

export function roleRouteFallbackSelectors(permit: RoleRoutePermit, registry?: ModelRegistry): readonly string[] {
	return roleRouteFallbackCandidates(permit, registry).map(candidate => candidate.selector);
}

/** Preview a permitted transition before asynchronous credential/metadata work. */
export function inspectRoleRouteCandidate(
	permit: RoleRoutePermit,
	selector: string,
	model: Model,
	registry?: ModelRegistry,
): RoleRouteModelSelection {
	const route = routeFor(permit);
	assertCurrent(route);
	for (let index = (route.selected?.occurrence ?? -1) + 1; index < route.candidates.length; index++) {
		const selected = resolvedOccurrence(route, index, registry ?? route.registry);
		if (
			!selected ||
			selected.selector !== selector ||
			formatModelStringWithRouting(selected.model) !== formatModelStringWithRouting(model) ||
			selected.model.api !== model.api ||
			selected.model.baseUrl !== model.baseUrl ||
			selected.model.transport !== model.transport
		)
			continue;
		return selected;
	}
	blocked("Retry model/effort is not a remaining approved occurrence.");
}

export function adoptRoleRouteCandidate(
	permit: RoleRoutePermit,
	selector: string,
	model: Model,
	registry?: ModelRegistry,
): RoleRouteModelSelection {
	const selected = inspectRoleRouteCandidate(permit, selector, model, registry);
	const route = routeFor(permit);
	route.selected = selected;
	route.metadata.selectedOccurrence = selected.occurrence;
	route.metadata.role = selected.role;
	return selected;
}

export function roleRouteThinkingLevel(permit: RoleRoutePermit, model: Model): ConfiguredThinkingLevel | undefined {
	const route = routeFor(permit);
	if (route.selected && formatModelStringWithRouting(route.selected.model) === formatModelStringWithRouting(model))
		return route.selected.thinkingLevel;
	return undefined;
}

export function assertRoleModel(
	permit: RoleRoutePermit | undefined,
	model: Model | undefined,
	signal?: AbortSignal,
	registry?: ModelRegistry,
): void {
	if (!permit) return;
	signal?.throwIfAborted();
	const route = routeFor(permit);
	assertCurrent(route);
	const selected = route.selected;
	if (
		!model ||
		!selected ||
		formatModelStringWithRouting(selected.model) !== formatModelStringWithRouting(model) ||
		selected.model.api !== model.api ||
		selected.model.baseUrl !== model.baseUrl ||
		selected.model.transport !== model.transport
	)
		blocked("The actual serving model or transport escaped the selected approved occurrence.");
	const current = resolvedOccurrence(route, selected.occurrence, registry ?? route.registry);
	if (!current)
		throw new RoleRouteUnavailableError(
			"The selected model is no longer available in provider/auth/enabled/tool scope.",
		);
	if (model.supportsTools === false || (route.metadata.requiresVision && !model.input.includes("image")))
		blocked("Serving model lost required tool/image capability.");
	const candidate = route.candidates[selected.occurrence];
	if (
		candidate.wirePolicy &&
		candidate.wirePolicy !==
			JSON.stringify({
				requestModelId: model.requestModelId,
				thinking: model.thinking,
				compat: model.compat,
				cursorModelRoutes: model.cursorModelRoutes,
			})
	)
		blocked("The final serving model changed the approved wire model/effort policy.");
}

export function assertRoleDispatch(
	permit: RoleRoutePermit | undefined,
	model: Model | undefined,
	reasoning: Effort | undefined,
	signal?: AbortSignal,
	registry?: ModelRegistry,
): void {
	assertRoleModel(permit, model, signal, registry);
	if (!permit || !model) return;
	const selected = routeFor(permit).selected!;
	if (selected.fixedEffort && reasoning !== toReasoningEffort(concreteThinkingLevel(selected.thinkingLevel)))
		blocked("The actual serving effort escaped the fixed requested occurrence.");
	if (reasoning !== undefined && !getSupportedEfforts(model).includes(reasoning))
		blocked("The actual serving effort is not supported by the selected model.");
}

/** Reuse the existing provider/settings wrappers; validate their final serving model and payload. */
export function wrapRoleRouteStream(
	getPermit: () => RoleRoutePermit | undefined,
	base: StreamFn,
	registry?: ModelRegistry,
): StreamFn {
	return async (model, context, options) => {
		const permit = getPermit();
		if (!permit) return base(model, context, options);
		const route = routeFor(permit);
		const refreshAuthority = async (): Promise<void> => {
			await route.authority.settings.reloadFromDisk();
			if (route.authority.getAgentModel) route.authority.agentModel = await route.authority.getAgentModel();
		};
		await refreshAuthority();
		const validate = (serving: Model = model): void => {
			if (getPermit() !== permit) blocked("The dispatch permit changed during provider preparation.");
			assertRoleDispatch(permit, serving, options?.reasoning, options?.signal, registry);
		};
		if (options?.fallbacks?.length) blocked("Provider-side fallback options cannot override the approved selection.");
		if (
			(options?.forceReasoningOff || options?.disableReasoning) &&
			route.selected?.fixedEffort &&
			toReasoningEffort(concreteThinkingLevel(route.selected.thinkingLevel)) !== undefined
		)
			blocked("External reasoning suppression cannot discard a fixed requested effort.");
		if (route.selected?.thinkingLevel === "off" && !options?.disableReasoning && !options?.forceReasoningOff)
			blocked("The final serving request discarded its explicit reasoning-off selection.");
		validate();
		if (
			context.messages.some(
				message => Array.isArray(message.content) && message.content.some(part => part.type === "image"),
			) &&
			!model.input.includes("image")
		)
			blocked("The final serving model cannot consume the worker's image content.");
		return base(model, context, {
			...options,
			preserveModelSelection: true,
			fallbacks: [],
			onPayload: async (payload, serving) => {
				if (
					isRecord(payload) &&
					((Array.isArray(payload.models) && payload.models.length > 0) ||
						(Array.isArray(payload.fallbacks) && payload.fallbacks.length > 0))
				)
					blocked("Provider payload supplied model alternatives outside the selected approved occurrence.");
				const fields = [
					"model",
					"models",
					"fallbacks",
					"provider",
					"providerOptions",
					"reasoning",
					"reasoning_effort",
					"thinking",
					"enable_thinking",
					"thinkingConfig",
					"thinking_config",
					"generationConfig",
					"output_config",
					"chat_template_kwargs",
					"config",
					"requestedModel",
					"modelDetails",
					"modelConfig",
					"requestModelId",
					"wireModelId",
					"response",
				];
				const before = isRecord(payload) ? fields.map(key => JSON.stringify(payload[key])) : undefined;
				const controlsBefore =
					isRecord(payload) && Array.isArray(payload.input)
						? JSON.stringify(payload.input.filter(item => isRecord(item) && item.type === "configuration_update"))
						: undefined;
				const transformed = options?.onPayload
					? await options.onPayload(payload, serving ?? model, options?.signal)
					: payload;
				const effective = transformed === undefined ? payload : transformed;
				if (before && !isRecord(effective)) blocked("Provider payload discarded the selected approved occurrence.");
				const controlsAfter =
					isRecord(effective) && Array.isArray(effective.input)
						? JSON.stringify(
								effective.input.filter(item => isRecord(item) && item.type === "configuration_update"),
							)
						: undefined;
				if (controlsBefore !== controlsAfter)
					blocked("Provider payload changed the approved in-band effort controls.");
				if (
					isRecord(effective) &&
					((Array.isArray(effective.models) && effective.models.length > 0) ||
						(Array.isArray(effective.fallbacks) && effective.fallbacks.length > 0) ||
						(before && fields.some((key, index) => JSON.stringify(effective[key]) !== before[index])))
				)
					blocked("Provider payload changed the approved serving model/effort selection.");
				await refreshAuthority();
				validate(serving ?? model);
				return transformed;
			},
		});
	};
}

/** Hooks may narrow/reorder occurrences or add effort, never widen their authority. */
export function narrowRoleRoute(
	permit: RoleRoutePermit,
	replacements: string[],
	registry?: ModelRegistry,
): RoleRouteResult {
	const route = routeFor(permit);
	assertCurrent(route);
	const lookup = registry ?? route.registry;
	const catalog = lookup.getAll("all");
	const candidates: RoleRouteOccurrence[] = [];
	const used = new Set<number>();
	const requestedOccurrences: RoleRouteOccurrence[] = [];
	for (const pattern of replacements) {
		const named = alias(pattern);
		if (named?.role === "default") {
			const parent = liveParent(route.authority, catalog);
			if (!parent) blocked("A hook cannot manufacture live-parent authority.");
			const level = named.level ?? parent.thinkingLevel;
			requestedOccurrences.push({
				pattern: formatModelSelectorValue(formatModelStringWithRouting(parent.model), level),
				role: "default",
				identity: formatModelStringWithRouting(parent.model),
				thinkingLevel: level,
				fixedEffort: level !== AUTO_THINKING,
			});
		} else if (named) {
			for (const candidate of expandRole(named.role, route.authority.settings, [], new Set(), named.level)) {
				requestedOccurrences.push(occurrence(candidate.pattern, catalog, named.role, candidate.thinkingLevel));
			}
		} else requestedOccurrences.push(occurrence(pattern, catalog));
	}
	for (const requested of requestedOccurrences) {
		const index = route.candidates.findIndex(
			(candidate, index) =>
				!used.has(index) &&
				(requested.role === undefined || candidate.role === requested.role) &&
				(candidate.identity && requested.identity
					? candidate.identity === requested.identity
					: candidate.pattern === requested.pattern) &&
				(!candidate.fixedEffort || candidate.thinkingLevel === requested.thinkingLevel) &&
				(candidate.thinkingLevel !== AUTO_THINKING ||
					requested.thinkingLevel === undefined ||
					requested.thinkingLevel === AUTO_THINKING),
		);
		if (index < 0) blocked("Extension model replacement escaped the approved model/effort occurrences.");
		used.add(index);
		const original = route.candidates[index];
		const model = requested.identity ? parse(requested.identity, catalog).model : undefined;
		if (model) supported(requested, model);
		candidates.push({
			...original,
			pattern: requested.pattern,
			effortOverride: requested.thinkingLevel ?? original.effortOverride,
			thinkingLevel: requested.thinkingLevel ?? original.thinkingLevel,
			fixedEffort: requested.fixedEffort || original.fixedEffort,
		});
	}
	if (candidates.length === 0) blocked("Extension model replacement has no candidates.");
	const narrowed: RoleRoutePermit = {};
	const metadata = { ...structuredClone(route.metadata), occurrences: candidates, selectedOccurrence: undefined };
	routeByPermit.set(narrowed, { ...route, metadata, candidates, selected: undefined });
	resolveRoleRoute(narrowed, lookup);
	return { permit: narrowed, metadata: roleRouteMetadata(narrowed)! };
}

/** Cold revival re-admits the recorded closure against current, independent host grants. */
export async function restoreTaskModelRoute(
	authority: TaskModelAuthority,
	modelRegistry: ModelRegistry,
	metadata: RoleRouteMetadata,
): Promise<RoleRouteResult> {
	const permit: RoleRoutePermit = {};
	const restored = structuredClone(metadata);
	if (
		!Array.isArray(restored.occurrences) ||
		restored.occurrences.length === 0 ||
		!Array.isArray(restored.dependencies)
	)
		blocked("The recorded worker route is incomplete.");
	if (
		restored.selectedOccurrence !== undefined &&
		(!Number.isInteger(restored.selectedOccurrence) ||
			restored.selectedOccurrence < 0 ||
			restored.selectedOccurrence >= restored.occurrences.length)
	)
		blocked("The recorded worker occurrence is invalid.");
	const route: HostRoleRoute = {
		authority,
		registry: modelRegistry,
		metadata: restored,
		candidates: restored.occurrences,
	};
	assertCurrent(route);
	for (const candidate of route.candidates) {
		const resolved = parse(candidate.identity ?? candidate.pattern, modelRegistry.getAll("all"));
		if (resolved.model) assertTaskModelAuthority(authority, modelRegistry, resolved.model);
		else assertDeferredAuthority(authority, candidate.identity ?? candidate.pattern, modelRegistry.getAll("all"));
	}
	routeByPermit.set(permit, route);
	if (restored.selectedOccurrence !== undefined) {
		const selected = resolvedOccurrence(route, restored.selectedOccurrence, modelRegistry);
		if (!selected)
			throw new RoleRouteUnavailableError(
				"The recorded worker selection is unavailable; revival cannot substitute another model.",
			);
		route.selected = selected;
	} else resolveRoleRoute(permit);
	return { permit, metadata: roleRouteMetadata(permit)! };
}
