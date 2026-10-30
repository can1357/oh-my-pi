import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { combine, effect, register, type SettingValueOf } from "../config/registry";
import {
	SERVICE_TIER_ANTHROPIC_OPTIONS,
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_OPTIONS,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "../config/service-tier";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../tiny/dtype";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, MAX_WEB_SEARCH_TIMEOUT_SECONDS } from "../web/search/types";
import { DEFAULT_USAGE_RESERVE_PCT } from "@oh-my-pi/pi-ai/auth-storage";
import { configureProviderStoreResponses } from "@oh-my-pi/pi-ai/providers/openai-responses-state";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata, getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";

const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const EMPTY_STRING_ARRAYS_RECORD: Record<string, string[]> = {};
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["wait"];

/** Scope of the resume picker's current-folder list. */
export const cfgSessionWorktreeScope = register({
	id: "session.worktreeScope",
	type: "enum",
	values: ["directory", "repo"] as const,
	default: "repo",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Resume Worktree Scope",
		description:
			"Choose whether the resume picker's current folder includes sessions from other repository worktrees",
		options: [
			{ value: "directory", label: "This Directory", description: "Only sessions saved for this directory" },
			{ value: "repo", label: "Repository Worktrees", description: "Also include sessions from sibling worktrees" },
		],
	},
});

// Power assertions: macOS IOKit, Linux login1/ScreenSaver, Windows execution state.
export const cfgPowerSleepPrevention = register({
	id: "power.sleepPrevention",
	type: "enum",
	values: ["off", "idle", "display", "system"] as const,
	default: "idle",
	ui: {
		tab: "interaction",
		group: "Power",
		label: __ompTranslate("Sleep Prevention"),
		description:
			"Prevent the system sleeping while the agent is running a turn; an idle session, including one waiting on background jobs, does not hold it. Each level is cumulative — it adds the flags of all lower levels.",
		options: [
			{
				value: "off",
				label: __ompTranslate("Off"),
				description: __ompTranslate("Do not prevent any sleep"),
			},
			{
				value: "idle",
				label: __ompTranslate("Prevent Idle Sleep"),
				description: __ompTranslate(
					"Keep the system awake while the agent is running a turn (macOS `caffeinate -i`)",
				),
			},
			{
				value: "display",
				label: __ompTranslate("Prevent Display Sleep"),
				description: __ompTranslate("Also keep the display from idle-sleeping (macOS `caffeinate -i -d`)"),
			},
			{
				value: "system",
				label: __ompTranslate("Prevent System Sleep"),
				description: __ompTranslate(
					"Also block all system sleep on AC and declare the user active (macOS `caffeinate -i -d -s -u`)",
				),
			},
		],
	},
});

export const cfgPrewalkEnabled = register({
	id: "prewalk.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prewalk",
		label: __ompTranslate("Enable Prewalk"),
		description:
			"Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.",
	},
});

export const cfgPrewalkFrom = register({
	id: "prewalk.from",
	type: "string",
	default: "@default",
	ui: {
		tab: "model",
		group: "Prewalk",
		label: "Prewalk planning model",
		description: "Model or role (default '@default') that /prewalk restart returns to for planning.",
	},
});

export const cfgPrewalkInto = register({
	id: "prewalk.into",
	type: "string",
	default: "@smol",
	ui: {
		tab: "model",
		group: "Prewalk",
		label: "Prewalk target",
		description:
			"Model or role (default '@smol') that prewalk hands off to at the first edit/write: /prewalk, /prewalk restart, Enable Prewalk, and --prewalk. Auto-prewalk uses its own target.",
	},
});

export const cfgPrewalkAuto = register({
	id: "prewalk.auto",
	type: "enum",
	values: ["off", "suggest", "on"] as const,
	default: "off",
	ui: {
		tab: "model",
		group: "Prewalk",
		label: __ompTranslate("Auto Prewalk"),
		description:
			"Ask the native judge resolved through the 'judge' role whether each new top-level user task front-loads its hard reasoning. Needs a native judge; without one nothing is classified. Independent of Enable Prewalk.",
		options: [
			{
				value: "off",
				label: __ompTranslate("Off"),
				description: __ompTranslate("Never classify prompts for prewalk"),
			},
			{
				value: "suggest",
				label: __ompTranslate("Suggest"),
				description: __ompTranslate("Classify each task and report the decision without arming prewalk"),
			},
			{
				value: "on",
				label: __ompTranslate("On"),
				description: __ompTranslate(
					"For confidently front-loaded tasks, arm a handoff from the active model to the auto target; the next task starts back on the planning model",
				),
			},
		],
	},
});

export const cfgPrewalkAutoTarget = register({
	id: "prewalk.autoTarget",
	type: "string",
	default: "@smol",
	ui: {
		tab: "model",
		group: "Prewalk",
		label: __ompTranslate("Auto-prewalk target"),
		description: "Model or role (default '@smol') auto-prewalk hands off to at the first edit/write.",
	},
});

function isLimitRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveLimit(limit: unknown): limit is number {
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

/** Per-provider request limits floored to whole numbers ≥ 1; non-positive or non-numeric entries are dropped. */
export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	const normalized: Record<string, number> = {};
	if (!isLimitRecord(value)) return normalized;
	for (const provider in value) {
		const limit = value[provider];
		if (isPositiveLimit(limit)) normalized[provider] = Math.max(1, Math.floor(limit));
	}
	return normalized;
}

/**
 * Per-provider request limits floored to whole numbers ≥ 1.
 *
 * @throws Error naming every provider whose limit is not a positive number.
 */
export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (isLimitRecord(value)) {
		const invalidProviders: string[] = [];
		for (const provider in value) if (!isPositiveLimit(value[provider])) invalidProviders.push(provider);
		if (invalidProviders.length > 0) {
			throw new Error(
				__ompTranslate("Provider request limits must be positive numbers: {0}", `${invalidProviders.join(", ")}`),
			);
		}
	}
	return normalizeProviderMaxInFlightRequests(value);
}

export const cfgProvidersMaxInFlightRequests = register({
	id: "providers.maxInFlightRequests",
	type: "record",
	default: EMPTY_NUMBER_RECORD,
	validate: validateProviderMaxInFlightRequests,
	normalize: validateProviderMaxInFlightRequests,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Max In-Flight Requests"),
		description:
			'Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local OMP processes with this config root. Omitted providers are unlimited.',
	},
});
effect(cfgProvidersMaxInFlightRequests, limits =>
	configureProviderMaxInFlightRequests(normalizeProviderMaxInFlightRequests(limits)),
);

export const cfgImagesDescribeForTextModels = register({
	id: "images.describeForTextModels",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Vision",
		label: __ompTranslate("Describe Images for Text Models"),
		description:
			"When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Model
// ────────────────────────────────────────────────────────────────────────

// Reasoning and prompts
export const cfgDefaultThinkingLevel = register({
	id: "defaultThinkingLevel",
	type: "enum",
	values: [...THINKING_EFFORTS, AUTO_THINKING],
	default: "high",
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Thinking Level"),
		description: "Reasoning depth for thinking-capable models",
		options: [getConfiguredThinkingLevelMetadata(AUTO_THINKING), ...THINKING_EFFORTS.map(getThinkingLevelMetadata)],
	},
});

export const cfgHideThinkingBlock = register({
	id: "hideThinkingBlock",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Hide Thinking Blocks"),
		description: "Hide thinking blocks in assistant responses",
	},
});

export const cfgExpandThinkingBlocks = register({
	id: "expandThinkingBlocks",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Expand Thinking Blocks"),
		description: "Keep finished thinking blocks expanded instead of collapsing them when the turn ends",
		condition: "nativeRendering",
	},
});

export const cfgProseOnlyThinking = register({
	id: "proseOnlyThinking",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Prose Only Thinking"),
		description: "Omit code blocks from thinking summaries and replace them with an ellipsis",
	},
});

export const cfgOmitThinking = register({
	id: "omitThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Omit Thinking summaries"),
		description: "Instruct upstream providers to completely omit thinking summaries from responses (where supported)",
	},
});

export const cfgExternalThinking = register({
	id: "externalThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("External Thinking"),
		description: "Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning",
		warning: __ompTranslate(
			"At your own risk: providers have flagged this request shape as abuse, up to account-level enforcement",
		),
	},
});

export const cfgModelLoopGuardEnabled = register({
	id: "model.loopGuard.enabled",
	type: "boolean",
	default: true,
	// Kill switch shared with pi-ai's stream-level guard (`utils/thinking-loop.ts`); only `1` disables.
	env: { name: "PI_NO_THINKING_LOOP_GUARD", parse: raw => (raw === "1" ? false : undefined) },
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Loop Guard"),
		description: "Enable automatic stream loop detection for model reasoning and prose",
	},
});

export const cfgModelLoopGuardCheckAssistantContent = register({
	id: "model.loopGuard.checkAssistantContent",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Loop Guard Scan Prose"),
		description: "Apply loop guard to assistant prose messages in addition to thinking logs",
	},
});

export const cfgModelLoopGuardToolCallReminder = register({
	id: "model.loopGuard.toolCallReminder",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Loop Guard Tool-Call Reminder"),
		description:
			"When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)",
	},
});

export const cfgModelToolCallLoopGuardEnabled = register({
	id: "model.toolCallLoopGuard.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Tool-Call Loop Guard"),
		description: "Detect consecutive identical tool calls across turns and inject a corrective steer",
	},
});

export const cfgModelToolCallLoopGuardThreshold = register({
	id: "model.toolCallLoopGuard.threshold",
	type: "number",
	default: 5,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Tool-Call Loop Threshold"),
		description: "Consecutive identical tool calls required before the corrective steer is injected",
	},
});

export const cfgModelToolCallLoopGuardExemptTools = register({
	id: "model.toolCallLoopGuard.exemptTools",
	type: "array",
	default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Tool-Call Loop Exempt Tools"),
		description: "Tool names that may repeat consecutively without triggering the cross-turn loop guard",
	},
});

export const cfgInlineToolDescriptors = register({
	id: "inlineToolDescriptors",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "model",
		group: "Prompt",
		label: __ompTranslate("Inline Tool Descriptors"),
		description:
			"Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Inline descriptors for Gemini models; keep them in tool schemas otherwise"),
			},
			{
				value: "on",
				label: __ompTranslate("On"),
				description: __ompTranslate("Always inline descriptors in the system prompt"),
			},
			{
				value: "off",
				label: __ompTranslate("Off"),
				description: __ompTranslate("Keep descriptors in provider tool schemas only"),
			},
		],
	},
});

export const cfgIncludeModelInPrompt = register({
	id: "includeModelInPrompt",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: __ompTranslate("Include Model in Prompt"),
		description: "Surface the active model identifier in the system prompt so the agent knows which model it is",
	},
});

export const cfgIncludeWorkspaceTree = register({
	id: "includeWorkspaceTree",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prompt",
		label: __ompTranslate("Include Workspace Tree"),
		description:
			"Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.",
	},
});

export const cfgSkillful = register({
	id: "skillful",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: __ompTranslate("List Skills in Prompt"),
		description:
			"List available skills in the system prompt; disable to save context and toggle per-session with /skillful",
	},
});

/** Personality preset. */
export type Personality = SettingValueOf<typeof cfgPersonality>;

export const cfgPersonality = register({
	id: "personality",
	type: "enum",
	values: ["default", "friendly", "pragmatic", "none"] as const,
	default: "default",
	ui: {
		tab: "model",
		group: "Prompt",
		label: __ompTranslate("Personality"),
		description: "Communication style rendered into the system prompt's personality block",
		options: [
			{
				value: "default",
				label: __ompTranslate("Default"),
				description: __ompTranslate("Terse, evidence-first engineer; dense, action-oriented replies"),
			},
			{
				value: "friendly",
				label: __ompTranslate("Friendly"),
				description: __ompTranslate("Warm, encouraging collaborator focused on momentum and morale"),
			},
			{
				value: "pragmatic",
				label: __ompTranslate("Pragmatic"),
				description: __ompTranslate("Direct, efficient engineer focused on clarity and rigor"),
			},
			{
				value: "none",
				label: __ompTranslate("None"),
				description: __ompTranslate("Omit the personality block entirely"),
			},
		],
	},
});

// Sampling
export const cfgTemperature = register({
	id: "temperature",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Temperature"),
		description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Use provider default"),
			},
			{ value: "0", label: "0", description: __ompTranslate("Deterministic") },
			{ value: "0.2", label: "0.2", description: __ompTranslate("Focused") },
			{ value: "0.5", label: "0.5", description: __ompTranslate("Balanced") },
			{ value: "0.7", label: "0.7", description: __ompTranslate("Creative") },
			{ value: "1", label: "1", description: __ompTranslate("Maximum variety") },
		],
	},
});

export const cfgTopP = register({
	id: "topP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Top P"),
		description: "Nucleus sampling cutoff (0-1, -1 = provider default)",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Use provider default"),
			},
			{ value: "0.1", label: "0.1", description: __ompTranslate("Very focused") },
			{ value: "0.3", label: "0.3", description: __ompTranslate("Focused") },
			{ value: "0.5", label: "0.5", description: __ompTranslate("Balanced") },
			{ value: "0.9", label: "0.9", description: __ompTranslate("Broad") },
			{ value: "1", label: "1", description: __ompTranslate("No nucleus filtering") },
		],
	},
});

export const cfgTopK = register({
	id: "topK",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Top K"),
		description: "Sample from top-K tokens (-1 = provider default)",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Use provider default"),
			},
			{ value: "1", label: "1", description: __ompTranslate("Greedy top token") },
			{ value: "20", label: "20", description: __ompTranslate("Focused") },
			{ value: "40", label: "40", description: __ompTranslate("Balanced") },
			{ value: "100", label: "100", description: __ompTranslate("Broad") },
		],
	},
});

export const cfgMinP = register({
	id: "minP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Min P"),
		description: "Minimum probability threshold (0-1, -1 = provider default)",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Use provider default"),
			},
			{ value: "0.01", label: "0.01", description: __ompTranslate("Very permissive") },
			{ value: "0.05", label: "0.05", description: __ompTranslate("Balanced") },
			{ value: "0.1", label: "0.1", description: __ompTranslate("Strict") },
		],
	},
});

export const cfgPresencePenalty = register({
	id: "presencePenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Presence Penalty"),
		description: "Penalty for introducing already-present tokens (-1 = provider default)",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Use provider default"),
			},
			{ value: "0", label: "0", description: __ompTranslate("No penalty") },
			{ value: "0.5", label: "0.5", description: __ompTranslate("Mild novelty") },
			{ value: "1", label: "1", description: __ompTranslate("Encourage novelty") },
			{ value: "2", label: "2", description: __ompTranslate("Strong novelty") },
		],
	},
});

export const cfgRepetitionPenalty = register({
	id: "repetitionPenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Repetition Penalty"),
		description: "Penalty for repeated tokens (-1 = provider default)",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Use provider default"),
			},
			{ value: "0.8", label: "0.8", description: __ompTranslate("Allow repetition") },
			{ value: "1", label: "1", description: __ompTranslate("No penalty") },
			{ value: "1.1", label: "1.1", description: __ompTranslate("Mild penalty") },
			{ value: "1.2", label: "1.2", description: __ompTranslate("Balanced") },
			{ value: "1.5", label: "1.5", description: __ompTranslate("Strong penalty") },
		],
	},
});

const providerDefaultWhenNegative = (value: number): number | undefined => (value >= 0 ? value : undefined);

/** Agent sampling options; a negative sampling setting means "provider default" (`undefined`). */
export const cfgSampling = combine(
	{
		temperature: cfgTemperature,
		topP: cfgTopP,
		topK: cfgTopK,
		minP: cfgMinP,
		presencePenalty: cfgPresencePenalty,
		repetitionPenalty: cfgRepetitionPenalty,
		hideThinkingSummary: cfgOmitThinking,
	},
	values => ({
		temperature: providerDefaultWhenNegative(values.temperature),
		topP: providerDefaultWhenNegative(values.topP),
		topK: providerDefaultWhenNegative(values.topK),
		minP: providerDefaultWhenNegative(values.minP),
		presencePenalty: providerDefaultWhenNegative(values.presencePenalty),
		repetitionPenalty: providerDefaultWhenNegative(values.repetitionPenalty),
		hideThinkingSummary: values.hideThinkingSummary,
	}),
);

export const cfgTextVerbosity = register({
	id: "textVerbosity",
	type: "enum",
	values: ["low", "medium", "high"] as const,
	default: "medium",
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Text Verbosity"),
		description: "OpenAI Responses and Codex response verbosity (low, medium, or high)",
		options: [
			{ value: "low", label: __ompTranslate("Low"), description: __ompTranslate("Prefer concise responses") },
			{
				value: "medium",
				label: __ompTranslate("Medium"),
				description: __ompTranslate("Balance brevity and detail (default)"),
			},
			{ value: "high", label: __ompTranslate("High"), description: __ompTranslate("Prefer detailed responses") },
		],
	},
});

export const cfgTierOpenai = register({
	id: "tier.openai",
	type: "enum",
	values: SERVICE_TIER_OPENAI_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Service Tier — OpenAI"),
		description:
			"Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.",
		options: SERVICE_TIER_OPENAI_OPTIONS,
	},
});

export const cfgTierAnthropic = register({
	id: "tier.anthropic",
	type: "enum",
	values: SERVICE_TIER_ANTHROPIC_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Service Tier — Anthropic"),
		description:
			'Processing tier for Claude requests. `priority` realizes fast mode (`speed: "fast"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter.',
		options: SERVICE_TIER_ANTHROPIC_OPTIONS,
	},
});

export const cfgTierGoogle = register({
	id: "tier.google",
	type: "enum",
	values: SERVICE_TIER_GOOGLE_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Service Tier — Google"),
		description:
			"Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.",
		options: SERVICE_TIER_GOOGLE_OPTIONS,
	},
});

export const cfgTierSubagent = register({
	id: "tier.subagent",
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "inherit",
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Service Tier — Subagent"),
		description:
			"Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.",
		options: SERVICE_TIER_INHERIT_OPTIONS,
	},
});

export const cfgTierAdvisor = register({
	id: "tier.advisor",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: __ompTranslate("Service Tier — Advisor"),
		description:
			"Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.",
		options: SERVICE_TIER_INHERIT_OPTIONS,
		condition: "advisorEnabled",
	},
});

// Retries
export const cfgRetryEnabled = register({ id: "retry.enabled", type: "boolean", default: true });

export const cfgRetryMaxRetries = register({
	id: "retry.maxRetries",
	type: "number",
	default: 10,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Retry Attempts"),
		description: "Maximum retry attempts on API errors",
		options: [
			{ value: "1", label: __ompTranslate("1 retry") },
			{ value: "2", label: __ompTranslate("2 retries") },
			{ value: "3", label: __ompTranslate("3 retries") },
			{ value: "5", label: __ompTranslate("5 retries") },
			{ value: "10", label: __ompTranslate("10 retries") },
		],
	},
});

export const cfgRetryBaseDelayMs = register({ id: "retry.baseDelayMs", type: "number", default: 500 });

export const cfgRetryMaxDelayMs = register({
	id: "retry.maxDelayMs",
	type: "number",
	default: 5 * 60 * 1000,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Max Retry Delay"),
		description:
			"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows). 0 disables the ceiling — to let the session auto-resume through provider-stated quota resets.",
	},
});

export const cfgRetryWaitForUsageReset = register({
	id: "retry.waitForUsageReset",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Wait For Usage Reset"),
		get description() {
			return __ompTranslate(
				"When a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), sleep until the reset instead of failing fast past retry.maxDelayMs. Waits are abortable ({0}) but also hold subagents, so leave off for unattended runs.",
				`${formatKeyHint("escape")}`,
			);
		},
	},
});

export const cfgRetryModelFallback = register({
	id: "retry.modelFallback",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Retry Model Fallback"),
		description:
			"Allow retry recovery to switch to models in retry.fallbackChains after provider errors. Independent of Auto-Promote Context",
	},
});

export const cfgRetryFallbackOn = register({
	id: "retry.fallbackOn",
	type: "enum",
	values: ["any", "usage-limit", "except-usage-limit"] as const,
	default: "any",
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Fallback Trigger"),
		description: "Which failed requests may switch to a configured fallback model",
		options: [
			{
				value: "any",
				label: __ompTranslate("Any error"),
				description: __ompTranslate("Every provider error may switch models"),
			},
			{
				value: "usage-limit",
				label: __ompTranslate("Usage limits only"),
				description: __ompTranslate(
					"Switch only on a usage limit; retry other errors on the same model, then surface them",
				),
			},
			{
				value: "except-usage-limit",
				label: __ompTranslate("All but usage limits"),
				description: __ompTranslate("Wait out or surface a usage limit; switch on other errors"),
			},
		],
	},
});

export const cfgRetryRateLimitWalksChain = register({
	id: "retry.rateLimitWalksChain",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: "Rate Limit Walks Chain",
		description:
			"On a rate limit, do not hold the retry.fallbackChains walk for a turn whose thinking is signed by the failing model. Off (the default), such a turn keeps retrying the rate-limited model until retry.maxRetries is spent before the chain is reached.",
	},
});

export const cfgRetryUsageAwareFallback = register({
	id: "retry.usageAwareFallback",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Usage-Aware Fallback"),
		description:
			"Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.",
	},
});

export const cfgRetryUsageReservePct = register({
	id: "retry.usageReservePct",
	type: "number",
	default: DEFAULT_USAGE_RESERVE_PCT,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Reserve Margin"),
		description:
			"Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.",
		condition: "usageAwareFallbackEnabled",
		options: [
			{ value: "5", label: "5%", description: __ompTranslate("Act only when nearly exhausted") },
			{ value: "10", label: "10%", description: __ompTranslate("Balanced safety margin") },
			{ value: "15", label: "15%", description: __ompTranslate("Conservative") },
			{ value: "20", label: "20%", description: __ompTranslate("Early protection") },
			{ value: "25", label: "25%", description: __ompTranslate("Very conservative") },
		],
	},
});

export const cfgRetryUsageReservePolicy = register({
	id: "retry.usageReservePolicy",
	type: "enum",
	values: ["confirm", "auto", "fail-closed"] as const,
	default: "confirm",
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Reserve Policy"),
		description: "What to do when every same-provider coding-plan account is inside the reserve margin.",
		condition: "usageAwareFallbackEnabled",
		options: [
			{
				value: "confirm",
				label: __ompTranslate("Confirm interactively"),
				description: __ompTranslate(
					"Keep interactive sessions on the primary until confirmed; background agents auto-fallback",
				),
			},
			{
				value: "auto",
				label: __ompTranslate("Auto-fallback"),
				description: __ompTranslate("Always select the next eligible configured fallback"),
			},
			{
				value: "fail-closed",
				label: __ompTranslate("Fail closed"),
				description: __ompTranslate("Do not spend reserve quota or select a fallback"),
			},
		],
	},
});

export const cfgRetryFallbackChains = register({
	id: "retry.fallbackChains",
	type: "record",
	default: EMPTY_STRING_ARRAYS_RECORD,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Retry Fallback Chains"),
		description:
			'JSON object mapping model roles, model selectors ("provider/model-id"), or provider wildcards ("provider/*") to ordered fallback selectors, e.g. {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a "provider/*" entry keeps the failing model\'s id and swaps the provider. An id-prefixed wildcard ("openrouter/google/*") re-prefixes the failing model\'s bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider\'s ids under the prefix. A fallback entry may carry an explicit thinking suffix ("provider/model:low", ":high", ":max", ":off"); a bare entry inherits the failing turn\'s effort, and "provider/*" entries always inherit.',
	},
});

export const cfgRetryFallbackRevertPolicy = register({
	id: "retry.fallbackRevertPolicy",
	type: "enum",
	values: ["cooldown-expiry", "never"] as const,
	default: "cooldown-expiry",
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Fallback Revert Policy"),
		description: "When to return to the primary model after a fallback",
		options: [
			{
				value: "cooldown-expiry",
				label: __ompTranslate("Cooldown expiry"),
				description: __ompTranslate("Return to the primary model after its suppression window ends"),
			},
			{
				value: "never",
				label: __ompTranslate("Never\u0004model.fallback-revert.never"),
				description: __ompTranslate("Stay on the fallback model until manually changed"),
			},
		],
	},
});

/** Retry/backoff and usage-aware fallback policy (`retry.*` except fallback chains/revert policy). */
export const cfgRetry = combine({
	enabled: cfgRetryEnabled,
	maxRetries: cfgRetryMaxRetries,
	baseDelayMs: cfgRetryBaseDelayMs,
	maxDelayMs: cfgRetryMaxDelayMs,
	waitForUsageReset: cfgRetryWaitForUsageReset,
	modelFallback: cfgRetryModelFallback,
	fallbackOn: cfgRetryFallbackOn,
	rateLimitWalksChain: cfgRetryRateLimitWalksChain,
	usageAwareFallback: cfgRetryUsageAwareFallback,
	usageReservePct: cfgRetryUsageReservePct,
	usageReservePolicy: cfgRetryUsageReservePolicy,
});

/** Retry/backoff policy ({@link cfgRetry}). */
export type RetrySettings = SettingValueOf<typeof cfgRetry>;

export const cfgProvidersAnthropicServerSideFallback = register({
	id: "providers.anthropic.serverSideFallback",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Retry & Fallback",
		label: __ompTranslate("Anthropic Server-Side Fallback (Fable 5)"),
		description:
			"When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 5 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.",
	},
});

/**
 * Anthropic subscription slow mode (`off` | `auto`). Deliberately has no
 * `/settings` UI: `/slow on|off` on an Anthropic model is the only switch.
 * `auto` switches to low priority automatically when a Claude subscription
 * hits its 5-hour limit and Anthropic offers it. Wrap-up allowance tracking
 * runs either way; this only gates the low-priority lane.
 */
export const cfgProvidersAnthropicSlowMode = register({
	id: "providers.anthropic.slowMode",
	type: "enum",
	values: ["off", "auto"] as const,
	default: "off" as const,
});

// Provider selection
export const cfgProvidersOllamaCloudMaxConcurrency = register({
	id: "providers.ollama-cloud.maxConcurrency",
	type: "number",
	default: 3,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Ollama Cloud Max Concurrency"),
		description: "Maximum concurrent Ollama Cloud subagent runs per process; 0 disables the provider-specific limit",
	},
});

export const cfgProvidersWebSearchTimeoutSeconds = register({
	id: "providers.webSearchTimeoutSeconds",
	type: "number",
	default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Web Search Timeout"),
		description: `Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum ${MAX_WEB_SEARCH_TIMEOUT_SECONDS})`,
		options: [
			{ value: "30", label: __ompTranslate("30 seconds") },
			{ value: "60", label: __ompTranslate("1 minute") },
			{ value: "120", label: __ompTranslate("2 minutes") },
			{ value: "180", label: __ompTranslate("3 minutes") },
			{ value: "300", label: __ompTranslate("5 minutes") },
		],
	},
});

export const cfgProvidersAntigravityEndpoint = register({
	id: "providers.antigravityEndpoint",
	type: "enum",
	values: ["auto", "production", "sandbox"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Antigravity Endpoint Mode"),
		description: "Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Try production endpoint, fail over to sandbox on 5xx/429"),
			},
			{
				value: "production",
				label: __ompTranslate("Production Only"),
				description: __ompTranslate("Force production endpoint only"),
			},
			{
				value: "sandbox",
				label: __ompTranslate("Sandbox Only"),
				description: __ompTranslate("Force sandbox endpoint only"),
			},
		],
	},
});

export const cfgProvidersFireworksTier = register({
	id: "providers.fireworksTier",
	type: "enum",
	values: ["standard", "priority"] as const,
	default: "standard",
	ui: {
		tab: "providers",
		group: "Fireworks",
		label: __ompTranslate("Fireworks Tier"),
		description:
			'Serving path for Fireworks requests. Priority sends `service_tier: "priority"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path.',
		options: [
			{
				value: "standard",
				label: __ompTranslate("Standard"),
				description: __ompTranslate("Default serving path (no service_tier)"),
			},
			{
				value: "priority",
				label: __ompTranslate("Priority"),
				description: __ompTranslate("Priority serving path: higher reliability, premium per-token pricing"),
			},
		],
	},
});

export const cfgProvidersTinyModelDevice = register({
	id: "providers.tinyModelDevice",
	type: "enum",
	values: TINY_MODEL_DEVICE_SETTING_VALUES,
	default: TINY_MODEL_DEVICE_DEFAULT,
	env: {
		name: "PI_TINY_DEVICE",
		parse: raw => TINY_MODEL_DEVICE_SETTING_VALUES.find(value => value === raw.trim().toLowerCase()),
	},
	ui: {
		tab: "providers",
		group: "Tiny Model",
		label: __ompTranslate("Tiny Model Device"),
		description:
			"Inference backend for local tiny models (titles + memory): an ONNX execution provider, or `mlx` to download MLX weights and run them through mlx-lm on Apple silicon. Default uses CPU-only ONNX. The PI_TINY_DEVICE env var overrides this.",
		options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
	},
});

export const cfgProvidersTinyModelDtype = register({
	id: "providers.tinyModelDtype",
	type: "enum",
	values: TINY_MODEL_DTYPE_SETTING_VALUES,
	default: TINY_MODEL_DTYPE_DEFAULT,
	env: {
		name: "PI_TINY_DTYPE",
		parse: raw => TINY_MODEL_DTYPE_SETTING_VALUES.find(value => value === raw.trim().toLowerCase()),
	},
	ui: {
		tab: "providers",
		group: "Tiny Model",
		label: __ompTranslate("Tiny Model Precision"),
		description:
			"ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. Ignored by the MLX backend (its repos are pre-quantized 4-bit). The PI_TINY_DTYPE env var overrides this.",
		options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
	},
});

export const cfgProvidersAutoThinkingMaxEffort = register({
	id: "providers.autoThinkingMaxEffort",
	type: "enum",
	values: ["xhigh", "max"] as const,
	default: "xhigh",
	ui: {
		tab: "model",
		group: "Thinking",
		label: __ompTranslate("Auto Thinking Ceiling"),
		description:
			"Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it.",
		condition: "autoThinkingActive",
		options: [
			{ value: "xhigh", label: "xhigh", description: __ompTranslate("Classifier stops at xhigh (default)") },
			{
				value: "max",
				label: "max",
				description: __ompTranslate("Classifier may resolve max where the model supports it"),
			},
		],
	},
});

export const cfgFeaturesUnexpectedStopDetection = register({
	id: "features.unexpectedStopDetection",
	type: "enum",
	values: ["none", "mechanical", "smart"] as const,
	default: "mechanical",
	ui: {
		tab: "interaction",
		group: "Agent",
		label: __ompTranslate("Unexpected Stops"),
		description:
			"Automatically recover when the assistant stops without a visible message. Smart also classifies text-only stops with a small model.",
		options: [
			{
				value: "none",
				label: __ompTranslate("None"),
				description: __ompTranslate("Disabled\u0004display.shimmer.disabled"),
			},
			{
				value: "mechanical",
				label: __ompTranslate("Mechanical"),
				description: __ompTranslate(
					"Retry stops with no visible assistant message; tool calls are excluded (default)",
				),
			},
			{
				value: "smart",
				label: __ompTranslate("Smart\u0004session.stop-detection.smart"),
				description: __ompTranslate("Mechanical + small-model classification of text-only stops"),
			},
		],
	},
});

export const cfgProvidersKimiApiFormat = register({
	id: "providers.kimiApiFormat",
	type: "enum",
	values: ["auto", "openai", "anthropic"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: __ompTranslate("Kimi API Format"),
		description: "API format for Kimi Code provider (auto follows live model metadata)",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Use the model's server-declared protocol"),
			},
			{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
			{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
		],
	},
});

export const cfgProvidersOpenaiWebsockets = register({
	id: "providers.openaiWebsockets",
	type: "enum",
	values: ["auto", "off", "on"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: "OpenAI WebSockets",
		description: "Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Use model/provider default websocket behavior"),
			},
			{
				value: "off",
				label: __ompTranslate("Off"),
				description: __ompTranslate("Disable websockets for OpenAI Codex models"),
			},
			{
				value: "on",
				label: __ompTranslate("On"),
				description: __ompTranslate("Force websockets for OpenAI Codex models"),
			},
		],
	},
});

export const cfgProvidersOpenaiLiveSteering = register({
	id: "providers.openaiLiveSteering",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Protocol",
		label: __ompTranslate("OpenAI Live Steering"),
		description:
			"Deliver messages typed while a GPT-6 response streams into that response over the Codex WebSocket, instead of waiting for the next tool boundary",
	},
});

export const cfgProvidersMuseCodeStoreResponses = register({
	id: "providers.muse-code.storeResponses",
	type: "boolean",
	default: false,
	env: "PI_MUSE_STORE_RESPONSES",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: __ompTranslate("Muse Code Stored Responses"),
		description:
			"Store Muse Code results on Meta's servers so a turn whose connection drops is recovered instead of re-run. Stored runs keep prompts and outputs on Meta's side.",
	},
});
// Process-wide too, so side requests that call `completeSimple`/`streamSimple`
// directly (titles, commit messages, memories) follow the setting.
effect(cfgProvidersMuseCodeStoreResponses, enabled => configureProviderStoreResponses({ "muse-code": enabled }));

export const cfgProvidersCacheRetention = register({
	id: "providers.cacheRetention",
	type: "enum",
	values: ["auto", "short", "long", "none"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: __ompTranslate("Prompt Cache Retention"),
		description:
			"Prompt-cache retention forwarded to providers that support it (Anthropic, Bedrock, OpenRouter, OpenAI)",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate(
					"Provider default — Anthropic OAuth subscriber sessions default to 1h, API keys use 5m; PI_CACHE_RETENTION still applies",
				),
			},
			{
				value: "short",
				label: __ompTranslate("Short (5m)"),
				description: __ompTranslate(
					"Cheapest cache writes; pair with cache warming to keep short entries alive while idle",
				),
			},
			{
				value: "long",
				label: __ompTranslate("Long (1h+)"),
				description: __ompTranslate(
					"Longer TTL where supported (Anthropic/Bedrock 1h, OpenAI GPT-5.6+ Responses 12h); pricier writes, only warmed during active runs",
				),
			},
			{
				value: "none",
				label: __ompTranslate("Off"),
				description: __ompTranslate("Disable prompt caching and cache-affinity routing"),
			},
		],
	},
});

export const cfgProvidersCacheWarming = register({
	id: "providers.cacheWarming",
	type: "enum",
	values: ["off", "streaming", "idle"] as const,
	default: "idle",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: __ompTranslate("Cache Warming"),
		description:
			"Re-send the last request with a one-token output budget shortly before its prompt-cache entry expires",
		options: [
			{ value: "off", label: __ompTranslate("Off"), description: __ompTranslate("Disable cache warming") },
			{
				value: "streaming",
				label: __ompTranslate("Streaming"),
				description: __ompTranslate(
					"Protect expensive prefixes during long tool executions; stops when the agent settles",
				),
			},
			{
				value: "idle",
				label: __ompTranslate("Idle\u0004provider.cache-warming.idle"),
				description: __ompTranslate(
					"Also refresh 5-minute entries between runs while the expected savings stay above the cost floor",
				),
			},
		],
	},
});

export const cfgProvidersStreamFirstEventTimeoutSeconds = register({
	id: "providers.streamFirstEventTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "Timeouts",
		label: __ompTranslate("Stream First Event Timeout"),
		description:
			"Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Use provider defaults and PI_* timeout env vars"),
			},
			{ value: "0", label: __ompTranslate("Off"), description: __ompTranslate("Disable first-event timeout") },
			{ value: "300", label: __ompTranslate("5 minutes") },
			{ value: "600", label: __ompTranslate("10 minutes") },
			{ value: "1800", label: __ompTranslate("30 minutes") },
		],
	},
});

export const cfgProvidersStreamIdleTimeoutSeconds = register({
	id: "providers.streamIdleTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "Timeouts",
		label: __ompTranslate("Stream Idle Timeout"),
		description:
			"Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog",
		options: [
			{
				value: "-1",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Use provider defaults and PI_* timeout env vars"),
			},
			{ value: "0", label: __ompTranslate("Off"), description: __ompTranslate("Disable idle timeout") },
			{ value: "300", label: __ompTranslate("5 minutes") },
			{ value: "600", label: __ompTranslate("10 minutes") },
			{ value: "1800", label: __ompTranslate("30 minutes") },
		],
	},
});

export const cfgProvidersOpenrouterVariant = register({
	id: "providers.openrouterVariant",
	type: "enum",
	values: ["default", "nitro", "floor", "online", "exacto"] as const,
	default: "default",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: __ompTranslate("OpenRouter Routing"),
		description:
			"Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)",
		options: [
			{
				value: "default",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("No suffix; use OpenRouter's default routing"),
			},
			{ value: "nitro", label: ":nitro", description: __ompTranslate("Prioritize throughput / lowest latency") },
			{ value: "floor", label: ":floor", description: __ompTranslate("Prioritize cheapest available provider") },
			{ value: "online", label: ":online", description: __ompTranslate("Enable OpenRouter's web-search plugin") },
			{
				value: "exacto",
				label: ":exacto",
				description: __ompTranslate("Cherry-picked high-quality providers (only defined for select models)"),
			},
		],
	},
});

export const cfgProvidersFetch = register({
	id: "providers.fetch",
	type: "enum",
	values: ["auto", "native", "trafilatura", "lynx", "parallel", "firecrawl", "jina"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Fetch Provider"),
		description: "Reader backend priority for the fetch/read URL tool",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Priority: native > trafilatura > lynx > parallel > firecrawl > jina"),
			},
			{
				value: "native",
				label: __ompTranslate("Native"),
				description: __ompTranslate("In-process HTML→Markdown converter (always available)"),
			},
			{ value: "trafilatura", label: "Trafilatura", description: __ompTranslate("Auto-installs via uv/pip") },
			{ value: "lynx", label: "Lynx", description: __ompTranslate("Requires lynx system package") },
			{ value: "parallel", label: "Parallel", description: __ompTranslate("Requires PARALLEL_API_KEY") },
			{ value: "firecrawl", label: "Firecrawl", description: __ompTranslate("Requires FIRECRAWL_API_KEY") },
			{ value: "jina", label: "Jina", description: __ompTranslate("Uses r.jina.ai reader (JINA_API_KEY optional)") },
		],
	},
});

// Codex saved rate-limit resets (auto-redeem)
export const cfgCodexResetsAutoRedeem = register({
	id: "codexResets.autoRedeem",
	type: "enum",
	values: ["unset", "yes", "no"] as const,
	default: "unset" as const,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Codex Auto-Redeem Saved Resets"),
		description:
			"Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend (with no prompt UI, it spends only a reset expiring within 5 minutes), yes spends without prompting, and no disables both checks.",
		options: [
			{
				value: "unset",
				label: __ompTranslate("Unset"),
				description: __ompTranslate(
					"Check eligibility, then ask before spending the first saved reset. With no prompt UI, spend only a reset expiring within 5 minutes.",
				),
			},
			{
				value: "yes",
				label: __ompTranslate("Yes"),
				description: __ompTranslate("Spend eligible saved resets without prompting."),
			},
			{
				value: "no",
				label: __ompTranslate("No"),
				description: __ompTranslate("Do not run the saved-reset auto-redeem check."),
			},
		],
	},
});

export const cfgCodexResetsMinBlockedMinutes = register({
	id: "codexResets.minBlockedMinutes",
	type: "number",
	default: 60,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Codex Auto-Redeem Min Block"),
		description:
			"Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks.",
	},
});

export const cfgCodexResetsKeepCredits = register({
	id: "codexResets.keepCredits",
	type: "number",
	default: 0,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Codex Auto-Redeem Reserve"),
		description:
			"Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing.",
	},
});

export const cfgCodexResetsSalvageHorizonHours = register({
	id: "codexResets.salvageHorizonHours",
	type: "number",
	default: 12,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Codex Reset Salvage Horizon"),
		description:
			"With auto-redeem enabled, spend a saved Codex reset within this many hours of expiry when either chat window has meaningful usage. 0 disables early salvage; credits expiring within 5 minutes are still attempted regardless of usage.",
	},
});

/** Codex saved-reset auto-redeem policy (`codexResets.*`). */
export const cfgCodexResets = combine({
	autoRedeem: cfgCodexResetsAutoRedeem,
	minBlockedMinutes: cfgCodexResetsMinBlockedMinutes,
	keepCredits: cfgCodexResetsKeepCredits,
	salvageHorizonHours: cfgCodexResetsSalvageHorizonHours,
});

/** Whether automatic reset redemption asks first, spends, or remains disabled. */
export type ResetAutoRedeemMode = SettingValueOf<typeof cfgCodexResetsAutoRedeem>;

// Claude Cedar/Juniper rate-limit resets (independent auto-redeem consent)
export const cfgClaudeResetsAutoRedeem = register({
	id: "claudeResets.autoRedeem",
	type: "enum",
	values: ["unset", "yes", "no"] as const,
	default: "unset" as const,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Claude Auto-Redeem Resets"),
		description:
			"Spend eligible Claude Cedar or Juniper resets automatically. Cedar is spent only for covered limits; Juniper can only recover a sole 5-hour block. unset asks before the first spend (with no prompt UI, it spends only a reset expiring within 5 minutes), yes spends without prompting, and no disables blocked recovery and expiry salvage.",
		options: [
			{
				value: "unset",
				label: __ompTranslate("Unset"),
				description: __ompTranslate(
					"Check live eligibility, then ask before spending the first Claude reset. With no prompt UI, spend only a reset expiring within 5 minutes.",
				),
			},
			{
				value: "yes",
				label: __ompTranslate("Yes"),
				description: __ompTranslate("Spend eligible Claude resets without prompting."),
			},
			{
				value: "no",
				label: __ompTranslate("No"),
				description: __ompTranslate("Do not run Claude reset auto-redeem checks."),
			},
		],
	},
});

export const cfgClaudeResetsMinBlockedMinutes = register({
	id: "claudeResets.minBlockedMinutes",
	type: "number",
	default: 60,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Claude Auto-Redeem Min Block"),
		description:
			"Only auto-redeem when the natural unblock — the latest reset among the exhausted covered windows — is at least this many minutes away. A 5-hour-only reset is never used for a weekly or model-scoped block.",
	},
});

export const cfgClaudeResetsKeepCredits = register({
	id: "claudeResets.keepCredits",
	type: "number",
	default: 0,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Claude Auto-Redeem Reserve"),
		description:
			"Keep at least this many Claude resets banked (0 allows the last eligible reset to be spent automatically). The reserve applies to early salvage, but not to eligible resets expiring within 5 minutes.",
	},
});

export const cfgClaudeResetsSalvageHorizonHours = register({
	id: "claudeResets.salvageHorizonHours",
	type: "number",
	default: 12,
	ui: {
		tab: "providers",
		group: "Services",
		label: __ompTranslate("Claude Reset Salvage Horizon"),
		description:
			"With auto-redeem enabled, use a server-selected Cedar reset within this many hours of expiry when its covered windows have meaningful usage. 0 disables early salvage; eligible Cedar or Juniper resets expiring within 5 minutes are still attempted regardless of usage or reserve. Provider limit requirements still apply.",
	},
});

/** Claude reset auto-redeem policy (`claudeResets.*`), independent of {@link cfgCodexResets}. */
export const cfgClaudeResets = combine({
	autoRedeem: cfgClaudeResetsAutoRedeem,
	minBlockedMinutes: cfgClaudeResetsMinBlockedMinutes,
	keepCredits: cfgClaudeResetsKeepCredits,
	salvageHorizonHours: cfgClaudeResetsSalvageHorizonHours,
});

export const cfgProviderAppendOnlyContext = register({
	id: "provider.appendOnlyContext",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: __ompTranslate("Append-Only Context"),
		description:
			"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Enable for known prefix-cache providers (recommended)"),
			},
			{ value: "on", label: __ompTranslate("On"), description: __ompTranslate("Always enable append-only context") },
			{ value: "off", label: __ompTranslate("Off"), description: __ompTranslate("Disable append-only context") },
		],
	},
});

export const cfgThinkingBudgetsMinimal = register({ id: "thinkingBudgets.minimal", type: "number", default: 1024 });

export const cfgThinkingBudgetsLow = register({ id: "thinkingBudgets.low", type: "number", default: 2048 });

export const cfgThinkingBudgetsMedium = register({ id: "thinkingBudgets.medium", type: "number", default: 8192 });

export const cfgThinkingBudgetsHigh = register({ id: "thinkingBudgets.high", type: "number", default: 16384 });

export const cfgThinkingBudgetsXhigh = register({ id: "thinkingBudgets.xhigh", type: "number", default: 32768 });

export const cfgThinkingBudgetsMax = register({ id: "thinkingBudgets.max", type: "number", default: 32768 });

/** Token budget per thinking level (`thinkingBudgets.*`) on transports that accept reasoning token budgets. */
export const cfgThinkingBudgets = combine({
	minimal: cfgThinkingBudgetsMinimal,
	low: cfgThinkingBudgetsLow,
	medium: cfgThinkingBudgetsMedium,
	high: cfgThinkingBudgetsHigh,
	xhigh: cfgThinkingBudgetsXhigh,
	max: cfgThinkingBudgetsMax,
});

/** Rejects a cost threshold that is not a positive USD amount. */
function validateCostThreshold(id: string): (raw: unknown) => void {
	return raw => {
		if (raw === undefined || raw === null || (typeof raw === "number" && Number.isFinite(raw) && raw > 0)) return;
		throw new Error(`Invalid ${id}: expected a positive USD amount, got ${Bun.inspect(raw)}.`);
	};
}

/** Session-tree spend (USD) at which omp warns once; `--warn-cost` overrides it for one run. */
export const cfgSessionWarnCost = register({
	id: "session.warnCost",
	type: "number",
	default: undefined,
	validate: validateCostThreshold("session.warnCost"),
});

/** Session-tree spend (USD) at which omp stops sending model requests; `--max-cost` overrides it for one run. */
export const cfgSessionMaxCost = register({
	id: "session.maxCost",
	type: "number",
	default: undefined,
	validate: validateCostThreshold("session.maxCost"),
});
