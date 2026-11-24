/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The alt+p model switcher: pick a model for this session (role models stay
 * as they are), with the thinking slider for the highlighted model; the
 * task-mode key flips it to picking the model Task subagents use; a query
 * starting with `@` lists the ctrl+p quick roles instead.
 *
 * A `picker` sheet rising from the composer: the search leads the list,
 * providers form a logo rail (Tab / ⇧Tab step through them, the active one
 * again goes back to all), the Recent block heads the list. Keys are the
 * program's: ↑/↓ and paging move, ←/→ step the slider, Enter picks, Esc
 * clears the query then closes. The catalog is read at once and refreshed
 * in the background when stale; a refresh error shows in the head.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { batch, computed, effect, type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { keyCaps } from "@oh-my-pi/pi-tui/term/painters/picker";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspPickerLevel, TspPickerScope } from "@oh-my-pi/pi-wire";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { ScopedModelItem } from "../../../modes/view-model/overlays/model-hub";
import {
	buildSessionModelScope,
	type ModelBrowserItem,
	type ModelBrowserRegistry,
	type ModelBrowserSource,
	providerMark,
	thinkingDotToken,
} from "../../../modes/view-model/overlays/model-browser";
import {
	type ModelPickerCallbacks,
	type ModelPickerOptions,
	type ResolvedRoleModel,
	type ThinkingSlider,
	thinkingSlider,
} from "../../../modes/view-model/overlays/model-picker";
import type { ConfiguredThinkingLevel } from "../../../utils/render-utils";
import "../../styles/pickers/model-picker";
import { segmentPalette } from "../../styles/pickers/model-browser";
import type { ModelPickerLookTerm } from "../../styles/pickers/model-picker";
import { ModelBrowserState } from "./model-browser-state";
import { pickerAction } from "./select-sheet";
import { actionKbd, cancelKbd, confirmKbd } from "../../keys/hints";

/** Catalog access the switcher needs: the browser's reads plus a refresh when stale. */
export interface ModelPickerRegistry extends ModelBrowserRegistry {
	/** Bring the catalog up to date without rebuilding a current one; true when it moved. */
	refreshIfStale(): Promise<boolean>;
}

export interface ModelPickerProps {
	readonly source: ModelBrowserSource;
	readonly registry: ModelPickerRegistry;
	/** The `--models` scope (empty: every available chat model). */
	readonly scopedModels: ReadonlyArray<ScopedModelItem>;
	readonly callbacks: ModelPickerCallbacks;
	readonly options?: ModelPickerOptions;
	/** Terminal height; the sheet takes 40% of it (default 40 rows). */
	readonly terminalRows?: () => number;
}

/** Rows of chrome around the list: frame, status and hint rows. */
const CHROME_ROWS = 4;
/** Rows the browser draws around its window: search + blank, blank + two detail rows. */
const BROWSER_FRAME_ROWS = 5;
/** The list's least rows on short terminals. */
const MIN_VISIBLE = 5;
/** Share of the terminal the sheet takes. */
const HEIGHT_FRACTION = 0.4;

const STATUS_HINT = "Session-only switch — role models stay unchanged";
const QUICK_ROLE_HINT = "Quick role switch — applies its model and thinking for this session";
const TASK_HINT = "Task subagent switch — spawned task agents use this model (session-only)";

/** The scope listing every model. */
const ALL_SCOPE = "all";
const PROVIDER_SCOPE = "provider:";

/** Slider step labels. */
const STEP_LABELS: Readonly<Record<string, string>> = {
	auto: "Auto",
	off: "Off",
	minimal: "Min",
	low: "Low",
	medium: "Med",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

/** The thinking color of a slider level (`max` falls back to `xhigh` in themes without one). */
function levelColor(theme: Theme, level: ConfiguredThinkingLevel): string {
	const token = thinkingDotToken(level) ?? "thinkingOff";
	return token === "thinkingMax" && !theme.has("thinkingMax") ? "thinkingXhigh" : token;
}

type Mode = "session" | "role" | "task";

export function ModelPicker(props: ModelPickerProps): JSXNode {
	const { source, registry, callbacks } = props;
	const options = props.options ?? {};
	const quickRoleKey = `@`;
	const cycleKey = keyCaps(["ctrl", "p"]);
	const taskKey = callbacks.onPickTask ? options.taskModeKeys?.[0] : undefined;
	const taskKeys = new Set<string>(callbacks.onPickTask ? (options.taskModeKeys ?? []) : []);
	const currentQuickRole = options.currentQuickRole ? `${quickRoleKey}${options.currentQuickRole}` : undefined;

	const roleMode = signal(false);
	const taskMode = signal(false);
	/** The slider's pending level; undefined while untouched (each model shows the session's level). */
	const thinking = signal<ConfiguredThinkingLevel | undefined>(undefined);
	const scope = signal(ALL_SCOPE);
	const configError = signal<string | undefined>(undefined);
	const modelItems = signal<ModelBrowserItem[]>([]);
	let scopedModels = props.scopedModels;

	const quickRoles = new Map<string, ResolvedRoleModel>();
	const quickRoleItems: ModelBrowserItem[] = (() => {
		const entries = options.quickRoles ?? [];
		const order = options.quickRoleOrder?.length ? options.quickRoleOrder : entries.map(entry => entry.role);
		const palette = segmentPalette(currentTheme(), order.length);
		return entries.map((entry, index) => {
			const selector = `${quickRoleKey}${entry.role}`;
			quickRoles.set(selector, entry);
			const at = order.indexOf(entry.role);
			return {
				provider: "",
				id: selector,
				model: entry.model,
				selector,
				labelColor: palette[(at >= 0 ? at : index) % palette.length],
			};
		});
	})();

	const browser = new ModelBrowserState(source, {
		currentContextTokens: options.currentContextTokens,
		markOverContext: true,
		emptyText: () => (roleMode() ? `  No quick roles in the ${cycleKey} cycle` : undefined),
	});
	// The rail's logos name each row's provider: picker rows show the model id alone.
	browser.setPickerProvider(false);

	const mode = (): Mode => (taskMode() ? "task" : roleMode() ? "role" : "session");

	/** The highlighted model's slider; session mode only. */
	const slider = (): ThinkingSlider | undefined => {
		const levelFor = options.thinkingLevelFor;
		if (!levelFor || mode() !== "session") return undefined;
		const model = browser.selected()?.model;
		if (!model) return undefined;
		return thinkingSlider(model, thinking() ?? levelFor(model));
	};

	/** The pending level as picking `model` applies it; undefined when untouched or the model has no effort. */
	const pendingThinking = (model: Model): ConfiguredThinkingLevel | undefined => {
		const pending = thinking();
		if (pending === undefined || mode() !== "session") return undefined;
		const shown = thinkingSlider(model, pending);
		return shown.disabled ? undefined : shown.value;
	};

	/** One scope per provider with models, alphabetical. */
	const scopes = (): TspPickerScope[] => {
		const counts = new Map<string, number>();
		for (const item of modelItems()) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		return [...counts.keys()]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => ({
				id: `${PROVIDER_SCOPE}${provider}`,
				label: provider,
				mark: providerMark(provider),
				count: counts.get(provider),
			}));
	};

	/** The active scope's models; a provider scope that lost its models falls back to all. */
	const scopedItems = (): ModelBrowserItem[] => {
		const all = modelItems.peek();
		if (scope.peek() === ALL_SCOPE) return all;
		const provider = scope.peek().slice(PROVIDER_SCOPE.length);
		const items = all.filter(item => item.provider === provider);
		if (items.length > 0) return items;
		scope.set(ALL_SCOPE);
		return all;
	};

	/** The browser's rows for the query's mode: a leading `@` lists the quick roles (outside task mode). */
	const syncItems = (query: string, refresh = false): void => {
		const wantRoles = query.startsWith(quickRoleKey) && !taskMode.peek();
		const changed = wantRoles !== roleMode.peek();
		if (!changed && !refresh) return;
		batch(() => {
			roleMode.set(wantRoles);
			if (wantRoles) scope.set(ALL_SCOPE);
			browser.setShowProvider(!wantRoles);
			browser.setMarkOverContext(!wantRoles && !taskMode.peek());
			browser.setPreserveQueryOrder(wantRoles);
			const current = wantRoles
				? currentQuickRole
				: taskMode.peek()
					? options.taskSelector
					: options.currentSelector;
			browser.setCurrentSelector(current);
			browser.setItems(wantRoles ? quickRoleItems : scopedItems());
			if (changed && current) browser.selectSelector(current);
		});
	};

	const syncFromRegistry = (): void => {
		const scoped = buildSessionModelScope(
			source,
			registry,
			scopedModels.map(entry => entry.model),
		);
		batch(() => {
			configError.set(scoped.error);
			modelItems.set(scoped.items);
			browser.setRoles(scoped.roles);
			browser.setMruOrder(scoped.mruOrder);
			browser.setPerfStats(source.modelPerf);
			syncItems(browser.query, true);
		});
	};

	/** Show scope `picked` (the active one again shows all); the highlight falls back to the current model when it leaves. */
	const setScope = (picked: string): void => {
		const id = picked === scope.peek() ? ALL_SCOPE : picked;
		if (roleMode.peek() || id === scope.peek()) return;
		if (id !== ALL_SCOPE && !scopes().some(entry => entry.id === id)) return;
		const before = browser.pickerSelected;
		batch(() => {
			scope.set(id);
			syncItems(browser.query, true);
			const target = taskMode.peek() ? options.taskSelector : options.currentSelector;
			if (browser.pickerSelected !== before && target) browser.selectSelector(target);
		});
	};

	const cycleScope = (delta: -1 | 1): void => {
		const ids = [ALL_SCOPE, ...scopes().map(entry => entry.id)];
		const next = ids[(ids.indexOf(scope.peek()) + delta + ids.length) % ids.length];
		if (next) setScope(next);
	};

	const stepThinking = (delta: -1 | 1): void => {
		const shown = slider();
		if (!shown || shown.disabled) return;
		const index = shown.steps.indexOf(shown.value);
		const next = shown.steps[Math.max(0, Math.min(shown.steps.length - 1, index + delta))];
		if (next !== undefined && next !== shown.value) thinking.set(next);
	};

	const setThinking = (value: string | undefined): void => {
		const shown = slider();
		if (!shown || shown.disabled) return;
		const step = shown.steps.find(level => level === value);
		if (step !== undefined) thinking.set(step);
	};

	const toggleTaskMode = (): void => {
		batch(() => {
			taskMode.set(!taskMode.peek());
			syncItems(browser.query, true);
			const target = taskMode.peek() ? options.taskSelector : options.currentSelector;
			if (target) browser.selectSelector(target);
		});
	};

	browser.onActivate = item => {
		const quickRole = quickRoles.get(item.selector);
		if (quickRole) {
			callbacks.onPickRole?.(quickRole);
			return;
		}
		if (taskMode.peek()) {
			callbacks.onPickTask?.(item.model, item.selector);
			return;
		}
		const overContext = browser.isOverContext(item);
		const thinkingLevel = pendingThinking(item.model);
		callbacks.onPick(
			item.model,
			item.selector,
			thinkingLevel === undefined ? { overContext } : { overContext, thinkingLevel },
		);
	};
	browser.onCancel = () => {
		const selected = browser.selected();
		const kept =
			selected && selected.selector === options.currentSelector ? pendingThinking(selected.model) : undefined;
		if (kept !== undefined) callbacks.onKeepThinking?.(kept);
		callbacks.onCancel();
	};
	browser.onQueryChange = query => syncItems(query);

	// Read the catalog as it is now, so the first Enter acts on cached models.
	syncFromRegistry();
	if (options.currentSelector) browser.selectSelector(options.currentSelector);
	// Re-read only when the catalog moved (discovery landing, a models.yml edit).
	registry
		.refreshIfStale()
		.then(async changed => {
			if (!changed) return;
			const scope = await callbacks.onCatalogRefreshed?.();
			if (scope) scopedModels = scope;
			syncFromRegistry();
		})
		.catch(error => configError.set(error instanceof Error ? error.message : String(error)));

	effect(() => {
		const rows = Math.max(16, props.terminalRows?.() ?? 40);
		const budget = Math.floor(rows * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS;
		browser.setMaxVisible(Math.max(MIN_VISIBLE, budget));
	});

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		if (taskKeys.has(key.id)) {
			toggleTaskMode();
			return true;
		}
		if (!roleMode()) {
			if (key.id === "tab") {
				cycleScope(1);
				return true;
			}
			if (key.id === "shift+tab") {
				cycleScope(-1);
				return true;
			}
		}
		// ←/→ step the slider; the query keeps ⌥←/→ and ⌃←/→ for its caret.
		if (options.thinkingLevelFor && mode() === "session" && (key.id === "left" || key.id === "right")) {
			stepThinking(key.id === "left" ? -1 : 1);
			return true;
		}
		browser.handleKey(key);
		return true;
	};

	const level = (): TspPickerLevel | null => {
		const shown = slider();
		if (!shown) return null;
		// The rows leave their provider out: the chip names the highlighted one's.
		const provider = browser.selected()?.model.provider ?? "";
		return {
			label: "Thinking",
			steps: shown.steps.map(id => ({ id, label: STEP_LABELS[id] ?? id })),
			value: shown.value,
			...(provider ? { detail: provider } : {}),
			icon: "brain",
			keys: ["left", "right"],
			...(shown.disabled ? { disabled: shown.disabled } : {}),
		};
	};

	const current = (): string | undefined =>
		mode() === "role" ? currentQuickRole : mode() === "task" ? options.taskSelector : options.currentSelector;

	// One computation per change: `pickerItems` tracks which rows went out whole.
	const rows = computed(() => {
		const query = browser.query;
		const catalogue = browser.pickerItems(roleMode() ? quickRoleItems : modelItems());
		return browser.pickerRows(
			catalogue,
			{ providers: false, rest: mode() === "role" ? null : query.trim() ? "Matches" : "All" },
			current(),
		);
	});

	const footer = (): string => {
		const close = `${keyCaps(cancelKbd())} close`;
		const nav = `${keyCaps(actionKbd("tui.select.up", "up"))}/${keyCaps(actionKbd("tui.select.down", "down"))}`;
		const confirm = keyCaps(confirmKbd());
		const provider = `${keyCaps(["tab"])} provider`;
		let hint: string;
		switch (mode()) {
			case "role":
				hint = `${nav} roles · ${confirm} apply role model · type to search · ${close}`;
				break;
			case "task":
				hint = `${nav} models · ${confirm} use for Task subagents · ${provider} · type to search · ${close}`;
				break;
			default: {
				const steps = options.thinkingLevelFor ? " · ←/→ thinking" : "";
				hint = `${nav} models · ${confirm} use for this session · ${provider}${steps} · type to search · @ quick roles · ${close}`;
			}
		}
		if (taskKey !== undefined && !roleMode())
			hint += ` · ${keyCaps(taskKey.split("+"))} ${taskMode() ? "session model" : "task model"}`;
		return hint;
	};

	const term = (): ModelPickerLookTerm => {
		const error = configError();
		const shown = slider();
		const theme = currentTheme();
		return {
			look: "omp.model-picker",
			browser,
			heading: taskMode() ? "Switch Task Model" : "Switch Model",
			...(taskMode() ? { tone: "error" } : {}),
			status: error
				? { text: error, tone: "error" }
				: taskMode()
					? { text: TASK_HINT, tone: "error" }
					: { text: roleMode() ? QUICK_ROLE_HINT : STATUS_HINT, tone: "muted" },
			...(shown
				? {
						thinking: shown.disabled
							? ("frozen" as const)
							: { label: STEP_LABELS[shown.value] ?? shown.value, color: levelColor(theme, shown.value) },
					}
				: {}),
			footer: footer(),
		};
	};

	return (
		<picker
			icon="cpu"
			noun={() => (mode() === "role" ? "roles" : "models")}
			size="md"
			anchor="composer"
			search="list"
			density="snug"
			layout="rows"
			preview="none"
			placeholder={() => (mode() === "task" ? "Search Task models…" : "Search, @ for roles…")}
			scopes={() => (mode() === "role" ? undefined : scopes())}
			scope={() => (mode() === "role" ? undefined : scope())}
			scopeStyle={() => (mode() === "role" ? undefined : "rail")}
			query={() => rows().query}
			cursor={() => rows().cursor}
			columns={() => rows().columns}
			items={() => rows().items}
			itemsAdd={() => rows().itemsAdd}
			itemsDel={() => rows().itemsDel}
			order={() => rows().order}
			hits={() => rows().hits}
			selected={() => rows().selected}
			current={() => rows().current}
			total={() => rows().total}
			level={level}
			title={() => (configError() ? "Switch model" : undefined)}
			subtitle={() => {
				const error = configError();
				return error ? [{ s: "error", t: error }] : undefined;
			}}
			empty={() => (mode() === "role" ? `No quick roles in the ${cycleKey} cycle` : "No models available")}
			actions={() =>
				taskKey !== undefined && mode() !== "role"
					? [
							pickerAction("task", "Task / Main", taskKey.split("+"), {
								on: mode() === "task",
								head: true,
								icon: "users",
							}),
						]
					: []
			}
			term={term}
			onKey={onKey}
			onSelect={id => void browser.routePickerItem(id, false)}
			onActivate={id => void browser.routePickerItem(id, true)}
			onAction={(act, event) => {
				switch (act) {
					case "close":
						browser.handleCancel();
						return;
					case "clear":
						if (browser.query.length > 0) browser.handleCancel();
						return;
					case "task":
						if (taskKey !== undefined && !roleMode.peek()) toggleTaskMode();
						return;
					case "scope":
						if (event.value !== undefined) setScope(event.value);
						return;
					case "level":
						setThinking(event.value);
						return;
				}
			}}
		/>
	);
}
