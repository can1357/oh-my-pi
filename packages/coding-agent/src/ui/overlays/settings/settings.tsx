/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The settings window: every setting the host declares, as a `prefs` page
 * set (one page per settings tab plus the installed plugins).
 *
 * The window's state lives here: the page, the focused row (or section),
 * the open editor and its draft, the search query and its ranked results.
 * A Tern terminal draws the `prefs` node natively and reports what the user
 * did as UI events; the terminal backend's `prefs` widget turns keys into the
 * same events. Keys only the program can interpret — typing into a search or
 * a draft, Tab between section headings, the provider-limits editor — are
 * handled here first (`onKey`).
 */
import {
	type Accessor,
	batch,
	computed,
	type JSXNode,
	type KeyEvent,
	type PasteEvent,
	signal,
	type UiEvent,
	nativeRendering,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import { PREFS_MENU_FOOTER_ROLE } from "@oh-my-pi/pi-tui/term/painters/prefs";
import type { PrefsTerm } from "@oh-my-pi/pi-tui/term/painters/prefs-model";
import { slugify } from "@oh-my-pi/pi-utils";
import type { TspPrefsControl, TspPrefsProps, TspPrefsRow, TspPrefsSection, TspSpan } from "@oh-my-pi/pi-wire";
import {
	getSettingDef,
	getSettingsForTab,
	SETTING_TABS,
	type SettingDef,
	type SettingsHost,
	type SettingTab,
	type SubmenuOption,
} from "../../../config/settings-defs";
import { sanitizeDisplayLineField, sanitizeDisplaySingleLine } from "../../../extensibility/inventory/display-text";
import type { PluginSettingsHost } from "../../../modes/view-model/overlays/plugin-settings";
import { fuzzyRank } from "../../../utils/fuzzy";
import { editLine, type LineState } from "./line-edit";
import { createProviderLimitsEditor, type ProviderLimitsEditor } from "./provider-limits";
import { SETTINGS_PAGES } from "./pages";
import "../../styles/settings/settings";
import { composerShape, composerShapeIds } from "../../styles/composer/shapes";
import { listKeyId } from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import type { ShapeTarget } from "@oh-my-pi/snapcompact";
import type { StatusFacts } from "../../status/facts";
import { createStatusLine, shapePlacement, type StatusChrome } from "../../status/status-line";
import type { StatusLineSettings } from "../../../modes/view-model/status-line/types";
import { ComposerShapePreview, PREVIEW_TITLE } from "../composer-shape-preview";
import { SnapcompactSamples, SnapcompactShapePreview } from "../panels/snapcompact-shape-preview";

/** The plugins page id. */
const PLUGINS_PAGE = "plugins";
/** Role of the status-line preview child. */
const PREVIEW_ROLE = "omp.prefs.preview.status";
/** Role of an editor drawn in place of the rows. */
const EDITOR_ROLE = "omp.prefs.editor";
/** Text settings whose values are paths, ids or commands (drawn in mono). */
const MONO_TEXT_SETTING = /(path|dir|url|endpoint|host|command|model|id)$/i;
/** Settings whose menus preview the highlighted choice live. */
const PREVIEWED_SETTINGS: Readonly<Record<string, true>> = {
	"theme.dark": true,
	"theme.light": true,
	"statusLine.preset": true,
	"statusLine.separator": true,
	"statusLine.contextLine": true,
	"snapcompact.shape": true,
	"composer.shape": true,
};
/** Thinking level offered before the model's own efforts. */
const AUTO_THINKING = "auto";

type PageId = SettingTab | typeof PLUGINS_PAGE;

/** Runtime facts the settings need beyond the schema. */
export interface SettingsContext {
	readonly settings: SettingsHost;
	readonly plugins?: PluginSettingsHost;
	/** Thinking levels the current model supports. */
	readonly availableThinkingLevels: readonly string[];
	readonly availableThemes: readonly string[];
	/** Host-supplied choices for menu settings, by setting path. */
	readonly runtimeOptions?: ReadonlyMap<string, readonly SubmenuOption[]>;
	/** Provider ids for the in-flight limits editor. */
	readonly providers: readonly string[];
	/** The live status line's settings and facts: the composer shape preview draws its own line from them. */
	readonly composerPreviewStatus?: {
		readonly settings: Accessor<StatusLineSettings>;
		readonly facts: Accessor<StatusFacts>;
	};
	/** The active model: what the snapcompact shape `auto` resolves to. */
	readonly model?: ShapeTarget;
	/** The terminal can display the snapcompact sample page. */
	readonly graphics?: boolean;
}

/** The status line settings a preview applies. */
export type StatusLinePreview = Readonly<Record<string, unknown>>;

/** What the window reports to its host. */
export interface SettingsCallbacks {
	onChange(path: string, value: unknown): void;
	/** Preview a theme while its menu highlights it (and restore the active one when it closes). */
	onThemePreview?(name: string): void | Promise<void>;
	/** The theme active before a preview started. */
	currentThemeName?(): string | undefined;
	onStatusLinePreview?(settings: StatusLinePreview): void;
	/** The status line as it renders now, for the Appearance preview. */
	getStatusLinePreview?(): readonly TspSpan[];
	/** The native status bar for the preview (a Tern terminal docks it). */
	describeStatusLinePreview?(): JSXNode;
	onPluginsChanged?(): void | Promise<void>;
	onCancel(): void;
}

/** The plugins page as `prefs` props. */
export interface SettingsPluginsPrefs {
	readonly lead: string;
	readonly sections: readonly TspPrefsSection[];
	readonly focus: string | null;
	readonly editing: TspPrefsProps["editing"];
}

/** A plugins page the window shows as its last page (see `../plugins/settings`). */
export interface SettingsPluginsPage {
	/** Terminal body drawn in place of the rows. */
	readonly view: UiNode;
	/** The page as prefs rows for a Tern terminal. */
	readonly prefs: Accessor<SettingsPluginsPrefs>;
	key(key: KeyEvent): boolean;
	event(event: UiEvent): void;
	dispose(): void;
}

/** Builds the plugins page (the window passes its own close). */
export type SettingsPluginsPageFactory = (
	host: PluginSettingsHost,
	options: { onClose(): void; onChanged(): void },
) => SettingsPluginsPage;

/** One drawn entry: a heading or a setting. */
interface Item {
	readonly id: string;
	readonly label: string;
	readonly heading?: true;
	readonly def?: SettingDef;
	readonly description?: string;
	readonly warning?: string;
	/** The value the row shows. */
	readonly shown: string;
	/** Values Enter cycles through (booleans, plain enums). */
	readonly cycle?: readonly string[];
	readonly changed?: boolean;
	readonly defaultLabel?: string;
	/** Search results: the page of the row. */
	readonly page?: SettingTab;
}

type Editing =
	| { readonly kind: "menu"; readonly row: string; readonly option: string; readonly before: string }
	| { readonly kind: "text"; readonly row: string; readonly line: LineState; readonly error?: string }
	| { readonly kind: "multi"; readonly row: string; readonly option: string }
	| { readonly kind: "limits"; readonly row: string; readonly editor: ProviderLimitsEditor };

function isChanged(def: SettingDef, value: unknown): boolean {
	const fallback: unknown = def.defaultValue;
	if (Array.isArray(value) && Array.isArray(fallback))
		return value.length !== fallback.length || value.some((entry, index) => entry !== fallback[index]);
	return !Object.is(value, fallback);
}

/** A number setting whose choices are all numbers (or `default`, stored -1): its steps. */
function numberSteps(def: SettingDef): Record<string, string> | undefined {
	if (def.schemaType !== "number" || def.type !== "submenu" || def.options.length < 2) return undefined;
	const labels: Record<string, string> = {};
	for (const option of def.options) {
		const n = numericOption(option.value);
		if (n === undefined) return undefined;
		labels[String(n)] = option.label;
	}
	return labels;
}

function numericOption(value: string): number | undefined {
	if (value === "default") return -1;
	const n = Number(value);
	return value.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/** Text as a page row carries it: no styles, one line, trimmed. */
function prefsLine(text: string): string {
	return text
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function searchText(item: Item): string {
	let text = `${item.label} ${item.id} ${item.shown}`;
	if (item.description) text += ` ${item.description}`;
	if (item.warning) text += ` ${item.warning}`;
	if (item.cycle) text += ` ${item.cycle.join(" ")}`;
	return text
		.replaceAll("\t", "   ")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Width of the split layout's section sidebar, stable across pages. */
function sidebarWidth(settings: SettingsHost): number {
	let widest = 0;
	for (const tab of SETTING_TABS)
		for (const def of getSettingsForTab(settings.entries, tab))
			if (def.group) widest = Math.max(widest, Bun.stringWidth(def.group));
	return Math.min(22, widest) + 4;
}

/** Selector key ids ({@link listKeyId}) the prefs widget moves and picks with. */
const LIST_KEYS: ReadonlySet<string> = new Set(["up", "down", "pageUp", "pageDown", "enter"]);

/** The settings window. */
export function SettingsWindow(props: {
	context: SettingsContext;
	callbacks: SettingsCallbacks;
	pluginsPage?: SettingsPluginsPageFactory;
}): JSXNode {
	const { context, callbacks } = props;
	const settings = context.settings;
	const entries = settings.entries;
	const sidebar = sidebarWidth(settings);

	/** Bumped when the rows rebuild (values, conditions and changed counts re-read). */
	const version = signal(0);
	const bump = (): void => version.set(version() + 1);
	/**
	 * Bumped when a value changes without the rows rebuilding: an open
	 * multi-select applies each toggle at once, but its row text and the
	 * page's changed count follow when it closes.
	 */
	const live = signal(0);
	const tab = signal<PageId>("appearance");
	const preSearchTab = signal<PageId>("appearance");
	const query = signal<LineState>({ text: "", cursor: 0 });
	const selected = signal<string | undefined>(undefined);
	const sectionFocus = signal(false);
	const editing = signal<Editing | null>(null);
	/** The shape the open composer-shape menu highlights. */
	const previewedShape = (): string => {
		const open = editing();
		return open?.kind === "menu" && open.row === "composer.shape" ? open.option : "band";
	};
	const liveStatus = context.composerPreviewStatus;
	/** The shape preview's status line: the live one placed for the previewed shape, an unnamed session titled as a stand-in. */
	const shapeStatus: StatusChrome | undefined = liveStatus
		? createStatusLine({
				settings: liveStatus.settings,
				facts: () => {
					const facts = liveStatus.facts();
					return facts.sessionName ? facts : { ...facts, sessionName: PREVIEW_TITLE };
				},
				placement: () => shapePlacement(composerShape(previewedShape()), false),
			}).chrome
		: undefined;
	/** Sample pages of the snapcompact shape preview, rendered once each for this window. */
	const snapcompactSamples = new SnapcompactSamples();
	const pluginsPage = signal<SettingsPluginsPage | null>(null);
	const searching = (): boolean => query().text !== "";
	/** The page the strip highlights while searching: the selected result's, kept while nothing matches. */
	const searchPage = signal<string | undefined>(undefined);
	const syncSearchPage = (): void => {
		if (!untrack(searching)) return;
		const id = untrack(selectedId);
		const page = id === undefined ? undefined : untrack(rows).find(item => item.id === id)?.page;
		if (page) searchPage.set(page);
	};

	// ── Values ──────────────────────────────────────────────────────────

	const submenuOptions = (def: SettingDef & { type: "submenu" }): readonly SubmenuOption[] => {
		if (def.path === "defaultThinkingLevel")
			return [AUTO_THINKING, ...context.availableThinkingLevels].map(
				level => def.options.find(option => option.value === level) ?? { value: level, label: level },
			);
		if (def.path === "theme.dark" || def.path === "theme.light")
			return context.availableThemes.map(name => ({ value: name, label: name }));
		// Every registered composer shape (built-ins and extension shapes), by its own copy.
		if (def.path === "composer.shape")
			return composerShapeIds().map(id => {
				const shape = composerShape(id);
				return {
					value: id,
					label: sanitizeDisplaySingleLine(shape.label ?? id),
					description: sanitizeDisplayLineField(shape.description),
				};
			});
		const runtime = context.runtimeOptions?.get(def.path);
		if (!runtime) return def.options;
		return runtime.map(option => ({
			value: option.value,
			label: sanitizeDisplaySingleLine(option.label),
			description: sanitizeDisplayLineField(option.description),
		}));
	};

	const submenuValue = (path: string, value: unknown): string => {
		const raw = String(value ?? "");
		if (
			(path === "compaction.thresholdPercent" || path === "compaction.thresholdTokens") &&
			(raw === "-1" || raw === "")
		)
			return "default";
		return context.runtimeOptions?.has(path) ? sanitizeDisplaySingleLine(raw) : raw;
	};

	const textValue = (value: unknown): string => {
		if (value === undefined || value === null) return "";
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	};

	const multiValue = (def: SettingDef & { type: "multiselect" }, value: unknown): string => {
		const labels = Array.isArray(value)
			? value.flatMap(entry => {
					const option =
						typeof entry === "string" ? def.options.find(candidate => candidate.value === entry) : undefined;
					return option ? [option.label] : [];
				})
			: [];
		if (labels.length === 0) return def.ordered ? "default" : "none";
		return labels.join(def.ordered ? " → " : ", ");
	};

	const limitsValue = (value: unknown): string => {
		const limits = settings.normalizeProviderLimits(value);
		const pairs = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b));
		if (pairs.length === 0) return "Unlimited";
		return pairs.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	};

	const defaultLabel = (def: SettingDef): string => {
		const value: unknown = def.defaultValue;
		switch (def.type) {
			case "boolean":
				return value ? "On" : "Off";
			case "submenu": {
				const raw = submenuValue(def.path, value);
				return submenuOptions(def).find(option => option.value === raw)?.label ?? raw;
			}
			case "multiselect":
				return multiValue(def, value);
			case "text":
				return def.secret ? "" : textValue(value);
			default:
				return value === undefined || value === null ? "" : String(value);
		}
	};

	const toItem = (def: SettingDef): Item | null => {
		if (def.condition && !def.condition()) return null;
		const value = settings.get(def.path);
		const changed = isChanged(def, value);
		const base = {
			id: def.path,
			label: def.label,
			def,
			description: def.description,
			warning: def.warning,
			changed,
			defaultLabel: changed ? defaultLabel(def) : undefined,
		};
		switch (def.type) {
			case "boolean":
				return { ...base, shown: value ? "true" : "false", cycle: ["true", "false"] };
			case "enum":
				return { ...base, shown: String(value ?? ""), cycle: [...def.values] };
			case "submenu":
				return { ...base, shown: submenuValue(def.path, value) };
			case "text":
				return { ...base, shown: def.secret ? (value ? "••••••••" : "") : textValue(value) };
			case "providerLimits":
				return { ...base, shown: limitsValue(value) };
			case "multiselect":
				return { ...base, shown: multiValue(def, value) };
		}
	};

	const tabItems = (id: SettingTab): Item[] => {
		const items: Item[] = [];
		let group: string | undefined;
		for (const def of getSettingsForTab(entries, id)) {
			const item = toItem(def);
			if (!item) continue;
			if (def.group && def.group !== group) {
				items.push({ id: `__heading:${def.group}`, label: def.group, heading: true, shown: "" });
				group = def.group;
			}
			items.push(item);
		}
		return items;
	};

	/** Search results grouped by page, best page first. */
	const searchItems = (text: string): { items: Item[]; counts: Map<SettingTab, number> } => {
		const results: { tab: SettingTab; items: Item[]; best: number; order: number }[] = [];
		const counts = new Map<SettingTab, number>();
		SETTING_TABS.forEach((id, order) => {
			const candidates: Item[] = [];
			for (const def of getSettingsForTab(entries, id)) {
				const item = toItem(def);
				if (item) candidates.push({ ...item, page: id });
			}
			const ranked = fuzzyRank(candidates, text, searchText);
			counts.set(id, ranked.length);
			if (ranked.length > 0)
				results.push({ tab: id, items: ranked.map(r => r.item), best: ranked[0]!.score, order });
		});
		results.sort((a, b) => a.best - b.best || a.order - b.order);
		const items: Item[] = [];
		for (const result of results) {
			const page = SETTINGS_PAGES[result.tab];
			items.push({ id: `__tab:${result.tab}`, label: page.label, heading: true, shown: "" });
			items.push(...result.items);
		}
		return { items, counts };
	};

	/** The list the window shows now. */
	const items = computed((): Item[] => {
		version();
		const text = query().text;
		if (text !== "") return searchItems(text).items;
		const id = tab();
		return id === PLUGINS_PAGE ? [] : tabItems(id);
	});

	const rows = (): Item[] => items().filter(item => !item.heading);

	/** Runs of rows under one heading (leading headless rows form one). */
	const runs = (): { name: string; first: number; last: number }[] => {
		const list = items();
		const out: { name: string; first: number; last: number }[] = [];
		let current: (typeof out)[number] | undefined;
		list.forEach((item, i) => {
			if (item.heading) {
				current = { name: item.label, first: -1, last: -1 };
				out.push(current);
				return;
			}
			if (!current) {
				current = { name: "", first: i, last: i };
				out.push(current);
			}
			if (current.first < 0) current.first = i;
			current.last = i;
		});
		return out.filter(run => run.first >= 0);
	};

	/** The selected row: the stored one while visible, else the first row. */
	const selectedId = computed((): string | undefined => {
		const id = selected();
		const visible = rows();
		if (id !== undefined && visible.some(item => item.id === id)) return id;
		return visible[0]?.id;
	});
	/** The nearest row at or after `index` in a raw list (headings are skipped forward, then back). */
	const coerceRowIndex = (list: Item[], index: number): number => {
		if (list.length === 0) return -1;
		const start = Math.max(0, Math.min(index, list.length - 1));
		for (let i = start; i < list.length; i++) if (!list[i]!.heading) return i;
		for (let i = start - 1; i >= 0; i--) if (!list[i]!.heading) return i;
		return -1;
	};

	/**
	 * The row a new result set selects, as the released selector does: keep the
	 * previous row while it still matches; otherwise clamp its previous index
	 * into the new list; with no previous row, take the first. The index spans
	 * the whole list (headings included), so a clamp steps past a heading.
	 */
	const nextSelectedId = (previous: Item[], next: Item[], keep: string | undefined): string | undefined => {
		if (next.length === 0) return undefined;
		if (keep !== undefined && next.some(item => !item.heading && item.id === keep)) return keep;
		const previousIndex = keep === undefined ? 0 : previous.findIndex(item => item.id === keep);
		const at = coerceRowIndex(next, Math.min(previousIndex, next.length - 1));
		return at < 0 ? undefined : next[at]!.id;
	};

	const selectedIndex = (): number => {
		const id = selectedId();
		return Math.max(
			0,
			items().findIndex(item => !item.heading && item.id === id),
		);
	};

	const activeRun = (): number => {
		const list = runs();
		const index = selectedIndex();
		for (let i = list.length - 1; i >= 0; i--) if (list[i]!.first <= index) return i;
		return 0;
	};

	// ── Previews ────────────────────────────────────────────────────────

	const triggerStatusLinePreview = (): void => {
		callbacks.onStatusLinePreview?.({
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
		});
	};

	const preview = (path: string, value: string): void => {
		if (path === "theme.dark" || path === "theme.light") void callbacks.onThemePreview?.(value);
		else if (path === "statusLine.separator") callbacks.onStatusLinePreview?.({ separator: value });
		else if (path === "statusLine.contextLine") callbacks.onStatusLinePreview?.({ contextLine: value });
		else if (path === "statusLine.preset") callbacks.onStatusLinePreview?.({ preset: value });
	};

	const cancelPreview = (path: string, before: string): void => {
		if (path === "theme.dark" || path === "theme.light") void callbacks.onThemePreview?.(before);
		else if (path === "statusLine.separator")
			callbacks.onStatusLinePreview?.({ separator: settings.get("statusLine.separator") });
		else if (path === "statusLine.contextLine")
			callbacks.onStatusLinePreview?.({ contextLine: settings.get("statusLine.contextLine") });
		else if (path === "statusLine.preset")
			callbacks.onStatusLinePreview?.({ preset: settings.get("statusLine.preset") });
	};

	// ── Writes ──────────────────────────────────────────────────────────

	const setValue = (path: string, value: string): void => {
		const current = settings.get(path);
		const def = getSettingDef(entries, path);
		if ((path === "compaction.thresholdPercent" || path === "compaction.thresholdTokens") && value === "default") {
			settings.set(path, -1);
		} else if (def?.schemaType === "array") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				throw new Error(`Invalid array JSON for ${path}`);
			}
			if (!Array.isArray(parsed)) throw new Error(`Invalid array JSON for ${path}`);
			settings.set(path, parsed);
		} else if (def?.schemaType === "record") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value || "{}");
			} catch {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error(`Invalid record JSON for ${path}`);
			settings.set(
				path,
				path === "providers.maxInFlightRequests" ? settings.validateProviderLimits(parsed) : parsed,
			);
		} else if (typeof current === "number") {
			settings.set(path, Number(value));
		} else if (typeof current === "boolean") {
			settings.set(path, value === "true");
		} else {
			settings.set(path, value);
		}
	};

	/** A cycling row (boolean, plain enum) set to `value`. */
	const applyCycle = (item: Item, value: string): void => {
		const def = item.def!;
		if (def.type === "boolean") {
			const on = value === "true";
			settings.set(def.path, on);
			callbacks.onChange(def.path, on);
			if (def.tab === "appearance") triggerStatusLinePreview();
		} else {
			settings.set(def.path, value);
			callbacks.onChange(def.path, value);
			if (searching() && def.tab === "appearance") triggerStatusLinePreview();
		}
		bump();
	};

	// ── Editors ─────────────────────────────────────────────────────────

	const findItem = (id: string): Item | undefined => rows().find(item => item.id === id);

	const select = (id: string): void => {
		if (!findItem(id)) return;
		batch(() => {
			selected.set(id);
			sectionFocus.set(false);
		});
		syncSearchPage();
	};

	const closeEditor = (): void => {
		const open = editing();
		if (!open) return;
		batch(() => {
			editing.set(null);
			selected.set(open.row);
			bump();
		});
	};

	/** Esc on the open editor: a menu restores its preview, a multi-select keeps what it applied. */
	const cancelEditor = (): void => {
		const open = editing();
		if (!open) return;
		if (open.kind === "menu") cancelPreview(open.row, open.before);
		closeEditor();
	};

	/** ⏎ on row `id`: a cycling row (boolean, plain enum) takes its next value, any other opens its editor. */
	const enter = (id: string): void => {
		const item = findItem(id);
		if (!item?.def) return;
		const cycle = item.cycle;
		if (!cycle) {
			activate(id);
			return;
		}
		select(id);
		if (cycle.length > 0) applyCycle(item, cycle[(cycle.indexOf(item.shown) + 1) % cycle.length]!);
	};

	/** Open row `id`'s editor (a plain enum opens its choices as a menu; a switch has none). */
	const activate = (id: string): void => {
		const item = findItem(id);
		if (!item?.def) return;
		select(id);
		const def = item.def;
		switch (def.type) {
			case "boolean":
				return;
			case "enum":
				editing.set({ kind: "menu", row: id, option: item.shown, before: item.shown });
				return;
			case "submenu":
				editing.set({
					kind: "menu",
					row: id,
					option: item.shown,
					before: def.path.startsWith("theme.") ? (callbacks.currentThemeName?.() ?? item.shown) : item.shown,
				});
				return;
			case "text": {
				const text = textValue(settings.get(def.path));
				editing.set({ kind: "text", row: id, line: { text, cursor: text.length } });
				return;
			}
			case "multiselect":
				editing.set({ kind: "multi", row: id, option: def.options[0]?.value ?? "" });
				return;
			case "providerLimits":
				editing.set({
					kind: "limits",
					row: id,
					editor: createProviderLimitsEditor(settings, context.providers, {
						onChange: value => {
							callbacks.onChange("providers.maxInFlightRequests", value);
							bump();
						},
						onClose: closeEditor,
					}),
				});
				return;
		}
	};

	/** A pick from an open menu: store it and close. */
	const pickMenu = (open: Extract<Editing, { kind: "menu" }>, value: string): void => {
		const def = getSettingDef(entries, open.row);
		if (!def) return;
		setValue(def.path, value);
		callbacks.onChange(def.path, value);
		closeEditor();
	};

	const submitText = (open: Extract<Editing, { kind: "text" }>): void => {
		const def = getSettingDef(entries, open.row);
		if (!def) return;
		const value = open.line.text;
		try {
			if (value === "") settings.unset(def.path);
			else setValue(def.path, value);
		} catch (error) {
			editing.set({ ...open, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		callbacks.onChange(def.path, settings.get(def.path));
		closeEditor();
	};

	const applyMulti = (id: string, values: readonly string[]): void => {
		const def = getSettingDef(entries, id);
		if (def?.type !== "multiselect") return;
		const next = values.filter(value => def.options.some(option => option.value === value));
		settings.set(def.path, next);
		callbacks.onChange(def.path, next);
		if (editing()?.row === id) live.set(live() + 1);
		else bump();
	};

	// ── Pages and search ────────────────────────────────────────────────

	const showTab = (id: PageId): void => {
		batch(() => {
			editing.set(null);
			sectionFocus.set(false);
			selected.set(undefined);
			tab.set(id);
			const page = untrack(pluginsPage);
			if (id !== PLUGINS_PAGE && page) {
				page.dispose();
				pluginsPage.set(null);
			}
			if (id === PLUGINS_PAGE && context.plugins && props.pluginsPage) {
				page?.dispose();
				pluginsPage.set(
					props.pluginsPage(context.plugins, {
						onClose: () => callbacks.onCancel(),
						onChanged: () => void callbacks.onPluginsChanged?.(),
					}),
				);
			}
		});
	};

	const showPage = (id: string): void => {
		if (searching()) endSearch(false);
		if (id !== tab() && (id === PLUGINS_PAGE || (SETTING_TABS as readonly string[]).includes(id)))
			showTab(id as PageId);
	};

	const stepTab = (delta: -1 | 1): void => {
		const ids: PageId[] = [...SETTING_TABS, PLUGINS_PAGE];
		const at = ids.indexOf(tab());
		showTab(ids[(at + delta + ids.length) % ids.length]!);
	};

	const startSearch = (text: string): void => {
		batch(() => {
			preSearchTab.set(tab());
			selected.set(undefined);
			sectionFocus.set(false);
			query.set({ text, cursor: text.length });
			searchPage.set(tab());
		});
		syncSearchPage();
	};

	const setQuery = (line: LineState): void => {
		if (line.text === "") {
			endSearch(false);
			return;
		}
		// The released selector keeps the selected row while it still matches and
		// otherwise clamps its previous index into the new results, so a query
		// that drops the row lands there rather than on the first row.
		const previous = untrack(items);
		const before = untrack(selectedId);
		query.set(line);
		selected.set(nextSelectedId(previous, untrack(items), before));
		syncSearchPage();
	};

	/** Leave search: on the selected result's page with it selected, or back where search started. */
	const endSearch = (jump: boolean): void => {
		const id = jump ? untrack(selectedId) : undefined;
		const def = id === undefined ? undefined : getSettingDef(entries, id);
		batch(() => {
			query.set({ text: "", cursor: 0 });
			showTab(def?.tab ?? preSearchTab());
			if (def) selected.set(def.path);
		});
	};

	/** Tab while searching: the first result of the next page with results. */
	const jumpSearchTab = (delta: -1 | 1): void => {
		const list = items();
		const pages = [...new Set(list.filter(item => !item.heading).map(item => item.page!))];
		if (pages.length === 0) return;
		const current = findItem(selectedId() ?? "")?.page;
		const at = Math.max(0, pages.indexOf(current!));
		const next = pages[(at + delta + pages.length) % pages.length];
		const first = list.find(item => !item.heading && item.page === next);
		if (first) select(first.id);
	};

	const jumpSection = (delta: -1 | 1): void => {
		const list = runs();
		if (list.length < 2) return;
		const next = (activeRun() + delta + list.length) % list.length;
		const target = items()[list[next]!.first];
		if (target) selected.set(target.id);
	};

	// ── Keys ────────────────────────────────────────────────────────────

	/** A paste: into an open text field at its caret, else into the search query (one line). */
	const onPaste = (paste: PasteEvent): boolean => {
		const text = paste.text.replace(/[\r\n]+/g, "");
		const insert = (line: LineState): LineState => ({
			text: line.text.slice(0, line.cursor) + text + line.text.slice(line.cursor),
			cursor: line.cursor + text.length,
		});
		const open = editing();
		if (open?.kind === "text") {
			editing.set({ kind: "text", row: open.row, line: insert(open.line) });
			return true;
		}
		if (open || untrack(pluginsPage) || text === "") return false;
		setQuery(insert(query()));
		return true;
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const open = editing();
		const nav = listKeyId(key);
		if (open?.kind === "text") {
			if (nav === "escape") closeEditor();
			else if (getKeybindings().matches(key, "tui.input.submit")) submitText(open);
			else {
				const line = editLine(open.line, key);
				if (line) editing.set({ kind: "text", row: open.row, line });
			}
			return true;
		}
		if (open?.kind === "limits") {
			open.editor.key(key);
			return true;
		}
		// An open menu or multi-select is the widget's.
		if (open) return false;

		if (searching()) {
			if (nav === "escape") endSearch(true);
			else if (key.id === "tab") jumpSearchTab(1);
			else if (key.id === "shift+tab") jumpSearchTab(-1);
			else if (LIST_KEYS.has(nav) || key.id === "ctrl+j") return false;
			else {
				const line = editLine(query(), key);
				if (line && (line.text !== query().text || line.cursor !== query().cursor)) setQuery(line);
			}
			return true;
		}

		if (tab() === PLUGINS_PAGE) {
			if (key.id === "tab") {
				stepTab(1);
				return true;
			}
			if (key.id === "shift+tab") {
				stepTab(-1);
				return true;
			}
			if (key.id === "left" || key.id === "right") return false;
			const page = pluginsPage();
			if (page) return page.key(key);
			if (nav === "escape") callbacks.onCancel();
			return true;
		}

		if (key.id === "tab" || key.id === "shift+tab") {
			if (runs().length >= 2) sectionFocus.set(!sectionFocus());
			else stepTab(key.id === "tab" ? 1 : -1);
			return true;
		}
		if (sectionFocus()) {
			if (nav === "up" || nav === "pageUp") jumpSection(-1);
			else if (nav === "down" || nav === "pageDown") jumpSection(1);
			else if (nav === "enter" || nav === "escape" || key.id === "space" || key.id === "ctrl+j")
				sectionFocus.set(false);
			else return false;
			return true;
		}
		const typed = key.text;
		if (typed !== undefined && typed.trim().length > 0 && key.id !== "space" && !LIST_KEYS.has(nav)) {
			startSearch(typed);
			return true;
		}
		if (key.id === "ctrl+j") {
			const id = selectedId();
			if (id !== undefined) enter(id);
			return true;
		}
		return false;
	};

	// ── Events ──────────────────────────────────────────────────────────

	const onEvent = (event: UiEvent): void => {
		if (tab() === PLUGINS_PAGE && !searching()) {
			const page = pluginsPage();
			if (event.type === "action" && event.act === "page" && event.value === PLUGINS_PAGE) {
				showTab(PLUGINS_PAGE);
				return;
			}
			const window =
				(event.type === "action" &&
					(event.act === "page" || (event.act === "close" && event.value === undefined))) ||
				event.key === "tabs";
			if (page && !window) {
				page.event(event);
				return;
			}
		}
		if (event.key === "tabs") {
			if ((event.type === "select" || event.type === "activate") && !editing()) {
				if (searching()) {
					const first = rows().find(item => item.page === event.item);
					if (first) select(first.id);
				} else showPage(event.item);
			}
			return;
		}
		switch (event.type) {
			case "action": {
				if (event.act === "page" && event.value) showPage(event.value);
				else if (event.act === "close") {
					if (event.value === undefined) callbacks.onCancel();
					else if (editing()?.row === event.value) cancelEditor();
				} else if (event.act === "edit" && event.value) {
					if (editing()?.row !== event.value && !editing()) activate(event.value);
				}
				return;
			}
			case "select": {
				const eq = event.item.indexOf("=");
				if (eq >= 0) {
					const open = editing();
					const row = event.item.slice(0, eq);
					let option = event.item.slice(eq + 1);
					if (open?.row !== row) return;
					if (open.kind === "menu") {
						const def = getSettingDef(entries, row);
						if (def && numberSteps(def)) {
							const n = Number(option);
							option =
								def.type === "submenu"
									? (def.options.find(o => numericOption(o.value) === n)?.value ?? option)
									: option;
						}
						editing.set({ ...open, option });
						preview(row, option);
						bump();
					} else if (open.kind === "multi") editing.set({ ...open, option });
					return;
				}
				if (editing()) cancelEditor();
				select(event.item);
				if (searching()) return;
				return;
			}
			case "activate":
				if (editing()?.row === event.item) return;
				if (editing()) return;
				activate(event.item);
				return;
			case "change":
				applyChange(event.item, event.value);
				return;
			default:
				return;
		}
	};

	/** A value change on row `id` (a click, a Tern control, a widget key): `null` resets to the default. */
	const applyChange = (id: string, value: boolean | number | string | readonly string[] | null): void => {
		const def = getSettingDef(entries, id);
		if (!def) return;
		const item = findItem(id);
		if (value === null) {
			if (editing()) cancelEditor();
			settings.unset(def.path);
			callbacks.onChange(def.path, settings.get(def.path));
			if (def.tab === "appearance") triggerStatusLinePreview();
			bump();
			return;
		}
		switch (def.type) {
			case "boolean":
				if (typeof value === "boolean" && item) {
					select(id);
					applyCycle(item, String(value));
				}
				return;
			case "enum":
				if (typeof value !== "string" || !item?.cycle?.includes(value)) return;
				if (editing()?.row === id) cancelEditor();
				select(id);
				applyCycle(item, value);
				return;
			case "submenu": {
				const choice =
					typeof value === "number"
						? submenuOptions(def).find(option => numericOption(option.value) === value)?.value
						: typeof value === "string"
							? value
							: undefined;
				if (choice === undefined) return;
				let open = editing();
				if (open?.row !== id) {
					if (open) return;
					activate(id);
					open = editing();
				}
				if (open?.kind !== "menu") return;
				if (!submenuOptions(def).some(option => option.value === choice)) return;
				preview(id, choice);
				pickMenu(open, choice);
				return;
			}
			case "text": {
				if (typeof value !== "string") return;
				let open = editing();
				if (open?.row !== id) {
					if (open) return;
					activate(id);
					open = editing();
				}
				if (open?.kind !== "text") return;
				submitText({ ...open, line: { text: value, cursor: value.length }, error: undefined });
				return;
			}
			case "multiselect": {
				if (!Array.isArray(value)) return;
				applyMulti(id, value);
				return;
			}
			default:
				return;
		}
	};

	// ── Native description ──────────────────────────────────────────────

	const changedCount = (id: SettingTab): number => {
		version();
		let count = 0;
		for (const def of getSettingsForTab(entries, id)) {
			if (def.condition && !def.condition()) continue;
			if (isChanged(def, settings.get(def.path))) count++;
		}
		return count;
	};

	const pages = computed((): TspPrefsProps["pages"] => {
		const out: TspPrefsProps["pages"][number][] = SETTING_TABS.map(id => {
			const changed = changedCount(id);
			return { id, label: SETTINGS_PAGES[id].label, icon: id, changed: changed > 0 ? changed : undefined };
		});
		out.push({ id: PLUGINS_PAGE, label: "Installed", icon: "plugins", group: "Plugins" });
		return out;
	});

	const control = (item: Item): TspPrefsControl | undefined => {
		const def = item.def!;
		const value = settings.get(def.path);
		switch (def.type) {
			case "boolean":
				return { k: "switch", on: value === true };
			case "enum":
				return { k: "choice", value: item.shown, options: def.values.map(v => ({ value: v, label: v })) };
			case "submenu": {
				const labels = numberSteps(def);
				if (labels) {
					const n = Number(value);
					return { k: "number", value: Number.isFinite(n) ? n : -1, labels };
				}
				const options = submenuOptions(def).map(option => ({
					value: option.value,
					label: option.label,
					detail: option.description,
				}));
				return {
					k: "choice",
					value: item.shown,
					options,
					style: PREVIEWED_SETTINGS[def.path] || options.some(option => option.detail) ? "menu" : "auto",
					mono: options.every(option => option.label === option.value),
				};
			}
			case "text":
				return {
					k: "text",
					value: item.shown,
					secret: def.secret || undefined,
					mono: !def.secret && MONO_TEXT_SETTING.test(def.path) ? true : undefined,
				};
			case "providerLimits":
				return { k: "action", label: "Edit…", act: "edit" };
			case "multiselect":
				return {
					k: "multi",
					values: Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
					options: def.options.map(option => ({
						value: option.value,
						label: option.label,
						detail: option.description,
					})),
					ordered: def.ordered || undefined,
				};
		}
	};

	const prefsRow = (item: Item): TspPrefsRow | undefined => {
		const typed = control(item);
		if (!typed) return undefined;
		const line = prefsLine;
		return {
			id: item.id,
			label: line(item.label),
			hint: item.description ? line(item.description) : undefined,
			warning: item.warning ? line(item.warning) : undefined,
			changed: item.changed === true ? true : undefined,
			defaultLabel: item.changed && item.defaultLabel ? line(item.defaultLabel) : undefined,
			control: typed,
		};
	};

	const sections = computed((): TspPrefsSection[] => {
		live();
		const out: { id: string; title: string; page?: string; rows: TspPrefsRow[] }[] = [];
		for (const item of items()) {
			if (item.heading) continue;
			const row = prefsRow(item);
			if (!row) continue;
			const group = item.def!.group ?? "General";
			const slug = slugify(group);
			const ref = item.page
				? { id: `${item.page}/${slug}`, title: group, page: item.page }
				: { id: slug, title: group };
			const section = out.find(candidate => candidate.id === ref.id);
			if (section) section.rows.push(row);
			else out.push({ ...ref, rows: [row] });
		}
		return out;
	});

	const focus = (): string | null => {
		if (sectionFocus()) {
			const run = runs()[activeRun()];
			return run?.name ? slugify(run.name) : null;
		}
		return selectedId() ?? null;
	};

	const nativeEditing = (): TspPrefsProps["editing"] => {
		const open = editing();
		if (!open) return null;
		switch (open.kind) {
			case "menu":
				return { row: open.row, option: open.option };
			case "multi":
				return { row: open.row, option: open.option };
			case "text": {
				const def = getSettingDef(entries, open.row);
				const secret = def?.type === "text" && def.secret;
				return {
					row: open.row,
					draft: secret ? "•".repeat([...open.line.text].length) : open.line.text,
					cursor: open.line.cursor,
				};
			}
			case "limits":
				return null;
		}
	};

	const term = (): PrefsTerm => {
		const values: Record<string, string> = {};
		const hints: Record<string, string> = {};
		for (const item of rows()) {
			values[item.id] = item.shown;
			if (item.description && item.description !== prefsLine(item.description)) hints[item.id] = item.description;
		}
		const headless: string[] = [];
		let leading = true;
		for (const item of items()) {
			if (item.heading) {
				leading = false;
				continue;
			}
			if (leading && !item.def!.group) headless.push(slugify("General"));
			break;
		}
		const open = editing();
		const page = pluginsPage();
		return {
			title: "Settings",
			values,
			headless,
			sidebar,
			order: searching() ? rows().map(item => item.id) : undefined,
			page: searching() ? searchPage() : undefined,
			sectionFocus: sectionFocus() || undefined,
			selected: selectedId(),
			hints,
			menuPreview: { rows: ["theme.dark", "theme.light"], line: previewLine() },
			error: open?.kind === "text" ? open.error : undefined,
			body: tab() === PLUGINS_PAGE && !searching() ? page?.view : undefined,
		};
	};

	const previewLine = (): readonly TspSpan[] => {
		version();
		return callbacks.getStatusLinePreview?.() ?? [{ s: "dim", t: "(preview not available)" }];
	};

	const plugins = (): SettingsPluginsPrefs | undefined =>
		tab() === PLUGINS_PAGE && !searching() ? pluginsPage()?.prefs() : undefined;

	const children = (): JSXNode[] => {
		const out: JSXNode[] = [];
		const open = editing();
		if (open?.kind === "limits") out.push(<col role={EDITOR_ROLE}>{open.editor.view}</col>);
		// A terminal previews the highlighted shape under its menu; Tern's own settings window has no such slot.
		if (open?.kind === "menu" && !nativeRendering()) {
			const highlighted = (): string => {
				const now = editing();
				return now?.kind === "menu" ? now.option : open.option;
			};
			if (open.row === "composer.shape")
				out.push(
					<col key="shape-preview" role={PREFS_MENU_FOOTER_ROLE}>
						<ComposerShapePreview shape={highlighted} status={shapeStatus} />
					</col>,
				);
			else if (open.row === "snapcompact.shape")
				out.push(
					<col key="snapcompact-preview" role={PREFS_MENU_FOOTER_ROLE}>
						<SnapcompactShapePreview
							value={highlighted}
							model={context.model}
							samples={snapcompactSamples}
							graphics={context.graphics}
						/>
					</col>,
				);
		}
		if (tab() === "appearance" && !searching()) {
			const spans = previewLine();
			out.push(
				<col key="status-preview" role={PREVIEW_ROLE} term={{ line: spans }}>
					{callbacks.describeStatusLinePreview?.() ?? <text spans={spans} wrap="none" truncate="end" />}
				</col>,
			);
		}
		return out;
	};

	showTab("appearance");

	return (
		<prefs
			title="omp settings"
			pages={pages}
			page={() => (searching() ? preSearchTab() : tab())}
			lead={() => {
				if (searching()) return undefined;
				const id = tab();
				if (id === PLUGINS_PAGE) return plugins()?.lead ?? "Loading installed plugins…";
				return SETTINGS_PAGES[id].lead;
			}}
			query={() => (searching() ? query().text : undefined)}
			cursor={() => (searching() ? query().cursor : undefined)}
			sections={() => plugins()?.sections ?? (tab() === PLUGINS_PAGE && !searching() ? [] : sections())}
			focus={() => {
				const page = plugins();
				if (page) return page.focus;
				return tab() === PLUGINS_PAGE && !searching() ? null : focus();
			}}
			editing={() => {
				const page = plugins();
				return page ? page.editing : nativeEditing();
			}}
			term={term}
			onKey={onKey}
			onPaste={onPaste}
			onAction={(_, event) => onEvent(event)}
			onChange={onEvent}
			onSelect={(_, event) => onEvent(event)}
			onActivate={(_, event) => onEvent(event)}
		>
			{children}
		</prefs>
	);
}
