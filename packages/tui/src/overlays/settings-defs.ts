/** Schema-independent display definitions for the settings overlay. */
import type { SymbolKey } from "../theme/symbols";
import type { MessageKey } from "@oh-my-pi/pi-i18n";
import { getDefaultI18n } from "../i18n";

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

const SETTING_TAB_KEYS: Readonly<Record<SettingTab, MessageKey>> = {
	appearance: "tui.settings.tabs.appearance",
	model: "tui.settings.tabs.model",
	interaction: "tui.settings.tabs.interaction",
	context: "tui.settings.tabs.context",
	memory: "tui.settings.tabs.memory",
	files: "tui.settings.tabs.files",
	shell: "tui.settings.tabs.shell",
	tools: "tui.settings.tabs.tools",
	tasks: "tui.settings.tabs.tasks",
	providers: "tui.settings.tabs.providers",
};

const SETTING_GROUP_KEYS: Readonly<Record<string, MessageKey>> = {
	Language: "tui.settings.groups.language",
	Theme: "tui.settings.groups.theme",
	Composer: "tui.settings.groups.composer",
	"Status Line": "tui.settings.groups.statusLine",
	Display: "tui.settings.groups.display",
	Images: "tui.settings.groups.images",
	Thinking: "tui.settings.groups.thinking",
	Sampling: "tui.settings.groups.sampling",
	Prompt: "tui.settings.groups.prompt",
	"Retry & Fallback": "tui.settings.groups.retryFallback",
	Advisor: "tui.settings.groups.advisor",
	Prewalk: "tui.settings.groups.prewalk",
	Vision: "tui.settings.groups.vision",
	Input: "tui.settings.groups.input",
	Approvals: "tui.settings.groups.approvals",
	Notifications: "tui.settings.groups.notifications",
	Speech: "tui.settings.groups.speech",
	Collab: "tui.settings.groups.collab",
	Stream: "tui.settings.groups.stream",
	"Magic Keywords": "tui.settings.groups.magicKeywords",
	"Startup & Updates": "tui.settings.groups.startupUpdates",
	Power: "tui.settings.groups.power",
	Agent: "tui.settings.groups.agent",
	Git: "tui.settings.groups.git",
	Skills: "tui.settings.groups.skills",
	General: "tui.settings.groups.general",
	Compaction: "tui.settings.groups.compaction",
	"Rules (TTSR)": "tui.settings.groups.rulesTtsr",
	Experimental: "tui.settings.groups.experimental",
	"Auto-Learn": "tui.settings.groups.autoLearn",
	Mnemopi: "tui.settings.groups.mnemopi",
	Hindsight: "tui.settings.groups.hindsight",
	Sharpshooter: "tui.settings.groups.sharpshooter",
	Editing: "tui.settings.groups.editing",
	Reading: "tui.settings.groups.reading",
	"Read Summaries": "tui.settings.groups.readSummaries",
	LSP: "tui.settings.groups.lsp",
	Bash: "tui.settings.groups.bash",
	"Eval & Runtimes": "tui.settings.groups.evalRuntimes",
	"Available Tools": "tui.settings.groups.availableTools",
	Todos: "tui.settings.groups.todos",
	"Grep & Browser": "tui.settings.groups.grepBrowser",
	Computer: "tui.settings.groups.computer",
	GitHub: "tui.settings.groups.github",
	"Output Limits": "tui.settings.groups.outputLimits",
	Execution: "tui.settings.groups.execution",
	"Discovery & MCP": "tui.settings.groups.discoveryMcp",
	Extensions: "tui.settings.groups.extensions",
	Developer: "tui.settings.groups.developer",
	Modes: "tui.settings.groups.modes",
	Subagents: "tui.settings.groups.subagents",
	Isolation: "tui.settings.groups.isolation",
	"Commands & Skills": "tui.settings.groups.commandsSkills",
	Services: "tui.settings.groups.services",
	Fireworks: "tui.settings.groups.fireworks",
	"Tiny Model": "tui.settings.groups.tinyModel",
	Protocol: "tui.settings.groups.protocol",
	Timeouts: "tui.settings.groups.timeouts",
	Privacy: "tui.settings.groups.privacy",
};

export function settingTabLabel(tab: SettingTab): string {
	return getDefaultI18n().t(SETTING_TAB_KEYS[tab]);
}

export function settingGroupLabel(group: string): string {
	const key = SETTING_GROUP_KEYS[group];
	return key ? getDefaultI18n().t(key) : group;
}

/**
 * Ordered section groups per tab. Settings declare their section via `ui.group`;
 * the settings UI renders groups in this order with a heading row between them.
 * Ungrouped settings render first, before any section heading.
 */
export const TAB_GROUPS: Record<SettingTab, readonly string[]> = {
	appearance: ["Language", "Theme", "Composer", "Status Line", "Display", "Images"],
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

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
	labelKey?: string;
	descriptionKey?: string;
};

export interface UiBase {
	tab: SettingTab;
	/** Section within the tab; must be listed in TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	label: string;
	description: string;
	labelKey?: string;
	descriptionKey?: string;
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

function entryToSettingDef(entry: SettingsDisplayEntry): SettingDef | null {
	const { path, ui } = entry;
	if (!ui) return null;

	const schemaType = entry.type;
	const condition = entry.condition;
	const base = {
		path,
		defaultValue: entry.defaultValue,
		schemaType,
		label: ui.label,
		description: ui.description,
		warning: ui.warning,
		tab: ui.tab,
		group: ui.group,
		condition,
	};

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui);

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
		// Arrays without declared options stay config-file only (free-form lists
		// like extension paths have no finite choice set to toggle).
		if (!options || options === "runtime") return null;
		return { ...base, type: "multiselect", options, ordered: ui.ordered === true };
	}

	if (schemaType === "record") {
		return path === "providers.maxInFlightRequests"
			? { ...base, type: "providerLimits" }
			: { ...base, type: "text", secret: false };
	}

	return null;
}

const definitions = new WeakMap<readonly SettingsDisplayEntry[], SettingDef[]>();

/** Get all setting definitions with UI, retaining live host visibility predicates. */
export function getAllSettingDefs(entries: readonly SettingsDisplayEntry[]): SettingDef[] {
	let defs = definitions.get(entries);
	if (!defs) {
		defs = [];
		for (const entry of entries) {
			const def = entryToSettingDef(entry);
			if (def) defs.push(def);
		}
		definitions.set(entries, defs);
	}
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

/** Format a setting's declared default for display. */
export function getDisplayDefault(entries: readonly SettingsDisplayEntry[], path: string): string {
	const value = entries.find(entry => entry.path === path)?.defaultValue;
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
