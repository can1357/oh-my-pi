/** Status line segment identifiers accepted by custom status-line settings. */
export const STATUS_LINE_SEGMENT_IDS = [
	"pi",
	"status",
	"model",
	"mode",
	"path",
	"git",
	"pr",
	"subagents",
	"token_in",
	"token_out",
	"token_total",
	"token_rate",
	"cost",
	"context_pct",
	"context_total",
	"time_spent",
	"time",
	"session",
	"hostname",
	"cache_read",
	"cache_write",
	"cache_hit",
	"cache",
	"session_name",
	"usage",
	"collab",
	"stream",
	"vim",
] as const;

/** One identifier from the supported status-line segment catalog. */
export type StatusLineSegmentId = (typeof STATUS_LINE_SEGMENT_IDS)[number];

/** Baseline segments used when Custom is selected without segment overrides. */
export const CUSTOM_STATUS_LINE_DEFAULTS: {
	readonly left: StatusLineSegmentId[];
	readonly right: StatusLineSegmentId[];
} = {
	left: ["vim", "model", "mode", "path", "git", "pr"],
	right: ["session_name", "token_total", "cost", "context_pct"],
};

/**
 * Editor metadata for the custom status-line segment lists, in the order the
 * editor lists them. Every id in {@link STATUS_LINE_SEGMENT_IDS} has one entry
 * so the settings UI can render a toggle list with human-readable labels
 * instead of raw identifiers.
 */
export const STATUS_LINE_SEGMENT_CHOICES: ReadonlyArray<{
	value: StatusLineSegmentId;
	label: string;
	description: string;
}> = [
	{
		value: "model",
		label: "Model",
		description: "Active model name; with the thinking level unless it is shown as an icon",
	},
	{
		value: "mode",
		label: "Mode",
		description: "Active mode badge: plan, prewalk, goal, vibe, or loop, with the loop state",
	},
	{
		value: "path",
		label: "Path",
		description: "Working directory, with the home directory shortened to ~ and a worktree name when linked",
	},
	{
		value: "git",
		label: "Git",
		description: "Branch name plus staged, unstaged, and untracked counts; hidden outside a repository",
	},
	{
		value: "pr",
		label: "Pull request",
		description: "Number of the pull request for the current branch, linked when the terminal supports it",
	},
	{ value: "subagents", label: "Subagents", description: "Count of running subagents; hidden at zero" },
	{
		value: "vim",
		label: "Vim mode",
		description: "Vim mode name and selected line count; hidden unless vim mode is on",
	},
	{
		value: "pi",
		label: "Brand",
		description: "The π brand glyph with the active profile, or the focused subagent and this turn's elapsed time",
	},
	{
		value: "session_name",
		label: "Session name",
		description: "Session title, with a pin marker when the session is pinned; hidden until the session has a name",
	},
	{ value: "session", label: "Session id", description: "First eight characters of the session id" },
	{ value: "hostname", label: "Hostname", description: "Short hostname of the machine running omp" },
	{
		value: "status",
		label: "Extension statuses",
		description: "Statuses extensions publish through ctx.ui.setStatus(), joined inline",
	},
	{
		value: "collab",
		label: "Collab",
		description: "Collab participant count and this session's role; hidden outside a collab session",
	},
	{
		value: "stream",
		label: "Stream",
		description: "Live viewer count and recording marker; hidden when neither is active",
	},
	{ value: "token_in", label: "Input tokens", description: "Input tokens recorded for the session" },
	{ value: "token_out", label: "Output tokens", description: "Output tokens recorded for the session" },
	{
		value: "token_total",
		label: "Total tokens",
		description: "Input, output, cache-write, and orchestration tokens combined; hidden at zero",
	},
	{
		value: "token_rate",
		label: "Token rate",
		description: "Live generation rate in tokens per second; hidden while idle",
	},
	{
		value: "cost",
		label: "Cost",
		description: "Session cost, including subagent and advisor spend, subscription markers, and peak-hours arrows",
	},
	{
		value: "usage",
		label: "Quota usage",
		description:
			"Provider quota windows (5h, 1d, 7d, monthly) and banked reset credits; hidden without usage reports",
	},
	{
		value: "context_pct",
		label: "Context percent",
		description:
			"Context used, as a percentage of the window with the token counts; absorbed into the status line gauge when the context line is embedded",
	},
	{ value: "context_total", label: "Context window", description: "Size of the active model's context window" },
	{
		value: "cache",
		label: "Prompt cache state",
		description: "Warm or cold marker for the prompt cache; hidden when the cache state is unknown",
	},
	{ value: "cache_read", label: "Cache read tokens", description: "Tokens served from the prompt cache" },
	{ value: "cache_write", label: "Cache write tokens", description: "Tokens written into the prompt cache" },
	{
		value: "cache_hit",
		label: "Cache hit rate",
		description: "Share of the request served from the prompt cache; hidden before any cache read",
	},
	{ value: "time_spent", label: "Time spent", description: "Time spent working, per turn; hidden under a second" },
	{ value: "time", label: "Clock", description: "Current wall-clock time" },
];

export const CONTEXT_LINE_MODE_VALUES = ["off", "percentage", "annotated", "embedded"] as const;
export type ContextLineMode = (typeof CONTEXT_LINE_MODE_VALUES)[number];
export const STATUS_LINE_PRESET_VALUES = ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const;
export type StatusLinePreset = (typeof STATUS_LINE_PRESET_VALUES)[number];
export const STATUS_LINE_SEPARATOR_VALUES = [
	"powerline",
	"powerline-thin",
	"slash",
	"pipe",
	"block",
	"none",
	"ascii",
] as const;
export type StatusLineSeparatorStyle = (typeof STATUS_LINE_SEPARATOR_VALUES)[number];
