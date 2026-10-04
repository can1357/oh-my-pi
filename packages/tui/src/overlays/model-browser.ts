/**
 * Frameless, reusable model browser: a fuzzy search row, a windowed model
 * list with role chips and metadata columns, and a selection detail block.
 *
 * Hosts own the surrounding chrome and the data scope — the fullscreen
 * /models hub ({@link ./model-hub}) feeds it scope-filtered items plus role
 * state, while the advisor config overlay embeds it as a plain "pick one
 * model" list.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getModelPricingStatus, modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ModelKind, ModelPricingStatus } from "@oh-my-pi/pi-catalog/types";
import type { Component } from "../tui";
import { fuzzyRank } from "../fuzzy";
import { Input } from "../components/input";
import { ScrollView } from "../components/scroll-view";
import { matchesKey } from "../keys";
import type { SgrMouseEvent } from "../mouse";
import { replaceTabs, truncateToWidth, visibleWidth } from "../utils";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	getConfiguredThinkingLevelMetadata,
	parseConfiguredThinkingLevel,
} from "../thinking";
import { thinkingLevelGlyph } from "../render/render-utils";
import { type ThemeColor, theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { MenuSelection } from "../components/menu-selection";
import { clampScrollOffset, scrollOffsetForRow } from "../components/scroll-viewport";
import type { TspPickerColumn, TspPickerGroup, TspPickerItem, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { col, md, node, row, span, text } from "../native/describe";
import { pickerFuzzyHits } from "../native/picker";
import type { NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { sameItems } from "../native/memo";
import { plainText } from "../native/spans";

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
];
export const KIND_ROLE_IDS: ModelRole[] = ["image", "web", "speech", "dictation", "judge"];

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
	color?: ThemeColor;
	hidden?: boolean;
	section: "chat" | "kind";
	accepts(model: Model): boolean;
}

/** Role lookup used for scoped model resolution. */
export interface ModelRoleLookup {
	getModelRole(role: string): string | undefined;
}

/** Resolved selector metadata required by model overlays. */
export interface ResolvedModelRoleValue {
	model: Model | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning?: string;
}

/** Host-provided preferences and model-role resolution for the browser. */
export interface ModelBrowserSource extends ModelRoleLookup {
	/**
	 * Changes whenever any preference this source reads or resolves against changes,
	 * except the storage-backed `mruOrder` and `modelPerf`. Keys derived-scope caches.
	 */
	readonly revision: number;
	readonly defaultThinkingLevel: string;
	readonly modelProviderOrder: readonly string[];
	readonly knownRoleIds: readonly string[];
	readonly mruOrder: readonly string[];
	readonly modelPerf: ReadonlyMap<string, ModelBrowserPerf>;
	getRoleInfo(role: string): ModelBrowserRoleInfo;
	defaultRoleChain(role: string): string[];
	resolveRoleValue(value: string | undefined, models: Model[], roleLookup?: ModelRoleLookup): ResolvedModelRoleValue;
}

/** Read-only catalog surface consumed by model browsers. */
export interface ModelBrowserRegistry {
	getError(): unknown;
	getAvailable(kind?: ModelKind | "all"): Model[];
	getAll(kind?: ModelKind | "all"): Model[];
}

/** One selectable row. `selector` is a canonical model key or host-specific virtual key. */
export interface ModelBrowserItem {
	provider: string;
	id: string;
	model: Model;
	selector: string;
	/** Optional foreground color for the row label. */
	labelColor?: ThemeColor;
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

/**
 * Resolve every known role to its display assignment: configured role values
 * resolve against `allModels`; unconfigured roles fall back to auto-selection
 * over `autoCandidates` (skipped when empty). Shared by the /models hub and
 * the alt+p session picker.
 */
export function resolveRoleAssignments(
	settings: ModelBrowserSource,
	allModels: ReadonlyArray<Model>,
	autoCandidates: ReadonlyArray<Model>,
): RoleAssignments {
	const resolvedThinkingLevel = (
		role: string,
		resolved: { explicitThinkingLevel: boolean; thinkingLevel?: ConfiguredThinkingLevel },
	): ConfiguredThinkingLevel => {
		if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) {
			return resolved.thinkingLevel;
		}
		if (role === "default") {
			return parseConfiguredThinkingLevel(settings.defaultThinkingLevel) ?? ThinkingLevel.Inherit;
		}
		return ThinkingLevel.Inherit;
	};

	// Roles sharing an `accepts` predicate share one filtered array, so the
	// resolver's array-keyed indexes are built once per pool, not once per role.
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
	const knownRoles = settings.knownRoleIds;
	const configuredRoles = new Set<string>();
	const catalogByAccepts = new Map<ModelBrowserRoleInfo["accepts"], Model[]>();

	for (const role of knownRoles) {
		const roleValue = settings.getModelRole(role);
		if (!roleValue) continue;
		configuredRoles.add(role);
		const resolved = settings.resolveRoleValue(roleValue, eligible(allModels, catalogByAccepts, role));
		if (resolved.model) {
			roles[role] = {
				model: resolved.model,
				thinkingLevel: resolvedThinkingLevel(role, resolved),
				autoSelected: false,
			};
		}
	}

	if (autoCandidates.length > 0) {
		const candidatesByAccepts = new Map<ModelBrowserRoleInfo["accepts"], Model[]>();
		for (const role of knownRoles) {
			if (configuredRoles.has(role)) continue;
			const resolved = settings.resolveRoleValue(`pi/${role}`, eligible(autoCandidates, candidatesByAccepts, role));
			if (!resolved.model) continue;
			roles[role] = {
				model: resolved.model,
				thinkingLevel: resolvedThinkingLevel(role, resolved),
				autoSelected: true,
			};
		}
	}

	return roles;
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

/** Extract the first version number from a model ID (e.g. "gemini-2.5-pro" → 2.5, "claude-sonnet-4-6" → 4.6). */
function extractVersionNumber(id: string): number {
	// Dot-separated version: "gemini-2.5-pro" → 2.5
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]);
	// Dash-separated short segments: "claude-sonnet-4-6" → 4.6, "llama-3-1-8b" → 3.1
	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
	// Single number after separator: "gpt-4o" → 4
	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]);
	return 0;
}

/** Rank a model by the first built-in role it is assigned to (lower = earlier role). */
function computeModelRank(model: Model, roles: RoleAssignments): number {
	let i = 0;
	while (i < MODEL_ROLE_IDS.length) {
		const assigned = roles[MODEL_ROLE_IDS[i]];
		if (assigned && modelsAreEqual(assigned.model, model)) {
			break;
		}
		i++;
	}
	return i;
}

/** Options for {@link sortModelItems}. */
export interface SortModelItemsOptions {
	roles?: RoleAssignments;
	mruOrder?: ReadonlyArray<string>;
	/**
	 * When a search query is narrowing the list, role assignments should NOT
	 * promote a weakly-matching default model above a perfect text match —
	 * defer to MRU/version instead so user affinity drives the order.
	 */
	skipRoleRank?: boolean;
}

/**
 * Order models for display: role-assigned first, then most-recently-used,
 * then per provider by priority, version, and recency.
 */
export function sortModelItems(items: ModelBrowserItem[], options: SortModelItemsOptions = {}): void {
	const { roles = {}, mruOrder = [], skipRoleRank = false } = options;
	const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

	const dateRe = /-(\d{8})$/;
	const latestRe = /-latest$/;

	items.sort((a, b) => {
		if (!skipRoleRank) {
			const aRank = computeModelRank(a.model, roles);
			const bRank = computeModelRank(b.model, roles);
			if (aRank !== bRank) return aRank - bRank;
		}

		// Then MRU order (models in mruIndex come before those not in it)
		const aMru = mruIndex.get(a.selector) ?? Number.MAX_SAFE_INTEGER;
		const bMru = mruIndex.get(b.selector) ?? Number.MAX_SAFE_INTEGER;
		if (aMru !== bMru) return aMru - bMru;

		// By provider, then recency within provider
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;

		// Priority field (lower = better, e.g. Codex priority values)
		const aPri = a.model.priority ?? Number.MAX_SAFE_INTEGER;
		const bPri = b.model.priority ?? Number.MAX_SAFE_INTEGER;
		if (aPri !== bPri) return aPri - bPri;

		// Version number descending (higher version = better model)
		const aVer = extractVersionNumber(a.id);
		const bVer = extractVersionNumber(b.id);
		if (aVer !== bVer) return bVer - aVer;

		const aIsLatest = latestRe.test(a.id);
		const bIsLatest = latestRe.test(b.id);
		const aDate = a.id.match(dateRe)?.[1] ?? "";
		const bDate = b.id.match(dateRe)?.[1] ?? "";

		// Models with recency info come before those without
		const aHasRecency = aIsLatest || aDate !== "";
		const bHasRecency = bIsLatest || bDate !== "";
		if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;

		// If neither has recency info, fall back to alphabetical
		if (!aHasRecency) return a.id.localeCompare(b.id);

		// -latest always sorts first within recency group
		if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;

		// Both have dates — descending (newest first)
		if (aDate && bDate) return bDate.localeCompare(aDate);

		// One has date, other is latest — latest first
		return aIsLatest ? -1 : bIsLatest ? 1 : a.id.localeCompare(b.id);
	});
}

/** Picker candidates and ordering inputs shared with composer model mentions. */
export interface SessionModelScope {
	items: ModelBrowserItem[];
	roles: RoleAssignments;
	mruOrder: ReadonlyArray<string>;
	error: string | undefined;
}

/** Catalog inputs a {@link SessionModelScope} is derived from. */
interface SessionModelScopeInputs {
	models: ReadonlyArray<Model>;
	allModels: ReadonlyArray<Model>;
	error: string | undefined;
}

function readSessionModelScopeInputs(
	registry: ModelBrowserRegistry,
	scopedModels: ReadonlyArray<Model>,
): SessionModelScopeInputs {
	if (scopedModels.length > 0) return { models: scopedModels, allModels: scopedModels, error: undefined };
	const loadError = registry.getError();
	let error = loadError ? String(loadError) : undefined;
	let models: ReadonlyArray<Model>;
	try {
		models = registry.getAvailable();
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
		models = [];
	}
	return { models, allModels: registry.getAll("all"), error };
}

function scopeFromInputs(settings: ModelBrowserSource, inputs: SessionModelScopeInputs): SessionModelScope {
	const roles = resolveRoleAssignments(settings, inputs.allModels, inputs.models);
	const mruOrder = settings.mruOrder;
	const items = buildBrowserItems(inputs.models);
	sortModelItems(items, { roles, mruOrder });
	return { items, roles, mruOrder, error: inputs.error };
}

/** Build the session picker's current scope without creating an interactive browser. */
export function buildSessionModelScope(
	settings: ModelBrowserSource,
	registry: ModelBrowserRegistry,
	scopedModels: ReadonlyArray<Model>,
): SessionModelScope {
	return scopeFromInputs(settings, readSessionModelScopeInputs(registry, scopedModels));
}

/**
 * {@link buildSessionModelScope} for per-keystroke callers: returns the same
 * scope until the source revision, MRU order, scoped models, or the registry's
 * available models, catalog, or load error change.
 */
export class SessionModelScopeCache {
	#settings: ModelBrowserSource;
	#registry: ModelBrowserRegistry;
	#revision = 0;
	#inputs: SessionModelScopeInputs | undefined;
	#scope: SessionModelScope | undefined;

	constructor(settings: ModelBrowserSource, registry: ModelBrowserRegistry) {
		this.#settings = settings;
		this.#registry = registry;
	}

	get(scopedModels: ReadonlyArray<Model>): SessionModelScope {
		const revision = this.#settings.revision;
		const inputs = readSessionModelScopeInputs(this.#registry, scopedModels);
		const cachedInputs = this.#inputs;
		const cached = this.#scope;
		if (
			cached &&
			cachedInputs &&
			revision === this.#revision &&
			inputs.error === cachedInputs.error &&
			sameItems(inputs.models, cachedInputs.models) &&
			sameItems(inputs.allModels, cachedInputs.allModels) &&
			sameItems(this.#settings.mruOrder, cached.mruOrder)
		) {
			return cached;
		}
		const scope = scopeFromInputs(this.#settings, inputs);
		this.#revision = revision;
		this.#inputs = inputs;
		this.#scope = scope;
		return scope;
	}
}

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

/** Collapse punctuation so exact and contiguous model-name matches form stable relevance tiers. */
function compactModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, "");
}

/** Exact id/selector → contiguous literal → fuzzy-only. */
function modelSearchTier(query: string, item: ModelBrowserItem): number {
	if (!query) return 2;
	const id = compactModelSearchText(item.id);
	const selector = compactModelSearchText(item.selector);
	if (query === id || query === selector) return 0;
	if (id.includes(query) || selector.includes(query)) return 1;
	return 2;
}

/** Rank picker and mention candidates by text relevance, user affinity, and MRU/version order. */
export function rankModelItems(
	query: string,
	items: ReadonlyArray<ModelBrowserItem>,
	options: { roles: RoleAssignments; mruOrder: ReadonlyArray<string>; affinity: SearchAffinity },
): ModelBrowserItem[] {
	if (!query.trim()) return [...items];
	const ranked = fuzzyRank(items, query, modelSearchText);
	const matches = ranked.map(result => result.item);
	// Exact and contiguous matches stay ahead of fuzzy-only candidates; affinity
	// breaks ties before fuzzy quality and the normal MRU/version ordering.
	sortModelItems(matches, { roles: options.roles, mruOrder: options.mruOrder, skipRoleRank: true });
	const fallbackRanks = new Map(matches.map((item, index) => [item, index]));
	const queryKey = compactModelSearchText(query);
	const searchRanks = new Map<ModelBrowserItem, { tier: number; bucket: number }>();
	for (const result of ranked) {
		searchRanks.set(result.item, {
			tier: modelSearchTier(queryKey, result.item),
			bucket: Math.round(result.score / 10),
		});
	}
	matches.sort((a, b) => {
		const aSearch = searchRanks.get(a);
		const bSearch = searchRanks.get(b);
		const tierCmp = (aSearch?.tier ?? Number.MAX_SAFE_INTEGER) - (bSearch?.tier ?? Number.MAX_SAFE_INTEGER);
		if (tierCmp !== 0) return tierCmp;

		const modelCmp =
			(options.affinity.models.get(a.selector.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
			(options.affinity.models.get(b.selector.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
		if (modelCmp !== 0) return modelCmp;

		const providerCmp =
			(options.affinity.providers.get(a.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
			(options.affinity.providers.get(b.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
		if (providerCmp !== 0) return providerCmp;

		const bucketCmp = (aSearch?.bucket ?? Number.MAX_SAFE_INTEGER) - (bSearch?.bucket ?? Number.MAX_SAFE_INTEGER);
		if (bucketCmp !== 0) return bucketCmp;
		return (fallbackRanks.get(a) ?? Number.MAX_SAFE_INTEGER) - (fallbackRanks.get(b) ?? Number.MAX_SAFE_INTEGER);
	});
	return matches;
}

/**
 * A slim role chip: `● default ◉` — solid dot for configured assignments,
 * hollow for auto-selected fallbacks, thinking glyph attached when set.
 *
 * The space after the status glyph is load-bearing. Under the `nerd` preset
 * these are Nerd Font private-use icons (U+F111 / U+F10C) whose glyphs are
 * drawn two cells wide, while `visibleWidth` counts them as one
 * (`ambiguousIsNarrow: true` in tui/utils.ts — the PUA block is
 * East_Asian_Width=Ambiguous). Without a separator the icon overhangs and
 * eats the label's first character (`● default` renders as `●efault`).
 * Mirrors the spacing already used for `status.success` in model-hub.
 */
export function formatRoleChip(role: string, assignment: RoleAssignment, settings: ModelBrowserSource): string {
	const info = settings.getRoleInfo(role);
	const label = (info.tag ?? info.name ?? role).toLowerCase();
	const glyph = thinkingLevelGlyph(assignment.thinkingLevel, theme);
	const suffix = glyph ? ` ${theme.fg("dim", glyph)}` : "";
	if (assignment.autoSelected) {
		return theme.fg("dim", `${theme.status.shadowed} ${label}`) + suffix;
	}
	return theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) + suffix;
}

/** {@link formatRoleChip} as styled spans for a described node. */
function roleChipSpans(role: string, assignment: RoleAssignment, settings: ModelBrowserSource): TspSpan[] {
	const info = settings.getRoleInfo(role);
	const label = (info.tag ?? info.name ?? role).toLowerCase();
	const glyph = thinkingLevelGlyph(assignment.thinkingLevel, theme);
	const spans = assignment.autoSelected
		? [span(`${theme.status.shadowed} ${label}`, "dim")]
		: [span(`${theme.status.enabled} ${label}`, info.color ?? "muted")];
	if (glyph) spans.push(span(` ${glyph}`, "dim"));
	return spans;
}

/**
 * The non-rate pricing state a catalog rule declared for a zero-rate row
 * (`pricing-status`), or `undefined` when the row publishes rates or declares
 * nothing. Undeclared zero-rate rows keep the `free` convention below.
 */
function declaredPricingStatus(model: Model): Exclude<ModelPricingStatus, "fixed"> | undefined {
	if (model.pricingStatus === undefined) return undefined;
	const status = getModelPricingStatus(model);
	return status === "fixed" ? undefined : status;
}
/** No token price and no subscription-credit charge (unless a pricing state is declared). */
function isFreeModel(model: Model): boolean {
	const declared = declaredPricingStatus(model);
	if (declared !== undefined) return declared === "free";
	const cost = model.cost;
	const credits = model.factoryDroidCredits;
	return (!cost || (cost.input === 0 && cost.output === 0)) && (credits === undefined || credits === 0);
}

/** One per-million price leg: `3`, `0.25`, `12.5`; `?` when unknown. */
function formatCostLeg(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n > 0 && n < 0.01) {
		return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
	}
	const s = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
	return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Adds Factory Droid's `N×` base Standard Credits rate to a dollar price,
 * replacing the price when the model has no dollar reference. Neither the
 * reference price nor the base credit rate includes live promotions.
 */
function withCreditBadge(model: Model, price: string): string {
	const credits = model.factoryDroidCredits;
	if (credits === undefined) return price;
	const badge = `${formatCostLeg(credits)}×`;
	return model.cost.input !== 0 || model.cost.output !== 0 ? `${price} ${badge}` : badge;
}

const PRICING_STATUS_LABELS: Record<Exclude<ModelPricingStatus, "fixed">, { short: string; detail: string }> = {
	free: { short: "free", detail: "free" },
	included: { short: "included", detail: "included" },
	variable: { short: "varies", detail: "price varies" },
	unknown: { short: "unknown", detail: "pricing unknown" },
};

/** `$in/out` per-million cost pair with any credit badge; `free` when nothing is charged; a declared pricing state otherwise. */
function formatCostPair(model: Model): string {
	const declared = declaredPricingStatus(model);
	if (declared !== undefined) return PRICING_STATUS_LABELS[declared].short;
	if (isFreeModel(model)) return "free";
	return withCreditBadge(model, `$${formatCostLeg(model.cost.input)}/${formatCostLeg(model.cost.output)}`);
}

/** Detail-pane price fact: `$3/15 per M`, or the declared pricing state in words. */
function formatCostDetail(model: Model): string {
	const declared = declaredPricingStatus(model);
	return declared !== undefined ? PRICING_STATUS_LABELS[declared].detail : `${formatCostPair(model)} per M`;
}

/** Fact columns of a model picker (Stencil `NATIVE_REDESIGN.md` §4.7); the lowest priority hides first. */
export const MODEL_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "int", head: "Int", format: "num", priority: 1 },
	{ id: "speed", head: "t/s", format: "num", priority: 2 },
	{ id: "ctx", head: "Ctx", format: "num", priority: 4 },
	{ id: "price", head: "$/M", format: "price", priority: 3 },
];

/** `$3·15` price fact of a picker row; `free` at zero cost; a declared pricing state otherwise. */
function pickerPrice(model: Model): string {
	const declared = declaredPricingStatus(model);
	if (declared !== undefined) return PRICING_STATUS_LABELS[declared].short;
	if (isFreeModel(model)) return "free";
	return withCreditBadge(model, `$${formatCostLeg(model.cost.input)}·${formatCostLeg(model.cost.output)}`);
}

/** `$2 in · $10 out · $0.2 cache` for a model preview. */
function previewPrice(model: Model): string {
	const declared = declaredPricingStatus(model);
	if (declared !== undefined) return PRICING_STATUS_LABELS[declared].detail;
	const cost = model.cost;
	const parts = [`$${formatCostLeg(cost.input)} in`, `$${formatCostLeg(cost.output)} out`];
	if (cost.cacheRead > 0) parts.push(`$${formatCostLeg(cost.cacheRead)} cache`);
	return withCreditBadge(model, parts.join(" · "));
}

/** The omp theme token of a thinking level's dot (`thinkingHigh`); none for inherit and auto. */
export function thinkingDotToken(level: ConfiguredThinkingLevel): string | undefined {
	if (level === ThinkingLevel.Inherit || level === AUTO_THINKING) return undefined;
	return `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

/**
 * The fuzzy haystack for a model row: the displayed `provider/id`, plus `free`
 * for zero-cost models so the cost column's own word is searchable even when
 * the id never says it (openrouter suffixes `:free`; nvidia does not).
 *
 * Must stay a pure function of the item — never of the query. `fuzzyRank`
 * caches match indices keyed on this string and stops admitting new entries
 * past its cap, so a query-dependent haystack would thrash that cache.
 */
export function modelSearchText({ provider, id, model }: ModelBrowserItem): string {
	const base = `${provider}/${id}`;
	return isFreeModel(model) ? `${base} free` : base;
}

/** Provider-supplied blurb, flattened to a single renderable detail-line cell. */
function formatDescription(description: string): string {
	return replaceTabs(sanitizeText(description))
		.replace(/[\r\n]+/g, " ")
		.trim();
}

/**
 * `400k ◫` context-window column; empty when the model does not report one.
 * The icon trails the number so right-alignment pins it to a fixed column
 * instead of drifting with the number's width. The ascii preset's `ctx:`
 * label is a prefix form — strip the colon for suffix placement.
 */
function formatContext(model: Model): string {
	const ctx = model.contextWindow ?? 0;
	if (ctx <= 0) return "";
	return `${formatNumber(ctx).toLowerCase()} ${theme.icon.context.replace(/:$/, "")}`;
}

/** `118t/s` average output speed; one decimal below 10 t/s. */
function formatTps(tps: number): string {
	const value = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
	return `${value}t/s`;
}

/** Brain-icon intelligence score delivered with the model catalog. */
function formatIntelligence(model: Model): string {
	if (model.int == null || !Number.isFinite(model.int)) return "";
	return `${theme.symbol("icon.intelligence")} ${Math.round(model.int)}`;
}

/** `0.9s` average time-to-first-token; whole seconds from 10s up. */
function formatTtft(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

/** Pad `text` on the left to `width` terminal columns (ANSI/emoji aware). */
function padLeftVisible(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? " ".repeat(missing) + text : text;
}

/** A model browser's visible rows as picker `order` plus the query's hit ranges. */
export interface ModelPickerOrder {
	readonly order: readonly (string | TspPickerGroup)[];
	readonly hits: Readonly<Record<string, readonly (readonly [number, number])[]>> | undefined;
	/** Selectable rows in `order`. */
	readonly count: number;
}

/**
 * A model picker's catalogue props: `items` as last sent whole, plus the
 * rows changed or added since (`itemsAdd`) and the ids gone (`itemsDel`), so
 * a discovery refresh that touches a few rows does not resend a thousand.
 */
export interface ModelPickerCatalogue {
	readonly items: readonly TspPickerItem[];
	readonly itemsAdd?: readonly TspPickerItem[];
	readonly itemsDel?: readonly string[];
}

/** How {@link ModelBrowser.pickerOrder} heads its rows. */
export interface ModelPickerGrouping {
	/** One group per provider after the Recent block (the unfiltered All models view). */
	readonly providers: boolean;
	/** Label of the rows after the Recent block when they are not split by provider; null drops every head. */
	readonly rest: string | null;
}

/** Behavior switches for {@link ModelBrowser}. */
export interface ModelBrowserOptions {
	/** Render the dim `provider/` prefix before model ids. Default true. */
	showProvider?: boolean;
	/** Session token count used to flag models whose context window is exceeded. */
	currentContextTokens?: number;
	/** When true, over-context rows render grayed; picking one compacts first (session-switch mode). */
	markOverContext?: boolean;
	/** Host-provided empty-state text (e.g. provider discovery status). */
	emptyText?: () => string | undefined;
}

/** Rendered rows before the list window: search row + blank. */
const LIST_ROW_START = 2;
/** Rendered rows after the list window: blank + two detail rows. */
const DETAIL_ROWS = 3;
/** Row width from which the measured-perf column appears (TPS only). */
const PERF_TPS_MIN_WIDTH = 76;
/** Row width from which the perf column also includes TTFT. */
const PERF_FULL_MIN_WIDTH = 96;
/** Narrowest model-name cell retained before cost and context are dropped. */
const MIN_NAME_WIDTH = 16;

/** Total width of present metadata columns, joined by two-space gaps. */
function metaColumnsWidth(widths: readonly number[]): number {
	let total = 0;
	let count = 0;
	for (const width of widths) {
		if (width <= 0) continue;
		total += width;
		count++;
	}
	return count > 0 ? total + 2 * (count - 1) : 0;
}

/** What the per-row perf column shows at the current width. */
type PerfMode = "off" | "tps" | "full";

/**
 * The reusable browser component. Renders a fixed-height block
 * (`maxVisible + LIST_ROW_START + DETAIL_ROWS` rows) so host mouse geometry
 * stays stable across renders.
 */
export class ModelBrowser implements Component {
	#settings: ModelBrowserSource;
	#searchInput = new Input();
	#menu = new MenuSelection<ModelBrowserItem>([], {
		getKey: item => item.selector,
		getSearchText: modelSearchText,
		isDisabled: item => item.id === "separator",
		filter: (items, query) => this.#filterItems(items, query),
	});
	#roles: RoleAssignments = {};
	#mruOrder: ReadonlyArray<string> = [];
	#affinity: SearchAffinity = { models: new Map(), providers: new Map() };
	#perf: ReadonlyMap<string, ModelBrowserPerf> = new Map();
	#hoveredIndex: number | null = null;
	#maxVisible = 10;
	#showProvider: boolean;
	#currentContextTokens: number;
	#markOverContext: boolean;
	#emptyText?: () => string | undefined;
	/** Keep role-like virtual rows in their host-defined order during search. */
	#preserveQueryOrder = false;
	/** First visible list row; panned by the wheel, snapped to the selection on keyboard navigation. */
	#windowStart = 0;
	#windowCount = 0;
	/** Whether the host pane owns arrow keys; drives cursor strength and the selected-row band. */
	#focused = true;
	/** `provider/id` of the session's active model; marked in rows and detail. */
	#currentSelector: string | undefined;
	/**
	 * Bumped whenever a per-row or detail input (provider prefix, current mark,
	 * over-context flagging, perf) changes; described nodes rebuild on a new epoch.
	 */
	#nativeEpoch = 0;
	/** Described item nodes by selector, valid for {@link #nativeEpoch} and the same item object. */
	#itemNodes = new Map<string, { item: ModelBrowserItem; node: NativeNode }>();
	#nativeSearch: NativeNode | undefined;
	#nativeList: { items: readonly ModelBrowserItem[]; epoch: number; children: NativeChild[] } | undefined;
	#nativeListNode:
		| { children: NativeChild[]; selected: string | null; filter: string; empty: string; node: NativeNode }
		| undefined;
	#nativeDetail:
		| { item: ModelBrowserItem | undefined; epoch: number; roles: RoleAssignments; node: NativeNode }
		| undefined;
	#nativeRoot: { list: NativeNode; detail: NativeNode; node: NativeNode } | undefined;
	/** Bumped when a picker row input other than roles changes (perf, over-context flagging). */
	#pickerEpoch = 0;
	/** Picker rows by selector, reused while the model and the roles it holds are unchanged. */
	#pickerItemCache = new Map<
		string,
		{ model: Model; label: string; held: string; epoch: number; value: TspPickerItem }
	>();
	#pickerItems:
		| {
				catalogue: readonly ModelBrowserItem[];
				epoch: number;
				roles: RoleAssignments;
				value: ModelPickerCatalogue;
		  }
		| undefined;
	/** The rows last sent as a whole `items`; later catalogues patch it. */
	#pickerBase: readonly TspPickerItem[] | undefined;
	/**
	 * Ids patched since {@link #pickerBase} went out. The terminal keeps
	 * applied patches, so a row that returns to its base value is still sent.
	 */
	#pickerPatched = new Set<string>();
	#pickerOrder: { visible: readonly ModelBrowserItem[]; key: string; value: ModelPickerOrder } | undefined;
	#pickerPreview:
		| {
				item: ModelBrowserItem | undefined;
				epoch: number;
				roles: RoleAssignments;
				key: string;
				children: readonly NativeChild[];
		  }
		| undefined;

	/** Enter or click-on-selected. */
	onActivate?: (item: ModelBrowserItem) => void;
	onSelectionChange?: (item: ModelBrowserItem | undefined) => void;
	onQueryChange?: (query: string) => void;
	/** Cancel key with an empty query (a non-empty query is cleared first). */
	onCancel?: () => void;

	constructor(settings: ModelBrowserSource, options: ModelBrowserOptions = {}) {
		this.#settings = settings;
		this.#showProvider = options.showProvider ?? true;
		const tokens = options.currentContextTokens ?? 0;
		this.#currentContextTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
		this.#markOverContext = options.markOverContext ?? false;
		this.#emptyText = options.emptyText;
		this.#syncAffinity();
	}

	/** Mark `selector` as the session's active model (undefined clears the mark). */
	setCurrentSelector(selector: string | undefined): void {
		if (selector !== this.#currentSelector) this.#bumpNativeEpoch();
		this.#currentSelector = selector;
	}

	/** Replace the scope's base items; the live query re-applies and selection is pinned by selector. */
	setItems(items: ModelBrowserItem[]): void {
		const selectedKey = this.getSelected()?.selector;
		this.#menu.setItems(this.#insertSeparator(items), selectedKey);
		this.onSelectionChange?.(this.getSelected());
		if (selectedKey) {
			this.selectSelector(selectedKey);
		}
	}

	setRoles(roles: RoleAssignments): void {
		this.#roles = roles;
		this.#syncAffinity();
	}

	setMruOrder(order: ReadonlyArray<string>): void {
		this.#mruOrder = order;
		this.#syncAffinity();
	}

	#syncAffinity(): void {
		this.#affinity = buildSearchAffinity(this.#settings.modelProviderOrder, this.#roles, this.#mruOrder);
	}

	/** Measured TPS/TTFT averages keyed by `provider/id` selector (see AgentStorage.getModelPerf). */
	setPerfStats(perf: ReadonlyMap<string, ModelBrowserPerf>): void {
		if (perf !== this.#perf) this.#bumpPickerEpoch();
		this.#perf = perf;
	}

	setMaxVisible(rows: number): void {
		// No selection snap here: hosts call this on every render, and it must
		// not undo wheel panning. render() re-clamps the window.
		this.#maxVisible = Math.max(1, rows);
	}

	setShowProvider(show: boolean): void {
		if (show !== this.#showProvider) this.#bumpNativeEpoch();
		this.#showProvider = show;
	}
	/** Keep the source order after fuzzy filtering instead of applying model-specific ranking. */
	setPreserveQueryOrder(preserve: boolean): void {
		this.#preserveQueryOrder = preserve;
	}
	/** Allow hosts to toggle context-window flagging between browser modes. */
	setMarkOverContext(mark: boolean): void {
		if (mark !== this.#markOverContext) this.#bumpPickerEpoch();
		this.#markOverContext = mark;
	}
	/** Focused: accent cursor + selected-row background band. Unfocused: dim cursor, no band. */
	setFocused(focused: boolean): void {
		this.#focused = focused;
	}

	/** Total rendered height for the current `maxVisible` (host layout budgeting). */
	get renderedRows(): number {
		return LIST_ROW_START + this.#maxVisible + DETAIL_ROWS;
	}

	get query(): string {
		return this.#searchInput.getValue();
	}

	/** Caret into {@link query} (UTF-16 offset), for native picker `cursor`. */
	get cursor(): number {
		return this.#searchInput.getCursor();
	}

	setQuery(query: string): void {
		this.#searchInput.setValue(query);
		this.#applyQuery("reset-changed-prefix");
	}

	getSelected(): ModelBrowserItem | undefined {
		return this.#menu.selectedItem;
	}

	get visibleCount(): number {
		return this.#menu.visibleItems.length;
	}

	/** Move selection to `selector`; false when it is not in the current view. */
	selectSelector(selector: string): boolean {
		if (!this.#menu.setSelectedKey(selector)) return false;
		this.#ensureSelectedVisible();
		return true;
	}

	#isDisabled(item: ModelBrowserItem): boolean {
		return item.id === "separator";
	}

	/**
	 * Rank base items for the live query and seat the recent/role separator.
	 * Runs inside the menu filter for non-blank queries; the blank-query path
	 * re-seats via {@link #applyQuery} because the menu passes items through
	 * unfiltered when the query is blank.
	 */
	#filterItems(items: readonly ModelBrowserItem[], query: string): readonly ModelBrowserItem[] {
		const base = items.filter(item => !this.#isDisabled(item));
		const ranked = this.#preserveQueryOrder
			? query.trim()
				? fuzzyRank(base, query, modelSearchText).map(result => result.item)
				: base
			: rankModelItems(query, base, {
					roles: this.#roles,
					mruOrder: this.#mruOrder,
					affinity: this.#affinity,
				});
		return this.#insertSeparator(ranked);
	}

	/** True when `item`'s context window is smaller than the live session token count (grayed row; hosts compact before switching). */
	isOverContext(item: ModelBrowserItem): boolean {
		if (item.id === "separator") return false;
		if (!this.#markOverContext || this.#currentContextTokens <= 0) return false;
		const contextWindow = item.model.contextWindow ?? 0;
		return contextWindow > 0 && this.#currentContextTokens > contextWindow;
	}

	/** Clamp a window start into `[0, total - maxVisible]`. */
	#clampWindowStart(start: number): number {
		return clampScrollOffset(start, this.#menu.visibleItems.length, this.#maxVisible);
	}

	/** Scroll just enough to keep the selected row inside the window. */
	#ensureSelectedVisible(): void {
		this.#windowStart = scrollOffsetForRow(
			this.#windowStart,
			this.#menu.selectedIndex,
			this.#menu.visibleItems.length,
			this.#maxVisible,
			"nearest",
		);
	}

	/**
	 * Move the selection by `delta` rows, skipping disabled rows. Single steps
	 * wrap at the ends; `wrap: false` (page/home/end jumps) clamps instead.
	 */
	moveSelection(delta: number, options: { wrap?: boolean } = {}): void {
		if (this.#menu.move(delta, options.wrap ?? true)) {
			this.#ensureSelectedVisible();
			this.onSelectionChange?.(this.getSelected());
		}
	}

	#isRecentOrRole(item: ModelBrowserItem): boolean {
		if (this.#mruOrder.includes(item.selector)) return true;
		for (const role in this.#roles) {
			const r = this.#roles[role];
			if (r && modelsAreEqual(r.model, item.model)) return true;
		}
		return false;
	}
	#insertSeparator(items: ModelBrowserItem[]): ModelBrowserItem[] {
		const filtered = items.filter(item => item.id !== "separator");
		const firstNonRecentIndex = filtered.findIndex(item => !this.#isRecentOrRole(item));
		if (firstNonRecentIndex > 0 && firstNonRecentIndex < filtered.length) {
			const separatorItem: ModelBrowserItem = {
				id: "separator",
				provider: "",
				selector: "separator",
				model: buildModel({
					id: "separator",
					name: "separator",
					api: "ollama-chat",
					provider: "",
					baseUrl: "",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 0,
					maxTokens: 0,
				}),
			};
			return [...filtered.slice(0, firstNonRecentIndex), separatorItem, ...filtered.slice(firstNonRecentIndex)];
		}
		return filtered;
	}

	/** Whether the new result list keeps every selectable choice through the previous selection unchanged. */
	#hasStableChoicePrefix(previousItems: ReadonlyArray<ModelBrowserItem>, previousSelectedIndex: number): boolean {
		const current = this.#menu.visibleItems;
		let currentIndex = 0;
		for (let previousIndex = 0; previousIndex <= previousSelectedIndex; previousIndex++) {
			const previous = previousItems[previousIndex];
			if (!previous || this.#isDisabled(previous)) continue;

			let found: ModelBrowserItem | undefined;
			while (currentIndex < current.length) {
				const candidate = current[currentIndex++];
				if (candidate && !this.#isDisabled(candidate)) {
					found = candidate;
					break;
				}
			}
			if (found?.selector !== previous.selector) return false;
		}
		return true;
	}

	#applyQuery(selection: "clamp" | "reset-changed-prefix" = "clamp"): void {
		const query = this.#searchInput.getValue();
		const previousItems = this.#menu.visibleItems;
		const previousSelectedIndex = this.#menu.selectedIndex;
		const previousSelected = previousItems[previousSelectedIndex];
		if (!query.trim()) {
			// The menu passes items through unfiltered on a blank query, so
			// re-seat the separator on the fresh base order here.
			const base = this.#menu.items.filter(item => !this.#isDisabled(item));
			this.#menu.setQuery("", false);
			this.#menu.setItems(
				this.#insertSeparator(base),
				selection === "clamp" ? previousSelected?.selector : undefined,
			);
		} else if (selection === "reset-changed-prefix") {
			this.#menu.setQuery(query, false);
		} else {
			this.#menu.setQuery(query, true);
		}
		if (
			selection === "reset-changed-prefix" &&
			previousSelected &&
			this.#hasStableChoicePrefix(previousItems, previousSelectedIndex)
		) {
			this.#menu.setSelectedKey(previousSelected.selector);
		}
		this.#ensureSelectedVisible();
		this.onSelectionChange?.(this.getSelected());
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) {
			this.handleCancel();
			return;
		}
		if (matchesSelectUp(data)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.moveSelection(1);
			return;
		}
		if (matchesSelectPageUp(data)) {
			this.moveSelection(-this.#maxVisible, { wrap: false });
			return;
		}
		if (matchesSelectPageDown(data)) {
			this.moveSelection(this.#maxVisible, { wrap: false });
			return;
		}
		if (matchesKey(data, "home")) {
			this.moveSelection(-this.#menu.visibleItems.length, { wrap: false });
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveSelection(this.#menu.visibleItems.length, { wrap: false });
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const selected = this.getSelected();
			if (selected && !this.#isDisabled(selected)) {
				this.onActivate?.(selected);
			}
			return;
		}
		// Everything else edits the query like a regular single-line editor.
		const before = this.#searchInput.getValue();
		this.#searchInput.handleInput(data);
		const after = this.#searchInput.getValue();
		if (after !== before) {
			this.#applyQuery("reset-changed-prefix");
			this.onQueryChange?.(after);
		}
	}

	/** Cancel-key ladder: clear a non-empty query first, then bubble to the host. */
	handleCancel(): void {
		if (this.#searchInput.getValue().length > 0) {
			this.setQuery("");
			this.onQueryChange?.("");
			return;
		}
		this.onCancel?.();
	}

	/**
	 * Route a mouse event. `line` is relative to the browser's first rendered
	 * row (the search row).
	 */
	routeMouse(event: SgrMouseEvent, line: number): void {
		if (event.wheel !== null) {
			// Wheel pans the window; it never moves the selection and never wraps.
			this.#windowStart = this.#clampWindowStart(this.#windowStart + event.wheel);
			this.#hoveredIndex = this.#hoverIndexAt(line);
			return;
		}
		if (event.motion) {
			this.#hoveredIndex = this.#hoverIndexAt(line);
			return;
		}
		if (!event.leftClick) return;
		const index = this.#hoverIndexAt(line);
		const item = index !== null ? this.#menu.visibleItems[index] : undefined;
		if (index === null || !item) return;
		// ModelBrowserSource idiom: click selects, click-again activates.
		if (index === this.#menu.selectedIndex) {
			this.onActivate?.(item);
		} else if (this.#menu.setSelectedIndex(index)) {
			this.#ensureSelectedVisible();
			this.onSelectionChange?.(this.getSelected());
		}
	}
	/** Drop the hover band. Hosts call this when the pointer leaves the browser pane. */
	clearHover(): void {
		this.#hoveredIndex = null;
	}

	/** List index under a frame-local row, or null when off-list or on a disabled row. */
	#hoverIndexAt(line: number): number | null {
		const listLine = line - LIST_ROW_START;
		if (listLine < 0 || listLine >= this.#windowCount) return null;
		const index = this.#windowStart + listLine;
		const item = this.#menu.visibleItems[index];
		if (!item || this.#isDisabled(item)) return null;
		return index;
	}

	/** Measured TPS/TTFT, falling back to the catalog TPS as an estimated `~118t/s`. */
	#perfCell(item: ModelBrowserItem, mode: PerfMode): string {
		if (mode === "off") return "";
		const perf = this.#perf.get(item.selector);
		if (perf) {
			const tps = formatTps(perf.tps);
			if (mode === "full" && perf.ttftMs !== null) return `${formatTtft(perf.ttftMs)} ${tps}`;
			return tps;
		}
		const tps = item.model.tps;
		return tps != null && Number.isFinite(tps) && tps > 0 ? `~${formatTps(tps)}` : "";
	}

	#renderRow(
		item: ModelBrowserItem,
		width: number,
		selected: boolean,
		hovered: boolean,
		ctxWidth: number,
		costWidth: number,
		intelligenceWidth: number,
		perfWidth: number,
		perfMode: PerfMode,
	): string {
		if (item.id === "separator") {
			const dashCount = Math.max(0, width - 4);
			const line = theme.fg("muted", "─".repeat(dashCount));
			return `  ${line}  `;
		}
		const overContext = this.isOverContext(item);
		const prefix = selected && this.#focused ? `${theme.fg("accent", theme.nav.cursor)} ` : "  ";
		const providerPrefix = this.#showProvider ? theme.fg("dim", `${item.provider}/`) : "";
		const name = item.labelColor
			? theme.fg(item.labelColor, item.id)
			: selected
				? theme.fg("accent", item.id)
				: item.id;
		const currentMark =
			item.selector === this.#currentSelector ? ` ${theme.fg("success", theme.status.enabled)}` : "";
		const overLimit = overContext
			? ` ${theme.status.disabled} context>${formatNumber(item.model.contextWindow ?? 0).toLowerCase()}`
			: "";
		let left = `${prefix}${providerPrefix}${name}${currentMark}${overLimit}`;

		// Metric columns collapse when empty or when the row needs room for its name.
		const cols: string[] = [];
		if (intelligenceWidth > 0)
			cols.push(theme.fg("dim", padLeftVisible(formatIntelligence(item.model), intelligenceWidth)));
		if (perfWidth > 0) cols.push(theme.fg("dim", padLeftVisible(this.#perfCell(item, perfMode), perfWidth)));
		if (ctxWidth > 0) cols.push(theme.fg("dim", padLeftVisible(formatContext(item.model), ctxWidth)));
		if (costWidth > 0) cols.push(theme.fg("dim", padLeftVisible(formatCostPair(item.model), costWidth)));
		const metaWidth = metaColumnsWidth([intelligenceWidth, perfWidth, ctxWidth, costWidth]);
		const available = Math.max(1, width - metaWidth - (cols.length > 0 ? 1 : 0));
		left = truncateToWidth(left, available);
		const gap = Math.max(0, available - visibleWidth(left));

		let line = cols.length > 0 ? `${left}${" ".repeat(gap)} ${cols.join("  ")}` : `${left}${" ".repeat(gap)}`;
		if (overContext) {
			// Gray the whole row but keep the selection cursor visible: over-context
			// models stay selectable (the host compacts before switching).
			const plainPrefix = Bun.stripANSI(prefix);
			line = `${prefix}${theme.fg("dim", Bun.stripANSI(line).slice(plainPrefix.length))}`;
		}
		// The bg band is reserved for the mouse: it marks hover, nothing else.
		// Keyboard selection is the cursor glyph + accent name.
		if (hovered) {
			line = theme.bg("selectedBg", line);
		}
		return line;
	}

	#detailLines(width: number): [string, string] {
		const selected = this.getSelected();
		if (!selected) return ["", ""];
		const model = selected.model;

		const facts: string[] = [model.name];
		// Upstream badges sit next to the name; the provider blurb goes last so
		// width truncation eats prose before context, cost, or perf facts.
		if (model.isNew) facts.push("new");
		if (model.isBeta) facts.push("beta");
		if (model.isRecommended) facts.push("recommended");
		if (model.contextWindow) facts.push(`${formatNumber(model.contextWindow).toLowerCase()} ctx`);
		if (model.maxTokens) facts.push(`${formatNumber(model.maxTokens).toLowerCase()} out`);
		facts.push(formatCostDetail(model));
		if (model.reasoning) facts.push("reasoning");
		if (model.input.includes("image")) facts.push("vision");
		const intelligence = formatIntelligence(model);
		if (intelligence) facts.push(intelligence);
		const perf = this.#perf.get(selected.selector);
		if (perf) {
			facts.push(`~${formatTps(perf.tps)}`);
			if (perf.ttftMs !== null) facts.push(`${formatTtft(perf.ttftMs)} ttft`);
		} else if (model.tps != null && Number.isFinite(model.tps) && model.tps > 0) {
			facts.push(`~${formatTps(model.tps)}`);
		}
		if (model.description) {
			const description = formatDescription(model.description);
			if (description) facts.push(description);
		}
		const line1 = truncateToWidth(theme.fg("muted", `  ${facts.join(" · ")}`), width);

		if (this.isOverContext(selected)) {
			const warning = `  ${theme.status.disabled} context ${formatNumber(this.#currentContextTokens).toLowerCase()} exceeds ${formatNumber(model.contextWindow ?? 0).toLowerCase()} limit · compacts with current model, then switches`;
			return [line1, truncateToWidth(theme.fg("warning", warning), width)];
		}

		const chips: string[] = [];
		if (selected.selector === this.#currentSelector) {
			chips.push(theme.fg("success", `${theme.status.enabled} current`));
		}
		const seen = new Set<string>();
		const pushRole = (role: string) => {
			if (seen.has(role)) return;
			seen.add(role);
			const assignment = this.#roles[role];
			if (!assignment || !modelsAreEqual(assignment.model, model)) return;
			if (this.#settings.getRoleInfo(role).hidden) return;
			chips.push(formatRoleChip(role, assignment, this.#settings));
		};
		for (const role of MODEL_ROLE_IDS) pushRole(role);
		for (const role in this.#roles) pushRole(role);
		const line2 = chips.length > 0 ? truncateToWidth(`  ${chips.join(theme.fg("dim", " · "))}`, width) : "";
		return [line1, line2];
	}

	render(width: number): string[] {
		const lines: string[] = [];

		const searchIcon = theme.fg("accent", theme.symbol("icon.search"));
		const inputWidth = Math.max(4, width - visibleWidth(theme.symbol("icon.search")) - 2);
		lines.push(` ${searchIcon} ${this.#searchInput.render(inputWidth)[0] ?? ""}`);
		lines.push("");

		const total = this.#menu.visibleItems.length;
		// The window is persistent state: wheel scrolling panned it, keyboard
		// navigation snapped it to the selection. Re-clamp here because items
		// or maxVisible may have changed since.
		this.#windowStart = this.#clampWindowStart(this.#windowStart);
		const startIndex = this.#windowStart;
		const endIndex = Math.min(startIndex + this.#maxVisible, total);
		this.#windowCount = Math.max(0, endIndex - startIndex);

		if (total === 0) {
			const message =
				this.#emptyText?.() ?? (this.query.trim() ? "  No matching models" : "  No models available in this scope");
			lines.push(truncateToWidth(theme.fg("muted", message), width));
			for (let i = 1; i < this.#maxVisible; i++) lines.push("");
		} else {
			// Per-window column widths keep the metadata block aligned without
			// scanning the entire catalog on every render.
			let ctxWidth = 0;
			let costWidth = 0;
			const perfMode: PerfMode = width >= PERF_FULL_MIN_WIDTH ? "full" : width >= PERF_TPS_MIN_WIDTH ? "tps" : "off";
			let intelligenceWidth = 0;
			let perfWidth = 0;
			for (let i = startIndex; i < endIndex; i++) {
				const item = this.#menu.visibleItems[i];
				if (!item) continue;
				ctxWidth = Math.max(ctxWidth, visibleWidth(formatContext(item.model)));
				costWidth = Math.max(costWidth, visibleWidth(formatCostPair(item.model)));
				if (perfMode !== "off") {
					intelligenceWidth = Math.max(intelligenceWidth, visibleWidth(formatIntelligence(item.model)));
				}
				perfWidth = Math.max(perfWidth, visibleWidth(this.#perfCell(item, perfMode)));
			}
			// Preserve at least a readable name by dropping cost, then context.
			let nameRoom = width - 2 - metaColumnsWidth([intelligenceWidth, perfWidth, ctxWidth, costWidth]);
			if (nameRoom < MIN_NAME_WIDTH) costWidth = 0;
			nameRoom = width - 2 - metaColumnsWidth([intelligenceWidth, perfWidth, ctxWidth, costWidth]);
			if (nameRoom < MIN_NAME_WIDTH) ctxWidth = 0;

			const rows: string[] = [];
			for (let i = startIndex; i < endIndex; i++) {
				const item = this.#menu.visibleItems[i];
				if (!item) continue;
				rows.push(
					this.#renderRow(
						item,
						width - 1,
						i === this.#menu.selectedIndex,
						i === this.#hoveredIndex,
						ctxWidth,
						costWidth,
						intelligenceWidth,
						perfWidth,
						perfMode,
					),
				);
			}
			const scrollView = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			scrollView.setScrollOffset(startIndex);
			lines.push(...scrollView.render(width));
			for (let i = rows.length; i < this.#maxVisible; i++) lines.push("");
		}

		lines.push("");
		const [detail1, detail2] = this.#detailLines(width);
		lines.push(detail1);
		lines.push(detail2);
		return lines;
	}

	invalidate(): void {}

	#bumpNativeEpoch(): void {
		this.#nativeEpoch++;
		this.#itemNodes.clear();
	}

	/** Perf and over-context flags feed both the generic rows and the picker rows. */
	#bumpPickerEpoch(): void {
		this.#bumpNativeEpoch();
		// Rows are rebuilt on the next read; equal ones keep their identity (see #pickerItem).
		this.#pickerEpoch++;
	}

	/**
	 * `col[search row, list, detail]`: the query field (the embedded `Input`),
	 * every visible model as a keyed `item` (the terminal virtualizes and
	 * scrolls), and the selection's facts and role chips.
	 */
	describe(): NativeNode {
		this.#nativeSearch ??= row([text([span(theme.symbol("icon.search"), "accent")]), this.#searchInput], {
			gap: "sm",
			align: "center",
		});
		const list = this.#describeList();
		const detail = this.#describeDetail();
		const root = this.#nativeRoot;
		if (root?.list === list && root.detail === detail) return root.node;
		const node = col([this.#nativeSearch, list, detail], { gap: "sm" });
		this.#nativeRoot = { list, detail, node };
		return node;
	}

	/** List `select`/`activate` on a model = highlight it, then Enter. */
	handleNativeEvent(event: NativeUiEvent): void {
		if ((event.type !== "select" && event.type !== "activate") || event.key !== "list") return;
		const index = this.#menu.visibleItems.findIndex(item => item.selector === event.item);
		const item = this.#menu.visibleItems[index];
		if (!item || this.#isDisabled(item)) return;
		if (this.#menu.setSelectedIndex(index)) {
			this.#ensureSelectedVisible();
			this.onSelectionChange?.(this.getSelected());
		}
		this.onActivate?.(item);
	}

	#describeList(): NativeNode {
		const items = this.#menu.visibleItems;
		let cached = this.#nativeList;
		if (cached?.items !== items || cached.epoch !== this.#nativeEpoch) {
			cached = { items, epoch: this.#nativeEpoch, children: items.map(item => this.#describeItem(item)) };
			this.#nativeList = cached;
		}
		const selected = this.getSelected()?.selector ?? null;
		const filter = this.query.trim();
		const empty =
			items.length > 0
				? ""
				: plainText(this.#emptyText?.() ?? "").trim() ||
					(filter ? "No matching models" : "No models available in this scope");
		const prev = this.#nativeListNode;
		if (
			prev?.children === cached.children &&
			prev.selected === selected &&
			prev.filter === filter &&
			prev.empty === empty
		) {
			return prev.node;
		}
		const listNode = node(
			"list",
			{
				role: "omp.model-browser.list",
				selected,
				filter: filter || undefined,
				empty: empty ? [span(empty, "muted")] : undefined,
				virtual: true,
				grow: 1,
			},
			cached.children,
			"list",
		);
		this.#nativeListNode = { children: cached.children, selected, filter, empty, node: listNode };
		return listNode;
	}

	#describeItem(item: ModelBrowserItem): NativeNode {
		if (item.id === "separator") return node("rule", undefined, undefined, "separator");
		const cached = this.#itemNodes.get(item.selector);
		if (cached?.item === item) return cached.node;

		const label: TspSpan[] = [];
		if (this.#showProvider) label.push(span(`${item.provider}/`, "dim"));
		label.push(span(item.id, item.labelColor));
		if (item.selector === this.#currentSelector) label.push(span(` ${theme.status.enabled}`, "success"));
		const metrics = [
			formatIntelligence(item.model),
			this.#perfCell(item, "full"),
			formatContext(item.model),
			formatCostPair(item.model),
		].filter(Boolean);
		const overContext = this.isOverContext(item);
		const itemNode = node(
			"item",
			{
				label,
				value: [span(metrics.join("  "), "dim")],
				detail: overContext
					? [
							span(
								`${theme.status.disabled} context>${formatNumber(item.model.contextWindow ?? 0).toLowerCase()}`,
								"warning",
							),
						]
					: undefined,
				tone: overContext ? "muted" : undefined,
			},
			undefined,
			item.selector,
		);
		this.#itemNodes.set(item.selector, { item, node: itemNode });
		return itemNode;
	}

	/** Facts, upstream badges, and the over-context warning or role chips for the selection. */
	#describeDetail(): NativeNode {
		const selected = this.getSelected();
		const prev = this.#nativeDetail;
		if (prev && prev.item === selected && prev.epoch === this.#nativeEpoch && prev.roles === this.#roles) {
			return prev.node;
		}

		const children: NativeChild[] = [];
		if (selected) {
			const model = selected.model;
			const head: NativeChild[] = [text([span(model.name, "strong")])];
			if (model.isNew) head.push(node("badge", { text: "new", tone: "accent" }));
			if (model.isBeta) head.push(node("badge", { text: "beta", tone: "warning" }));
			if (model.isRecommended) head.push(node("badge", { text: "recommended", tone: "success" }));
			children.push(row(head, { gap: "sm", align: "center", wrap: true }));

			const facts: string[] = [];
			if (model.contextWindow) facts.push(`${formatNumber(model.contextWindow).toLowerCase()} ctx`);
			if (model.maxTokens) facts.push(`${formatNumber(model.maxTokens).toLowerCase()} out`);
			facts.push(formatCostDetail(model));
			if (model.reasoning) facts.push("reasoning");
			if (model.input.includes("image")) facts.push("vision");
			const intelligence = formatIntelligence(model);
			if (intelligence) facts.push(intelligence);
			const perf = this.#perf.get(selected.selector);
			if (perf) {
				facts.push(`~${formatTps(perf.tps)}`);
				if (perf.ttftMs !== null) facts.push(`${formatTtft(perf.ttftMs)} ttft`);
			} else if (model.tps != null && Number.isFinite(model.tps) && model.tps > 0) {
				facts.push(`~${formatTps(model.tps)}`);
			}
			children.push(text([span(facts.join(" · "), "muted")], { wrap: "word" }));
			const description = model.description ? formatDescription(model.description) : "";
			if (description) children.push(text([span(description, "dim")], { wrap: "word", lines: 2 }));

			if (this.isOverContext(selected)) {
				const warning = `${theme.status.disabled} context ${formatNumber(this.#currentContextTokens).toLowerCase()} exceeds ${formatNumber(model.contextWindow ?? 0).toLowerCase()} limit · compacts with current model, then switches`;
				children.push(text([span(warning, "warning")], { wrap: "word" }));
			} else {
				const chips: TspSpan[] = [];
				if (selected.selector === this.#currentSelector) {
					chips.push(span(`${theme.status.enabled} current`, "success"));
				}
				const seen = new Set<string>();
				const pushRole = (role: string) => {
					if (seen.has(role)) return;
					seen.add(role);
					const assignment = this.#roles[role];
					if (!assignment || !modelsAreEqual(assignment.model, model)) return;
					if (this.#settings.getRoleInfo(role).hidden) return;
					if (chips.length > 0) chips.push(span(" · ", "dim"));
					chips.push(...roleChipSpans(role, assignment, this.#settings));
				};
				for (const role of MODEL_ROLE_IDS) pushRole(role);
				for (const role in this.#roles) pushRole(role);
				if (chips.length > 0) children.push(text(chips, { wrap: "word" }));
			}
		}
		const detailNode = node("col", { role: "omp.model-browser.detail", gap: "none" }, children, "detail");
		this.#nativeDetail = { item: selected, epoch: this.#nativeEpoch, roles: this.#roles, node: detailNode };
		return detailNode;
	}

	// ─── Picker (data-first `picker` kind) ────────────────────────────────

	/** Base rows of the current scope, before the query (the head's "of N"). */
	get baseCount(): number {
		let count = 0;
		for (const item of this.#menu.items) if (!this.#isDisabled(item)) count++;
		return count;
	}

	/** The selected row's selector, null when nothing selectable is selected. */
	get pickerSelected(): string | null {
		const selected = this.getSelected();
		return selected && !this.#isDisabled(selected) ? selected.selector : null;
	}

	/**
	 * Picker rows for `catalogue`: the same object while the catalogue, roles
	 * and row inputs are unchanged, so typing and scope hops never resend it.
	 * A rebuilt catalogue that differs in a few rows (a provider refresh, a
	 * role moving) keeps the last whole `items` and patches it.
	 */
	pickerItems(catalogue: readonly ModelBrowserItem[]): ModelPickerCatalogue {
		const memo = this.#pickerItems;
		if (memo?.catalogue === catalogue && memo.epoch === this.#pickerEpoch && memo.roles === this.#roles) {
			return memo.value;
		}
		const rows = catalogue.map(item => this.#pickerItem(item));
		const value = this.#patchCatalogue(rows);
		this.#pickerItems = { catalogue, epoch: this.#pickerEpoch, roles: this.#roles, value };
		return value;
	}

	#patchCatalogue(rows: readonly TspPickerItem[]): ModelPickerCatalogue {
		const base = this.#pickerBase;
		if (base) {
			const baseById = new Map(base.map(row => [row.id, row]));
			const current = new Set(rows.map(row => row.id));
			const add = rows.filter(row => baseById.get(row.id) !== row || this.#pickerPatched.has(row.id));
			const del: string[] = [];
			for (const row of base) if (!current.has(row.id)) del.push(row.id);
			for (const id of this.#pickerPatched) if (!baseById.has(id) && !current.has(id)) del.push(id);
			if (add.length + del.length === 0) return { items: base };
			// Past a quarter of the catalogue a whole resend is cheaper than the patch.
			if ((add.length + del.length) * 4 <= base.length) {
				for (const row of add) this.#pickerPatched.add(row.id);
				for (const id of del) this.#pickerPatched.add(id);
				return {
					items: base,
					...(add.length > 0 ? { itemsAdd: add } : {}),
					...(del.length > 0 ? { itemsDel: del } : {}),
				};
			}
		}
		this.#pickerBase = rows;
		this.#pickerPatched.clear();
		return { items: rows };
	}

	#pickerItem(item: ModelBrowserItem): TspPickerItem {
		const model = item.model;
		const heldRoles = this.#heldRoles(model);
		const held = heldRoles
			.map(({ role, assignment }) => `${role}:${assignment.autoSelected}:${assignment.thinkingLevel}`)
			.join(",");
		const cached = this.#pickerItemCache.get(item.selector);
		if (
			cached?.model === model &&
			cached.label === item.id &&
			cached.held === held &&
			cached.epoch === this.#pickerEpoch
		) {
			return cached.value;
		}
		const facts: Record<string, TspText | number> = {};
		const int = model.int != null && Number.isFinite(model.int) ? model.int : undefined;
		if (int !== undefined) facts.int = String(Math.round(int));
		const speed = this.#perfCell(item, "tps").replace(/t\/s$/, "");
		if (speed) facts.speed = speed;
		if (model.contextWindow) facts.ctx = model.contextWindow;
		facts.price = pickerPrice(model);
		const badges: { text: string; tone?: "accent" | "warning" | "success"; title?: string }[] = [];
		if (this.isOverContext(item)) {
			badges.push({
				text: `ctx>${formatNumber(model.contextWindow ?? 0).toLowerCase()}`,
				tone: "warning",
				title: `Context ${formatNumber(this.#currentContextTokens).toLowerCase()} exceeds this model's limit; picking it compacts first`,
			});
		}
		if (model.isNew) badges.push({ text: "new", tone: "accent" });
		if (model.isBeta) badges.push({ text: "beta", tone: "warning" });
		if (isFreeModel(model)) badges.push({ text: "free", tone: "success" });
		const chips = heldRoles.map(({ role, assignment }) => {
			const info = this.#settings.getRoleInfo(role);
			const dot = thinkingDotToken(assignment.thinkingLevel);
			return {
				text: (info.tag ?? info.name ?? role).toLowerCase(),
				on: !assignment.autoSelected,
				...(assignment.autoSelected ? { auto: true } : {}),
				...(dot ? { dot } : {}),
			};
		});
		// Quick-role rows (`@role`) name the role and trail the model they apply.
		const quickRole = item.provider === "" && item.id.startsWith("@");
		const value: TspPickerItem = {
			id: item.selector,
			label: quickRole ? item.id : item.selector,
			mono: true,
			...(quickRole ? { detail: `${item.model.provider}/${item.model.id}` } : {}),
			facts,
			...(badges.length > 0 ? { badges: badges.slice(0, 3) } : {}),
			...(chips.length > 0 ? { chips } : {}),
			...(int !== undefined ? { title: `Intelligence ${Math.round(int)}` } : {}),
		};
		// Discovery re-mints Model objects for unchanged models; an equal row keeps its identity.
		const kept = cached && Bun.deepEquals(cached.value, value) ? cached.value : value;
		this.#pickerItemCache.set(item.selector, { model, label: item.id, held, epoch: this.#pickerEpoch, value: kept });
		return kept;
	}

	/** Visible roles `model` holds, built-in order first (the detail line's chips). */
	#heldRoles(model: Model): { role: string; assignment: RoleAssignment }[] {
		const held: { role: string; assignment: RoleAssignment }[] = [];
		const seen = new Set<string>();
		const push = (role: string) => {
			if (seen.has(role)) return;
			seen.add(role);
			const assignment = this.#roles[role];
			if (!assignment || !modelsAreEqual(assignment.model, model)) return;
			if (this.#settings.getRoleInfo(role).hidden) return;
			held.push({ role, assignment });
		};
		for (const role of MODEL_ROLE_IDS) push(role);
		for (const role in this.#roles) push(role);
		return held;
	}

	/**
	 * The visible rows as picker `order`: the Recent block (recent and
	 * role-assigned models, the ANSI separator's upper side) under "Recent",
	 * then the rest per provider or under `grouping.rest`. Memoized per
	 * result list and query, so selection moves reuse it.
	 */
	pickerOrder(grouping: ModelPickerGrouping): ModelPickerOrder {
		const visible = this.#menu.visibleItems;
		const query = this.query.trim();
		const key = `${grouping.providers}\0${grouping.rest}\0${query}`;
		const memo = this.#pickerOrder;
		if (memo?.visible === visible && memo.key === key) return memo.value;

		const split = visible.findIndex(item => this.#isDisabled(item));
		const order: (string | TspPickerGroup)[] = [];
		let count = 0;
		const pushRows = (rows: readonly ModelBrowserItem[]) => {
			for (const item of rows) {
				if (this.#isDisabled(item)) continue;
				order.push(item.selector);
				count++;
			}
		};
		const recent = split > 0 ? visible.slice(0, split) : [];
		const rest = split > 0 ? visible.slice(split + 1) : visible;
		if (grouping.rest === null) {
			pushRows(visible);
		} else {
			if (recent.length > 0) {
				order.push({ group: "recent", label: "Recent", count: recent.length });
				pushRows(recent);
			}
			if (grouping.providers) this.#pushProviderGroups(order, rest, pushRows);
			else {
				if (recent.length > 0 && rest.length > 0) {
					order.push({ group: "rest", label: grouping.rest, count: rest.length });
				}
				pushRows(rest);
			}
		}

		let hits: Record<string, [number, number][]> | undefined;
		if (query) {
			hits = {};
			for (const item of visible) {
				if (this.#isDisabled(item)) continue;
				const label = item.provider === "" ? item.id : item.selector;
				const ranges = pickerFuzzyHits(label, query);
				if (ranges) hits[item.selector] = ranges;
			}
		}
		const value: ModelPickerOrder = { order, hits, count };
		this.#pickerOrder = { visible, key, value };
		return value;
	}

	/** One group head per run of same-provider rows (the unfiltered list is provider-sorted past the Recent block). */
	#pushProviderGroups(
		order: (string | TspPickerGroup)[],
		rest: readonly ModelBrowserItem[],
		pushRows: (rows: readonly ModelBrowserItem[]) => void,
	): void {
		let start = 0;
		while (start < rest.length) {
			const provider = rest[start]!.provider;
			let end = start + 1;
			while (end < rest.length && rest[end]!.provider === provider) end++;
			order.push({ group: `provider:${provider}:${start}`, label: provider, count: end - start });
			pushRows(rest.slice(start, end));
			start = end;
		}
	}

	/**
	 * Preview children for the selection. `full` (the model hub's side pane):
	 * title, copyable id, badges, a fact grid, every role the model can fill
	 * (held ones on) and the description. `compact` (the quick picker's strip
	 * below the list): one inline fact line and the held-role chips.
	 */
	pickerPreview(mode: "full" | "compact", current?: string): readonly NativeChild[] {
		const selected = this.getSelected();
		const item = selected && !this.#isDisabled(selected) ? selected : undefined;
		const key = `${mode}\0${current ?? ""}`;
		const memo = this.#pickerPreview;
		if (
			memo !== undefined &&
			memo.item === item &&
			memo.epoch === this.#pickerEpoch &&
			memo.roles === this.#roles &&
			memo.key === key
		) {
			return memo.children;
		}
		const children = item ? this.modelPreview(item, mode, current) : [];
		this.#pickerPreview = { item, epoch: this.#pickerEpoch, roles: this.#roles, key, children };
		return children;
	}

	/** Preview children for any model row (the hub's Roles view previews assigned models with it); unmemoized. */
	modelPreview(item: ModelBrowserItem, mode: "full" | "compact", current: string | undefined): NativeChild[] {
		const model = item.model;
		const selector = `${model.provider}/${model.id}`;
		const perf = this.#perf.get(selector);
		const ctx = model.contextWindow ?? 0;
		const out = model.maxTokens ?? 0;
		const overContext = this.isOverContext(item);
		const warning = overContext
			? text(
					[
						span(
							`Context ${formatNumber(this.#currentContextTokens).toLowerCase()} exceeds the ${formatNumber(ctx).toLowerCase()} limit · compacts with the current model, then switches`,
							"warning",
						),
					],
					{ wrap: "word" },
				)
			: undefined;
		const held = this.#heldRoles(model);
		const roleBadge = (role: string, assignment: RoleAssignment | undefined): NativeNode => {
			const info = this.#settings.getRoleInfo(role);
			const level =
				assignment && assignment.thinkingLevel !== ThinkingLevel.Inherit
					? getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label
					: undefined;
			return node("badge", {
				text: (info.tag ?? info.name ?? role).toLowerCase(),
				...(assignment ? { tone: assignment.autoSelected ? "muted" : "accent" } : {}),
				title: assignment
					? `${info.name}${assignment.autoSelected ? " (auto-selected)" : ""}${level ? ` · thinking ${level}` : ""}`
					: `${info.name}: not assigned`,
			});
		};

		if (mode === "compact") {
			const facts: { k: TspText; v: TspText }[] = [];
			if (ctx > 0) facts.push({ k: "ctx", v: formatNumber(ctx).toLowerCase() });
			if (out > 0) facts.push({ k: "out", v: formatNumber(out).toLowerCase() });
			facts.push({ k: "price", v: isFreeModel(model) ? "free" : formatCostDetail(model) });
			facts.push({ k: "reasoning", v: model.reasoning ? "yes" : "no" });
			const children: NativeChild[] = [node("kv", { items: facts, layout: "inline" })];
			const chips: NativeChild[] = [];
			if (item.selector === current) chips.push(node("badge", { text: "current", tone: "success" }));
			for (const { role, assignment } of held) chips.push(roleBadge(role, assignment));
			if (chips.length > 0) children.push(row(chips, { gap: "xs", wrap: true }));
			if (warning) children.push(warning);
			return children;
		}

		const children: NativeChild[] = [
			text(model.name, { role: "omp.picker.title" }),
			text([span(selector, "mono")], { actions: { click: "copy" }, title: "Copy model id", truncate: "middle" }),
		];
		const badges: NativeChild[] = [];
		if (item.selector === current) badges.push(node("badge", { text: "current", tone: "success" }));
		if (model.isNew) badges.push(node("badge", { text: "new", tone: "accent" }));
		if (model.isBeta) badges.push(node("badge", { text: "beta", tone: "warning" }));
		if (model.isRecommended) badges.push(node("badge", { text: "recommended", tone: "success" }));
		if (model.reasoning) badges.push(node("badge", { text: "reasoning" }));
		if (model.input.includes("image")) badges.push(node("badge", { text: "vision" }));
		if (badges.length > 0) children.push(row(badges, { gap: "xs", wrap: true }));

		const speed: string[] = [];
		if (perf) {
			speed.push(`${formatTps(perf.tps).replace("t/s", " t/s")}`);
			if (perf.ttftMs !== null) speed.push(`${formatTtft(perf.ttftMs).replace("s", " s")} TTFT`);
			speed.push(`${perf.samples} ${perf.samples === 1 ? "sample" : "samples"}`);
		} else if (model.tps != null && Number.isFinite(model.tps) && model.tps > 0) {
			speed.push(`~${formatTps(model.tps).replace("t/s", " t/s")} (catalog)`);
		}
		const facts: { k: TspText; v: TspText }[] = [];
		const fact = (k: string, v: string | undefined) => {
			if (v) facts.push({ k: [span(k, "muted")], v: [span(v, "mono")] });
		};
		fact("Context", ctx > 0 ? ctx.toLocaleString("en-US") : undefined);
		fact("Max output", out > 0 ? out.toLocaleString("en-US") : undefined);
		fact("Price", isFreeModel(model) ? "free" : `${previewPrice(model)} per M`);
		fact("Speed", speed.length > 0 ? speed.join(" · ") : undefined);
		fact("Intelligence", model.int != null && Number.isFinite(model.int) ? String(Math.round(model.int)) : undefined);
		fact("Input", model.input.join(" · "));
		fact("Reasoning", model.reasoning ? "yes" : "no");
		children.push(node("kv", { items: facts }));
		if (warning) children.push(warning);

		const heldBy = new Map(held.map(entry => [entry.role, entry.assignment]));
		const roleBadges: NativeChild[] = [];
		for (const role of this.#settings.knownRoleIds) {
			const info = this.#settings.getRoleInfo(role);
			if (info.hidden || !info.accepts(model)) continue;
			roleBadges.push(roleBadge(role, heldBy.get(role)));
		}
		if (roleBadges.length > 0) {
			children.push(node("section", { head: "Roles" }, [row(roleBadges, { gap: "xs", wrap: true })]));
		}
		const description = model.description ? sanitizeText(model.description).trim() : "";
		if (description) children.push(md(description));
		return children;
	}

	/** A picker row click: `select` highlights it, `activate` also runs Enter's path. False when not a visible row. */
	routePickerItem(selector: string, activate: boolean): boolean {
		const index = this.#menu.visibleItems.findIndex(item => item.selector === selector);
		const item = this.#menu.visibleItems[index];
		if (!item || this.#isDisabled(item)) return false;
		if (this.#menu.setSelectedIndex(index)) {
			this.#ensureSelectedVisible();
			this.onSelectionChange?.(this.getSelected());
		}
		if (activate) this.onActivate?.(item);
		return true;
	}
}
