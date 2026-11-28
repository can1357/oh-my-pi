/**
 * The /models hub's state: a sidebar of scopes (Roles, All models, one entry
 * per provider — signed-out providers too, dimmed) beside either a model list
 * ({@link ModelBrowserState}) or the Roles view, which manages assignments,
 * retry fallback chains, the ctrl+p cycle and presets.
 *
 * Arrow keys belong to one pane (`focus`): the sidebar hops scopes, the list
 * moves rows; Tab flips, ←/→ move between them, typing searches the catalog
 * (provider entries without matches dim and the hop skips them). Picking a
 * model opens a chip strip of the roles it can fill (and fallback chains);
 * assigning a role then offers its thinking levels. A footer name field
 * creates a role, saves a preset or sets a model's compaction limit.
 *
 * Every view reads it reactively through {@link ModelHubState.version}; the
 * terminal look is `styles/pickers/model-hub`, the native tree `model-hub.tsx`.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { MODEL_KINDS, type ModelKind, modelKind } from "@oh-my-pi/pi-catalog/types";
import { batch, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { errorMessage } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatModelSelectorValue, parseModelString, splitUpstreamRouting } from "../../../config/model-selector";
import { providerAccessOff, providerManageUrl, providerRequiredScope } from "@oh-my-pi/pi-catalog/compat/auth";
import { connectedProviderName } from "../../../modes/view-model/chrome/format";
import {
	buildSessionModelScope,
	ModelSearchIndex,
	type ModelBrowserItem,
	type ModelRoleLookup,
	type ResolvedModelRoleValue,
	type RoleAssignments,
	scopedRolePool,
} from "../../../modes/view-model/overlays/model-browser";
import type {
	ModelHubCallbacks,
	ModelHubOptions,
	ModelHubRegistry,
	ModelHubSource,
	ModelRoleSelectionScope,
	ScopedModelItem,
} from "../../../modes/view-model/overlays/model-hub";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata } from "../../../thinking/levels";
import { END_SLICE, runSlicedWork, type SlicedWork } from "../../../utils/sliced-work";
import type { ConfiguredThinkingLevel } from "../../../utils/render-utils";
import { hubGeometry } from "../../styles/pickers/hub-frame";
import { editLine, type LineState } from "../settings/line-edit";
import { glyph, ModelBrowserState, thinkingGlyph } from "./model-browser-state";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";

/** A Roles-view row: a role, a model/wildcard chain header, a chain entry, or a "+ New …" row. */
export type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "separator" }
	| { kind: "newFallback" }
	| { kind: "newRole" };

/** What the model list is picking for: a role's model, a fallback slot, or a new chain's protected model. */
type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" };

/** A sidebar scope. */
export interface SidebarEntry {
	readonly id: string;
	readonly kind: "recent" | "roles" | "all" | "separator" | "provider";
	readonly label: string;
	readonly annotation?: string;
	readonly providerId?: string;
	readonly locked?: boolean;
	readonly oauth?: boolean;
	readonly catalogCount?: number;
}

/** A chip of the footer strip. */
export interface StripChip {
	readonly label: string;
	readonly action: "assign" | "unassign" | "fallback" | "fallbackModel" | "fallbackProvider" | "scope" | "thinking";
	readonly role?: string;
	readonly thinkingLevel?: ConfiguredThinkingLevel;
	readonly scope?: ModelRoleSelectionScope;
}

/** The footer strip: chips to pick from, or a name field. */
export type StripState =
	| {
			kind: "role" | "scope" | "thinking";
			item: ModelBrowserItem;
			chips: StripChip[];
			index: number;
			role?: string;
			/** A thinking strip editing a fallback-chain entry instead of a role. */
			fallbackIndex?: number;
			scope?: ModelRoleSelectionScope;
			/** Land back on the Roles view when a scope or thinking strip closes. */
			returnToRoles: boolean;
			/** The thinking level already committed. */
			initialThinkingLevel?: ConfiguredThinkingLevel;
	  }
	| { kind: "name"; purpose: "role" | "preset"; field: LineState }
	| {
			kind: "name";
			purpose: "compaction";
			model: Model;
			field: LineState;
			error?: string;
			/** The warning a second Enter on the same `value` accepts. */
			confirm?: { value: string; message: string };
	  };

/** A Roles-view command (keys and action buttons share it). */
export type RolesAction =
	| "pick"
	| "clear"
	| "fallback"
	| "cycle"
	| "earlier"
	| "later"
	| "new"
	| "thinking"
	| "compaction"
	| "save"
	| "nextPreset"
	| "prevPreset";

/** Letter keys of the Roles view. */
const ROLES_ACTION_KEYS: Readonly<Record<string, RolesAction>> = {
	x: "clear",
	f: "fallback",
	c: "cycle",
	"[": "earlier",
	"]": "later",
	n: "new",
	t: "thinking",
	k: "compaction",
	s: "save",
	// Letter twins of ctrl+←/→, which macOS reserves for switching Spaces.
	p: "nextPreset",
	P: "prevPreset",
};

export const MODEL_KIND_TABS: ReadonlyArray<"all" | ModelKind> = ["all", ...MODEL_KINDS];
export const ROLE_TABS = ["all", "chat", "kind"] as const;
export type RoleTab = (typeof ROLE_TABS)[number];

/** Kind tab labels. */
export const MODEL_KIND_LABELS: Readonly<Record<"all" | ModelKind, string>> = {
	all: "All",
	chat: "Chat",
	tiny: "Tiny",
	image: "Image",
	tts: "TTS",
	stt: "STT",
	search: "Search",
	judge: "Judge",
	embedding: "Embedding",
	rerank: "Rerank",
	video: "Video",
};

/** Accepted compaction-limit input, shown beside the field. */
export const COMPACTION_INPUT_HINT = "400k base · f400k fixed · 80% · empty resets";
const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const RECENT_LIMIT = 15;
/** Stable key of a Roles-view row (picker item id). */
export function rolesRowKey(row: RolesRow, index: number): string {
	switch (row.kind) {
		case "role":
			return `role:${row.role}`;
		case "chainKey":
			return `chain:${row.role}`;
		case "fallback":
			return `fallback:${row.role}:${row.chainIndex}`;
		case "separator":
			return `sep:${index}`;
		case "newRole":
		case "newFallback":
			return row.kind;
	}
}

/** Providers already auto-refreshed this process (selecting one fetches its list at most once; F5 forces). */
const autoRefreshedProviders = new Set<string>();

/** Test hook: forget which providers were auto-refreshed. */
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

/** Whether the compaction field still holds the text its pending warning was raised for. */
export function compactionConfirmPending(strip: Extract<StripState, { purpose: "compaction" }>): boolean {
	return strip.confirm !== undefined && strip.confirm.value === strip.field.text;
}

/** The printable text of a key, when it types one. */
function printable(key: KeyEvent): string | undefined {
	const text = key.text;
	return text !== undefined && text !== "" && !/[\x00-\x1f\x7f]/.test(text) ? text : undefined;
}

/** The hub state. */
export class ModelHubState {
	readonly source: ModelHubSource;
	readonly registry: ModelHubRegistry;
	readonly callbacks: ModelHubCallbacks;
	readonly browser: ModelBrowserState;
	/** Bumped on every change a view shows; views read it to follow the state. */
	readonly #version = signal(0);
	readonly #rows: () => number;

	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#roles: RoleAssignments = {};
	readonly #searchIndex = new ModelSearchIndex();
	#availableItems: ModelBrowserItem[] = [];
	#recentItems: ModelBrowserItem[] = [];
	#recentSelectors: ReadonlySet<string> = new Set();
	#candidateItems: ModelBrowserItem[] = [];
	#modelKindTab: "all" | ModelKind = "all";
	#roleTab: RoleTab = "all";
	#configError: string | undefined;

	#entries: SidebarEntry[] = [];
	#fixedEntries: SidebarEntry[] = [];
	#unlockedProviders: SidebarEntry[] = [];
	#lockedProviders: SidebarEntry[] = [];
	#recentSearchCount = 0;
	#searchTotal = 0;
	/** Per-provider match counts while a query is live; null otherwise. */
	#searchCounts: Map<string, number> | null = null;
	#activeEntryId = "all";
	#sidebarScroll = 0;
	#sidebarHover: number | null = null;
	/** Arrow-key ownership: the sidebar (`scope`) or the rows (`list`). */
	#focus: "scope" | "list" = "scope";

	#rolesRows: RolesRow[] = [];
	#roleIndex = 0;
	#roleHover: number | null = null;
	#roleScrollStart = 0;

	#assigning: AssignTarget | null = null;
	#strip: StripState | null = null;
	#assignmentPending = false;
	/** The role the last hub assign wrote and its row: a repeat Enter there must not toggle it off. */
	#committed: { selector: string; role: string; scope: ModelRoleSelectionScope | undefined } | null = null;
	#presetCursor: { name: string; revision: number } | undefined;
	#disposed = false;

	#refreshingProviders = new Set<string>();
	#scheduledRefreshes = new Map<string, Timer>();
	#pendingCredentialRefreshes = new Set<string>();
	#currentSelector: string | undefined;
	/** The opening freshness check is in flight (an empty scope shows as loading). */
	#catalogRefreshing = false;

	constructor(
		source: ModelHubSource,
		registry: ModelHubRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelHubCallbacks,
		options: ModelHubOptions & { terminalRows?: () => number } = {},
	) {
		this.source = source;
		this.registry = registry;
		this.callbacks = callbacks;
		this.#scopedModels = scopedModels;
		this.#currentSelector = options.currentSelector;
		this.#rows = options.terminalRows ?? (() => 40);
		this.browser = new ModelBrowserState(source, {
			emptyText: () => this.emptyStateMessage(),
			searchIndex: this.#searchIndex,
		});
		this.browser.onActivate = item => this.#activateItem(item);
		this.browser.onCancel = () => this.callbacks.onCancel();
		this.browser.onQueryChange = query => this.#onQueryChanged(query);
		this.browser.onSelectionChange = item => {
			if (item?.selector !== this.#committed?.selector) this.#committed = null;
		};

		// Read the catalog as it is now, so the first Enter acts on cached models.
		this.#sync();
		const initial = options.initialProviderId;
		this.#setActiveEntry(
			initial && this.#entries.some(entry => entry.providerId === initial) ? `provider:${initial}` : "all",
		);

		// An explicit --models scope does not depend on catalog freshness.
		if (this.#scopedModels.length === 0) {
			this.#catalogRefreshing = true;
			this.registry
				.refreshIfStale()
				.then(changed => {
					if (changed) return this.#afterRegistryRefresh();
				})
				.catch(error => {
					this.#configError = errorMessage(error);
				})
				.finally(() => {
					this.#catalogRefreshing = false;
					this.#bump();
				});
		}
	}

	/** Cancel pending provider refreshes (the host calls this when the hub closes). */
	dispose(): void {
		this.#disposed = true;
		for (const timer of this.#scheduledRefreshes.values()) clearTimeout(timer);
		this.#scheduledRefreshes.clear();
		this.#refreshingProviders.clear();
		this.#pendingCredentialRefreshes.clear();
	}

	// ─── Reads ──────────────────────────────────────────────────────────────

	/** Read inside a view to follow every change. */
	version(): number {
		return this.#version();
	}

	/** Rows the hub's content takes (between the title row and the footer divider). */
	contentRows(): number {
		return Math.max(10, Math.max(16, this.#rows()) - 4);
	}

	get entries(): readonly SidebarEntry[] {
		return this.#entries;
	}

	get activeEntryId(): string {
		return this.#activeEntryId;
	}

	get focus(): "scope" | "list" {
		return this.#focus;
	}

	get strip(): StripState | null {
		return this.#strip;
	}

	get assigning(): AssignTarget | null {
		return this.#assigning;
	}

	get assignmentPending(): boolean {
		return this.#assignmentPending;
	}

	get configError(): string | undefined {
		return this.#configError;
	}

	get roles(): RoleAssignments {
		return this.#roles;
	}

	get rolesRows(): readonly RolesRow[] {
		return this.#rolesRows;
	}

	get roleIndex(): number {
		return this.#roleIndex;
	}

	get roleHover(): number | null {
		return this.#roleHover;
	}

	get roleTab(): RoleTab {
		return this.#roleTab;
	}

	get modelKindTab(): "all" | ModelKind {
		return this.#modelKindTab;
	}

	get availableItems(): readonly ModelBrowserItem[] {
		return this.#availableItems;
	}

	get candidateItems(): readonly ModelBrowserItem[] {
		return this.#candidateItems;
	}

	get recentItems(): readonly ModelBrowserItem[] {
		return this.#recentItems;
	}

	get scoped(): boolean {
		return this.#scopedModels.length > 0;
	}

	get currentSelector(): string | undefined {
		return this.#currentSelector;
	}

	get catalogRefreshing(): boolean {
		return this.#catalogRefreshing;
	}

	get searchCounts(): ReadonlyMap<string, number> | null {
		return this.#searchCounts;
	}

	get searchTotal(): number {
		return this.#searchTotal;
	}

	get recentSearchCount(): number {
		return this.#recentSearchCount;
	}

	get sidebarHover(): number | null {
		return this.#sidebarHover;
	}

	isRefreshing(providerId: string | undefined): boolean {
		return providerId !== undefined && this.#refreshingProviders.has(providerId);
	}

	activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0]!;
	}

	/** The Roles view is showing (not picking a model for it). */
	rolesView(): boolean {
		return this.activeEntry().kind === "roles" && this.#assigning === null;
	}

	/** A signed-out provider's pane is showing. */
	lockedView(): boolean {
		const entry = this.activeEntry();
		return entry.kind === "provider" && entry.locked === true && this.#assigning === null;
	}

	/** Whether `entry` shows the model list. */
	isBrowserView(entry: SidebarEntry): boolean {
		if (this.#assigning !== null) return true;
		return entry.kind === "recent" || entry.kind === "all" || (entry.kind === "provider" && !entry.locked);
	}

	visibleRoleIds(): string[] {
		return this.source.knownRoleIds.filter(role => !this.source.getRoleInfo(role).hidden);
	}

	/** First sidebar entry drawn: follows the active entry, clamped to the list. */
	sidebarScroll(): number {
		return Math.max(0, Math.min(this.#sidebarScroll, Math.max(0, this.#entries.length - this.contentRows())));
	}

	/** Roles rows the view shows at once (one less when an overflow line is needed). */
	rolesWindow(): { start: number; end: number; overflow: boolean } {
		const total = this.#rolesRows.length;
		// The pane: status row, tabs row, rows, the overflow line, the cycle line.
		const capacity = Math.max(0, this.contentRows() - 1 - 2 - 1);
		const overflow = total > capacity;
		const height = overflow ? Math.max(0, capacity - 1) : capacity;
		let start = this.#roleScrollStart;
		if (height > 0) {
			if (this.#roleIndex < start) start = this.#roleIndex;
			else if (this.#roleIndex >= start + height) start = this.#roleIndex - height + 1;
			start = Math.max(0, Math.min(start, Math.max(0, total - height)));
		} else start = 0;
		return { start, end: Math.min(start + height, total), overflow };
	}

	/** The fallback chains with malformed keys and entries dropped. */
	fallbackChains(): Record<string, string[]> {
		try {
			const chains = this.source.fallbackChains;
			if (!chains || typeof chains !== "object" || Array.isArray(chains)) return {};
			const clean: Record<string, string[]> = {};
			for (const key in chains) {
				const chain: unknown = chains[key];
				if (Array.isArray(chain)) clean[key] = chain.filter((entry): entry is string => typeof entry === "string");
			}
			return clean;
		} catch {
			return {};
		}
	}

	cycleOrder(): string[] {
		try {
			return [...this.source.cycleOrder];
		} catch {
			return [];
		}
	}

	/** Saved presets and the one the setup matches; empty unless the host can both list and switch. */
	presets(): { names: readonly string[]; active: string | undefined } {
		if (!this.callbacks.onSwitchPreset || !this.source.getModelPresets) return { names: [], active: undefined };
		return this.source.getModelPresets();
	}

	/** Rows the Roles view lists on the All tab (separators aside): the picker's `total`. */
	allRolesRowCount(): number {
		const chains = this.fallbackChains();
		let count = 2;
		for (const role of this.visibleRoleIds()) count += 1 + (chains[role]?.length ?? 0);
		for (const key in chains) if (key.includes("/")) count += 1 + chains[key]!.length;
		return count;
	}

	/** Thinking levels a role assignment can apply to `model` (none when it does not reason). */
	thinkingOptionsFor(model: Model): ConfiguredThinkingLevel[] {
		if (!model.reasoning) return [];
		if (model.thinking?.unverified) return [ThinkingLevel.Inherit, ThinkingLevel.Off, ...getSupportedEfforts(model)];
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
	}

	/** What `t` on a role row edits: the role's model in its persisted scope; undefined when inert. */
	roleThinkingTarget(role: string): { item: ModelBrowserItem; scope?: ModelRoleSelectionScope } | undefined {
		const assignment = this.#roles[role];
		if (!assignment) return undefined;
		const origin = this.source.modelRoleStorage === "project" ? this.source.getModelRoleSource(role) : "default";
		const scope = origin === "project" || origin === "global" ? origin : undefined;
		const model = scope ? this.#roleForScope(role, scope).model : assignment.model;
		if (!model || this.thinkingOptionsFor(model).length === 0) return undefined;
		return { item: itemOf(model), scope };
	}

	/** The model a Roles row resolves to, whose compaction point `k` edits. */
	roleRowModel(): Model | undefined {
		const row = this.#rolesRows[this.#roleIndex];
		if (row?.kind === "role") return this.#roles[row.role]?.model;
		if (row?.kind === "fallback") return this.resolveFallbackEntry(row.role, row.chainIndex)?.item.model;
		return undefined;
	}

	/** A fallback entry's model, explicit effort and routing; undefined for wildcards and unknown models. */
	resolveFallbackEntry(
		role: string,
		index: number,
	):
		| { item: ModelBrowserItem; thinkingLevel: ConfiguredThinkingLevel | undefined; upstream: string | undefined }
		| undefined {
		const raw = this.fallbackChains()[role]?.[index];
		if (!raw || raw.endsWith("/*")) return undefined;
		const parsed = this.#parseFallbackEntry(raw);
		if (!parsed) return undefined;
		const item = this.#findFallbackModel(parsed.provider, parsed.id);
		if (!item) return undefined;
		return { item, thinkingLevel: parsed.thinkingLevel, upstream: parsed.upstream };
	}

	/** The empty list's text in the active scope (with its indent); undefined for the default. */
	emptyStateMessage(): string | undefined {
		if (this.#configError) return `  ${this.#configError}`;
		const entry = this.activeEntry();
		if (entry.kind === "recent") return "  No recently used models yet";
		if (entry.kind !== "provider" || entry.locked) return undefined;
		if (this.browser.query.trim()) {
			return `  No matching models in ${entry.label}. Switch to All models to search every provider.`;
		}
		const state = this.registry.getProviderDiscoveryState(entry.providerId ?? "");
		if (!state) return undefined;
		const age = discoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable": {
				const http = state.error?.match(/^HTTP (\d+) from (.+)$/);
				if (http?.[1] === "404") {
					return `  Discovery endpoint ${http[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
				}
				if (state.error) return `  Discovery failed: ${state.error}`;
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			}
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "empty":
				return "  Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
			case "ok":
				return undefined;
		}
	}

	/**
	 * Whether `providerId` is signed in with its access off: every stored login
	 * lacks the provider's `required-scope` (declined, or turned off at the host).
	 */
	accessOff(providerId: string): boolean {
		if (providerRequiredScope(providerId) === undefined) return false;
		const scopes = this.registry.authStorage.credentials
			.list(providerId)
			.flatMap(({ credential }) => (credential.type === "oauth" ? [credential.scope] : []));
		return scopes.length > 0 && scopes.every(scope => providerAccessOff(providerId, scope));
	}

	/** The signed-in provider pane's `manage-url`, where the user turns its access on or off at the host. */
	manageUrl(entry: SidebarEntry = this.activeEntry()): string | undefined {
		if (entry.kind !== "provider" || entry.locked || !entry.providerId) return undefined;
		return providerManageUrl(entry.providerId);
	}

	/** How a signed-out provider signs in. */
	lockedMessage(entry: SidebarEntry): string {
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		const how =
			envVars.length > 0
				? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
				: "Add an API key for this provider in config.";
		return `${entry.label} has no credentials configured. ${how}`;
	}

	/** Env vars that sign a provider in. */
	envVarsOf(providerId: string | undefined): readonly string[] {
		return providerId ? (providerEntry(providerId)?.envVars ?? []) : [];
	}

	/** Catalog models of a signed-out provider (none in a --models scope). */
	lockedCatalog(entry: SidebarEntry): Model[] {
		if (this.scoped) return [];
		return this.registry.getAll("all").filter(model => model.provider === entry.providerId);
	}

	/** A strip chip's spans (`symbol` resolves glyphs: the theme's in the terminal). */
	chipSpans(chip: StripChip, symbol: (key: string) => string = glyph): TspSpan[] {
		switch (chip.action) {
			case "assign":
			case "unassign": {
				const color = this.source.getRoleInfo(chip.role ?? "").color ?? "muted";
				return chip.action === "unassign"
					? [
							{ s: color, t: `${symbol("status.enabled")} ${chip.label}` },
							{ s: "dim", t: ` ${symbol("status.success")}` },
						]
					: [{ s: color, t: chip.label }];
			}
			case "scope":
				return [{ s: chip.scope === "project" ? "accent" : "muted", t: chip.label }];
			case "thinking": {
				const level = chip.thinkingLevel === undefined ? "" : thinkingGlyph(chip.thinkingLevel);
				return level ? [{ s: "accent", t: level }, { t: ` ${chip.label}` }] : [{ t: chip.label }];
			}
			default:
				return [{ s: "muted", t: chip.action === "fallback" ? "retry-fallback" : chip.label }];
		}
	}

	// ─── Data pipeline ──────────────────────────────────────────────────────

	#bump(): void {
		this.browser.setFocused(this.#focus === "list");
		this.#version.update(v => v + 1);
	}

	#sync(): void {
		const anchorIndex = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		const anchor = { id: this.#activeEntryId, index: anchorIndex, offset: anchorIndex - this.#sidebarScroll };
		const scope = buildSessionModelScope(
			this.source,
			this.registry,
			this.#scopedModels.map(entry => entry.model),
		);
		this.#configError = scope.error;
		this.#roles = scope.roles;
		this.#buildRolesRows();

		const { mruOrder } = scope;
		if (this.#availableItems !== scope.availableItems) {
			this.#availableItems = scope.availableItems;
			void runSlicedWork(this.#warmSearch(this.#availableItems));
		}
		this.browser.setRoles(this.#roles);
		this.browser.setMruOrder(mruOrder);
		this.browser.setPerfStats(this.source.modelPerf);
		const bySelector = new Map(this.#availableItems.map(item => [item.selector, item]));
		this.#recentItems = [];
		for (const key of mruOrder) {
			const item = bySelector.get(key);
			if (item) this.#recentItems.push(item);
			if (this.#recentItems.length >= RECENT_LIMIT) break;
		}
		this.#recentSelectors = new Set(this.#recentItems.map(item => item.selector));
		this.#buildSidebar(scope.catalogModels, scope.availableItems);
		// A background rebuild keeps the focused entry's screen row (or its nearest survivor's).
		if (anchor.index >= 0) {
			const survivor = this.#entries.findIndex(entry => entry.id === anchor.id);
			if (survivor >= 0) this.#sidebarScroll = Math.max(0, survivor - anchor.offset);
			else {
				const replacement = this.#nearestNavigableEntry(anchor.index);
				if (replacement) {
					this.#activeEntryId = replacement.id;
					this.#sidebarScroll = Math.max(0, this.#entries.indexOf(replacement) - anchor.offset);
				}
			}
		}
		this.#applyScope();
		this.#bump();
	}

	#buildSidebar(allModels: ReadonlyArray<Model>, availableItems: ReadonlyArray<ModelBrowserItem>): void {
		let disabled: ReadonlySet<string>;
		try {
			disabled = new Set(this.source.disabledProviders);
		} catch {
			disabled = new Set();
		}
		const available = new Map<string, number>();
		for (const item of availableItems) available.set(item.provider, (available.get(item.provider) ?? 0) + 1);
		const catalog = new Map<string, number>();
		for (const model of allModels) catalog.set(model.provider, (catalog.get(model.provider) ?? 0) + 1);

		const unlocked = new Set<string>(available.keys());
		const locked = new Set<string>();
		if (!this.scoped) {
			for (const provider of catalog.keys())
				if (!unlocked.has(provider) && !disabled.has(provider)) locked.add(provider);
			for (const provider of this.registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabled.has(provider)) continue;
				// Keyless discoverable endpoints surface so discovery can fill them; catalog providers without auth stay locked.
				const authenticated = this.registry.authStorage.keys.source(provider) !== undefined;
				if (!authenticated && locked.has(provider)) continue;
				if (!authenticated) {
					// Implicit local endpoints stay hidden until discovery reaches a server.
					const discovery = this.registry.getProviderDiscoveryState(provider);
					if (discovery?.optional && (discovery.status === "idle" || discovery.status === "unavailable")) continue;
				}
				locked.delete(provider);
				unlocked.add(provider);
			}
		}
		const oauth = new Set(getOAuthProviders().map(provider => provider.id));
		const providerEntryOf = (providerId: string, isLocked: boolean): SidebarEntry => ({
			id: `provider:${providerId}`,
			kind: "provider",
			// A locked provider has no linked account yet, so only unlocked ones take the connected name.
			label: isLocked
				? providerId
				: `${connectedProviderName(providerId)}${this.accessOff(providerId) ? " (off)" : ""}`,
			providerId,
			locked: isLocked,
			...(isLocked ? {} : { annotation: String(available.get(providerId) ?? 0) }),
			oauth: oauth.has(providerId),
			catalogCount: catalog.get(providerId) ?? 0,
		});
		const visibleRoles = this.visibleRoleIds();
		let assigned = 0;
		for (const role of visibleRoles) {
			const assignment = this.#roles[role];
			if (assignment && !assignment.autoSelected) assigned++;
		}
		// Roles leads, so downward hops head into model scopes.
		this.#fixedEntries = [
			{ id: "roles", kind: "roles", label: "Roles", annotation: `${assigned}/${visibleRoles.length}` },
			{ id: "all", kind: "all", label: "All models", annotation: String(availableItems.length) },
		];
		this.#unlockedProviders = [...unlocked].sort((a, b) => a.localeCompare(b)).map(id => providerEntryOf(id, false));
		this.#lockedProviders = [...locked].sort((a, b) => a.localeCompare(b)).map(id => providerEntryOf(id, true));
		this.#composeEntries();
	}

	/** Assemble the sidebar; while searching, providers with matches float up (each group alphabetical). */
	#composeEntries(): void {
		const counts = this.#searchCounts;
		let providers = this.#unlockedProviders;
		if (counts) {
			providers = [...providers].sort((a, b) => {
				const aMatched = (counts.get(a.providerId ?? "") ?? 0) > 0;
				const bMatched = (counts.get(b.providerId ?? "") ?? 0) > 0;
				if (aMatched !== bMatched) return aMatched ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
		}
		const entries: SidebarEntry[] = [...this.#fixedEntries];
		if (providers.length > 0) entries.push({ id: "sep:providers", kind: "separator", label: "" }, ...providers);
		if (this.#lockedProviders.length > 0)
			entries.push({ id: "sep:locked", kind: "separator", label: "" }, ...this.#lockedProviders);
		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) {
			this.#activeEntryId = "all";
			this.#followSidebar();
		}
	}

	#nearestNavigableEntry(preferred: number): SidebarEntry | undefined {
		const entries = this.#entries;
		if (entries.length === 0) return undefined;
		const start = Math.max(0, Math.min(preferred, entries.length - 1));
		for (let radius = 0; radius < entries.length; radius++) {
			for (const index of radius === 0 ? [start] : [start + radius, start - radius]) {
				const entry = entries[index];
				if (entry && !this.#isHopSkipped(entry)) return entry;
			}
		}
		return undefined;
	}

	/** Scroll the sidebar just enough to show the active entry. */
	#followSidebar(): void {
		const index = Math.max(
			0,
			this.#entries.findIndex(entry => entry.id === this.#activeEntryId),
		);
		const rows = this.contentRows();
		if (index < this.#sidebarScroll) this.#sidebarScroll = index;
		else if (index >= this.#sidebarScroll + rows) this.#sidebarScroll = index - rows + 1;
		this.#sidebarScroll = this.sidebarScroll();
	}

	#setActiveEntry(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#activeEntryId = id;
		this.#committed = null;
		this.#followSidebar();
		this.#applyScope();
		const entry = this.activeEntry();
		// Hops never steal arrow focus; diving into rows is explicit.
		this.#focus = "scope";
		if (entry.kind === "provider" && !entry.locked) this.#scheduleProviderRefresh(entry.providerId ?? "");
		this.#cancelScheduledRefreshesExcept(entry.kind === "provider" ? entry.providerId : undefined);
	}

	#applyScope(): void {
		const entry = this.activeEntry();
		switch (entry.kind) {
			case "recent":
				this.browser.setShowProvider(true);
				this.#setCandidateItems(this.#recentItems);
				break;
			case "provider":
				if (entry.locked) {
					this.#setCandidateItems([]);
					break;
				}
				this.browser.setShowProvider(false);
				this.#setCandidateItems(this.#availableItems.filter(item => item.provider === entry.providerId));
				break;
			case "roles":
				this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
				break;
			default:
				this.browser.setShowProvider(true);
				this.#setCandidateItems(this.#availableItems);
				break;
		}
	}

	/** Reapply assignment eligibility after every scope change, before the kind tab filter. */
	#setCandidateItems(items: ReadonlyArray<ModelBrowserItem>): void {
		const assigning = this.#assigning;
		if (assigning) {
			// Model and provider keys protect chat sessions; named chains follow their role.
			const role =
				assigning.kind === "fallbackKey" || (assigning.kind === "fallback" && assigning.role.includes("/"))
					? "default"
					: assigning.role;
			const { accepts } = this.source.getRoleInfo(role);
			this.#candidateItems = items.filter(item => accepts(item.model));
		} else this.#candidateItems = [...items];
		this.#applyModelKind();
	}

	#applyModelKind(): void {
		const kind = this.#modelKindTab;
		this.browser.setItems(
			kind === "all"
				? [...this.#candidateItems]
				: this.#candidateItems.filter(item => modelKind(item.model) === kind),
		);
	}

	/** The Roles rows: each visible role with its chain entries, then model-keyed chains. */
	#buildRolesRows(): void {
		const rows: RolesRow[] = [];
		const chains = this.fallbackChains();
		const appendRoles = (roles: ReadonlyArray<string>): void => {
			for (const role of roles) {
				rows.push({ kind: "role", role });
				const chain = chains[role] ?? [];
				for (let i = 0; i < chain.length; i++)
					rows.push({ kind: "fallback", role, chainIndex: i, selector: chain[i]! });
			}
		};
		const visible = this.visibleRoleIds();
		if (this.#roleTab === "all") {
			const chat = visible.filter(role => this.source.getRoleInfo(role).section === "chat");
			const kinds = visible.filter(role => this.source.getRoleInfo(role).section === "kind");
			appendRoles(chat);
			if (chat.length > 0 && kinds.length > 0) rows.push({ kind: "separator" });
			appendRoles(kinds);
		} else appendRoles(visible.filter(role => this.source.getRoleInfo(role).section === this.#roleTab));
		rows.push({ kind: "newRole" }, { kind: "separator" });
		for (const key of Object.keys(chains)
			.filter(key => key.includes("/"))
			.sort()) {
			const chain = chains[key] ?? [];
			rows.push({ kind: "chainKey", role: key });
			for (let i = 0; i < chain.length; i++)
				rows.push({ kind: "fallback", role: key, chainIndex: i, selector: chain[i]! });
		}
		rows.push({ kind: "newFallback" });
		this.#rolesRows = rows;
	}

	/** Re-read everything after settings changed outside the hub. */
	refreshAfterExternalMutation(): void {
		this.#sync();
	}

	*#warmSearch(items: readonly ModelBrowserItem[]): SlicedWork {
		yield END_SLICE; // Let the picker paint before indexing any rows.
		for (const item of items) {
			if (this.#disposed || items !== this.#availableItems) return;
			this.#searchIndex.warm(item);
			yield;
		}
	}

	/** Match counts per provider for the live query; a provider scope without matches falls back to All. */
	#onQueryChanged(query: string): void {
		if (!query.trim()) {
			this.#searchCounts = null;
			this.#composeEntries();
			this.#bump();
			return;
		}
		const prepared = this.#searchIndex.prepare(query);
		let total = 0;
		const counts = new Map<string, number>();
		let recent = 0;
		for (const item of this.#availableItems) {
			if (!this.#searchIndex.match(item, prepared).matches) continue;
			total++;
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
			if (this.#recentSelectors.has(item.selector)) recent++;
		}
		this.#recentSearchCount = recent;
		this.#searchTotal = total;
		this.#searchCounts = counts;
		this.#composeEntries();
		const entry = this.activeEntry();
		if (
			this.#assigning === null &&
			entry.kind === "provider" &&
			(entry.locked || (counts.get(entry.providerId ?? "") ?? 0) === 0)
		)
			this.#setActiveEntry("all");
		this.#bump();
	}

	/** Entries the scope hop skips: separators; while searching also Roles, an empty Recent, locked and matchless providers. */
	#isHopSkipped(entry: SidebarEntry): boolean {
		if (entry.kind === "separator") return true;
		const counts = this.#searchCounts;
		if (!counts) return false;
		if (entry.kind === "roles") return true;
		if (entry.kind === "recent") return this.#recentSearchCount === 0;
		if (entry.kind === "provider") return entry.locked === true || (counts.get(entry.providerId ?? "") ?? 0) === 0;
		return false;
	}

	// ─── Provider refresh ───────────────────────────────────────────────────

	#setProviderRefreshing(providerId: string, refreshing: boolean): void {
		if (refreshing) this.#refreshingProviders.add(providerId);
		else this.#refreshingProviders.delete(providerId);
	}

	#cancelScheduledRefreshesExcept(keep?: string): void {
		// Selection debounce only: an F5 queued behind an in-flight fetch still re-mints credentials.
		for (const [providerId, timer] of this.#scheduledRefreshes) {
			if (providerId === keep) continue;
			clearTimeout(timer);
			this.#scheduledRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleProviderRefresh(providerId: string, options?: { force?: boolean }): void {
		if (this.scoped || !providerId) return;
		const force = options?.force === true;
		if (force) {
			const pending = this.#scheduledRefreshes.get(providerId);
			if (pending) {
				// Selection queued a catalog-only fetch: F5 upgrades it.
				clearTimeout(pending);
				this.#scheduledRefreshes.delete(providerId);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProvider(providerId, true);
				return;
			}
			if (this.#refreshingProviders.has(providerId)) {
				this.#pendingCredentialRefreshes.add(providerId);
				return;
			}
		} else if (this.#scheduledRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) return;
		// Selecting a provider re-fetches at most once per process; F5 forces.
		if (!force && autoRefreshedProviders.has(providerId)) return;
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			// The once-guard is spent only when the fetch starts: hopping past cancels it.
			autoRefreshedProviders.add(providerId);
			this.#scheduledRefreshes.delete(providerId);
			void this.#refreshProvider(providerId, force);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		this.#scheduledRefreshes.set(providerId, timer);
	}

	async #afterRegistryRefresh(providerId?: string): Promise<void> {
		if (this.#disposed) return;
		const scope = await this.callbacks.onCatalogRefreshed?.(providerId);
		if (this.#disposed) return;
		if (scope) this.#scopedModels = scope;
		this.#sync();
	}

	async #refreshProvider(providerId: string, refreshCommandCredentials = false): Promise<void> {
		try {
			if (refreshCommandCredentials)
				await this.registry.refreshProvider(providerId, "online", { refreshCommandCredentials: true });
			else await this.registry.refreshProvider(providerId, "online");
			await this.#afterRegistryRefresh(providerId);
		} catch (error) {
			this.#configError = errorMessage(error);
		} finally {
			this.#setProviderRefreshing(providerId, false);
			if (!this.#disposed && this.#pendingCredentialRefreshes.delete(providerId)) {
				this.#setProviderRefreshing(providerId, true);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProvider(providerId, true);
			}
			this.#bump();
		}
	}

	// ─── Assignment ─────────────────────────────────────────────────────────

	#activateItem(item: ModelBrowserItem): void {
		batch(() => {
			const target = this.#assigning;
			if (target) {
				this.#assigning = null;
				if (target.kind === "role") this.#assignRole(item, target.role, true);
				else if (target.kind === "fallbackKey") this.#openFallbackKeyStrip(item);
				else this.#commitFallback(item, target);
			} else this.#openRoleStrip(item);
			this.#bump();
		});
	}

	#roleForScope(role: string, scope: ModelRoleSelectionScope): ResolvedModelRoleValue {
		const value = scope === "project" ? this.source.getProjectModelRole(role) : this.source.getGlobalModelRole(role);
		const allModels = this.scoped
			? scopedRolePool(
					this.#scopedModels.map(entry => entry.model),
					this.registry,
				)
			: this.registry.getAll("all");
		const lookup: ModelRoleLookup = {
			getModelRole: other =>
				scope === "project"
					? (this.source.getProjectModelRole(other) ?? this.source.getGlobalModelRole(other))
					: this.source.getGlobalModelRole(other),
		};
		return this.source.resolveRoleValue(value, allModels, lookup);
	}

	#thinkingLevelForScope(role: string, scope: ModelRoleSelectionScope): ConfiguredThinkingLevel {
		const resolved = this.#roleForScope(role, scope);
		return resolved.explicitThinkingLevel ? (resolved.thinkingLevel ?? ThinkingLevel.Inherit) : ThinkingLevel.Inherit;
	}

	/** Run `onSuccess` once a host write lands (a promise shows "Applying model…" meanwhile); `false` means refused. */
	#finishAssignment(result: void | boolean | Promise<void | boolean>, onSuccess: () => void): void {
		if (!(result instanceof Promise)) {
			if (result !== false) onSuccess();
			this.#bump();
			return;
		}
		this.#assignmentPending = true;
		this.#bump();
		void result.then(
			applied => {
				this.#assignmentPending = false;
				if (this.#disposed) return;
				if (applied !== false) onSuccess();
				this.#bump();
			},
			() => {
				this.#assignmentPending = false;
				if (!this.#disposed) this.#bump();
			},
		);
	}

	/** Persist `role → item` (keeping a still-supported thinking level), then offer its thinking levels. */
	#assignRole(item: ModelBrowserItem, role: string, returnToRoles: boolean, scope?: ModelRoleSelectionScope): void {
		if (this.source.modelRoleStorage === "project" && scope === undefined) {
			this.#strip = {
				kind: "scope",
				item,
				role,
				chips: [
					{ label: "project", action: "scope", scope: "project" },
					{ label: "global", action: "scope", scope: "global" },
				],
				index: 0,
				returnToRoles,
			};
			return;
		}
		const current = this.#roles[role];
		let level: ConfiguredThinkingLevel = ThinkingLevel.Inherit;
		if (this.source.modelRoleStorage === "project" && scope !== undefined)
			level = this.#thinkingLevelForScope(role, scope);
		else if (current && !current.autoSelected) level = current.thinkingLevel;
		const supported = this.thinkingOptionsFor(item.model);
		if (!supported.includes(level)) level = ThinkingLevel.Inherit;
		this.#finishAssignment(this.callbacks.onAssign(item.model, role, level, item.selector, scope), () => {
			this.#committed = { selector: item.selector, role, scope };
			this.#sync();
			if (supported.length === 0) {
				if (returnToRoles) {
					this.#setActiveEntry("roles");
					this.#focus = "list";
				}
				return;
			}
			this.#openThinkingStrip(item, role, returnToRoles, scope, level);
		});
	}

	#unassignRole(role: string): void {
		const assignment = this.#roles[role];
		if (!assignment || assignment.autoSelected) return;
		if (this.source.modelRoleStorage === "project") {
			const origin = this.source.getModelRoleSource(role);
			this.callbacks.onUnassign(role, origin === "default" ? undefined : origin);
		} else this.callbacks.onUnassign(role);
		this.#sync();
	}

	/** The roles `item` can fill (in each storage scope), then its fallback chains. */
	#openRoleStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [];
		const scopedStorage = this.source.modelRoleStorage === "project";
		const scopes: readonly ModelRoleSelectionScope[] = scopedStorage ? ["project", "global"] : ["global"];
		for (const role of this.visibleRoleIds()) {
			const info = this.source.getRoleInfo(role);
			if (!info.accepts(item.model)) continue;
			const assignment = this.#roles[role];
			for (const scope of scopes) {
				const model = scopedStorage
					? this.#roleForScope(role, scope).model
					: assignment && !assignment.autoSelected
						? assignment.model
						: undefined;
				const here = !!model && model.provider === item.model.provider && model.id === item.model.id;
				const roleLabel = (info.tag ?? info.name ?? role).toLowerCase();
				chips.push({
					label: scopedStorage ? `${scope} ${roleLabel}` : roleLabel,
					role,
					scope,
					action: here ? "unassign" : "assign",
				});
			}
		}
		if (this.source.getRoleInfo("default").accepts(item.model)) {
			chips.push(
				{ label: `fallbacks:${item.model.id}`, action: "fallbackModel" },
				{ label: `fallbacks:${item.model.provider}/*`, action: "fallbackProvider" },
				{ label: "fallback", action: "fallback" },
			);
		}
		if (chips.length === 0) return;
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	#openThinkingStrip(
		item: ModelBrowserItem,
		role: string,
		returnToRoles: boolean,
		scope?: ModelRoleSelectionScope,
		committed?: ConfiguredThinkingLevel,
	): void {
		const options = this.thinkingOptionsFor(item.model);
		const current =
			committed ??
			(this.source.modelRoleStorage === "project" && scope !== undefined
				? this.#thinkingLevelForScope(role, scope)
				: (this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit));
		const at = options.indexOf(current);
		this.#strip = {
			kind: "thinking",
			item,
			role,
			scope,
			chips: thinkingChips(options),
			index: at >= 0 ? at : 0,
			returnToRoles,
			initialThinkingLevel: current,
		};
	}

	/** Registry lookup (case-insensitive, alias-aware; signed-out providers too) of a fallback entry's model. */
	#findFallbackModel(provider: string, id: string): ModelBrowserItem | undefined {
		const model = this.registry.find(provider, id);
		return model ? itemOf(model) : undefined;
	}

	/** A chain entry's model, effort and `@upstream` routing (an exact literal id wins over routing). */
	#parseFallbackEntry(
		raw: string,
	):
		| { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel; upstream: string | undefined }
		| undefined {
		const trimmed = raw.trim();
		const parse = (pattern: string) =>
			parseModelString(pattern, {
				allowMaxSuffix: true,
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) => this.#findFallbackModel(provider, id) !== undefined,
			});
		const literal = parse(trimmed);
		if (literal && this.#findFallbackModel(literal.provider, literal.id)) return { ...literal, upstream: undefined };
		const routing = splitUpstreamRouting(trimmed);
		if (!routing) return literal ? { ...literal, upstream: undefined } : undefined;
		const parsed = parse(routing.base.trim());
		return parsed ? { ...parsed, upstream: routing.upstream } : undefined;
	}

	/** `t` on a chain entry: inherit, off and the model's efforts (wildcards always inherit). */
	#openFallbackThinkingStrip(row: { role: string; chainIndex: number }): void {
		const resolved = this.resolveFallbackEntry(row.role, row.chainIndex);
		if (!resolved) return;
		const options: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			...getSupportedEfforts(resolved.item.model),
		];
		const current =
			resolved.thinkingLevel === undefined || resolved.thinkingLevel === AUTO_THINKING
				? ThinkingLevel.Inherit
				: resolved.thinkingLevel;
		this.#strip = {
			kind: "thinking",
			item: resolved.item,
			role: row.role,
			fallbackIndex: row.chainIndex,
			chips: thinkingChips(options),
			index: Math.max(0, options.indexOf(current)),
			returnToRoles: true,
		};
	}

	/** Persist a chain entry's effort (inherit stored bare), in the registry's spelling with its routing. */
	#setFallbackThinking(role: string, index: number, level: ConfiguredThinkingLevel): void {
		const chain = [...(this.fallbackChains()[role] ?? [])];
		if (index >= chain.length) return;
		const resolved = this.resolveFallbackEntry(role, index);
		if (!resolved) return;
		const base = `${resolved.item.provider}/${resolved.item.id}`;
		const next = formatModelSelectorValue(resolved.upstream ? `${base}@${resolved.upstream}` : base, level);
		chain[index] = next;
		for (let i = chain.length - 1; i >= 0; i--) if (i !== index && chain[i] === next) chain.splice(i, 1);
		this.#setFallbackChain(role, chain);
		const at = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === role && row.selector === next,
		);
		if (at >= 0) this.#roleIndex = at;
	}

	#closeStrip(): void {
		const strip = this.#strip;
		this.#strip = null;
		if ((strip?.kind === "scope" || strip?.kind === "thinking") && strip.returnToRoles) {
			this.#setActiveEntry("roles");
			this.#focus = "list";
		}
	}

	/** Apply the selected strip chip. */
	activateStripChip(): void {
		const strip = this.#strip;
		if (!strip || strip.kind === "name") return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		switch (chip.action) {
			case "assign":
				if (chip.role) {
					this.#strip = null;
					this.#assignRole(strip.item, chip.role, false, chip.scope);
				}
				break;
			case "unassign": {
				const committed = this.#committed;
				// A repeat Enter on the row just committed is not a toggle back.
				const repeat =
					committed !== null &&
					committed.selector === strip.item.selector &&
					committed.role === chip.role &&
					committed.scope === chip.scope;
				if (chip.role && !repeat) {
					if (this.source.modelRoleStorage === "project") this.callbacks.onUnassign(chip.role, chip.scope);
					else this.callbacks.onUnassign(chip.role);
					this.#sync();
				}
				this.#closeStrip();
				break;
			}
			case "fallback": {
				const chain = [...(this.fallbackChains().default ?? [])];
				if (!chain.includes(strip.item.selector))
					this.#setFallbackChain("default", [...chain, strip.item.selector]);
				this.#closeStrip();
				break;
			}
			case "fallbackModel":
				this.#closeStrip();
				this.#startAssignFallback(strip.item.selector, null);
				break;
			case "fallbackProvider":
				this.#closeStrip();
				this.#startAssignFallback(`${strip.item.model.provider}/*`, null);
				break;
			case "scope":
				if (strip.role && chip.scope) {
					this.#strip = null;
					this.#assignRole(strip.item, strip.role, strip.returnToRoles, chip.scope);
				}
				break;
			case "thinking": {
				if (strip.role && chip.thinkingLevel !== undefined && strip.fallbackIndex !== undefined) {
					this.#setFallbackThinking(strip.role, strip.fallbackIndex, chip.thinkingLevel);
					this.#strip = null;
					break;
				}
				// The preselected level is confirmation; only a changed level writes.
				if (strip.role && chip.thinkingLevel !== undefined && chip.thinkingLevel !== strip.initialThinkingLevel) {
					const result = this.callbacks.onAssign(
						strip.item.model,
						strip.role,
						chip.thinkingLevel,
						strip.item.selector,
						strip.scope,
					);
					this.#closeStrip();
					this.#finishAssignment(result, () => this.#sync());
				} else this.#closeStrip();
				break;
			}
		}
		this.#bump();
	}

	/** Browse the whole catalog to assign `role` (its model preselected). */
	#startAssign(role: string): void {
		this.#assigning = { kind: "role", role };
		this.#startBrowsing();
		const current = this.#roles[role];
		if (current) this.browser.selectSelector(`${current.model.provider}/${current.model.id}`);
	}

	/** Browse to fill a chain slot: `index` replaces an entry, `null` appends. */
	#startAssignFallback(role: string, index: number | null): void {
		this.#assigning = { kind: "fallback", role, index };
		this.#startBrowsing();
		if (index === null) return;
		const selector = this.fallbackChains()[role]?.[index];
		if (selector) {
			// Suffixed entries carry effort the rows don't show: preselect by the base.
			const parsed = this.#parseFallbackEntry(selector);
			this.browser.selectSelector(parsed ? `${parsed.provider}/${parsed.id}` : selector);
		}
	}

	#startBrowsing(): void {
		this.#focus = "list";
		this.browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.browser.setQuery("");
	}

	/** Second step of "+ New fallback…": key the chain by the model or its whole provider. */
	#openFallbackKeyStrip(item: ModelBrowserItem): void {
		this.#strip = {
			kind: "role",
			item,
			chips: [
				{ label: `for ${item.selector}`, action: "fallbackModel" },
				{ label: `for ${item.model.provider}/*`, action: "fallbackProvider" },
			],
			index: 0,
			returnToRoles: false,
		};
	}

	/** Write the picked model into the chain slot (deduped; stored bare = inherit) and land on its row. */
	#commitFallback(item: ModelBrowserItem, target: { role: string; index: number | null }): void {
		const chain = [...(this.fallbackChains()[target.role] ?? [])];
		const selector = item.selector;
		if (target.index !== null && target.index < chain.length) {
			chain[target.index] = selector;
			for (let i = chain.length - 1; i >= 0; i--)
				if (i !== target.index && chain[i] === selector) chain.splice(i, 1);
		} else if (!chain.includes(selector)) chain.push(selector);
		this.#setFallbackChain(target.role, chain);
		this.browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
		const at = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === target.role && row.selector === selector,
		);
		if (at >= 0) this.#roleIndex = at;
	}

	#setFallbackChain(role: string, chain: string[]): void {
		this.callbacks.onFallbackChainChange?.(role, chain);
		this.#sync();
	}

	#cancelAssign(): void {
		this.#assigning = null;
		this.browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
	}

	#setCycleOrder(order: string[]): void {
		this.callbacks.onCycleOrderChange?.(order);
		this.#sync();
	}

	#submitNameStrip(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name") return;
		if (strip.purpose === "compaction") {
			const value = strip.field.text;
			const result = this.callbacks.onCompactionPointChange?.(strip.model, value, compactionConfirmPending(strip));
			if (result?.kind === "error") {
				strip.error = result.message;
				strip.confirm = undefined;
				return;
			}
			if (result?.kind === "confirm") {
				strip.error = undefined;
				strip.confirm = { value, message: result.message };
				return;
			}
			this.#strip = null;
			this.#sync();
			return;
		}
		const name = strip.field.text.trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		if (strip.purpose === "preset") {
			this.#strip = null;
			this.callbacks.onSavePreset?.(name);
			this.#sync();
			return;
		}
		if (this.visibleRoleIds().includes(name)) return;
		this.#strip = null;
		this.#startAssign(name);
	}

	/** Apply the previous/next saved preset (wrapping). */
	#switchPreset(delta: -1 | 1): void {
		const onSwitchPreset = this.callbacks.onSwitchPreset;
		const { names, active } = this.presets();
		if (!onSwitchPreset || names.length === 0) return;
		// Step from the last preset tried while nothing changed since (a refused switch writes nothing), else the active one.
		const cursor = this.#presetCursor;
		const base = cursor && (active === undefined || cursor.revision === this.source.revision) ? cursor.name : active;
		const current = base === undefined ? -1 : names.indexOf(base);
		const next = current < 0 ? (delta > 0 ? 0 : names.length - 1) : (current + delta + names.length) % names.length;
		const name = names[next];
		if (name === undefined) return;
		const settle = (): void => {
			this.#presetCursor = { name, revision: this.source.revision };
			this.#sync();
		};
		if (name === active) {
			settle();
			return;
		}
		this.#finishAssignment(onSwitchPreset(name), settle);
	}

	// ─── Input ──────────────────────────────────────────────────────────────

	/** A key, as the old hub took it: strips first, then cancel, pane keys, the Roles view, the list. */
	handleKey(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		batch(() => {
			this.#handleKey(key);
			this.#bump();
		});
		return true;
	}

	#handleKey(key: KeyEvent): void {
		const id = selectKeyId(key);
		const cancelKey = matchesSelectCancel(key);
		if (this.#assignmentPending) {
			if (cancelKey) this.callbacks.onCancel();
			return;
		}
		if (this.#strip) {
			this.#handleStripKey(key);
			return;
		}
		if (cancelKey) {
			this.cancel();
			return;
		}
		const entry = this.activeEntry();
		const rolesView = this.rolesView();
		const lockedView = this.lockedView();
		if (id === "tab" || id === "shift+tab") {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			return;
		}
		if (id === "f5") {
			if (entry.kind === "provider" && !entry.locked)
				this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
			return;
		}
		if (id === "f6") {
			this.#manageAccess();
			return;
		}
		if (rolesView && (id === "ctrl+left" || id === "ctrl+right")) {
			this.#switchPreset(id === "ctrl+left" ? -1 : 1);
			return;
		}
		// Option+←/→ (ESC b / ESC f on macOS) step the tab strip on screen.
		if (id === "alt+left" || id === "alt+b" || id === "alt+right" || id === "alt+f") {
			const delta = id === "alt+left" || id === "alt+b" ? -1 : 1;
			if (rolesView) this.#moveRoleTab(delta);
			else this.#moveModelKind(delta);
			return;
		}
		// ←/→ switch panes; they never reach the query caret.
		if (id === "left") {
			this.#focus = "scope";
			return;
		}
		if (id === "right") {
			if (rolesView || this.isBrowserView(entry)) this.#focus = "list";
			return;
		}
		if (this.#focus === "scope" && (id === "up" || id === "down")) {
			this.#moveSidebar(id === "up" ? -1 : 1);
			return;
		}
		const typed = printable(key);
		if (rolesView) {
			// Typing searches from the sidebar, and from the rows while a query is live.
			const editsQuery = this.browser.query.length > 0 && (typed !== undefined || id === "backspace");
			if ((this.#focus === "scope" && typed !== undefined && typed.trim().length > 0) || editsQuery) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.browser.handleKey(key);
				return;
			}
			this.#handleRolesKey(key);
			return;
		}
		if (lockedView) {
			if (typed !== undefined && typed.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.browser.handleKey(key);
				return;
			}
			if (id === "enter") this.#requestLogin(entry);
			return;
		}
		// Enter on the sidebar switches panes, like →.
		if (this.#focus === "scope" && id === "enter") {
			this.#focus = "list";
			return;
		}
		const before = this.browser.query;
		this.browser.handleKey(key);
		if (typed !== undefined || this.browser.query !== before) this.#focus = "list";
	}

	/** The cancel ladder: close a strip, leave assign mode, clear the query, close the hub. */
	cancel(): void {
		if (this.#assignmentPending) {
			this.callbacks.onCancel();
			return;
		}
		if (this.#strip) {
			this.#closeStrip();
			return;
		}
		if (this.#assigning !== null) {
			this.#cancelAssign();
			return;
		}
		if (this.isBrowserView(this.activeEntry()) && this.browser.query.length > 0) {
			this.browser.handleCancel();
			return;
		}
		this.callbacks.onCancel();
	}

	#handleStripKey(key: KeyEvent): void {
		const strip = this.#strip!;
		const id = selectKeyId(key);
		if (matchesSelectCancel(key)) {
			this.#closeStrip();
			return;
		}
		if (strip.kind === "name") {
			if (id === "enter") {
				this.#submitNameStrip();
				return;
			}
			const next = editLine(strip.field, key);
			if (next) {
				strip.field = next;
				if (strip.purpose === "compaction") strip.error = undefined;
			}
			return;
		}
		const back = id === "left" || id === "up" || id === "shift+tab";
		if (back || id === "right" || id === "down" || id === "tab") {
			const count = strip.chips.length;
			const before = strip.index;
			strip.index = (strip.index + (back ? -1 : 1) + count) % count;
			// Moving within the strip re-arms the committed-row repeat guard.
			if (strip.index !== before) this.#committed = null;
			return;
		}
		if (id === "enter") this.activateStripChip();
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = Math.max(
			0,
			this.#entries.findIndex(entry => entry.id === this.#activeEntryId),
		);
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && !this.#isHopSkipped(entry)) {
				// Landing on Roles cancels an assignment; other scopes keep it (scoping helps find the model).
				if (entry.kind === "roles") this.#assigning = null;
				this.#setActiveEntry(entry.id);
				return;
			}
		}
	}

	#moveModelKind(delta: -1 | 1): void {
		const at = Math.max(0, MODEL_KIND_TABS.indexOf(this.#modelKindTab));
		this.#modelKindTab = MODEL_KIND_TABS[(at + delta + MODEL_KIND_TABS.length) % MODEL_KIND_TABS.length] ?? "all";
		this.#applyModelKind();
	}

	#moveRoleTab(delta: -1 | 1): void {
		const at = Math.max(0, ROLE_TABS.indexOf(this.#roleTab));
		this.#setRoleTab(ROLE_TABS[(at + delta + ROLE_TABS.length) % ROLE_TABS.length] ?? "all");
	}

	#setRoleTab(tab: RoleTab): void {
		this.#roleTab = tab;
		this.#roleIndex = 0;
		this.#roleScrollStart = 0;
		this.#buildRolesRows();
	}

	/** Pick the kind tab `id` (unknown ids are ignored). */
	setModelKind(id: string | undefined): void {
		const kind = MODEL_KIND_TABS.find(candidate => candidate === id);
		if (!kind) return;
		this.#modelKindTab = kind;
		this.#applyModelKind();
		this.#bump();
	}

	/** Pick the role tab `id` (unknown ids are ignored). */
	setRoleTab(id: string | undefined): void {
		const tab = ROLE_TABS.find(candidate => candidate === id);
		if (!tab) return;
		this.#setRoleTab(tab);
		this.#bump();
	}

	/** Step the roles cursor one row past separators; wraps unless `wrap` is false. */
	#stepRoleIndex(from: number, delta: -1 | 1, wrap = true): number {
		const count = this.#rolesRows.length;
		if (count === 0) return 0;
		let index = from;
		for (let i = 0; i < count; i++) {
			const next = index + delta;
			if (next < 0 || next >= count) {
				if (!wrap) return from;
				index = (next + count) % count;
			} else index = next;
			if (this.#rolesRows[index]?.kind !== "separator") return index;
		}
		return from;
	}

	#selectRole(index: number): void {
		this.#roleIndex = index;
		this.#roleScrollStart = this.rolesWindow().start;
	}

	#handleRolesKey(key: KeyEvent): void {
		const id = selectKeyId(key);
		// The sidebar previews the Roles view: Enter/Space dive into the rows.
		if (this.#focus === "scope") {
			if (id === "enter" || id === "space") this.#focus = "list";
			return;
		}
		switch (id) {
			case "up":
			case "down":
				this.#selectRole(this.#stepRoleIndex(this.#roleIndex, id === "up" ? -1 : 1));
				return;
			case "enter":
				this.runRolesAction("pick");
				return;
			case "backspace":
			case "delete":
				this.runRolesAction("clear");
				return;
			case "shift+up":
				this.runRolesAction("earlier");
				return;
			case "shift+down":
				this.runRolesAction("later");
				return;
		}
		const typed = printable(key);
		const action = typed === undefined ? undefined : ROLES_ACTION_KEYS[typed];
		if (action) this.runRolesAction(action);
	}

	#activateRolesRow(row: RolesRow): void {
		switch (row.kind) {
			case "role":
				this.#startAssign(row.role);
				return;
			case "chainKey":
				this.#startAssignFallback(row.role, null);
				return;
			case "fallback":
				this.#startAssignFallback(row.role, row.chainIndex);
				return;
			case "newFallback":
				this.#assigning = { kind: "fallbackKey" };
				this.#startBrowsing();
				return;
			case "newRole":
				this.#strip = { kind: "name", purpose: "role", field: { text: "", cursor: 0 } };
				return;
			case "separator":
				return;
		}
	}

	/** One Roles-view command on the selected row. */
	runRolesAction(action: RolesAction): void {
		const row = this.#rolesRows[this.#roleIndex];
		const role = row?.kind === "role" ? row.role : undefined;
		switch (action) {
			case "pick":
				if (row) this.#activateRolesRow(row);
				return;
			case "clear":
				if (role) this.#unassignRole(role);
				else if (row?.kind === "fallback") {
					const chain = [...(this.fallbackChains()[row.role] ?? [])];
					if (row.chainIndex >= chain.length) return;
					chain.splice(row.chainIndex, 1);
					this.#setFallbackChain(row.role, chain);
					this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
				} else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
				return;
			case "fallback":
				if (row?.kind === "newFallback") this.#activateRolesRow(row);
				else if (row && row.kind !== "newRole" && row.kind !== "separator")
					this.#startAssignFallback(row.role, null);
				return;
			case "cycle":
				if (role) {
					const order = this.cycleOrder();
					const at = order.indexOf(role);
					if (at >= 0) order.splice(at, 1);
					else order.push(role);
					this.#setCycleOrder(order);
				}
				return;
			case "earlier":
			case "later": {
				const delta = action === "earlier" ? -1 : 1;
				if (role) {
					const order = this.cycleOrder();
					const at = order.indexOf(role);
					const target = at + delta;
					if (at < 0 || target < 0 || target >= order.length) return;
					[order[at], order[target]] = [order[target]!, order[at]!];
					this.#setCycleOrder(order);
				} else if (row?.kind === "fallback") {
					const chain = [...(this.fallbackChains()[row.role] ?? [])];
					const target = row.chainIndex + delta;
					if (row.chainIndex >= chain.length || target < 0 || target >= chain.length) return;
					[chain[row.chainIndex], chain[target]] = [chain[target]!, chain[row.chainIndex]!];
					this.#setFallbackChain(row.role, chain);
					this.#roleIndex += delta;
				}
				return;
			}
			case "new":
				this.#strip = { kind: "name", purpose: "role", field: { text: "", cursor: 0 } };
				return;
			case "save":
				if (this.callbacks.onSavePreset)
					this.#strip = { kind: "name", purpose: "preset", field: { text: "", cursor: 0 } };
				return;
			case "nextPreset":
			case "prevPreset":
				this.#switchPreset(action === "nextPreset" ? 1 : -1);
				return;
			case "compaction": {
				if (!this.callbacks.onCompactionPointChange) return;
				const model = this.roleRowModel();
				if (!model) return;
				const draft = this.source.compactionPointFor?.(model)?.draft ?? "";
				this.#strip = { kind: "name", purpose: "compaction", model, field: { text: draft, cursor: draft.length } };
				return;
			}
			case "thinking":
				if (role) {
					const target = this.roleThinkingTarget(role);
					if (target) this.#openThinkingStrip(target.item, role, true, target.scope);
				} else if (row?.kind === "fallback") this.#openFallbackThinkingStrip(row);
				return;
		}
	}

	#manageAccess(): void {
		const url = this.manageUrl();
		if (url) this.callbacks.onManageAccess?.(url);
	}

	#requestLogin(entry: SidebarEntry): void {
		if (entry.providerId && entry.oauth) this.callbacks.onLoginRequest?.(entry.providerId);
	}

	// ─── Pointer and native events ──────────────────────────────────────────

	/** A click on a sidebar entry: pick the scope (Roles dives into its rows; a second click on a locked provider logs in). */
	clickSidebarEntry(id: string | undefined): void {
		const clicked = this.#entries.find(entry => entry.id === id);
		if (!clicked || clicked.kind === "separator") return;
		batch(() => {
			const already = clicked.id === this.#activeEntryId;
			if (clicked.kind === "roles") this.#assigning = null;
			this.#setActiveEntry(clicked.id);
			if (clicked.kind === "roles") this.#focus = "list";
			if (already && clicked.kind === "provider" && clicked.locked) this.#requestLogin(clicked);
			this.#bump();
		});
	}

	/**
	 * A pointer event at a cell of the hub painted `width` wide: sidebar
	 * (wheel pans, motion hovers, click picks), body (Roles rows or the model
	 * list), footer strip chips.
	 */
	routeMouse(
		event: { row: number; col: number; button: string; action: string },
		width: number,
		chipAt: (col: number) => number | undefined,
	): void {
		if (this.#assignmentPending) return;
		const rows = this.contentRows();
		const { sidebar } = hubGeometry(width, this.#entries);
		const footerRow = rows + 2;
		const content = event.row - 1;
		const inContent = content >= 0 && content < rows;
		const overSidebar = inContent && event.col >= 2 && event.col < 2 + sidebar;
		const overBody = inContent && event.col >= 2 + sidebar + 3 && event.col < width - 2;
		const bodyLine = content - 1;
		const wheel = event.button === "wheel-up" ? -1 : event.button === "wheel-down" ? 1 : 0;
		const click = event.button === "left" && event.action === "press";
		const entry = this.activeEntry();
		const rolesView = this.rolesView();
		batch(() => {
			if (event.row === footerRow && this.#strip) {
				const strip = this.#strip;
				const index = chipAt(event.col);
				if (click && strip.kind !== "name" && index !== undefined) {
					strip.index = index;
					// A pointer activation is deliberate: it re-arms the committed-row guard.
					this.#committed = null;
					this.activateStripChip();
				}
			} else if (wheel !== 0 && event.action === "press") {
				if (overSidebar) {
					this.#sidebarScroll = Math.max(
						0,
						Math.min(this.sidebarScroll() + wheel, Math.max(0, this.#entries.length - rows)),
					);
					this.#sidebarHover = this.#sidebarEntryAt(content);
				} else if (overBody) {
					if (rolesView) this.#selectRole(this.#stepRoleIndex(this.#roleIndex, wheel > 0 ? 1 : -1, false));
					else if (this.isBrowserView(entry) && bodyLine > 0)
						this.browser.wheel(wheel, this.#browserRow(bodyLine));
				}
			} else if (event.action === "move") {
				this.#sidebarHover = overSidebar ? this.#sidebarEntryAt(content) : null;
				if (overBody && rolesView) {
					const line = bodyLine - 1;
					const window = this.rolesWindow();
					this.#roleHover = line >= 0 && line < window.end - window.start ? line + window.start : null;
				} else {
					this.#roleHover = null;
					if (overBody && this.isBrowserView(entry) && bodyLine > 0)
						this.browser.hover(this.#browserRow(bodyLine));
					else this.browser.clearHover();
				}
			} else if (click) {
				if (overSidebar) {
					const index = this.#sidebarEntryAt(content);
					this.clickSidebarEntry(index === null ? undefined : this.#entries[index]?.id);
				} else if (overBody) {
					if (rolesView) {
						this.#focus = "list";
						const line = bodyLine - 1;
						const window = this.rolesWindow();
						if (line >= 0 && line < window.end - window.start) {
							const index = line + window.start;
							const row = this.#rolesRows[index];
							if (row && row.kind !== "separator") {
								if (index === this.#roleIndex) this.#activateRolesRow(row);
								else this.#selectRole(index);
							}
						}
					} else if (this.lockedView()) {
						if (bodyLine === this.lockedLoginLine(entry)) this.#requestLogin(entry);
					} else if (this.isBrowserView(entry) && bodyLine > 0) {
						const row = this.#browserRow(bodyLine);
						if (row !== null) this.browser.click(row);
					}
				}
			}
			this.#bump();
		});
	}

	/** The body line (rows after the status row) of the locked pane's login row; OAuth providers only. */
	lockedLoginLine(entry: SidebarEntry): number | null {
		// Blank, warning, blank, how-to, then the login row.
		return entry.oauth ? 4 : null;
	}

	/** The browser's window row under body line `bodyLine` (the status and kind rows sit above it). */
	#browserRow(bodyLine: number): number | null {
		const line = bodyLine - 1 - 2;
		return line >= 0 && line < this.browser.maxVisible ? line : null;
	}

	#sidebarEntryAt(content: number): number | null {
		const index = this.sidebarScroll() + content;
		return index >= 0 && index < this.#entries.length ? index : null;
	}

	/** A picker event: rows, actions (roles commands, tabs, strip chips, refresh, login…). */
	handleEvent(event: { type: "select" | "activate" | "action"; item?: string; act?: string; value?: string }): void {
		batch(() => {
			this.#handleEvent(event);
			this.#bump();
		});
	}

	#handleEvent(event: { type: "select" | "activate" | "action"; item?: string; act?: string; value?: string }): void {
		if (event.type === "action" && event.act === "close") {
			this.cancel();
			return;
		}
		if (this.#assignmentPending) return;
		const entry = this.activeEntry();
		const rolesView = this.rolesView();
		if (event.type !== "action") {
			if (this.#strip || event.item === undefined) return;
			if (rolesView) {
				const index = this.#rolesRows.findIndex((row, i) => rolesRowKey(row, i) === event.item);
				const row = this.#rolesRows[index];
				if (!row || row.kind === "separator") return;
				this.#focus = "list";
				this.#selectRole(index);
				if (event.type === "activate") this.#activateRolesRow(row);
				return;
			}
			if (this.isBrowserView(entry) && this.browser.routePickerItem(event.item, event.type === "activate"))
				this.#focus = "list";
			return;
		}
		const act = event.act ?? "";
		if (act.startsWith("roles:")) {
			if (!rolesView || this.#strip) return;
			this.#focus = "list";
			this.runRolesAction(act.slice("roles:".length) as RolesAction);
			return;
		}
		switch (act) {
			case "scope":
				this.clickSidebarEntry(event.value);
				return;
			case "tab":
				if (rolesView) this.setRoleTab(event.value);
				else this.setModelKind(event.value);
				return;
			case "strip": {
				const strip = this.#strip;
				const index = Number(event.value);
				if (!strip || strip.kind === "name" || !Number.isInteger(index) || !strip.chips[index]) return;
				strip.index = index;
				this.#committed = null;
				this.activateStripChip();
				return;
			}
			case "stripApply":
				this.#committed = null;
				this.activateStripChip();
				return;
			case "roleName":
			case "presetName":
			case "compactionPoint":
				this.#submitNameStrip();
				return;
			case "cancel":
				if (this.#strip) this.#closeStrip();
				return;
			case "clear":
				if (this.browser.query.length > 0) this.browser.handleCancel();
				return;
			case "assign": {
				if (this.#strip || !this.isBrowserView(entry)) return;
				const selected = this.browser.pickerSelected;
				if (!selected) return;
				this.#focus = "list";
				this.browser.routePickerItem(selected, true);
				return;
			}
			case "refresh":
				if (entry.kind === "provider" && !entry.locked)
					this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
				return;
			case "login":
				if (this.lockedView()) this.#requestLogin(entry);
				return;
			case "manage":
				this.#manageAccess();
				return;
		}
	}
}

/** A browser row for `model`. */
function itemOf(model: Model): ModelBrowserItem {
	return { provider: model.provider, id: model.id, model, selector: `${model.provider}/${model.id}` };
}

/** Thinking strip chips for `options`. */
function thinkingChips(options: readonly ConfiguredThinkingLevel[]): StripChip[] {
	return options.map(level => ({
		label: getConfiguredThinkingLevelMetadata(level).label,
		action: "thinking",
		thinkingLevel: level,
	}));
}

/** How long ago a discovery fetch ran. */
function discoveryAge(fetchedAt: number | undefined): string | undefined {
	if (!fetchedAt) return undefined;
	const ms = Math.max(0, Date.now() - fetchedAt);
	return ms < 60_000 ? "less than a minute ago" : `${Math.round(ms / 60_000)}m ago`;
}
