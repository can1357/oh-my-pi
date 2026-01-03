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
import type { SettingsManager } from "../../../core/settings-manager";
import { getAllProvidersInfo, isProviderEnabled } from "../../../discovery";

// Setting value types
export type SettingValue = boolean | string;

// Base definition for all settings
interface BaseSettingDef {
	id: string;
	label: string;
	description: string;
	tab: string;
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
		id: "interruptMode",
		tab: "config",
		type: "enum",
		label: "Interrupt mode",
		description: "When to process queued messages: immediately (interrupt tools) or wait for turn to complete",
		values: ["immediate", "wait"],
		get: (sm) => sm.getInterruptMode(),
		set: (sm, v) => sm.setInterruptMode(v as "immediate" | "wait"), // Also handled in session
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
		id: "editFuzzyMatch",
		tab: "config",
		type: "boolean",
		label: "Edit fuzzy match",
		description: "Accept high-confidence fuzzy matches for whitespace/indentation differences",
		get: (sm) => sm.getEditFuzzyMatch(),
		set: (sm, v) => sm.setEditFuzzyMatch(v),
	},
	{
		id: "ttsrEnabled",
		tab: "config",
		type: "boolean",
		label: "TTSR enabled",
		description: "Time Traveling Stream Rules: interrupt agent when output matches rule patterns",
		get: (sm) => sm.getTtsrEnabled(),
		set: (sm, v) => sm.setTtsrEnabled(v),
	},
	{
		id: "ttsrContextMode",
		tab: "config",
		type: "enum",
		label: "TTSR context mode",
		description: "What to do with partial output when TTSR triggers",
		values: ["discard", "keep"],
		get: (sm) => sm.getTtsrContextMode(),
		set: (sm, v) => sm.setTtsrContextMode(v as "keep" | "discard"),
	},
	{
		id: "ttsrRepeatMode",
		tab: "config",
		type: "enum",
		label: "TTSR repeat mode",
		description: "How rules can repeat: once per session or after a message gap",
		values: ["once", "after-gap"],
		get: (sm) => sm.getTtsrRepeatMode(),
		set: (sm, v) => sm.setTtsrRepeatMode(v as "once" | "after-gap"),
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

	// LSP tab
	{
		id: "lspFormatOnWrite",
		tab: "lsp",
		type: "boolean",
		label: "Format on write",
		description: "Automatically format code files using LSP after writing",
		get: (sm) => sm.getLspFormatOnWrite(),
		set: (sm, v) => sm.setLspFormatOnWrite(v),
	},
	{
		id: "lspDiagnosticsOnWrite",
		tab: "lsp",
		type: "boolean",
		label: "Diagnostics on write",
		description: "Return LSP diagnostics (errors/warnings) after writing code files",
		get: (sm) => sm.getLspDiagnosticsOnWrite(),
		set: (sm, v) => sm.setLspDiagnosticsOnWrite(v),
	},
	{
		id: "lspDiagnosticsOnEdit",
		tab: "lsp",
		type: "boolean",
		label: "Diagnostics on edit",
		description: "Return LSP diagnostics (errors/warnings) after editing code files",
		get: (sm) => sm.getLspDiagnosticsOnEdit(),
		set: (sm, v) => sm.setLspDiagnosticsOnEdit(v),
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

/**
 * Get discovery provider settings dynamically.
 * These are generated at runtime from getAllProvidersInfo().
 */
function getDiscoverySettings(): SettingDef[] {
	const providers = getAllProvidersInfo();
	const settings: SettingDef[] = [];

	for (const provider of providers) {
		// Skip native provider - it can't be disabled
		if (provider.id === "native") {
			continue;
		}

		settings.push({
			id: `discovery.${provider.id}`,
			tab: "discovery",
			type: "boolean",
			label: provider.displayName,
			description: provider.description,
			get: () => isProviderEnabled(provider.id),
			set: () => {}, // Handled in interactive-mode.ts
		});
	}

	return settings;
}

/**
 * All settings with dynamic discovery settings merged in.
 */
function getAllSettings(): SettingDef[] {
	return [...SETTINGS_DEFS, ...getDiscoverySettings()];
}

/** Get settings for a specific tab */
export function getSettingsForTab(tab: string): SettingDef[] {
	return getAllSettings().filter((def) => def.tab === tab);
}

/** Get a setting definition by id */
export function getSettingDef(id: string): SettingDef | undefined {
	return getAllSettings().find((def) => def.id === id);
}
