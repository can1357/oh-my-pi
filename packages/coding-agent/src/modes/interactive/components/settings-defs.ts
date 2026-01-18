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
import type {
	ImageProviderOption,
	NotificationMethod,
	PythonKernelMode,
	PythonToolMode,
	SettingsManager,
	StatusLinePreset,
	StatusLineSeparatorStyle,
	SymbolPreset,
	WebSearchProviderOption,
} from "../../../core/settings-manager";
import { getPreset } from "./status-line/presets";

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
 *
 * Tabs:
 * - behavior: Core agent behavior (compaction, modes, retries, notifications)
 * - tools: Tool-specific settings (bash, git, python, edit, MCP, skills)
 * - display: Visual/UI settings (theme, images, thinking)
 * - voice: Voice mode and TTSR settings
 * - status: Status line configuration
 * - lsp: LSP integration settings
 * - exa: Exa search tool settings
 */
export const SETTINGS_DEFS: SettingDef[] = [
	// ═══════════════════════════════════════════════════════════════════════════
	// Behavior tab - Core agent behavior
	// ═══════════════════════════════════════════════════════════════════════════
	{
		id: "autoCompact",
		tab: "behavior",
		type: "boolean",
		label: "Auto-compact",
		description: "Automatically compact context when it gets too large",
		get: (sm) => sm.getCompactionEnabled(),
		set: (sm, v) => sm.setCompactionEnabled(v),
	},
	{
		id: "branchSummaries",
		tab: "behavior",
		type: "boolean",
		label: "Branch summaries",
		description: "Prompt to summarize when leaving a branch",
		get: (sm) => sm.getBranchSummaryEnabled(),
		set: (sm, v) => sm.setBranchSummaryEnabled(v),
	},
	{
		id: "todoCompletion",
		tab: "behavior",
		type: "boolean",
		label: "Todo completion",
		description: "Remind agent to complete todos before stopping",
		get: (sm) => sm.getTodoCompletionEnabled(),
		set: (sm, v) => sm.setTodoCompletionEnabled(v),
	},
	{
		id: "todoCompletionMaxReminders",
		tab: "behavior",
		type: "submenu",
		label: "Todo max reminders",
		description: "Maximum reminders to complete todos before giving up",
		get: (sm) => String(sm.getTodoCompletionMaxReminders()),
		set: (sm, v) => sm.setTodoCompletionMaxReminders(Number.parseInt(v, 10)),
		getOptions: () => [
			{ value: "1", label: "1 reminder" },
			{ value: "2", label: "2 reminders" },
			{ value: "3", label: "3 reminders" },
			{ value: "5", label: "5 reminders" },
		],
	},
	{
		id: "steeringMode",
		tab: "behavior",
		type: "enum",
		label: "Steering mode",
		description: "How to process queued messages while agent is working",
		values: ["one-at-a-time", "all"],
		get: (sm) => sm.getSteeringMode(),
		set: (sm, v) => sm.setSteeringMode(v as "all" | "one-at-a-time"),
	},
	{
		id: "followUpMode",
		tab: "behavior",
		type: "enum",
		label: "Follow-up mode",
		description: "How to drain follow-up messages after a turn completes",
		values: ["one-at-a-time", "all"],
		get: (sm) => sm.getFollowUpMode(),
		set: (sm, v) => sm.setFollowUpMode(v as "one-at-a-time" | "all"),
	},
	{
		id: "interruptMode",
		tab: "behavior",
		type: "enum",
		label: "Interrupt mode",
		description: "When steering messages interrupt tool execution",
		values: ["immediate", "wait"],
		get: (sm) => sm.getInterruptMode(),
		set: (sm, v) => sm.setInterruptMode(v as "immediate" | "wait"),
	},
	{
		id: "retryMaxRetries",
		tab: "behavior",
		type: "submenu",
		label: "Retry max attempts",
		description: "Maximum retry attempts on API errors",
		get: (sm) => String(sm.getRetryMaxRetries()),
		set: (sm, v) => sm.setRetryMaxRetries(Number.parseInt(v, 10)),
		getOptions: () => [
			{ value: "1", label: "1 retry" },
			{ value: "2", label: "2 retries" },
			{ value: "3", label: "3 retries" },
			{ value: "5", label: "5 retries" },
			{ value: "10", label: "10 retries" },
		],
	},
	{
		id: "completionNotification",
		tab: "behavior",
		type: "enum",
		label: "Completion notification",
		description: "Notify when the agent completes",
		values: ["auto", "bell", "osc99", "osc9", "off"],
		get: (sm) => sm.getNotificationOnComplete(),
		set: (sm, v) => sm.setNotificationOnComplete(v as NotificationMethod),
	},
	{
		id: "startupQuiet",
		tab: "behavior",
		type: "boolean",
		label: "Startup quiet",
		description: "Skip welcome screen and startup status messages",
		get: (sm) => sm.getStartupQuiet(),
		set: (sm, v) => sm.setStartupQuiet(v),
	},
	{
		id: "collapseChangelog",
		tab: "behavior",
		type: "boolean",
		label: "Collapse changelog",
		description: "Show condensed changelog after updates",
		get: (sm) => sm.getCollapseChangelog(),
		set: (sm, v) => sm.setCollapseChangelog(v),
	},
	{
		id: "doubleEscapeAction",
		tab: "behavior",
		type: "enum",
		label: "Double-escape action",
		description: "Action when pressing Escape twice with empty editor",
		values: ["tree", "branch"],
		get: (sm) => sm.getDoubleEscapeAction(),
		set: (sm, v) => sm.setDoubleEscapeAction(v as "branch" | "tree"),
	},

	// ═══════════════════════════════════════════════════════════════════════════
	// Tools tab - Tool-specific settings
	// ═══════════════════════════════════════════════════════════════════════════
	{
		id: "bashInterceptor",
		tab: "tools",
		type: "boolean",
		label: "Bash interceptor",
		description: "Block shell commands that have dedicated tools (grep, cat, etc.)",
		get: (sm) => sm.getBashInterceptorEnabled(),
		set: (sm, v) => sm.setBashInterceptorEnabled(v),
	},
	{
		id: "bashInterceptorSimpleLs",
		tab: "tools",
		type: "boolean",
		label: "Intercept simple ls",
		description: "Intercept bare ls commands (when bash interceptor is enabled)",
		get: (sm) => sm.getBashInterceptorSimpleLsEnabled(),
		set: (sm, v) => sm.setBashInterceptorSimpleLsEnabled(v),
	},
	{
		id: "gitTool",
		tab: "tools",
		type: "boolean",
		label: "Git tool",
		description: "Enable structured Git tool",
		get: (sm) => sm.getGitToolEnabled(),
		set: (sm, v) => sm.setGitToolEnabled(v),
	},
	{
		id: "pythonToolMode",
		tab: "tools",
		type: "enum",
		label: "Python tool mode",
		description: "How Python code is executed",
		values: ["ipy-only", "bash-only", "both"],
		get: (sm) => sm.getPythonToolMode(),
		set: (sm, v) => sm.setPythonToolMode(v as PythonToolMode),
	},
	{
		id: "pythonKernelMode",
		tab: "tools",
		type: "enum",
		label: "Python kernel mode",
		description: "Whether to keep IPython kernel alive across calls",
		values: ["session", "per-call"],
		get: (sm) => sm.getPythonKernelMode(),
		set: (sm, v) => sm.setPythonKernelMode(v as PythonKernelMode),
	},
	{
		id: "editFuzzyMatch",
		tab: "tools",
		type: "boolean",
		label: "Edit fuzzy match",
		description: "Accept high-confidence fuzzy matches for whitespace/indentation differences",
		get: (sm) => sm.getEditFuzzyMatch(),
		set: (sm, v) => sm.setEditFuzzyMatch(v),
	},
	{
		id: "mcpProjectConfig",
		tab: "tools",
		type: "boolean",
		label: "MCP project config",
		description: "Load .mcp.json/mcp.json from project root",
		get: (sm) => sm.getMCPProjectConfigEnabled(),
		set: (sm, v) => sm.setMCPProjectConfigEnabled(v),
	},
	{
		id: "skillCommands",
		tab: "tools",
		type: "boolean",
		label: "Skill commands",
		description: "Register skills as /skill:name commands",
		get: (sm) => sm.getEnableSkillCommands(),
		set: (sm, v) => sm.setEnableSkillCommands(v),
	},
	{
		id: "claudeUserCommands",
		tab: "tools",
		type: "boolean",
		label: "Claude user commands",
		description: "Load commands from ~/.claude/commands/",
		get: (sm) => sm.getCommandsEnableClaudeUser(),
		set: (sm, v) => sm.setCommandsEnableClaudeUser(v),
	},
	{
		id: "claudeProjectCommands",
		tab: "tools",
		type: "boolean",
		label: "Claude project commands",
		description: "Load commands from .claude/commands/",
		get: (sm) => sm.getCommandsEnableClaudeProject(),
		set: (sm, v) => sm.setCommandsEnableClaudeProject(v),
	},
	{
		id: "webSearchProvider",
		tab: "tools",
		type: "submenu",
		label: "Web search provider",
		description: "Provider for web search tool",
		get: (sm) => sm.getWebSearchProvider(),
		set: (sm, v) => sm.setWebSearchProvider(v as WebSearchProviderOption),
		getOptions: () => [
			{ value: "auto", label: "Auto", description: "Priority: Exa > Perplexity > Anthropic" },
			{ value: "exa", label: "Exa", description: "Use Exa (requires EXA_API_KEY)" },
			{ value: "perplexity", label: "Perplexity", description: "Use Perplexity (requires PERPLEXITY_API_KEY)" },
			{ value: "anthropic", label: "Anthropic", description: "Use Anthropic web search" },
		],
	},
	{
		id: "imageProvider",
		tab: "tools",
		type: "submenu",
		label: "Image provider",
		description: "Provider for image generation tool",
		get: (sm) => sm.getImageProvider(),
		set: (sm, v) => sm.setImageProvider(v as ImageProviderOption),
		getOptions: () => [
			{ value: "auto", label: "Auto", description: "Priority: OpenRouter > Gemini" },
			{ value: "gemini", label: "Gemini", description: "Use Gemini API directly (requires GEMINI_API_KEY)" },
			{ value: "openrouter", label: "OpenRouter", description: "Use OpenRouter (requires OPENROUTER_API_KEY)" },
		],
	},

	// ═══════════════════════════════════════════════════════════════════════════
	// Display tab - Visual/UI settings
	// ═══════════════════════════════════════════════════════════════════════════
	{
		id: "theme",
		tab: "display",
		type: "submenu",
		label: "Theme",
		description: "Color theme for the interface",
		get: (sm) => sm.getTheme() ?? "dark",
		set: (sm, v) => sm.setTheme(v),
		getOptions: () => [], // Filled dynamically from context
	},
	{
		id: "symbolPreset",
		tab: "display",
		type: "submenu",
		label: "Symbol preset",
		description: "Icon/symbol style (overrides theme default)",
		get: (sm) => sm.getSymbolPreset() ?? "unicode",
		set: (sm, v) => sm.setSymbolPreset(v as SymbolPreset),
		getOptions: () => [
			{ value: "unicode", label: "Unicode", description: "Standard Unicode symbols (default)" },
			{ value: "nerd", label: "Nerd Font", description: "Nerd Font icons (requires Nerd Font)" },
			{ value: "ascii", label: "ASCII", description: "ASCII-only characters (maximum compatibility)" },
		],
	},
	{
		id: "thinkingLevel",
		tab: "display",
		type: "submenu",
		label: "Thinking level",
		description: "Reasoning depth for thinking-capable models",
		get: (sm) => sm.getDefaultThinkingLevel() ?? "off",
		set: (sm, v) => sm.setDefaultThinkingLevel(v as ThinkingLevel),
		getOptions: () =>
			(["off", "minimal", "low", "medium", "high", "xhigh"] as ThinkingLevel[]).map((level) => ({
				value: level,
				label: level,
				description: THINKING_DESCRIPTIONS[level],
			})),
	},
	{
		id: "hideThinking",
		tab: "display",
		type: "boolean",
		label: "Hide thinking",
		description: "Hide thinking blocks in assistant responses",
		get: (sm) => sm.getHideThinkingBlock(),
		set: (sm, v) => sm.setHideThinkingBlock(v),
	},
	{
		id: "showImages",
		tab: "display",
		type: "boolean",
		label: "Show images",
		description: "Render images inline in terminal",
		get: (sm) => sm.getShowImages(),
		set: (sm, v) => sm.setShowImages(v),
		condition: () => !!getCapabilities().images,
	},
	{
		id: "autoResizeImages",
		tab: "display",
		type: "boolean",
		label: "Auto-resize images",
		description: "Resize large images to 2000x2000 max for better model compatibility",
		get: (sm) => sm.getImageAutoResize(),
		set: (sm, v) => sm.setImageAutoResize(v),
	},
	{
		id: "blockImages",
		tab: "display",
		type: "boolean",
		label: "Block images",
		description: "Prevent images from being sent to LLM providers",
		get: (sm) => sm.getBlockImages(),
		set: (sm, v) => sm.setBlockImages(v),
	},
	{
		id: "showHardwareCursor",
		tab: "display",
		type: "boolean",
		label: "Hardware cursor",
		description: "Show terminal cursor for IME support (default: on for Linux/macOS)",
		get: (sm) => sm.getShowHardwareCursor(),
		set: (sm, v) => sm.setShowHardwareCursor(v),
	},

	// ═══════════════════════════════════════════════════════════════════════════
	// Voice tab - Voice mode and TTSR settings
	// ═══════════════════════════════════════════════════════════════════════════
	{
		id: "voiceEnabled",
		tab: "voice",
		type: "boolean",
		label: "Voice mode",
		description: "Enable realtime voice input/output (Ctrl+Y toggle, auto-send on silence)",
		get: (sm) => sm.getVoiceEnabled(),
		set: (sm, v) => sm.setVoiceEnabled(v),
	},
	{
		id: "voiceTtsModel",
		tab: "voice",
		type: "submenu",
		label: "TTS model",
		description: "Text-to-speech model for voice output",
		get: (sm) => sm.getVoiceTtsModel(),
		set: (sm, v) => sm.setVoiceTtsModel(v),
		getOptions: () => [
			{ value: "gpt-4o-mini-tts", label: "GPT-4o Mini TTS", description: "Fast and efficient" },
			{ value: "tts-1", label: "TTS-1", description: "Standard quality" },
			{ value: "tts-1-hd", label: "TTS-1 HD", description: "Higher quality" },
		],
	},
	{
		id: "voiceTtsVoice",
		tab: "voice",
		type: "submenu",
		label: "TTS voice",
		description: "Voice for text-to-speech output",
		get: (sm) => sm.getVoiceTtsVoice(),
		set: (sm, v) => sm.setVoiceTtsVoice(v),
		getOptions: () => [
			{ value: "alloy", label: "Alloy", description: "Neutral" },
			{ value: "echo", label: "Echo", description: "Male" },
			{ value: "fable", label: "Fable", description: "British" },
			{ value: "onyx", label: "Onyx", description: "Deep male" },
			{ value: "nova", label: "Nova", description: "Female" },
			{ value: "shimmer", label: "Shimmer", description: "Female" },
		],
	},
	{
		id: "voiceTtsFormat",
		tab: "voice",
		type: "submenu",
		label: "TTS format",
		description: "Audio format for voice output",
		get: (sm) => sm.getVoiceTtsFormat(),
		set: (sm, v) => sm.setVoiceTtsFormat(v as "wav" | "mp3" | "opus" | "aac" | "flac"),
		getOptions: () => [
			{ value: "wav", label: "WAV", description: "Uncompressed, best quality" },
			{ value: "mp3", label: "MP3", description: "Compressed, widely compatible" },
			{ value: "opus", label: "Opus", description: "Efficient compression" },
			{ value: "aac", label: "AAC", description: "Apple-friendly" },
			{ value: "flac", label: "FLAC", description: "Lossless compression" },
		],
	},
	{
		id: "ttsrEnabled",
		tab: "voice",
		type: "boolean",
		label: "TTSR enabled",
		description: "Time Traveling Stream Rules: interrupt agent when output matches patterns",
		get: (sm) => sm.getTtsrEnabled(),
		set: (sm, v) => sm.setTtsrEnabled(v),
	},
	{
		id: "ttsrContextMode",
		tab: "voice",
		type: "enum",
		label: "TTSR context mode",
		description: "What to do with partial output when TTSR triggers",
		values: ["discard", "keep"],
		get: (sm) => sm.getTtsrContextMode(),
		set: (sm, v) => sm.setTtsrContextMode(v as "keep" | "discard"),
	},
	{
		id: "ttsrRepeatMode",
		tab: "voice",
		type: "enum",
		label: "TTSR repeat mode",
		description: "How rules can repeat: once per session or after a message gap",
		values: ["once", "after-gap"],
		get: (sm) => sm.getTtsrRepeatMode(),
		set: (sm, v) => sm.setTtsrRepeatMode(v as "once" | "after-gap"),
	},
	{
		id: "ttsrRepeatGap",
		tab: "voice",
		type: "submenu",
		label: "TTSR repeat gap",
		description: "Messages before a rule can trigger again (when repeat mode is after-gap)",
		get: (sm) => String(sm.getTtsrRepeatGap()),
		set: (sm, v) => sm.setTtsrRepeatGap(Number.parseInt(v, 10)),
		getOptions: () => [
			{ value: "5", label: "5 messages" },
			{ value: "10", label: "10 messages" },
			{ value: "15", label: "15 messages" },
			{ value: "20", label: "20 messages" },
			{ value: "30", label: "30 messages" },
		],
	},

	// ═══════════════════════════════════════════════════════════════════════════
	// Status tab - Status line configuration
	// ═══════════════════════════════════════════════════════════════════════════
	{
		id: "statusLinePreset",
		tab: "status",
		type: "submenu",
		label: "Preset",
		description: "Pre-built status line configurations",
		get: (sm) => sm.getStatusLinePreset(),
		set: (sm, v) => sm.setStatusLinePreset(v as StatusLinePreset),
		getOptions: () => [
			{ value: "default", label: "Default", description: "Model, path, git, context, tokens, cost" },
			{ value: "minimal", label: "Minimal", description: "Path and git only" },
			{ value: "compact", label: "Compact", description: "Model, git, cost, context" },
			{ value: "full", label: "Full", description: "All segments including time" },
			{ value: "nerd", label: "Nerd", description: "Maximum info with Nerd Font icons" },
			{ value: "ascii", label: "ASCII", description: "No special characters" },
			{ value: "custom", label: "Custom", description: "User-defined segments" },
		],
	},
	{
		id: "statusLineSeparator",
		tab: "status",
		type: "submenu",
		label: "Separator style",
		description: "Style of separators between segments",
		get: (sm) => {
			const settings = sm.getStatusLineSettings();
			if (settings.separator) return settings.separator;
			return getPreset(sm.getStatusLinePreset()).separator;
		},
		set: (sm, v) => sm.setStatusLineSeparator(v as StatusLineSeparatorStyle),
		getOptions: () => [
			{ value: "powerline", label: "Powerline", description: "Solid arrows (requires Nerd Font)" },
			{ value: "powerline-thin", label: "Thin chevron", description: "Thin arrows (requires Nerd Font)" },
			{ value: "slash", label: "Slash", description: "Forward slashes" },
			{ value: "pipe", label: "Pipe", description: "Vertical pipes" },
			{ value: "block", label: "Block", description: "Solid blocks" },
			{ value: "none", label: "None", description: "Space only" },
			{ value: "ascii", label: "ASCII", description: "Greater-than signs" },
		],
	},
	{
		id: "statusLineShowHooks",
		tab: "status",
		type: "boolean",
		label: "Show extension status",
		description: "Display hook status messages below status line",
		get: (sm) => sm.getStatusLineShowHookStatus(),
		set: (sm, v) => sm.setStatusLineShowHookStatus(v),
	},
	{
		id: "statusLineSegments",
		tab: "status",
		type: "submenu",
		label: "Configure segments",
		description: "Choose and arrange status line segments",
		get: () => "configure...",
		set: () => {},
		getOptions: () => [{ value: "open", label: "Open segment editor..." }],
	},
	{
		id: "statusLineModelThinking",
		tab: "status",
		type: "enum",
		label: "Model thinking level",
		description: "Show thinking level in the model segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().model?.showThinkingLevel;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("model", "showThinkingLevel");
			} else {
				sm.setStatusLineSegmentOption("model", "showThinkingLevel", v === "on");
			}
		},
	},
	{
		id: "statusLinePathAbbreviate",
		tab: "status",
		type: "enum",
		label: "Path abbreviate",
		description: "Use ~ and strip home prefix in path segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().path?.abbreviate;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("path", "abbreviate");
			} else {
				sm.setStatusLineSegmentOption("path", "abbreviate", v === "on");
			}
		},
	},
	{
		id: "statusLinePathMaxLength",
		tab: "status",
		type: "submenu",
		label: "Path max length",
		description: "Maximum length for displayed path",
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().path?.maxLength;
			return typeof value === "number" ? String(value) : "default";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("path", "maxLength");
			} else {
				sm.setStatusLineSegmentOption("path", "maxLength", Number.parseInt(v, 10));
			}
		},
		getOptions: () => [
			{ value: "default", label: "Preset default" },
			{ value: "20", label: "20" },
			{ value: "30", label: "30" },
			{ value: "40", label: "40" },
			{ value: "50", label: "50" },
			{ value: "60", label: "60" },
			{ value: "80", label: "80" },
		],
	},
	{
		id: "statusLinePathStripWorkPrefix",
		tab: "status",
		type: "enum",
		label: "Path strip /work",
		description: "Strip /work prefix in path segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().path?.stripWorkPrefix;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("path", "stripWorkPrefix");
			} else {
				sm.setStatusLineSegmentOption("path", "stripWorkPrefix", v === "on");
			}
		},
	},
	{
		id: "statusLineGitShowBranch",
		tab: "status",
		type: "enum",
		label: "Git show branch",
		description: "Show branch name in git segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().git?.showBranch;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("git", "showBranch");
			} else {
				sm.setStatusLineSegmentOption("git", "showBranch", v === "on");
			}
		},
	},
	{
		id: "statusLineGitShowStaged",
		tab: "status",
		type: "enum",
		label: "Git show staged",
		description: "Show staged file count in git segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().git?.showStaged;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("git", "showStaged");
			} else {
				sm.setStatusLineSegmentOption("git", "showStaged", v === "on");
			}
		},
	},
	{
		id: "statusLineGitShowUnstaged",
		tab: "status",
		type: "enum",
		label: "Git show unstaged",
		description: "Show unstaged file count in git segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().git?.showUnstaged;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("git", "showUnstaged");
			} else {
				sm.setStatusLineSegmentOption("git", "showUnstaged", v === "on");
			}
		},
	},
	{
		id: "statusLineGitShowUntracked",
		tab: "status",
		type: "enum",
		label: "Git show untracked",
		description: "Show untracked file count in git segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().git?.showUntracked;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("git", "showUntracked");
			} else {
				sm.setStatusLineSegmentOption("git", "showUntracked", v === "on");
			}
		},
	},
	{
		id: "statusLineTimeFormat",
		tab: "status",
		type: "enum",
		label: "Time format",
		description: "Clock segment time format",
		values: ["default", "12h", "24h"],
		get: (sm) => sm.getStatusLineSegmentOptions().time?.format ?? "default",
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("time", "format");
			} else {
				sm.setStatusLineSegmentOption("time", "format", v);
			}
		},
	},
	{
		id: "statusLineTimeShowSeconds",
		tab: "status",
		type: "enum",
		label: "Time show seconds",
		description: "Include seconds in clock segment",
		values: ["default", "on", "off"],
		get: (sm) => {
			const value = sm.getStatusLineSegmentOptions().time?.showSeconds;
			if (value === undefined) return "default";
			return value ? "on" : "off";
		},
		set: (sm, v) => {
			if (v === "default") {
				sm.clearStatusLineSegmentOption("time", "showSeconds");
			} else {
				sm.setStatusLineSegmentOption("time", "showSeconds", v === "on");
			}
		},
	},

	// ═══════════════════════════════════════════════════════════════════════════
	// LSP tab - LSP integration settings
	// ═══════════════════════════════════════════════════════════════════════════
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

	// ═══════════════════════════════════════════════════════════════════════════
	// Exa tab - Exa search tool settings
	// ═══════════════════════════════════════════════════════════════════════════
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
 * All settings. Discovery settings have been moved to /extensions dashboard.
 */
function getAllSettings(): SettingDef[] {
	return SETTINGS_DEFS;
}

/** Get settings for a specific tab */
export function getSettingsForTab(tab: string): SettingDef[] {
	return getAllSettings().filter((def) => def.tab === tab);
}

/** Get a setting definition by id */
export function getSettingDef(id: string): SettingDef | undefined {
	return getAllSettings().find((def) => def.id === id);
}
