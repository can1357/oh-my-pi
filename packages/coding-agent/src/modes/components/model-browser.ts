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
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import {
	type Component,
	fuzzyRank,
	Input,
	matchesKey,
	replaceTabs,
	ScrollView,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { ModelPerfStats } from "../../session/agent-storage";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../../thinking";
import { type ThemeColor, theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";

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
	settings: Settings,
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
			return parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel")) ?? ThinkingLevel.Inherit;
		}
		return ThinkingLevel.Inherit;
	};

	const roles: RoleAssignments = {};
	const matchPreferences = getModelMatchPreferences(settings);
	const knownRoles = getKnownRoleIds(settings);
	const configuredRoles = new Set<string>();
	const catalog = [...allModels];

	for (const role of knownRoles) {
		const roleValue = settings.getModelRole(role);
		if (!roleValue) continue;
		configuredRoles.add(role);
		const resolved = resolveModelRoleValue(roleValue, catalog, { settings, matchPreferences });
		if (resolved.model) {
			roles[role] = {
				model: resolved.model,
				thinkingLevel: resolvedThinkingLevel(role, resolved),
				autoSelected: false,
			};
		}
	}

	if (autoCandidates.length > 0) {
		const candidates = [...autoCandidates];
		for (const role of knownRoles) {
			if (configuredRoles.has(role)) continue;
			const resolved = resolveModelRoleValue(`pi/${role}`, candidates, { settings, matchPreferences });
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

interface RoleProviderStats {
	count: number;
	firstRole: number;
}

/** User affinity used to order search matches within one relevance tier. */
interface SearchAffinity {
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
function buildSearchAffinity(
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

/** Compact glyph for a configured thinking level; empty for `inherit` (nothing to show). */
export function thinkingLevelGlyph(level: ConfiguredThinkingLevel): string {
	const glyphOf = (symbol: string) => symbol.split(" ")[0] ?? symbol;
	switch (level) {
		case AUTO_THINKING:
			return glyphOf(theme.thinking.autoPending);
		case ThinkingLevel.Off:
			return theme.status.disabled;
		case ThinkingLevel.Minimal:
			return glyphOf(theme.thinking.minimal);
		case ThinkingLevel.Low:
			return glyphOf(theme.thinking.low);
		case ThinkingLevel.Medium:
			return glyphOf(theme.thinking.medium);
		case ThinkingLevel.High:
			return glyphOf(theme.thinking.high);
		case ThinkingLevel.XHigh:
			return glyphOf(theme.thinking.xhigh);
		case ThinkingLevel.Max:
			return glyphOf(theme.thinking.max);
		case ThinkingLevel.Inherit:
			return "";
	}
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
export function formatRoleChip(role: string, assignment: RoleAssignment, settings: Settings): string {
	const info = getRoleInfo(role, settings);
	const label = (info.tag ?? info.name ?? role).toLowerCase();
	const glyph = thinkingLevelGlyph(assignment.thinkingLevel);
	const suffix = glyph ? ` ${theme.fg("dim", glyph)}` : "";
	if (assignment.autoSelected) {
		return theme.fg("dim", `${theme.status.shadowed} ${label}`) + suffix;
	}
	return theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) + suffix;
}

/** `$in/out` per-million cost pair; `free` when both legs are zero. */
function formatCostPair(model: Model): string {
	const cost = model.cost;
	if (!cost || (cost.input <= 0 && cost.output <= 0)) return "free";
	const fmt = (n: number): string => {
		if (n <= 0) return "0";
		const s = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
		return s.replace(/\.?0+$/, "");
	};
	return `$${fmt(cost.input)}/${fmt(cost.output)}`;
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
/** What the per-row perf column shows at the current width. */
type PerfMode = "off" | "tps" | "full";

/**
 * The reusable browser component. Renders a fixed-height block
 * (`maxVisible + LIST_ROW_START + DETAIL_ROWS` rows) so host mouse geometry
 * stays stable across renders.
 */
export class ModelBrowser implements Component {
	#settings: Settings;
	#searchInput = new Input();
	#baseItems: ModelBrowserItem[] = [];
	#visibleItems: ModelBrowserItem[] = [];
	#roles: RoleAssignments = {};
	#mruOrder: ReadonlyArray<string> = [];
	#affinity: SearchAffinity = { models: new Map(), providers: new Map() };
	#perf: ReadonlyMap<string, ModelPerfStats> = new Map();
	#selectedIndex = 0;
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

	/** Enter or click-on-selected. */
	onActivate?: (item: ModelBrowserItem) => void;
	onSelectionChange?: (item: ModelBrowserItem | undefined) => void;
	onQueryChange?: (query: string) => void;
	/** Cancel key with an empty query (a non-empty query is cleared first). */
	onCancel?: () => void;

	constructor(settings: Settings, options: ModelBrowserOptions = {}) {
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
		this.#currentSelector = selector;
	}

	/** Replace the scope's base items; the live query re-applies and selection is pinned by selector. */
	setItems(items: ModelBrowserItem[]): void {
		const selectedKey = this.getSelected()?.selector;
		this.#baseItems = items;
		this.#applyQuery();
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
		this.#affinity = buildSearchAffinity(this.#settings.get("modelProviderOrder"), this.#roles, this.#mruOrder);
	}

	/** Measured TPS/TTFT averages keyed by `provider/id` selector (see AgentStorage.getModelPerf). */
	setPerfStats(perf: ReadonlyMap<string, ModelPerfStats>): void {
		this.#perf = perf;
	}

	setMaxVisible(rows: number): void {
		// No selection snap here: hosts call this on every render, and it must
		// not undo wheel panning. render() re-clamps the window.
		this.#maxVisible = Math.max(1, rows);
	}

	setShowProvider(show: boolean): void {
		this.#showProvider = show;
	}
	/** Keep the source order after fuzzy filtering instead of applying model-specific ranking. */
	setPreserveQueryOrder(preserve: boolean): void {
		this.#preserveQueryOrder = preserve;
	}
	/** Allow hosts to toggle context-window flagging between browser modes. */
	setMarkOverContext(mark: boolean): void {
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

	setQuery(query: string): void {
		this.#searchInput.setValue(query);
		this.#applyQuery("reset-changed-prefix");
	}

	getSelected(): ModelBrowserItem | undefined {
		return this.#visibleItems[this.#selectedIndex];
	}

	get visibleCount(): number {
		return this.#visibleItems.length;
	}

	/** Move selection to `selector`; false when it is not in the current view. */
	selectSelector(selector: string): boolean {
		const index = this.#visibleItems.findIndex(item => item.selector === selector);
		if (index < 0) return false;
		this.#selectedIndex = this.#coerceSelectedIndex(index);
		this.#ensureSelectedVisible();
		return true;
	}

	#isDisabled(item: ModelBrowserItem): boolean {
		return item.id === "separator";
	}

	/** True when `item`'s context window is smaller than the live session token count (grayed row; hosts compact before switching). */
	isOverContext(item: ModelBrowserItem): boolean {
		if (item.id === "separator") return false;
		if (!this.#markOverContext || this.#currentContextTokens <= 0) return false;
		const contextWindow = item.model.contextWindow ?? 0;
		return contextWindow > 0 && this.#currentContextTokens > contextWindow;
	}

	#coerceSelectedIndex(index: number): number {
		const maxIndex = this.#visibleItems.length - 1;
		if (maxIndex < 0) return 0;
		const clamped = Math.max(0, Math.min(index, maxIndex));
		const clampedItem = this.#visibleItems[clamped];
		if (clampedItem && !this.#isDisabled(clampedItem)) return clamped;
		for (let i = clamped + 1; i <= maxIndex; i++) {
			const item = this.#visibleItems[i];
			if (item && !this.#isDisabled(item)) return i;
		}
		for (let i = clamped - 1; i >= 0; i--) {
			const item = this.#visibleItems[i];
			if (item && !this.#isDisabled(item)) return i;
		}
		return clamped;
	}

	/** Clamp a window start into `[0, total - maxVisible]`. */
	#clampWindowStart(start: number): number {
		return Math.max(0, Math.min(start, this.#visibleItems.length - this.#maxVisible));
	}

	/** Scroll just enough to keep the selected row inside the window. */
	#ensureSelectedVisible(): void {
		if (this.#selectedIndex < this.#windowStart) {
			this.#windowStart = this.#selectedIndex;
		} else if (this.#selectedIndex >= this.#windowStart + this.#maxVisible) {
			this.#windowStart = this.#selectedIndex - this.#maxVisible + 1;
		}
		this.#windowStart = this.#clampWindowStart(this.#windowStart);
	}

	/**
	 * Move the selection by `delta` rows, skipping disabled rows. Single steps
	 * wrap at the ends; `wrap: false` (page/home/end jumps) clamps instead.
	 */
	moveSelection(delta: number, options: { wrap?: boolean } = {}): void {
		const count = this.#visibleItems.length;
		if (count === 0) return;
		if (options.wrap ?? true) {
			let index = this.#selectedIndex;
			for (let step = 0; step < count; step++) {
				index = (index + delta + count) % count;
				const item = this.#visibleItems[index];
				if (item && !this.#isDisabled(item)) {
					this.#setSelectedIndex(index);
					return;
				}
			}
			return;
		}
		const target = Math.max(0, Math.min(this.#selectedIndex + delta, count - 1));
		this.#setSelectedIndex(this.#coerceSelectedIndex(target));
	}

	#setSelectedIndex(index: number): void {
		if (index === this.#selectedIndex) return;
		this.#selectedIndex = index;
		this.#ensureSelectedVisible();
		this.onSelectionChange?.(this.getSelected());
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
		let currentIndex = 0;
		for (let previousIndex = 0; previousIndex <= previousSelectedIndex; previousIndex++) {
			const previous = previousItems[previousIndex];
			if (!previous || this.#isDisabled(previous)) continue;

			let current: ModelBrowserItem | undefined;
			while (currentIndex < this.#visibleItems.length) {
				const candidate = this.#visibleItems[currentIndex++];
				if (candidate && !this.#isDisabled(candidate)) {
					current = candidate;
					break;
				}
			}
			if (current?.selector !== previous.selector) return false;
		}
		return true;
	}

	#applyQuery(selection: "clamp" | "reset-changed-prefix" = "clamp"): void {
		const previousItems = this.#visibleItems;
		const previousSelectedIndex = this.#selectedIndex;
		const previousSelected = previousItems[previousSelectedIndex];
		const query = this.#searchInput.getValue();
		let items: ModelBrowserItem[];
		if (query.trim()) {
			// Match against the displayed "provider/id" string so the user can
			// type what they see: bare names, provider prefixes, or scoped
			// queries all flow through the same fuzzy matcher.
			const ranked = fuzzyRank(this.#baseItems, query, ({ provider, id }) => `${provider}/${id}`);
			const matches = ranked.map(result => result.item);
			if (this.#preserveQueryOrder) {
				items = matches;
			} else {
				// Exact and contiguous text matches remain ahead of fuzzy-only
				// candidates. Within each relevance tier: models the user
				// assigned to a role or used recently, then providers the user
				// configured, assigned, or used recently, then fuzzy quality,
				// then the normal MRU/version ordering.
				sortModelItems(matches, { roles: this.#roles, mruOrder: this.#mruOrder, skipRoleRank: true });
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
						(this.#affinity.models.get(a.selector.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
						(this.#affinity.models.get(b.selector.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
					if (modelCmp !== 0) return modelCmp;

					const providerCmp =
						(this.#affinity.providers.get(a.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
						(this.#affinity.providers.get(b.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
					if (providerCmp !== 0) return providerCmp;

					const bucketCmp =
						(aSearch?.bucket ?? Number.MAX_SAFE_INTEGER) - (bSearch?.bucket ?? Number.MAX_SAFE_INTEGER);
					if (bucketCmp !== 0) return bucketCmp;
					return (
						(fallbackRanks.get(a) ?? Number.MAX_SAFE_INTEGER) - (fallbackRanks.get(b) ?? Number.MAX_SAFE_INTEGER)
					);
				});
				items = matches;
			}
		} else {
			items = this.#baseItems;
		}
		this.#visibleItems = this.#insertSeparator(items);
		if (
			selection === "reset-changed-prefix" &&
			previousSelected &&
			this.#hasStableChoicePrefix(previousItems, previousSelectedIndex)
		) {
			const selectedIndex = this.#visibleItems.findIndex(item => item.selector === previousSelected.selector);
			this.#selectedIndex = this.#coerceSelectedIndex(selectedIndex);
		} else if (selection === "reset-changed-prefix") {
			this.#selectedIndex = this.#coerceSelectedIndex(0);
		} else {
			this.#selectedIndex = this.#coerceSelectedIndex(Math.min(this.#selectedIndex, this.#visibleItems.length - 1));
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
			this.moveSelection(-this.#visibleItems.length, { wrap: false });
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveSelection(this.#visibleItems.length, { wrap: false });
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
		const item = index !== null ? this.#visibleItems[index] : undefined;
		if (index === null || !item) return;
		// Settings idiom: click selects, click-again activates.
		if (index === this.#selectedIndex) {
			this.onActivate?.(item);
		} else {
			this.#setSelectedIndex(index);
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
		const item = this.#visibleItems[index];
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

		// Metric columns collapse independently when no visible row has data.
		const intelligenceCol =
			intelligenceWidth > 0
				? `${theme.fg("dim", padLeftVisible(formatIntelligence(item.model), intelligenceWidth))}  `
				: "";
		const perfCol =
			perfWidth > 0 ? `${theme.fg("dim", padLeftVisible(this.#perfCell(item, perfMode), perfWidth))}  ` : "";
		const meta = `${intelligenceCol}${perfCol}${theme.fg("dim", padLeftVisible(formatContext(item.model), ctxWidth))}  ${theme.fg("dim", padLeftVisible(formatCostPair(item.model), costWidth))}`;
		const metaWidth =
			ctxWidth +
			costWidth +
			2 +
			(intelligenceWidth > 0 ? intelligenceWidth + 2 : 0) +
			(perfWidth > 0 ? perfWidth + 2 : 0);
		const available = Math.max(1, width - metaWidth - 1);
		left = truncateToWidth(left, available);
		const gap = Math.max(0, available - visibleWidth(left));

		let line = `${left}${" ".repeat(gap)} ${meta}`;
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
		facts.push(`${formatCostPair(model)} per M`);
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
			if (getRoleInfo(role, this.#settings).hidden) return;
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

		const total = this.#visibleItems.length;
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
				const item = this.#visibleItems[i];
				if (!item) continue;
				ctxWidth = Math.max(ctxWidth, visibleWidth(formatContext(item.model)));
				costWidth = Math.max(costWidth, visibleWidth(formatCostPair(item.model)));
				if (perfMode !== "off") {
					intelligenceWidth = Math.max(intelligenceWidth, visibleWidth(formatIntelligence(item.model)));
				}
				perfWidth = Math.max(perfWidth, visibleWidth(this.#perfCell(item, perfMode)));
			}

			const rows: string[] = [];
			for (let i = startIndex; i < endIndex; i++) {
				const item = this.#visibleItems[i];
				if (!item) continue;
				rows.push(
					this.#renderRow(
						item,
						width - 1,
						i === this.#selectedIndex,
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
}
