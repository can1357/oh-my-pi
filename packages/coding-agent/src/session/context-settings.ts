import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import {
	type AgentCompactionThresholdOverride,
	validateModelCompactionThresholds,
} from "../config/compaction-threshold";
import { combine, register, type SettingValueOf } from "../config/registry";
import { COMPACTION_METHOD_CHOICES, DEFAULT_COMPACTION_METHOD_ORDER } from "./compaction-methods";
import { SHAPE_VARIANT_NAMES } from "@oh-my-pi/snapcompact";

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_MODEL_COMPACTION_THRESHOLDS: Record<string, AgentCompactionThresholdOverride> = {};

export const cfgWorkspaceAdditionalDirectories = register({
	id: "workspace.additionalDirectories",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "context",
		group: "General",
		label: __ompTranslate("Additional Workspace Dirs"),
		description:
			"Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them.",
	},
});

/** Built-in context filenames. Listing them in `contextFiles.extra` would load a second copy or bypass one-per-depth shadowing. */
const BUILTIN_CONTEXT_FILE_NAMES: Record<string, true> = {
	"agents.md": true,
	"claude.md": true,
	"gemini.md": true,
	"copilot-instructions.md": true,
};

/** Why `entry` is not a valid `contextFiles.extra` name; undefined for a plain, non-built-in file name. */
function contextFileNameError(entry: unknown): string | undefined {
	if (typeof entry !== "string")
		return __ompTranslate("contextFiles.extra entries must be strings ({0})", `${String(entry)}`);
	const name = entry.trim();
	if (name === "") return __ompTranslate("contextFiles.extra entries must not be empty");
	if (BUILTIN_CONTEXT_FILE_NAMES[name.toLowerCase()] === true) {
		return __ompTranslate("contextFiles.extra cannot list a built-in context file ({0})", `${name}`);
	}
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
		return __ompTranslate("contextFiles.extra entries must be file names, not paths ({0})", `${name}`);
	}
	return undefined;
}

/** Extra instruction filenames discovered in addition to AGENTS.md / CLAUDE.md / GEMINI.md. */
export const cfgContextFilesExtra = register({
	id: "contextFiles.extra",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "context",
		group: "General",
		label: __ompTranslate("Extra Context Files"),
		editor: "json",
		description:
			'Extra instruction filenames loaded beside AGENTS.md. Use a JSON list of names, not paths, e.g. ["AGENTS.local.md"]; [] disables extras. Start a new session to load them.',
		condition: "contextFilesExtraNotProject",
	},
	validate: raw => {
		if (raw === undefined) return;
		if (!Array.isArray(raw)) throw new Error(__ompTranslate("contextFiles.extra must be a list of file names"));
		for (const entry of raw) {
			const error = contextFileNameError(entry);
			if (error !== undefined) throw new Error(error);
		}
	},
});

// ────────────────────────────────────────────────────────────────────────
// Context
// ────────────────────────────────────────────────────────────────────────

// Context promotion
export const cfgContextPromotionEnabled = register({
	id: "contextPromotion.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "General",
		label: __ompTranslate("Auto-Promote Context"),
		description:
			"Promote to the model's contextPromotionTarget on context overflow instead of compacting. Retry fallback switches are controlled by Retry Model Fallback",
	},
});

// Opt in to advertised maximum context windows and premium long-context
// tiers. Off preserves default windows and caps premium models before
// requests cross into their higher pricing tier.
export const cfgExtendedContext = register({
	id: "extendedContext",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "General",
		label: __ompTranslate("Extended Context"),
		description:
			"Use larger context windows where supported; may incur premium pricing. Off keeps default or standard-pricing windows",
	},
});

// Compaction
export const cfgCompactionEnabled = register({
	id: "compaction.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Auto-Compact"),
		description: "Automatically compact context when it gets too large",
	},
});

export const cfgCompactionExperimentalContextManagement = register({
	id: "compaction.experimentalContextManagement",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Notes-backed context windows (experimental)"),
		description: "Keep persistent notes and searchable raw history across context windows.",
	},
});

export const cfgCompactionMidTurnEnabled = register({
	id: "compaction.midTurnEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Mid-Turn Compaction"),
		description:
			"Check thresholds at safe mid-turn tool-loop boundaries before the next provider request; subagents always check, since their whole assignment is one turn",
	},
});

export const cfgCompactionMethodOrder = register({
	id: "compaction.methodOrder",
	type: "array",
	default: [...DEFAULT_COMPACTION_METHOD_ORDER],
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Compaction Method Order"),
		description:
			"Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice",
		options: COMPACTION_METHOD_CHOICES,
		ordered: true,
	},
});

export const cfgCompactionThresholdPercent = register({
	id: "compaction.thresholdPercent",
	type: "number",
	default: -1,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Compaction Threshold"),
		description: "Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
		options: [
			{
				value: "default",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Legacy reserve-based threshold"),
			},
			{ value: "10", label: "10%", description: __ompTranslate("Extremely early maintenance") },
			{ value: "20", label: "20%", description: __ompTranslate("Very early maintenance") },
			{ value: "30", label: "30%", description: __ompTranslate("Early maintenance") },
			{ value: "40", label: "40%", description: __ompTranslate("Moderately early maintenance") },
			{ value: "50", label: "50%", description: __ompTranslate("Halfway point") },
			{ value: "60", label: "60%", description: __ompTranslate("Moderate context usage") },
			{ value: "70", label: "70%", description: __ompTranslate("Balanced") },
			{ value: "75", label: "75%", description: __ompTranslate("Slightly aggressive") },
			{ value: "80", label: "80%", description: __ompTranslate("Typical threshold") },
			{ value: "85", label: "85%", description: __ompTranslate("Aggressive context usage") },
			{ value: "90", label: "90%", description: __ompTranslate("Very aggressive") },
			{ value: "95", label: "95%", description: __ompTranslate("Near context limit") },
		],
	},
});

export const cfgCompactionThresholdTokens = register({
	id: "compaction.thresholdTokens",
	type: "number",
	default: -1,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Compaction Token Limit"),
		description: "Fixed token limit for context maintenance; overrides percentage if set",
		options: [
			{
				value: "default",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Use percentage-based threshold"),
			},
			{ value: "25000", label: __ompTranslate("25K tokens"), description: __ompTranslate("1/8 of a 200K window") },
			{ value: "50000", label: __ompTranslate("50K tokens"), description: __ompTranslate("1/4 of a 200K window") },
			{ value: "100000", label: __ompTranslate("100K tokens"), description: __ompTranslate("1/2 of a 200K window") },
			{ value: "150000", label: __ompTranslate("150K tokens"), description: __ompTranslate("3/4 of a 200K window") },
			{
				value: "200000",
				label: __ompTranslate("200K tokens"),
				description: __ompTranslate("Full standard context window"),
			},
			{ value: "300000", label: __ompTranslate("300K tokens"), description: __ompTranslate("Large context window") },
			{
				value: "500000",
				label: __ompTranslate("500K tokens"),
				description: __ompTranslate("Very large context window"),
			},
		],
	},
});

/**
 * Per-model compaction limits for the models they match: `provider/model-id`
 * exactly, else the longest `…*` prefix. A token entry is the base the
 * threshold policy scales in place of the window (see
 * `applyModelCompactionThreshold`); a percentage entry replaces both
 * `compaction.threshold*` fields. Edited from the /models hub; a per-agent
 * `task.agentCompactionThresholdOverrides` entry still wins. A token base past a
 * model's standard window opts that model into its extended window
 * (`ModelRegistry.contextWindowTiers`).
 */
export const cfgCompactionModelThresholds = register({
	id: "compaction.modelThresholds",
	type: "record",
	default: EMPTY_MODEL_COMPACTION_THRESHOLDS,
	validate: validateModelCompactionThresholds,
});

/**
 * Whether `compaction.modelThresholds` applies. Subagent spawn turns it off for an
 * agent whose `task.agentCompactionThresholdOverrides` entry applies, so that entry
 * outranks every model entry, including ones added while the agent runs.
 */
export const cfgCompactionModelThresholdsEnabled = register({
	id: "compaction.modelThresholdsEnabled",
	type: "boolean",
	default: true,
});

export const cfgCompactionHandoffSaveToDisk = register({
	id: "compaction.handoffSaveToDisk",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Save Handoff Docs"),
		description: "Save generated handoff documents to markdown files for the auto-handoff flow",
	},
});

export const cfgCompactionRemoteStreamingV2Enabled = register({
	id: "compaction.remoteStreamingV2Enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Remote Compaction V2"),
		description: "Use Responses streaming compaction for compatible remote compaction models",
	},
});

export const cfgCompactionAsyncEnabled = register({
	id: "compaction.asyncEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Async Compaction"),
		description:
			"Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed",
	},
});

// No default: an unset reserve tells the compaction layer the user never
// chose one, so small-window recovery may swap in the proportional reserve
// (see resolveBudgetReserveTokens). A materialized 16384 here would make
// every session look explicitly configured.
export const cfgCompactionReserveTokens = register({
	id: "compaction.reserveTokens",
	type: "number",
	default: undefined,
});

export const cfgCompactionKeepRecentTokens = register({
	id: "compaction.keepRecentTokens",
	type: "number",
	default: 20000,
});

export const cfgCompactionAutoContinue = register({ id: "compaction.autoContinue", type: "boolean", default: true });

export const cfgCompactionRemoteEndpoint = register({
	id: "compaction.remoteEndpoint",
	type: "string",
	default: undefined,
});

export const cfgCompactionV2RetainedMessageBudget = register({
	id: "compaction.v2RetainedMessageBudget",
	type: "number",
	default: 64000,
});

// Idle compaction
export const cfgCompactionIdleEnabled = register({
	id: "compaction.idleEnabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Idle Compaction"),
		description: "Compact context while idle when token count exceeds threshold",
	},
});

export const cfgCompactionIdleThresholdTokens = register({
	id: "compaction.idleThresholdTokens",
	type: "number",
	default: 200000,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Idle Compaction Threshold"),
		description: "Token count above which idle compaction triggers",
		options: [
			{ value: "100000", label: __ompTranslate("100K tokens") },
			{ value: "200000", label: __ompTranslate("200K tokens") },
			{ value: "300000", label: __ompTranslate("300K tokens") },
			{ value: "400000", label: __ompTranslate("400K tokens") },
			{ value: "500000", label: __ompTranslate("500K tokens") },
			{ value: "600000", label: __ompTranslate("600K tokens") },
			{ value: "700000", label: __ompTranslate("700K tokens") },
			{ value: "800000", label: __ompTranslate("800K tokens") },
			{ value: "900000", label: __ompTranslate("900K tokens") },
		],
	},
});

export const cfgCompactionIdleTimeoutSeconds = register({
	id: "compaction.idleTimeoutSeconds",
	type: "number",
	default: 300,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Idle Compaction Delay"),
		description:
			"Seconds to wait while idle before compacting; with a 1-hour prompt cache, compaction instead runs just before the cache expires",
		options: [
			{ value: "60", label: __ompTranslate("1 minute") },
			{ value: "120", label: __ompTranslate("2 minutes") },
			{ value: "300", label: __ompTranslate("5 minutes") },
			{ value: "600", label: __ompTranslate("10 minutes") },
			{ value: "1800", label: __ompTranslate("30 minutes") },
			{ value: "3600", label: __ompTranslate("1 hour") },
		],
	},
});

export const cfgCompactionSupersedeReads = register({
	id: "compaction.supersedeReads",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Supersede Stale Reads"),
		description: "Prune older read results when the same file is read again (cache-aware, runs every turn)",
	},
});

export const cfgCompactionDropUseless = register({
	id: "compaction.dropUseless",
	type: "boolean",
	default: true,
	ui: {
		tab: "context",
		group: "Compaction",
		label: __ompTranslate("Elide Uneventful Results"),
		description:
			"Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)",
	},
});

/** Every `compaction.*` setting as one memoized snapshot (the configured compaction policy). */
export const cfgCompaction = combine({
	enabled: cfgCompactionEnabled,
	experimentalContextManagement: cfgCompactionExperimentalContextManagement,
	methodOrder: cfgCompactionMethodOrder,
	thresholdPercent: cfgCompactionThresholdPercent,
	thresholdTokens: cfgCompactionThresholdTokens,
	reserveTokens: cfgCompactionReserveTokens,
	keepRecentTokens: cfgCompactionKeepRecentTokens,
	midTurnEnabled: cfgCompactionMidTurnEnabled,
	asyncEnabled: cfgCompactionAsyncEnabled,
	handoffSaveToDisk: cfgCompactionHandoffSaveToDisk,
	autoContinue: cfgCompactionAutoContinue,
	remoteEndpoint: cfgCompactionRemoteEndpoint,
	remoteStreamingV2Enabled: cfgCompactionRemoteStreamingV2Enabled,
	v2RetainedMessageBudget: cfgCompactionV2RetainedMessageBudget,
	idleEnabled: cfgCompactionIdleEnabled,
	idleThresholdTokens: cfgCompactionIdleThresholdTokens,
	idleTimeoutSeconds: cfgCompactionIdleTimeoutSeconds,
	supersedeReads: cfgCompactionSupersedeReads,
	dropUseless: cfgCompactionDropUseless,
});

/**
 * Configured compaction policy ({@link cfgCompaction}). `baseWindowTokens` is
 * never configured directly: a `compaction.modelThresholds` token entry sets it
 * for its model (see `applyModelCompactionThreshold`).
 */
export type CompactionSettings = SettingValueOf<typeof cfgCompaction> & { baseWindowTokens?: number };

// Experimental: snapcompact inline imaging (transient, per-request; never persisted)
export const cfgSnapcompactSystemPrompt = register({
	id: "snapcompact.systemPrompt",
	type: "enum",
	values: ["none", "agents-md", "all"] as const,
	default: "none",
	ui: {
		tab: "context",
		group: "Experimental",
		label: __ompTranslate("Snapcompact System Prompt"),
		description:
			"Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text.",
		options: [
			{
				value: "none",
				label: __ompTranslate("None"),
				description: __ompTranslate("Keep the system prompt as text."),
			},
			{
				value: "agents-md",
				label: "AGENTS.md",
				description: __ompTranslate(
					"Only move loaded context-file instructions to images, when that saves tokens.",
				),
			},
			{
				value: "all",
				label: __ompTranslate("All"),
				description: __ompTranslate("Move the full system prompt to images, when that saves tokens."),
			},
		],
	},
});

export const cfgSnapcompactToolResults = register({
	id: "snapcompact.toolResults",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "Experimental",
		label: __ompTranslate("Snapcompact Tool Results"),
		description:
			"Experimental: render large tool results, the newest one included, as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated search and command output; read results stay text unless the model is known to edit exactly from images.",
	},
});

export const cfgToolsFormat = register({
	id: "tools.format",
	type: "enum",
	values: [
		"auto",
		"native",
		"glm",
		"hermes",
		"kimi",
		"xml",
		"anthropic",
		"deepseek",
		"harmony",
		"qwen3",
		"gemini",
		"gemma",
		"minimax",
	] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "Experimental",
		label: __ompTranslate("Tool Calling Mode"),
		description:
			"Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect.",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Use native tool calls unless the model is known not to support them."),
			},
			{
				value: "native",
				label: __ompTranslate("Native"),
				description: __ompTranslate("Use provider-native tool calls."),
			},
			{ value: "glm", label: "GLM", description: __ompTranslate("Use GLM-style in-band tool calls.") },
			{ value: "hermes", label: "Hermes", description: __ompTranslate("Use Hermes-style in-band tool calls.") },
			{ value: "kimi", label: "Kimi", description: __ompTranslate("Use Kimi-style in-band tool calls.") },
			{ value: "xml", label: "XML", description: __ompTranslate("Use generic XML in-band tool calls.") },
			{
				value: "anthropic",
				label: "Anthropic",
				description: __ompTranslate("Use Anthropic-style in-band tool calls."),
			},
			{
				value: "deepseek",
				label: "DeepSeek",
				description: __ompTranslate("Use DeepSeek-style in-band tool calls."),
			},
			{ value: "harmony", label: "Harmony", description: __ompTranslate("Use Harmony-style in-band tool calls.") },
			{ value: "qwen3", label: "Qwen3", description: __ompTranslate("Use the Qwen3 owned dialect.") },
			{ value: "gemini", label: "Gemini", description: __ompTranslate("Use the Gemini owned dialect.") },
			{ value: "gemma", label: "Gemma", description: __ompTranslate("Use the Gemma owned dialect.") },
			{ value: "minimax", label: "MiniMax", description: __ompTranslate("Use the MiniMax owned dialect.") },
		],
	},
});

export const cfgSnapcompactShape = register({
	id: "snapcompact.shape",
	type: "enum",
	values: ["auto", ...SHAPE_VARIANT_NAMES] as const,
	default: "auto",
	ui: {
		tab: "context",
		group: "Experimental",
		label: __ompTranslate("Snapcompact Shape"),
		description:
			"Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model.",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate(
					"Picks a shape tuned for the current model, falling back to its provider family.",
				),
			},
			{
				value: "8x8r-bw",
				label: __ompTranslate("8x8 repeated, black"),
				description: __ompTranslate(
					"unscii square cell, black ink, every line printed twice with the copy on a pale highlight band.",
				),
			},
			{
				value: "8x8r-sent",
				label: __ompTranslate("8x8 repeated, sentence hues"),
				description: __ompTranslate("Repeated grid with ink cycling six hues at sentence boundaries."),
			},
			{
				value: "8x8u-bw",
				label: __ompTranslate("8x8, black"),
				description: __ompTranslate("Plain unscii square cell, single-printed lines, black ink."),
			},
			{
				value: "8x8u-sent",
				label: __ompTranslate("8x8, sentence hues"),
				description: __ompTranslate("Plain unscii square cell with sentence-hue ink."),
			},
			{
				value: "6x6u-bw",
				label: __ompTranslate("6x6 dense, black"),
				description: __ompTranslate(
					"unscii squeezed to 6x6 — densest readable cell, fewest frames — in black ink.",
				),
			},
			{
				value: "6x6u-sent",
				label: __ompTranslate("6x6 dense, sentence hues"),
				description: __ompTranslate("Densest cell with sentence-hue ink."),
			},
			{
				value: "5x8-bw",
				label: __ompTranslate("5x8 legacy, black"),
				description: __ompTranslate("Original X.org 5x8 glyphs on the 2576px frame, black ink."),
			},
			{
				value: "5x8-sent",
				label: __ompTranslate("5x8 legacy, sentence hues"),
				description: __ompTranslate("The original snapcompact shape (pre-shape-table sessions rendered this)."),
			},
			{
				value: "6x12-dim",
				label: __ompTranslate("6x12, dimmed stopwords"),
				description: __ompTranslate("X.org 6x12 glyphs, black ink, function words dimmed gray."),
			},
			{
				value: "8x13-bw",
				label: __ompTranslate("8x13, black"),
				description: __ompTranslate("X.org 8x13 glyphs, black ink."),
			},
			{
				value: "8on16-bw",
				label: __ompTranslate("8x13 on 16px pitch, black"),
				description: __ompTranslate("8x13 glyphs on an 8x16 cell (extra leading), black ink."),
			},
			{
				value: "8on22-bw",
				label: __ompTranslate("8x13 on 22px pitch (leading), black"),
				description: __ompTranslate(
					"8x13 glyphs on an 8x22 cell — extra line spacing so rows don't crowd. Default for OpenAI/Google.",
				),
			},
			{
				value: "11on16-bw",
				label: __ompTranslate("8x13 on 11px advance (tracking), black"),
				description: __ompTranslate(
					"8x13 glyphs on an 11x16 cell — extra letter spacing so characters don't merge. Default for Anthropic.",
				),
			},
			{
				value: "silver16-bw",
				label: "Silver 16, CJK",
				description: __ompTranslate(
					"Embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text.",
				),
			},
			{
				value: "doc-8on16-bw",
				label: __ompTranslate("Doc 8on16, black"),
				description: __ompTranslate(
					"Two word-wrapped newspaper columns of 8x13 glyphs on a 16px pitch, black ink.",
				),
			},
			{
				value: "doc-8on16-sent",
				label: __ompTranslate("Doc 8on16, sentence hues"),
				description: __ompTranslate("Two-column doc layout with sentence-hue ink."),
			},
			{
				value: "doc-8on16-sent-dim",
				label: __ompTranslate("Doc 8on16, sentence hues + dimmed stopwords"),
				description: __ompTranslate("Two-column doc layout, sentence-hue ink, function words dimmed gray."),
			},
		],
	},
});

// Branch summaries
export const cfgBranchSummaryEnabled = register({
	id: "branchSummary.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "context",
		group: "General",
		label: __ompTranslate("Branch Summaries"),
		description: "Prompt to summarize when leaving a branch",
	},
});

export const cfgBranchSummaryReserveTokens = register({
	id: "branchSummary.reserveTokens",
	type: "number",
	default: 16384,
});
