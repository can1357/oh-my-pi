/**
 * Compact session-model picker (alt+p / `/switch`): a bottom-anchored
 * floating overlay hosting a {@link ModelBrowser}, filtered by a provider
 * scope (Tab), with a thinking-level slider (alt+←/→) for the pick. Natively
 * it is a drop-up sheet rising from the composer with an icon-only provider
 * rail. Model entries switch the current session only; a search beginning
 * with `@` exposes the configured ctrl+p quick roles.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { uiText } from "@oh-my-pi/pi-utils/ui-language";
import type { Model } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { addKeyAliases, canonicalKeyId } from "../keybindings";
import { type KeyId, matchesKey, parseKey } from "../keys";
import type { Component, TUI } from "../tui";
import { type ThemeColor, theme } from "../theme/theme";
import {
	buildSessionModelScope,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelPickerCatalogue,
	providerMark,
} from "./model-browser";
import type { ModelBrowserRegistry, ModelBrowserSource } from "./model-browser";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import type { ScopedModelItem } from "./model-hub";
import { bottomBorder, row, topBorder } from "../chrome/overlay-box";
import { resolveSegmentPalette } from "../chrome/segment-track";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { card, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent } from "../native/picker";
import type { TspPickerLevel, TspPickerScope } from "@oh-my-pi/pi-wire";
import { actionHint, hintsRow, type NativeHint } from "../native/overlay";

/** Configured role resolved to a concrete model. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** Catalog refresh capability used by the session picker. */
export interface ModelPickerRegistry extends ModelBrowserRegistry {
	/** Bring the catalog up to date without rebuilding a current one; `true` when the picker must re-read it. */
	refreshIfStale(): Promise<boolean>;
}

export interface ModelPickerCallbacks {
	/**
	 * A model was chosen for a session-only switch. `selector` is `provider/id`.
	 * `overContext` is true when the session transcript exceeds the model's
	 * context window — the host must compact before switching. `thinkingLevel`
	 * is the slider's level clamped to `model`, absent when it was not moved.
	 */
	onPick: (
		model: Model,
		selector: string,
		meta: { overContext: boolean; thinkingLevel?: ConfiguredThinkingLevel },
	) => void;
	/** A configured ctrl+p quick role was chosen. */
	onPickRole?: (entry: ResolvedRoleModel) => void;
	/**
	 * A model was chosen for Task subagents (task mode, toggled by pressing the
	 * picker shortcut again). Session-only: the host applies a runtime override.
	 */
	onPickTask?: (model: Model, selector: string) => void;
	/**
	 * The picker is closing on the current model's row with the slider moved: keep `level`
	 * (clamped to that model) as the session's thinking level. {@link onCancel} follows.
	 */
	onKeepThinking?: (level: ConfiguredThinkingLevel) => void;
	/** Returns the rebuilt `--models` scope after the catalog moved; `undefined` keeps the current one. */
	onCatalogRefreshed?: () =>
		| ReadonlyArray<ScopedModelItem>
		| undefined
		| Promise<ReadonlyArray<ScopedModelItem> | undefined>;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Session token count; models with smaller context windows are grayed and compact-first on pick. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
	/** Resolved role models in the same order used by the ctrl+p quick-role cycle. */
	quickRoles?: ReadonlyArray<ResolvedRoleModel>;
	/** Complete ctrl+p order, including unavailable roles, to preserve segment colors. */
	quickRoleOrder?: ReadonlyArray<string>;
	/** Active quick role, highlighted when the search begins with `@`. */
	currentQuickRole?: string;
	/** Keys that toggle task-subagent mode while the picker is open; the first is shown in the footer. */
	taskModeKeys?: readonly KeyId[];
	/** `provider/id` highlighted and preselected in task mode (current Task subagent model). */
	taskSelector?: string;
	/**
	 * Level the untouched slider shows for `model` (clamped to its ladder): the
	 * session's current level. An untouched pick carries the session's own
	 * selection over instead. Enables the session-mode thinking slider; absent,
	 * the picker shows none.
	 */
	thinkingLevelFor?: (model: Model) => ConfiguredThinkingLevel | undefined;
}

/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
export const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;

const STATUS_HINT = "Session-only switch — role models stay unchanged";
const QUICK_ROLE_STATUS_HINT = "Quick role switch — applies its model and thinking for this session";
const TASK_STATUS_HINT = "Task subagent switch — spawned task agents use this model (session-only)";

type PickerMode = "session" | "role" | "task";

/** The scope listing every model. */
const ALL_SCOPE = "all";
/** Prefix of a provider scope id (`provider:anthropic`). */
const PROVIDER_SCOPE = "provider:";

/** Slider step labels by thinking selector. */
const THINKING_STEP_LABELS: Readonly<Record<string, string>> = {
	[AUTO_THINKING]: "Auto",
	[ThinkingLevel.Off]: "Off",
	[ThinkingLevel.Minimal]: "Min",
	[ThinkingLevel.Low]: "Low",
	[ThinkingLevel.Medium]: "Med",
	[ThinkingLevel.High]: "High",
	[ThinkingLevel.XHigh]: "XHigh",
	[ThinkingLevel.Max]: "Max",
};
/** Display label of one slider step (`Auto`, `Off`, …) or frozen-slider reason. */
const thinkingStepLabel = (label: string): string => uiText(label, undefined, "thinking");

/** The frozen slider's steps for a model without an effort to pick. */
const FROZEN_THINKING_STEPS: readonly ConfiguredThinkingLevel[] = [
	ThinkingLevel.Off,
	ThinkingLevel.Minimal,
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
];
/** Keycaps of the slider's step keys (←/→). */
const THINKING_KEYS = ["left", "right"];

/** The thinking slider for one model: its steps low to high, the shown step, and why it is frozen. */
export interface ThinkingSlider {
	steps: readonly ConfiguredThinkingLevel[];
	value: ConfiguredThinkingLevel;
	disabled?: string;
}

/** `model`'s slider steps (auto, off, its efforts), frozen when it has no effort to pick. */
function thinkingSteps(model: Model): { steps: readonly ConfiguredThinkingLevel[]; disabled?: string } {
	const efforts = getSupportedEfforts(model);
	if (efforts.length > 0) return { steps: [AUTO_THINKING, ThinkingLevel.Off, ...efforts] };
	return {
		steps: FROZEN_THINKING_STEPS,
		disabled: model.reasoning
			? uiText("{{name}} picks its own effort", { name: model.name }, "thinking")
			: uiText("{{name}} does not reason", { name: model.name }, "thinking"),
	};
}

/** `level` as one of `model`'s live `steps`: unset or inherit as the model's default, an effort clamped to its ladder. */
function thinkingStep(
	model: Model,
	steps: readonly ConfiguredThinkingLevel[],
	level: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel {
	const wanted =
		level === undefined || level === ThinkingLevel.Inherit
			? (model.thinking?.defaultLevel ?? ThinkingLevel.Off)
			: level;
	if (steps.includes(wanted)) return wanted;
	if (wanted === AUTO_THINKING || wanted === ThinkingLevel.Off) return ThinkingLevel.Off;
	return clampThinkingLevelForModel(model, wanted) ?? ThinkingLevel.Off;
}

/**
 * `model`'s thinking slider showing `level` (clamped to its ladder; unset or inherit as its default level), frozen at
 * off when it has no effort to pick. The alt+p picker's slider, and RPC's `get_model_picker` rows.
 */
export function thinkingSlider(model: Model, level: ConfiguredThinkingLevel | undefined): ThinkingSlider {
	const { steps, disabled } = thinkingSteps(model);
	if (disabled) return { steps, value: ThinkingLevel.Off, disabled };
	return { steps, value: thinkingStep(model, steps, level) };
}

/** Footer hint for the active mode; keys resolve at render time so theme/keybinding changes apply. */
function footerHint(mode: PickerMode, thinking: boolean): string {
	const upDown = editorKeys("tui.select.up", "tui.select.down");
	const enter = formatKeyHint("enter");
	const provider = `${formatKeyHint("tab")} ${uiText("provider")}`;
	const close = `${editorKey("tui.select.cancel")} ${uiText("close")}`;
	switch (mode) {
		case "role":
			return `${upDown} ${uiText("roles")} · ${enter} ${uiText("apply role model")} · ${uiText("type to search")} · ${close}`;
		case "task":
			return `${upDown} ${uiText("models")} · ${enter} ${uiText("use for Task subagents")} · ${provider} · ${uiText("type to search")} · ${close}`;
		default: {
			const level = thinking ? ` · ${formatKeyHint("left")}/${formatKeyHint("right")} ${uiText("thinking")}` : "";
			return `${upDown} ${uiText("models")} · ${enter} ${uiText("use for this session")} · ${provider}${level} · ${uiText("type to search")} · @ ${uiText("quick roles")} · ${close}`;
		}
	}
}

/**
 * The alt+p picker component. Hosted as a non-fullscreen bottom-anchored
 * overlay (`ui.showOverlay(..., { anchor: "bottom-center" })`); keyboard-only,
 * since mouse tracking is reserved for fullscreen overlays.
 */
export class ModelPickerComponent implements Component {
	#tui: TUI;
	#settings: ModelBrowserSource;
	#registry: ModelPickerRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#browser: ModelBrowser;
	#configError: string | undefined;
	#currentSelector: string | undefined;
	#currentQuickRoleSelector: string | undefined;
	#modelItems: ModelBrowserItem[] = [];
	#quickRoleItems: ModelBrowserItem[] = [];
	#quickRoles = new Map<string, ResolvedRoleModel>();
	#roleMode = false;
	#taskMode = false;
	#taskMatchKeys = new Set<string>();
	#taskModeKey: KeyId | undefined;
	#taskSelector: string | undefined;
	#thinkingLevelFor: ((model: Model) => ConfiguredThinkingLevel | undefined) | undefined;
	/** The slider's pending level; undefined while untouched (each model shows the session's current level). */
	#thinking: ConfiguredThinkingLevel | undefined;
	/** Active scope: {@link ALL_SCOPE} or `provider:<id>`. */
	#scope = ALL_SCOPE;
	#scopeItems: { source: ModelBrowserItem[]; scope: string; items: ModelBrowserItem[] } | undefined;
	#scopes: { source: ModelBrowserItem[]; value: TspPickerScope[] } | undefined;
	#level: { key: string; value: TspPickerLevel } | undefined;
	#nativeRoot: { memo: string; node: NativeNode } | undefined;
	#pickerRoot:
		| {
				memo: string;
				catalogue: ModelPickerCatalogue;
				order: object;
				scopes: readonly TspPickerScope[] | undefined;
				level: TspPickerLevel | null;
				node: NativeNode;
		  }
		| undefined;

	constructor(
		tui: TUI,
		settings: ModelBrowserSource,
		registry: ModelPickerRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		options: ModelPickerOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#currentSelector = options.currentSelector;
		this.#currentQuickRoleSelector = options.currentQuickRole ? `@${options.currentQuickRole}` : undefined;
		this.#taskSelector = options.taskSelector;
		this.#thinkingLevelFor = options.thinkingLevelFor;
		if (callbacks.onPickTask) {
			this.#taskModeKey = options.taskModeKeys?.[0];
			for (const key of options.taskModeKeys ?? []) addKeyAliases(this.#taskMatchKeys, key);
		}
		this.#quickRoleItems = this.#buildQuickRoleItems(
			options.quickRoles ?? [],
			options.quickRoleOrder ?? options.quickRoles?.map(entry => entry.role) ?? [],
		);

		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			markOverContext: true,
			emptyText: () =>
				this.#roleMode
					? `  ${uiText("No quick roles in the {{key}} cycle", {
							key: editorKey("app.model.cycleForward") || formatKeyHint("ctrl+p"),
						})}`
					: undefined,
		});
		// The rail's logos name each row's provider: the rows show the model id alone.
		this.#browser.setPickerProvider(false);
		this.#browser.onActivate = item => {
			const quickRole = this.#quickRoles.get(item.selector);
			if (quickRole) {
				callbacks.onPickRole?.(quickRole);
				return;
			}
			if (this.#taskMode) {
				callbacks.onPickTask?.(item.model, item.selector);
				return;
			}
			const overContext = this.#browser.isOverContext(item);
			const thinkingLevel = this.#pendingThinking(item.model);
			callbacks.onPick(
				item.model,
				item.selector,
				thinkingLevel === undefined ? { overContext } : { overContext, thinkingLevel },
			);
		};
		this.#browser.onCancel = () => {
			const selected = this.#browser.getSelected();
			const kept =
				selected && selected.selector === this.#currentSelector ? this.#pendingThinking(selected.model) : undefined;
			if (kept !== undefined) callbacks.onKeepThinking?.(kept);
			callbacks.onCancel();
		};
		this.#browser.onQueryChange = query => this.#syncItemsForQuery(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		// Re-read only if the catalog moves (startup discovery landing, a
		// models.yml edit, an expired discovery cache): rebuilding a current
		// catalog on every open blocks the first paint for seconds. The host
		// re-resolves a --models scope against the moved catalog.
		this.#registry
			.refreshIfStale()
			.then(async changed => {
				if (!changed) return;
				const scope = await callbacks.onCatalogRefreshed?.();
				if (scope) this.#scopedModels = scope;
				this.#syncFromRegistryState();
			})
			.catch(error => {
				this.#configError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => this.#tui.requestRender());
	}

	invalidate(): void {}

	/** Rebuild model items and role chips from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		const scope = buildSessionModelScope(
			this.#settings,
			this.#registry,
			this.#scopedModels.map(s => s.model),
		);
		this.#configError = scope.error;
		this.#modelItems = scope.items;
		this.#browser.setRoles(scope.roles);
		this.#browser.setMruOrder(scope.mruOrder);
		this.#browser.setPerfStats(this.#settings.modelPerf);
		this.#syncItemsForQuery(this.#browser.query, true);
	}

	/** Build virtual `@role` rows, colored by their ctrl+p segment position. */
	#buildQuickRoleItems(
		quickRoles: ReadonlyArray<ResolvedRoleModel>,
		quickRoleOrder: ReadonlyArray<string>,
	): ModelBrowserItem[] {
		const order = quickRoleOrder.length > 0 ? quickRoleOrder : quickRoles.map(entry => entry.role);
		const palette = resolveSegmentPalette(order.length);
		return quickRoles.map((entry, index) => {
			const selector = `@${entry.role}`;
			this.#quickRoles.set(selector, entry);
			const orderIndex = order.indexOf(entry.role);
			return {
				provider: "",
				id: selector,
				model: entry.model,
				selector,
				labelColor: palette[(orderIndex >= 0 ? orderIndex : index) % palette.length],
			};
		});
	}

	/** Switch browser content only when a leading `@` changes the search mode. */
	#syncItemsForQuery(query: string, refresh = false): void {
		const roleMode = query.startsWith("@") && !this.#taskMode;
		const modeChanged = roleMode !== this.#roleMode;
		if (!modeChanged && !refresh) return;

		this.#roleMode = roleMode;
		if (roleMode) this.#scope = ALL_SCOPE;
		this.#browser.setShowProvider(!roleMode);
		this.#browser.setMarkOverContext(!roleMode && !this.#taskMode);
		this.#browser.setPreserveQueryOrder(roleMode);
		const currentSelector = roleMode
			? this.#currentQuickRoleSelector
			: this.#taskMode
				? this.#taskSelector
				: this.#currentSelector;
		this.#browser.setCurrentSelector(currentSelector);
		this.#browser.setItems(roleMode ? this.#quickRoleItems : this.#scopedModelItems());
		if (modeChanged && currentSelector) {
			this.#browser.selectSelector(currentSelector);
		}
	}

	#mode(): PickerMode {
		return this.#taskMode ? "task" : this.#roleMode ? "role" : "session";
	}

	/** The model rows of the active scope; a provider scope that lost its models falls back to All. */
	#scopedModelItems(): ModelBrowserItem[] {
		const source = this.#modelItems;
		if (this.#scope === ALL_SCOPE) return source;
		const memo = this.#scopeItems;
		if (memo?.source === source && memo.scope === this.#scope) return memo.items;
		const provider = this.#scope.slice(PROVIDER_SCOPE.length);
		const items = source.filter(item => item.provider === provider);
		if (items.length === 0) {
			this.#scope = ALL_SCOPE;
			return source;
		}
		this.#scopeItems = { source, scope: this.#scope, items };
		return items;
	}

	/** One scope per provider with models, alphabetical; none active lists them all. */
	#pickerScopes(): TspPickerScope[] {
		const source = this.#modelItems;
		if (this.#scopes?.source === source) return this.#scopes.value;
		const counts = new Map<string, number>();
		for (const item of source) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		const value: TspPickerScope[] = [...counts.keys()]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => ({
				id: `${PROVIDER_SCOPE}${provider}`,
				label: provider,
				mark: providerMark(provider),
				count: counts.get(provider),
			}));
		this.#scopes = { source, value };
		return value;
	}

	/**
	 * Show scope `id` ({@link ALL_SCOPE}, or a provider's; the active provider again goes back to all); the highlight
	 * stays on its model when the scope lists it, else falls back to the current model.
	 */
	#setScope(picked: string): void {
		const id = picked === this.#scope ? ALL_SCOPE : picked;
		if (this.#roleMode || id === this.#scope) return;
		if (id !== ALL_SCOPE && !this.#pickerScopes().some(scope => scope.id === id)) return;
		const before = this.#browser.pickerSelected;
		this.#scope = id;
		this.#syncItemsForQuery(this.#browser.query, true);
		const target = this.#taskMode ? this.#taskSelector : this.#currentSelector;
		if (this.#browser.pickerSelected !== before && target) this.#browser.selectSelector(target);
		this.#tui.requestRender();
	}

	/** Step through all models, then each provider, wrapping. */
	#cycleScope(delta: -1 | 1): void {
		const ids = [ALL_SCOPE, ...this.#pickerScopes().map(scope => scope.id)];
		const index = ids.indexOf(this.#scope);
		const next = ids[(index + delta + ids.length) % ids.length];
		if (next) this.#setScope(next);
	}

	/** The thinking slider for the highlighted model; session mode only. */
	#slider(): ThinkingSlider | undefined {
		const levelFor = this.#thinkingLevelFor;
		if (!levelFor || this.#mode() !== "session" || this.#browser.pickerSelected === null) return undefined;
		const model = this.#browser.getSelected()?.model;
		if (!model) return undefined;
		return thinkingSlider(model, this.#thinking ?? levelFor(model));
	}

	/** The pending level as picking `model` applies it; undefined when untouched or the model has no effort. */
	#pendingThinking(model: Model): ConfiguredThinkingLevel | undefined {
		if (this.#thinking === undefined || this.#mode() !== "session") return undefined;
		const slider = thinkingSlider(model, this.#thinking);
		return slider.disabled ? undefined : slider.value;
	}

	/** Move the pending level one step along the highlighted model's slider, stopping at its ends. */
	#stepThinking(delta: -1 | 1): void {
		const slider = this.#slider();
		if (!slider || slider.disabled) return;
		const index = slider.steps.indexOf(slider.value);
		const next = slider.steps[Math.max(0, Math.min(slider.steps.length - 1, index + delta))];
		if (next === undefined || next === slider.value) return;
		this.#thinking = next;
		this.#tui.requestRender();
	}

	/** A slider press: `value` must be a step of the highlighted model's live slider. */
	#setThinking(value: string | undefined): void {
		const slider = this.#slider();
		if (!slider || slider.disabled) return;
		const step = slider.steps.find(level => level === value);
		if (step === undefined) return;
		this.#thinking = step;
		this.#tui.requestRender();
	}

	handleInput(data: string): void {
		// Mouse tracking is off outside fullscreen overlays; drop any stray SGR
		// reports instead of feeding them to the search input.
		if (data.startsWith("\x1b[<")) return;
		if (this.#taskMatchKeys.size > 0) {
			const parsed = parseKey(data);
			const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;
			if (canonical !== undefined && this.#taskMatchKeys.has(canonical)) {
				this.#toggleTaskMode();
				return;
			}
		}
		if (!this.#roleMode) {
			if (matchesKey(data, "tab")) {
				this.#cycleScope(1);
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				this.#cycleScope(-1);
				return;
			}
		}
		// ←/→ step the thinking slider; the search keeps ⌥←/→ and ⌃←/→ to
		// move its caret by words.
		if (this.#thinkingLevelFor && this.#mode() === "session") {
			if (matchesKey(data, "left")) {
				this.#stepThinking(-1);
				return;
			}
			if (matchesKey(data, "right")) {
				this.#stepThinking(1);
				return;
			}
		}
		this.#browser.handleInput(data);
	}
	/** Flip between session-model and Task-subagent targets, repointing the highlight. */
	#toggleTaskMode(): void {
		this.#taskMode = !this.#taskMode;
		this.#syncItemsForQuery(this.#browser.query, true);
		const target = this.#taskMode ? this.#taskSelector : this.#currentSelector;
		if (target) this.#browser.selectSelector(target);
		this.#tui.requestRender();
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.floor(termRows * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS;
		this.#browser.setMaxVisible(Math.max(MIN_VISIBLE, listBudget));

		const inner = Math.max(1, width - 4);
		let status = this.#configError
			? theme.fg("error", ` ${this.#configError}`)
			: this.#taskMode
				? theme.fg("error", ` ${uiText(TASK_STATUS_HINT)}`)
				: theme.fg("muted", ` ${this.#roleMode ? QUICK_ROLE_STATUS_HINT : STATUS_HINT}`);
		const slider = this.#slider();
		if (slider) {
			status += slider.disabled
				? theme.fg("dim", ` · ${uiText("no thinking")}`)
				: `${theme.fg("muted", ` · ${uiText("thinking")} `)}${theme.getThinkingBorderColor(slider.value)(thinkingStepLabel(THINKING_STEP_LABELS[slider.value] ?? slider.value))}`;
		}

		const borderColor: ThemeColor | undefined = this.#taskMode ? "error" : undefined;
		let footer = footerHint(this.#mode(), this.#thinkingLevelFor !== undefined);
		if (this.#taskModeKey !== undefined && !this.#roleMode) {
			footer += ` · ${formatKeyHint(this.#taskModeKey)} ${uiText(this.#taskMode ? "session model" : "task model")}`;
		}

		const out: string[] = [];
		out.push(topBorder(width, uiText(this.#taskMode ? "Switch Task Model" : "Switch Model"), borderColor));
		out.push(row(status, width, borderColor));
		for (const line of this.#browser.render(inner)) {
			out.push(row(line, width, borderColor));
		}
		out.push(row(theme.fg("dim", footer), width, borderColor));
		out.push(bottomBorder(width, borderColor));
		return out;
	}

	/** A `picker` is its own sheet: the backend mounts it in `layer` without an `overlay` wrapper. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	/** Picker pointer events, each on the path of the key it stands for. */
	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event);
		if (!picked) return;
		if (picked.kind !== "action") {
			this.#browser.routePickerItem(picked.item, picked.kind === "activate");
			return;
		}
		switch (picked.act) {
			case CLOSE_ACTION.id:
				this.#browser.handleCancel();
				return;
			case "clear":
				if (this.#browser.query.length > 0) this.#browser.handleCancel();
				return;
			case "task":
				if (this.#taskModeKey !== undefined && !this.#roleMode) this.#toggleTaskMode();
				return;
			case "scope":
				if (picked.value !== undefined) this.#setScope(picked.value);
				return;
			case "level":
				this.#setThinking(picked.value);
				return;
		}
	}

	/** The `md` picker sheet, or the fallback card when the terminal lacks the kind. */
	describe(cx?: DescribeContext): NativeNode {
		return cx?.supports("picker") ? this.#describePicker() : this.#describeCard();
	}

	#describePicker(): NativeNode {
		const mode = this.#mode();
		const query = this.#browser.query;
		const view = this.#browser.pickerOrder({
			providers: false,
			rest: mode === "role" ? null : query.trim() ? uiText("Matches") : uiText("All"),
		});
		const catalogue = this.#browser.pickerItems(this.#roleMode ? this.#quickRoleItems : this.#modelItems);
		const current =
			mode === "role"
				? this.#currentQuickRoleSelector
				: mode === "task"
					? this.#taskSelector
					: this.#currentSelector;
		const scopes = mode === "role" ? undefined : this.#pickerScopes();
		const level = this.#levelProps();
		const selected = this.#browser.pickerSelected;
		const cursor = this.#browser.cursor;
		const memo = `${mode}\0${this.#configError ?? ""}\0${query}\0${cursor}\0${selected ?? ""}\0${this.#scope}`;
		const cached = this.#pickerRoot;
		if (
			cached !== undefined &&
			cached.memo === memo &&
			cached.catalogue === catalogue &&
			cached.order === view &&
			cached.scopes === scopes &&
			cached.level === level
		) {
			return cached.node;
		}
		const cycleKey = editorKey("app.model.cycleForward") || formatKeyHint("ctrl+p");
		const node = picker({
			icon: "cpu",
			noun: uiText(mode === "role" ? "roles" : "models"),
			size: "md",
			anchor: "composer",
			search: "list",
			density: "snug",
			layout: "rows",
			preview: "none",
			placeholder: uiText(mode === "task" ? "Search Task models…" : "Search, @ for roles…"),
			...(scopes ? { scopes, scope: this.#scope, scopeStyle: "rail" as const } : {}),
			...this.#browser.pickerRows(catalogue, view, current),
			level,
			// The head is the search alone; a config error titles it instead (`message` shows only in the error state).
			...(this.#configError ? { title: uiText("Switch model"), subtitle: [span(this.#configError, "error")] } : {}),
			empty:
				mode === "role"
					? uiText("No quick roles in the {{key}} cycle", { key: cycleKey })
					: uiText("No models available"),
			// No action bar: click/Enter pick, Esc and the head's esc keycap close; the
			// Task-subagent toggle sits in the head.
			actions:
				this.#taskModeKey !== undefined && mode !== "role"
					? [
								pickerAction("task", uiText("Task / Main"), this.#taskModeKey, {
								on: mode === "task",
								head: true,
								icon: "users",
							}),
						]
					: [],
		});
		this.#pickerRoot = { memo, catalogue, order: view, scopes, level, node };
		return node;
	}

	/** The thinking slider's props for the highlighted model, the same object while its steps and value hold. */
	#levelProps(): TspPickerLevel | null {
		const slider = this.#slider();
		if (!slider) return null;
		// The rows leave their provider out: the chip names the highlighted one's.
		const provider = this.#browser.getSelected()?.model.provider ?? "";
		const key = `${slider.steps.join(",")}\0${slider.value}\0${slider.disabled ?? ""}\0${provider}`;
		if (this.#level?.key === key) return this.#level.value;
		const value: TspPickerLevel = {
			label: uiText("Thinking"),
			steps: slider.steps.map(id => ({ id, label: thinkingStepLabel(THINKING_STEP_LABELS[id] ?? id) })),
			value: slider.value,
			...(provider ? { detail: provider } : {}),
			icon: "brain",
			keys: THINKING_KEYS,
			...(slider.disabled ? { disabled: slider.disabled } : {}),
		};
		this.#level = { key, value };
		return value;
	}

	/** Root card over the status line, the embedded browser, and the mode's key hints. */
	#describeCard(): NativeNode {
		const mode = this.#mode();
		const memo = `${mode}\0${this.#configError ?? ""}\0${this.#taskModeKey ?? ""}`;
		if (this.#nativeRoot?.memo === memo) return this.#nativeRoot.node;

		const status = this.#configError
			? span(this.#configError, "error")
			: this.#taskMode
				? span(uiText(TASK_STATUS_HINT), "error")
				: span(uiText(this.#roleMode ? QUICK_ROLE_STATUS_HINT : STATUS_HINT), "muted");
		const hints: (NativeHint | undefined)[] = [
			actionHint(["tui.select.up", "tui.select.down"], uiText(mode === "role" ? "roles" : "models")),
			{
				keys: ["enter"],
				label: uiText(
					mode === "role"
						? "apply role model"
						: mode === "task"
							? "use for Task subagents"
							: "use for this session",
					),
			},
			{ keys: [], label: uiText("type to search") },
		];
		if (mode === "session") hints.push({ keys: ["@"], label: uiText("quick roles") });
		hints.push(actionHint("tui.select.cancel", uiText("close")));
		if (this.#taskModeKey !== undefined && !this.#roleMode) {
			hints.push({ keys: [this.#taskModeKey], label: uiText(this.#taskMode ? "session model" : "task model") });
		}
		// `card` directly: the task-mode tone is a common prop `overlayCard` doesn't take.
		const node = card(
			{
				role: "omp.overlay.model-picker",
				head: uiText(this.#taskMode ? "Switch Task Model" : "Switch Model"),
				tone: this.#taskMode ? "error" : undefined,
			},
			[text([status], { wrap: "word" }), this.#browser, hintsRow(hints)],
		);
		this.#nativeRoot = { memo, node };
		return node;
	}
}
