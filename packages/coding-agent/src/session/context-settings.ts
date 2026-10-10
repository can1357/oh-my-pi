import {
	type AgentCompactionThresholdOverride,
	validateModelCompactionThresholds,
} from "../config/compaction-threshold";
import { combine, register, type SettingValueOf } from "../config/registry";
import { COMPACTION_METHOD_CHOICES, DEFAULT_COMPACTION_METHOD_ORDER } from "./compaction-methods";
import { FRAME_DATA_BYTES_BUDGET, SHAPE_VARIANT_NAMES } from "@oh-my-pi/snapcompact";

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_MODEL_COMPACTION_THRESHOLDS: Record<string, AgentCompactionThresholdOverride> = {};

export const cfgWorkspaceAdditionalDirectories = register({
	id: "workspace.additionalDirectories",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "context",
		group: "General",
		label: "Additional Workspace Dirs",
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
	if (typeof entry !== "string") return `contextFiles.extra entries must be strings (${String(entry)})`;
	const name = entry.trim();
	if (name === "") return "contextFiles.extra entries must not be empty";
	if (BUILTIN_CONTEXT_FILE_NAMES[name.toLowerCase()] === true) {
		return `contextFiles.extra cannot list a built-in context file (${name})`;
	}
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
		return `contextFiles.extra entries must be file names, not paths (${name})`;
	}
	return undefined;
}

/**
 * Extra instruction filenames discovered in addition to AGENTS.md / CLAUDE.md / GEMINI.md.
 * Config-file only: the names are open-ended, so there is no settings-panel vocabulary.
 */
export const cfgContextFilesExtra = register({
	id: "contextFiles.extra",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	validate: raw => {
		if (raw === undefined) return;
		if (!Array.isArray(raw)) throw new Error("contextFiles.extra must be a list of file names");
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
		label: "Auto-Promote Context",
		description: "Promote to a larger-context model on context overflow instead of compacting",
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
		label: "Extended Context",
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
		label: "Auto-Compact",
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
		label: "Notes-backed context windows (experimental)",
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
		label: "Mid-Turn Compaction",
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
		label: "Compaction Method Order",
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
		label: "Compaction Threshold",
		description: "Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
		options: [
			{ value: "default", label: "Default", description: "Legacy reserve-based threshold" },
			{ value: "10", label: "10%", description: "Extremely early maintenance" },
			{ value: "20", label: "20%", description: "Very early maintenance" },
			{ value: "30", label: "30%", description: "Early maintenance" },
			{ value: "40", label: "40%", description: "Moderately early maintenance" },
			{ value: "50", label: "50%", description: "Halfway point" },
			{ value: "60", label: "60%", description: "Moderate context usage" },
			{ value: "70", label: "70%", description: "Balanced" },
			{ value: "75", label: "75%", description: "Slightly aggressive" },
			{ value: "80", label: "80%", description: "Typical threshold" },
			{ value: "85", label: "85%", description: "Aggressive context usage" },
			{ value: "90", label: "90%", description: "Very aggressive" },
			{ value: "95", label: "95%", description: "Near context limit" },
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
		label: "Compaction Token Limit",
		description: "Fixed token limit for context maintenance; overrides percentage if set",
		options: [
			{ value: "default", label: "Default", description: "Use percentage-based threshold" },
			{ value: "25000", label: "25K tokens", description: "1/8 of a 200K window" },
			{ value: "50000", label: "50K tokens", description: "1/4 of a 200K window" },
			{ value: "100000", label: "100K tokens", description: "1/2 of a 200K window" },
			{ value: "150000", label: "150K tokens", description: "3/4 of a 200K window" },
			{ value: "200000", label: "200K tokens", description: "Full standard context window" },
			{ value: "300000", label: "300K tokens", description: "Large context window" },
			{ value: "500000", label: "500K tokens", description: "Very large context window" },
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
		label: "Save Handoff Docs",
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
		label: "Remote Compaction V2",
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
		label: "Async Compaction",
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
		label: "Idle Compaction",
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
		label: "Idle Compaction Threshold",
		description: "Token count above which idle compaction triggers",
		options: [
			{ value: "100000", label: "100K tokens" },
			{ value: "200000", label: "200K tokens" },
			{ value: "300000", label: "300K tokens" },
			{ value: "400000", label: "400K tokens" },
			{ value: "500000", label: "500K tokens" },
			{ value: "600000", label: "600K tokens" },
			{ value: "700000", label: "700K tokens" },
			{ value: "800000", label: "800K tokens" },
			{ value: "900000", label: "900K tokens" },
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
		label: "Idle Compaction Delay",
		description: "Seconds to wait while idle before compacting",
		options: [
			{ value: "60", label: "1 minute" },
			{ value: "120", label: "2 minutes" },
			{ value: "300", label: "5 minutes" },
			{ value: "600", label: "10 minutes" },
			{ value: "1800", label: "30 minutes" },
			{ value: "3600", label: "1 hour" },
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
		label: "Supersede Stale Reads",
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
		label: "Elide Uneventful Results",
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
		label: "Snapcompact System Prompt",
		description:
			"Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text.",
		options: [
			{ value: "none", label: "None", description: "Keep the system prompt as text." },
			{
				value: "agents-md",
				label: "AGENTS.md",
				description: "Only move loaded context-file instructions to images, when that saves tokens.",
			},
			{
				value: "all",
				label: "All",
				description: "Move the full system prompt to images, when that saves tokens.",
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
		label: "Snapcompact Tool Results",
		description:
			"Experimental: render large historical tool results as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated read/search output.",
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
		label: "Tool Calling Mode",
		description:
			"Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect.",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "Use native tool calls unless the model is known not to support them.",
			},
			{ value: "native", label: "Native", description: "Use provider-native tool calls." },
			{ value: "glm", label: "GLM", description: "Use GLM-style in-band tool calls." },
			{ value: "hermes", label: "Hermes", description: "Use Hermes-style in-band tool calls." },
			{ value: "kimi", label: "Kimi", description: "Use Kimi-style in-band tool calls." },
			{ value: "xml", label: "XML", description: "Use generic XML in-band tool calls." },
			{ value: "anthropic", label: "Anthropic", description: "Use Anthropic-style in-band tool calls." },
			{ value: "deepseek", label: "DeepSeek", description: "Use DeepSeek-style in-band tool calls." },
			{ value: "harmony", label: "Harmony", description: "Use Harmony-style in-band tool calls." },
			{ value: "qwen3", label: "Qwen3", description: "Use the Qwen3 owned dialect." },
			{ value: "gemini", label: "Gemini", description: "Use the Gemini owned dialect." },
			{ value: "gemma", label: "Gemma", description: "Use the Gemma owned dialect." },
			{ value: "minimax", label: "MiniMax", description: "Use the MiniMax owned dialect." },
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
		label: "Snapcompact Shape",
		description:
			"Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model.",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "Picks a shape tuned for the current model, falling back to its provider family.",
			},
			{
				value: "8x8r-bw",
				label: "8x8 repeated, black",
				description:
					"unscii square cell, black ink, every line printed twice with the copy on a pale highlight band.",
			},
			{
				value: "8x8r-sent",
				label: "8x8 repeated, sentence hues",
				description: "Repeated grid with ink cycling six hues at sentence boundaries.",
			},
			{
				value: "8x8u-bw",
				label: "8x8, black",
				description: "Plain unscii square cell, single-printed lines, black ink.",
			},
			{
				value: "8x8u-sent",
				label: "8x8, sentence hues",
				description: "Plain unscii square cell with sentence-hue ink.",
			},
			{
				value: "6x6u-bw",
				label: "6x6 dense, black",
				description: "unscii squeezed to 6x6 — densest readable cell, fewest frames — in black ink.",
			},
			{
				value: "6x6u-sent",
				label: "6x6 dense, sentence hues",
				description: "Densest cell with sentence-hue ink.",
			},
			{
				value: "5x8-bw",
				label: "5x8 legacy, black",
				description: "Original X.org 5x8 glyphs on the 2576px frame, black ink.",
			},
			{
				value: "5x8-sent",
				label: "5x8 legacy, sentence hues",
				description: "The original snapcompact shape (pre-shape-table sessions rendered this).",
			},
			{
				value: "6x12-dim",
				label: "6x12, dimmed stopwords",
				description: "X.org 6x12 glyphs, black ink, function words dimmed gray.",
			},
			{
				value: "8x13-bw",
				label: "8x13, black",
				description: "X.org 8x13 glyphs, black ink.",
			},
			{
				value: "8on16-bw",
				label: "8x13 on 16px pitch, black",
				description: "8x13 glyphs on an 8x16 cell (extra leading), black ink.",
			},
			{
				value: "8on22-bw",
				label: "8x13 on 22px pitch (leading), black",
				description:
					"8x13 glyphs on an 8x22 cell — extra line spacing so rows don't crowd. Default for OpenAI/Google.",
			},
			{
				value: "11on16-bw",
				label: "8x13 on 11px advance (tracking), black",
				description:
					"8x13 glyphs on an 11x16 cell — extra letter spacing so characters don't merge. Default for Anthropic.",
			},
			{
				value: "silver16-bw",
				label: "Silver 16, CJK",
				description: "Embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text.",
			},
			{
				value: "doc-8on16-bw",
				label: "Doc 8on16, black",
				description: "Two word-wrapped newspaper columns of 8x13 glyphs on a 16px pitch, black ink.",
			},
			{
				value: "doc-8on16-sent",
				label: "Doc 8on16, sentence hues",
				description: "Two-column doc layout with sentence-hue ink.",
			},
			{
				value: "doc-8on16-sent-dim",
				label: "Doc 8on16, sentence hues + dimmed stopwords",
				description: "Two-column doc layout, sentence-hue ink, function words dimmed gray.",
			},
		],
	},
});

export const cfgSnapcompactFrameBytesBudget = register({
	id: "snapcompact.frameBytesBudget",
	type: "number",
	default: FRAME_DATA_BYTES_BUDGET,
	ui: {
		tab: "context",
		group: "Experimental",
		label: "Snapcompact Frame Bytes",
		description:
			"Maximum base64 bytes of snapcompact archive frames attached to one request. Raise it only when every gateway and provider on the route accepts the larger request body.",
		options: [
			{ value: "3000000", label: "3 MB", description: "Default" },
			{ value: "8000000", label: "8 MB", description: "About 2.5× the default frame payload" },
			{ value: "16000000", label: "16 MB", description: "Large payloads; check gateway body limits" },
			{ value: "32000000", label: "32 MB", description: "At the request-size limit of some providers" },
		],
	},
});

export const cfgSnapcompactMaxFrames = register({
	id: "snapcompact.maxFrames",
	type: "number",
	default: 0,
	ui: {
		tab: "context",
		group: "Experimental",
		label: "Snapcompact Max Frames",
		description:
			"Archive frame cap. 0 uses the provider's image budget (5 for unrecognized providers). A positive value replaces that cap (at most 80) and raises the provider's per-request image limit to at least that value. User and tool images share that limit; a request over it drops its oldest images first, archive frames included.",
		options: [
			{ value: "0", label: "Auto", description: "Provider image budget" },
			{ value: "10", label: "10 frames" },
			{ value: "20", label: "20 frames" },
			{ value: "40", label: "40 frames" },
			{ value: "80", label: "80 frames", description: "Snapcompact maximum" },
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
		label: "Branch Summaries",
		description: "Prompt to summarize when leaving a branch",
	},
});

export const cfgBranchSummaryReserveTokens = register({
	id: "branchSummary.reserveTokens",
	type: "number",
	default: 16384,
});
