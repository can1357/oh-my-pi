import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { getSupportedEfforts } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { modelsAreEqual } from "@pk-nerdsaver-ai/pi-catalog/models";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	ScrollView,
	Spacer,
	type Tab,
	TabBar,
	Text,
	type TUI,
	visibleWidth,
} from "@pk-nerdsaver-ai/pi-tui";
import { formatNumber } from "@pk-nerdsaver-ai/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS, MODEL_ROLES } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../../thinking";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";

function makeInvertedBadge(label: string, color: ThemeColor): string {
	const fgAnsi = theme.getFgAnsi(color);
	const bgAnsi = fgAnsi.replace(/\x1b\[38;/g, "\x1b[48;");
	return `${bgAnsi}\x1b[30m ${label} \x1b[39m\x1b[49m`;
}

function makeAutoSelectedBadge(label: string, color: ThemeColor): string {
	return `${theme.fg("dim", "[")}${theme.fg(color, label)}${theme.fg("dim", " auto]")}`;
}

function makeRoleBadgeToken(label: string, color: ThemeColor, assigned: RoleAssignment): string {
	if (assigned.autoSelected) {
		const badge = makeAutoSelectedBadge(label, color);
		if (assigned.thinkingLevel === ThinkingLevel.Inherit) {
			return badge;
		}
		const thinkingLabel = getConfiguredThinkingLevelMetadata(assigned.thinkingLevel).label;
		return `${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`;
	}

	const badge = makeInvertedBadge(label, color);
	const thinkingLabel = getConfiguredThinkingLevelMetadata(assigned.thinkingLevel).label;
	return `${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`;
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function compactSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getAlphaSearchTokens(query: string): string[] {
	return [...normalizeSearchText(query).matchAll(/[a-z]+/g)].map(match => match[0]).filter(token => token.length > 0);
}

function computeModelRank(model: Model, roles: Record<string, RoleAssignment | undefined>): number {
	let i = 0;
	while (i < MODEL_ROLE_IDS.length) {
		const role = MODEL_ROLE_IDS[i];
		const assigned = roles[role];
		if (assigned && modelsAreEqual(assigned.model, model)) {
			break;
		}
		i++;
	}
	return i;
}

interface ModelItem {
	kind: "provider";
	provider: string;
	id: string;
	model: Model;
	selector: string;
}

interface CanonicalModelItem {
	kind: "canonical";
	id: string;
	model: Model;
	selector: string;
	variantCount: number;
	searchText: string;
	normalizedSearchText: string;
	compactSearchText: string;
}

interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

interface RoleAssignment {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel;
	autoSelected: boolean;
}

type RoleSelectCallback = (
	model: Model,
	role: string | null,
	thinkingLevel?: ConfiguredThinkingLevel,
	selector?: string,
) => void;
type CancelCallback = () => void;
interface MenuRoleAction {
	label: string;
	role: string; // now accepts custom role strings
}

interface ProviderTabState {
	id: string;
	label: string;
	providerId?: string;
}
const ALL_TAB = "ALL";
const CANONICAL_TAB = "CANONICAL";

const STATIC_PROVIDER_TABS: ProviderTabState[] = [
	{ id: ALL_TAB, label: ALL_TAB },
	{ id: CANONICAL_TAB, label: CANONICAL_TAB },
];

const MODEL_TAB_REFRESH_DEBOUNCE_MS = 120;

function formatProviderTabLabel(providerId: string): string {
	return providerId.replace(/[-_]+/g, " ").toUpperCase();
}

function createProviderTab(providerId: string): ProviderTabState {
	return { id: providerId, label: formatProviderTabLabel(providerId), providerId };
}
const TEMPORARY_MODEL_PICKER_HINT =
	"Temporary model selection is session-only. Use Alt+M or /model for role models (default/smol/plan/task/slow/custom roles).";

/**
 * Component that renders a model selector with provider tabs and context menu.
 * - Tab/Arrow Left/Right: Switch between provider tabs
 * - Arrow Up/Down: Navigate model list
 * - Enter: Open context menu to select action
 * - Escape: Close menu or selector
 */
export class ModelSelectorComponent extends Container {
	#searchInput: Input;
	#headerContainer: Container;
	#tabBar: TabBar | null = null;
	#listContainer: Container;
	#menuContainer: Container;
	#allModels: ModelItem[] = [];
	#filteredModels: ModelItem[] = [];
	#canonicalModels: CanonicalModelItem[] = [];
	#filteredCanonicalModels: CanonicalModelItem[] = [];
	#selectedIndex: number = 0;
	#roles = {} as Record<string, RoleAssignment | undefined>;
	#settings = null as unknown as Settings;
	#modelRegistry = null as unknown as ModelRegistry;
	#onSelectCallback = (() => {}) as RoleSelectCallback;
	#onCancelCallback = (() => {}) as CancelCallback;
	#errorMessage?: unknown;
	#tui: TUI;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#temporaryOnly: boolean;
	#currentContextTokens: number;

	#menuRoleActions: MenuRoleAction[] = [];

	// Tab state
	#providers: ProviderTabState[] = STATIC_PROVIDER_TABS;
	#activeTabIndex: number = 0;
	#refreshingProviders: Set<string> = new Set();
	#scheduledProviderRefreshes: Map<string, Timer> = new Map();
	#refreshSpinnerFrame: number = 0;
	#refreshSpinnerInterval?: Timer;

	// Context menu state
	#isMenuOpen: boolean = false;
	#menuSelectedIndex: number = 0;
	#menuStep: "role" | "thinking" = "role";
	#menuSelectedRole: string | null = null;

	constructor(
		tui: TUI,
		_currentModel: Model | undefined,
		settings: Settings,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: RoleSelectCallback,
		onCancel: () => void,
		options?: { temporaryOnly?: boolean; initialSearchInput?: string; currentContextTokens?: number },
	) {
		super();

		this.#tui = tui;
		this.#settings = settings;
		this.#modelRegistry = modelRegistry;
		this.#scopedModels = scopedModels;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#temporaryOnly = options?.temporaryOnly ?? false;
		const currentContextTokens = options?.currentContextTokens ?? 0;
		this.#currentContextTokens =
			Number.isFinite(currentContextTokens) && currentContextTokens > 0 ? Math.floor(currentContextTokens) : 0;
		const initialSearchInput = options?.initialSearchInput;

		// Initialize menu role actions (built-in + custom from settings)
		this.#buildMenuRoleActions();

		// Load current role assignments from settings
		this.#loadRoleModels();

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		const hintText =
			scopedModels.length > 0
				? "Showing models from --models scope"
				: "Only showing models with configured API keys (see README for details)";
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Spacer(1));
		if (this.#temporaryOnly) {
			this.addChild(new Text(theme.fg("muted", TEMPORARY_MODEL_PICKER_HINT), 0, 0));
			this.addChild(new Spacer(1));
		}

		// Create header container for tab bar
		this.#headerContainer = new Container();
		this.addChild(this.#headerContainer);

		this.addChild(new Spacer(1));

		// Create search input
		this.#searchInput = new Input();
		if (initialSearchInput) {
			this.#searchInput.setValue(initialSearchInput);
		}
		this.#searchInput.onSubmit = () => {
			// Enter on search input opens menu if we have an enabled selection
			if (this.#getSelectedItem()) {
				this.#openMenu();
			}
		};
		this.addChild(this.#searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);

		// Create menu container (hidden by default)
		this.#menuContainer = new Container();
		this.addChild(this.#menuContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening the selector acts on cached models instead of being
		// dropped while the offline refresh promise is still pending. This stays
		// on the open path, so it must remain cheap — heavy lifting lives in the
		// registry's one-pass getCanonicalModelSelections.
		this.#syncFromRegistryState();

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#modelRegistry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#errorMessage = error instanceof Error ? error.message : String(error);
					this.#updateList();
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	#buildMenuRoleActions(): void {
		this.#menuRoleActions = getKnownRoleIds(this.#settings).map(role => {
			const roleInfo = getRoleInfo(role, this.#settings);
			const roleLabel = roleInfo.tag ? `${roleInfo.tag} (${roleInfo.name})` : roleInfo.name;
			return {
				label: `Set as ${roleLabel}`,
				role,
			};
		});
	}

	#loadRoleModels(autoCandidateModels?: ReadonlyArray<Model>): void {
		const nextRoles = {} as Record<string, RoleAssignment | undefined>;
		const allModels = this.#modelRegistry.getAll();
		const matchPreferences = getModelMatchPreferences(this.#settings);
		const knownRoles = getKnownRoleIds(this.#settings);
		const configuredRoles = new Set<string>();

		for (const role of knownRoles) {
			const roleValue = this.#settings.getModelRole(role);
			if (!roleValue) continue;
			configuredRoles.add(role);

			const resolved = resolveModelRoleValue(roleValue, allModels, {
				settings: this.#settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (resolved.model) {
				nextRoles[role] = {
					model: resolved.model,
					thinkingLevel:
						resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined
							? resolved.thinkingLevel
							: ThinkingLevel.Inherit,
					autoSelected: false,
				};
			}
		}

		if (autoCandidateModels && autoCandidateModels.length > 0) {
			const candidates = [...autoCandidateModels];
			for (const role of knownRoles) {
				if (configuredRoles.has(role)) continue;
				const resolved = resolveModelRoleValue(`pi/${role}`, candidates, {
					settings: this.#settings,
					matchPreferences,
					modelRegistry: this.#modelRegistry,
				});
				if (!resolved.model) continue;
				nextRoles[role] = {
					model: resolved.model,
					thinkingLevel:
						resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined
							? resolved.thinkingLevel
							: ThinkingLevel.Inherit,
					autoSelected: true,
				};
			}
		}

		this.#roles = nextRoles;
	}

	/**
	 * @param skipRoleRank When a search query is narrowing the list, role assignments
	 *   should NOT promote a weakly-matching default model above a perfect text
	 *   match — defer to MRU/version instead so user affinity drives the order.
	 */
	#sortModels(models: ModelItem[], { skipRoleRank = false }: { skipRoleRank?: boolean } = {}): void {
		// Sort: tagged models (default/smol/slow/plan) first, then MRU, then alphabetical
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (item: ModelItem) => computeModelRank(item.model, this.#roles);

		const dateRe = /-(\d{8})$/;
		const latestRe = /-latest$/;

		models.sort((a, b) => {
			const aKey = a.selector;
			const bKey = b.selector;

			if (!skipRoleRank) {
				const aRank = modelRank(a);
				const bRank = modelRank(b);
				if (aRank !== bRank) return aRank - bRank;
			}

			// Then MRU order (models in mruIndex come before those not in it)
			const aMru = mruIndex.get(aKey) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(bKey) ?? Number.MAX_SAFE_INTEGER;
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

			// Both have dates or latest tags — sort by recency
			const aHasRecency = aIsLatest || aDate !== "";
			const bHasRecency = bIsLatest || bDate !== "";

			// Models with recency info come before those without
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

	#sortCanonicalModels(models: CanonicalModelItem[], { skipRoleRank = false }: { skipRoleRank?: boolean } = {}): void {
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (item: CanonicalModelItem) => computeModelRank(item.model, this.#roles);

		models.sort((a, b) => {
			if (!skipRoleRank) {
				const aRank = modelRank(a);
				const bRank = modelRank(b);
				if (aRank !== bRank) return aRank - bRank;
			}

			const aMru = mruIndex.get(`${a.model.provider}/${a.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(`${b.model.provider}/${b.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			const providerCmp = a.model.provider.localeCompare(b.model.provider);
			if (providerCmp !== 0) return providerCmp;

			return a.id.localeCompare(b.id);
		});
	}

	#loadModelsFromCurrentRegistryState(): void {
		let models: ModelItem[];
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => ({
				kind: "provider",
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
				selector: `${scoped.model.provider}/${scoped.model.id}`,
			}));
		} else {
			const loadError = this.#modelRegistry.getError();
			if (loadError) {
				this.#errorMessage = loadError;
			} else {
				this.#errorMessage = undefined;
			}

			try {
				const availableModels = this.#modelRegistry.getAvailable();
				models = availableModels.map((model: Model) => ({
					kind: "provider",
					provider: model.provider,
					id: model.id,
					model,
					selector: `${model.provider}/${model.id}`,
				}));
			} catch (error) {
				this.#allModels = [];
				this.#filteredModels = [];
				this.#canonicalModels = [];
				this.#filteredCanonicalModels = [];
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				return;
			}
		}

		const candidates = models.map(item => item.model);
		this.#loadRoleModels(candidates);
		const canonicalSelections = this.#modelRegistry.getCanonicalModelSelections({
			availableOnly: this.#scopedModels.length === 0,
			candidates,
		});
		const canonicalModels = canonicalSelections.map(({ record, model: selectedModel }): CanonicalModelItem => {
			const searchText = [
				record.id,
				record.name,
				selectedModel.provider,
				selectedModel.id,
				selectedModel.name,
				...record.variants.flatMap(variant => [variant.selector, variant.model.name]),
			].join(" ");
			return {
				kind: "canonical",
				id: record.id,
				model: selectedModel,
				selector: record.id,
				variantCount: record.variants.length,
				searchText,
				normalizedSearchText: normalizeSearchText(searchText),
				compactSearchText: compactSearchText(searchText),
			};
		});

		this.#sortModels(models);
		this.#sortCanonicalModels(canonicalModels);

		this.#allModels = models;
		this.#filteredModels = models;
		this.#canonicalModels = canonicalModels;
		this.#filteredCanonicalModels = canonicalModels;
		const visibleModels = this.#isCanonicalTab() ? canonicalModels : models;
		this.#selectedIndex = this.#coerceSelectedIndex(
			Math.min(this.#selectedIndex, Math.max(0, visibleModels.length - 1)),
			visibleModels,
		);
	}

	/**
	 * Rebuild the visible model lists from the registry's in-memory state.
	 * Re-entrant: runs once synchronously at construction and again whenever a
	 * background refresh lands, so it re-applies the live search query and pins
	 * the highlighted item by selector — a refresh that reorders or inserts
	 * models must not yank the user's selection out from under a pending Enter.
	 */
	#syncFromRegistryState(): void {
		const selectedKey = this.#getSelectedItem()?.selector;
		this.#loadModelsFromCurrentRegistryState();
		this.#buildProviderTabs();
		this.#updateTabBar();
		this.#applyTabFilter();
		if (selectedKey) {
			const visibleItems = this.#getVisibleItems();
			const restoredIndex = visibleItems.findIndex(item => item.selector === selectedKey);
			if (restoredIndex >= 0 && restoredIndex !== this.#selectedIndex) {
				this.#selectedIndex = this.#coerceSelectedIndex(restoredIndex, visibleItems);
				this.#updateList();
			}
		}
	}

	#buildProviderTabs(): void {
		const activeTabId = this.#getActiveTab().id;
		const providerSet = new Set<string>();
		for (const item of this.#allModels) {
			providerSet.add(item.provider);
		}
		for (const provider of this.#modelRegistry.getDiscoverableProviders()) {
			providerSet.add(provider);
		}
		const sortedProviderIds = Array.from(providerSet).sort((left, right) =>
			formatProviderTabLabel(left).localeCompare(formatProviderTabLabel(right)),
		);
		this.#providers = [...STATIC_PROVIDER_TABS, ...sortedProviderIds.map(createProviderTab)];
		const activeIndex = this.#providers.findIndex(tab => tab.id === activeTabId);
		this.#activeTabIndex =
			activeIndex >= 0 ? activeIndex : Math.min(this.#activeTabIndex, this.#providers.length - 1);
	}

	#getActiveProviderRefreshStatusText(): string | undefined {
		const providerId = this.#getActiveProviderId();
		if (!providerId || !this.#refreshingProviders.has(providerId)) {
			return undefined;
		}
		const spinnerFrames = theme.spinnerFrames;
		const spinner =
			spinnerFrames.length > 0
				? spinnerFrames[this.#refreshSpinnerFrame % spinnerFrames.length]
				: theme.status.pending;
		return theme.fg("warning", `  ${spinner} Refreshing ${formatProviderTabLabel(providerId)} in background...`);
	}

	#startRefreshSpinner(): void {
		if (this.#refreshSpinnerInterval) {
			return;
		}
		this.#refreshSpinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#refreshSpinnerFrame = (this.#refreshSpinnerFrame + 1) % frameCount;
			}
			this.#updateTabBar();
			this.#tui.requestRender();
		}, 80);
	}

	#stopRefreshSpinner(): void {
		if (this.#refreshingProviders.size > 0) {
			return;
		}
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
			this.#stopRefreshSpinner();
		}
	}

	#cancelScheduledProviderRefreshesExcept(keepProviderId?: string): void {
		for (const [providerId, timer] of this.#scheduledProviderRefreshes) {
			if (providerId === keepProviderId) {
				continue;
			}
			clearTimeout(timer);
			this.#scheduledProviderRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleSelectedProviderRefresh(): void {
		const providerId = this.#getActiveProviderId();
		if (this.#scopedModels.length > 0 || !providerId) {
			return;
		}
		if (this.#scheduledProviderRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) {
			return;
		}
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			this.#scheduledProviderRefreshes.delete(providerId);
			void this.#refreshProviderInBackground(providerId);
		}, MODEL_TAB_REFRESH_DEBOUNCE_MS);
		this.#scheduledProviderRefreshes.set(providerId, timer);
	}

	async #refreshProviderInBackground(providerId: string): Promise<void> {
		try {
			await this.#modelRegistry.refreshProvider(providerId, "online");
			// Provider refresh already updated the registry snapshot. Re-reading it
			// here must stay purely in-memory — do not call modelRegistry.refresh()
			// again or tab switches will pay an extra whole-registry reload after the
			// network round-trip completes.
			this.#syncFromRegistryState();
		} catch (error) {
			this.#errorMessage = error instanceof Error ? error.message : String(error);
			this.#updateList();
		} finally {
			this.#setProviderRefreshing(providerId, false);
			this.#updateTabBar();
			this.#tui.requestRender();
		}
	}

	#updateTabBar(): void {
		this.#headerContainer.clear();

		const tabs: Tab[] = this.#providers.map(provider => ({ id: provider.id, label: provider.label }));
		const tabBar = new TabBar("Models", tabs, getTabBarTheme(), this.#activeTabIndex);
		tabBar.onTabChange = (_tab, index) => {
			this.#activeTabIndex = index;
			this.#selectedIndex = 0;
			this.#cancelScheduledProviderRefreshesExcept(this.#getActiveProviderId());
			this.#applyTabFilter();
			this.#scheduleSelectedProviderRefresh();
			this.#updateTabBar();
			// Let TUI's normal post-input render paint the new tab immediately.
			// The live refresh is debounced onto a later timer so tab cycling never
			// shares a stack frame with provider refresh work.
			this.#tui.requestRender();
		};
		this.#tabBar = tabBar;
		this.#headerContainer.addChild(tabBar);
		const refreshStatusText = this.#getActiveProviderRefreshStatusText();
		if (refreshStatusText) {
			this.#headerContainer.addChild(new Text(refreshStatusText, 0, 0));
		}
	}

	#getActiveTab(): ProviderTabState {
		return this.#providers[this.#activeTabIndex] ?? STATIC_PROVIDER_TABS[0]!;
	}

	#getActiveTabId(): string {
		return this.#getActiveTab().id;
	}

	#getActiveProviderId(): string | undefined {
		return this.#getActiveTab().providerId;
	}

	#isCanonicalTab(): boolean {
		return this.#getActiveTabId() === CANONICAL_TAB;
	}

	#isModelOverCurrentContext(model: Model): boolean {
		const contextWindow = model.contextWindow ?? 0;
		return this.#currentContextTokens > 0 && contextWindow > 0 && this.#currentContextTokens > contextWindow;
	}

	#isModelOverContextLimit(model: Model): boolean {
		return this.#temporaryOnly && this.#isModelOverCurrentContext(model);
	}

	#isDefaultRoleActionOverContextLimit(action: MenuRoleAction, model: Model): boolean {
		return action.role === "default" && this.#isModelOverCurrentContext(model);
	}

	#formatCurrentContextLimitSuffix(model: Model): string {
		return ` ${theme.status.disabled} context>${formatNumber(model.contextWindow ?? 0).toLowerCase()}`;
	}

	#isItemDisabled(item: ModelItem | CanonicalModelItem): boolean {
		return this.#isModelOverContextLimit(item.model);
	}

	#formatContextLimitSuffix(model: Model): string {
		if (!this.#isModelOverContextLimit(model)) {
			return "";
		}
		return this.#formatCurrentContextLimitSuffix(model);
	}

	#getVisibleItems(): ReadonlyArray<ModelItem | CanonicalModelItem> {
		return this.#isCanonicalTab() ? this.#filteredCanonicalModels : this.#filteredModels;
	}

	#coerceSelectedIndex(
		index: number,
		visibleItems: ReadonlyArray<ModelItem | CanonicalModelItem> = this.#getVisibleItems(),
	): number {
		const maxIndex = visibleItems.length - 1;
		if (maxIndex < 0) {
			return 0;
		}
		const clamped = Math.max(0, Math.min(index, maxIndex));
		const clampedItem = visibleItems[clamped];
		if (clampedItem && !this.#isItemDisabled(clampedItem)) {
			return clamped;
		}
		for (let i = clamped + 1; i <= maxIndex; i++) {
			const item = visibleItems[i];
			if (item && !this.#isItemDisabled(item)) {
				return i;
			}
		}
		for (let i = clamped - 1; i >= 0; i--) {
			const item = visibleItems[i];
			if (item && !this.#isItemDisabled(item)) {
				return i;
			}
		}
		return clamped;
	}

	#moveSelection(delta: number): void {
		const visibleItems = this.#getVisibleItems();
		const count = visibleItems.length;
		if (count === 0) {
			return;
		}
		let index = this.#selectedIndex;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const item = visibleItems[index];
			if (item && !this.#isItemDisabled(item)) {
				this.#selectedIndex = index;
				this.#updateList();
				return;
			}
		}
		this.#selectedIndex = this.#coerceSelectedIndex(this.#selectedIndex, visibleItems);
		this.#updateList();
	}

	#filterModels(query: string): void {
		const activeTabId = this.#getActiveTabId();
		const activeProviderId = this.#getActiveProviderId();
		const isCanonicalTab = activeTabId === CANONICAL_TAB;

		// Start with all models or filter by provider/canonical view
		let baseModels = this.#allModels;
		const baseCanonicalModels = this.#canonicalModels;
		if (activeProviderId) {
			baseModels = this.#allModels.filter(m => m.provider === activeProviderId);
		}

		// Apply fuzzy filter if query is present
		if (query.trim()) {
			// If user is searching from a provider tab, auto-switch to ALL to show global provider results.
			if (activeProviderId && !isCanonicalTab) {
				this.#activeTabIndex = 0;
				if (this.#tabBar && this.#tabBar.getActiveIndex() !== 0) {
					this.#tabBar.setActiveIndex(0);
					return;
				}
				this.#updateTabBar();
				baseModels = this.#allModels;
			}

			if (isCanonicalTab) {
				const alphaTokens = getAlphaSearchTokens(query);
				const alphaFiltered =
					alphaTokens.length === 0
						? baseCanonicalModels
						: baseCanonicalModels.filter(item =>
								alphaTokens.every(token => item.normalizedSearchText.includes(token)),
							);
				const compactQuery = compactSearchText(query);
				const substringFiltered =
					compactQuery.length === 0
						? alphaFiltered
						: alphaFiltered.filter(item => item.compactSearchText.includes(compactQuery));
				const fuzzySource =
					substringFiltered.length > 0
						? substringFiltered
						: alphaFiltered.length > 0
							? alphaFiltered
							: baseCanonicalModels;
				// Fuzzy provides the candidate set, but `${provider}/${id}` scoring
				// is biased by provider-prefix length (e.g. `openai/X` beats
				// `openai-codex/X` purely because the prefix is shorter). Re-sort by
				// affinity — MRU then version — so the user's actually-used model
				// wins. Role rank is skipped: when narrowing by query, a weakly
				// matching default model should not be promoted above a stronger
				// non-default match.
				const fuzzyMatches = fuzzyFilter(fuzzySource, query, ({ searchText }) => searchText);
				this.#sortCanonicalModels(fuzzyMatches, { skipRoleRank: true });
				this.#filteredCanonicalModels = fuzzyMatches;
			} else {
				// Match against the displayed "provider/id" string so the user can
				// type what they see: bare names (`mimo`, `kimi`), provider prefixes
				// (`openrouter`), or scoped queries (`openrouter/mimo`) all flow
				// through the same fuzzy matcher. The score is biased by provider-
				// prefix length, so re-sort by MRU/version afterwards; skip role
				// rank so a weakly matching default doesn't trump a stronger match.
				const fuzzyMatches = fuzzyFilter(baseModels, query, ({ id, provider }) => `${provider}/${id}`);
				this.#sortModels(fuzzyMatches, { skipRoleRank: true });
				this.#filteredModels = fuzzyMatches;
			}
		} else {
			this.#filteredModels = baseModels;
			this.#filteredCanonicalModels = baseCanonicalModels;
		}

		const visibleItems = isCanonicalTab ? this.#filteredCanonicalModels : this.#filteredModels;
		this.#selectedIndex = this.#coerceSelectedIndex(
			Math.min(this.#selectedIndex, Math.max(0, visibleItems.length - 1)),
			visibleItems,
		);
		this.#updateList();
	}

	#applyTabFilter(): void {
		const query = this.#searchInput.getValue();
		this.#filterModels(query);
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) {
			return undefined;
		}
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) {
			return "less than a minute ago";
		}
		const ageMinutes = Math.round(ageMs / 60_000);
		return `${ageMinutes}m ago`;
	}

	#formatDiscoveryErrorHint(error: string | undefined): string | undefined {
		if (!error) {
			return undefined;
		}
		const httpMatch = error.match(/^HTTP (\d+) from (.+)$/);
		if (!httpMatch) {
			return undefined;
		}
		const [, statusCode, url] = httpMatch;
		if (statusCode === "404") {
			return `  Discovery endpoint ${url} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
		}
		return `  Discovery failed: ${error}`;
	}

	#getProviderEmptyStateMessage(): string | undefined {
		const activeProviderId = this.#getActiveProviderId();
		if (!activeProviderId || this.#searchInput.getValue().trim()) {
			return undefined;
		}
		const state = this.#modelRegistry.getProviderDiscoveryState(activeProviderId);
		if (!state) {
			return undefined;
		}
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable":
				return (
					this.#formatDiscoveryErrorHint(state.error) ??
					(age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.")
				);
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

	#updateList(): void {
		this.#listContainer.clear();
		const isCanonicalTab = this.#isCanonicalTab();
		const visibleItems = isCanonicalTab ? this.#filteredCanonicalModels : this.#filteredModels;

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), visibleItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, visibleItems.length);

		const showProvider = this.#getActiveTabId() === ALL_TAB;

		const rows: string[] = [];
		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = visibleItems[i];
			if (!item) continue;
			const canonicalItem = isCanonicalTab ? (item as CanonicalModelItem) : undefined;
			const providerItem = isCanonicalTab ? undefined : (item as ModelItem);

			const isSelected = i === this.#selectedIndex;
			const isDisabled = this.#isItemDisabled(item);
			const disabledSuffix = this.#formatContextLimitSuffix(item.model);

			// Build role badges. Solid badges are configured; outlined badges are auto-selected defaults.
			const roleBadgeTokens: string[] = [];
			for (const role of MODEL_ROLE_IDS) {
				const { tag, color, hidden } = getRoleInfo(role, this.#settings);
				if (hidden) continue;
				const assigned = this.#roles[role];
				if (!tag || !assigned || !modelsAreEqual(assigned.model, item.model)) continue;

				roleBadgeTokens.push(makeRoleBadgeToken(tag, color ?? "success", assigned));
			}
			// Custom role badges
			for (const [role, assigned] of Object.entries(this.#roles)) {
				if (role in MODEL_ROLES || !assigned || !modelsAreEqual(assigned.model, item.model)) continue;
				const roleInfo = getRoleInfo(role, this.#settings);
				const badgeLabel = roleInfo.tag ?? roleInfo.name;
				roleBadgeTokens.push(makeRoleBadgeToken(badgeLabel, roleInfo.color ?? "muted", assigned));
			}
			const badgeText = roleBadgeTokens.length > 0 ? ` ${roleBadgeTokens.join(" ")}` : "";

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${theme.fg("accent", item.id)}${variants}${backing}${badgeText}${disabledSuffix}`;
				} else if (showProvider) {
					const providerPrefix = theme.fg("dim", `${providerItem?.provider ?? ""}/`);
					line = `${prefix}${providerPrefix}${theme.fg("accent", providerItem?.id ?? item.id)}${badgeText}${disabledSuffix}`;
				} else {
					line = `${prefix}${theme.fg("accent", item.id)}${badgeText}${disabledSuffix}`;
				}
			} else {
				const prefix = "  ";
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${item.id}${variants}${backing}${badgeText}${disabledSuffix}`;
				} else if (showProvider) {
					const providerPrefix = theme.fg("dim", `${providerItem?.provider ?? ""}/`);
					line = `${prefix}${providerPrefix}${providerItem?.id ?? item.id}${badgeText}${disabledSuffix}`;
				} else {
					line = `${prefix}${item.id}${badgeText}${disabledSuffix}`;
				}
			}

			if (isDisabled) {
				line = theme.fg("dim", Bun.stripANSI(line));
			}
			rows.push(line);
		}

		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: visibleItems.length,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		}

		// Show error message or "no results" if empty
		if (this.#errorMessage) {
			const errorLines = String(this.#errorMessage).split("\n");
			for (const line of errorLines) {
				this.#listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (visibleItems.length === 0) {
			const statusMessage = this.#getProviderEmptyStateMessage();
			this.#listContainer.addChild(new Text(theme.fg("muted", statusMessage ?? "  No matching models"), 0, 0));
		} else {
			const selected = visibleItems[this.#selectedIndex];
			if (!selected) {
				return;
			}
			this.#listContainer.addChild(new Spacer(1));
			const suffix = isCanonicalTab
				? ` (${selected.model.provider}/${selected.model.id}, ${(selected as CanonicalModelItem).variantCount} variants)`
				: "";
			const limitWarning = this.#isItemDisabled(selected)
				? theme.fg(
						"dim",
						` — current context ${formatNumber(this.#currentContextTokens).toLowerCase()} > ${formatNumber(selected.model.contextWindow ?? 0).toLowerCase()} limit`,
					)
				: "";
			this.#listContainer.addChild(
				new Text(theme.fg("muted", `  Model Name: ${selected.model.name}${suffix}`) + limitWarning, 0, 0),
			);
		}
	}
	#getThinkingLevelsForModel(model: Model): ReadonlyArray<ConfiguredThinkingLevel> {
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
	}

	#getCurrentRoleThinkingLevel(role: string): ConfiguredThinkingLevel {
		return this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit;
	}

	#getThinkingPreselectIndex(role: string, model: Model): number {
		const options = this.#getThinkingLevelsForModel(model);
		const currentLevel = this.#getCurrentRoleThinkingLevel(role);
		const foundIndex = options.indexOf(currentLevel);
		return foundIndex >= 0 ? foundIndex : 0;
	}

	#getSelectedItem(): ModelItem | CanonicalModelItem | undefined {
		return this.#isCanonicalTab()
			? this.#filteredCanonicalModels[this.#selectedIndex]
			: this.#filteredModels[this.#selectedIndex];
	}

	#isMenuRoleIndexDisabled(index: number, selectedItem: ModelItem | CanonicalModelItem): boolean {
		const action = this.#menuRoleActions[index];
		return action ? this.#isDefaultRoleActionOverContextLimit(action, selectedItem.model) : false;
	}

	#coerceMenuSelectedIndex(index: number, selectedItem: ModelItem | CanonicalModelItem): number {
		const maxIndex = this.#menuRoleActions.length - 1;
		if (maxIndex < 0) {
			return 0;
		}
		const clamped = Math.max(0, Math.min(index, maxIndex));
		if (!this.#isMenuRoleIndexDisabled(clamped, selectedItem)) {
			return clamped;
		}
		for (let i = clamped + 1; i <= maxIndex; i++) {
			if (!this.#isMenuRoleIndexDisabled(i, selectedItem)) {
				return i;
			}
		}
		for (let i = clamped - 1; i >= 0; i--) {
			if (!this.#isMenuRoleIndexDisabled(i, selectedItem)) {
				return i;
			}
		}
		return clamped;
	}

	#moveMenuSelection(delta: number, selectedItem: ModelItem | CanonicalModelItem, optionCount: number): void {
		let index = this.#menuSelectedIndex;
		for (let step = 0; step < optionCount; step++) {
			index = (index + delta + optionCount) % optionCount;
			if (this.#menuStep !== "role" || !this.#isMenuRoleIndexDisabled(index, selectedItem)) {
				this.#menuSelectedIndex = index;
				this.#updateMenu();
				return;
			}
		}
		this.#menuSelectedIndex =
			this.#menuStep === "role"
				? this.#coerceMenuSelectedIndex(this.#menuSelectedIndex, selectedItem)
				: this.#menuSelectedIndex;
		this.#updateMenu();
	}

	#openMenu(): void {
		const selectedItem = this.#getSelectedItem();
		if (!selectedItem || this.#isItemDisabled(selectedItem)) return;

		this.#isMenuOpen = true;
		this.#menuStep = "role";
		this.#menuSelectedRole = null;
		this.#menuSelectedIndex = this.#coerceMenuSelectedIndex(0, selectedItem);
		// Collapse the model list while the action/thinking menu is open so the
		// menu owns the full viewport instead of stacking below a now-irrelevant
		// (and often off-screen) list.
		this.#listContainer.clear();
		this.#updateMenu();
	}

	#closeMenu(): void {
		this.#isMenuOpen = false;
		this.#menuStep = "role";
		this.#menuSelectedRole = null;
		this.#menuContainer.clear();
		// Restore the model list that #openMenu collapsed.
		this.#updateList();
	}

	#updateMenu(): void {
		this.#menuContainer.clear();

		const selectedItem = this.#getSelectedItem();
		if (!selectedItem) return;

		const showingThinking = this.#menuStep === "thinking" && this.#menuSelectedRole !== null;
		const thinkingOptions = showingThinking ? this.#getThinkingLevelsForModel(selectedItem.model) : [];
		const optionLines = showingThinking
			? thinkingOptions.map((thinkingLevel, index) => {
					const prefix = index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
					const label = getConfiguredThinkingLevelMetadata(thinkingLevel).label;
					return `${prefix}${label}`;
				})
			: this.#menuRoleActions.map((action, index) => {
					const prefix = index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
					const disabled = this.#isDefaultRoleActionOverContextLimit(action, selectedItem.model);
					const suffix = disabled ? this.#formatCurrentContextLimitSuffix(selectedItem.model) : "";
					return `${prefix}${action.label}${suffix}`;
				});

		const selectedRoleName = this.#menuSelectedRole ? getRoleInfo(this.#menuSelectedRole, this.#settings).name : "";
		const headerText =
			showingThinking && this.#menuSelectedRole
				? `  Thinking for: ${selectedRoleName} (${selectedItem.id})`
				: `  Action for: ${selectedItem.id}`;
		const hintText = showingThinking ? "  Enter: confirm  Esc: back" : "  Enter: continue  Esc: cancel";
		// Window the option list so a long action/thinking menu scrolls inside the
		// viewport instead of running off the bottom of the screen.
		const maxVisible = this.#getMenuVisibleCount(optionLines.length);
		const needsScroll = optionLines.length > maxVisible;
		const startIndex = needsScroll
			? Math.max(0, Math.min(this.#menuSelectedIndex - Math.floor(maxVisible / 2), optionLines.length - maxVisible))
			: 0;
		const endIndex = needsScroll ? startIndex + maxVisible : optionLines.length;
		const contentWidth = Math.max(
			visibleWidth(headerText),
			visibleWidth(hintText),
			...optionLines.map(line => visibleWidth(line)),
		);
		// Reserve one column for the scrollbar when the list overflows.
		const menuWidth = contentWidth + (needsScroll ? 1 : 0);

		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxRound.horizontal.repeat(menuWidth)), 0, 0));
		if (showingThinking && this.#menuSelectedRole) {
			this.#menuContainer.addChild(
				new Text(
					theme.fg("text", `  Thinking for: ${theme.bold(selectedRoleName)} (${theme.bold(selectedItem.id)})`),
					0,
					0,
				),
			);
		} else {
			this.#menuContainer.addChild(new Text(theme.fg("text", `  Action for: ${theme.bold(selectedItem.id)}`), 0, 0));
		}
		this.#menuContainer.addChild(new Spacer(1));

		const visibleRows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const lineText = optionLines[i];
			if (lineText === undefined) continue;
			const isSelected = i === this.#menuSelectedIndex;
			visibleRows.push(isSelected ? theme.fg("accent", lineText) : theme.fg("muted", lineText));
		}
		if (needsScroll) {
			const sv = new ScrollView(visibleRows, {
				height: visibleRows.length,
				scrollbar: "auto",
				totalRows: optionLines.length,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			for (const row of sv.render(menuWidth)) {
				this.#menuContainer.addChild(new Text(row, 0, 0));
			}
		} else {
			for (const row of visibleRows) {
				this.#menuContainer.addChild(new Text(row, 0, 0));
			}
		}

		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("dim", hintText), 0, 0));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxRound.horizontal.repeat(menuWidth)), 0, 0));
	}

	#getMenuVisibleCount(optionCount: number): number {
		// Rows the selector chrome and the menu's own header/hint/borders/spacers
		// consume, leaving the remainder of the viewport for the scrollable option
		// window. Without a known terminal height (e.g. tests) show every option.
		const MENU_CHROME_ROWS = 19;
		const MIN_VISIBLE_OPTIONS = 4;
		const terminalRows = this.#tui.terminal?.rows ?? 0;
		if (!Number.isFinite(terminalRows) || terminalRows <= 0) return optionCount;
		return Math.max(MIN_VISIBLE_OPTIONS, Math.min(optionCount, terminalRows - MENU_CHROME_ROWS));
	}

	handleInput(keyData: string): void {
		if (this.#isMenuOpen) {
			this.#handleMenuInput(keyData);
			return;
		}

		// Tab bar navigation
		if (this.#tabBar?.handleInput(keyData)) {
			return;
		}

		// Up arrow - navigate list (wrap to bottom when at top)
		if (matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}

		// Down arrow - navigate list (wrap to top when at bottom)
		if (matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}

		// Enter - open context menu or select directly in temporary mode
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedItem = this.#getSelectedItem();
			if (selectedItem && !this.#isItemDisabled(selectedItem)) {
				if (this.#temporaryOnly) {
					// In temporary mode, skip menu and select directly
					this.#handleSelect(selectedItem, null);
				} else {
					this.#openMenu();
				}
			}
			return;
		}

		// Escape or Ctrl+C - close selector
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#onCancelCallback();
			return;
		}

		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterModels(this.#searchInput.getValue());
	}
	#handleMenuInput(keyData: string): void {
		const selectedItem = this.#getSelectedItem();
		if (!selectedItem || this.#isItemDisabled(selectedItem)) return;

		const optionCount =
			this.#menuStep === "thinking" && this.#menuSelectedRole !== null
				? this.#getThinkingLevelsForModel(selectedItem.model).length
				: this.#menuRoleActions.length;
		if (optionCount === 0) return;

		if (matchesSelectUp(keyData)) {
			this.#moveMenuSelection(-1, selectedItem, optionCount);
			return;
		}

		if (matchesSelectDown(keyData)) {
			this.#moveMenuSelection(1, selectedItem, optionCount);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			if (this.#menuStep === "role") {
				const action = this.#menuRoleActions[this.#menuSelectedIndex];
				if (!action || this.#isDefaultRoleActionOverContextLimit(action, selectedItem.model)) return;
				this.#menuSelectedRole = action.role;
				this.#menuStep = "thinking";
				this.#menuSelectedIndex = this.#getThinkingPreselectIndex(action.role, selectedItem.model);
				this.#updateMenu();
				return;
			}

			if (!this.#menuSelectedRole) return;
			const thinkingOptions = this.#getThinkingLevelsForModel(selectedItem.model);
			const thinkingLevel = thinkingOptions[this.#menuSelectedIndex];
			if (!thinkingLevel) return;
			this.#handleSelect(selectedItem, this.#menuSelectedRole, thinkingLevel);
			this.#closeMenu();
			return;
		}

		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			if (this.#menuStep === "thinking" && this.#menuSelectedRole !== null) {
				this.#menuStep = "role";
				const roleIndex = this.#menuRoleActions.findIndex(action => action.role === this.#menuSelectedRole);
				this.#menuSelectedRole = null;
				this.#menuSelectedIndex = roleIndex >= 0 ? roleIndex : 0;
				this.#updateMenu();
				return;
			}
			this.#closeMenu();
			return;
		}
	}

	#handleSelect(
		item: ModelItem | CanonicalModelItem,
		role: string | null,
		thinkingLevel?: ConfiguredThinkingLevel,
	): void {
		if (this.#isItemDisabled(item)) {
			return;
		}
		// For temporary role, don't save to settings - just notify caller
		if (role === null) {
			this.#onSelectCallback(item.model, null, undefined, item.selector);
			return;
		}

		const selectedThinkingLevel = thinkingLevel ?? this.#getCurrentRoleThinkingLevel(role);

		// Update local state for UI
		this.#roles[role] = { model: item.model, thinkingLevel: selectedThinkingLevel, autoSelected: false };

		// Notify caller (for updating agent state if needed)
		this.#onSelectCallback(item.model, role, selectedThinkingLevel, item.selector);

		// Update list to show new badges
		this.#updateList();
	}

	getSearchInput(): Input {
		return this.#searchInput;
	}
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
