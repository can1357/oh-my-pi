/**
 * Declarative settings definitions.
 *
 * Each setting is defined once here and the UI is generated automatically.
 * To add a new setting:
 * 1. Add it to SettingsManager (getter/setter)
 * 2. Add the definition here
 * 3. Add the handler in interactive-mode.ts settingsHandlers
 */

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getCapabilities } from "@oh-my-pi/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.js";

// Setting value types
export type SettingValue = boolean | string;

// Base definition for all settings
interface BaseSettingDef {
	id: string;
	label: string;
	description: string;
	tab: "config" | "exa";
}

// Boolean toggle setting
export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
	get: (sm: SettingsManager) => boolean;
	set: (sm: SettingsManager, value: boolean) => void;
	/** If provided, setting is only shown when this returns true */
	condition?: () => boolean;
}

// Enum setting (inline toggle between values)
export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
	get: (sm: SettingsManager) => string;
	set: (sm: SettingsManager, value: string) => void;
}

// Submenu setting (opens a selection list)
export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	get: (sm: SettingsManager) => string;
	set: (sm: SettingsManager, value: string) => void;
	/** Get available options dynamically */
	getOptions: (sm: SettingsManager) => Array<{ value: string; label: string; description?: string }>;
	/** Called when selection changes (for preview) */
	onPreview?: (value: string) => void;
	/** Called when submenu is cancelled (to restore preview) */
	onPreviewCancel?: (originalValue: string) => void;
}

export type SettingDef = BooleanSettingDef | EnumSettingDef | SubmenuSettingDef;

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

/**
 * All settings definitions.
 * Order determines display order within each tab.
 */
export const SETTINGS_DEFS: SettingDef[] = [
	// Config tab
	{
		id: "autoCompact",
		tab: "config",
		type: "boolean",
		label: "Auto-compact",
		description: "Automatically compact context when it gets too large",
		get: (sm) => sm.getCompactionEnabled(),
		set: (sm, v) => sm.setCompactionEnabled(v), // Also handled in session
	},
	{
		id: "showImages",
		tab: "config",
		type: "boolean",
		label: "Show images",
		description: "Render images inline in terminal",
		get: (sm) => sm.getShowImages(),
		set: (sm, v) => sm.setShowImages(v),
		condition: () => !!getCapabilities().images,
	},
	{
		id: "queueMode",
		tab: "config",
		type: "enum",
		label: "Queue mode",
		description: "How to process queued messages while agent is working",
		values: ["one-at-a-time", "all"],
		get: (sm) => sm.getQueueMode(),
		set: (sm, v) => sm.setQueueMode(v as "all" | "one-at-a-time"), // Also handled in session
	},
	{
		id: "hideThinking",
		tab: "config",
		type: "boolean",
		label: "Hide thinking",
		description: "Hide thinking blocks in assistant responses",
		get: (sm) => sm.getHideThinkingBlock(),
		set: (sm, v) => sm.setHideThinkingBlock(v),
	},
	{
		id: "collapseChangelog",
		tab: "config",
		type: "boolean",
		label: "Collapse changelog",
		description: "Show condensed changelog after updates",
		get: (sm) => sm.getCollapseChangelog(),
		set: (sm, v) => sm.setCollapseChangelog(v),
	},
	{
		id: "bashInterceptor",
		tab: "config",
		type: "boolean",
		label: "Bash interceptor",
		description: "Block shell commands that have dedicated tools (grep, cat, etc.)",
		get: (sm) => sm.getBashInterceptorEnabled(),
		set: (sm, v) => sm.setBashInterceptorEnabled(v),
	},
	{
		id: "mcpProjectConfig",
		tab: "config",
		type: "boolean",
		label: "MCP project config",
		description: "Load .mcp.json/mcp.json from project root",
		get: (sm) => sm.getMCPProjectConfigEnabled(),
		set: (sm, v) => sm.setMCPProjectConfigEnabled(v),
	},
	{
		id: "lspFormatOnWrite",
		tab: "config",
		type: "boolean",
		label: "LSP format on write",
		description: "Automatically format code files using LSP after writing",
		get: (sm) => sm.getLspFormatOnWrite(),
		set: (sm, v) => sm.setLspFormatOnWrite(v),
	},
	{
		id: "lspDiagnosticsOnWrite",
		tab: "config",
		type: "boolean",
		label: "LSP diagnostics on write",
		description: "Return LSP diagnostics (errors/warnings) after writing code files",
		get: (sm) => sm.getLspDiagnosticsOnWrite(),
		set: (sm, v) => sm.setLspDiagnosticsOnWrite(v),
	},
	{
		id: "editFuzzyMatch",
		tab: "config",
		type: "boolean",
		label: "Edit fuzzy match",
		description: "Accept high-confidence fuzzy matches for whitespace/indentation differences",
		get: (sm) => sm.getEditFuzzyMatch(),
		set: (sm, v) => sm.setEditFuzzyMatch(v),
	},
	{
		id: "thinkingLevel",
		tab: "config",
		type: "submenu",
		label: "Thinking level",
		description: "Reasoning depth for thinking-capable models",
		get: (sm) => sm.getDefaultThinkingLevel() ?? "off",
		set: (sm, v) => sm.setDefaultThinkingLevel(v as ThinkingLevel), // Also handled in session
		getOptions: () =>
			(["off", "minimal", "low", "medium", "high", "xhigh"] as ThinkingLevel[]).map((level) => ({
				value: level,
				label: level,
				description: THINKING_DESCRIPTIONS[level],
			})),
	},
	{
		id: "theme",
		tab: "config",
		type: "submenu",
		label: "Theme",
		description: "Color theme for the interface",
		get: (sm) => sm.getTheme() ?? "dark",
		set: (sm, v) => sm.setTheme(v),
		getOptions: () => [], // Filled dynamically from context
	},

	// Exa tab
	{
		id: "exaEnabled",
		tab: "exa",
		type: "boolean",
		label: "Exa enabled",
		description: "Master toggle for all Exa search tools",
		get: (sm) => sm.getExaSettings().enabled,
		set: (sm, v) => sm.setExaEnabled(v),
	},
	{
		id: "exaSearch",
		tab: "exa",
		type: "boolean",
		label: "Exa search",
		description: "Basic search, deep search, code search, crawl",
		get: (sm) => sm.getExaSettings().enableSearch,
		set: (sm, v) => sm.setExaSearchEnabled(v),
	},
	{
		id: "exaLinkedin",
		tab: "exa",
		type: "boolean",
		label: "Exa LinkedIn",
		description: "Search LinkedIn for people and companies",
		get: (sm) => sm.getExaSettings().enableLinkedin,
		set: (sm, v) => sm.setExaLinkedinEnabled(v),
	},
	{
		id: "exaCompany",
		tab: "exa",
		type: "boolean",
		label: "Exa company",
		description: "Comprehensive company research tool",
		get: (sm) => sm.getExaSettings().enableCompany,
		set: (sm, v) => sm.setExaCompanyEnabled(v),
	},
	{
		id: "exaResearcher",
		tab: "exa",
		type: "boolean",
		label: "Exa researcher",
		description: "AI-powered deep research tasks",
		get: (sm) => sm.getExaSettings().enableResearcher,
		set: (sm, v) => sm.setExaResearcherEnabled(v),
	},
	{
		id: "exaWebsets",
		tab: "exa",
		type: "boolean",
		label: "Exa websets",
		description: "Webset management and enrichment tools",
		get: (sm) => sm.getExaSettings().enableWebsets,
		set: (sm, v) => sm.setExaWebsetsEnabled(v),
	},
];

/** Get settings for a specific tab */
export function getSettingsForTab(tab: "config" | "exa"): SettingDef[] {
	return SETTINGS_DEFS.filter((def) => def.tab === tab);
}

/** Get a setting definition by id */
export function getSettingDef(id: string): SettingDef | undefined {
	return SETTINGS_DEFS.find((def) => def.id === id);
}
