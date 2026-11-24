/**
 * Model browser data: role assignments, the session's model scope, display
 * order, search ranking, and the price/mark facts every model list shows
 * (the alt+p picker, the /models hub, setup, RPC `get_model_picker`).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	getEffectiveTokenCost,
	getFactoryDroidCreditRate,
	getModelPricingStatus,
	modelsAreEqual,
} from "@oh-my-pi/pi-catalog/models";
import { type ModelKind, type ModelPricingStatus, modelKind } from "@oh-my-pi/pi-catalog/types";
import type { TspPickerColumn, TspPickerMark } from "@oh-my-pi/pi-wire";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "../../../thinking/levels";
import { FuzzyQuery, FuzzyText, fuzzyRank } from "../../../utils/fuzzy";
import { type ConfiguredThinkingLevel } from "../../../utils/render-utils";

/** Canonical display ordering of built-in model roles. */
export type ModelRole =
	| "default"
	| "smol"
	| "slow"
	| "vision"
	| "plan"
	| "commit"
	| "tiny"
	| "memory"
	| "task"
	| "advisor"
	| "widget"
	| "image"
	| "web"
	| "speech"
	| "dictation"
	| "judge";

export const MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"widget",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
];

export const CHAT_MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"widget",
];

export const KIND_ROLE_IDS: ModelRole[] = ["image", "web", "speech", "dictation", "judge"];

/** Role lookup used for scoped model resolution. */
export interface ModelRoleLookup {
	getModelRole(role: string): string | undefined;
}

/** Measured model performance shown in browser rows. */
export interface ModelBrowserPerf {
	samples: number;
	tps: number;
	ttftMs: number | null;
}

/** Role metadata shown in model selectors. */
export interface ModelBrowserRoleInfo {
	tag?: string;
	name: string;
	/** Theme color of the role's chip. */
	color?: string;
	hidden?: boolean;
	section: "chat" | "kind";
	accepts(model: Model): boolean;
}

/** Resolved selector metadata required by model overlays. */
export interface ResolvedModelRoleValue {
	model: Model | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning?: string;
}

/** Host-provided preferences and model-role resolution for model lists. */
export interface ModelBrowserSource extends ModelRoleLookup {
	/**
	 * Changes whenever any preference this source reads or resolves against changes,
	 * except the storage-backed `mruOrder` and `modelPerf`. Keys derived-scope caches.
	 */
	readonly revision: number;
	/**
	 * The preference store behind this source (its {@link revision} counts that
	 * store's changes): sources sharing it resolve roles alike, so derived-scope
	 * caches outlive one source. Absent: the source itself.
	 */
	readonly preferences?: object;
	readonly defaultThinkingLevel: string;
	readonly modelProviderOrder: readonly string[];
	readonly knownRoleIds: readonly string[];
	readonly mruOrder: readonly string[];
	readonly modelPerf: ReadonlyMap<string, ModelBrowserPerf>;
	/** Service tier the host would send for `model`: rows with a measured `selector@tier` aggregate show that tier. */
	serviceTierFor?(model: Model): string | undefined;
	getRoleInfo(role: string): ModelBrowserRoleInfo;
	defaultRoleChain(role: string): string[];
	resolveRoleValue(value: string | undefined, models: Model[], roleLookup?: ModelRoleLookup): ResolvedModelRoleValue;
	/** Auto-compaction point for `model`; absent hosts show no compaction fact. */
	compactionPointFor?(model: Model): ModelCompactionPoint | undefined;
}

/** One selectable row. `selector` is a canonical model key or a host-specific virtual key (`@smol`). */
export interface ModelBrowserItem {
	provider: string;
	id: string;
	model: Model;
	selector: string;
	/** Theme color of the row label (quick-role rows take their ctrl+p segment's). */
	labelColor?: string;
}

/** Where auto-compaction triggers for one model, as the model hub's preview shows it (edited from the Roles view). */
export interface ModelCompactionPoint {
	/** Context tokens that trigger auto-compaction; undefined when auto-compaction is off or the window is unknown. */
	tokens: number | undefined;
	/** Why it triggers there, in a few words: `fixed`, `85% of 400K base`, `80% of window`. */
	basis?: string;
	/** What sets it: the matching `compaction.modelThresholds` key, `global`, or `default`. */
	source: string;
	/** The model's own exact entry as editable text (`90k`, `80%`); absent when it has none. */
	draft?: string;
}

/** Read-only catalog surface consumed by model browsers. */
export interface ModelBrowserRegistry {
	getError(): unknown;
	getAvailable(kind?: ModelKind | "all"): Model[];
	getAll(kind?: ModelKind | "all"): Model[];
}

/** Resolved role assignment as displayed by the browser and the hub. */
export interface RoleAssignment {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel;
	/** True when the role has no configured value and fell back to auto-selection. */
	autoSelected: boolean;
}

/** Map of role id to its resolved assignment (absent roles are unresolved). */
export type RoleAssignments = Record<string, RoleAssignment | undefined>;

interface RoleProviderStats {
	count: number;
	firstRole: number;
}

/** User affinity used to order search matches within one relevance tier. */
export interface SearchAffinity {
	/** `provider/id` (lowercased) → rank; configured-role models first, then MRU. */
	models: Map<string, number>;
	/** provider (lowercased) → rank; explicit order, then role providers, then MRU providers. */
	providers: Map<string, number>;
}

/**
 * Build model and provider affinity from explicit configuration, configured
 * role assignments, and recent model use. Auto-selected roles are catalog
 * policy, not evidence of user preference.
 */
export function buildSearchAffinity(
	providerOrder: ReadonlyArray<string>,
	roles: RoleAssignments,
	mruOrder: ReadonlyArray<string>,
): SearchAffinity {
	const models: string[] = [];
	const seenModels = new Set<string>();
	const addModel = (selector: string) => {
		const key = selector.toLowerCase();
		if (seenModels.has(key)) return;
		seenModels.add(key);
		models.push(key);
	};

	const providers: string[] = [];
	const seenProviders = new Set<string>();
	const addProvider = (provider: string) => {
		const key = provider.trim().toLowerCase();
		if (!key || seenProviders.has(key)) return;
		seenProviders.add(key);
		providers.push(key);
	};

	for (const provider of providerOrder) addProvider(provider);

	const roleStats = new Map<string, RoleProviderStats>();
	const seenRoles = new Set<string>();
	let roleIndex = 0;
	const recordRole = (role: string) => {
		if (seenRoles.has(role)) return;
		seenRoles.add(role);
		const assignment = roles[role];
		if (assignment && !assignment.autoSelected) {
			addModel(`${assignment.model.provider}/${assignment.model.id}`);
			const provider = assignment.model.provider.toLowerCase();
			const current = roleStats.get(provider);
			if (current) {
				current.count++;
			} else {
				roleStats.set(provider, { count: 1, firstRole: roleIndex });
			}
		}
		roleIndex++;
	};
	for (const role of MODEL_ROLE_IDS) recordRole(role);
	for (const role in roles) recordRole(role);
	for (const selector of mruOrder) addModel(selector);

	const preferredByRole = [...roleStats.entries()].sort(
		([, a], [, b]) => b.count - a.count || a.firstRole - b.firstRole,
	);
	for (const [provider] of preferredByRole) addProvider(provider);

	for (const selector of mruOrder) {
		const slash = selector.indexOf("/");
		if (slash > 0) addProvider(selector.slice(0, slash));
	}

	return {
		models: new Map(models.map((selector, index) => [selector, index])),
		providers: new Map(providers.map((provider, index) => [provider, index])),
	};
}

// ─── Role assignments ───────────────────────────────────────────────────────

/**
 * Resolve every known role to its display assignment: configured role values
 * resolve against `allModels`; unconfigured roles fall back to auto-selection
 * over `autoCandidates` (skipped when empty).
 */
export function resolveRoleAssignments(
	settings: ModelBrowserSource,
	allModels: ReadonlyArray<Model>,
	autoCandidates: ReadonlyArray<Model>,
): RoleAssignments {
	const levelOf = (
		role: string,
		resolved: { explicitThinkingLevel: boolean; thinkingLevel?: ConfiguredThinkingLevel },
	): ConfiguredThinkingLevel => {
		if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) return resolved.thinkingLevel;
		if (role === "default")
			return parseConfiguredThinkingLevel(settings.defaultThinkingLevel) ?? ThinkingLevel.Inherit;
		return ThinkingLevel.Inherit;
	};
	// Roles sharing an `accepts` predicate share one filtered pool.
	const eligible = (
		pool: ReadonlyArray<Model>,
		byAccepts: Map<ModelBrowserRoleInfo["accepts"], Model[]>,
		role: string,
	): Model[] => {
		const accepts = settings.getRoleInfo(role).accepts;
		let models = byAccepts.get(accepts);
		if (!models) {
			models = pool.filter(accepts);
			byAccepts.set(accepts, models);
		}
		return models;
	};

	const roles: RoleAssignments = {};
	const configured = new Set<string>();
	const catalogPools = new Map<ModelBrowserRoleInfo["accepts"], Model[]>();
	for (const role of settings.knownRoleIds) {
		const value = settings.getModelRole(role);
		if (!value) continue;
		configured.add(role);
		const resolved = settings.resolveRoleValue(value, eligible(allModels, catalogPools, role));
		if (resolved.model)
			roles[role] = { model: resolved.model, thinkingLevel: levelOf(role, resolved), autoSelected: false };
	}
	if (autoCandidates.length > 0) {
		const candidatePools = new Map<ModelBrowserRoleInfo["accepts"], Model[]>();
		for (const role of settings.knownRoleIds) {
			if (configured.has(role)) continue;
			const resolved = settings.resolveRoleValue(`pi/${role}`, eligible(autoCandidates, candidatePools, role));
			if (resolved.model)
				roles[role] = { model: resolved.model, thinkingLevel: levelOf(role, resolved), autoSelected: true };
		}
	}
	return roles;
}

/**
 * Role-resolution pool for a `--models` scope: the scoped models plus every
 * available non-chat runner (the scope only filters chat models).
 */
export function scopedRolePool(scoped: ReadonlyArray<Model>, registry: ModelBrowserRegistry): Model[] {
	const pool = [...scoped];
	for (const model of registry.getAvailable("all")) {
		if (modelKind(model) === "chat" || scoped.some(entry => modelsAreEqual(entry, model))) continue;
		pool.push(model);
	}
	return pool;
}

/** Wrap raw models into browser items. */
export function buildBrowserItems(models: ReadonlyArray<Model>): ModelBrowserItem[] {
	return models.map(model => ({
		provider: model.provider,
		id: model.id,
		model,
		selector: `${model.provider}/${model.id}`,
	}));
}

/** A role's chip text: its tag, else its name, lowercased. */
export function roleChipLabel(role: string, settings: Pick<ModelBrowserSource, "getRoleInfo">): string {
	const info = settings.getRoleInfo(role);
	return (info.tag ?? info.name ?? role).toLowerCase();
}

/** A role a model holds. */
export interface HeldRole {
	role: string;
	assignment: RoleAssignment;
}

/** Visible roles `model` holds, built-in order first. */
export function heldRoles(
	model: Model,
	roles: RoleAssignments,
	settings: Pick<ModelBrowserSource, "getRoleInfo">,
): HeldRole[] {
	const held: HeldRole[] = [];
	eachAssignedRole(roles, (role, assignment) => {
		if (!modelsAreEqual(assignment.model, model)) return;
		if (settings.getRoleInfo(role).hidden) return;
		held.push({ role, assignment });
	});
	return held;
}

/** {@link heldRoles} of every model at once, keyed by {@link modelIdentityKey}; models holding none are absent. */
export function heldRolesByModel(
	roles: RoleAssignments,
	settings: Pick<ModelBrowserSource, "getRoleInfo">,
): Map<string, HeldRole[]> {
	const byModel = new Map<string, HeldRole[]>();
	eachAssignedRole(roles, (role, assignment) => {
		if (settings.getRoleInfo(role).hidden) return;
		const key = modelIdentityKey(assignment.model);
		const held = byModel.get(key);
		if (held) held.push({ role, assignment });
		else byModel.set(key, [{ role, assignment }]);
	});
	return byModel;
}

/** A model's identity as {@link modelsAreEqual} compares it, as one map key. */
export function modelIdentityKey(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}\0${model.id}`;
}

/** Each assigned role once, built-in order first. */
function eachAssignedRole(roles: RoleAssignments, visit: (role: string, assignment: RoleAssignment) => void): void {
	const seen = new Set<string>();
	const push = (role: string): void => {
		if (seen.has(role)) return;
		seen.add(role);
		const assignment = roles[role];
		if (assignment) visit(role, assignment);
	};
	for (const role of MODEL_ROLE_IDS) push(role);
	for (const role in roles) push(role);
}

function isRecentOrRole(item: ModelBrowserItem, roles: RoleAssignments, mruOrder: ReadonlyArray<string>): boolean {
	if (mruOrder.includes(item.selector)) return true;
	for (const role in roles) {
		const assignment = roles[role];
		if (assignment && modelsAreEqual(assignment.model, item.model)) return true;
	}
	return false;
}

/**
 * Rows of the Recent block heading `items`: the leading run of recently used
 * or role-held models; 0 when that run is empty or spans every item.
 */
export function recentBlockLength(
	items: readonly ModelBrowserItem[],
	roles: RoleAssignments,
	mruOrder: ReadonlyArray<string>,
): number {
	const end = items.findIndex(item => !isRecentOrRole(item, roles, mruOrder));
	return end > 0 ? end : 0;
}

// ─── Display order ──────────────────────────────────────────────────────────

/** The first version number of a model id (`gemini-2.5-pro` → 2.5, `claude-sonnet-4-6` → 4.6, `gpt-4o` → 4). */
function versionNumber(id: string): number {
	const dotted = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotted) return Number.parseFloat(dotted[1]!);
	const dashed = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashed) return Number.parseFloat(`${dashed[1]}.${dashed[2]}`);
	const single = id.match(/(?:^|[-_])(\d+)/);
	return single ? Number.parseFloat(single[1]!) : 0;
}

/** The first built-in role each assigned model holds (lower = earlier), keyed by {@link modelIdentityKey}. */
function roleRanks(roles: RoleAssignments): Map<string, number> {
	const ranks = new Map<string, number>();
	for (let i = MODEL_ROLE_IDS.length - 1; i >= 0; i--) {
		const assigned = roles[MODEL_ROLE_IDS[i]!];
		if (assigned) ranks.set(modelIdentityKey(assigned.model), i);
	}
	return ranks;
}

/** Options for {@link sortModelItems}. */
export interface SortModelItemsOptions {
	roles?: RoleAssignments;
	mruOrder?: ReadonlyArray<string>;
	/** A query is narrowing the list: roles do not promote a weak match above a strong one. */
	skipRoleRank?: boolean;
}

/** Order models for display: role-assigned first, then most recently used, then per provider by priority, version and recency. */
export function sortModelItems(items: ModelBrowserItem[], options: SortModelItemsOptions = {}): void {
	const compare = modelItemComparator(items, options);
	items.sort(compare);
}

const DATED_ID = /-(\d{8})$/;
const LATEST_ID = /-latest$/;

/** One item's {@link modelItemComparator} keys, computed once per sort. */
interface OrderKeys {
	roleRank: number;
	mru: number;
	/** Position of the provider in `localeCompare` order (equal-comparing providers share one). */
	provider: number;
	priority: number;
	version: number;
	latest: boolean;
	/** `YYYYMMDD` of a dated id, else empty. */
	date: string;
}

/** The display-order comparator over `items` (only those): keys are computed once per item, not per comparison. */
function modelItemComparator(
	items: readonly ModelBrowserItem[],
	options: SortModelItemsOptions,
): (a: ModelBrowserItem, b: ModelBrowserItem) => number {
	const { roles = {}, mruOrder = [], skipRoleRank = false } = options;
	const mru = new Map(mruOrder.map((key, i) => [key, i]));
	const ranks = skipRoleRank ? undefined : roleRanks(roles);
	const providers = [...new Set(items.map(item => item.provider))].sort((a, b) => a.localeCompare(b));
	const providerRank = new Map<string, number>();
	let rank = 0;
	for (let i = 0; i < providers.length; i++) {
		if (i > 0 && providers[i - 1]!.localeCompare(providers[i]!) !== 0) rank++;
		providerRank.set(providers[i]!, rank);
	}
	const keys = new Map<ModelBrowserItem, OrderKeys>();
	for (const item of items) {
		keys.set(item, {
			roleRank: ranks?.get(modelIdentityKey(item.model)) ?? MODEL_ROLE_IDS.length,
			mru: mru.get(item.selector) ?? Number.MAX_SAFE_INTEGER,
			provider: providerRank.get(item.provider)!,
			priority: item.model.priority ?? Number.MAX_SAFE_INTEGER,
			version: versionNumber(item.id),
			latest: LATEST_ID.test(item.id),
			date: item.id.match(DATED_ID)?.[1] ?? "",
		});
	}
	return (a, b) => {
		const ka = keys.get(a)!;
		const kb = keys.get(b)!;
		if (!skipRoleRank) {
			const byRole = ka.roleRank - kb.roleRank;
			if (byRole !== 0) return byRole;
		}
		const byMru = ka.mru - kb.mru;
		if (byMru !== 0) return byMru;
		const byProvider = ka.provider - kb.provider;
		if (byProvider !== 0) return byProvider;
		const byPriority = ka.priority - kb.priority;
		if (byPriority !== 0) return byPriority;
		const byVersion = kb.version - ka.version;
		if (byVersion !== 0) return byVersion;
		const aRecency = ka.latest || ka.date !== "";
		const bRecency = kb.latest || kb.date !== "";
		if (aRecency !== bRecency) return aRecency ? -1 : 1;
		if (!aRecency) return a.id.localeCompare(b.id);
		if (ka.latest !== kb.latest) return ka.latest ? -1 : 1;
		if (ka.date && kb.date) return kb.date.localeCompare(ka.date);
		return a.id.localeCompare(b.id);
	};
}

// ─── The session's model scope ──────────────────────────────────────────────

/** Picker candidates and ordering inputs shared with composer model mentions. */
export interface SessionModelScope {
	items: ModelBrowserItem[];
	roles: RoleAssignments;
	mruOrder: ReadonlyArray<string>;
	error: string | undefined;
}

/** Catalog inputs a {@link SessionModelScope} is derived from. */
interface SessionModelScopeInputs {
	/** The `--models` scope listed as rows; undefined lists the chat models of {@link roleModels}. */
	scoped: ReadonlyArray<Model> | undefined;
	/** Catalog configured role values resolve against. */
	allModels: ReadonlyArray<Model>;
	/** Available models of every kind unconfigured roles auto-select from. */
	roleModels: ReadonlyArray<Model>;
	error: string | undefined;
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function readScopeInputs(registry: ModelBrowserRegistry, scopedModels: ReadonlyArray<Model>): SessionModelScopeInputs {
	if (scopedModels.length > 0) {
		try {
			const pool = scopedRolePool(scopedModels, registry);
			return { scoped: scopedModels, allModels: pool, roleModels: pool, error: undefined };
		} catch (cause) {
			return { scoped: scopedModels, allModels: scopedModels, roleModels: scopedModels, error: errorText(cause) };
		}
	}
	const loadError = registry.getError();
	let error = loadError ? String(loadError) : undefined;
	let roleModels: ReadonlyArray<Model>;
	try {
		roleModels = registry.getAvailable("all");
	} catch (cause) {
		error = errorText(cause);
		roleModels = [];
	}
	return { scoped: undefined, allModels: registry.getAll("all"), roleModels, error };
}

function scopeFromInputs(settings: ModelBrowserSource, inputs: SessionModelScopeInputs): SessionModelScope {
	const roles = resolveRoleAssignments(settings, inputs.allModels, inputs.roleModels);
	const mruOrder = settings.mruOrder;
	const items = buildBrowserItems(inputs.scoped ?? inputs.roleModels.filter(model => modelKind(model) === "chat"));
	sortModelItems(items, { roles, mruOrder });
	return { items, roles, mruOrder, error: inputs.error };
}

/** Whether two lists hold the same elements (by identity), in order. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

/** The last scope built from one registry, with copies of every input it read. */
interface CachedSessionModelScope {
	preferences: object;
	revision: number;
	scoped: readonly Model[] | undefined;
	allModels: readonly Model[];
	roleModels: readonly Model[];
	error: string | undefined;
	mruOrder: readonly string[];
	scope: SessionModelScope;
}

const kSessionModelScope = Symbol("model-browser.sessionModelScope");

/** A registry tagged with the last scope built from it. */
interface ScopeTagged {
	[kSessionModelScope]?: CachedSessionModelScope;
}

/**
 * The session picker's model scope: chat models (or the `--models` scope) in
 * display order, with roles and MRU. The last scope per registry is reused
 * (shared by every caller: treat it as read-only) until the source's
 * preferences or revision, the MRU order, the scoped models, or the
 * registry's models or load error change.
 */
export function buildSessionModelScope(
	settings: ModelBrowserSource,
	registry: ModelBrowserRegistry,
	scopedModels: ReadonlyArray<Model>,
): SessionModelScope {
	const preferences = settings.preferences ?? settings;
	const revision = settings.revision;
	const inputs = readScopeInputs(registry, scopedModels);
	const mruOrder = settings.mruOrder;
	const tagged = registry as ModelBrowserRegistry & ScopeTagged;
	const cached = tagged[kSessionModelScope];
	if (
		cached &&
		cached.preferences === preferences &&
		cached.revision === revision &&
		cached.error === inputs.error &&
		(cached.scoped === undefined) === (inputs.scoped === undefined) &&
		(inputs.scoped === undefined || sameItems(cached.scoped!, inputs.scoped)) &&
		sameItems(cached.allModels, inputs.allModels) &&
		sameItems(cached.roleModels, inputs.roleModels) &&
		sameItems(cached.mruOrder, mruOrder)
	)
		return cached.scope;
	const scope = scopeFromInputs(settings, inputs);
	tagged[kSessionModelScope] = {
		preferences,
		revision,
		scoped: inputs.scoped && [...inputs.scoped],
		allModels: [...inputs.allModels],
		roleModels: [...inputs.roleModels],
		error: inputs.error,
		mruOrder: [...mruOrder],
		scope,
	};
	return scope;
}

// ─── Search ─────────────────────────────────────────────────────────────────

/** Lowercased without punctuation: exact and contiguous matches form stable relevance tiers. */
export function compactModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, "");
}

/** A `provider/model` search: the text before the first `/` prefixes a provider id, the rest searches its model ids. */
export interface ProviderScopedQuery {
	/** Typed provider prefix (trimmed, as typed). */
	provider: string;
	/** {@link provider} compacted, compared against compact provider ids. */
	providerKey: string;
	/** Model query after the slash; blank lists every model of the matched providers. */
	model: string;
}

/** Split a `provider/model` query; undefined when the text before the first `/` is blank or spans words. */
export function parseProviderScopedQuery(query: string): ProviderScopedQuery | undefined {
	const trimmed = query.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = trimmed.slice(0, slash);
	const providerKey = compactModelSearchText(provider);
	if (/\s/.test(provider) || !providerKey) return undefined;
	return { provider, providerKey, model: trimmed.slice(slash + 1) };
}

/** Provider rank under a scoped query: exact provider, provider prefix, outside the scope. */
const SCOPE_EXACT = 0;
const SCOPE_PREFIX = 1;
const SCOPE_NONE = 2;

/** How `compactProvider` relates to the compact typed provider prefix. */
function providerScope(compactPrefix: string, compactProvider: string): number {
	if (compactProvider === compactPrefix) return SCOPE_EXACT;
	return compactProvider.startsWith(compactPrefix) ? SCOPE_PREFIX : SCOPE_NONE;
}

/** Whether `provider` falls under a scoped query's provider prefix. */
export function inProviderScope(scoped: ProviderScopedQuery, provider: string): boolean {
	return providerScope(scoped.providerKey, compactModelSearchText(provider)) !== SCOPE_NONE;
}

/** Exact id/selector → contiguous literal → fuzzy-only. */
function searchTier(query: string, id: string, selector: string): number {
	if (!query) return 2;
	if (query === id || query === selector) return 0;
	if (id.includes(query) || selector.includes(query)) return 1;
	return 2;
}

/** The fuzzy haystack of a model row: `provider/id`, plus `free` for zero-cost models (the cost column's word). */
export function modelSearchText(item: ModelBrowserItem): string {
	return `${item.provider}/${modelIdSearchText(item)}`;
}

/** {@link modelSearchText} without the provider: what the model part of a `provider/model` query searches. */
function modelIdSearchText({ id, model }: ModelBrowserItem): string {
	return isFreeModel(model) ? `${id} free` : id;
}

/** Inputs to {@link ModelItemRanker}. */
export interface ModelRankOptions {
	roles: RoleAssignments;
	mruOrder: ReadonlyArray<string>;
	affinity: SearchAffinity;
}

/** Query-independent sort keys of one candidate. */
interface RankKeys {
	compactId: string;
	compactSelector: string;
	compactProvider: string;
	modelAffinity: number;
	providerAffinity: number;
	/** Position class in the MRU/version order; comparator-equal items share it. */
	orderGroup: number;
}

/** One candidate's sort keys for a single {@link ModelItemRanker.rank} call. */
interface RankRow {
	item: ModelBrowserItem;
	keys: RankKeys;
	scope: number;
	tier: number;
	/** Fuzzy score; lower is better. */
	score: number;
}

/**
 * Ranks one candidate list by query: the MRU/version order and affinity ranks
 * are computed once, so per-keystroke callers pay only the fuzzy scan.
 */
export class ModelItemRanker {
	readonly items: ReadonlyArray<ModelBrowserItem>;
	readonly options: ModelRankOptions;
	readonly #keys = new Map<ModelBrowserItem, RankKeys>();
	readonly #idTexts = new Map<ModelBrowserItem, FuzzyText>();

	constructor(items: ReadonlyArray<ModelBrowserItem>, options: ModelRankOptions) {
		this.items = items;
		this.options = options;
		const compare = modelItemComparator(items, {
			roles: options.roles,
			mruOrder: options.mruOrder,
			skipRoleRank: true,
		});
		const ordered = [...items].sort(compare);
		let group = 0;
		for (let i = 0; i < ordered.length; i++) {
			const item = ordered[i]!;
			if (i > 0 && compare(ordered[i - 1]!, item) !== 0) group++;
			this.#keys.set(item, {
				compactId: compactModelSearchText(item.id),
				compactSelector: compactModelSearchText(item.selector),
				compactProvider: compactModelSearchText(item.provider),
				modelAffinity: options.affinity.models.get(item.selector.toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
				providerAffinity: options.affinity.providers.get(item.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
				orderGroup: group,
			});
		}
	}

	/**
	 * Rank by text relevance, user affinity, and MRU/version order. A
	 * `provider/model` query lists the prefixed providers' models first,
	 * matched on the model part; whole-text matches follow.
	 */
	rank(query: string): ModelBrowserItem[] {
		if (!query.trim()) return [...this.items];
		const rows = new Map<ModelBrowserItem, RankRow>();
		const scoped = parseProviderScopedQuery(query);
		if (scoped) this.#rankScoped(scoped, rows);
		const queryKey = compactModelSearchText(query);
		for (const { item, score } of fuzzyRank(this.items, query, modelSearchText)) {
			if (rows.has(item)) continue;
			const keys = this.#keys.get(item)!;
			rows.set(item, {
				item,
				keys,
				scope: SCOPE_NONE,
				tier: searchTier(queryKey, keys.compactId, keys.compactSelector),
				score,
			});
		}
		return [...rows.values()]
			.sort(
				(a, b) =>
					a.scope - b.scope ||
					a.tier - b.tier ||
					a.keys.modelAffinity - b.keys.modelAffinity ||
					a.keys.providerAffinity - b.keys.providerAffinity ||
					Math.round(a.score / 10) - Math.round(b.score / 10) ||
					a.keys.orderGroup - b.keys.orderGroup ||
					a.score - b.score,
			)
			.map(row => row.item);
	}

	#rankScoped(scoped: ProviderScopedQuery, rows: Map<ModelBrowserItem, RankRow>): void {
		const modelKey = compactModelSearchText(scoped.model);
		const modelQuery = modelKey ? new FuzzyQuery(scoped.model) : undefined;
		for (const item of this.items) {
			const keys = this.#keys.get(item)!;
			const scope = providerScope(scoped.providerKey, keys.compactProvider);
			if (scope === SCOPE_NONE) continue;
			let score = 0;
			if (modelQuery) {
				let text = this.#idTexts.get(item);
				if (!text) {
					text = new FuzzyText(modelIdSearchText(item));
					this.#idTexts.set(item, text);
				}
				const match = text.match(modelQuery);
				if (!match.matches) continue;
				score = match.score;
			}
			rows.set(item, { item, keys, scope, tier: searchTier(modelKey, keys.compactId, keys.compactId), score });
		}
	}
}

/** Rank candidates by text relevance, user affinity, and MRU/version order. */
export function rankModelItems(
	query: string,
	items: ReadonlyArray<ModelBrowserItem>,
	options: ModelRankOptions,
): ModelBrowserItem[] {
	return new ModelItemRanker(items, options).rank(query);
}

/**
 * Hit ranges of `query` in `label`: each whitespace token marks its first
 * case-insensitive substring, else its characters as a greedy in-order
 * subsequence. Undefined when nothing matches.
 */
export function fuzzyHits(label: string, query: string): [number, number][] | undefined {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.filter(token => token.length > 0);
	if (tokens.length === 0) return undefined;
	const lower = label.toLowerCase();
	const marked = new Uint8Array(lower.length);
	for (const token of tokens) {
		const at = lower.indexOf(token);
		if (at >= 0) {
			marked.fill(1, at, at + token.length);
			continue;
		}
		let from = 0;
		for (const ch of token) {
			const index = lower.indexOf(ch, from);
			if (index < 0) break;
			marked[index] = 1;
			from = index + ch.length;
		}
	}
	const ranges: [number, number][] = [];
	for (let i = 0; i < marked.length; i++) {
		if (!marked[i]) continue;
		const start = i;
		while (i < marked.length && marked[i]) i++;
		ranges.push([start, i]);
	}
	return ranges.length > 0 ? ranges : undefined;
}

// ─── Facts ──────────────────────────────────────────────────────────────────

/** The non-rate pricing state a catalog rule declared for a zero-rate row; undefined when it publishes rates or declares nothing. */
function declaredPricingStatus(model: Model): Exclude<ModelPricingStatus, "fixed"> | undefined {
	if (model.pricingStatus === undefined) return undefined;
	const status = getModelPricingStatus(model);
	return status === "fixed" ? undefined : status;
}

/** No token price and no subscription-credit charge (unless a pricing state is declared). */
export function isFreeModel(model: Model): boolean {
	const declared = declaredPricingStatus(model);
	if (declared !== undefined) return declared === "free";
	const cost = model.cost ? getEffectiveTokenCost(model.cost) : undefined;
	const credits = getFactoryDroidCreditRate(model)?.rate;
	return (!cost || (cost.input === 0 && cost.output === 0)) && (credits === undefined || credits === 0);
}

/** One per-million price leg: `3`, `0.25`, `12.5`; `?` when unknown. */
export function formatCostLeg(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n > 0 && n < 0.01) return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
	const s = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
	return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** `2× from 2026-11-22` when a dated credit card changes the rate in force now. */
export function nextCreditRateNote(model: Model): string | undefined {
	const next = getFactoryDroidCreditRate(model)?.next;
	return next ? `${formatCostLeg(next.rate)}× from ${new Date(next.at).toISOString().slice(0, 10)}` : undefined;
}

/** A dollar price with the credit rate in force now (`$3/15 2×`); the badge alone without a dollar reference. */
function withCreditBadge(model: Model, price: string): string {
	const credits = getFactoryDroidCreditRate(model);
	if (credits === undefined) return price;
	const badge = `${formatCostLeg(credits.rate)}×`;
	const cost = getEffectiveTokenCost(model.cost);
	return cost.input !== 0 || cost.output !== 0 ? `${price} ${badge}` : badge;
}

const PRICING_LABELS: Record<Exclude<ModelPricingStatus, "fixed">, { short: string; detail: string }> = {
	free: { short: "free", detail: "free" },
	included: { short: "included", detail: "included" },
	variable: { short: "varies", detail: "price varies" },
	unknown: { short: "unknown", detail: "pricing unknown" },
};

/** The price in `sep`-joined legs (`$3/15`, `$3·15`); `free`; a declared pricing state. */
function priceWith(model: Model, sep: string): string {
	const declared = declaredPricingStatus(model);
	if (declared !== undefined) return PRICING_LABELS[declared].short;
	if (isFreeModel(model)) return "free";
	const cost = getEffectiveTokenCost(model.cost);
	return withCreditBadge(model, `$${formatCostLeg(cost.input)}${sep}${formatCostLeg(cost.output)}`);
}

/** `$3/15` per-million price column. */
export function formatCostPair(model: Model): string {
	return priceWith(model, "/");
}

/** `$3/15 per M`, or the declared pricing state in words. */
export function formatCostDetail(model: Model): string {
	const declared = declaredPricingStatus(model);
	return declared !== undefined ? PRICING_LABELS[declared].detail : `${formatCostPair(model)} per M`;
}

/**
 * When the price facts of `model` (its price, `free`, the credit badge) may
 * next change after `now`: the earliest later dated rate or credit card;
 * infinity when none is pending.
 */
export function nextPriceChange(model: Model, now: number): number {
	let next = Number.POSITIVE_INFINITY;
	for (const card of model.cost?.timeBased?.effectiveRates ?? [])
		if (card.effectiveFrom > now && card.effectiveFrom < next) next = card.effectiveFrom;
	for (const card of model.factoryDroidCreditCards ?? [])
		if (card.effectiveFrom > now && card.effectiveFrom < next) next = card.effectiveFrom;
	return next;
}

/** `$3·15` price fact of a picker row. */
export function pickerPrice(model: Model): string {
	return priceWith(model, "·");
}

/** `$2 in · $10 out · $0.2 cache` for a model preview. */
export function previewPrice(model: Model): string {
	const declared = declaredPricingStatus(model);
	if (declared !== undefined) return PRICING_LABELS[declared].detail;
	const cost = getEffectiveTokenCost(model.cost);
	const parts = [`$${formatCostLeg(cost.input)} in`, `$${formatCostLeg(cost.output)} out`];
	if (cost.cacheRead > 0) parts.push(`$${formatCostLeg(cost.cacheRead)} cache`);
	const priced = withCreditBadge(model, parts.join(" · "));
	const note = nextCreditRateNote(model);
	return note ? `${priced} (${note})` : priced;
}

/** Fact columns of a model picker; the lowest priority hides first. */
export const MODEL_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "int", head: "Int", format: "num", priority: 4 },
	{ id: "speed", head: "t/s", format: "num", priority: 3 },
	{ id: "ctx", head: "Ctx", format: "num", priority: 1 },
	{ id: "price", head: "$/M", format: "price", priority: 2 },
];

/** {@link providerMark} texts by provider id (a few dozen providers). */
const markTexts = new Map<string, string>();

/** A provider's picker mark: the terminal's logo, else its initials (`amazon-bedrock` → `AB`, `anthropic` → `An`). */
export function providerMark(providerId: string): TspPickerMark {
	let text = markTexts.get(providerId);
	if (text === undefined) {
		const words = providerId.split(/[-_\s.]+/).filter(word => word.length > 0);
		const word = words[0] ?? providerId;
		text =
			words.length >= 2
				? `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase()
				: `${word.charAt(0).toUpperCase()}${word.charAt(1)}`;
		markTexts.set(providerId, text);
	}
	return { text, seed: providerId, icon: `provider:${providerId}` };
}

/** The theme token of a thinking level's dot (`thinkingHigh`); none for inherit and auto. */
export function thinkingDotToken(level: ConfiguredThinkingLevel): string | undefined {
	if (level === ThinkingLevel.Inherit || level === AUTO_THINKING) return undefined;
	return `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

/**
 * Measured perf of a row: the tier the host would send, else the standard
 * aggregate, else the fastest measured tier. `tier` is set whenever the
 * numbers come from a tier aggregate.
 */
export function measuredPerf(
	perf: ReadonlyMap<string, ModelBrowserPerf>,
	item: ModelBrowserItem,
	serviceTier: string | undefined,
	tiers?: TieredPerf,
): { perf: ModelBrowserPerf; tier?: string } | undefined {
	if (perf.size === 0) return undefined;
	if (serviceTier) {
		const tiered = perf.get(`${item.selector}@${serviceTier}`);
		if (tiered) return { perf: tiered, tier: serviceTier };
	}
	const standard = perf.get(item.selector);
	if (standard) return { perf: standard };
	const best = (tiers ?? tieredPerf(perf)).get(item.selector);
	return best && { perf: best.perf, tier: best.tier };
}

/** Whether `selector` has measured tier aggregates (`selector@tier`): only then does the service tier pick its perf. */
export function hasTieredPerf(perf: ReadonlyMap<string, ModelBrowserPerf>, selector: string): boolean {
	return perf.size > 0 && tieredPerf(perf).has(selector);
}

const kTierIndex = Symbol("model-browser.tierIndex");

/** A perf map tagged with its {@link tieredPerf} index and the size it was built at. */
interface TierIndexed {
	[kTierIndex]?: { size: number; best: Map<string, { perf: ModelBrowserPerf; tier: string }> };
}

/** The fastest `selector@tier` aggregate per selector of one perf map (see {@link tieredPerf}). */
export type TieredPerf = ReadonlyMap<string, { perf: ModelBrowserPerf; tier: string }>;

/**
 * The fastest `selector@tier` aggregate per selector (the first of equals), for
 * every `@` a key could split at. Pass it to {@link measuredPerf} when looking
 * up many rows of one perf map.
 */
export function tieredPerf(perf: ReadonlyMap<string, ModelBrowserPerf>): TieredPerf {
	const tagged = perf as ReadonlyMap<string, ModelBrowserPerf> & TierIndexed;
	const indexed = tagged[kTierIndex];
	if (indexed && indexed.size === perf.size) return indexed.best;
	const best = new Map<string, { perf: ModelBrowserPerf; tier: string }>();
	for (const [key, entry] of perf) {
		for (let at = key.indexOf("@"); at >= 0; at = key.indexOf("@", at + 1)) {
			const selector = key.slice(0, at);
			const current = best.get(selector);
			if (!current || entry.tps > current.perf.tps) best.set(selector, { perf: entry, tier: key.slice(at + 1) });
		}
	}
	tagged[kTierIndex] = { size: perf.size, best };
	return best;
}
