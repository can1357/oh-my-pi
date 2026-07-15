import { THINKING_EFFORTS } from "@pk-nerdsaver-ai/pi-ai";
import { DEFAULT_SHARE_URL } from "@pk-nerdsaver-ai/pi-wire";
import { DEFAULT_RELAY_URL } from "../collab/protocol";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS, STT_MODEL_VALUES } from "../stt/models";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata, getThinkingLevelMetadata } from "../thinking";
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
import {
	AUTO_THINKING_MODEL_OPTIONS,
	AUTO_THINKING_MODEL_VALUES,
	ONLINE_AUTO_THINKING_MODEL_KEY,
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_MEMORY_MODEL_OPTIONS,
	TINY_MEMORY_MODEL_VALUES,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "../tiny/models";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODEL_OPTIONS,
	TTS_LOCAL_MODEL_VALUES,
	TTS_LOCAL_VOICE_OPTIONS,
	TTS_LOCAL_VOICE_VALUES,
} from "../tts/models";
import { EDIT_MODES } from "../utils/edit-mode";
import { SEARCH_PROVIDER_OPTIONS, SEARCH_PROVIDER_PREFERENCES, type SearchProviderId } from "../web/search/types";

/** Unified settings schema - single source of truth for all settings.
 *
 * Each setting is defined once here with:
 * - Type and default value
 * - Optional UI metadata (label, description, tab, group)
 *
 * UI metadata places the setting in the settings panel: `tab` picks the
 * panel tab, `group` the titled section within it (registered in
 * TAB_GROUPS). Sections render in TAB_GROUPS order; settings within a
 * section keep declaration order.
 *
 * The Settings singleton provides type-safe path-based access:
 *   settings.get("compaction.enabled")  // => boolean
 *   settings.set("theme.dark", "titanium")  // sync, saves in background
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

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
export type TabMetadata = { label: string; icon: `tab.${string}` };

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
export const TAB_METADATA: Record<SettingTab, { label: string; icon: `tab.${string}` }> = {
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
 * Ordered section groups per tab. Settings declare their section via `ui.group`;
 * the settings UI renders groups in this order with a heading row between them.
 * Ungrouped settings render first, before any section heading.
 */
export const TAB_GROUPS: Record<SettingTab, readonly string[]> = {
	appearance: ["Theme", "Status Line", "Display", "Images"],
	model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Vision"],
	interaction: [
		"Input",
		"Approvals",
		"Notifications",
		"Speech",
		"Collab",
		"Magic Keywords",
		"Startup & Updates",
		"Power (macOS)",
		"Agent",
		"Git",
		"Mixture of Agents",
		"Fusion",
	],
	context: ["General", "Light Context", "Compaction", "Rules (TTSR)", "Experimental"],
	memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight"],
	files: ["Editing", "Reading", "Read Summaries", "LSP"],
	shell: ["Bash", "Eval & Python"],
	tools: [
		"Available Tools",
		"Todos",
		"Search & Browser",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Developer",
	],
	tasks: ["Modes", "Subagents", "Isolation", "Commands & Skills"],
	providers: ["Services", "Tiny Model", "Protocol", "Privacy"],
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write"
	| "cache_hit"
	| "session_name"
	| "usage"
	| "collab"
	| "moa"
	| "fusion"
	| "fusion_savings";

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;
	/** Section within the tab; must be listed in TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	label: string;
	description: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	/** Submenu options. When omitted, the enum renders as an inline toggle derived from `values`. */
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	/** Submenu options. Without options, a numeric setting has no UI representation (intentional hide). */
	options?: ReadonlyArray<SubmenuOption>;
}

interface UiString extends UiBase {
	/**
	 * Submenu options.
	 *  - Array  → submenu with these choices.
	 *  - "runtime" → submenu populated by the runtime layer (theme registry, etc.).
	 *  - Omitted → renders as a free text input.
	 */
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
};

interface BooleanDef {
	type: "boolean";
	default: boolean | undefined;
	ui?: UiBoolean;
}

interface StringDef {
	type: "string";
	default: string | undefined;
	ui?: UiString;
}

interface NumberDef {
	type: "number";
	default: number;
	ui?: UiNumber;
}

interface EnumDef<T extends readonly string[]> {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiEnum<T>;
}

interface ArrayDef<T> {
	type: "array";
	default: T[];
	ui?: UiBase;
}

interface RecordDef<T> {
	type: "record";
	default: Record<string, T>;
	ui?: UiBase;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};

/**
 * Per-agent execution policy overrides under `task.agentPolicies`.
 * Lookup precedence at resolve time: stable agent id → agent type → workflow/default.
 */
export interface AgentPolicySettings {
	tier?: "light" | "mid" | "frontier";
	autonomy?: "bound" | "supervised" | "independent";
	collaboration?: "report-only" | "message-peers" | "self-coordinate";
	workClass?: "mechanical" | "judgment";
	editMode?: "none" | "replace" | "hashline" | "apply-patch";
	maxRequests?: number;
	maxRuntimeMs?: number;
	modelPool?: string[];
}

const EMPTY_AGENT_POLICIES: Record<string, AgentPolicySettings> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];
const WORKSPACE_MODE_VALUES = ["auto", "copy", "worktree"] as const;
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "search",
		message: "Use the `search` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "find",
		message: "Use the `find` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched.
		pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+(?:[^\"'>]|\"[^\"]*\"|'[^']*')*(?<!\\|)>{1,2}\\|?\\s*[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
];

export const SETTINGS_SCHEMA = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	setupVersion: { type: "number", default: 0 },

	// Auth broker — credentials proxied through a remote `omp auth-broker serve`
	// host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	// Env (`OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`) takes precedence so
	// per-machine overrides remain trivial.
	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined },

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Auto Resume",
			description: "Automatically resume the most recent session in the current directory",
		},
	},

	// macOS power assertions (caffeinate flags). No-op on other platforms.
	"power.sleepPrevention": {
		type: "enum",
		values: ["off", "idle", "display", "system"] as const,
		default: "idle",
		ui: {
			tab: "interaction",
			group: "Power (macOS)",
			label: "Sleep Prevention",
			description:
				"Prevent macOS sleep during active sessions. Each level is cumulative — it adds the flags of all lower levels.",
			options: [
				{
					value: "off",
					label: "Off",
					description: "Do not prevent any sleep",
				},
				{
					value: "idle",
					label: "Prevent Idle Sleep",
					description: "Keep the system awake while a session is open (caffeinate -i)",
				},
				{
					value: "display",
					label: "Prevent Display Sleep",
					description: "Also keep the display from idle-sleeping (caffeinate -i -d)",
				},
				{
					value: "system",
					label: "Prevent System Sleep",
					description: "Also block all system sleep on AC and declare the user active (caffeinate -i -d -s -u)",
				},
			],
		},
	},
	"advisor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Enable Advisor",
			description:
				"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.",
		},
	},
	"advisor.subagents": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor for Subagents",
			description: "Also enable the advisor on spawned task/eval subagents.",
			condition: "advisorEnabled",
		},
	},
	"advisor.syncBacklog": {
		type: "enum",
		values: ["off", "1", "3", "5"] as const,
		default: "off",
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor Sync Backlog",
			description:
				"Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.",
			condition: "advisorEnabled",
		},
	},
	"advisor.immuneTurns": {
		type: "number",
		default: 1,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor Immune Turns",
			description:
				"After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.",
			options: [
				{ value: "0", label: "0 turns", description: "Allow every concern/blocker to interrupt." },
				{ value: "1", label: "1 turn", description: "Default." },
				{ value: "2", label: "2 turns" },
				{ value: "3", label: "3 turns" },
				{ value: "4", label: "4 turns" },
				{ value: "5", label: "5 turns" },
			],
			condition: "advisorEnabled",
		},
	},
	shellPath: { type: "string", default: undefined },
	"git.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Git",
			label: "Enable Git Integration",
			description: "Show git branch, status, and PR information in the TUI and watch repository metadata.",
		},
	},

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledExtensions: { type: "array", default: EMPTY_STRING_ARRAY },

	modelRoles: { type: "record", default: EMPTY_STRING_RECORD },

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	// Named, swappable bundles of model roles — "optimal model per agent slot"
	// presets. Each profile is a role->model-selector map (same keys as
	// `modelRoles`). When `agent.profile` names an entry here, its role map is
	// applied UNDER explicit `modelRoles` (per-role explicit always wins), so
	// every agent that resolves through a role (`pi/smol`, `pi/task`, …)
	// retargets at once. Per-slot exceptions still use `task.agentModelOverrides`.
	"agent.profile": {
		type: "string",
		default: "",
		ui: {
			tab: "model",
			group: "Agent Model Profiles",
			label: "Active Agent Profile",
			description:
				"Name of a profile under `agent.profiles` to activate. Empty disables profiles. Explicit `model.*` role settings still override the profile.",
		},
	},

	"agent.profiles": {
		type: "record",
		default: {} as Record<string, Record<string, string>>,
		ui: {
			tab: "model",
			group: "Agent Model Profiles",
			label: "Agent Model Profiles",
			description:
				"Named role->model maps, e.g. `frugal: { smol: nvidia/…, task: …, slow: … }`. Activate one via `agent.profile`.",
		},
	},

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },

	// ────────────────────────────────────────────────────────────────────────
	// Appearance
	// ────────────────────────────────────────────────────────────────────────

	// Theme
	"theme.dark": {
		type: "string",
		default: "titanium",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Dark Theme",
			description: "Theme used when the terminal has a dark background",
			options: "runtime",
		},
	},

	"theme.light": {
		type: "string",
		default: "light",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Light Theme",
			description: "Theme used when the terminal has a light background",
			options: "runtime",
		},
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Symbol Preset",
			description: "Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)",
			options: [
				{ value: "unicode", label: "Unicode", description: "Standard symbols (default)" },
				{ value: "nerd", label: "Nerd Font", description: "Requires Nerd Font" },
				{ value: "ascii", label: "ASCII", description: "Maximum compatibility" },
			],
		},
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Color-Blind Mode",
			description: "Use blue instead of green for diff additions",
		},
	},

	// Composer
	"composer.layout": {
		type: "enum",
		values: ["intent", "classic"] as const,
		default: "intent",
		ui: {
			tab: "appearance",
			group: "Composer",
			label: "Composer Layout",
			description:
				"Intent-first layout puts the work-mode bar above the editor, context chips and the execution rail inside the frame, and moves the status line beneath the composer. Classic keeps the status line embedded in the editor's top border.",
			options: [
				{
					value: "intent",
					label: "Intent",
					description: "Mode bar, context chips, execution rail, diagnostics below",
				},
				{ value: "classic", label: "Classic", description: "Status line embedded in the editor top border" },
			],
		},
	},

	// Status line
	"statusLine.preset": {
		type: "enum",
		values: ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const,
		default: "default",
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Status Line Preset",
			description: "Pre-built status line configurations",
			options: [
				{ value: "default", label: "Default", description: "Model, path, git, context, tokens, cost" },
				{ value: "minimal", label: "Minimal", description: "Path and git only" },
				{ value: "compact", label: "Compact", description: "Model, git, cost, context" },
				{ value: "full", label: "Full", description: "All segments including time" },
				{ value: "nerd", label: "Nerd", description: "Maximum info with Nerd Font icons" },
				{ value: "ascii", label: "ASCII", description: "No special characters" },
				{ value: "custom", label: "Custom", description: "User-defined segments" },
			],
		},
	},

	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		default: "powerline-thin",
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Status Line Separator",
			description: "Style of separators between segments",
			options: [
				{ value: "powerline", label: "Powerline", description: "Solid arrows (Nerd Font)" },
				{ value: "powerline-thin", label: "Thin chevron", description: "Thin arrows (Nerd Font)" },
				{ value: "slash", label: "Slash", description: "Forward slashes" },
				{ value: "pipe", label: "Pipe", description: "Vertical pipes" },
				{ value: "block", label: "Block", description: "Solid blocks" },
				{ value: "none", label: "None", description: "Space only" },
				{ value: "ascii", label: "ASCII", description: "Greater-than signs" },
			],
		},
	},

	"statusLine.sessionAccent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Session Accent",
			description: "Use the session name color for the editor border and status line gap",
		},
	},

	"statusLine.transparent": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Transparent Status Line",
			description:
				"Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.",
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Spill Threshold (KB)",
			description: "Tool output above this size is saved as an artifact; tail is kept inline",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "~5K tokens" },
				{ value: "30", label: "30 KB", description: "~7.5K tokens" },
				{ value: "50", label: "50 KB", description: "Default; ~12.5K tokens" },
				{ value: "75", label: "75 KB", description: "~19K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
				{ value: "500", label: "500 KB", description: "~125K tokens" },
				{ value: "1000", label: "1 MB", description: "~250K tokens" },
			],
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Tail Size (KB)",
			description: "Amount of tail content kept inline when output spills to artifact",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Head Size (KB)",
			description:
				"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.",
			options: [
				{ value: "0", label: "0 KB", description: "Disabled; tail-only truncation" },
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Output Column Cap",
			description:
				"Per-line byte cap for streaming tool outputs (bash, ssh, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.",
			options: [
				{ value: "0", label: "Off", description: "No per-line cap" },
				{ value: "256", label: "256", description: "Tight" },
				{ value: "512", label: "512" },
				{ value: "768", label: "768", description: "Default" },
				{ value: "1024", label: "1024" },
				{ value: "2048", label: "2048" },
				{ value: "4096", label: "4096", description: "Loose" },
			],
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Tail Lines",
			description: "Maximum lines of tail content kept inline when output spills to artifact",
			options: [
				{ value: "50", label: "50 lines", description: "~250 tokens" },
				{ value: "100", label: "100 lines", description: "~500 tokens" },
				{ value: "250", label: "250 lines", description: "~1.25K tokens" },
				{ value: "500", label: "500 lines", description: "Default; ~2.5K tokens" },
				{ value: "1000", label: "1000 lines", description: "~5K tokens" },
				{ value: "2000", label: "2000 lines", description: "~10K tokens" },
				{ value: "5000", label: "5000 lines", description: "~25K tokens" },
			],
		},
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Show Hook Status",
			description: "Display hook status messages below the status line",
		},
	},

	"statusLine.leftSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.rightSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },
	// Mixture-of-Agents: read-only candidate lanes feeding the active model.
	"moa.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Mixture of Agents",
			label: "Enable Mixture of Agents",
			description: "Run read-only candidate lanes before each turn and inject private advice into the active model.",
		},
	},

	"moa.preset": {
		type: "enum",
		values: ["off", "balanced", "diverse", "code", "custom"] as const,
		default: "off",
		ui: {
			tab: "interaction",
			group: "Mixture of Agents",
			label: "MOA Preset",
			description: "Named lane preset. `custom` uses the lane selectors you provide below.",
			options: [
				{ value: "off", label: "Off", description: "MOA disabled at the preset layer (overrides enabled=false)." },
				{ value: "balanced", label: "Balanced", description: "Two lanes: smol + slow." },
				{ value: "diverse", label: "Diverse", description: "Four lanes: smol, slow, plus Sonnet + GPT-4o." },
				{ value: "code", label: "Code", description: "Two lanes: slow + a code model." },
				{ value: "custom", label: "Custom", description: "Use the selectors in `moa.lanes`." },
			],
			condition: "moaEnabled",
		},
	},

	"moa.lanes": {
		type: "record",
		default: {} as Record<string, string>,
		ui: {
			tab: "interaction",
			group: "Mixture of Agents",
			label: "Custom Lane Selectors",
			description: "Map of lane name -> model selector (e.g. `smol: pi/smol`). Active when preset is `custom`.",
			condition: "moaCustomPreset",
		},
	},

	"moa.maxLanes": {
		type: "number",
		default: 4,
		ui: {
			tab: "interaction",
			group: "Mixture of Agents",
			label: "Maximum Lanes",
			description: "Hard cap on resolved lanes. Excess selectors are skipped with a warning.",
			condition: "moaEnabled",
		},
	},

	// Devin-style fusion: delegate settled mechanical work to a cheap sidekick,
	// keep reasoning on the frontier model, and meter the token-cost savings.
	"fusion.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Enable Fusion (cost mode)",
			description:
				"Delegate settled mechanical work to a cheap sidekick model and keep reasoning on the frontier model, reducing frontier token use.",
		},
	},

	"fusion.mode": {
		type: "enum",
		values: ["off", "delegate", "escalate"] as const,
		default: "escalate",
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Fusion Mode",
			description: "How aggressively to route work to the sidekick.",
			options: [
				{ value: "off", label: "Off", description: "Fusion disabled at the mode layer (overrides enabled=true)." },
				{
					value: "delegate",
					label: "Delegate",
					description: "Prompt-driven: the main model offloads settled mechanical work to the sidekick.",
				},
				{
					value: "escalate",
					label: "Escalate",
					description: "Delegate + difficulty-gated routing: cheap-first, escalate hard work to the frontier.",
				},
			],
			condition: "fusionEnabled",
		},
	},

	"fusion.sidekickModel": {
		type: "string",
		default: "pi/smol",
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Sidekick Model",
			description: "Cheap model selector the sidekick runs (alias or provider/id). Defaults to pi/smol.",
			condition: "fusionEnabled",
		},
	},

	// Devin-Fusion refinement: the compaction classifier's verdict also re-tiers
	// the warm sidekick, independently of the main-model switch.
	"fusion.sidekickStrongModel": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Sidekick Strong Model",
			description:
				"Optional stronger sidekick tier: with dynamic routing on, each compaction verdict also re-tiers the warm sidekick — hard stretches upgrade it to this model (recommended: `pi/task`), settled stretches return it to the base sidekick model. Empty disables.",
			condition: "fusionEnabled",
		},
	},

	"fusion.compactModel": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Post-Compaction Model",
			description:
				"Optional cheaper model to switch the main agent to at each compaction boundary (the messages cache is already invalidated there, so the switch is marginal-cost). Empty disables it.",
			condition: "fusionEnabled",
		},
	},

	"fusion.dynamicRouting": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Dynamic Routing",
			description:
				"At every compaction boundary, run a lightweight classifier over the compaction summary to pick the main model for the next stretch — ramping down to the post-compaction model for mechanical work and back up to the frontier model when the work turns hard.",
			condition: "fusionEnabled",
		},
	},

	// Between compactions, a streak of consecutive failed tool calls on a
	// downgraded main model is the cheapest reliable "this stretch turned hard"
	// signal — force an early tier-up instead of waiting for the next boundary.
	"fusion.escalateFailureStreak": {
		type: "number",
		default: 3,
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Failure-Streak Escalation",
			description:
				"Consecutive failed tool calls on a Fusion-downgraded main model that force an early switch back to the frontier model, without waiting for the next compaction (0 = disabled).",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "2", label: "2 failures" },
				{ value: "3", label: "3 failures" },
				{ value: "5", label: "5 failures" },
			],
			condition: "fusionEnabled",
		},
	},

	// Tiered routing pool managed via /fusion pool (legacy alias: /fusion-pool).
	// Entries are "<tier>=<selector>"
	// with tier 1 = most powerful … 5 = least intelligent. With 2+ entries and
	// dynamic routing on, the compaction classifier picks a tier from this pool
	// instead of the binary compactModel/frontier choice.
	"fusion.modelPool": { type: "array", default: [] as string[] },

	"fusion.sidekickRequestBudget": {
		type: "number",
		default: 40,
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Sidekick Request Budget",
			description:
				"Hard cap on model requests per delegated subagent turn in fusion mode, including reused warm-sidekick turns (0 = unlimited).",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "20", label: "20 requests" },
				{ value: "40", label: "40 requests" },
				{ value: "80", label: "80 requests" },
			],
			condition: "fusionEnabled",
		},
	},

	"fusion.showSavings": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Fusion",
			label: "Show Savings Estimate",
			description: "Show an estimated frontier-vs-sidekick token-cost savings figure in the status line and /usage.",
			condition: "fusionEnabled",
		},
	},

	// Images and terminal
	"terminal.showImages": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "Show Inline Images",
			description: "Render images inline in the terminal",
			condition: "hasImageProtocol",
		},
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "Auto-Resize Images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
		},
	},

	"images.blockImages": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "Block Images",
			description: "Prevent images from being sent to LLM providers",
		},
	},

	"images.describeForTextModels": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Describe Images for Text Models",
			description:
				"When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it",
		},
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
		description:
			"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
		description:
			"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
	},

	"tui.maxInlineImages": {
		type: "number",
		default: 8,
		description:
			"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).",
	},

	"tui.textSizing": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Large Headings (Kitty)",
			description:
				"Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.",
		},
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Terminal Hyperlinks",
			description:
				"Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)",
		},
	},
	"tui.tight": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Tight Layout",
			description: "Remove the 1-character horizontal padding from the left and right of the terminal output",
		},
	},

	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Shimmer",
			description: "Animation style for working/loading messages",
			options: [
				{ value: "classic", label: "Classic", description: "Soft cosine wave sweeping across the text" },
				{ value: "kitt", label: "KITT Scanner", description: "Knight Rider 1982 red light bouncing left-right" },
				{ value: "disabled", label: "Disabled", description: "No animation; static muted text" },
			],
		},
	},

	"display.smoothStreaming": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Smooth Streaming",
			description: "Reveal assistant text and streamed tool input smoothly while chunks arrive",
		},
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Token Usage",
			description: "Show per-turn token usage on assistant messages",
		},
	},

	"display.cacheMissMarker": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Cache Miss Marker",
			description: "Show a divider above an assistant turn whose request lost (missed) the prompt cache",
		},
	},

	showHardwareCursor: {
		type: "boolean",
		default: true, // will be computed based on platform if undefined
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Hardware Cursor",
			description: "Show terminal cursor for IME support",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	defaultThinkingLevel: {
		type: "enum",
		values: [...THINKING_EFFORTS, AUTO_THINKING, "max"],
		default: "high",
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Thinking Level",
			description: "Reasoning depth for thinking-capable models",
			options: [
				getConfiguredThinkingLevelMetadata(AUTO_THINKING),
				...THINKING_EFFORTS.map(getThinkingLevelMetadata),
			],
		},
	},

	hideThinkingBlock: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Hide Thinking Blocks",
			description: "Hide thinking blocks in assistant responses",
		},
	},

	"model.loopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard",
			description: "Enable automatic stream loop detection for Gemini and DeepSeek models",
		},
	},

	"model.loopGuard.checkAssistantContent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Loop Guard Scan Prose",
			description: "Apply loop guard to assistant prose messages in addition to thinking logs",
		},
	},

	inlineToolDescriptors: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Inline Tool Descriptors",
			description:
				"Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once",
		},
	},

	includeModelInPrompt: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Include Model in Prompt",
			description: "Surface the active model identifier in the system prompt so the agent knows which model it is",
		},
	},

	personality: {
		type: "enum",
		values: ["default", "friendly", "pragmatic", "none"] as const,
		default: "default",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "Personality",
			description: "Communication style rendered into the system prompt's personality block",
			options: [
				{
					value: "default",
					label: "Default",
					description: "Terse, evidence-first engineer; dense, action-oriented replies",
				},
				{
					value: "friendly",
					label: "Friendly",
					description: "Warm, encouraging collaborator focused on momentum and morale",
				},
				{
					value: "pragmatic",
					label: "Pragmatic",
					description: "Direct, efficient engineer focused on clarity and rigor",
				},
				{ value: "none", label: "None", description: "Omit the personality block entirely" },
			],
		},
	},

	// Sampling
	temperature: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Temperature",
			description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "Deterministic" },
				{ value: "0.2", label: "0.2", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.7", label: "0.7", description: "Creative" },
				{ value: "1", label: "1", description: "Maximum variety" },
			],
		},
	},

	topP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top P",
			description: "Nucleus sampling cutoff (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.1", label: "0.1", description: "Very focused" },
				{ value: "0.3", label: "0.3", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.9", label: "0.9", description: "Broad" },
				{ value: "1", label: "1", description: "No nucleus filtering" },
			],
		},
	},

	topK: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top K",
			description: "Sample from top-K tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "1", label: "1", description: "Greedy top token" },
				{ value: "20", label: "20", description: "Focused" },
				{ value: "40", label: "40", description: "Balanced" },
				{ value: "100", label: "100", description: "Broad" },
			],
		},
	},

	minP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Min P",
			description: "Minimum probability threshold (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.01", label: "0.01", description: "Very permissive" },
				{ value: "0.05", label: "0.05", description: "Balanced" },
				{ value: "0.1", label: "0.1", description: "Strict" },
			],
		},
	},

	presencePenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Presence Penalty",
			description: "Penalty for introducing already-present tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "No penalty" },
				{ value: "0.5", label: "0.5", description: "Mild novelty" },
				{ value: "1", label: "1", description: "Encourage novelty" },
				{ value: "2", label: "2", description: "Strong novelty" },
			],
		},
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Repetition Penalty",
			description: "Penalty for repeated tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.8", label: "0.8", description: "Allow repetition" },
				{ value: "1", label: "1", description: "No penalty" },
				{ value: "1.1", label: "1.1", description: "Mild penalty" },
				{ value: "1.2", label: "1.2", description: "Balanced" },
				{ value: "1.5", label: "1.5", description: "Strong penalty" },
			],
		},
	},

	serviceTier: {
		type: "enum",
		values: ["none", "auto", "default", "flex", "scale", "priority", "openai-only", "claude-only"] as const,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Service Tier",
			description:
				'Processing priority hint (none = omit). OpenAI accepts the tier values directly; Anthropic realizes `priority` as `speed: "fast"` on supported Opus models. Scoped values target one family.',
			options: [
				{ value: "none", label: "None", description: "Omit service_tier parameter" },
				{ value: "auto", label: "Auto", description: "Use provider default tier selection (OpenAI)" },
				{ value: "default", label: "Default", description: "Standard priority processing (OpenAI)" },
				{ value: "flex", label: "Flex", description: "Flexible capacity tier when available (OpenAI)" },
				{ value: "scale", label: "Scale", description: "Scale Tier credits when available (OpenAI)" },
				{
					value: "priority",
					label: "Priority",
					description: "Priority on every supported provider (OpenAI `service_tier`, Anthropic fast mode)",
				},
				{
					value: "openai-only",
					label: "Priority (OpenAI only)",
					description: "Priority on OpenAI/OpenAI-Codex requests; ignored elsewhere",
				},
				{
					value: "claude-only",
					label: "Priority (Claude only)",
					description: "Anthropic fast mode on direct Claude requests; ignored elsewhere (incl. Bedrock/Vertex)",
				},
			],
		},
	},

	fastModeScope: {
		type: "enum",
		values: ["both", "openai", "claude"] as const,
		default: "both",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Fast Mode Scope",
			description:
				'Which providers `/fast on` (and the fast-mode toggle) target. "both" = priority on every supported provider; "openai"/"claude" scope it to one family (mirrors serviceTier openai-only/claude-only).',
			options: [
				{ value: "both", label: "Both", description: "Priority on every supported provider" },
				{
					value: "openai",
					label: "OpenAI only",
					description: "Priority on OpenAI/OpenAI-Codex requests; ignored elsewhere",
				},
				{
					value: "claude",
					label: "Claude only",
					description: "Anthropic fast mode on direct Claude requests; ignored elsewhere",
				},
			],
		},
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Attempts",
			description: "Maximum retry attempts on API errors",
			options: [
				{ value: "1", label: "1 retry" },
				{ value: "2", label: "2 retries" },
				{ value: "3", label: "3 retries" },
				{ value: "5", label: "5 retries" },
				{ value: "10", label: "10 retries" },
			],
		},
	},

	"retry.baseDelayMs": { type: "number", default: 500 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Max Retry Delay",
			description:
				"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows).",
		},
	},
	"retry.modelFallback": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Model Fallback",
			description: "Allow retry recovery to switch to configured fallback models",
		},
	},
	"retry.fallbackChains": { type: "record", default: {} as Record<string, string[]> },
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Fallback Revert Policy",
			description: "When to return to the primary model after a fallback",
			options: [
				{
					value: "cooldown-expiry",
					label: "Cooldown expiry",
					description: "Return to the primary model after its suppression window ends",
				},
				{ value: "never", label: "Never", description: "Stay on the fallback model until manually changed" },
			],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Interaction
	// ────────────────────────────────────────────────────────────────────────

	// Conversation flow
	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Steering Mode",
			description: "How to process queued messages while agent is working",
		},
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Follow-Up Mode",
			description: "How to drain follow-up messages after a turn completes",
		},
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Interrupt Mode",
			description: "When steering messages interrupt tool execution",
		},
	},

	"loop.mode": {
		type: "enum",
		values: ["prompt", "compact", "reset", "spiral"] as const,
		default: "prompt",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Loop Mode",
			description: "What happens between /loop iterations before re-submitting the prompt",
			options: [
				{
					value: "prompt",
					label: "Prompt",
					description: "Re-submit the prompt as a follow-up message (current behavior)",
				},
				{
					value: "compact",
					label: "Compact",
					description: "Compact the session context, then re-submit the prompt",
				},
				{ value: "reset", label: "Reset", description: "Start a new session, then re-submit the prompt" },
				{
					value: "spiral",
					label: "Spiral",
					description:
						"Run a verifier/synthesis step between iterations and feed the reflection into the next prompt; stop when the objective is complete",
				},
			],
		},
	},

	// Input and startup
	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "tree",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Double-Escape Action",
			description: "Action when pressing Escape twice with empty editor",
		},
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Session Tree Filter",
			description: "Default filter mode when opening the session tree",
		},
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 5,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Autocomplete Items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			options: [
				{ value: "3", label: "3 items" },
				{ value: "5", label: "5 items" },
				{ value: "7", label: "7 items" },
				{ value: "10", label: "10 items" },
				{ value: "15", label: "15 items" },
				{ value: "20", label: "20 items" },
			],
		},
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Emoji Autocomplete",
			description: "Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
		},
	},

	"paste.largeMenuThreshold": {
		type: "number",
		default: 100,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Large Paste Menu",
			description:
				"When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).",
			options: [
				{ value: "0", label: "Off" },
				{ value: "100", label: "100 lines" },
				{ value: "250", label: "250 lines" },
				{ value: "500", label: "500 lines" },
				{ value: "1000", label: "1000 lines" },
			],
		},
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Quiet Startup",
			description: "Skip welcome screen and startup status messages",
		},
	},

	"startup.showSplash": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Show Startup Splash",
			description:
				"Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.",
		},
	},

	"startup.setupWizard": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Setup Wizard",
			description: "Show newly added onboarding steps once per setup version",
		},
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Check for Updates",
			description: "Check for omp updates on startup",
		},
	},

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "notify",
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Marketplace Auto-Update",
			description: "Check for plugin updates on startup",
			options: [
				{ value: "off", label: "Off", description: "Don't check for plugin updates" },
				{ value: "notify", label: "Notify", description: "Check on startup and notify when updates are available" },
				{ value: "auto", label: "Auto", description: "Check on startup and auto-install updates" },
			],
		},
	},

	collapseChangelog: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Collapse Changelog",
			description: "Show condensed changelog after updates",
		},
	},

	"magicKeywords.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Magic Keywords",
			description: "Enable hidden notices for standalone ultrathink, orchestrate, and workflowz keywords",
		},
	},

	"magicKeywords.ultrathink": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Ultrathink Keyword",
			description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		},
	},

	"magicKeywords.orchestrate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Orchestrate Keyword",
			description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
		},
	},

	"magicKeywords.workflow": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Workflow Keyword",
			description: "Let standalone workflowz append its hidden eval workflow notice",
		},
	},

	// Notifications
	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Completion Notification",
			description: "Notify when the agent finishes a turn",
		},
	},

	"ask.timeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Ask Timeout",
			description: "Auto-select the recommended ask option after this many seconds (0 disables)",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "15", label: "15 seconds" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
			],
		},
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Ask Notification",
			description: "Notify when the ask tool is waiting for input",
		},
	},

	// Collab
	"collab.relayUrl": {
		type: "string",
		default: DEFAULT_RELAY_URL,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Relay URL",
			description: "Relay used by /collab (wss://host[:port])",
		},
	},

	"collab.webUrl": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Web UI URL",
			description:
				"Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
		},
	},

	"collab.displayName": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Display Name",
			description: "Name shown to other collab participants (default: OS username)",
		},
	},

	"share.serverUrl": {
		type: "string",
		default: DEFAULT_SHARE_URL,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Share Server",
			description:
				"Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)",
		},
	},

	"share.redactSecrets": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Share Secret Redaction",
			description: "Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)",
		},
	},

	// Hub
	"hub.relayUrl": {
		type: "string",
		default: "https://collab.pkking.computer/h",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Hub Relay URL",
			description: "Cloud-durable hub base used by /hub publish/resume (HTTPS endpoint that accepts sealed blobs)",
		},
	},

	"hub.token": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Hub Access Token",
			description:
				"Account access token for /hub. Provision once, then install it on every device you want to hand off between.",
			sensitive: true,
		},
	},

	"hub.deviceId": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Hub Device ID",
			description: "Stable per-install identifier allocated on first /hub publish.",
		},
	},

	"hub.activeId": { type: "string", default: "" },
	"hub.activeKey": { type: "string", default: "" },
	// Speech-to-text
	"stt.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "Speech-to-Text",
			description: "Enable speech-to-text input via microphone",
		},
	},

	"stt.language": {
		type: "string",
		default: "en",
	},

	"stt.modelName": {
		type: "enum",
		values: STT_MODEL_VALUES,
		default: DEFAULT_STT_MODEL_KEY,
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "Speech Model",
			description:
				"Local on-device speech model. Parakeet TDT v3 (sherpa-onnx) is the SoTA default; Whisper base/small/large-v3-turbo tiers (transformers.js) trade size for multilingual coverage. Downloaded on first use.",
			options: STT_MODEL_OPTIONS,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Context
	// ────────────────────────────────────────────────────────────────────────

	// Context promotion
	"contextPromotion.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "Auto-Promote Context",
			description: "Promote to a larger-context model on context overflow instead of compacting",
		},
	},

	// Light context layer
	"contextLayer.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Light Context",
			label: "Light Context Layer",
			description:
				"Expose a compact deterministic context-oracle tool backed by LSP, file summaries, diagnostics, and cache.",
		},
	},

	"contextLayer.model": {
		type: "string",
		default: undefined,
		ui: {
			tab: "context",
			group: "Light Context",
			label: "Context Layer Model",
			description:
				"Optional cheap model selector for future evidence summarization. Empty keeps deterministic mode.",
		},
	},

	"contextLayer.maxInputTokens": { type: "number", default: 12000 },

	"contextLayer.maxOutputTokens": { type: "number", default: 1200 },

	"contextLayer.cache": { type: "boolean", default: true },

	// Compaction
	"compaction.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Auto-Compact",
			description: "Automatically compact context when it gets too large",
		},
	},

	"compaction.strategy": {
		type: "enum",
		values: ["context-full", "handoff", "shake", "off"] as const,
		default: "context-full",
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Compaction Strategy",
			description:
				"Choose in-place context-full maintenance, auto-handoff, surgical shake (drop heavy content), or disable auto maintenance (off)",
			options: [
				{
					value: "context-full",
					label: "Context-full",
					description: "Summarize in-place and keep the current session",
				},
				{ value: "handoff", label: "Handoff", description: "Generate handoff and continue in a new session" },
				{
					value: "shake",
					label: "Shake",
					description: "Drop heavy content (tool results + large blocks) in place; recover via artifact",
				},
				{
					value: "off",
					label: "Off",
					description: "Disable automatic context maintenance (same behavior as Auto-compact off)",
				},
			],
		},
	},

	"compaction.thresholdPercent": {
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
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Compaction Token Limit",
			description: "Fixed token limit for context maintenance; overrides percentage if set",
			options: [
				{ value: "default", label: "Default", description: "Use percentage-based threshold" },
				{ value: "25000", label: "25K tokens", description: "Quarter of a 200K window" },
				{ value: "50000", label: "50K tokens", description: "Half of a 200K window" },
				{ value: "100000", label: "100K tokens", description: "Half of a 200K window" },
				{ value: "150000", label: "150K tokens", description: "Three-quarters of a 200K window" },
				{ value: "200000", label: "200K tokens", description: "Full standard context window" },
				{ value: "300000", label: "300K tokens", description: "Large context window" },
				{ value: "500000", label: "500K tokens", description: "Very large context window" },
			],
		},
	},

	"compaction.handoffSaveToDisk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Save Handoff Docs",
			description: "Save generated handoff documents to markdown files for the auto-handoff flow",
		},
	},

	"compaction.remoteEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Remote Compaction",
			description: "Use remote compaction endpoints when available instead of local summarization",
		},
	},

	"compaction.reserveTokens": { type: "number", default: 16384 },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	// Idle compaction
	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Idle Compaction",
			description: "Compact context while idle when token count exceeds threshold",
		},
	},

	"compaction.idleThresholdTokens": {
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
	},

	"compaction.idleTimeoutSeconds": {
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
	},

	"compaction.supersedeReads": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Supersede Stale Reads",
			description: "Prune older read results when the same file is read again (cache-aware, runs every turn)",
		},
	},

	"compaction.dropUseless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Elide Uneventful Results",
			description:
				"Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)",
		},
	},

	"compaction.maskConsumedObservations": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Mask Consumed Observations",
			description:
				"Replace tool results the model has already acted on with short placeholders (e.g. '[bash result consumed]'). Deterministic and cache-aware; preserves reasoning traces.",
		},
	},

	// Optional user-level general background packs. Runtime reads these from
	// persisted global settings only; project config and overrides are ignored.
	"backgroundPacks.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Background Packs",
			label: "Image Background Packs",
			description:
				"Attach qualified, non-authoritative image background packs from explicit user-level manifests. Active instructions and conversation context always remain native text.",
		},
	},

	"backgroundPacks.manifests": {
		type: "array",
		default: [] as string[],
	},

	"tools.format": {
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
			"pi",
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
				"Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect. Applies on session start.",
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
				{ value: "pi", label: "Pi", description: "Use the Pi owned dialect (compact sigil-delimited tool calls)." },
				{ value: "qwen3", label: "Qwen3", description: "Use the Qwen3 owned dialect." },
				{ value: "gemini", label: "Gemini", description: "Use the Gemini owned dialect." },
				{ value: "gemma", label: "Gemma", description: "Use the Gemma owned dialect." },
				{ value: "minimax", label: "MiniMax", description: "Use the MiniMax owned dialect." },
			],
		},
	},

	// Branch summaries
	"branchSummary.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "Branch Summaries",
			description: "Prompt to summarize when leaving a branch",
		},
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	// Memories
	// Legacy local-memory enable flag kept only for back-compat migration.
	// Hidden from UI — users should use `memory.backend` instead.
	"memories.enabled": {
		type: "boolean",
		default: false,
	},

	"memories.maxRolloutsPerStartup": { type: "number", default: 64 },

	"memories.maxRolloutAgeDays": { type: "number", default: 30 },

	"memories.minRolloutIdleHours": { type: "number", default: 12 },

	"memories.threadScanLimit": { type: "number", default: 300 },

	"memories.maxRawMemoriesForGlobal": { type: "number", default: 200 },

	"memories.stage1Concurrency": { type: "number", default: 8 },

	"memories.stage1LeaseSeconds": { type: "number", default: 120 },

	"memories.stage1RetryDelaySeconds": { type: "number", default: 120 },

	"memories.phase2LeaseSeconds": { type: "number", default: 180 },

	"memories.phase2RetryDelaySeconds": { type: "number", default: 180 },

	"memories.phase2HeartbeatSeconds": { type: "number", default: 30 },

	"memories.rolloutPayloadPercent": { type: "number", default: 0.7 },

	"memories.phase1InputTokenLimit": { type: "number", default: 4000 },

	"memories.fallbackTokenLimit": { type: "number", default: 16000 },

	"memories.summaryInjectionTokenLimit": { type: "number", default: 5000 },

	// Memory backend selector — picks between local memories pipeline,
	// Mnemopi local SQLite, Hindsight remote memory, or off. Legacy
	// `memories.enabled` keeps gating the local backend; see config/settings.ts
	// migration for details.
	"memory.backend": {
		type: "enum",
		values: ["off", "local", "hindsight", "mnemopi"] as const,
		default: "off",
		ui: {
			tab: "memory",
			group: "General",
			label: "Memory Backend",
			description: "Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory",
			options: [
				{ value: "off", label: "Off", description: "No memory subsystem runs" },
				{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
				{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
				{
					value: "mnemopi",
					label: "Mnemopi",
					description: "Local SQLite recall/retain backend with optional embeddings",
				},
			],
		},
	},

	// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
	// and mint/enhance isolated managed skills under ~/.omp/agent/managed-skills.
	// Master flag is default-off → zero footprint; sub-flags gate behaviour.
	"autolearn.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Auto-Learn",
			label: "Auto-Learn (experimental)",
			description:
				"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills",
		},
	},
	"autolearn.autoContinue": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Auto-Learn",
			label: "Auto-run capture at stop",
			description:
				"When on, auto-run one capture turn at stop (uses extra tokens). Off = passive reminder on your next turn.",
			condition: "autolearnActive",
		},
	},
	// Config-file-only knob (numbers without `options` are hidden from the UI).
	"autolearn.minToolCalls": { type: "number", default: 5 },

	// Mnemopi local SQLite memory backend.
	"mnemopi.dbPath": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi DB Path",
			description: "Optional SQLite DB path. Defaults to the agent memories directory.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.bank": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Bank",
			description: "Optional shared bank base name. Per-project modes derive project-local banks from it.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility",
			options: [
				{
					value: "global",
					label: "Global",
					description: "One shared Mnemopi bank for every project",
				},
				{
					value: "per-project",
					label: "Per project",
					description: "Project-local Mnemopi bank per cwd basename",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description: "Write to a project-local bank but merge project + shared recall results",
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingVariant": {
		type: "enum",
		values: ["en", "multilingual"] as const,
		default: "en",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Embedding variant",
			description:
				"Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.",
			options: [
				{
					value: "en",
					label: "English (bge-base-en-v1.5)",
					description: "BAAI/bge-base-en-v1.5 (768d), English-only",
				},
				{
					value: "multilingual",
					label: "Multilingual (multilingual-e5-large)",
					description: "intfloat/multilingual-e5-large (1024d), cross-language recall",
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Auto Recall",
			description: "Recall local memories into the first turn of each session",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Auto Retain",
			description: "Retain completed conversation turns into local Mnemopi memory",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.polyphonicRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Polyphonic Recall",
			description: "Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.enhancedRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Enhanced Recall",
			description: "Enable the tiered query result cache for repeated and similar recall queries",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.noEmbeddings": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Disable Embeddings",
			description: "Force deterministic FTS-only recall instead of vector embeddings",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding Model",
			description:
				"Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding API URL",
			description: "Optional OpenAI-compatible embedding endpoint passed to Mnemopi",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiKey": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding API Key",
			description: "Optional embedding API key passed to Mnemopi",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmMode": {
		type: "enum",
		values: ["none", "smol", "remote"] as const,
		default: "smol",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Mode",
			description: "Use no LLM, the configured smol model, or a remote OpenAI-compatible endpoint",
			condition: "mnemopiActive",
			options: [
				{ value: "none", label: "None", description: "Disable Mnemopi LLM-backed extraction" },
				{ value: "smol", label: "Smol", description: "Use the configured pi-ai smol model" },
				{ value: "remote", label: "Remote", description: "Use the Mnemopi remote LLM settings below" },
			],
		},
	},
	"mnemopi.llmBaseUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Base URL",
			description: "Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmApiKey": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM API Key",
			description: "Optional LLM API key for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Model",
			description: "Optional LLM model name for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.retainEveryNTurns": { type: "number", default: 4 },
	"mnemopi.recallLimit": { type: "number", default: 4 },
	"mnemopi.recallContextTurns": { type: "number", default: 1 },
	"mnemopi.recallMaxQueryChars": { type: "number", default: 1200 },
	"mnemopi.injectionTokenLimit": { type: "number", default: 1000 },
	"mnemopi.debug": { type: "boolean", default: false },

	// WikiGraph Lite sidecar wiki index.
	"wikigraph.enabled": { type: "boolean", default: true },
	"wikigraph.roots": { type: "array", of: "string", default: ["~/.omp/agent/wiki", "<cwd>/.omp/wiki"] },
	"wikigraph.maxNodesPerResolve": { type: "number", default: 8 },
	"wikigraph.maxCharsPerResolve": { type: "number", default: 1200 },
	"wikigraph.factModel": { type: "string", default: "auto" },
	"wikigraph.factsPerSection": { type: "number", default: 5 },
	"wikigraph.factMinConfidence": { type: "number", default: 0.6 },

	// Opt-in progressive-disclosure trace/offload for compaction summaries.
	"offloadTrace.enabled": { type: "boolean", default: false },
	"offloadTrace.maxCanvasChars": { type: "number", default: 2000 },
	"offloadTrace.maxNodes": { type: "number", default: 24 },
	"offloadTrace.rawArtifactMinChars": { type: "number", default: 4000 },

	// Hindsight (https://hindsight.vectorize.io)
	"hindsight.apiUrl": {
		type: "string",
		default: "http://localhost:8888",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight API URL",
			description: "Hindsight server URL (Cloud or self-hosted)",
			condition: "hindsightActive",
		},
	},

	"hindsight.apiToken": { type: "string", default: undefined },

	"hindsight.bankId": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Bank ID",
			description: "Memory bank identifier (default: project name)",
			condition: "hindsightActive",
		},
	},

	"hindsight.bankIdPrefix": { type: "string", default: undefined },
	"hindsight.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project-tagged",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
			options: [
				{
					value: "global",
					label: "Global",
					description: "One shared bank — every project sees the same memories",
				},
				{
					value: "per-project",
					label: "Per project",
					description: "Isolated bank per cwd basename — projects cannot see each other's memories",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description:
						"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
				},
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.bankMission": { type: "string", default: undefined },
	"hindsight.retainMission": { type: "string", default: undefined },

	"hindsight.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Auto Recall",
			description: "Recall memories on the first turn of each session",
			condition: "hindsightActive",
		},
	},
	"hindsight.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Auto Retain",
			description: "Retain transcript every N turns and at session boundaries",
			condition: "hindsightActive",
		},
	},

	"hindsight.retainMode": {
		type: "enum",
		values: ["full-session", "last-turn"] as const,
		default: "full-session",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Retain Mode",
			description: "full-session = upsert one document per session, last-turn = chunked",
			options: [
				{
					value: "full-session",
					label: "Full session",
					description: "Upsert one document per session (recommended)",
				},
				{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.retainEveryNTurns": { type: "number", default: 3 },
	"hindsight.retainOverlapTurns": { type: "number", default: 2 },
	"hindsight.retainContext": { type: "string", default: "omp" },

	"hindsight.recallBudget": {
		type: "enum",
		values: ["low", "mid", "high"] as const,
		default: "mid",
	},
	"hindsight.recallMaxTokens": { type: "number", default: 1024 },
	"hindsight.recallContextTurns": { type: "number", default: 1 },
	"hindsight.recallMaxQueryChars": { type: "number", default: 800 },
	"hindsight.recallTypes": { type: "array", default: HINDSIGHT_RECALL_TYPES_DEFAULT },

	"hindsight.debug": { type: "boolean", default: false },

	"hindsight.mentalModelsEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Mental Models",
			description:
				"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelAutoSeed": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Mental Model Auto-Seed",
			description:
				"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelRefreshIntervalMs": { type: "number", default: 5 * 60 * 1000 },
	"hindsight.mentalModelMaxRenderChars": { type: "number", default: 16_000 },

	// TTSR
	"ttsr.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR",
			description: "Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)",
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Context Mode",
			description: "What to do with partial output when TTSR triggers",
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Interrupt Mode",
			description: "When to interrupt mid-stream vs inject warning after completion",
			options: [
				{ value: "always", label: "always", description: "Interrupt on prose and tool streams" },
				{ value: "prose-only", label: "prose-only", description: "Interrupt only on reply/thinking matches" },
				{ value: "tool-only", label: "tool-only", description: "Interrupt only on tool-call argument matches" },
				{ value: "never", label: "never", description: "Never interrupt; inject warning after completion" },
			],
		},
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Repeat Mode",
			description: "How rules can repeat: once per session or after a message gap",
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR Repeat Gap",
			description: "Messages before a rule can trigger again",
			options: [
				{ value: "5", label: "5 messages" },
				{ value: "10", label: "10 messages" },
				{ value: "15", label: "15 messages" },
				{ value: "20", label: "20 messages" },
				{ value: "30", label: "30 messages" },
			],
		},
	},

	"ttsr.builtinRules": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "Built-in Rules",
			description: "Load the default rules shipped with the agent (override individually with ttsr.disabledRules)",
		},
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "Disabled Rules",
			description: "Rule names to ignore entirely (applies to bundled defaults and your own rules)",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Editing
	// ────────────────────────────────────────────────────────────────────────

	// Edit tool
	"edit.mode": {
		type: "enum",
		values: EDIT_MODES,
		default: "hashline",
		ui: {
			tab: "files",
			group: "Editing",
			label: "Edit Mode",
			description: "Select the edit tool variant (replace, patch, hashline, or apply_patch)",
		},
	},

	"edit.fuzzyMatch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Fuzzy Match",
			description: "Accept high-confidence fuzzy matches for whitespace differences",
		},
	},

	"edit.fuzzyThreshold": {
		type: "number",
		default: 0.95,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Fuzzy Match Threshold",
			description: "Similarity threshold (0-1) for accepting fuzzy matches",
			options: [
				{ value: "0.85", label: "0.85", description: "Lenient" },
				{ value: "0.90", label: "0.90", description: "Moderate" },
				{ value: "0.95", label: "0.95", description: "Default" },
				{ value: "0.98", label: "0.98", description: "Strict" },
			],
		},
	},

	"edit.streamingAbort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Abort on Failed Preview",
			description: "Abort streaming edit tool calls when patch preview fails",
		},
	},

	"edit.blockAutoGenerated": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Editing",
			label: "Block Auto-Generated Files",
			description: "Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)",
		},
	},

	readLineNumbers: {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Line Numbers",
			description: "Prepend line numbers to read tool output by default",
		},
	},

	readHashLines: {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Hash Lines",
			description:
				"Include snapshot-tag headers and line numbers in read output for hashline edit mode ([PATH#TAG] plus LINE:content)",
		},
	},

	"read.defaultLimit": {
		type: "number",
		default: 300,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Default Read Limit",
			description: "Default number of lines returned when agent calls read without a limit",
			options: [
				{ value: "200", label: "200 lines" },
				{ value: "300", label: "300 lines" },
				{ value: "500", label: "500 lines" },
				{ value: "1000", label: "1000 lines" },
				{ value: "5000", label: "5000 lines" },
			],
		},
	},

	"read.summarize.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summaries",
			description: "Return structural code summaries when read is called without an explicit selector",
		},
	},

	"read.summarize.prose": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Prose Summaries",
			description: "Return structural summaries for Markdown and plain text reads",
		},
	},

	"read.summarize.minBodyLines": {
		type: "number",
		default: 4,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Body Lines",
			description: "Minimum multiline body or literal length before read summaries collapse it",
		},
	},

	"read.summarize.minCommentLines": {
		type: "number",
		default: 6,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Comment Lines",
			description: "Minimum multiline block comment length before read summaries collapse it",
		},
	},

	"read.summarize.minTotalLines": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Minimum File Length",
			description: "Files with fewer total lines are read verbatim instead of structurally summarized",
		},
	},

	"read.summarize.unfoldUntil": {
		type: "number",
		default: 50,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Unfold Target",
			description:
				"BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.",
		},
	},

	"read.summarize.unfoldLimit": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "Read Summary Unfold Ceiling",
			description:
				"Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans.",
		},
	},

	"read.toolResultPreview": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Inline Read Previews",
			description: "Render read tool results inline in the transcript instead of summary rows",
		},
	},

	// LSP
	"lsp.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "LSP",
			description: "Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename)",
		},
	},

	"lsp.lazy": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "Lazy LSP Startup",
			description:
				"Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup",
		},
	},

	"lsp.formatOnWrite": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "LSP",
			label: "Format on Write",
			description: "Automatically format code files using LSP after writing",
		},
	},

	"lsp.diagnosticsOnWrite": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "Diagnostics on Write",
			description: "Return LSP diagnostics after writing code files",
		},
	},

	"lsp.diagnosticsOnEdit": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "LSP",
			label: "Diagnostics on Edit",
			description: "Return LSP diagnostics after editing code files",
		},
	},

	"lsp.diagnosticsDeduplicate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "Deduplicate Diagnostics",
			description: "Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones",
		},
	},

	"bash.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash",
			description: "Enable the bash tool for shell command execution",
		},
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash Auto-Background",
			description: "Automatically background long-running bash commands and deliver the result later",
		},
	},

	// Bash interceptor
	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash Interceptor",
			description: "Block shell commands that have dedicated tools",
		},
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

	"bash.stripTrailingHeadTail": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Strip head/tail Pipes",
			description:
				"Silently drop trailing `| head`/`| tail` pipes from single-line bash commands. Output is already truncated automatically.",
		},
	},

	// Shell output minimizer
	"shellMinimizer.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Shell Minimizer",
			description: "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent",
		},
	},
	"shellMinimizer.settingsPath": {
		type: "string",
		default: undefined,
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
	},
	"shellMinimizer.sourceOutlineLevel": {
		type: "enum",
		values: ["default", "aggressive"] as const,
		default: "default",
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Shell Minimizer Source Outline",
			description: "Source outline mode for cat/read of source files: default or aggressive",
		},
	},
	"shellMinimizer.legacyFilters": {
		type: "boolean",
		default: undefined,
	},

	// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
	"eval.py": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Eval & Python",
			label: "Python Eval Backend",
			description: "Allow the eval tool to dispatch Python cells to the IPython kernel",
		},
	},

	"eval.js": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Eval & Python",
			label: "JavaScript Eval Backend",
			description: "Allow the eval tool to dispatch JavaScript cells to the in-process runtime",
		},
	},

	// Python kernel knobs (consumed by the eval py backend and the /python slash command)
	"python.kernelMode": {
		type: "enum",
		values: ["session", "per-call"] as const,
		default: "session",
		ui: {
			tab: "shell",
			group: "Eval & Python",
			label: "Python Kernel Mode",
			description: "Keep the IPython kernel alive across eval calls or start fresh each time",
		},
	},
	"python.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: "Eval & Python",
			label: "Python Interpreter",
			description:
				"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Tool approval policies
	"tools.approval": {
		type: "record",
		default: {},
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "Tool Approval Policies",
			description:
				"Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.",
		},
	},

	// Default tool approval mode (interaction tab, but governs the tool wrapper).
	//   "always-ask" — auto-approves read-tier tools only; prompts for write/exec.
	//   "write"      — auto-approves read and write-tier tools; prompts for exec.
	//   "yolo"       — auto-approves every tier.
	"tools.approvalMode": {
		type: "enum",
		values: ["always-ask", "write", "yolo"] as const,
		default: "yolo",
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "Tool Approval",
			description:
				"Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.",
			options: [
				{
					value: "always-ask",
					label: "Always ask",
					description: "Auto-approve read-only tools; require confirmation for write and exec tools.",
				},
				{
					value: "write",
					label: "Write",
					description:
						"Auto-approve read-only and write tools; require confirmation for exec tools such as bash, eval, browser, task, and ssh.",
				},
				{
					value: "yolo",
					label: "Yolo",
					description:
						"Auto-approve read, write, and exec tools. User policy can still require confirmation or block calls.",
				},
			],
		},
	},

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Todos",
			description: "Enable the todo tool for task tracking",
		},
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Reminders",
			description: "Remind the agent to complete todos before stopping",
		},
	},

	"todo.reminders.max": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Reminder Limit",
			description: "Maximum number of todo reminders before giving up",
			options: [
				{ value: "1", label: "1 reminder" },
				{ value: "2", label: "2 reminders" },
				{ value: "3", label: "3 reminders" },
				{ value: "5", label: "5 reminders" },
			],
		},
	},

	"todo.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Create Todos Automatically",
			description: "How strongly to push automatic todo-list creation after the first message",
			options: [
				{ value: "default", label: "Default", description: "Model decides; no automatic todo list" },
				{
					value: "preferred",
					label: "Preferred",
					description: "Suggests a todo list on the first message (reminder, not forced)",
				},
				{ value: "always", label: "Always", description: "Forces a comprehensive todo list on the first message" },
			],
		},
	},

	// Search and AST tools
	"find.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Find",
			description: "Enable the find tool for glob-based file lookup",
		},
	},

	"search.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Search",
			description: "Enable the search tool for regex content search",
		},
	},

	"search.contextBefore": {
		type: "number",
		default: 1,
		ui: {
			tab: "tools",
			group: "Search & Browser",
			label: "Search Context Before",
			description: "Lines of context before each search match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
			],
		},
	},

	"search.contextAfter": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Search & Browser",
			label: "Search Context After",
			description: "Lines of context after each search match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
				{ value: "10", label: "10 lines" },
			],
		},
	},

	"astGrep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "AST Grep",
			description: "Enable the ast_grep tool for structural AST search",
		},
	},

	"astEdit.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "AST Edit",
			description: "Enable the ast_edit tool for structural AST rewrites",
		},
	},

	// Optional tools

	"debug.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Debug",
			description: "Enable the debug tool for DAP-based debugging",
		},
	},

	"speechgen.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Speech Generation",
			description: "Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis",
		},
	},

	"inspect_image.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Inspect Image",
			description: "Enable the inspect_image tool, delegating image understanding to a vision-capable model",
		},
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Checkpoint/Rewind",
			description: "Enable the checkpoint and rewind tools for context checkpointing",
		},
	},

	// Fetching and browser
	"fetch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Read URLs",
			description: "Allow the read tool to fetch and process URLs",
		},
	},

	"vault.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Obsidian Vault",
			description:
				"Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.",
		},
	},

	"github.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "GitHub CLI",
			description:
				"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)",
		},
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub View Cache",
			description: "Cache rendered issue/PR view output in ~/.omp/cache/github-cache.db so repeated reads are free",
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub Cache Soft TTL",
			description:
				"Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)",
		},
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub Cache Hard TTL",
			description:
				"Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)",
		},
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Web Search",
			description: "Enable the web_search tool for live web results",
		},
	},

	"browser.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Browser",
			description: "Enable the browser tool for scripted Chromium automation (puppeteer)",
		},
	},

	"ix_bridge.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "IX Bridge",
			description:
				"Enable the ix_bridge tool for local IX Bridge browser automation (daemon + extension at http://127.0.0.1:18086)",
		},
	},

	"browser.headless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Search & Browser",
			label: "Headless Browser",
			description: "Launch browser in headless mode (disable to show browser UI)",
		},
	},

	"browser.cmux": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Search & Browser",
			label: "cmux Browser",
			description:
				"Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override.",
		},
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Search & Browser",
			label: "Screenshot Directory",
			description:
				"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
		},
	},

	// Tool execution
	"tools.intentTracing": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Intent Tracing",
			description: "Ask the agent to describe the intent of each tool call before executing it",
		},
	},
	"tools.abortOnFabricatedResult": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Abort On Fabricated Tool Result",
			description:
				"With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.",
		},
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Max Tool Timeout",
			description: "Maximum timeout in seconds the agent can set for any tool (0 = no limit)",
			options: [
				{ value: "0", label: "No limit" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
			],
		},
	},

	// Async jobs
	"async.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Async Execution",
			description: "Enable async bash commands and background task execution",
		},
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m", "smart"] as const,
		default: "smart",
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Max Poll Time",
			description:
				"How long the poll tool waits for background job updates before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 5s and lengthens with each back-to-back poll (up to 5m), then resets to 5s after about a minute without polling.",
			options: [
				{ value: "5s", label: "5 seconds" },
				{ value: "10s", label: "10 seconds" },
				{ value: "30s", label: "30 seconds" },
				{ value: "1m", label: "1 minute" },
				{ value: "5m", label: "5 minutes" },
				{ value: "smart", label: "Smart", description: "Default — adaptive 5s→5m, resets when you stop polling" },
			],
		},
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "IRC Timeout",
			description: "Default timeout for irc wait (and send await:true) in milliseconds; 0 disables the timeout",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "30000", label: "30 seconds" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
				{ value: "300000", label: "5 minutes" },
			],
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	// Tool Discovery
	"tools.discoveryMode": {
		type: "enum",
		values: ["auto", "off", "mcp-only", "all"] as const,
		default: "all",
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "Tool Discovery",
			description:
				"Hide tools behind a search tool to save tokens. 'all' (default) hides all non-essential built-ins and MCP tools; 'auto' hides MCP tools once the tool set has more than 40 tools; 'mcp-only' always hides MCP tools; 'off' sends everything.",
		},
	},

	"tools.essentialOverride": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "Essential Tools Override",
			description:
				"Override the always-loaded built-in tools (default: read, bash, edit, find, search, write, todo). Leave empty to use defaults.",
		},
	},

	// MCP
	"mcp.enableProjectConfig": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Project Config",
			description: "Load .mcp.json/mcp.json from project root",
		},
	},

	"mcp.discoveryMode": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Tool Discovery",
			description: "Hide MCP tools by default and expose them through a tool discovery tool",
		},
	},

	"mcp.discoveryDefaultServers": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Discovery Default Servers",
			description: "Keep MCP tools from these servers visible while discovery mode hides other MCP tools",
		},
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Update Injection",
			description: "Inject MCP resource updates into the agent conversation",
		},
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Notification Debounce",
			description:
				"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tasks
	// ────────────────────────────────────────────────────────────────────────

	// Plan mode
	"plan.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Plan Mode",
			description: "Enable plan mode for read-only exploration and planning before execution",
		},
	},

	"plan.defaultOnStartup": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Start in Plan Mode",
			description: "Automatically enter plan mode at the start of every new session",
			condition: "planModeEnabled",
		},
	},

	"goal.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Mode",
			description: "Enable per-session goal mode and the hidden goal tool",
		},
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Status in Footer",
			description: "Show token budget alongside the goal indicator in the status line",
		},
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Continuation Modes",
			description: "Run modes where active goals may auto-continue between turns",
		},
	},

	// Ethereal Workspaces
	"workspace.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Ethereal Workspaces",
			description: "Run top-level agent sessions inside a disposable temporary copy of the current repository.",
		},
	},

	"workspace.mode": {
		type: "enum",
		values: WORKSPACE_MODE_VALUES,
		default: "copy",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Workspace Mode",
			description:
				"Auto prefers reflink copy for Git repos, then git worktree with a dirty overlay, and falls back to copy for non-Git repos.",
			options: [
				{ value: "auto", label: "Auto", description: "Use reflink copy when available, otherwise git worktree" },
				{ value: "copy", label: "Copy", description: "Safe full copy with cache and secret exclusions" },
				{ value: "worktree", label: "Git Worktree", description: "Fast git worktree plus dirty-file overlay" },
			],
		},
	},

	"workspace.root": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Workspace Root",
			description: "Directory where Ethereal Workspaces are created. Defaults to the OS temp directory.",
		},
	},

	"workspace.preserve": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Preserve Workspace",
			description: "Keep Ethereal Workspaces after runs instead of deleting them.",
		},
	},

	"workspace.copyEnv": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Copy Env Files",
			description: "Copy common repo .env files into Ethereal Workspaces. Disabled by default for safety.",
		},
	},

	"workspace.envFiles": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
	},

	"workspace.secretFiles": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
	},

	"workspace.secretAllowlist": {
		type: "string",
		default: undefined,
	},

	"workspace.exportPatch": {
		type: "string",
		default: undefined,
	},

	"workspace.name": {
		type: "string",
		default: undefined,
	},

	// Git worktrees
	"worktree.base": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Worktree Base Directory",
			description:
				"Directory where agent-managed git worktrees are created (absolute or ~-relative). Defaults to ~/.omp/wt; the OMP_WORKTREE_DIR env var takes precedence.",
		},
	},

	// Delegation
	"task.isolation.mode": {
		type: "enum",
		values: [
			"none",
			"auto",
			"apfs",
			"btrfs",
			"zfs",
			"reflink",
			"overlayfs",
			"projfs",
			"block-clone",
			"rcopy",
		] as const,
		default: "none",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Isolation Mode",
			description:
				'Isolation backend for subagents. "auto" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).',
			options: [
				{ value: "none", label: "None", description: "No isolation" },
				{ value: "auto", label: "Auto", description: "Let the PAL pick the best available backend" },
				{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
				{ value: "btrfs", label: "btrfs", description: "btrfs subvolume snapshot" },
				{ value: "zfs", label: "ZFS", description: "ZFS snapshot + clone" },
				{ value: "reflink", label: "Reflink", description: "Linux FICLONE per-file reflink" },
				{
					value: "overlayfs",
					label: "Overlayfs",
					description: "Linux kernel overlay (or fuse-overlayfs fallback)",
				},
				{ value: "projfs", label: "ProjFS", description: "Windows Projected File System" },
				{
					value: "block-clone",
					label: "Block clone",
					description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
				},
				{
					value: "rcopy",
					label: "Recursive copy",
					description: "git worktree if available, otherwise recursive copy",
				},
			],
		},
	},

	"task.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Isolation Merge Strategy",
			description: "How isolated task changes are integrated (patch apply or branch merge)",
			options: [
				{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
				{ value: "branch", label: "Branch", description: "Commit per task, merge with --no-ff" },
			],
		},
	},

	"task.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Isolation Commit Style",
			description: "Commit message style for nested repo changes (generic or AI-generated)",
			options: [
				{ value: "generic", label: "Generic", description: "Static commit message" },
				{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
			],
		},
	},

	"task.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Prefer Task Delegation",
			description: "How strongly to push delegating work to subagents",
			options: [
				{ value: "default", label: "Default", description: "Model decides when to delegate" },
				{ value: "preferred", label: "Preferred", description: "Adds delegation guidance to the system prompt" },
				{ value: "always", label: "Always", description: "Prompt guidance plus a first-turn delegation reminder" },
			],
		},
	},

	"task.batch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Batch Task Calls",
			description:
				"Switch the task tool to its batch shape: one call carries { agent, context, tasks[] } — one subagent per item (with per-item isolation) and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema.",
		},
	},

	"task.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Max Concurrent Tasks",
			description: "Maximum number of subagents running concurrently",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "1", label: "1 task" },
				{ value: "2", label: "2 tasks" },
				{ value: "4", label: "4 tasks" },
				{ value: "8", label: "8 tasks" },
				{ value: "16", label: "16 tasks" },
				{ value: "32", label: "32 tasks" },
				{ value: "64", label: "64 tasks" },
			],
		},
	},

	"task.enableLsp": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "LSP in Subagents",
			description:
				"Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.",
		},
	},

	"task.prefetch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Subagent Evidence Prefetch",
			description:
				"Inject deterministic local file:line candidates into opted-in subagents before their first turn. Disable to fall back to the normal model-only subagent prompt.",
		},
	},

	"task.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Max Task Recursion",
			description: "How many levels deep subagents can spawn their own subagents",
			options: [
				{ value: "-1", label: "Unlimited" },
				{ value: "0", label: "None" },
				{ value: "1", label: "Single" },
				{ value: "2", label: "Double" },
				{ value: "3", label: "Triple" },
			],
		},
	},

	"task.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Max Subagent Runtime",
			description:
				"Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.",
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "300000", label: "5 minutes" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
		},
	},

	"task.agentIdleTtlMs": {
		type: "number",
		default: 420_000,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Agent Idle TTL",
			description:
				"How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit.",
		},
	},

	"task.softRequestBudget": {
		type: "number",
		default: 90,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Soft Subagent Request Budget",
			description:
				"Soft per-subagent request budget (assistant requests per run). Crossing it injects one steering notice asking the subagent to wrap up; at 1.5x the budget the run is aborted gracefully, salvaging partial output. 0 disables the guard. Bundled explore/quick_task agents use a lower built-in budget.",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "40", label: "40 requests" },
				{ value: "90", label: "90 requests", description: "Default" },
				{ value: "150", label: "150 requests" },
			],
		},
	},

	"task.disabledAgents": {
		type: "array",
		default: [] as string[],
	},

	"task.agentModelOverrides": {
		type: "record",
		default: {} as Record<string, string>,
	},

	/**
	 * Named execution policies for spawned agents. Keys are stable agent ids,
	 * agent types, or workflow/default sentinels. Resolve with agent-id →
	 * agent-type → workflow/default precedence; absent policies preserve
	 * unrestricted legacy behavior. The optional router enable flag lives only
	 * in llm-router extension config (Lane D).
	 */
	"task.agentPolicies": {
		type: "record",
		default: EMPTY_AGENT_POLICIES,
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Auto-Clear Delay",
			description: "Delay before completed or abandoned todos are removed from the todo widget",
			options: [
				{ value: "0", label: "Instant" },
				{ value: "60", label: "1 minute", description: "Default" },
				{ value: "300", label: "5 minutes" },
				{ value: "900", label: "15 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
				{ value: "-1", label: "Never" },
			],
		},
	},

	"task.showResolvedModelBadge": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Resolved Model Badge",
			description: "Display the actual model ID used by each subagent in the task widget status line",
		},
	},

	/**
	 * Per-key aliases used by `/subagent using <alias> <task>`. Keys are matched
	 * case-, space-, and hyphen-insensitively; values are concrete catalog
	 * selectors (`<provider>/<model>`, optionally with `:thinkingLevel`).
	 */
	"subagent.modelAliases": {
		type: "record",
		default: {} as Record<string, string>,
	},

	/**
	 * Delegate slash-command configuration.
	 * `delegate.mode` selects the implementation: "subagents" (native) or
	 * "legacy-endpoint" (external dispatch-endpoint.mjs script).
	 */
	"delegate.enabled": {
		type: "boolean",
		default: true,
	},

	"delegate.promptModel": {
		type: "string",
		default: "pi/smol",
	},

	"delegate.lanes": {
		type: "record",
		default: {} as Record<string, string>,
	},

	"delegate.verifierModel": {
		type: "string",
		default: "pi/task",
	},

	"delegate.synthesizerModel": {
		type: "string",
		default: "pi/slow",
	},

	"delegate.mode": {
		type: "enum",
		values: ["subagents", "legacy-endpoint"] as const,
		default: "subagents",
	},

	"delegate.legacyEndpointConfigPath": {
		type: "string",
		default: "~/.claude/custom-endpoint.json",
	},

	// Skills
	"skills.enabled": { type: "boolean", default: true },
	"skills.projectOnly": { type: "boolean", default: false },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Skill Commands",
			description: "Register skills as /skill:name commands",
		},
	},

	"skills.enableCodexUser": { type: "boolean", default: true },

	"skills.enableClaudeUser": { type: "boolean", default: true },

	"skills.enableClaudeProject": { type: "boolean", default: true },

	"skills.enablePiUser": { type: "boolean", default: true },

	"skills.enablePiProject": { type: "boolean", default: true },

	"skills.enableAgentsUser": { type: "boolean", default: true },

	"skills.enableAgentsProject": { type: "boolean", default: true },

	"skills.enableBuiltinSkills": { type: "boolean", default: true },

	"skills.customDirectories": { type: "array", default: [] as string[] },

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

	"skills.discoveryMode": {
		type: "enum",
		values: ["lazy"] as const,
		default: "lazy",
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Skill Prompt Injection",
			description:
				"Skill descriptions are request-only to preserve context. The agent searches descriptions on demand with skill://?q=... and reads the selected skill explicitly.",
			options: [
				{
					value: "lazy",
					label: "Lazy",
					description: "Never inject skill descriptions; search on demand with `skill://?q=<keywords>`.",
				},
			],
		},
	},

	// Commands
	"commands.enableClaudeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude User Commands",
			description: "Load commands from ~/.claude/commands/",
		},
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude Project Commands",
			description: "Load commands from .claude/commands/",
		},
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode User Commands",
			description: "Load commands from ~/.config/opencode/commands/",
		},
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode Project Commands",
			description: "Load commands from .opencode/commands/",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Providers
	// ────────────────────────────────────────────────────────────────────────

	// Secret handling
	"secrets.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Privacy",
			label: "Hide Secrets",
			description: "Obfuscate secrets before sending to AI providers",
		},
	},

	// Provider selection
	"providers.webSearch": {
		type: "enum",
		values: SEARCH_PROVIDER_PREFERENCES,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Web Search Provider",
			description: "Preferred provider for the web_search tool",
			options: SEARCH_PROVIDER_OPTIONS,
		},
	},
	"providers.webSearchExclude": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "Excluded Web Search Providers",
			description: "Providers that web_search should never use, even as fallbacks",
		},
	},
	"providers.antigravityEndpoint": {
		type: "enum",
		values: ["auto", "production", "sandbox"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Antigravity Endpoint Mode",
			description: "Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Try production endpoint, fail over to sandbox on 5xx/429",
				},
				{
					value: "production",
					label: "Production Only",
					description: "Force production endpoint only",
				},
				{
					value: "sandbox",
					label: "Sandbox Only",
					description: "Force sandbox endpoint only",
				},
			],
		},
	},
	"providers.image": {
		type: "enum",
		values: ["auto", "openai", "antigravity", "xai", "gemini", "openrouter"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Image Provider",
			description: "Preferred provider for image generation",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: GPT model image tool > Antigravity > xAI > OpenRouter > Gemini",
				},
				{ value: "openai", label: "OpenAI", description: "Uses the active GPT Responses/Codex model" },
				{
					value: "antigravity",
					label: "Antigravity",
					description: "Requires google-antigravity OAuth",
				},
				{
					value: "xai",
					label: "xAI Grok Imagine",
					description: "Requires xAI Grok OAuth or XAI_API_KEY",
				},
				{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
				{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
			],
		},
	},
	"providers.tts": {
		type: "enum",
		values: ["auto", "local", "xai"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Text-to-Speech Provider",
			description: "Backend for the tts tool: local on-device neural TTS (Kokoro-82M) or xAI Grok Voice",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Prefer local on-device TTS; route .mp3 output to xAI when credentials exist",
				},
				{ value: "local", label: "Local", description: "On-device neural TTS (Kokoro-82M); output is WAV/PCM16" },
				{
					value: "xai",
					label: "xAI Grok Voice",
					description: "Requires xAI Grok OAuth or XAI_API_KEY; MP3 or WAV",
				},
			],
		},
	},
	"tts.localModel": {
		type: "enum",
		values: TTS_LOCAL_MODEL_VALUES,
		default: DEFAULT_TTS_LOCAL_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Local TTS Model",
			description: "On-device neural TTS model (Kokoro-82M) used by the local TTS backend",
			options: TTS_LOCAL_MODEL_OPTIONS,
		},
	},
	"tts.localVoice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Local TTS Voice",
			description: "Kokoro voice used by the local TTS backend (American/British, female/male)",
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"speech.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Speech Vocalization",
			description: "Speak the assistant's output aloud through the speakers as it streams",
		},
	},
	"speech.mode": {
		type: "enum",
		values: ["all", "assistant", "yield"] as const,
		default: "assistant",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Speech Vocalization Mode",
			description:
				"What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end",
			options: [
				{ value: "all", label: "All (messages + thinking)" },
				{ value: "assistant", label: "Assistant messages" },
				{ value: "yield", label: "Final message only" },
			],
		},
	},
	"speech.voice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Speech Vocalization Voice",
			description: "Kokoro voice used when speaking the assistant's output aloud",
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"providers.tinyModel": {
		type: "enum",
		values: TINY_TITLE_MODEL_VALUES,
		default: ONLINE_TINY_TITLE_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model",
			description: "Session-title model: online pi/smol by default, or a local on-device model",
			options: TINY_TITLE_MODEL_OPTIONS,
		},
	},
	"providers.tinyModelDevice": {
		type: "enum",
		values: TINY_MODEL_DEVICE_SETTING_VALUES,
		default: TINY_MODEL_DEVICE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model Device",
			description:
				"ONNX execution provider for local tiny models (titles + memory). Default uses CPU-only inference. The PI_TINY_DEVICE env var overrides this.",
			options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
		},
	},
	"providers.tinyModelDtype": {
		type: "enum",
		values: TINY_MODEL_DTYPE_SETTING_VALUES,
		default: TINY_MODEL_DTYPE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Tiny Model Precision",
			description:
				"ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. The PI_TINY_DTYPE env var overrides this.",
			options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
		},
	},
	"providers.memoryModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "memory",
			group: "General",
			label: "Memory Model",
			description:
				"Mnemopi LLM for fact extraction + consolidation: online (smol/remote) by default, or a local on-device model",
			condition: "mnemopiActive",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.autoThinkingModel": {
		type: "enum",
		values: AUTO_THINKING_MODEL_VALUES,
		default: ONLINE_AUTO_THINKING_MODEL_KEY,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Auto Thinking Model",
			description:
				"Difficulty classifier for the `auto` thinking level: online smol by default, or a local on-device model",
			condition: "autoThinkingActive",
			options: AUTO_THINKING_MODEL_OPTIONS,
		},
	},
	"features.unexpectedStopDetection": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Agent",
			label: "Detect unexpected stops",
			description:
				"Use a small model to detect when the assistant says it will continue but stops without tool calls; automatically prompt it to continue.",
		},
	},
	"providers.unexpectedStopModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "Unexpected Stop Model",
			description: "Classifier for unexpected-stop detection: online smol by default, or a local on-device model.",
			condition: "unexpectedStopDetection",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["openai", "anthropic"] as const,
		default: "anthropic",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Kimi API Format",
			description: "API format for Kimi Code provider",
			options: [
				{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
				{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
			],
		},
	},

	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenAI WebSockets",
			description: "Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)",
			options: [
				{ value: "auto", label: "Auto", description: "Use model/provider default websocket behavior" },
				{ value: "off", label: "Off", description: "Disable websockets for OpenAI Codex models" },
				{ value: "on", label: "On", description: "Force websockets for OpenAI Codex models" },
			],
		},
	},

	"providers.openrouterVariant": {
		type: "enum",
		values: ["default", "nitro", "floor", "online", "exacto"] as const,
		default: "default",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenRouter Routing",
			description:
				"Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)",
			options: [
				{ value: "default", label: "Default", description: "No suffix; use OpenRouter's default routing" },
				{ value: "nitro", label: ":nitro", description: "Prioritize throughput / lowest latency" },
				{ value: "floor", label: ":floor", description: "Prioritize cheapest available provider" },
				{ value: "online", label: ":online", description: "Enable OpenRouter's web-search plugin" },
				{
					value: "exacto",
					label: ":exacto",
					description: "Cherry-picked high-quality providers (only defined for select models)",
				},
			],
		},
	},
	"providers.fetch": {
		type: "enum",
		values: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Fetch Provider",
			description: "Reader backend priority for the fetch/read URL tool",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: native > trafilatura > lynx > parallel > jina",
				},
				{ value: "native", label: "Native", description: "In-process HTML→Markdown converter (always available)" },
				{ value: "trafilatura", label: "Trafilatura", description: "Auto-installs via uv/pip" },
				{ value: "lynx", label: "Lynx", description: "Requires lynx system package" },
				{ value: "parallel", label: "Parallel", description: "Requires PARALLEL_API_KEY" },
				{ value: "jina", label: "Jina", description: "Uses r.jina.ai reader (JINA_API_KEY optional)" },
			],
		},
	},
	// Codex saved rate-limit resets (auto-redeem)
	"codexResets.autoRedeem": {
		type: "enum",
		values: ["unset", "yes", "no"] as const,
		default: "unset" as const,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Saved Resets",
			description:
				"When a turn is blocked by the Codex weekly limit on the active account and no other account is available, run the conservative saved-reset check. unset asks before spending the first eligible reset, yes spends eligible resets without prompting, and no disables the check entirely. Requires retries enabled.",
			options: [
				{
					value: "unset",
					label: "Unset",
					description: "Check eligibility, then ask before spending the first saved reset.",
				},
				{ value: "yes", label: "Yes", description: "Spend eligible saved resets without prompting." },
				{ value: "no", label: "No", description: "Do not run the saved-reset auto-redeem check." },
			],
		},
	},
	"codexResets.minBlockedMinutes": {
		type: "number",
		default: 60,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Min Block",
			description:
				"Only auto-redeem when the natural weekly reset is at least this many minutes away (don't spend a ~30-day credit to save a short wait).",
		},
	},
	"codexResets.keepCredits": {
		type: "number",
		default: 0,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex Auto-Redeem Reserve",
			description: "Never auto-spend below this many saved resets (0 = the last credit may be spent automatically).",
		},
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Append-Only Context",
			description:
				"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.",
			options: [
				{ value: "auto", label: "Auto", description: "Enable for known prefix-cache providers (recommended)" },
				{ value: "on", label: "On", description: "Always enable append-only context" },
				{ value: "off", label: "Off", description: "Disable append-only context" },
			],
		},
	},

	// Exa
	"exa.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "providers", group: "Services", label: "Exa", description: "Master toggle for all Exa search tools" },
	},

	"exa.enableSearch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Search",
			description: "Enable Exa basic search, deep search, code search, and crawl tools",
		},
	},

	"exa.enableResearcher": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Researcher",
			description: "Enable the Exa researcher tool for AI-powered deep research",
		},
	},

	"exa.enableWebsets": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa Websets",
			description: "Enable Exa webset management and enrichment tools",
		},
	},

	// SearXNG
	"searxng.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: "Services",
			label: "SearXNG Endpoint",
			description: "Base URL of a self-hosted SearXNG instance used for web search",
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"dev.autoqa": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "Auto QA",
			description: "Enable automated tool issue reporting (report_tool_issue) for all agents",
		},
	},

	"dev.autoqaPush.endpoint": {
		type: "string",
		default: "https://qa.omp.sh/v1/grievances" as const,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "Auto QA Push Endpoint",
			description: "Full URL receiving Auto QA JSON reports (default https://qa.omp.sh/v1/grievances)",
		},
	},

	"dev.autoqaPush.token": {
		type: "string",
		default: undefined,
	},

	/**
	 * User decision on sharing automatic `report_tool_issue` grievances.
	 *
	 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
	 *                  pops a consent dialog and persists the answer here.
	 *   - `"granted"` — record and (when push is configured) ship grievances.
	 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
	 *
	 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via the
	 * process-global consent handler registered by `InteractiveMode`.
	 */
	"dev.autoqa.consent": {
		type: "enum",
		values: ["unset", "granted", "denied"] as const,
		default: "unset" as const,
	},

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

/** All valid setting paths */
export type SettingPath = keyof Schema;

/** Infer the value type for a setting path */
export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: Schema[P] extends { type: "boolean" }
		? boolean
		: Schema[P] extends { type: "string" }
			? string | undefined
			: Schema[P] extends { type: "number" }
				? number
				: Schema[P] extends { type: "enum"; values: infer V }
					? V extends readonly string[]
						? V[number]
						: never
					: Schema[P] extends { type: "array"; default: infer D }
						? D
						: Schema[P] extends { type: "record"; default: infer D }
							? D
							: never;

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

/** Check if a path has UI metadata (should appear in settings panel) */
export function hasUi(path: SettingPath): boolean {
	return "ui" in SETTINGS_SCHEMA[path];
}

/** Get UI metadata for a path (undefined if no UI) */
export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

/** Get all paths for a specific tab */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingDef["type"] {
	return SETTINGS_SCHEMA[path].type;
}

/** Get enum values for an enum setting */
export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived Types from Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Status line preset - derived from schema */
export type StatusLinePreset = SettingValue<"statusLine.preset">;

/** Status line separator style - derived from schema */
export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

/** Tree selector filter mode - derived from schema */
export type TreeFilterMode = SettingValue<"treeFilterMode">;

/** Personality preset - derived from schema */
export type Personality = SettingValue<"personality">;

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings {
	enabled: boolean;
	strategy: "context-full" | "handoff" | "shake" | "off";
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens: number;
	keepRecentTokens: number;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
	remoteEnabled: boolean;
	remoteEndpoint: string | undefined;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
	supersedeReads: boolean;
	dropUseless: boolean;
	maskConsumedObservations: boolean;
}

export interface ContextPromotionSettings {
	enabled: boolean;
}

export interface ContextLayerSettings {
	enabled: boolean;
	model: string | undefined;
	maxInputTokens: number;
	maxOutputTokens: number;
	cache: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	modelFallback: boolean;
}

export interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	enabled?: boolean;
	projectOnly?: boolean;
	enableSkillCommands?: boolean;
	enableBuiltinSkills?: boolean;
	enableCodexUser?: boolean;
	enableClaudeUser?: boolean;
	enableClaudeProject?: boolean;
	enablePiUser?: boolean;
	enablePiProject?: boolean;
	enableAgentsUser?: boolean;
	enableAgentsProject?: boolean;
	customDirectories?: string[];
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
	discoveryMode?: "lazy";
}

export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	builtinRules?: boolean;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	disabledRules?: string[];
}

export interface ExaSettings {
	enabled: boolean;
	enableSearch: boolean;
	enableResearcher: boolean;
	enableWebsets: boolean;
}

export interface StatusLineSettings {
	preset: StatusLinePreset;
	separator: StatusLineSeparatorStyle;
	showHookStatus: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

export interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
}

export interface DelegateSettings {
	enabled: boolean;
	promptModel: string;
	lanes: Record<string, string>;
	verifierModel: string;
	synthesizerModel: string;
	mode: "subagents" | "legacy-endpoint";
	legacyEndpointConfigPath: string;
}

export interface SttSettings {
	enabled: boolean;
	language: string | undefined;
	modelName: string;
	streaming: boolean;
}

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}
export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}

export type CodexAutoRedeemMode = "unset" | "yes" | "no";

export interface CodexResetsSettings {
	autoRedeem: CodexAutoRedeemMode;
	minBlockedMinutes: number;
	keepCredits: number;
}

export interface SubagentSettings {
	modelAliases: Record<string, string>;
}

export interface MoaSettings {
	enabled: boolean;
	preset: MoaPreset;
	lanes: Record<string, string>;
	maxLanes: number;
}

/** MOA preset identifier (derived from settings schema). */
export type MoaPreset = SettingValue<"moa.preset">;
/** MOA enabled toggle (derived from settings schema). */
export type MoaEnabled = SettingValue<"moa.enabled">;

export interface FusionSettings {
	enabled: boolean;
	mode: FusionMode;
	sidekickModel: string;
	compactModel: string;
	sidekickRequestBudget: number;
	showSavings: boolean;
}

/** Fusion mode identifier (derived from settings schema). */
export type FusionMode = SettingValue<"fusion.mode">;

/** Map group prefix -> typed settings interface */
export interface GroupTypeMap {
	compaction: CompactionSettings;
	contextPromotion: ContextPromotionSettings;
	contextLayer: ContextLayerSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	stt: SttSettings;
	modelRoles: Record<string, string>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
	codexResets: CodexResetsSettings;
	subagent: SubagentSettings;
	delegate: DelegateSettings;
	moa: MoaSettings;
	fusion: FusionSettings;
}

export type GroupPrefix = keyof GroupTypeMap;
