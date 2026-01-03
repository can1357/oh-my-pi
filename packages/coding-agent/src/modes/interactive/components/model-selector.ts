import { type Model, modelsAreEqual } from "@oh-my-pi/pi-ai";
import {
	Container,
	Input,
	isArrowDown,
	isArrowLeft,
	isArrowRight,
	isArrowUp,
	isEnter,
	isEscape,
	isShiftTab,
	isTab,
	Spacer,
	Text,
	type TUI,
} from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry";
import { parseModelString } from "../../../core/model-resolver";
import type { SettingsManager } from "../../../core/settings-manager";
import { fuzzyFilter } from "../../../utils/fuzzy";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel: string;
}

type ModelRole = "default" | "smol" | "slow";

interface MenuAction {
	label: string;
	role: ModelRole;
}

const MENU_ACTIONS: MenuAction[] = [
	{ label: "Set as Default", role: "default" },
	{ label: "Set as Smol (Fast)", role: "smol" },
	{ label: "Set as Slow (Thinking)", role: "slow" },
];

const ALL_TAB = "ALL";

/**
 * Component that renders a model selector with provider tabs and context menu.
 * - Tab/Arrow Left/Right: Switch between provider tabs
 * - Arrow Up/Down: Navigate model list
 * - Enter: Open context menu to select action
 * - Escape: Close menu or selector
 */
export class ModelSelectorComponent extends Container {
	private searchInput: Input;
	private headerContainer: Container;
	private listContainer: Container;
	private menuContainer: Container;
	private allModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private defaultModel?: Model<any>;
	private smolModel?: Model<any>;
	private slowModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>, role: string) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;

	// Tab state
	private providers: string[] = [ALL_TAB];
	private activeTabIndex: number = 0;

	// Context menu state
	private isMenuOpen: boolean = false;
	private menuSelectedIndex: number = 0;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>, role: string) => void,
		onCancel: () => void,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Load current role assignments from settings
		this._loadRoleModels();

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

		// Create header container for tab bar
		this.headerContainer = new Container();
		this.addChild(this.headerContainer);

		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			// Enter on search input opens menu if we have a selection
			if (this.filteredModels[this.selectedIndex]) {
				this.openMenu();
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Create menu container (hidden by default)
		this.menuContainer = new Container();
		this.addChild(this.menuContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			this.buildProviderTabs();
			this.updateTabBar();
			this.updateList();
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private _loadRoleModels(): void {
		const roles = this.settingsManager.getModelRoles();
		const allModels = this.modelRegistry.getAll();

		// Load default model
		const defaultStr = roles.default;
		if (defaultStr) {
			const parsed = parseModelString(defaultStr);
			if (parsed) {
				this.defaultModel = allModels.find((m) => m.provider === parsed.provider && m.id === parsed.id);
			}
		}

		// Load smol model
		const smolStr = roles.smol;
		if (smolStr) {
			const parsed = parseModelString(smolStr);
			if (parsed) {
				this.smolModel = allModels.find((m) => m.provider === parsed.provider && m.id === parsed.id);
			}
		}

		// Load slow model
		const slowStr = roles.slow;
		if (slowStr) {
			const parsed = parseModelString(slowStr);
			if (parsed) {
				this.slowModel = allModels.find((m) => m.provider === parsed.provider && m.id === parsed.id);
			}
		}
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Use scoped models if provided via --models flag
		if (this.scopedModels.length > 0) {
			models = this.scopedModels.map((scoped) => ({
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
			}));
		} else {
			// Refresh to pick up any changes to models.json
			this.modelRegistry.refresh();

			// Check for models.json errors
			const loadError = this.modelRegistry.getError();
			if (loadError) {
				this.errorMessage = loadError;
			}

			// Load available models (built-in models still work even if models.json failed)
			try {
				const availableModels = await this.modelRegistry.getAvailable();
				models = availableModels.map((model: Model<any>) => ({
					provider: model.provider,
					id: model.id,
					model,
				}));
			} catch (error) {
				this.allModels = [];
				this.filteredModels = [];
				this.errorMessage = error instanceof Error ? error.message : String(error);
				return;
			}
		}

		// Sort: current model first, then by provider, then by id
		models.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const providerCmp = a.provider.localeCompare(b.provider);
			if (providerCmp !== 0) return providerCmp;
			return a.id.localeCompare(b.id);
		});

		this.allModels = models;
		this.filteredModels = models;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, models.length - 1));
	}

	private buildProviderTabs(): void {
		// Extract unique providers from models
		const providerSet = new Set<string>();
		for (const item of this.allModels) {
			providerSet.add(item.provider.toUpperCase());
		}
		// Sort providers alphabetically
		const sortedProviders = Array.from(providerSet).sort();
		this.providers = [ALL_TAB, ...sortedProviders];
	}

	private updateTabBar(): void {
		this.headerContainer.clear();

		// Build tab bar line
		const parts: string[] = [];
		parts.push(theme.fg("muted", "Provider:"));
		parts.push("  ");

		for (let i = 0; i < this.providers.length; i++) {
			const provider = this.providers[i]!;
			const isActive = i === this.activeTabIndex;

			if (isActive) {
				parts.push(theme.fg("accent", `[ ${provider} ]`));
			} else {
				parts.push(theme.fg("muted", `  ${provider}  `));
			}

			if (i < this.providers.length - 1) {
				parts.push(" ");
			}
		}

		parts.push("  ");
		parts.push(theme.fg("dim", "(←/→ or Tab to switch)"));

		this.headerContainer.addChild(new Text(parts.join(""), 0, 0));
	}

	private getActiveProvider(): string {
		return this.providers[this.activeTabIndex] ?? ALL_TAB;
	}

	private filterModels(query: string): void {
		const activeProvider = this.getActiveProvider();

		// Start with all models or filter by provider
		let baseModels = this.allModels;
		if (activeProvider !== ALL_TAB) {
			baseModels = this.allModels.filter((m) => m.provider.toUpperCase() === activeProvider);
		}

		// Apply fuzzy filter if query is present
		if (query.trim()) {
			// If user is searching, auto-switch to ALL tab to show global results
			if (activeProvider !== ALL_TAB) {
				this.activeTabIndex = 0;
				this.updateTabBar();
				baseModels = this.allModels;
			}
			this.filteredModels = fuzzyFilter(baseModels, query, ({ id, provider }) => `${id} ${provider}`);
		} else {
			this.filteredModels = baseModels;
		}

		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private applyTabFilter(): void {
		const query = this.searchInput.getValue();
		this.filterModels(query);
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		const activeProvider = this.getActiveProvider();
		const showProvider = activeProvider === ALL_TAB;

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isDefault = modelsAreEqual(this.defaultModel, item.model);
			const isSmol = modelsAreEqual(this.smolModel, item.model);
			const isSlow = modelsAreEqual(this.slowModel, item.model);

			// Build role badges (right-aligned style)
			const badges: string[] = [];
			if (isDefault) badges.push(theme.fg("success", "[ DEFAULT ]"));
			if (isSmol) badges.push(theme.fg("warning", "[ SMOL ]"));
			if (isSlow) badges.push(theme.fg("accent", "[ SLOW ]"));
			const badgeText = badges.length > 0 ? ` ${badges.join(" ")}` : "";

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = item.id;
				if (showProvider) {
					const providerBadge = theme.fg("muted", `[${item.provider}]`);
					line = `${prefix}${theme.fg("accent", modelText)} ${providerBadge}${badgeText}`;
				} else {
					line = `${prefix}${theme.fg("accent", modelText)}${badgeText}`;
				}
			} else {
				const prefix = "  ";
				if (showProvider) {
					const providerBadge = theme.fg("muted", `[${item.provider}]`);
					line = `${prefix}${item.id} ${providerBadge}${badgeText}`;
				} else {
					line = `${prefix}${item.id}${badgeText}`;
				}
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		}
	}

	private openMenu(): void {
		if (this.filteredModels.length === 0) return;

		this.isMenuOpen = true;
		this.menuSelectedIndex = 0;
		this.updateMenu();
	}

	private closeMenu(): void {
		this.isMenuOpen = false;
		this.menuContainer.clear();
	}

	private updateMenu(): void {
		this.menuContainer.clear();

		const selectedModel = this.filteredModels[this.selectedIndex];
		if (!selectedModel) return;

		// Menu header
		this.menuContainer.addChild(new Spacer(1));
		this.menuContainer.addChild(new Text(theme.fg("border", "─".repeat(40)), 0, 0));
		this.menuContainer.addChild(new Text(theme.fg("text", `  Action for: ${theme.bold(selectedModel.id)}`), 0, 0));
		this.menuContainer.addChild(new Spacer(1));

		// Menu options
		for (let i = 0; i < MENU_ACTIONS.length; i++) {
			const action = MENU_ACTIONS[i]!;
			const isSelected = i === this.menuSelectedIndex;

			let line: string;
			if (isSelected) {
				line = theme.fg("accent", `  → ${action.label}`);
			} else {
				line = theme.fg("muted", `    ${action.label}`);
			}
			this.menuContainer.addChild(new Text(line, 0, 0));
		}

		this.menuContainer.addChild(new Spacer(1));
		this.menuContainer.addChild(new Text(theme.fg("dim", "  Enter: confirm  Esc: cancel"), 0, 0));
		this.menuContainer.addChild(new Text(theme.fg("border", "─".repeat(40)), 0, 0));
	}

	handleInput(keyData: string): void {
		if (this.isMenuOpen) {
			this.handleMenuInput(keyData);
			return;
		}

		// Tab bar navigation: Left/Right arrows or Tab/Shift+Tab
		if (isArrowLeft(keyData) || isShiftTab(keyData)) {
			this.activeTabIndex = (this.activeTabIndex - 1 + this.providers.length) % this.providers.length;
			this.updateTabBar();
			this.selectedIndex = 0;
			this.applyTabFilter();
			return;
		}

		if (isArrowRight(keyData) || isTab(keyData)) {
			this.activeTabIndex = (this.activeTabIndex + 1) % this.providers.length;
			this.updateTabBar();
			this.selectedIndex = 0;
			this.applyTabFilter();
			return;
		}

		// Up arrow - navigate list (wrap to bottom when at top)
		if (isArrowUp(keyData)) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}

		// Down arrow - navigate list (wrap to top when at bottom)
		if (isArrowDown(keyData)) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// Enter - open context menu
		if (isEnter(keyData)) {
			if (this.filteredModels[this.selectedIndex]) {
				this.openMenu();
			}
			return;
		}

		// Escape - close selector
		if (isEscape(keyData)) {
			this.onCancelCallback();
			return;
		}

		// Pass everything else to search input
		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
	}

	private handleMenuInput(keyData: string): void {
		// Up arrow - navigate menu
		if (isArrowUp(keyData)) {
			this.menuSelectedIndex = (this.menuSelectedIndex - 1 + MENU_ACTIONS.length) % MENU_ACTIONS.length;
			this.updateMenu();
			return;
		}

		// Down arrow - navigate menu
		if (isArrowDown(keyData)) {
			this.menuSelectedIndex = (this.menuSelectedIndex + 1) % MENU_ACTIONS.length;
			this.updateMenu();
			return;
		}

		// Enter - confirm selection
		if (isEnter(keyData)) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			const action = MENU_ACTIONS[this.menuSelectedIndex];
			if (selectedModel && action) {
				this.handleSelect(selectedModel.model, action.role);
				this.closeMenu();
			}
			return;
		}

		// Escape - close menu only
		if (isEscape(keyData)) {
			this.closeMenu();
			return;
		}
	}

	private handleSelect(model: Model<any>, role: ModelRole): void {
		// Save to settings
		this.settingsManager.setModelRole(role, `${model.provider}/${model.id}`);

		// Update local state for UI
		if (role === "default") {
			this.defaultModel = model;
		} else if (role === "smol") {
			this.smolModel = model;
		} else if (role === "slow") {
			this.slowModel = model;
		}

		// Notify caller (for updating agent state if needed)
		this.onSelectCallback(model, role);

		// Update list to show new badges
		this.updateList();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
