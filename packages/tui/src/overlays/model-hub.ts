import { parseModelString, splitUpstreamRouting, formatModelSelectorValue } from "./model-selector";
/**
 * Fullscreen /models hub, shown on the alternate screen like /settings.
 *
 * Layout: a sidebar of scopes (recently used, role management, all models,
 * one entry per provider — locked providers included, dimmed) beside a
 * {@link ModelBrowser} body. The Roles view manages assignments directly:
 * pick a role, pick a model, adjust thinking in an inline strip, or clear the
 * role back to auto-selection. Locked providers forward to the /login flow.
 * Fully mouse-navigable (hover, wheel, click). Session-only switching lives
 * in the compact alt+p picker ({@link ./model-picker}).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	TspPickerAction,
	TspPickerColumn,
	TspPickerGroup,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
	TspSpan,
} from "@oh-my-pi/pi-wire";
import type { KeysApi, Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { MODEL_KINDS, modelKind, type ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { Component, TUI } from "../tui";
import { extractPrintableText, matchesKey } from "../keys";
import { fuzzyFilter } from "../fuzzy";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { boundKeys, editorKey, editorKeys } from "../chrome/keybinding-hints";
import type { KeyName } from "../key-hint-format";
import { col, compact, kbd, md, node, span, text } from "../native/describe";
import { CLOSE_ACTION, type PickerEvent, picker, pickerAction, pickerEvent } from "../native/picker";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, type NativeHint } from "../native/overlay";
import { plainText } from "../native/spans";
import { isNativeRendering } from "../native/state";
import { Input } from "../components/input";
import { routeSgrMouseInput, type SgrMouseEvent } from "../mouse";
import { truncateToWidth, visibleWidth } from "../utils";
import type {
	ModelBrowserSource,
	ModelBrowserRegistry,
	ModelRoleLookup,
	ResolvedModelRoleValue,
} from "./model-browser";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../thinking";
import { thinkingLevelGlyph } from "../render/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import {
	buildBrowserItems,
	MODEL_PICKER_COLUMNS,
	ModelBrowser,
	type ModelBrowserItem,
	modelSearchText,
	thinkingDotToken,
	type RoleAssignments,
	resolveRoleAssignments,
	sortModelItems,
} from "./model-browser";
import {
	describeHubFrame,
	describeHubSidebar,
	HubFrame,
	moveStripSelection,
	type SidebarEntry as HubSidebarEntry,
	type SidebarStyle,
	type StripChip as HubStripChip,
	type StripState as HubStripState,
} from "./hub-frame";
import { renderSegmentTrack } from "../chrome/segment-track";

const MODEL_HUB_BODY_MIN_WIDTH = 28;

/**
 * A row of the Roles view: a role, a model/wildcard chain-key header, one of a
 * chain's fallback entries, or the trailing "+ New role…". Fallback rows under
 * a chain-key header carry the key in `role` — `retry.fallbackChains` treats
 * roles, `provider/model-id`, and `provider/*` keys uniformly.
 */
type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "separator" }
	| { kind: "newFallback" }
	| { kind: "newRole" };

/**
 * What the model browser is currently picking for: a role's model, a slot in
 * a fallback chain (`role` may be a role name, model selector, or `provider/*`
 * key), or the primary model a brand-new fallback chain protects.
 */
type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" };

/** Live preferences and selector operations supplied by the host. */
export interface ModelHubSource extends ModelBrowserSource {
	readonly disabledProviders: readonly string[];
	readonly fallbackChains: Record<string, string[]>;
	readonly modelRoleStorage: "global" | "project";
	readonly cycleOrder: readonly string[];
	getProjectModelRole(role: string): string | undefined;
	getGlobalModelRole(role: string): string | undefined;
	getModelRoleSource(role: string): "global" | "project" | "default";
	/**
	 * Saved model presets (in switch order) and the one the current role setup
	 * matches, if any. Absent hosts have no presets to switch between.
	 */
	getModelPresets?(): { names: readonly string[]; active: string | undefined };
}

/** Catalog capabilities required by the model hub. */
export interface ModelHubRegistry extends ModelBrowserRegistry {
	readonly authStorage: { readonly keys: Pick<KeysApi, "source"> };
	getDiscoverableProviders(): string[];
	getProviderDiscoveryState(provider: string):
		| {
				optional: boolean;
				status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
				fetchedAt?: number;
				error?: string;
		  }
		| undefined;
	find(provider: string, id: string): Model | undefined;
	refresh(strategy: "online"): Promise<void>;
	refreshProvider(
		provider: string,
		strategy: "online",
		options?: { refreshCommandCredentials?: boolean },
	): Promise<void>;
}

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project";

export interface ModelHubCallbacks {
	/** Persist a role assignment. */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
	) => void | boolean | Promise<void | boolean>;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string, scope?: ModelRoleSelectionScope) => void;
	/** Persist a `retry.fallbackChains` entry — keyed by a role, `provider/model-id`, or `provider/*`; an empty chain clears the key. */
	onFallbackChainChange?: (role: string, chain: string[]) => void;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Save the current role assignments and default thinking level as a named model preset. */
	onSavePreset?: (name: string) => void;
	/**
	 * Apply a saved model preset (ctrl+←/→ or p/⇧P in the Roles view) and report
	 * the outcome itself. A switch that writes nothing (a refused preset) still
	 * advances the hub's preset cursor, so the next press moves past it.
	 */
	onSwitchPreset?: (name: string) => void | Promise<void>;
	/** Persist a new quick-switch cycle order (the ctrl+p role cycle). */
	onCycleOrderChange?: (order: string[]) => void;
	onCancel: () => void;
}

export interface ModelHubOptions {
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
	/** `provider/id` of the session's model, marked current in the native picker. */
	currentSelector?: string;
	/**
	 * One-pick flow: Enter on a model assigns it to the `default` role directly (no role strip),
	 * and the hub closes once the thinking choice is confirmed or kept. Models that cannot fill
	 * `default` still open the role strip. The roles view and Assign mode are unchanged.
	 */
	quickPick?: boolean;
}

interface SidebarEntry extends HubSidebarEntry<"recent" | "roles" | "all" | "separator" | "provider"> {
	providerId?: string;
	locked?: boolean;
	oauth?: boolean;
	catalogCount?: number;
}

/**
 * The focused sidebar entry plus its screen row, captured before a rebuild so
 * the viewport can be restored around it. `index` is the entry's position in
 * `#entries` (−1 when absent); `offset` is its row relative to the scroll top.
 */
interface SidebarAnchor {
	id: string;
	index: number;
	offset: number;
}

interface StripChip extends HubStripChip<
	"assign" | "unassign" | "fallback" | "fallbackModel" | "fallbackProvider" | "scope" | "thinking"
> {
	role?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	scope?: ModelRoleSelectionScope;
}

/**
 * Where the hub lands once an assignment's follow-up strips finish: back on the
 * model list, on the Roles view, or closed (the `quickPick` one-pick flow).
 */
type StripLanding = "list" | "roles" | "close";

type StripState =
	| (HubStripState<StripChip> & {
			kind: "role" | "scope" | "thinking";
			item: ModelBrowserItem;
			role?: string;
			/** Set when a thinking strip edits a fallback-chain entry instead of a role assignment. */
			fallbackIndex?: number;
			scope?: ModelRoleSelectionScope;
			/** Where to land when a scope or thinking strip finishes. */
			after: StripLanding;
			/** Thinking value already committed for this strip. */
			initialThinkingLevel?: ConfiguredThinkingLevel;
	  })
	| {
			/** Footer text input naming a new role, or saving a model preset. */
			kind: "name";
			purpose: "role" | "preset";
			input: Input;
	  };

/** A Roles-view command; keys and the picker's action bar both run {@link ModelHubComponent}'s `#runRolesAction`. */
type RolesAction =
	| "pick"
	| "clear"
	| "fallback"
	| "cycle"
	| "earlier"
	| "later"
	| "new"
	| "thinking"
	| "save"
	| "nextPreset"
	| "prevPreset";

/** Printable keys of the Roles view and the command each runs. */
const ROLES_ACTION_KEYS: Record<string, RolesAction> = {
	x: "clear",
	f: "fallback",
	c: "cycle",
	"[": "earlier",
	"]": "later",
	n: "new",
	t: "thinking",
	s: "save",
	// Letter twins of ctrl+←/→, which macOS reserves for switching Spaces.
	p: "nextPreset",
	P: "prevPreset",
};

/** Picker fact columns of the Roles view. */
const ROLE_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "model", head: "Model", format: "text", priority: 2 },
	{ id: "thinking", head: "Thinking", format: "dim", priority: 1 },
];

/** Kind tab labels (sentence case; acronyms stay upper). */
const MODEL_KIND_LABELS: Record<"all" | ModelKind, string> = {
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

/** A provider mark's initials: `amazon-bedrock` → `AB`, `anthropic` → `An`. */
function providerInitials(providerId: string): string {
	const words = providerId.split(/[-_\s.]+/).filter(word => word.length > 0);
	if (words.length >= 2) return `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase();
	const word = words[0] ?? providerId;
	return `${word.charAt(0).toUpperCase()}${word.charAt(1)}`;
}

const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const RECENT_LIMIT = 15;
const MODEL_KIND_TABS: ReadonlyArray<"all" | ModelKind> = ["all", ...MODEL_KINDS];
const ROLE_TABS = ["all", "chat", "kind"] as const;
type RoleTab = (typeof ROLE_TABS)[number];

/** Stable native list-item key of a Roles-view row. */
function rolesRowKey(row: RolesRow, index: number): string {
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

/**
 * Providers already auto-refreshed this process. Selecting a provider fetches
 * its live model list at most once per application lifetime (surviving hub
 * close/reopen); F5 re-fetches on demand.
 */
const autoRefreshedProviders = new Set<string>();

/** Test hook: forget which providers were auto-refreshed this process. */
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

/**
 * The fullscreen model hub component. Hosted via `ui.showOverlay(..., { fullscreen: true })`;
 * the host must call {@link ModelHubComponent.dispose} when the overlay closes.
 */
export class ModelHubComponent implements Component {
	#tui: TUI;
	#settings: ModelHubSource;
	#registry: ModelHubRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#callbacks: ModelHubCallbacks;

	#browser: ModelBrowser;
	#roles: RoleAssignments = {};
	#availableItems: ModelBrowserItem[] = [];
	#recentItems: ModelBrowserItem[] = [];
	#candidateItems: ModelBrowserItem[] = [];
	#modelKindTab: "all" | ModelKind = "all";
	#roleTab: RoleTab = "all";
	#configError: string | undefined;

	#entries: SidebarEntry[] = [];
	// Sidebar sections from the last registry sync; #composeEntries assembles
	// #entries from these (reordered while searching).
	#fixedEntries: SidebarEntry[] = [];
	#unlockedProviderEntries: SidebarEntry[] = [];
	#lockedProviderEntries: SidebarEntry[] = [];
	/** Fuzzy match totals while searching: recent-scope hits and overall hits. */
	#recentSearchCount = 0;
	#searchTotal = 0;
	#activeEntryId = "all";
	/** Snap the sidebar viewport to the active entry on the next render; wheel panning leaves it free. */
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
	/**
	 * Arrow-key ownership: `scope` (default) hops the sidebar; `list`
	 * navigates rows (browser models or role rows). Typing anywhere focuses
	 * the model list; Tab toggles; ←/→ switches between sidebar and list.
	 */
	#focus: "scope" | "list" = "scope";

	#rolesRows: RolesRow[] = [];
	#roleIndex = 0;
	#roleHover: number | null = null;
	/** First roles row drawn in the scroll window; follows the cursor and clamps to the list. */
	#roleScrollStart = 0;
	/** Roles rows actually drawn this frame; bounds mouse hit-testing to the visible window. */
	#rolesVisibleCount = 0;

	#assigning: AssignTarget | null = null;
	#strip: StripState | null = null;
	#assignmentPending = false;
	/**
	 * Last preset ctrl+←/→ tried in this hub, with the settings revision after the
	 * attempt; steps from it while nothing matches the setup or nothing changed since.
	 */
	#presetCursor: { name: string; revision: number } | undefined;
	#presetsMemo: { revision: number; names: readonly string[]; active: string | undefined } | undefined;
	#disposed = false;
	/** Per-provider fuzzy match counts while a query is active; null when not searching. */
	#searchCounts: Map<string, number> | null = null;

	// Provider discovery refresh (debounced per sidebar selection, with spinner).
	#refreshingProviders = new Set<string>();
	#scheduledProviderRefreshes = new Map<string, Timer>();
	/** F5 while a catalog-only refresh is in flight: re-run with credentials after it settles. */
	#pendingCredentialRefreshProviders = new Set<string>();
	#refreshSpinnerFrame = 0;
	#refreshSpinnerInterval?: Timer;
	#renderBodyPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? 10));
		const lines: string[] = [this.#statusRow(width)];
		const entry = this.#activeEntry();
		if (entry.kind === "roles" && this.#assigning === null) {
			lines.push(...this.#renderRolesView(width, rows - 1));
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			lines.push(...this.#renderLockedView(entry, width, rows - 1));
		} else {
			lines.push(this.#renderModelKindTabs(width));
			this.#browser.setMaxVisible(rows - 2 - 5);
			this.#browser.setFocused(this.#focus === "list");
			lines.push(...this.#browser.render(width));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	readonly #frame: HubFrame = new HubFrame(
		"Models",
		{ min: 18, max: 26 },
		(width, rows) => this.#renderSidebar(width, rows),
		this.#renderBodyPane,
		{ bodyMinWidth: MODEL_HUB_BODY_MIN_WIDTH, preserveSidebar: true },
	);
	#lockedLoginLine: number | null = null;
	#rolesRowStart = 1;
	/** Bumped on every visible-state change; the described node is rebuilt when it moves. */
	#nativeVersion = 0;
	#nativeCache: { version: number; picker: boolean; node: NativeNode } | undefined;
	#currentSelector: string | undefined;
	#quickPick: boolean;
	/** The opening online catalog refresh is still in flight (an empty scope then shows as loading). */
	#catalogRefreshing = false;
	#kindTabsMemo: { candidates: readonly ModelBrowserItem[]; tabs: TspPickerProps["tabs"] } | undefined;
	#pickerRoleItems:
		| { rows: readonly RolesRow[]; roles: RoleAssignments; cycle: string; items: readonly TspPickerItem[] }
		| undefined;
	#pickerRolePreview:
		| {
				row: RolesRow | undefined;
				roles: RoleAssignments;
				rows: readonly RolesRow[];
				children: readonly NativeChild[];
		  }
		| undefined;

	constructor(
		tui: TUI,
		settings: ModelHubSource,
		registry: ModelHubRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelHubCallbacks,
		options: ModelHubOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#callbacks = callbacks;
		this.#currentSelector = options.currentSelector;
		this.#quickPick = options.quickPick === true;

		this.#browser = new ModelBrowser(settings, {
			emptyText: () => this.#emptyStateMessage(),
		});
		this.#browser.onActivate = item => this.#activateItem(item);
		this.#browser.onCancel = () => this.#callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#onQueryChanged(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();

		const initialProvider = options.initialProviderId;
		if (initialProvider && this.#entries.some(entry => entry.providerId === initialProvider)) {
			this.#setActiveEntry(`provider:${initialProvider}`);
		} else {
			this.#setActiveEntry("all");
		}

		// Reconcile catalogs in the background. This is online discovery only —
		// it must not re-run `!command` credential helpers (F5 / `omp models
		// refresh` pass refreshCommandCredentials for that). A --models scope is
		// registry-independent, so the reload would only repeat the hydration
		// above.
		if (this.#scopedModels.length === 0) {
			this.#catalogRefreshing = true;
			this.#registry
				.refresh("online")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					this.#catalogRefreshing = false;
					this.#requestRender();
				});
		}
	}

	/** Cancel pending provider refresh timers and the spinner. Host calls this on overlay close. */
	dispose(): void {
		this.#disposed = true;
		for (const [, timer] of this.#scheduledProviderRefreshes) clearTimeout(timer);
		this.#scheduledProviderRefreshes.clear();
		this.#refreshingProviders.clear();
		this.#pendingCredentialRefreshProviders.clear();
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
	}

	invalidate(): void {
		this.#nativeVersion++;
		this.#frame.invalidate();
	}

	/** Request a repaint after a state change, invalidating the described node. */
	#requestRender(): void {
		this.#nativeVersion++;
		this.#tui.requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	#visibleRoleIds(): string[] {
		return this.#settings.knownRoleIds.filter(role => !this.#settings.getRoleInfo(role).hidden);
	}

	/**
	 * Models a `--models`/`enabledModels` scope exposes. The scope only resolves
	 * chat models (it feeds Ctrl+P cycling), so available non-chat runners
	 * (judge, search, image, …) join from the registry — runtime role
	 * resolution ignores the scope for them as well.
	 */
	#scopedPool(): Model[] {
		const pool = this.#scopedModels.map(scoped => scoped.model);
		for (const model of this.#registry.getAvailable("all")) {
			if (modelKind(model) === "chat") continue;
			if (this.#scopedModels.some(scoped => modelsAreEqual(scoped.model, model))) continue;
			pool.push(model);
		}
		return pool;
	}

	/** Resolve every known role: configured values first, auto-selection for the rest. */
	#reloadRoles(autoCandidates: ReadonlyArray<Model>): void {
		const allModels = this.#scopedModels.length > 0 ? autoCandidates : this.#registry.getAll("all");
		this.#roles = resolveRoleAssignments(this.#settings, allModels, autoCandidates);
	}

	/** Rebuild items, roles, and the sidebar from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		this.#nativeVersion++;
		// A background rebuild (provider refresh, mutation) must not yank the
		// sidebar viewport: remember the focused entry's screen row so it — or
		// its nearest survivor — stays put after #buildSidebar reshuffles entries.
		const anchor = this.#captureSidebarAnchor();
		let allModels: ReadonlyArray<Model>;
		let availableModels: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			this.#configError = undefined;
			try {
				allModels = this.#scopedPool();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				allModels = this.#scopedModels.map(scoped => scoped.model);
			}
			availableModels = allModels;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			allModels = this.#registry.getAll("all");
			try {
				availableModels = this.#registry.getAvailable("all");
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				availableModels = [];
			}
		}

		this.#reloadRoles(availableModels);
		this.#buildRolesRows();

		const mruOrder = this.#settings.mruOrder;
		this.#availableItems = buildBrowserItems(availableModels);
		sortModelItems(this.#availableItems, { roles: this.#roles, mruOrder });
		this.#browser.setRoles(this.#roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(this.#settings.modelPerf);

		const bySelector = new Map(this.#availableItems.map(item => [item.selector, item]));
		this.#recentItems = [];
		for (const key of mruOrder) {
			const item = bySelector.get(key);
			if (item) this.#recentItems.push(item);
			if (this.#recentItems.length >= RECENT_LIMIT) break;
		}

		this.#buildSidebar(allModels, availableModels);
		this.#restoreSidebarAnchor(anchor);
		this.#applyScope();
	}

	#buildSidebar(allModels: ReadonlyArray<Model>, availableModels: ReadonlyArray<Model>): void {
		const scoped = this.#scopedModels.length > 0;
		let disabledProviders: ReadonlySet<string>;
		try {
			disabledProviders = new Set(this.#settings.disabledProviders);
		} catch {
			disabledProviders = new Set();
		}

		const availableCounts = new Map<string, number>();
		for (const model of availableModels) {
			availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
		}
		const catalogCounts = new Map<string, number>();
		for (const model of allModels) {
			catalogCounts.set(model.provider, (catalogCounts.get(model.provider) ?? 0) + 1);
		}

		const unlocked = new Set<string>(availableCounts.keys());
		const locked = new Set<string>();
		if (!scoped) {
			const authStorage = this.#registry.authStorage;
			for (const provider of catalogCounts.keys()) {
				if (!unlocked.has(provider) && !disabledProviders.has(provider)) {
					locked.add(provider);
				}
			}
			for (const provider of this.#registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabledProviders.has(provider)) continue;
				// Discoverable without stored auth: catalog-backed providers stay
				// locked; keyless/custom endpoints (ollama, vllm, …) surface as
				// selectable so discovery can populate them.
				const authenticated = authStorage.keys.source(provider) !== undefined;
				if (authenticated || !locked.has(provider)) {
					// #2761: implicit local endpoints (optional: true) stay hidden
					// until discovery actually reaches a server. "idle" means never
					// probed; "unavailable" means the endpoint is unreachable; both
					// would render a dead tab for a provider the user never
					// configured. models.yml discovery providers (optional: false)
					// and providers with stored auth keep their entry so
					// misconfigurations stay visible and diagnosable.
					if (!authenticated) {
						const discovery = this.#registry.getProviderDiscoveryState(provider);
						if (discovery?.optional && (discovery.status === "idle" || discovery.status === "unavailable")) {
							continue;
						}
					}
					locked.delete(provider);
					unlocked.add(provider);
				}
			}
		}

		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const providerEntry = (providerId: string, isLocked: boolean): SidebarEntry => ({
			id: `provider:${providerId}`,
			kind: "provider",
			label: providerId,
			providerId,
			locked: isLocked,
			annotation: isLocked ? undefined : String(availableCounts.get(providerId) ?? 0),
			oauth: oauthIds.has(providerId),
			catalogCount: catalogCounts.get(providerId) ?? 0,
		});

		const visibleRoles = this.#visibleRoleIds();
		let assignedCount = 0;
		for (const role of visibleRoles) {
			const assignment = this.#roles[role];
			if (assignment && !assignment.autoSelected) assignedCount++;
		}

		// Roles leads the fixed section so downward hops from Recent head into
		// model scopes instead of being captured by the roles view.
		const fixed: SidebarEntry[] = [
			{
				id: "roles",
				kind: "roles",
				label: "Roles",
				annotation: `${assignedCount}/${visibleRoles.length}`,
			},
			{ id: "all", kind: "all", label: "All models", annotation: String(availableModels.length) },
		];

		this.#fixedEntries = fixed;
		this.#unlockedProviderEntries = [...unlocked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, false));
		this.#lockedProviderEntries = [...locked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, true));
		this.#composeEntries();
	}

	/**
	 * Assemble `#entries` from the stored sections. While a search is active,
	 * providers with matches float to the top of the provider section (each
	 * group stays alphabetical) so the hop order, mouse hit-testing, and the
	 * paint all agree.
	 */
	#composeEntries(): void {
		const counts = this.#searchCounts;
		let providers = this.#unlockedProviderEntries;
		if (counts) {
			providers = [...providers].sort((a, b) => {
				const aMatched = (counts.get(a.providerId ?? "") ?? 0) > 0;
				const bMatched = (counts.get(b.providerId ?? "") ?? 0) > 0;
				if (aMatched !== bMatched) return aMatched ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
		}

		const entries: SidebarEntry[] = [...this.#fixedEntries];
		if (providers.length > 0) {
			entries.push({ id: "sep:providers", kind: "separator", label: "" }, ...providers);
		}
		if (this.#lockedProviderEntries.length > 0) {
			entries.push({ id: "sep:locked", kind: "separator", label: "" }, ...this.#lockedProviderEntries);
		}

		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) {
			this.#activeEntryId = "all";
			this.#sidebarFollowActive = true;
		}
	}

	/** Snapshot the focused entry and its row within the sidebar viewport. */
	#captureSidebarAnchor(): SidebarAnchor {
		const index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		return { id: this.#activeEntryId, index, offset: index - this.#frame.sidebarScroll };
	}

	/**
	 * Reposition the sidebar after {@link #buildSidebar} rebuilt `#entries`. A
	 * surviving focused entry keeps its screen row; if it vanished (a keyless
	 * provider flipping back to hidden mid-navigation), focus falls to the
	 * nearest surviving entry instead of snapping to the top.
	 */
	#restoreSidebarAnchor(anchor: SidebarAnchor): void {
		if (anchor.index < 0) return;
		const survivor = this.#entries.findIndex(entry => entry.id === anchor.id);
		if (survivor >= 0) {
			this.#frame.sidebarScroll = Math.max(0, survivor - anchor.offset);
			return;
		}
		const replacement = this.#nearestNavigableEntry(anchor.index);
		if (!replacement) return;
		this.#activeEntryId = replacement.id;
		this.#frame.sidebarScroll = Math.max(0, this.#entries.indexOf(replacement) - anchor.offset);
	}

	/** The selectable entry nearest `preferredIndex` in the current `#entries`. */
	#nearestNavigableEntry(preferredIndex: number): SidebarEntry | undefined {
		const entries = this.#entries;
		if (entries.length === 0) return undefined;
		const start = Math.max(0, Math.min(preferredIndex, entries.length - 1));
		for (let radius = 0; radius < entries.length; radius++) {
			for (const index of radius === 0 ? [start] : [start + radius, start - radius]) {
				const entry = entries[index];
				if (entry && !this.#isHopSkipped(entry)) return entry;
			}
		}
		return undefined;
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#setActiveEntry(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#activeEntryId = id;
		this.#sidebarFollowActive = true;
		this.#applyScope();
		const entry = this.#activeEntry();
		// Hops must never steal arrow focus: landing on a scope keeps provider
		// navigation active. Diving into the roles rows is explicit (Enter, →,
		// or a click on the Roles entry).
		this.#focus = "scope";
		if (entry.kind === "provider" && !entry.locked) {
			this.#scheduleProviderRefresh(entry.providerId ?? "");
		}
		this.#cancelScheduledRefreshesExcept(entry.kind === "provider" ? entry.providerId : undefined);
	}

	/** Push the active scope's items into the browser. */
	#applyScope(): void {
		const entry = this.#activeEntry();
		switch (entry.kind) {
			case "recent":
				this.#browser.setShowProvider(true);
				this.#setCandidateItems(this.#recentItems);
				break;
			case "provider": {
				if (entry.locked) {
					// Assign-mode renders the browser regardless of scope; a locked
					// provider contributes nothing selectable.
					this.#setCandidateItems([]);
					break;
				}
				const providerId = entry.providerId;
				this.#browser.setShowProvider(false);
				this.#setCandidateItems(this.#availableItems.filter(item => item.provider === providerId));
				break;
			}
			case "roles":
				this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRowCount - 1));
				break;
			default:
				this.#browser.setShowProvider(true);
				this.#setCandidateItems(this.#availableItems);
				break;
		}
	}

	/**
	 * Push the active scope's items into the browser. While assigning a role,
	 * the role's `accepts` predicate is re-applied here so a scope hop
	 * (provider/all/recent) can never surface a model the role rejects — role
	 * resolution and the runtime candidate pool filter the same way, so an
	 * unaccepted pick would persist a selector that never resolves.
	 */
	#setCandidateItems(items: ReadonlyArray<ModelBrowserItem>): void {
		const assigning = this.#assigning;
		const scoped =
			assigning?.kind === "role"
				? items.filter(item => this.#settings.getRoleInfo(assigning.role).accepts(item.model))
				: items;
		this.#candidateItems = [...scoped];
		this.#applyModelKind();
	}

	#applyModelKind(): void {
		const kind = this.#modelKindTab;
		this.#browser.setItems(
			kind === "all"
				? [...this.#candidateItems]
				: this.#candidateItems.filter(item => modelKind(item.model) === kind),
		);
	}

	/**
	 * The configured `retry.fallbackChains` record with malformed keys/entries
	 * dropped: non-array chains and non-string selectors never reach the rows
	 * or chain editors, so an edit through the hub replaces them wholesale.
	 */
	#fallbackChains(): Record<string, string[]> {
		try {
			const chains = this.#settings.fallbackChains;
			if (!chains || typeof chains !== "object" || Array.isArray(chains)) return {};
			const sanitized: Record<string, string[]> = {};
			for (const key in chains) {
				const chain = (chains as Record<string, unknown>)[key];
				if (!Array.isArray(chain)) continue;
				sanitized[key] = chain.filter((entry): entry is string => typeof entry === "string");
			}
			return sanitized;
		} catch {
			return {};
		}
	}

	/**
	 * Rebuild the Roles view rows: each visible role followed by its
	 * fallback-chain entries, then model-oriented chains (`provider/model-id`
	 * and `provider/*` keys) as headed groups.
	 */
	#buildRolesRows(): void {
		const rows: RolesRow[] = [];
		const chains = this.#fallbackChains();
		const appendRoles = (roles: ReadonlyArray<string>): void => {
			for (const role of roles) {
				rows.push({ kind: "role", role });
				const chain = chains[role] ?? [];
				for (let i = 0; i < chain.length; i++) {
					rows.push({ kind: "fallback", role, chainIndex: i, selector: chain[i] });
				}
			}
		};
		const visibleRoles = this.#visibleRoleIds();
		if (this.#roleTab === "all") {
			const chatRoles = visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === "chat");
			const kindRoles = visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === "kind");
			appendRoles(chatRoles);
			if (chatRoles.length > 0 && kindRoles.length > 0) rows.push({ kind: "separator" });
			appendRoles(kindRoles);
		} else {
			appendRoles(visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === this.#roleTab));
		}
		rows.push({ kind: "newRole" });
		rows.push({ kind: "separator" });
		const modelKeys = Object.keys(chains)
			.filter(key => key.includes("/"))
			.sort();
		for (const key of modelKeys) {
			const chain = chains[key] ?? [];
			rows.push({ kind: "chainKey", role: key });
			for (let i = 0; i < chain.length; i++) {
				rows.push({ kind: "fallback", role: key, chainIndex: i, selector: chain[i] });
			}
		}
		rows.push({ kind: "newFallback" });
		this.#rolesRows = rows;
	}

	/**
	 * Rows the Roles view lists on the All tab, separators aside: the picker's
	 * unfiltered `total`, counted in the same rows Tern counts as shown.
	 */
	#allRolesRowCount(): number {
		const chains = this.#fallbackChains();
		// "New role…" and "New fallback chain…", then each role and model chain with its fallback entries.
		let count = 2;
		for (const role of this.#visibleRoleIds()) count += 1 + (chains[role]?.length ?? 0);
		for (const key in chains) if (key.includes("/")) count += 1 + chains[key].length;
		return count;
	}

	/** Refresh roles + dependent state after a settings mutation (assign/unassign). */
	#refreshAfterMutation(): void {
		this.#syncFromRegistryState();
		this.#requestRender();
	}

	/** Re-sync after an asynchronous callback finishes mutating settings. */
	refreshAfterExternalMutation(): void {
		this.#refreshAfterMutation();
	}

	/**
	 * Recompute per-provider match counts for the active query. Providers
	 * without matches gray out and the scope hop skips them; a provider scope
	 * that just lost its last match falls back to All models so the results
	 * never silently vanish.
	 */
	#onQueryChanged(query: string): void {
		this.#nativeVersion++;
		if (!query.trim()) {
			this.#searchCounts = null;
			this.#composeEntries();
			return;
		}
		const matches = fuzzyFilter(this.#availableItems, query, modelSearchText);
		const counts = new Map<string, number>();
		for (const item of matches) {
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		}
		const recentSelectors = new Set(this.#recentItems.map(item => item.selector));
		this.#recentSearchCount = matches.reduce(
			(total, item) => total + (recentSelectors.has(item.selector) ? 1 : 0),
			0,
		);
		this.#searchTotal = matches.length;
		this.#searchCounts = counts;
		this.#composeEntries();
		const entry = this.#activeEntry();
		if (
			this.#assigning === null &&
			entry.kind === "provider" &&
			(entry.locked || (counts.get(entry.providerId ?? "") ?? 0) === 0)
		) {
			this.#setActiveEntry("all");
		}
	}

	/**
	 * Entries the scope hop skips: separators always; while searching, also
	 * the Roles view (not a model scope), an empty Recent, locked providers,
	 * and providers without matches.
	 */
	#isHopSkipped(entry: SidebarEntry): boolean {
		if (entry.kind === "separator") return true;
		if (!this.#searchCounts) return false;
		if (entry.kind === "roles") return true;
		if (entry.kind === "recent") return this.#recentSearchCount === 0;
		if (entry.kind === "provider") {
			if (entry.locked) return true;
			return (this.#searchCounts.get(entry.providerId ?? "") ?? 0) === 0;
		}
		return false;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Provider discovery refresh
	// ═══════════════════════════════════════════════════════════════════════

	#startRefreshSpinner(): void {
		// Native surfaces clock the refresh spinner themselves.
		if (this.#refreshSpinnerInterval || isNativeRendering()) return;
		this.#refreshSpinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#refreshSpinnerFrame = (this.#refreshSpinnerFrame + 1) % frameCount;
			}
			this.#requestRender();
		}, 80);
	}

	#stopRefreshSpinnerIfIdle(): void {
		if (this.#refreshingProviders.size > 0) return;
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
		this.#refreshSpinnerFrame = 0;
	}

	#setProviderRefreshing(providerId: string, refreshing: boolean): void {
		if (refreshing) {
			this.#refreshingProviders.add(providerId);
			this.#startRefreshSpinner();
		} else {
			this.#refreshingProviders.delete(providerId);
			this.#stopRefreshSpinnerIfIdle();
		}
	}

	#cancelScheduledRefreshesExcept(keepProviderId?: string): void {
		// Hover debounce only. An explicit F5 queued behind an in-flight catalog
		// fetch must still re-mint credentials after that fetch settles, even if
		// the user has moved to All models or another provider.
		for (const [providerId, timer] of this.#scheduledProviderRefreshes) {
			if (providerId === keepProviderId) continue;
			clearTimeout(timer);
			this.#scheduledProviderRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleProviderRefresh(providerId: string, options?: { force?: boolean }): void {
		if (this.#scopedModels.length > 0 || !providerId) return;
		const force = options?.force === true;
		if (force) {
			const pending = this.#scheduledProviderRefreshes.get(providerId);
			if (pending) {
				// Selection already queued a catalog-only fetch. F5 upgrades it
				// instead of returning at the pending-guard and dropping force.
				clearTimeout(pending);
				this.#scheduledProviderRefreshes.delete(providerId);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProviderInBackground(providerId, true);
				return;
			}
			if (this.#refreshingProviders.has(providerId)) {
				this.#pendingCredentialRefreshProviders.add(providerId);
				return;
			}
		} else if (this.#scheduledProviderRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) {
			return;
		}
		// Hovering a provider must not re-fetch on every visit: auto-refresh runs
		// at most once per provider for the process lifetime. F5 forces a re-fetch.
		if (!force && autoRefreshedProviders.has(providerId)) return;
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			// Consume the once-guard only when the fetch actually starts: hopping
			// through a provider cancels the debounce and must not burn its slot.
			autoRefreshedProviders.add(providerId);
			this.#scheduledProviderRefreshes.delete(providerId);
			void this.#refreshProviderInBackground(providerId, force);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		this.#scheduledProviderRefreshes.set(providerId, timer);
	}

	async #refreshProviderInBackground(providerId: string, refreshCommandCredentials = false): Promise<void> {
		try {
			if (refreshCommandCredentials) {
				await this.#registry.refreshProvider(providerId, "online", { refreshCommandCredentials: true });
			} else {
				await this.#registry.refreshProvider(providerId, "online");
			}
			// The provider refresh already updated the registry snapshot;
			// re-reading it here stays purely in-memory.
			this.#syncFromRegistryState();
		} catch (error) {
			this.#configError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#setProviderRefreshing(providerId, false);
			if (!this.#disposed && this.#pendingCredentialRefreshProviders.delete(providerId)) {
				this.#setProviderRefreshing(providerId, true);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProviderInBackground(providerId, true);
			}
			this.#requestRender();
		}
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) return undefined;
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) return "less than a minute ago";
		return `${Math.round(ageMs / 60_000)}m ago`;
	}

	#emptyStateMessage(): string | undefined {
		if (this.#configError) return `  ${this.#configError}`;
		const entry = this.#activeEntry();
		if (entry.kind === "recent") return "  No recently used models yet";
		if (entry.kind !== "provider" || entry.locked) return undefined;
		if (this.#browser.query.trim()) {
			return `  No matching models in ${entry.label}. Switch to All models to search every provider.`;
		}
		const providerId = entry.providerId ?? "";
		const state = this.#registry.getProviderDiscoveryState(providerId);
		if (!state) return undefined;
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable": {
				const httpMatch = state.error?.match(/^HTTP (\d+) from (.+)$/);
				if (httpMatch?.[1] === "404") {
					return `  Discovery endpoint ${httpMatch[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
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

	// ═══════════════════════════════════════════════════════════════════════
	// Assignment flow
	// ═══════════════════════════════════════════════════════════════════════

	#activateItem(item: ModelBrowserItem): void {
		// Also reached from the browser's own native list events, which bypass handleInput.
		this.#nativeVersion++;
		if (this.#assigning) {
			const target = this.#assigning;
			this.#assigning = null;
			if (target.kind === "role") {
				this.#assignRole(item, target.role, "roles");
			} else if (target.kind === "fallbackKey") {
				this.#openFallbackKeyStrip(item);
			} else {
				this.#commitFallback(item, target);
			}
			return;
		}
		if (this.#quickPick && this.#settings.getRoleInfo("default").accepts(item.model)) {
			this.#assignRole(item, "default", "close");
			return;
		}
		this.#openRoleStrip(item);
	}

	#roleForScope(role: string, scope: ModelRoleSelectionScope): ResolvedModelRoleValue {
		const roleValue =
			scope === "project" ? this.#settings.getProjectModelRole(role) : this.#settings.getGlobalModelRole(role);
		const allModels = this.#scopedModels.length > 0 ? this.#scopedPool() : this.#registry.getAll("all");
		const roleLookup: ModelRoleLookup = {
			getModelRole: scopedRole =>
				scope === "project"
					? (this.#settings.getProjectModelRole(scopedRole) ?? this.#settings.getGlobalModelRole(scopedRole))
					: this.#settings.getGlobalModelRole(scopedRole),
		};
		return this.#settings.resolveRoleValue(roleValue, allModels, roleLookup);
	}

	#thinkingLevelForScope(role: string, scope: ModelRoleSelectionScope): ConfiguredThinkingLevel {
		const resolved = this.#roleForScope(role, scope);
		return resolved.explicitThinkingLevel ? (resolved.thinkingLevel ?? ThinkingLevel.Inherit) : ThinkingLevel.Inherit;
	}
	#finishAssignment(result: void | boolean | Promise<void | boolean>, onSuccess: () => void): void {
		if (!(result instanceof Promise)) {
			if (result !== false) onSuccess();
			else this.#requestRender();
			return;
		}
		this.#assignmentPending = true;
		this.#requestRender();
		void result.then(
			applied => {
				this.#assignmentPending = false;
				if (this.#disposed) return;
				if (applied !== false) onSuccess();
				else this.#requestRender();
			},
			() => {
				this.#assignmentPending = false;
				if (!this.#disposed) this.#requestRender();
			},
		);
	}

	/**
	 * Persist `role → item`, preserving a still-supported thinking level, then
	 * open the thinking strip — skipped for models with no reasoning surface,
	 * where every chip would be a no-op ({@link #thinkingOptionsFor}).
	 */
	#assignRole(item: ModelBrowserItem, role: string, after: StripLanding, scope?: ModelRoleSelectionScope): void {
		if (this.#settings.modelRoleStorage === "project" && scope === undefined) {
			this.#openScopeStrip(item, role, after);
			return;
		}

		const current = this.#roles[role];
		let level: ConfiguredThinkingLevel = ThinkingLevel.Inherit;
		if (this.#settings.modelRoleStorage === "project" && scope !== undefined) {
			level = this.#thinkingLevelForScope(role, scope);
		} else if (current && !current.autoSelected) {
			level = current.thinkingLevel;
		}
		const supported = this.#thinkingOptionsFor(item.model);
		if (!supported.includes(level)) level = ThinkingLevel.Inherit;
		const result = this.#callbacks.onAssign(item.model, role, level, item.selector, scope);
		this.#finishAssignment(result, () => {
			this.#refreshAfterMutation();
			if (supported.length === 0) {
				this.#land(after);
				return;
			}
			this.#openThinkingStrip(item, role, after, scope, level);
		});
	}

	#unassignRole(role: string): void {
		const assignment = this.#roles[role];
		if (!assignment || assignment.autoSelected) return;
		if (this.#settings.modelRoleStorage === "project") {
			const source = this.#settings.getModelRoleSource(role);
			this.#callbacks.onUnassign(role, source === "default" ? undefined : source);
		} else {
			this.#callbacks.onUnassign(role);
		}
		this.#refreshAfterMutation();
	}

	/**
	 * Thinking levels a role assignment can actually apply. A model that does
	 * not reason gets none: no request path sends reasoning for it, and
	 * `applyAutoThinkingLevel` early-returns on `!model.reasoning`, so
	 * `inherit`/`off`/`auto` would all be no-ops. Reasoners without an effort
	 * dial (`thinking: undefined`, e.g. `xai/grok-code-fast-1`) keep the three
	 * always-on levels — their thinking is real, only the ladder is absent.
	 */
	#thinkingOptionsFor(model: Model): ConfiguredThinkingLevel[] {
		if (!model.reasoning) return [];
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
	}

	/**
	 * Resolve what `t` on a role row would edit: the role's model in its
	 * persisted scope. Undefined when the role is unassigned or its model has
	 * no thinking levels to offer, which makes both `t` and its footer hint
	 * inert — the same rule wildcard fallback rows follow.
	 */
	#roleThinkingTarget(role: string): { item: ModelBrowserItem; scope?: ModelRoleSelectionScope } | undefined {
		const assignment = this.#roles[role];
		if (!assignment) return undefined;
		const source =
			this.#settings.modelRoleStorage === "project" ? this.#settings.getModelRoleSource(role) : "default";
		const scope = source === "project" || source === "global" ? source : undefined;
		const model = scope ? this.#roleForScope(role, scope).model : assignment.model;
		if (!model || this.#thinkingOptionsFor(model).length === 0) return undefined;
		return {
			item: { provider: model.provider, id: model.id, model, selector: `${model.provider}/${model.id}` },
			scope,
		};
	}

	/** Offer only the roles this model can actually fill (chat roles for chat models, `web` for search runners, …). */
	#openRoleStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [];
		const scopedStorage = this.#settings.modelRoleStorage === "project";
		const scopes: readonly ModelRoleSelectionScope[] = scopedStorage ? ["project", "global"] : ["global"];
		for (const role of this.#visibleRoleIds()) {
			const info = this.#settings.getRoleInfo(role);
			if (!info.accepts(item.model)) continue;
			const assignment = this.#roles[role];
			for (const scope of scopes) {
				const scopedModel = scopedStorage
					? this.#roleForScope(role, scope).model
					: assignment && !assignment.autoSelected
						? assignment.model
						: undefined;
				const assignedHere =
					!!scopedModel && scopedModel.provider === item.model.provider && scopedModel.id === item.model.id;
				const roleLabel = (info.tag ?? info.name ?? role).toLowerCase();
				const label = scopedStorage ? `${scope} ${roleLabel}` : roleLabel;
				chips.push({
					label,
					styled: assignedHere
						? // Separator required: under the `nerd` preset this glyph is a
							// two-cell-wide PUA icon that `visibleWidth` counts as one, so
							// without it the icon overhangs and eats `label`'s first char.
							theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) +
							theme.fg("dim", ` ${theme.status.success}`)
						: theme.fg(info.color ?? "muted", label),
					role,
					scope,
					action: assignedHere ? "unassign" : "assign",
				});
			}
		}
		chips.push({
			label: `fallbacks:${item.model.id}`,
			styled: theme.fg("muted", `fallbacks:${item.model.id}`),
			action: "fallbackModel",
		});
		chips.push({
			label: `fallbacks:${item.model.provider}/*`,
			styled: theme.fg("muted", `fallbacks:${item.model.provider}/*`),
			action: "fallbackProvider",
		});
		// `retry-fallback` appends to the default chain, so only chat-capable models qualify.
		if (this.#settings.getRoleInfo("default").accepts(item.model)) {
			chips.push({ label: "fallback", styled: theme.fg("muted", "retry-fallback"), action: "fallback" });
		}
		this.#strip = { kind: "role", item, chips, index: 0, after: "list" };
	}

	#openScopeStrip(item: ModelBrowserItem, role: string, after: StripLanding): void {
		const chips: StripChip[] = [
			{ label: "project", styled: theme.fg("accent", "project"), action: "scope", scope: "project" },
			{ label: "global", styled: theme.fg("muted", "global"), action: "scope", scope: "global" },
		];
		this.#strip = { kind: "scope", item, role, chips, index: 0, after };
	}

	#openThinkingStrip(
		item: ModelBrowserItem,
		role: string,
		after: StripLanding,
		scope?: ModelRoleSelectionScope,
		committedLevel?: ConfiguredThinkingLevel,
	): void {
		const options = this.#thinkingOptionsFor(item.model);
		const current =
			committedLevel ??
			(this.#settings.modelRoleStorage === "project" && scope !== undefined
				? this.#thinkingLevelForScope(role, scope)
				: (this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit));
		const chips = this.#thinkingChips(options);
		const preselect = options.indexOf(current);
		this.#strip = {
			kind: "thinking",
			item,
			role,
			scope,
			chips,
			index: preselect >= 0 ? preselect : 0,
			after,
			initialThinkingLevel: current,
		};
	}

	/** Build the footer chips for a thinking strip from its level options. */
	#thinkingChips(options: ConfiguredThinkingLevel[]): StripChip[] {
		return options.map(level => {
			const label = getConfiguredThinkingLevelMetadata(level).label;
			const glyph = thinkingLevelGlyph(level, theme);
			return {
				label,
				styled: glyph ? `${theme.fg("accent", glyph)} ${label}` : label,
				action: "thinking",
				thinkingLevel: level,
			};
		});
	}

	/**
	 * Fallback-entry model lookup through the registry — the same
	 * case-insensitive, alias-aware resolution the runtime uses, so
	 * `OpenAI/GPT-5.5` edits the model it runs. Covers locked providers too:
	 * effort support is a catalog fact, not an auth fact, and the row already
	 * exists, so the strip changes no scope.
	 */
	#findFallbackModel(provider: string, id: string): ModelBrowserItem | undefined {
		const model = this.#registry.find(provider, id);
		if (!model) return undefined;
		return { provider: model.provider, id: model.id, model, selector: `${model.provider}/${model.id}` };
	}

	/**
	 * Split a fallback-chain entry into its model base, explicit effort, and
	 * `@upstream` routing. An exact literal id wins over routing
	 * (`google-vertex/claude-opus-4-8@default` is a real model, not a route —
	 * mirroring the runtime's exact-first precedence); otherwise the routing
	 * slug is kept verbatim so saves can re-attach it (`openrouter/id@fireworks`
	 * looks up `openrouter/id` but persists with the route intact).
	 */
	#parseFallbackEntry(raw: string):
		| {
				provider: string;
				id: string;
				thinkingLevel?: ConfiguredThinkingLevel;
				upstream: string | undefined;
		  }
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
		if (!routing) {
			if (!literal) return undefined;
			return { ...literal, upstream: undefined };
		}
		const parsed = parse(routing.base.trim());
		if (!parsed) return undefined;
		return { ...parsed, upstream: routing.upstream };
	}

	/**
	 * Resolve a fallback-chain entry to its browser item, explicit effort, and
	 * routing. Undefined when the row is inert: `provider/*` wildcards (always
	 * inherit) or models known neither live nor from the catalog.
	 */
	#resolveFallbackEntry(
		role: string,
		index: number,
	):
		| { item: ModelBrowserItem; thinkingLevel: ConfiguredThinkingLevel | undefined; upstream: string | undefined }
		| undefined {
		const raw = this.#fallbackChains()[role]?.[index];
		if (!raw || raw.endsWith("/*")) return undefined;
		const parsed = this.#parseFallbackEntry(raw);
		if (!parsed) return undefined;
		const item = this.#findFallbackModel(parsed.provider, parsed.id);
		if (!item) return undefined;
		return { item, thinkingLevel: parsed.thinkingLevel, upstream: parsed.upstream };
	}

	/**
	 * Open the thinking strip for a fallback-chain entry (`t` on a `↳` row).
	 * Wildcard entries (`provider/*`) always inherit by design, so `t` is inert on them.
	 */
	#openFallbackThinkingStrip(row: { role: string; chainIndex: number }): void {
		const resolved = this.#resolveFallbackEntry(row.role, row.chainIndex);
		if (!resolved) return;
		const { item } = resolved;
		// No `auto` chip: a hand-written `:auto` suffix collapses to inherit at
		// apply time, so offering it would promise per-prompt classification the
		// fallback never performs. A primary running `auto` is inherited anyway
		// through the bare form.
		const options: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			...getSupportedEfforts(item.model),
		];
		const current =
			resolved.thinkingLevel === undefined || resolved.thinkingLevel === AUTO_THINKING
				? ThinkingLevel.Inherit
				: resolved.thinkingLevel;
		const chips = this.#thinkingChips(options);
		this.#strip = {
			kind: "thinking",
			item,
			role: row.role,
			fallbackIndex: row.chainIndex,
			chips,
			index: Math.max(0, options.indexOf(current)),
			after: "roles",
		};
	}

	/** Persist a fallback entry's thinking choice: an explicit effort is suffixed, inherit is stored bare. */
	#setFallbackThinking(role: string, index: number, level: ConfiguredThinkingLevel): void {
		const chain = [...(this.#fallbackChains()[role] ?? [])];
		if (index >= chain.length) return;
		const resolved = this.#resolveFallbackEntry(role, index);
		if (!resolved) return;
		// Save the registry-canonical spelling (`OpenAI/GPT-5.5` persists as
		// `openai/gpt-5.5:off`), re-attaching `@upstream` routing ahead of the
		// effort suffix (`id@up:low` is the canonical order).
		const base = `${resolved.item.provider}/${resolved.item.id}`;
		const routed = resolved.upstream ? `${base}@${resolved.upstream}` : base;
		const next = formatModelSelectorValue(routed, level);
		chain[index] = next;
		for (let i = chain.length - 1; i >= 0; i--) {
			if (i !== index && chain[i] === next) chain.splice(i, 1);
		}
		this.#setFallbackChain(role, chain);
		const rowIndex = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === role && row.selector === next,
		);
		if (rowIndex >= 0) this.#roleIndex = rowIndex;
	}

	/** Leave the strip chain: back to the list, the Roles view, or the whole hub. */
	#land(after: StripLanding): void {
		switch (after) {
			case "close":
				this.#callbacks.onCancel();
				return;
			case "roles":
				this.#setActiveEntry("roles");
				this.#focus = "list";
				return;
			case "list":
				return;
		}
	}

	/**
	 * Close the strip. A thinking strip finishing a one-pick flow also closes the hub, unless
	 * `keepHubOpen` (the change is still being applied). Esc on a one-pick scope strip backs out
	 * to the model list: nothing was assigned yet.
	 */
	#closeStrip(options?: { keepHubOpen?: boolean }): void {
		const strip = this.#strip;
		this.#strip = null;
		this.#frame.chipRanges = [];
		if (strip?.kind === "thinking") {
			if (strip.after !== "close" || !options?.keepHubOpen) this.#land(strip.after);
		} else if (strip?.kind === "scope" && strip.after === "roles") {
			this.#land("roles");
		}
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (!strip || strip.kind === "name") return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		switch (chip.action) {
			case "assign":
				if (chip.role) {
					this.#strip = null;
					this.#assignRole(strip.item, chip.role, "list", chip.scope);
				}
				return;
			case "unassign":
				if (chip.role) {
					if (this.#settings.modelRoleStorage === "project") {
						this.#callbacks.onUnassign(chip.role, chip.scope);
					} else {
						this.#callbacks.onUnassign(chip.role);
					}
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
			case "fallback":
				this.#appendFallback(strip.item, "default");
				this.#closeStrip();
				return;
			case "fallbackModel":
				this.#closeStrip();
				this.#startAssignFallback(strip.item.selector, null);
				return;
			case "fallbackProvider":
				this.#closeStrip();
				this.#startAssignFallback(`${strip.item.model.provider}/*`, null);
				return;
			case "scope":
				if (strip.role && chip.scope) {
					this.#strip = null;
					this.#assignRole(strip.item, strip.role, strip.after, chip.scope);
				}
				return;
			case "thinking": {
				if (strip.role && chip.thinkingLevel !== undefined && strip.fallbackIndex !== undefined) {
					this.#setFallbackThinking(strip.role, strip.fallbackIndex, chip.thinkingLevel);
					this.#strip = null;
					this.#frame.chipRanges = [];
					return;
				}
				// The preselected level is confirmation, not a force-reapply action;
				// only a changed level should call setModel() again.
				const changed = chip.thinkingLevel !== strip.initialThinkingLevel;
				if (strip.role && chip.thinkingLevel !== undefined && changed) {
					const result = this.#callbacks.onAssign(
						strip.item.model,
						strip.role,
						chip.thinkingLevel,
						strip.item.selector,
						strip.scope,
					);
					this.#closeStrip({ keepHubOpen: true });
					this.#finishAssignment(result, () => {
						this.#refreshAfterMutation();
						if (strip.after === "close") this.#land("close");
					});
				} else {
					this.#closeStrip();
				}
				return;
			}
		}
	}

	/**
	 * Switch the body into assign mode for `role`: full catalog, cleared query, current model preselected.
	 * Arrows land on the model rows (the next step of the flow); ← still reaches the provider scopes.
	 */
	#startAssign(role: string): void {
		this.#assigning = { kind: "role", role };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
		const current = this.#roles[role];
		if (current) {
			this.#browser.selectSelector(`${current.model.provider}/${current.model.id}`);
		}
	}

	/** Browse the catalog to fill a fallback-chain slot: `index` replaces an entry, `null` appends. */
	#startAssignFallback(role: string, index: number | null): void {
		this.#assigning = { kind: "fallback", role, index };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
		if (index !== null) {
			const selector = this.#fallbackChains()[role]?.[index];
			// Suffixed entries (`provider/id:low`) carry effort the browser rows
			// don't show; match on the base so the current model preselects.
			if (selector) {
				const parsed = this.#parseFallbackEntry(selector);
				this.#browser.selectSelector(parsed ? `${parsed.provider}/${parsed.id}` : selector);
			}
		}
	}

	/** Browse the catalog for the primary model a brand-new fallback chain protects. */
	#startAssignFallbackKey(): void {
		this.#assigning = { kind: "fallbackKey" };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
	}

	/** Second step of "+ New fallback…": key the chain by the picked model or its whole provider. */
	#openFallbackKeyStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [
			{
				label: `for ${item.selector}`,
				styled: theme.fg("muted", `for ${item.selector}`),
				action: "fallbackModel",
			},
			{
				label: `for ${item.model.provider}/*`,
				styled: theme.fg("muted", `for ${item.model.provider}/*`),
				action: "fallbackProvider",
			},
		];
		this.#strip = { kind: "role", item, chips, index: 0, after: "list" };
	}

	/** Write the picked model into the target chain slot, dedupe, and land back on its Roles row. */
	#commitFallback(item: ModelBrowserItem, target: { role: string; index: number | null }): void {
		const chain = [...(this.#fallbackChains()[target.role] ?? [])];
		// New picks are stored bare, i.e. inherit-the-primary; `t` on the row specializes the effort.
		const selector = item.selector;
		if (target.index !== null && target.index < chain.length) {
			chain[target.index] = selector;
			for (let i = chain.length - 1; i >= 0; i--) {
				if (i !== target.index && chain[i] === selector) chain.splice(i, 1);
			}
		} else if (!chain.includes(selector)) {
			chain.push(selector);
		}
		this.#setFallbackChain(target.role, chain);
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
		const rowIndex = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === target.role && row.selector === selector,
		);
		if (rowIndex >= 0) this.#roleIndex = rowIndex;
	}

	/** Persist `role`'s chain through the host callback and rebuild dependent state. */
	#setFallbackChain(role: string, chain: string[]): void {
		this.#callbacks.onFallbackChainChange?.(role, chain);
		this.#refreshAfterMutation();
	}

	/** Append `item` to `role`'s fallback chain (no-op when already present). */
	#appendFallback(item: ModelBrowserItem, role: string): void {
		const chain = [...(this.#fallbackChains()[role] ?? [])];
		if (chain.includes(item.selector)) return;
		chain.push(item.selector);
		this.#setFallbackChain(role, chain);
	}

	/** Remove one chain entry; the cursor stays on the nearest surviving row. */
	#removeFallback(row: { role: string; chainIndex: number }): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		if (row.chainIndex >= chain.length) return;
		chain.splice(row.chainIndex, 1);
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
	}

	/** Move a chain entry one slot earlier/later; the cursor follows the moved entry. */
	#moveFallback(row: { role: string; chainIndex: number }, delta: -1 | 1): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		const target = row.chainIndex + delta;
		if (row.chainIndex >= chain.length || target < 0 || target >= chain.length) return;
		[chain[row.chainIndex], chain[target]] = [chain[target], chain[row.chainIndex]];
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex += delta;
	}

	#cancelAssign(): void {
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Quick-switch cycle (ctrl+p) editing
	// ═══════════════════════════════════════════════════════════════════════

	#cycleOrder(): string[] {
		try {
			return [...this.#settings.cycleOrder];
		} catch {
			return [];
		}
	}

	/** Toggle `role`'s membership in the quick-switch cycle (appended at the end). */
	#toggleCycleMembership(role: string): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		if (index >= 0) {
			order.splice(index, 1);
		} else {
			order.push(role);
		}
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Move `role` one slot earlier/later within the cycle order. */
	#moveCycleMembership(role: string, delta: -1 | 1): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		const target = index + delta;
		if (index < 0 || target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target], order[index]];
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Open the footer name input: a new custom role, or saving the current setup as a model preset. */
	#openNameStrip(purpose: "role" | "preset"): void {
		this.#strip = { kind: "name", purpose, input: new Input() };
	}

	/** Validate and commit the name strip: a new role jumps into assigning it, a preset name saves it. */
	#submitNameStrip(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name") return;
		if (strip.purpose === "preset") {
			this.#submitPresetName();
			return;
		}
		this.#submitRoleName();
	}

	/** Validate and commit the new-role name: jump straight into assigning it. */
	#submitRoleName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name" || strip.purpose !== "role") return;
		const name = strip.input.getValue().trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		if (this.#visibleRoleIds().includes(name)) return;
		this.#strip = null;
		this.#frame.chipRanges = [];
		this.#startAssign(name);
	}

	/** Validate and commit the preset name: save the current setup under it (overwrites). */
	#submitPresetName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name" || strip.purpose !== "preset") return;
		const name = strip.input.getValue().trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		this.#strip = null;
		this.#frame.chipRanges = [];
		this.#callbacks.onSavePreset?.(name);
		this.#refreshAfterMutation();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	#moveModelKind(delta: -1 | 1): void {
		const current = MODEL_KIND_TABS.indexOf(this.#modelKindTab);
		const next = (Math.max(0, current) + delta + MODEL_KIND_TABS.length) % MODEL_KIND_TABS.length;
		this.#modelKindTab = MODEL_KIND_TABS[next] ?? "all";
		this.#applyModelKind();
	}

	#moveRoleTab(delta: -1 | 1): void {
		const current = ROLE_TABS.indexOf(this.#roleTab);
		const next = (Math.max(0, current) + delta + ROLE_TABS.length) % ROLE_TABS.length;
		this.#roleTab = ROLE_TABS[next] ?? "all";
		this.#roleIndex = 0;
		this.#roleScrollStart = 0;
		this.#buildRolesRows();
	}

	/** Saved presets and the one the setup matches; empty unless the host can both list and switch. */
	#presets(): { names: readonly string[]; active: string | undefined } {
		if (!this.#callbacks.onSwitchPreset || !this.#settings.getModelPresets) return { names: [], active: undefined };
		const revision = this.#settings.revision;
		if (this.#presetsMemo?.revision !== revision) {
			const { names, active } = this.#settings.getModelPresets();
			this.#presetsMemo = { revision, names, active };
		}
		return this.#presetsMemo;
	}

	/**
	 * The preset ctrl+←/→ steps from: the last one tried here while settings are
	 * unchanged since (a refused switch writes nothing, so the next press moves
	 * past it) or nothing matches; otherwise the preset the setup matches.
	 */
	#presetBase(active: string | undefined): string | undefined {
		const cursor = this.#presetCursor;
		if (cursor && (active === undefined || cursor.revision === this.#settings.revision)) return cursor.name;
		return active;
	}

	/** Apply the previous/next saved preset (wrapping), as `/modelpreset switch` does. */
	#switchPreset(delta: -1 | 1): void {
		const onSwitchPreset = this.#callbacks.onSwitchPreset;
		const { names, active } = this.#presets();
		if (!onSwitchPreset || names.length === 0) return;
		const base = this.#presetBase(active);
		const current = base === undefined ? -1 : names.indexOf(base);
		const next = current < 0 ? (delta > 0 ? 0 : names.length - 1) : (current + delta + names.length) % names.length;
		const name = names[next];
		if (name === undefined) return;
		const settle = () => {
			this.#presetCursor = { name, revision: this.#settings.revision };
			this.#refreshAfterMutation();
		};
		// Stepping onto the preset already in effect has nothing to apply.
		if (name === active) {
			settle();
			return;
		}
		// The host reports refusals itself, so the cursor moves once the switch
		// resolves, refused or not (`#presetBase` sees a refusal left the revision alone).
		this.#finishAssignment(onSwitchPreset(name), settle);
	}

	handleInput(data: string): void {
		this.#nativeVersion++;
		if (this.#assignmentPending) {
			if (matchesSelectCancel(data)) this.#callbacks.onCancel();
			return;
		}
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(data);
			return;
		}

		if (matchesSelectCancel(data)) {
			this.#cancel();
			return;
		}

		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked && this.#assigning === null;

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			return;
		}
		if (matchesKey(data, "f5")) {
			if (entry.kind === "provider" && !entry.locked) {
				this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
			}
			return;
		}
		// Ctrl+←/→ in the Roles view steps through saved model presets, wrapping.
		if (rolesView && (matchesKey(data, "ctrl+left") || matchesKey(data, "ctrl+right"))) {
			this.#switchPreset(matchesKey(data, "ctrl+left") ? -1 : 1);
			return;
		}
		// Alt+←/→ cycles whichever tab strip is on screen: role tabs in the
		// Roles view, kind tabs in every browser view. Ctrl+←/→ is unusable on
		// macOS (Spaces shortcut). macOS terminals (ghostty, Terminal.app,
		// iTerm) send ESC b / ESC f for Option+←/→, which parse as alt+b /
		// alt+f — the same aliases the editor's word-motion bindings accept.
		if (matchesKey(data, "alt+left") || matchesKey(data, "alt+b")) {
			if (rolesView) this.#moveRoleTab(-1);
			else this.#moveModelKind(-1);
			return;
		}
		if (matchesKey(data, "alt+right") || matchesKey(data, "alt+f")) {
			if (rolesView) this.#moveRoleTab(1);
			else this.#moveModelKind(1);
			return;
		}

		// ←/→ are spatial pane switches: the sidebar sits left of the rows.
		// They never reach the search caret — fuzzy queries don't need one.
		if (matchesKey(data, "left")) {
			this.#focus = "scope";
			return;
		}
		if (matchesKey(data, "right")) {
			// Only views with rows can take list focus (not the locked pane).
			if (rolesView || this.#isBrowserView(entry)) {
				this.#focus = "list";
			}
			return;
		}

		// Arrow ownership: scope mode hops the sidebar; list mode navigates rows.
		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				return;
			}
		}

		if (rolesView) {
			const printable = extractPrintableText(data);
			if (this.#focus === "scope" && printable !== undefined && printable.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			this.#handleRolesViewInput(data);
			return;
		}
		if (lockedView) {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#requestLogin(entry);
			}
			return;
		}

		// Enter on the sidebar is a pane switch, like →: it lands on the model
		// rows instead of acting on a row the user cannot see is selected.
		if (this.#focus === "scope" && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n")) {
			this.#focus = "list";
			return;
		}

		const beforeQuery = this.#browser.query;
		const isPrintable = extractPrintableText(data) !== undefined;
		this.#browser.handleInput(data);
		if (isPrintable || this.#browser.query !== beforeQuery) {
			this.#focus = "list";
		}
	}

	/** The cancel key's ladder: close a strip, leave assign mode, clear the query, then close the hub. */
	#cancel(): void {
		if (this.#assignmentPending) {
			this.#callbacks.onCancel();
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
		if (this.#isBrowserView(this.#activeEntry()) && this.#browser.query.length > 0) {
			this.#browser.handleCancel();
			return;
		}
		this.#callbacks.onCancel();
	}

	#isBrowserView(entry: SidebarEntry): boolean {
		if (this.#assigning !== null) return true;
		return entry.kind === "recent" || entry.kind === "all" || (entry.kind === "provider" && !entry.locked);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		if (matchesSelectCancel(data)) {
			this.#closeStrip();
			return;
		}
		if (strip.kind === "name") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#submitNameStrip();
				return;
			}
			strip.input.handleInput(data);
			return;
		}
		if (moveStripSelection(strip, data)) return;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		if (index < 0) index = 0;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && !this.#isHopSkipped(entry)) {
				// Scope changes keep an active assignment (scoping helps find the
				// model); landing on the Roles view cancels it.
				if (entry.kind === "roles") this.#assigning = null;
				this.#setActiveEntry(entry.id);
				return;
			}
		}
	}

	/** Row count of the roles view (roles, their fallback entries, and the trailing "+ New role…" row). */
	get #rolesRowCount(): number {
		return this.#rolesRows.length;
	}

	/** Enter/click activation for a Roles-view row. */
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
				this.#startAssignFallbackKey();
				return;
			case "newRole":
				this.#openNameStrip("role");
				return;
			case "separator":
				return;
		}
	}

	/** Scroll `#roleScrollStart` just enough to keep `#roleIndex` inside a window of `viewHeight` rows, clamped to the list. */
	#ensureRoleVisible(viewHeight: number, total: number): number {
		if (viewHeight <= 0) return 0;
		let start = this.#roleScrollStart;
		if (this.#roleIndex < start) start = this.#roleIndex;
		else if (this.#roleIndex >= start + viewHeight) start = this.#roleIndex - viewHeight + 1;
		return Math.max(0, Math.min(start, Math.max(0, total - viewHeight)));
	}

	/** Step the roles cursor by one row, skipping separator rows. Wraps at the ends unless `wrap: false` (then the cursor stays put). */
	#stepRoleIndex(from: number, delta: -1 | 1, options: { wrap?: boolean } = {}): number {
		const wrap = options.wrap ?? true;
		const count = this.#rolesRows.length;
		if (count === 0) return 0;
		let index = from;
		for (let i = 0; i < count; i++) {
			const next = index + delta;
			if (next < 0 || next >= count) {
				if (!wrap) return from;
				index = (next + count) % count;
			} else {
				index = next;
			}
			if (this.#rolesRows[index]?.kind !== "separator") return index;
		}
		return from;
	}

	#handleRolesViewInput(data: string): void {
		// Scope focus treats the roles view as a preview: Enter/Space dives
		// into the rows, everything else is inert (arrows already hop).
		if (this.#focus === "scope") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space")) {
				this.#focus = "list";
			}
			return;
		}
		if (matchesSelectUp(data)) {
			this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, -1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#runRolesAction("pick");
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			this.#runRolesAction("clear");
			return;
		}
		// Reordering: [ / shift+↑ moves the row earlier, ] / shift+↓ later —
		// cycle order on a role row, chain order on a fallback row.
		if (matchesKey(data, "shift+up")) {
			this.#runRolesAction("earlier");
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.#runRolesAction("later");
			return;
		}
		const printable = extractPrintableText(data);
		if (printable !== undefined && Object.hasOwn(ROLES_ACTION_KEYS, printable)) {
			this.#runRolesAction(ROLES_ACTION_KEYS[printable]!);
		}
	}

	/** One Roles-view command on the selected row (keys and action-bar buttons share it). */
	#runRolesAction(action: RolesAction): void {
		const row = this.#rolesRows[this.#roleIndex];
		const role = row?.kind === "role" ? row.role : undefined;
		switch (action) {
			case "pick":
				if (row) this.#activateRolesRow(row);
				return;
			case "clear":
				if (role) this.#unassignRole(role);
				else if (row?.kind === "fallback") this.#removeFallback(row);
				else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
				return;
			case "fallback":
				if (row?.kind === "newFallback") this.#startAssignFallbackKey();
				else if (row && row.kind !== "newRole" && row.kind !== "separator") {
					this.#startAssignFallback(row.role, null);
				}
				return;
			case "cycle":
				if (role) this.#toggleCycleMembership(role);
				return;
			case "earlier":
			case "later": {
				const delta = action === "earlier" ? -1 : 1;
				if (role) this.#moveCycleMembership(role, delta);
				else if (row?.kind === "fallback") this.#moveFallback(row, delta);
				return;
			}
			case "new":
				this.#openNameStrip("role");
				return;
			case "save":
				if (this.#callbacks.onSavePreset) this.#openNameStrip("preset");
				return;
			case "nextPreset":
			case "prevPreset":
				this.#switchPreset(action === "nextPreset" ? 1 : -1);
				return;
			case "thinking":
				if (role) {
					const target = this.#roleThinkingTarget(role);
					if (target) this.#openThinkingStrip(target.item, role, "roles", target.scope);
				} else if (row?.kind === "fallback") {
					this.#openFallbackThinkingStrip(row);
				}
				return;
		}
	}

	#requestLogin(entry: SidebarEntry): void {
		if (!entry.providerId) return;
		if (entry.oauth) {
			this.#callbacks.onLoginRequest?.(entry.providerId);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		if (this.#assignmentPending) return true;
		const { footerColumn, bodyHeight, contentLine, overSidebar, overBody, bodyLine } = this.#frame.locate(
			event.row,
			event.col,
		);
		const entry = this.#activeEntry();

		// Footer strip chips (columns stay in frame coordinates).
		if (footerColumn !== undefined && this.#strip) {
			const strip = this.#strip;
			if (event.leftClick && strip.kind !== "name" && this.#frame.selectChipAt(strip, footerColumn)) {
				this.#activateStripChip();
			}
			return true;
		}

		if (event.wheel !== null) {
			if (overSidebar) {
				// Wheel pans the sidebar viewport; picking a scope is click/keys only.
				this.#frame.scrollSidebar(event.wheel, bodyHeight, this.#entries.length);
				this.#sidebarHover = this.#sidebarEntryIndexAt(contentLine);
			} else if (overBody) {
				if (entry.kind === "roles" && this.#assigning === null) {
					this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, event.wheel > 0 ? 1 : -1, { wrap: false });
				} else if (this.#isBrowserView(entry) && bodyLine > 0) {
					this.#browser.routeMouse(event, bodyLine - 1);
				}
			}
			return true;
		}

		if (event.motion) {
			this.#sidebarHover = overSidebar ? this.#sidebarEntryIndexAt(contentLine) : null;
			if (overBody && entry.kind === "roles" && this.#assigning === null) {
				const roleLine = bodyLine - this.#rolesRowStart;
				this.#roleHover =
					roleLine >= 0 && roleLine < this.#rolesVisibleCount ? roleLine + this.#roleScrollStart : null;
			} else {
				this.#roleHover = null;
				if (overBody && this.#isBrowserView(entry) && bodyLine > 0) {
					this.#browser.routeMouse(event, bodyLine - 1);
				} else {
					// Pointer left the browser pane: without this, the last
					// hovered row keeps its band while the sidebar hovers too.
					this.#browser.clearHover();
				}
			}
			return true;
		}

		if (!event.leftClick) return true;

		if (overSidebar) {
			const index = this.#sidebarEntryIndexAt(contentLine);
			this.#clickSidebarEntry(index !== null ? this.#entries[index] : undefined);
			return true;
		}

		if (overBody) {
			if (entry.kind === "roles" && this.#assigning === null) {
				this.#focus = "list";
				const listLine = bodyLine - this.#rolesRowStart;
				if (listLine >= 0 && listLine < this.#rolesVisibleCount) {
					const roleLine = listLine + this.#roleScrollStart;
					const rowDef = this.#rolesRows[roleLine];
					if (rowDef && rowDef.kind !== "separator") {
						if (roleLine === this.#roleIndex) {
							this.#activateRolesRow(rowDef);
						} else {
							this.#roleIndex = roleLine;
						}
					}
				}
			} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
				if (this.#lockedLoginLine !== null && bodyLine === this.#lockedLoginLine) {
					this.#requestLogin(entry);
				}
			} else if (this.#isBrowserView(entry) && bodyLine > 0) {
				this.#browser.routeMouse(event, bodyLine - 1);
			}
		}
		return true;
	}

	/** Pointer activation of a sidebar entry: pick the scope; a second click on a locked provider logs in. */
	#clickSidebarEntry(clicked: SidebarEntry | undefined): void {
		if (!clicked || clicked.kind === "separator") return;
		const already = clicked.id === this.#activeEntryId;
		if (clicked.kind === "roles") this.#assigning = null;
		this.#setActiveEntry(clicked.id);
		// A click on Roles is a deliberate dive into the rows.
		if (clicked.kind === "roles") this.#focus = "list";
		if (already && clicked.kind === "provider" && clicked.locked) {
			this.#requestLogin(clicked);
		}
	}

	/** Map a content-line index to a sidebar entry index (accounting for scroll). */
	#sidebarEntryIndexAt(contentLine: number): number | null {
		const index = this.#frame.sidebarScroll + contentLine;
		if (index < 0 || index >= this.#entries.length) return null;
		return index;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#renderSidebar(width: number, rows: number): string[] {
		const lines = this.#frame.renderSidebar(
			this.#entries,
			width,
			rows,
			{ id: this.#activeEntryId, focused: this.#focus === "scope", follow: this.#sidebarFollowActive, clamp: true },
			this.#sidebarStyle,
		);
		this.#sidebarFollowActive = false;
		return lines;
	}

	#sidebarStyle = (entry: SidebarEntry, index: number): SidebarStyle => {
		const searching = this.#searchCounts !== null;
		let matchCount: number | undefined;
		if (searching) {
			if (entry.kind === "provider" && !entry.locked) {
				matchCount = this.#searchCounts?.get(entry.providerId ?? "") ?? 0;
			} else if (entry.kind === "recent") {
				matchCount = this.#recentSearchCount;
			} else if (entry.kind === "all") {
				matchCount = this.#searchTotal;
			}
		}
		// Search-ineligible entries gray out, but keep their place in the viewport.
		const muted = entry.locked || matchCount === 0 || (searching && entry.kind === "roles");
		let icon: string;
		if (entry.kind === "recent") {
			icon = theme.icon.time;
		} else if (entry.kind === "roles") {
			icon = theme.icon.extensionSkill;
		} else if (entry.kind === "all") {
			icon = theme.icon.model;
		} else {
			icon = muted ? theme.status.shadowed : theme.status.enabled;
		}
		const refreshing = entry.providerId ? this.#refreshingProviders.has(entry.providerId) : false;
		const annotationText = matchCount !== undefined ? String(matchCount) : (entry.annotation ?? "");
		return {
			icon: theme.fg(muted ? "dim" : entry.kind === "provider" ? "success" : "accent", icon),
			annotation: refreshing
				? theme.fg("warning", theme.spinnerFrames[this.#refreshSpinnerFrame % theme.spinnerFrames.length] ?? "")
				: theme.fg("dim", annotationText),
			muted,
			hovered: index === this.#sidebarHover,
			padTruncated: true,
		};
	};

	#renderModelKindTabs(width: number): string {
		const active = MODEL_KIND_TABS.indexOf(this.#modelKindTab);
		const track = renderSegmentTrack(
			MODEL_KIND_TABS.map(kind => ({ label: kind })),
			Math.max(0, active),
		);
		return truncateToWidth(
			` ${theme.fg("dim", "Kind:")} ${track}  ${theme.fg("dim", formatKeyHints(["alt+left", "alt+right"]))}`,
			width,
		);
	}

	#renderRoleTabs(width: number): string {
		const active = ROLE_TABS.indexOf(this.#roleTab);
		const track = renderSegmentTrack(
			ROLE_TABS.map(tab => ({ label: tab === "kind" ? "kinds" : tab })),
			Math.max(0, active),
		);
		const { names, active: activePreset } = this.#presets();
		const preset =
			names.length > 0
				? `   ${theme.fg("dim", "Preset:")} ${activePreset ? theme.fg("accent", activePreset) : theme.fg("muted", "custom")}  ${theme.fg("dim", `${formatKeyHints(["ctrl+left", "ctrl+right"])} · ${formatKeyHints(["p", "shift+p"])}`)}`
				: "";
		return truncateToWidth(
			` ${theme.fg("dim", "Roles:")} ${track}  ${theme.fg("dim", formatKeyHints(["alt+left", "alt+right"]))}${preset}`,
			width,
		);
	}

	#statusRow(width: number): string {
		if (this.#assignmentPending) {
			return truncateToWidth(theme.fg("accent", " Applying model…"), width);
		}
		if (this.#assigning !== null) {
			const enter = formatKeyHint("enter");
			const cancel = editorKey("tui.select.cancel");
			if (this.#assigning.kind === "fallbackKey") {
				return truncateToWidth(
					theme.fg("accent", ` New fallback chain — ${enter} picks the model it protects, ${cancel} cancels`),
					width,
				);
			}
			const info = this.#settings.getRoleInfo(this.#assigning.role);
			const label = info.tag ?? info.name ?? this.#assigning.role;
			if (this.#assigning.kind === "fallback") {
				const verb = this.#assigning.index === null ? "Adding fallback for" : "Replacing fallback of";
				return truncateToWidth(
					theme.fg(
						"accent",
						` ${verb} ${theme.bold(label)} — ${enter} picks the fallback model, ${cancel} cancels`,
					),
					width,
				);
			}
			return truncateToWidth(
				theme.fg("accent", ` Assigning ${theme.bold(label)} — ${enter} assigns, ${cancel} cancels`),
				width,
			);
		}
		const entry = this.#activeEntry();
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		let text: string;
		switch (entry.kind) {
			case "recent":
				text = `Recently used models${scopedSuffix}`;
				break;
			case "roles":
				text = `Model roles — ${formatKeyHint("f")} adds a retry fallback, cleared roles fall back to auto-selection`;
				break;
			case "provider":
				if (entry.locked) {
					text = `${entry.label} · not configured`;
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					text = `${entry.label} · refreshing model list…`;
				} else {
					text = `${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`;
				}
				break;
			default:
				text = `All available models${scopedSuffix}`;
				break;
		}
		if (this.#configError && entry.kind !== "provider") {
			text = this.#configError;
			return truncateToWidth(theme.fg("error", ` ${text}`), width);
		}
		return truncateToWidth(theme.fg("muted", ` ${text}`), width);
	}

	/** Clamp a roles row to `width`; the bg band is reserved for mouse hover. */
	#finishRolesRow(line: string, width: number, hovered: boolean): string {
		let out = truncateToWidth(line, width);
		if (hovered) {
			const w = visibleWidth(out);
			if (w < width) out += " ".repeat(width - w);
			return theme.bg("selectedBg", out);
		}
		return out;
	}

	#renderRolesView(width: number, rows: number): string[] {
		const lines: string[] = [];
		lines.push(this.#renderRoleTabs(width));
		// First row's offset in bodyLine coordinates: the mouse router's
		// `bodyLine` has already dropped the status row, leaving the tabs row.
		this.#rolesRowStart = lines.length;

		let tagWidth = 0;
		for (const rowDef of this.#rolesRows) {
			if (rowDef.kind !== "role") continue;
			const info = this.#settings.getRoleInfo(rowDef.role);
			tagWidth = Math.max(tagWidth, visibleWidth(info.tag ?? info.name ?? rowDef.role));
		}

		const cycleOrder = this.#cycleOrder();
		const listFocused = this.#focus === "list";
		// Window the list around the cursor so entries past the panel height stay
		// reachable; the trailing indicator line steals one row when clipped.
		const total = this.#rolesRows.length;
		const capacity = Math.max(0, rows - 2 - this.#rolesRowStart);
		const overflow = total > capacity;
		const viewHeight = overflow ? Math.max(0, capacity - 1) : capacity;
		this.#roleScrollStart = this.#ensureRoleVisible(viewHeight, total);
		const endIndex = Math.min(this.#roleScrollStart + viewHeight, total);
		this.#rolesVisibleCount = Math.max(0, endIndex - this.#roleScrollStart);
		for (let i = this.#roleScrollStart; i < endIndex; i++) {
			const rowDef = this.#rolesRows[i];
			if (!rowDef) continue;
			const selected = i === this.#roleIndex;
			const hovered = i === this.#roleHover;
			// The unfocused pane draws no cursor; accent text still marks the row.
			const cursor = selected && listFocused ? theme.fg("accent", theme.nav.cursor) : " ";

			if (rowDef.kind === "separator") {
				lines.push(`   ${theme.fg("border", "─".repeat(Math.max(1, width - 6)))}`);
				continue;
			}

			if (rowDef.kind === "newRole" || rowDef.kind === "newFallback") {
				const label = rowDef.kind === "newRole" ? "+ New role…" : "+ New fallback…";
				let line = ` ${cursor} ${theme.fg(selected ? "accent" : "dim", label)}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			if (rowDef.kind === "chainKey") {
				const key = rowDef.role;
				const slash = key.lastIndexOf("/");
				const tail = key.slice(slash + 1);
				const keyStyled = theme.fg("dim", key.slice(0, slash + 1)) + (selected ? theme.fg("accent", tail) : tail);
				let line = ` ${cursor} ${theme.fg("dim", theme.status.shadowed)} ${keyStyled}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			if (rowDef.kind === "fallback") {
				const branch = theme.fg("dim", `${"".padEnd(tagWidth + 3)}↳`);
				const selector = selected ? theme.fg("accent", rowDef.selector) : theme.fg("muted", rowDef.selector);
				let line = ` ${cursor} ${branch} ${selector}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			const role = rowDef.role;
			const info = this.#settings.getRoleInfo(role);
			const assignment = this.#roles[role];
			const tag = (info.tag ?? info.name ?? role).padEnd(tagWidth);

			let dot: string;
			let tagStyled: string;
			let value: string;
			let levelStyled = "";
			if (assignment && !assignment.autoSelected) {
				dot = theme.fg(info.color ?? "muted", theme.status.enabled);
				tagStyled = theme.fg(info.color ?? "muted", tag);
				value = `${theme.fg("dim", `${assignment.model.provider}/`)}${selected ? theme.fg("accent", assignment.model.id) : assignment.model.id}`;
				const glyph = thinkingLevelGlyph(assignment.thinkingLevel, theme);
				const label = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
					levelStyled = theme.fg("dim", glyph ? `${glyph} ${label}` : label);
				}
			} else if (assignment) {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", `auto → ${assignment.model.provider}/${assignment.model.id}`);
			} else {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", "—");
			}

			// Quick-cycle membership badge (`⟳ 2` = second stop of the ctrl+p cycle).
			const cycleIndex = cycleOrder.indexOf(role);
			const cycleStyled = cycleIndex >= 0 ? theme.fg("accent", `${theme.icon.loop} ${cycleIndex + 1}`) : "";

			let line = ` ${cursor} ${dot} ${tagStyled}  ${value}`;
			const right = [levelStyled, cycleStyled].filter(part => part.length > 0).join("  ");
			const rightWidth = visibleWidth(right);
			const lineWidth = visibleWidth(line);
			if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
			}
			line = this.#finishRolesRow(line, width, hovered);
			lines.push(line);
		}

		if (overflow) {
			const hiddenAbove = this.#roleScrollStart;
			const hiddenBelow = total - endIndex;
			const parts: string[] = [];
			if (hiddenAbove > 0) parts.push(`↑ ${hiddenAbove} more`);
			if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} more`);
			lines.push(truncateToWidth(theme.fg("dim", `   ${parts.join("   ")}`), width));
		}

		// Live preview of the quick-switch cycle, rendered with the exact
		// segment track the ctrl+p status uses; the selected role's chip fills.
		while (lines.length < rows - 1) lines.push("");
		if (rows >= 2) {
			const cycleKey = editorKey("app.model.cycleForward") || formatKeyHint("ctrl+p");
			if (cycleOrder.length > 0) {
				const selectedRow = this.#rolesRows[this.#roleIndex];
				const selectedRole =
					selectedRow && (selectedRow.kind === "role" || selectedRow.kind === "fallback") ? selectedRow.role : "";
				const activeIndex = cycleOrder.indexOf(selectedRole);
				const track = renderSegmentTrack(
					cycleOrder.map(role => ({ label: role })),
					activeIndex,
				);
				lines[rows - 1] = truncateToWidth(`  ${theme.fg("dim", `${cycleKey} cycle:`)} ${track}`, width);
			} else {
				lines[rows - 1] = truncateToWidth(
					theme.fg("dim", `  ${cycleKey} cycle is empty — press ${formatKeyHint("c")} on a role to add it`),
					width,
				);
			}
		}
		return lines;
	}

	#renderLockedView(entry: SidebarEntry, width: number, rows: number): string[] {
		const lines: string[] = [];
		this.#lockedLoginLine = null;
		lines.push("");
		lines.push(truncateToWidth(theme.fg("warning", `  ${entry.label} has no credentials configured`), width));
		lines.push("");
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		if (envVars.length > 0) {
			lines.push(
				truncateToWidth(
					theme.fg("muted", `  Set ${envVars.join(" or ")} in your environment, or add a key in config.`),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(theme.fg("muted", "  Add an API key for this provider in config."), width));
		}
		if (entry.oauth) {
			this.#lockedLoginLine = lines.length + 1; // +1 for the status row offset handled by caller
			lines.push(
				truncateToWidth(
					theme.fg("accent", `  ${theme.nav.cursor} Log in with OAuth (${formatKeyHint("enter")})`),
					width,
				),
			);
		}
		lines.push("");
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${catalogCount} models in catalog:`), width));
			const preview = this.#scopedModels.length > 0 ? [] : this.#registry.getAll("all");
			for (const model of preview) {
				if (model.provider !== entry.providerId) continue;
				if (lines.length >= rows) break;
				lines.push(truncateToWidth(theme.fg("dim", `    ${model.id}`), width));
			}
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		const enter = formatKeyHint("enter");
		const cancel = editorKey("tui.select.cancel");
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const left = formatKeyHint("left");
		const leftRight = formatKeyHints(["left", "right"]);
		const enterRight = formatKeyHints(["enter", "right"]);
		const altLeftRight = formatKeyHints(["alt+left", "alt+right"]);
		const strip = this.#strip;
		if (strip) {
			if (strip.kind === "name") {
				if (strip.purpose === "preset") {
					return `${enter} save preset · ${cancel} cancel`;
				}
				return `${enter} create + pick model · ${cancel} cancel`;
			}
			if (strip.kind === "role") return `${leftRight} choose · ${enter} assign/clear · ${cancel} cancel`;
			if (strip.kind === "scope") return `${leftRight} save scope · ${enter} choose · ${cancel} cancel`;
			return `${leftRight} thinking level · ${enter} apply · ${cancel} keep`;
		}
		if (this.#assigning !== null) {
			if (this.#focus === "scope") {
				return `${enterRight} models · ${upDown} providers · type to search · ${altLeftRight} kind · ${cancel} cancel`;
			}
			const browse = `${upDown} models · ${left} providers · type to search · ${altLeftRight} kind · ${cancel} cancel`;
			switch (this.#assigning.kind) {
				case "fallback":
					return `${enter} pick fallback · ${browse}`;
				case "fallbackKey":
					return `${enter} pick the protected model · ${browse}`;
				default:
					return `${enter} assign · ${browse}`;
			}
		}
		const entry = this.#activeEntry();
		if (entry.kind === "roles") {
			if (this.#focus !== "list") {
				const presets =
					this.#presets().names.length > 0 ? ` · ${formatKeyHints(["ctrl+left", "ctrl+right"])} preset` : "";
				return `${upDown} providers · ${enterRight} roles · ${altLeftRight} tabs${presets} · ${cancel} close`;
			}
			const row = this.#rolesRows[this.#roleIndex];
			if (row?.kind === "fallback") {
				// Advertise `t` only when the entry resolves: wildcards always
				// inherit and unknown models have no ladder to offer, so the
				// action would be inert there.
				const editable = this.#resolveFallbackEntry(row.role, row.chainIndex) !== undefined;
				const thinking = editable ? ` · ${formatKeyHint("t")} thinking` : "";
				return `${upDown} rows · ${enter} replace · ${formatKeyHint("f")} add another · ${formatKeyHint("x")} remove${thinking} · [/] reorder · ${left} providers`;
			}
			if (row?.kind === "chainKey") {
				return `${upDown} rows · ${formatKeyHints(["enter", "f"])} add fallback · ${formatKeyHint("x")} clear chain · ${left} providers`;
			}
			if (row?.kind === "newFallback") {
				return `${upDown} rows · ${enter} new model/provider fallback chain · ${left} providers`;
			}
			// Same rule as fallback rows: advertise `t` only where a strip would
			// open — an assigned role whose model has thinking levels to offer.
			const editable = row?.kind === "role" && this.#roleThinkingTarget(row.role) !== undefined;
			const thinking = editable ? ` · ${formatKeyHint("t")} thinking` : "";
			const savePreset = this.#callbacks.onSavePreset ? ` · ${formatKeyHint("s")} save preset` : "";
			const switchPreset = this.#presets().names.length > 0 ? ` · ${formatKeyHints(["p", "shift+p"])} preset` : "";
			return `${upDown} rows · ${enter} pick · ${formatKeyHint("f")} fallback · ${formatKeyHint("x")} clear${thinking} · ${formatKeyHint("c")} cycle · [/] reorder · ${formatKeyHint("n")} new${savePreset}${switchPreset}`;
		}
		if (entry.kind === "provider" && entry.locked) {
			return entry.oauth
				? `${enter} log in · ${upDown} providers · ${cancel} close`
				: `${upDown} providers · ${cancel} close`;
		}
		const refresh = entry.kind === "provider" ? ` · ${formatKeyHint("f5")} refresh` : "";
		if (this.#focus === "scope") {
			return `${enterRight} models · ${upDown} providers · type to search · ${altLeftRight} kind${refresh} · ${cancel} close`;
		}
		return `${enter} assign roles · ${upDown} models · ${left} providers · type to search · ${altLeftRight} kind${refresh} · ${cancel} close`;
	}

	#renderFooter(width: number): string {
		const strip = this.#strip;
		return this.#frame.renderFooter(
			width,
			this.#footerHint(),
			strip ? () => this.#renderStrip(width, strip) : undefined,
		);
	}

	#renderStrip(width: number, strip: StripState): string {
		if (strip.kind === "name") {
			const preset = strip.purpose === "preset";
			const labelText = preset ? "Preset name:" : "New role name:";
			const label = theme.fg("accent", labelText);
			const inputWidth = Math.max(8, Math.min(32, width - visibleWidth(labelText) - 24));
			const inputLine = strip.input.render(inputWidth)[0] ?? "";
			return truncateToWidth(`${label} ${inputLine} ${theme.fg("dim", "(letters, digits, - and _)")}`, width);
		}

		const prefix =
			strip.kind === "role"
				? `${theme.fg("accent", strip.item.id)}${theme.fg("dim", " →")} `
				: `${theme.fg(this.#settings.getRoleInfo(strip.role ?? "").color ?? "muted", (this.#settings.getRoleInfo(strip.role ?? "").tag ?? strip.role ?? "").toLowerCase())}${theme.fg("dim", ` · ${strip.item.id} →`)} `;

		// Horizontal window: once the strip overflows, drop leading chips behind
		// a dim ellipsis so the selected chip (plus one chip of lookahead when it
		// fits) stays visible while cycling right.
		const prefixWidth = visibleWidth(prefix);
		const available = Math.max(1, width - prefixWidth);
		const chipWidths = strip.chips.map(
			(chip, i) => visibleWidth(` ${chip.styled} `) + (i === strip.index ? 2 : 0) + 1,
		);
		// Smallest start index whose window [start..target] (with its "… " lead-in
		// when start > 0) fits in the available width; `target` itself may still
		// overflow when a single chip is wider than the row.
		const startFor = (target: number): number => {
			let start = 0;
			while (start < target) {
				let sum = start > 0 ? 2 : 0;
				for (let i = start; i <= target; i++) sum += chipWidths[i] ?? 0;
				if (sum <= available) break;
				start++;
			}
			return start;
		};
		let start = startFor(Math.min(strip.index + 1, strip.chips.length - 1));
		if (start > strip.index) start = startFor(strip.index);

		return this.#frame.renderChips(width, prefix, strip, start);
	}

	render(width: number): readonly string[] {
		const height = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		return this.#frame.render(width, height, this.#entries, this.#renderFooter(width - 4));
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Native (TSP) description
	// ═══════════════════════════════════════════════════════════════════════

	/** A `picker` is its own sheet: the backend mounts it in `layer` without an `overlay` wrapper. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	describe(cx: DescribeContext): NativeNode {
		const usePicker = cx.supports("picker");
		const cached = this.#nativeCache;
		if (cached?.version === this.#nativeVersion && cached.picker === usePicker) return cached.node;
		if (usePicker) {
			const described = this.#describePicker();
			this.#nativeCache = { version: this.#nativeVersion, picker: true, node: described };
			return described;
		}
		const footer: NativeChild[] = [];
		const strip = this.#describeStrip();
		if (strip) footer.push(strip);
		footer.push(hintsRow(this.#footerHints()));
		const described = describeHubFrame(
			"omp.overlay.model-hub",
			"Models",
			describeHubSidebar(this.#entries, this.#activeEntryId, this.#nativeSidebarStyle, "scopes"),
			this.#describeBody(),
			node("col", { gap: "xs" }, footer, "footer"),
		);
		this.#nativeCache = { version: this.#nativeVersion, picker: false, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event);
		if (picked) {
			this.#handlePickerEvent(picked);
			this.#requestRender();
			return;
		}
		// Same gate as the mouse router: nothing is interactive while an assignment applies.
		if (this.#assignmentPending) return;
		const target = event.key.slice(event.key.lastIndexOf("/") + 1);
		if (event.type === "action") {
			const entry = this.#activeEntry();
			if (target !== "login" || event.act !== "login") return;
			if (entry.kind !== "provider" || !entry.locked || this.#assigning !== null) return;
			this.#requestLogin(entry);
		} else if (event.type === "select" || event.type === "activate") {
			switch (target) {
				case "scopes":
					this.#clickSidebarEntry(this.#entries.find(entry => entry.id === event.item));
					break;
				case "roles": {
					if (this.#activeEntry().kind !== "roles" || this.#assigning !== null) return;
					const index = this.#rolesRows.findIndex((rowDef, i) => rolesRowKey(rowDef, i) === event.item);
					const rowDef = this.#rolesRows[index];
					if (!rowDef || rowDef.kind === "separator") return;
					this.#focus = "list";
					this.#roleIndex = index;
					this.#activateRolesRow(rowDef);
					break;
				}
				case "roleTabs": {
					const tab = ROLE_TABS.find(candidate => candidate === event.item);
					if (!tab) return;
					this.#roleTab = tab;
					this.#roleIndex = 0;
					this.#roleScrollStart = 0;
					this.#buildRolesRows();
					break;
				}
				case "kinds": {
					const kind = MODEL_KIND_TABS.find(candidate => candidate === event.item);
					if (!kind) return;
					this.#modelKindTab = kind;
					this.#applyModelKind();
					break;
				}
				case "strip": {
					// A chip click picks and applies it, like the footer mouse path.
					const strip = this.#strip;
					const index = Number(event.item);
					if (!strip || strip.kind === "name" || !Number.isInteger(index) || !strip.chips[index]) return;
					strip.index = index;
					this.#activateStripChip();
					break;
				}
				default:
					return;
			}
		} else {
			return;
		}
		this.#requestRender();
	}

	/** Sidebar decoration for the native list: refreshing providers show an ellipsis, the status row spins. */
	#nativeSidebarStyle = (entry: SidebarEntry, index: number): Pick<SidebarStyle, "icon" | "annotation" | "muted"> => {
		const style = this.#sidebarStyle(entry, index);
		const refreshing = entry.providerId !== undefined && this.#refreshingProviders.has(entry.providerId);
		return { ...style, annotation: refreshing ? "…" : plainText(style.annotation) };
	};

	#describeBody(): NativeNode {
		const children: NativeChild[] = [this.#describeStatus()];
		const entry = this.#activeEntry();
		if (entry.kind === "roles" && this.#assigning === null) {
			children.push(...this.#describeRolesView());
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			children.push(this.#describeLockedView(entry));
		} else {
			children.push(
				node(
					"row",
					{ gap: "sm", align: "center" },
					[
						text([span("Kind:", "dim")]),
						node(
							"tabs",
							{ items: MODEL_KIND_TABS.map(kind => ({ id: kind, label: kind })), active: this.#modelKindTab },
							undefined,
							"kinds",
						),
					],
					"kindTabs",
				),
				this.#browser,
			);
		}
		return node("col", { gap: "sm", grow: 1 }, children, "body");
	}

	#describeStatus(): NativeNode {
		if (this.#assignmentPending) {
			return node("spinner", { label: [span("Applying model…", "accent")] }, undefined, "status");
		}
		let spans: TspSpan[];
		const assigning = this.#assigning;
		if (assigning !== null) {
			if (assigning.kind === "fallbackKey") {
				spans = [span("New fallback chain — pick the model it protects", "accent")];
			} else {
				const info = this.#settings.getRoleInfo(assigning.role);
				const label = info.tag ?? info.name ?? assigning.role;
				const verb =
					assigning.kind === "role"
						? "Assigning"
						: assigning.index === null
							? "Adding fallback for"
							: "Replacing fallback of";
				spans = [span(`${verb} `, "accent"), span(label, "accent strong")];
			}
			return node("text", { spans, truncate: "end" }, undefined, "status");
		}
		const entry = this.#activeEntry();
		if (this.#configError && entry.kind !== "provider") {
			return node("text", { spans: [span(this.#configError, "error")], wrap: "word" }, undefined, "status");
		}
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		switch (entry.kind) {
			case "recent":
				spans = [span(`Recently used models${scopedSuffix}`, "muted")];
				break;
			case "roles":
				spans = [
					span("Model roles — ", "muted"),
					span("f", "key"),
					span(" adds a retry fallback, cleared roles fall back to auto-selection", "muted"),
				];
				break;
			case "provider":
				if (entry.locked) {
					spans = [span(`${entry.label} · not configured`, "muted")];
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					return node(
						"spinner",
						{ label: [span(`${entry.label} · refreshing model list…`, "muted")] },
						undefined,
						"status",
					);
				} else {
					spans = [span(`${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`, "muted")];
				}
				break;
			default:
				spans = [span(`All available models${scopedSuffix}`, "muted")];
				break;
		}
		return node("text", { spans, truncate: "end" }, undefined, "status");
	}

	#describeRolesView(): NativeNode[] {
		const tabs = node(
			"row",
			{ gap: "sm", align: "center" },
			[
				text([span("Roles:", "dim")]),
				node(
					"tabs",
					{
						items: ROLE_TABS.map(tab => ({ id: tab, label: tab === "kind" ? "kinds" : tab })),
						active: this.#roleTab,
					},
					undefined,
					"roleTabs",
				),
			],
			"roleTabsRow",
		);
		const cycleOrder = this.#cycleOrder();
		const items = this.#rolesRows.map((rowDef, index) => this.#describeRolesRow(rowDef, index, cycleOrder));
		const selectedRow = this.#rolesRows[this.#roleIndex];
		const list = node(
			"list",
			{
				selected: selectedRow ? rolesRowKey(selectedRow, this.#roleIndex) : null,
				virtual: true,
				grow: 1,
				tone: this.#focus === "list" ? "accent" : undefined,
				aria: "Roles",
			},
			items,
			"roles",
		);
		return [tabs, list, this.#describeCycle(cycleOrder)];
	}

	#describeRolesRow(rowDef: RolesRow, index: number, cycleOrder: readonly string[]): NativeNode {
		const key = rolesRowKey(rowDef, index);
		switch (rowDef.kind) {
			case "separator":
				return node("rule", undefined, undefined, key);
			case "newRole":
				return node("item", { label: [span("+ New role…", "dim")] }, undefined, key);
			case "newFallback":
				return node("item", { label: [span("+ New fallback…", "dim")] }, undefined, key);
			case "chainKey": {
				const slash = rowDef.role.lastIndexOf("/");
				return node(
					"item",
					{
						label: [
							span(`${theme.status.shadowed} `, "dim"),
							span(rowDef.role.slice(0, slash + 1), "dim"),
							span(rowDef.role.slice(slash + 1)),
						],
					},
					undefined,
					key,
				);
			}
			case "fallback":
				return node("item", { label: [span("  ↳ ", "dim"), span(rowDef.selector, "muted")] }, undefined, key);
			case "role":
				break;
		}
		const role = rowDef.role;
		const info = this.#settings.getRoleInfo(role);
		const assignment = this.#roles[role];
		const tag = info.tag ?? info.name ?? role;
		let label: TspSpan[];
		let detail: TspSpan[];
		const value: TspSpan[] = [];
		if (assignment && !assignment.autoSelected) {
			const color = info.color ?? "muted";
			label = [span(`${theme.status.enabled} `, color), span(tag, color)];
			detail = [span(`${assignment.model.provider}/`, "dim"), span(assignment.model.id)];
			if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
				const glyph = thinkingLevelGlyph(assignment.thinkingLevel, theme);
				const levelLabel = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				value.push(span(glyph ? `${glyph} ${levelLabel}` : levelLabel, "dim"));
			}
		} else {
			label = [span(`${theme.status.shadowed} `, "dim"), span(tag, "dim")];
			detail = assignment
				? [span(`auto → ${assignment.model.provider}/${assignment.model.id}`, "dim")]
				: [span("—", "dim")];
		}
		// Quick-cycle membership badge (`⟳ 2` = second stop of the ctrl+p cycle).
		const cycleIndex = cycleOrder.indexOf(role);
		if (cycleIndex >= 0) {
			if (value.length > 0) value.push(span("  "));
			value.push(span(`${theme.icon.loop} ${cycleIndex + 1}`, "accent"));
		}
		return node("item", { label, detail, value: value.length > 0 ? value : undefined }, undefined, key);
	}

	/** Live preview of the quick-switch cycle; the selected row's role is emphasized. */
	#describeCycle(cycleOrder: readonly string[]): NativeNode {
		const [cycleKey] = boundKeys("app.model.cycleForward", ["ctrl+p"]);
		const keycap: NativeChild[] = cycleKey ? [kbd(cycleKey)] : [];
		if (cycleOrder.length === 0) {
			return node(
				"row",
				{ gap: "xs", align: "center", wrap: true },
				[
					...keycap,
					text([span("cycle is empty — press ", "dim"), span("c", "key"), span(" on a role to add it", "dim")]),
				],
				"cycle",
			);
		}
		const selectedRow = this.#rolesRows[this.#roleIndex];
		const selectedRole =
			selectedRow && (selectedRow.kind === "role" || selectedRow.kind === "fallback") ? selectedRow.role : "";
		const track: TspSpan[] = [];
		for (const role of cycleOrder) {
			if (track.length > 0) track.push(span(" › ", "dim"));
			track.push(span(role, role === selectedRole ? "accent strong" : "muted"));
		}
		return node(
			"row",
			{ gap: "xs", align: "center", wrap: true },
			[...keycap, text([span("cycle:", "dim")]), text(track, { wrap: "word" })],
			"cycle",
		);
	}

	#describeLockedView(entry: SidebarEntry): NativeNode {
		const children: NativeChild[] = [
			text([span(`${entry.label} has no credentials configured`, "warning")], { wrap: "word" }),
		];
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		children.push(
			text(
				[
					span(
						envVars.length > 0
							? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
							: "Add an API key for this provider in config.",
						"muted",
					),
				],
				{ wrap: "word" },
			),
		);
		if (entry.oauth) {
			children.push(
				node(
					"row",
					{ gap: "sm", align: "center", actions: { click: "login" } },
					[text([span("Log in with OAuth", "accent")]), node("kbd", { keys: ["enter"] })],
					"login",
				),
			);
		}
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			const models = this.#scopedModels.length > 0 ? [] : this.#registry.getAll("all");
			const items: NativeNode[] = [];
			for (const model of models) {
				if (model.provider !== entry.providerId) continue;
				items.push(node("item", { label: model.id, disabled: true }, undefined, model.id));
			}
			children.push(
				node(
					"section",
					{ head: [span(`${catalogCount} models in catalog`, "dim")] },
					[node("list", { selected: null, virtual: true }, items, "catalog")],
					"catalog",
				),
			);
		}
		return node("col", { gap: "sm", grow: 1 }, children, "locked");
	}

	// ─── Picker (data-first `picker` kind, NATIVE_REDESIGN.md §4.7) ─────────

	#describePicker(): NativeNode {
		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked === true && this.#assigning === null;
		const strip = this.#strip;
		const props: TspPickerProps = {
			title: "Models",
			subtitle: this.#pickerSubtitle(entry, rolesView),
			icon: "cpu",
			noun: rolesView ? "roles" : "models",
			size: "lg",
			layout: "rows",
			preview: "side",
			query: this.#browser.query,
			cursor: this.#browser.cursor,
			placeholder: "Search models…",
			scopes: this.#pickerScopes(),
			scope: entry.id,
			actions: this.#pickerActions(entry, rolesView, lockedView),
			strip: strip ? this.#pickerStrip(strip) : null,
			focus: strip ? "strip" : this.#focus === "scope" ? "scopes" : "list",
		};
		if (rolesView) {
			const row = this.#rolesRows[this.#roleIndex];
			return picker(
				{
					...props,
					tabs: ROLE_TABS.map(tab => ({
						id: tab,
						label: tab === "all" ? "All" : tab === "chat" ? "Chat" : "Kinds",
						count: this.#visibleRoleIds().filter(
							role => tab === "all" || this.#settings.getRoleInfo(role).section === tab,
						).length,
					})),
					tab: this.#roleTab,
					columns: ROLE_PICKER_COLUMNS,
					items: this.#rolePickerItems(),
					order: this.#rolePickerOrder(),
					selected: row && row.kind !== "separator" ? rolesRowKey(row, this.#roleIndex) : null,
					total: this.#allRolesRowCount(),
				},
				this.#rolePreview(row),
			);
		}
		const catalogue = this.#browser.pickerItems(this.#availableItems);
		const current = this.#currentSelector ? [this.#currentSelector] : undefined;
		if (lockedView) {
			return picker(
				{
					...props,
					columns: MODEL_PICKER_COLUMNS,
					...catalogue,
					order: [],
					selected: null,
					total: entry.catalogCount ?? 0,
					empty: this.#lockedMessage(entry),
					...(current ? { current } : {}),
				},
				this.#lockedPreview(entry),
			);
		}
		const query = this.#browser.query.trim();
		const view = this.#browser.pickerOrder({
			providers: entry.kind === "all" && query.length === 0,
			rest: entry.kind === "provider" ? entry.label : query ? "Matches" : "All models",
		});
		const refreshing =
			this.#catalogRefreshing ||
			(entry.kind === "provider" && this.#refreshingProviders.has(entry.providerId ?? ""));
		const state =
			view.count > 0 || query
				? "ready"
				: refreshing
					? "loading"
					: this.#configError && !this.#assigning
						? "error"
						: "ready";
		return picker(
			{
				...props,
				tabs: this.#pickerKindTabs(),
				tab: this.#modelKindTab,
				columns: MODEL_PICKER_COLUMNS,
				...catalogue,
				order: view.order,
				...(view.hits ? { hits: view.hits } : {}),
				selected: this.#browser.pickerSelected,
				...(current ? { current } : {}),
				total: this.#browser.baseCount,
				state,
				...(state === "error" && this.#configError ? { message: this.#configError } : {}),
				empty:
					this.#emptyStateMessage()?.trim() ??
					(entry.kind === "provider" ? `No models from ${entry.label} yet` : "No models available in this scope"),
			},
			this.#browser.pickerPreview("full", this.#currentSelector),
		);
	}

	/** What the hub is doing when it is more than browsing: applying, assigning, refreshing, a config error. */
	#pickerSubtitle(entry: SidebarEntry, rolesView: boolean): TspPickerProps["subtitle"] {
		if (this.#assignmentPending) return "Applying model…";
		const assigning = this.#assigning;
		if (assigning !== null) {
			if (assigning.kind === "fallbackKey") return "New fallback chain — pick the model it protects";
			const info = this.#settings.getRoleInfo(assigning.role);
			const label = info.tag ?? info.name ?? assigning.role;
			const verb =
				assigning.kind === "role"
					? "Assigning"
					: assigning.index === null
						? "Adding fallback for"
						: "Replacing fallback of";
			return [span(`${verb} `), span(label, "strong")];
		}
		if (this.#configError && entry.kind !== "provider") return [span(this.#configError, "error")];
		if (entry.kind === "provider" && entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
			return `${entry.label} · refreshing model list…`;
		}
		const presets = rolesView ? this.#presets() : undefined;
		if (presets && presets.names.length > 0) {
			return [
				span("Preset ", "muted"),
				presets.active ? span(presets.active, "strong") : span("custom", "muted"),
				span(
					this.#scopedModels.length > 0 ? " · --models scope" : " · Cleared roles fall back to auto-selection",
					"muted",
				),
			];
		}
		if (this.#scopedModels.length > 0) return "--models scope";
		if (rolesView) return "Cleared roles fall back to auto-selection";
		return undefined;
	}

	/** The sidebar as picker scopes: Roles, All models, then signed-in and signed-out providers. */
	#pickerScopes(): TspPickerScope[] {
		const counts = this.#searchCounts;
		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const scopes: TspPickerScope[] = [];
		for (const entry of this.#entries) {
			switch (entry.kind) {
				case "separator":
					break;
				case "roles":
					scopes.push({ id: entry.id, label: "Roles", icon: "sparkles", count: this.#visibleRoleIds().length });
					break;
				case "all":
					scopes.push({
						id: entry.id,
						label: "All models",
						icon: "list",
						count: counts ? this.#searchTotal : this.#availableItems.length,
					});
					break;
				case "recent":
					scopes.push({
						id: entry.id,
						label: "Recent",
						icon: "clock",
						count: counts ? this.#recentSearchCount : this.#recentItems.length,
					});
					break;
				case "provider": {
					const providerId = entry.providerId ?? entry.label;
					const mark = { text: providerInitials(providerId), seed: providerId };
					if (entry.locked) {
						const envVars = providerEntry(providerId)?.envVars ?? [];
						scopes.push({
							id: entry.id,
							label: entry.label,
							mark,
							group: "Not signed in",
							disabled: oauthIds.has(providerId)
								? "Sign in with /login"
								: envVars.length > 0
									? `Set ${envVars.join(" or ")} to sign in`
									: "Add an API key in config to sign in",
							dot: "muted",
						});
						break;
					}
					const dot = this.#providerDot(providerId);
					scopes.push({
						id: entry.id,
						label: entry.label,
						mark,
						group: "Providers",
						count: counts ? (counts.get(providerId) ?? 0) : Number(entry.annotation ?? 0),
						...(dot ? { dot } : {}),
					});
					break;
				}
			}
		}
		return scopes;
	}

	/** Discovery state as a scope dot: refreshing, ok, cached/empty, unavailable, signed out. */
	#providerDot(providerId: string): TspPickerScope["dot"] {
		if (this.#refreshingProviders.has(providerId)) return "pending";
		switch (this.#registry.getProviderDiscoveryState(providerId)?.status) {
			case "ok":
				return "success";
			case "cached":
			case "empty":
				return "warning";
			case "unavailable":
				return "error";
			case "unauthenticated":
				return "muted";
			default:
				return undefined;
		}
	}

	/** Kind tabs with their counts in the active scope; the same array while the scope's models are unchanged. */
	#pickerKindTabs(): TspPickerProps["tabs"] {
		const candidates = this.#candidateItems;
		if (this.#kindTabsMemo?.candidates === candidates) return this.#kindTabsMemo.tabs;
		const counts = new Map<string, number>();
		for (const item of candidates) {
			const kind = modelKind(item.model);
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
		const tabs = MODEL_KIND_TABS.map(kind => ({
			id: kind,
			label: MODEL_KIND_LABELS[kind],
			count: kind === "all" ? candidates.length : (counts.get(kind) ?? 0),
		}));
		this.#kindTabsMemo = { candidates, tabs };
		return tabs;
	}

	/** The action bar for the current view; every button runs the path of the key it shows. */
	#pickerActions(entry: SidebarEntry, rolesView: boolean, lockedView: boolean): TspPickerAction[] {
		const strip = this.#strip;
		const cancel = (label: string): TspPickerAction => ({ ...CLOSE_ACTION, label });
		if (this.#assignmentPending) return [CLOSE_ACTION];
		if (strip) {
			const apply =
				strip.kind === "name"
					? pickerAction(
							strip.purpose === "preset" ? "presetName" : "roleName",
							strip.purpose === "preset" ? "Save preset" : "Create role",
							"enter",
							{ primary: true },
						)
					: pickerAction(
							"stripApply",
							strip.kind === "thinking" ? "Apply" : strip.kind === "scope" ? "Save to scope" : "Assign / clear",
							"enter",
							{ primary: true },
						);
			return [apply, cancel(strip.kind === "thinking" ? "Keep" : "Cancel")];
		}
		const refresh =
			entry.kind === "provider" && !entry.locked ? pickerAction("refresh", "Refresh provider", "f5") : undefined;
		if (this.#assigning !== null) {
			const label =
				this.#assigning.kind === "fallback"
					? "Pick fallback"
					: this.#assigning.kind === "fallbackKey"
						? "Pick protected model"
						: "Assign";
			return compact([pickerAction("assign", label, "enter", { primary: true }), refresh, cancel("Cancel")]);
		}
		if (rolesView) {
			const row = this.#rolesRows[this.#roleIndex];
			const roleAction = (action: RolesAction, label: string, key: string, primary = false) =>
				pickerAction(`roles:${action}`, label, key, primary ? { primary: true } : undefined);
			const actions: (TspPickerAction | undefined)[] = [];
			switch (row?.kind) {
				case "role": {
					const assigned = this.#roles[row.role];
					actions.push(
						roleAction("pick", "Pick model", "enter", true),
						roleAction("fallback", "Add fallback", "f"),
						assigned && !assigned.autoSelected ? roleAction("clear", "Clear", "x") : undefined,
						this.#roleThinkingTarget(row.role) ? roleAction("thinking", "Thinking", "t") : undefined,
						roleAction("cycle", this.#cycleOrder().includes(row.role) ? "Leave cycle" : "Add to cycle", "c"),
						roleAction("new", "New role", "n"),
						this.#callbacks.onSavePreset ? roleAction("save", "Save preset", "s") : undefined,
						this.#presets().names.length > 0 ? roleAction("nextPreset", "Next preset", "p") : undefined,
					);
					break;
				}
				case "fallback":
					actions.push(
						roleAction("pick", "Replace", "enter", true),
						roleAction("fallback", "Add another", "f"),
						roleAction("clear", "Remove", "x"),
						this.#resolveFallbackEntry(row.role, row.chainIndex)
							? roleAction("thinking", "Thinking", "t")
							: undefined,
						roleAction("earlier", "Earlier", "["),
						roleAction("later", "Later", "]"),
					);
					break;
				case "chainKey":
					actions.push(roleAction("pick", "Add fallback", "enter", true), roleAction("clear", "Clear chain", "x"));
					break;
				case "newFallback":
					actions.push(roleAction("pick", "New fallback chain", "enter", true));
					break;
				case "newRole":
					actions.push(roleAction("pick", "New role", "enter", true));
					break;
			}
			return compact([...actions, CLOSE_ACTION]);
		}
		if (lockedView) {
			return entry.oauth
				? [pickerAction("login", "Log in", "enter", { primary: true }), CLOSE_ACTION]
				: [CLOSE_ACTION];
		}
		return compact([
			pickerAction(
				"assign",
				"Assign role",
				"enter",
				this.#browser.pickerSelected ? { primary: true } : { primary: true, disabled: "No model selected" },
			),
			refresh,
			this.#browser.query.length > 0 ? cancel("Clear search") : CLOSE_ACTION,
		]);
	}

	/** The open strip as the picker's chip strip (role assignment, save scope, thinking level, new role name). */
	#pickerStrip(strip: StripState): NonNullable<TspPickerProps["strip"]> {
		if (strip.kind === "name") {
			return {
				label: [
					span(strip.purpose === "preset" ? "Preset name " : "New role name ", "muted"),
					span(strip.input.getValue(), "mono"),
					span("▏", "accent"),
				],
				items: [],
			};
		}
		let label: TspSpan[];
		if (strip.kind === "role") {
			// The second step of "New fallback chain…" reuses the role strip with key chips only.
			const keyStrip = strip.chips.every(chip => chip.label.startsWith("for "));
			label = keyStrip
				? [span("New fallback chain", "muted")]
				: [span("Assign ", "muted"), span(strip.item.id, "mono"), span(" to", "muted")];
		} else {
			const info = this.#settings.getRoleInfo(strip.role ?? "");
			const roleLabel = (info.tag ?? strip.role ?? "").toLowerCase();
			label = [
				span(strip.kind === "thinking" ? "Thinking for " : "Save ", "muted"),
				span(roleLabel, "strong"),
				span(" · ", "muted"),
				span(strip.item.id, "mono"),
				...(strip.kind === "scope" ? [span(" to", "muted")] : []),
			];
		}
		return {
			label,
			items: strip.chips.map((chip, index) => {
				const assigned = chip.role ? this.#roles[chip.role] : undefined;
				const level =
					chip.action === "thinking"
						? chip.thinkingLevel
						: chip.action === "unassign" && assigned && !assigned.autoSelected
							? assigned.thinkingLevel
							: undefined;
				const dot = level !== undefined ? thinkingDotToken(level) : undefined;
				const on =
					chip.action === "unassign" ||
					(strip.kind === "thinking" &&
						chip.thinkingLevel !== undefined &&
						chip.thinkingLevel === strip.initialThinkingLevel);
				return { id: String(index), label: chip.label, ...(on ? { on: true } : {}), ...(dot ? { dot } : {}) };
			}),
			selected: String(strip.index),
		};
	}

	/** Roles-view rows as picker items; rebuilt only when the rows, roles or cycle change. */
	#rolePickerItems(): readonly TspPickerItem[] {
		const cycleOrder = this.#cycleOrder();
		const cycle = cycleOrder.join("\0");
		const memo = this.#pickerRoleItems;
		if (memo?.rows === this.#rolesRows && memo.roles === this.#roles && memo.cycle === cycle) return memo.items;
		const items: TspPickerItem[] = [];
		this.#rolesRows.forEach((row, index) => {
			const id = rolesRowKey(row, index);
			switch (row.kind) {
				case "separator":
					return;
				case "newRole":
					items.push({ id, label: "New role…", icon: "plus", tone: "muted" });
					return;
				case "newFallback":
					items.push({ id, label: "New fallback chain…", icon: "plus", tone: "muted" });
					return;
				case "chainKey":
					items.push({ id, label: row.role, mono: true, icon: "git-branch", detail: "fallback chain" });
					return;
				case "fallback":
					items.push({ id, label: row.selector, mono: true, depth: 1, detail: `fallback ${row.chainIndex + 1}` });
					return;
				case "role":
					break;
			}
			const info = this.#settings.getRoleInfo(row.role);
			const tag = info.tag ?? info.name ?? row.role;
			const assignment = this.#roles[row.role];
			const facts: Record<string, string> = {};
			if (assignment) {
				const selector = `${assignment.model.provider}/${assignment.model.id}`;
				facts.model = assignment.autoSelected ? `auto → ${selector}` : selector;
				if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
					facts.thinking = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				}
			} else {
				facts.model = "—";
			}
			const cycleIndex = cycleOrder.indexOf(row.role);
			items.push({
				id,
				label: tag,
				...(info.name && info.name !== tag ? { detail: info.name } : {}),
				facts,
				...(assignment && !assignment.autoSelected ? {} : { tone: "muted" as const }),
				...(cycleIndex >= 0
					? {
							badges: [
								{
									text: `cycle ${cycleIndex + 1}`,
									tone: "accent" as const,
									title: `Stop ${cycleIndex + 1} of the quick-switch cycle`,
								},
							],
						}
					: {}),
			});
		});
		this.#pickerRoleItems = { rows: this.#rolesRows, roles: this.#roles, cycle, items };
		return items;
	}

	/** Roles-view order: the separators become group heads (chat roles, kind roles, model fallback chains). */
	#rolePickerOrder(): (string | TspPickerGroup)[] {
		const order: (string | TspPickerGroup)[] = [];
		let head: { group: string; label: string; count: number } | undefined;
		const open = (group: string, label: string) => {
			head = { group, label, count: 0 };
			order.push(head);
		};
		open(this.#roleTab === "kind" ? "kind" : "chat", this.#roleTab === "kind" ? "Kind roles" : "Chat roles");
		this.#rolesRows.forEach((row, index) => {
			if (row.kind === "separator") {
				const previous = this.#rolesRows[index - 1];
				if (previous?.kind === "newRole") open("chains", "Model fallback chains");
				else open("kind", "Kind roles");
				return;
			}
			order.push(rolesRowKey(row, index));
			// Heads count roles and chains, not their fallback entries or the "new" rows.
			if (head && (row.kind === "role" || row.kind === "chainKey")) head.count++;
		});
		return order;
	}

	/** The selected Roles-view row's preview: its model's facts and its fallback chain. */
	#rolePreview(row: RolesRow | undefined): readonly NativeChild[] {
		const memo = this.#pickerRolePreview;
		if (memo !== undefined && memo.row === row && memo.roles === this.#roles && memo.rows === this.#rolesRows) {
			return memo.children;
		}
		const children: NativeChild[] = [];
		const chainList = (key: string): NativeChild | undefined => {
			const chain = this.#fallbackChains()[key] ?? [];
			if (chain.length === 0) return undefined;
			return node("section", { head: "Fallback chain" }, [
				md(chain.map((selector, index) => `${index + 1}. \`${selector}\``).join("\n")),
			]);
		};
		const modelItem = (model: Model): ModelBrowserItem => ({
			provider: model.provider,
			id: model.id,
			model,
			selector: `${model.provider}/${model.id}`,
		});
		switch (row?.kind) {
			case "role": {
				const info = this.#settings.getRoleInfo(row.role);
				const assignment = this.#roles[row.role];
				if (assignment) {
					children.push(...this.#browser.modelPreview(modelItem(assignment.model), "full", this.#currentSelector));
					children.push(
						node("kv", {
							items: [
								{ k: [span("Role", "muted")], v: info.name },
								{
									k: [span("Thinking", "muted")],
									v: getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label,
								},
								{ k: [span("Source", "muted")], v: assignment.autoSelected ? "auto-selected" : "configured" },
							],
						}),
					);
				} else {
					children.push(
						text(info.name, { role: "omp.picker.title" }),
						text([span("Not assigned; no available model fits this role.", "muted")], { wrap: "word" }),
					);
				}
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				break;
			}
			case "fallback": {
				const resolved = this.#resolveFallbackEntry(row.role, row.chainIndex);
				if (resolved) children.push(...this.#browser.modelPreview(resolved.item, "full", this.#currentSelector));
				else children.push(text([span(row.selector, "mono")], { role: "omp.picker.title" }));
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				break;
			}
			case "chainKey": {
				children.push(text([span(row.role, "mono")], { role: "omp.picker.title" }));
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				break;
			}
			case "newRole":
				children.push(
					text("New role", { role: "omp.picker.title" }),
					text([span("Name a custom role, then pick the model it runs on.", "muted")], { wrap: "word" }),
				);
				break;
			case "newFallback":
				children.push(
					text("New fallback chain", { role: "omp.picker.title" }),
					text([span("Pick the model (or provider) a new retry fallback chain protects.", "muted")], {
						wrap: "word",
					}),
				);
				break;
		}
		this.#pickerRolePreview = { row, roles: this.#roles, rows: this.#rolesRows, children };
		return children;
	}

	#lockedMessage(entry: SidebarEntry): string {
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		const how =
			envVars.length > 0
				? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
				: "Add an API key for this provider in config.";
		return `${entry.label} has no credentials configured. ${how}`;
	}

	/** A signed-out provider's preview: how to sign in and what its catalog holds. */
	#lockedPreview(entry: SidebarEntry): readonly NativeChild[] {
		const children: NativeChild[] = [
			text(entry.label, { role: "omp.picker.title" }),
			text([span(this.#lockedMessage(entry), "muted")], { wrap: "word" }),
		];
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0 && this.#scopedModels.length === 0) {
			const ids: string[] = [];
			for (const model of this.#registry.getAll("all")) {
				if (model.provider === entry.providerId) ids.push(`- \`${model.id}\``);
			}
			children.push(node("section", { head: `${catalogCount} models in catalog` }, [md(ids.join("\n"))]));
		}
		return children;
	}

	/** Picker pointer events, each on the path of the key it stands for. */
	#handlePickerEvent(event: PickerEvent): void {
		if (event.kind === "action" && event.act === CLOSE_ACTION.id) {
			this.#cancel();
			return;
		}
		// Same gate as the keys: only cancel works while an assignment applies.
		if (this.#assignmentPending) return;
		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigning === null;
		if (event.kind !== "action") {
			if (this.#strip) return;
			if (rolesView) {
				const index = this.#rolesRows.findIndex((row, i) => rolesRowKey(row, i) === event.item);
				const row = this.#rolesRows[index];
				if (!row || row.kind === "separator") return;
				this.#focus = "list";
				this.#roleIndex = index;
				if (event.kind === "activate") this.#activateRolesRow(row);
				return;
			}
			if (this.#isBrowserView(entry) && this.#browser.routePickerItem(event.item, event.kind === "activate")) {
				this.#focus = "list";
			}
			return;
		}
		const { act, value } = event;
		if (act.startsWith("roles:")) {
			const action = act.slice("roles:".length) as RolesAction;
			if (!rolesView || this.#strip) return;
			this.#focus = "list";
			this.#runRolesAction(action);
			return;
		}
		switch (act) {
			case "scope":
				this.#clickSidebarEntry(this.#entries.find(candidate => candidate.id === value));
				return;
			case "tab":
				if (rolesView) {
					const tab = ROLE_TABS.find(candidate => candidate === value);
					if (!tab) return;
					this.#roleTab = tab;
					this.#roleIndex = 0;
					this.#roleScrollStart = 0;
					this.#buildRolesRows();
				} else {
					const kind = MODEL_KIND_TABS.find(candidate => candidate === value);
					if (!kind) return;
					this.#modelKindTab = kind;
					this.#applyModelKind();
				}
				return;
			case "strip": {
				const strip = this.#strip;
				const index = Number(value);
				if (!strip || strip.kind === "name" || !Number.isInteger(index) || !strip.chips[index]) return;
				strip.index = index;
				this.#activateStripChip();
				return;
			}
			case "stripApply":
				this.#activateStripChip();
				return;
			case "roleName":
				this.#submitRoleName();
				return;
			case "presetName":
				this.#submitPresetName();
				return;
			case "cancel":
				if (this.#strip) this.#closeStrip();
				return;
			case "clear":
				if (this.#browser.query.length > 0) this.#browser.handleCancel();
				return;
			case "assign": {
				if (this.#strip || !this.#isBrowserView(entry)) return;
				const selected = this.#browser.pickerSelected;
				if (!selected) return;
				this.#focus = "list";
				this.#browser.routePickerItem(selected, true);
				return;
			}
			case "refresh":
				if (entry.kind === "provider" && !entry.locked) {
					this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
				}
				return;
			case "login":
				if (entry.kind === "provider" && entry.locked && this.#assigning === null) this.#requestLogin(entry);
				return;
		}
	}

	/** Footer chip labels, built from each chip's action instead of its ANSI rendering. */
	#chipSpans(chip: StripChip): TspSpan[] {
		switch (chip.action) {
			case "assign":
			case "unassign": {
				const color = this.#settings.getRoleInfo(chip.role ?? "").color ?? "muted";
				return chip.action === "unassign"
					? [span(`${theme.status.enabled} ${chip.label}`, color), span(` ${theme.status.success}`, "dim")]
					: [span(chip.label, color)];
			}
			case "scope":
				return [span(chip.label, chip.scope === "project" ? "accent" : "muted")];
			case "thinking": {
				const glyph = chip.thinkingLevel === undefined ? "" : thinkingLevelGlyph(chip.thinkingLevel, theme);
				return glyph ? [span(glyph, "accent"), span(` ${chip.label}`)] : [span(chip.label)];
			}
			default:
				return [span(plainText(chip.styled), "muted")];
		}
	}

	#describeStrip(): NativeNode | undefined {
		const strip = this.#strip;
		if (!strip) return undefined;
		if (strip.kind === "name") {
			const preset = strip.purpose === "preset";
			return node(
				"row",
				{ gap: "sm", align: "center" },
				[
					text([span(preset ? "Preset name:" : "New role name:", "accent")]),
					col([strip.input], { grow: 1 }),
					text([span("(letters, digits, - and _)", "dim")]),
				],
				preset ? "presetName" : "roleName",
			);
		}
		let prefix: TspSpan[];
		if (strip.kind === "role") {
			prefix = [span(strip.item.id, "accent"), span(" →", "dim")];
		} else {
			const info = this.#settings.getRoleInfo(strip.role ?? "");
			prefix = [
				span((info.tag ?? strip.role ?? "").toLowerCase(), info.color ?? "muted"),
				span(` · ${strip.item.id} →`, "dim"),
			];
		}
		return node(
			"row",
			{ gap: "sm", align: "center" },
			[
				text(prefix),
				node(
					"tabs",
					{
						items: strip.chips.map((chip, index) => ({ id: String(index), label: this.#chipSpans(chip) })),
						active: String(strip.index),
						actions: { click: "activate" },
					},
					undefined,
					"strip",
				),
			],
			"chips",
		);
	}

	#footerHints(): (NativeHint | undefined)[] {
		const keys = (label: string, ...ids: KeyName[]): NativeHint => ({ keys: ids, label });
		const cancel = (label: string) => actionHint("tui.select.cancel", label);
		const upDown = (label: string) => actionHint(["tui.select.up", "tui.select.down"], label);
		const search = keys("type to search");
		const kind = keys("kind", "alt+left", "alt+right");
		const reorder = keys("reorder", "[", "]");
		const strip = this.#strip;
		if (strip) {
			switch (strip.kind) {
				case "name":
					return strip.purpose === "preset"
						? [keys("save preset", "enter"), cancel("cancel")]
						: [keys("create + pick model", "enter"), cancel("cancel")];
				case "role":
					return [keys("choose", "left", "right"), keys("assign/clear", "enter"), cancel("cancel")];
				case "scope":
					return [keys("save scope", "left", "right"), keys("choose", "enter"), cancel("cancel")];
				case "thinking":
					return [keys("thinking level", "left", "right"), keys("apply", "enter"), cancel("keep")];
			}
		}
		if (this.#assigning !== null) {
			if (this.#focus === "scope") {
				return [keys("models", "enter", "right"), upDown("providers"), search, kind, cancel("cancel")];
			}
			const pick =
				this.#assigning.kind === "fallback"
					? "pick fallback"
					: this.#assigning.kind === "fallbackKey"
						? "pick the protected model"
						: "assign";
			return [keys(pick, "enter"), upDown("models"), keys("providers", "left"), search, kind, cancel("cancel")];
		}
		const presetHint = this.#presets().names.length > 0 ? keys("preset", "ctrl+left", "ctrl+right") : undefined;
		const entry = this.#activeEntry();
		if (entry.kind === "roles") {
			if (this.#focus !== "list") {
				return [
					upDown("providers"),
					keys("roles", "enter", "right"),
					keys("tabs", "alt+left", "alt+right"),
					presetHint,
					cancel("close"),
				];
			}
			const row = this.#rolesRows[this.#roleIndex];
			if (row?.kind === "fallback") {
				// Advertise `t` only where a strip would open, as the ANSI footer does.
				const editable = this.#resolveFallbackEntry(row.role, row.chainIndex) !== undefined;
				return [
					upDown("rows"),
					keys("replace", "enter"),
					keys("add another", "f"),
					keys("remove", "x"),
					editable ? keys("thinking", "t") : undefined,
					reorder,
					keys("providers", "left"),
				];
			}
			if (row?.kind === "chainKey") {
				return [
					upDown("rows"),
					keys("add fallback", "enter", "f"),
					keys("clear chain", "x"),
					keys("providers", "left"),
				];
			}
			if (row?.kind === "newFallback") {
				return [upDown("rows"), keys("new model/provider fallback chain", "enter"), keys("providers", "left")];
			}
			const editable = row?.kind === "role" && this.#roleThinkingTarget(row.role) !== undefined;
			return [
				upDown("rows"),
				keys("pick", "enter"),
				keys("fallback", "f"),
				keys("clear", "x"),
				editable ? keys("thinking", "t") : undefined,
				keys("cycle", "c"),
				reorder,
				keys("new", "n"),
				this.#callbacks.onSavePreset ? keys("save preset", "s") : undefined,
				this.#presets().names.length > 0 ? keys("preset", "ctrl+left", "ctrl+right", "p", "shift+p") : undefined,
			];
		}
		if (entry.kind === "provider" && entry.locked) {
			return entry.oauth
				? [keys("log in", "enter"), upDown("providers"), cancel("close")]
				: [upDown("providers"), cancel("close")];
		}
		const refresh = entry.kind === "provider" ? keys("refresh", "f5") : undefined;
		if (this.#focus === "scope") {
			return [keys("models", "enter", "right"), upDown("providers"), search, kind, refresh, cancel("close")];
		}
		return [
			keys("assign roles", "enter"),
			upDown("models"),
			keys("providers", "left"),
			search,
			kind,
			refresh,
			cancel("close"),
		];
	}
}
