import type { ModelBrowserPerf } from "@oh-my-pi/pi-tui/overlays/model-browser";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { RawSettings } from "../config/settings";

/** Model role → selector; `null` keeps the role Automatic even when lower layers assign it. */
export type ModelRoleAssignments = Record<string, string | null>;

export const PROFILE_EMOJIS = [
	{ emoji: "💻", label: "Coding" },
	{ emoji: "⚡", label: "Fast" },
	{ emoji: "🪙", label: "Budget" },
	{ emoji: "💸", label: "Premium" },
	{ emoji: "🖥️", label: "Local" },
	{ emoji: "🧠", label: "Thinking" },
	{ emoji: "🔍", label: "Review" },
	{ emoji: "🐛", label: "Debug" },
	{ emoji: "🧪", label: "Experiment" },
	{ emoji: "📚", label: "Research" },
	{ emoji: "📝", label: "Docs" },
	{ emoji: "🔒", label: "Security" },
	{ emoji: "🚀", label: "Release" },
	{ emoji: "🌐", label: "Web" },
	{ emoji: "🎨", label: "Design" },
	{ emoji: "🗄️", label: "Database" },
	{ emoji: "☁️", label: "Cloud" },
	{ emoji: "📋", label: "Planning" },
	{ emoji: "✅", label: "Testing" },
	{ emoji: "🤖", label: "Automation" },
	{ emoji: "🔧", label: "Refactor" },
	{ emoji: "🏗️", label: "Architecture" },
	{ emoji: "📊", label: "Analytics" },
	{ emoji: "📱", label: "Mobile" },
	{ emoji: "🎮", label: "Games" },
	{ emoji: "💬", label: "Chat" },
	{ emoji: "🧩", label: "Extensions" },
	{ emoji: "🎯", label: "Focus" },
	{ emoji: "⭐", label: "Favorite" },
] as const;

export type ProfileEmoji = (typeof PROFILE_EMOJIS)[number]["emoji"];

/** Optional settings groups a setup can include; ids match Settings tabs. */
export type ProfileSettingsGroup =
	| "model"
	| "appearance"
	| "interaction"
	| "context"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers";

export interface ProfileSettingsGroupMetadata {
	id: ProfileSettingsGroup;
	label: string;
	description: string;
}

export const PROFILE_SETTINGS_GROUPS: readonly ProfileSettingsGroupMetadata[] = [
	{ id: "model", label: "Model options", description: "Sampling, thinking, prompts, and retries" },
	{ id: "appearance", label: "Appearance", description: "Theme and terminal presentation" },
	{ id: "interaction", label: "Interaction", description: "Input and session behavior" },
	{ id: "context", label: "Context", description: "Compaction and context management" },
	{ id: "memory", label: "Memory", description: "Portable memory behavior, not stored memories" },
	{ id: "files", label: "Files", description: "File handling behavior" },
	{ id: "shell", label: "Shell", description: "Portable shell behavior, not executable paths" },
	{ id: "tools", label: "Tools", description: "Tool behavior and output limits" },
	{ id: "tasks", label: "Agents & tasks", description: "Task behavior and agent assignments" },
	{ id: "providers", label: "Provider settings", description: "Portable provider behavior only" },
];

export interface SetupMetadata {
	version: 1;
	emoji?: ProfileEmoji;
	enabledGroups: ProfileSettingsGroup[];
}

export interface ProfileDraft {
	metadata: SetupMetadata;
	/** Native settings overlay. Reserved `$setup` metadata is never included here. */
	config: RawSettings;
}

export interface ProfileRoleRow {
	role: string;
	selector?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Catalog intelligence score. */
	int?: number;
	/** Catalog-estimated output speed in tokens per second. */
	tps?: number;
	/** Resolved context window in tokens. */
	contextWindow?: number;
	/** Locally measured throughput and latency for this exact provider/model pair. */
	perf?: ModelBrowserPerf;
	/** Resolved token rates in USD per million tokens; not account or subscription billing. */
	cost?: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	automatic: boolean;
	warning?: string;
}

export interface ProfileAgentRow {
	name: string;
	enabled: boolean;
	source: string;
	selector?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	warning?: string;
}

export interface ProfileSettingRow {
	/** Setting id, e.g. `compaction.enabled`. */
	id: string;
	label: string;
	value: boolean | number | string | null;
	hidden: boolean;
	configured: boolean;
}

/** What a configuration resolves to, as shown in the Profiles preview. */
export interface ProfileSnapshot {
	generatedAt: number;
	roles: ProfileRoleRow[];
	agents: ProfileAgentRow[];
	memory: { backend: string; scope?: string; storageLabel: string };
	settings: ProfileSettingRow[];
	/** Entries skipped while loading a saved setup, or other preview caveats. */
	warnings: string[];
}
