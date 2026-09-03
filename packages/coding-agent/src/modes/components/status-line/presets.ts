import type { PresetDef, StatusLinePreset } from "./types";

export const STATUS_LINE_PRESETS: Record<StatusLinePreset, PresetDef> = {
	default: {
		leftSegments: ["pi", "model", "mode", "collab", "path", "git", "pr", "context_pct", "cost"],
		rightSegments: ["session_name"],
		separator: "powerline-thin",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 40, stripWorkPrefix: true },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
		},
	},

	minimal: {
		leftSegments: ["path", "git"],
		rightSegments: ["session_name", "mode", "context_pct"],
		separator: "slash",
		segmentOptions: {
			path: { abbreviate: true, maxLength: 30 },
			git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false },
		},
	},

	compact: {
		leftSegments: ["model", "mode", "git", "pr"],
		rightSegments: ["session_name", "cost", "context_pct"],
		separator: "powerline-thin",
		segmentOptions: {
			model: { showThinkingLevel: false },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: false },
		},
	},

	full: {
		leftSegments: ["pi", "hostname", "model", "mode", "path", "git", "pr", "subagents"],
		rightSegments: [
			"session_name",
			"cache_hit",
			"token_in",
			"token_out",
			"token_rate",
			"cache_read",
			"cost",
			"context_pct",
			"time_spent",
			"time",
		],
		separator: "powerline",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 50 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			time: { format: "24h", showSeconds: false },
		},
	},

	nerd: {
		// Full preset with all Nerd Font icons
		leftSegments: ["pi", "hostname", "model", "mode", "path", "git", "pr", "session", "subagents"],
		rightSegments: [
			"session_name",
			"token_in",
			"token_out",
			"cache_read",
			"cache_write",
			"token_rate",
			"cost",
			"context_pct",
			"context_total",
			"time_spent",
			"time",
		],
		separator: "powerline",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 60 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			time: { format: "24h", showSeconds: true },
		},
	},

	ascii: {
		// No Nerd Font dependencies
		leftSegments: ["model", "mode", "path", "git", "pr"],
		rightSegments: ["session_name", "token_total", "cost", "context_pct"],
		separator: "ascii",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 40 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
		},
	},

	custom: {
		// User-defined - these are just defaults that get overridden
		leftSegments: ["model", "mode", "path", "git", "pr"],
		rightSegments: ["session_name", "token_total", "cost", "context_pct"],
		separator: "powerline-thin",
		segmentOptions: {},
	},
};

export function getPreset(name: StatusLinePreset): PresetDef {
	return STATUS_LINE_PRESETS[name] ?? STATUS_LINE_PRESETS.default;
}
