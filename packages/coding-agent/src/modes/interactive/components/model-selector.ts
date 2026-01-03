import { type Model, modelsAreEqual } from "@oh-my-pi/pi-ai";
import { Container, Input, isArrowDown, isArrowUp, isEnter, isEscape, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { parseModelString } from "../../../core/model-resolver.js";
import type { SettingsManager } from "../../../core/settings-manager.js";
import { fuzzyFilter } from "../../../utils/fuzzy.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel: string;
}

/**
 * Component that renders a model selector with search.
 * - Enter: Set selected model as default
 * - S: Set selected model as smol
 * - L: Set selected model as slow
 * - Escape: Close selector
 */
export class ModelSelectorComponent extends Container {
	private searchInput: Input;
	private listContainer: Container;
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

		// Add hint about model filtering and key bindings
		const hintText =
			scopedModels.length > 0
				? "Showing models from --models scope"
				: "Only showing models with configured API keys (see README for details)";
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Enter: default  S: smol  L: slow  Esc: close"), 0, 0));
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			// Enter on search input sets as default
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model, "default");
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
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

		// Sort: current model first, then by provider
		models.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});

		this.allModels = models;
		this.filteredModels = models;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, models.length - 1));
	}

	private filterModels(query: string): void {
		this.filteredModels = fuzzyFilter(this.allModels, query, ({ id, provider }) => `${id} ${provider}`);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isDefault = modelsAreEqual(this.defaultModel, item.model);
			const isSmol = modelsAreEqual(this.smolModel, item.model);
			const isSlow = modelsAreEqual(this.slowModel, item.model);

			// Build role markers: ✓ for default, ⚡ for smol, 🧠 for slow
			let markers = "";
			if (isDefault) markers += theme.fg("success", " ✓");
			if (isSmol) markers += theme.fg("warning", " ⚡");
			if (isSlow) markers += theme.fg("accent", " 🧠");

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = `${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				line = `${prefix + theme.fg("accent", modelText)} ${providerBadge}${markers}`;
			} else {
				const modelText = `  ${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				line = `${modelText} ${providerBadge}${markers}`;
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
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		// Up arrow - wrap to bottom when at top
		if (isArrowUp(keyData)) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (isArrowDown(keyData)) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter - set as default model (don't close)
		else if (isEnter(keyData)) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model, "default");
			}
		}
		// S key - set as smol model (don't close)
		else if (keyData === "s" || keyData === "S") {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model, "smol");
			}
		}
		// L key - set as slow model (don't close)
		else if (keyData === "l" || keyData === "L") {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model, "slow");
			}
		}
		// Escape - close
		else if (isEscape(keyData)) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>, role: string): void {
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

		// Update list to show new markers
		this.updateList();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
