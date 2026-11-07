/** Schema-independent display definitions for the settings overlay. */
import type { SymbolKey } from "../theme/symbols";
import { displayText, getDisplayCatalogEpoch } from "./display-catalog";

export type SettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers";

/** Tab display metadata - icon is resolved via theme.symbol() */
export type TabMetadata = { label: string; icon: Extract<SymbolKey, `tab.${string}`> };

/** Ordered list of tabs for UI rendering */
export const SETTING_TABS: SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"context",
	"memory",
	"files",
	"shell",
	"tools",
	"tasks",
	"providers",
];

/** Tab display metadata - icon is a symbol key from theme.ts (tab.*) */
export const TAB_METADATA: Record<SettingTab, TabMetadata> = {
	appearance: { label: "Appearance", icon: "tab.appearance" },
	model: { label: "Model", icon: "tab.model" },
	interaction: { label: "Interaction", icon: "tab.interaction" },
	context: { label: "Context", icon: "tab.context" },
	memory: { label: "Memory", icon: "tab.memory" },
	files: { label: "Files", icon: "tab.files" },
	shell: { label: "Shell", icon: "tab.shell" },
	tools: { label: "Tools", icon: "tab.tools" },
	tasks: { label: "Tasks", icon: "tab.tasks" },
	providers: { label: "Providers", icon: "tab.providers" },
};

/**
 * Tab metadata with its label translated by the display catalog. The icon is a
 * theme symbol key, never display text, so it is left alone. The original object
 * comes back when the label is unchanged, keeping memory identity stable.
 */
export function tabDisplayMetadata(tab: SettingTab): TabMetadata {
	const meta = TAB_METADATA[tab];
	const label = displayText(`tab.${tab}.label`, meta.label);
	return label === meta.label ? meta : { ...meta, label };
}

/** One-sentence lead per tab, under the page title of the native settings page. */
export const TAB_LEADS: Record<SettingTab, string> = {
	appearance: "Theme, composer, status line and how the transcript renders.",
	model: "Thinking, sampling, the system prompt, retries and the helper models.",
	interaction: "Input, approvals, notifications, speech and what happens at startup.",
	context: "What the model sees, and when and how the conversation compacts.",
	memory: "What omp remembers across sessions and where it keeps it.",
	files: "How files are read, summarized and edited, and the language servers.",
	shell: "The bash tool and the eval runtimes.",
	tools: "Which tools the model has, their limits and the external integrations.",
	tasks: "Modes, subagents, isolation and custom commands.",
	providers: "Services, provider protocols, timeouts and privacy.",
};

/** The tab's lead sentence, translated by the display catalog. */
export function tabDisplayLead(tab: SettingTab): string {
	return displayText(`tab.${tab}.lead`, TAB_LEADS[tab]);
}

/**
 * Ordered section groups per tab. Settings declare their section via `ui.group`;
 * the settings UI renders groups in this order with a heading row between them.
 * Ungrouped settings render first, before any section heading.
 */
export const TAB_GROUPS: Record<SettingTab, readonly string[]> = {
	appearance: ["Theme", "Composer", "Status Line", "Display", "Images"],
	model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
	interaction: [
		"Input",
		"Approvals",
		"Notifications",
		"Speech",
		"Collab",
		"Stream",
		"Magic Keywords",
		"Startup & Updates",
		"Power",
		"Agent",
		"Git",
		"Skills",
	],
	context: ["General", "Compaction", "Rules (TTSR)", "Experimental"],
	memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"],
	files: ["Editing", "Reading", "Read Summaries", "LSP"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Grep & Browser",
		"Computer",
		"IDA Pro",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Extensions",
		"Developer",
	],
	tasks: ["Modes", "Subagents", "Isolation", "Commands & Skills"],
	providers: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
};

/**
 * A section heading translated by the display catalog, keyed on the canonical
 * group name. `SettingDef.group` and `TAB_GROUPS` stay canonical: they drive
 * ordering and `prefsSectionId`, which must not follow the display language.
 */
export function groupDisplayName(tab: SettingTab, group: string): string {
	return displayText(`group.${tab}.${group}`, group);
}

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

export interface UiBase {
	tab: SettingTab;
	/** Section within the tab; must be listed in TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	label: string;
	description: string;
	/**
	 * Risk note. Marks the settings row with a warning glyph and renders above
	 * the description in warning styling. For settings that can get the user
	 * rate-limited, flagged, or banned — not for merely advanced options.
	 */
	warning?: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
	secret?: boolean;
	ordered?: boolean;
	editor?: "json";
};

/** Structural schema entries supplied by the application host. */
export interface SettingsDisplayEntry {
	path: string;
	type: string;
	defaultValue: unknown;
	ui?: AnyUiMetadata;
	enumValues?: readonly string[];
	credential?: boolean;
	condition?: () => boolean;
}

export interface SettingsHost {
	entries: readonly SettingsDisplayEntry[];
	get(path: string): unknown;
	set(path: string, value: unknown): void;
	/**
	 * Removes the value from the global config: a project or other layer, or an environment
	 * variable, that configures the setting still applies; otherwise the default does.
	 */
	unset(path: string): void;
	normalizeProviderLimits(value: unknown): Record<string, number>;
	validateProviderLimits(value: unknown): Record<string, number>;
}

/** Primitive value displayed by a settings control. */
export type SettingsDisplayValue = boolean | string;

interface BaseSettingDef {
	path: string;
	defaultValue: unknown;
	schemaType: string;
	label: string;
	description: string;
	/** Risk note shown in warning styling; set for settings that can get the user flagged or banned. */
	warning?: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	condition?: () => boolean;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

export interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

/** Array-of-enum setting edited as a toggle list; `ordered` lists render positions and support reordering. */
export interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: OptionList;
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| TextInputSettingDef
	| ProviderLimitsSettingDef
	| MultiSelectSettingDef;

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

/** Localize an option list; the original array comes back when no choice is translated. */
function localizeOptions(path: string, options: OptionList): OptionList {
	let changed = false;
	const localized = options.map(option => {
		const label = displayText(`setting.${path}.option.${option.value}.label`, option.label);
		const description =
			option.description === undefined
				? undefined
				: displayText(`setting.${path}.option.${option.value}.description`, option.description);
		if (label === option.label && description === option.description) return option;
		changed = true;
		return description === undefined ? { value: option.value, label } : { value: option.value, label, description };
	});
	return changed ? localized : options;
}

function entryToSettingDef(entry: SettingsDisplayEntry): SettingDef | null {
	const { path, ui } = entry;
	if (!ui) return null;

	const schemaType = entry.type;
	const condition = entry.condition;
	const base = {
		path,
		defaultValue: entry.defaultValue,
		schemaType,
		label: displayText(`setting.${path}.label`, ui.label),
		description: displayText(`setting.${path}.description`, ui.description),
		warning: ui.warning === undefined ? undefined : displayText(`setting.${path}.warning`, ui.warning),
		tab: ui.tab,
		// Canonical, untranslated: `group` drives ordering (TAB_GROUPS) and prefsSectionId.
		group: ui.group,
		condition,
	};

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const resolved = resolveOptions(ui);
	const options = resolved && resolved !== "runtime" ? localizeOptions(path, resolved) : resolved;

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: entry.enumValues ?? [] };
		}
		// "runtime" is not a valid sentinel for enums — schema types prevent this,
		// but treat defensively as an empty submenu.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		// Numbers without options are intentionally hidden from the UI.
		if (!options || options === "runtime") return null;
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "string") {
		if (options === "runtime") {
			// Empty list now; the selector layer (theme handling, etc.) injects choices.
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}
		// One classification drives both surfaces: a setting marked `credential`
		// masks here too, so the panel cannot display one that only the CLI knows
		// to redact.
		return { ...base, type: "text", secret: entry.credential === true };
	}

	if (schemaType === "array") {
		if (ui.editor === "json") return { ...base, type: "text", secret: entry.credential === true };
		if (!options) return null;
		if (options === "runtime") return null;
		return { ...base, type: "multiselect", options, ordered: ui.ordered === true };
	}

	if (schemaType === "record") {
		return path === "providers.maxInFlightRequests"
			? { ...base, type: "providerLimits" }
			: { ...base, type: "text", secret: false };
	}

	return null;
}

/** Definitions per entry list, rebuilt when the display catalog changes (`epoch`). */
const definitions = new WeakMap<readonly SettingsDisplayEntry[], { epoch: number; defs: SettingDef[] }>();

/** Get all setting definitions with UI, retaining live host visibility predicates. */
export function getAllSettingDefs(entries: readonly SettingsDisplayEntry[]): SettingDef[] {
	const epoch = getDisplayCatalogEpoch();
	const cached = definitions.get(entries);
	if (cached?.epoch === epoch) return cached.defs;
	const defs: SettingDef[] = [];
	for (const entry of entries) {
		const def = entryToSettingDef(entry);
		if (def) defs.push(def);
	}
	definitions.set(entries, { epoch, defs });
	return defs;
}

/** Get settings ordered by their tab's section layout. */
export function getSettingsForTab(entries: readonly SettingsDisplayEntry[], tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs(entries).filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Find the display definition for a host setting path. */
export function getSettingDef(entries: readonly SettingsDisplayEntry[], path: string): SettingDef | undefined {
	return getAllSettingDefs(entries).find(def => def.path === path);
}

/**
 * The numeric value a number-like choice option stands for: its number, or
 * -1 for `default` (the stored sentinel, see the selector's value mapping);
 * `undefined` when the option is not numeric.
 */
export function numericOption(value: string): number | undefined {
	if (value === "default") return -1;
	const n = Number(value);
	return value.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/**
 * Number hint: a numeric setting whose choices are all numbers (or the
 * `default` sentinel) edits as a stepper through those values on a native
 * settings page. Returns the steps (number → label), else `undefined`.
 */
export function numberSteps(def: SettingDef): Record<string, string> | undefined {
	if (def.schemaType !== "number" || def.type !== "submenu" || def.options.length < 2) return undefined;
	const labels: Record<string, string> = {};
	for (const option of def.options) {
		const n = numericOption(option.value);
		if (n === undefined) return undefined;
		labels[String(n)] = option.label;
	}
	return labels;
}

/** Format a setting's declared default for display. */
export function getDisplayDefault(entries: readonly SettingsDisplayEntry[], path: string): string {
	const value = entries.find(entry => entry.path === path)?.defaultValue;
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
