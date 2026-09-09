//! Chat-owned settings shared across the interactive renderer and host.
use omp_con::Kv;
use omp_core::Str;

use crate::status_band::{WallClockFormatSetting, WallClockSecondsSetting};

/// Transcript behavior after a terminal resize.
#[derive(
	Clone, Copy, Debug, Eq, PartialEq, strum::EnumString, strum::IntoStaticStr, strum::VariantNames,
)]
#[strum(serialize_all = "lowercase")]
pub enum ResizePolicy {
	/// Preserve the current physical presentation.
	Preserve,
	/// Append a fresh physical presentation.
	Append,
	/// Rebuild the physical presentation from logical history.
	Rebuild,
}

omp_con::con_enum!(ResizePolicy);

omp_con::var! {
	/// Renderer theme override. `default` follows the terminal background.
	pub static CL_THEME = cl_theme: Str {
		default: Str::new_static("default"),
		flags: archive | session,
	};
	/// Show model thinking blocks in assistant responses.
	pub static CL_SHOWTHINKING = cl_showthinking: bool {
		default: true,
		flags: archive | session,
		meta: {
			"ui.tab": "model",
			"ui.group": "Thinking",
			"ui.label": "Show Thinking Blocks",
			"legacy.path": "hideThinkingBlock",
		},
	};
	/// Show the thinking level as a single icon on the model name instead of a
	/// separate ` · <level>` suffix.
	pub static CL_STATUS_COMPACT_THINKING = cl_status_compact_thinking: bool {
		default: true,
		flags: archive | session,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Compact Thinking Level",
			"legacy.path": "statusLine.compactThinkingLevel",
		},
	};
	/// Move the prompt's bottom border to a separate row so macOS IME preedit
	/// cannot displace it.
	pub static CL_IME_SAFE_CURSOR = cl_ime_safe_cursor: bool {
		default: false,
		flags: archive | session,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "IME-Safe Prompt Layout",
			"legacy.path": "tui.imeSafeCursor",
		},
	};
	/// How a settled terminal resize refreshes transcript rows retained in
	/// terminal scrollback.
	pub static CL_RESIZE_POLICY = cl_resize_policy: ResizePolicy {
		default: ResizePolicy::Rebuild,
		flags: archive | session,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "Resize Scrollback",
			"ui.option.append": "Append",
			"ui.option.append.desc": "Replay the transcript at the new width below retained history",
			"ui.option.rebuild": "Rebuild",
			"ui.option.rebuild.desc": "Erase all terminal scrollback, then replay one current-width transcript",
			"ui.option.preserve": "Preserve",
			"ui.option.preserve.desc": "Repaint only the viewport and keep history wrapped at its old width",
			"legacy.path": "tui.resizeScrollback",
		},
	};
	/// Theme used when the terminal has a dark background.
	pub static CL_THEME_DARK = cl_theme_dark: Str {
		default: Str::new_static("titanium"),
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Theme",
			"ui.label": "Dark Theme",
			"ui.choices": "themes",
			"legacy.path": "theme.dark",
		},
	};
	/// Theme used when the terminal has a light background.
	pub static CL_THEME_LIGHT = cl_theme_light: Str {
		default: Str::new_static("light"),
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Theme",
			"ui.label": "Light Theme",
			"ui.choices": "themes",
			"legacy.path": "theme.light",
		},
	};
	/// Visual layout of the input editor and status line.
	pub static CL_COMPOSER_SHAPE = cl_composer_shape: Str {
		default: Str::new_static("band"),
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Composer",
			"ui.label": "Composer Shape",
			"ui.choices": "composer-shapes",
			"legacy.path": "composer.shape",
		},
	};
	/// Pre-built status line configuration.
	pub static CL_STATUS_LINE_PRESET = cl_status_line_preset: Str {
		default: Str::new_static("default"),
		suggest: ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"],
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Status Line Preset",
			"ui.option.default": "Default",
			"ui.option.default.desc": "Model, path, git, context, tokens, cost",
			"ui.option.minimal": "Minimal",
			"ui.option.minimal.desc": "Path and git only",
			"ui.option.compact": "Compact",
			"ui.option.compact.desc": "Model, git, cost, context",
			"ui.option.full": "Full",
			"ui.option.full.desc": "All segments including time",
			"ui.option.nerd": "Nerd",
			"ui.option.nerd.desc": "Maximum info with Nerd Font icons",
			"ui.option.ascii": "ASCII",
			"ui.option.ascii.desc": "No special characters",
			"ui.option.custom": "Custom",
			"ui.option.custom.desc": "User-defined segments",
			"legacy.path": "statusLine.preset",
		},
	};
	/// Style of separators between status line segments.
	pub static CL_STATUS_LINE_SEPARATOR = cl_status_line_separator: Str {
		default: Str::new_static("powerline-thin"),
		suggest: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"],
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Status Line Separator",
			"ui.option.powerline": "Powerline",
			"ui.option.powerline.desc": "Solid arrows (Nerd Font)",
			"ui.option.powerline-thin": "Thin chevron",
			"ui.option.powerline-thin.desc": "Thin arrows (Nerd Font)",
			"ui.option.slash": "Slash",
			"ui.option.slash.desc": "Forward slashes",
			"ui.option.pipe": "Pipe",
			"ui.option.pipe.desc": "Vertical pipes",
			"ui.option.block": "Block",
			"ui.option.block.desc": "Solid blocks",
			"ui.option.none": "None",
			"ui.option.none.desc": "Space only",
			"ui.option.ascii": "ASCII",
			"ui.option.ascii.desc": "Greater-than signs",
			"legacy.path": "statusLine.separator",
		},
	};
	/// How the line between the left and right status segments reflects context
	/// usage when using the box composer.
	pub static CL_STATUS_LINE_CONTEXT_LINE = cl_status_line_context_line: Str {
		default: Str::new_static("embedded"),
		suggest: ["off", "percentage", "annotated", "embedded"],
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Context-Reactive Line",
			"ui.option.off": "Off",
			"ui.option.off.desc": "Solid accent line, no context feedback",
			"ui.option.percentage": "Percentage",
			"ui.option.percentage.desc": "Used portion in accent color, remainder dimmed",
			"ui.option.annotated": "Annotated",
			"ui.option.annotated.desc": "Percentage plus ticks at the speculative and auto-compaction boundaries",
			"ui.option.embedded": "Embedded",
			"ui.option.embedded.desc": "Annotated line with the context percentage and window embedded in the gauge",
			"legacy.path": "statusLine.contextLine",
		},
	};
	/// Use the terminal's default background for the status line instead of the
	/// theme's status-line background.
	pub static CL_STATUS_LINE_TRANSPARENT = cl_status_line_transparent: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Transparent Status Line",
			"legacy.path": "statusLine.transparent",
		},
	};
	/// Display hook status messages below the status line.
	pub static CL_STATUS_LINE_SHOW_HOOK_STATUS = cl_status_line_show_hook_status: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Show Hook Status",
			"legacy.path": "statusLine.showHookStatus",
		},
	};
	/// Ordered status line segments on the left; an empty list uses the preset.
	pub static CL_STATUS_LINE_LEFT_SEGMENTS = cl_status_line_left_segments: Vec<Str> {
		default: Vec::new(),
		suggest: ["pi", "status", "model", "mode", "path", "git", "pr", "subagents", "token_in", "token_out", "token_total", "token_rate", "cost", "context_pct", "context_total", "time_spent", "time", "session", "hostname", "cache_read", "cache_write", "cache_hit", "session_name", "usage", "collab"],
		flags: archive,
		meta: {
			"legacy.path": "statusLine.leftSegments",
		},
	};
	/// Ordered status line segments on the right; an empty list uses the preset.
	pub static CL_STATUS_LINE_RIGHT_SEGMENTS = cl_status_line_right_segments: Vec<Str> {
		default: Vec::new(),
		suggest: ["pi", "status", "model", "mode", "path", "git", "pr", "subagents", "token_in", "token_out", "token_total", "token_rate", "cost", "context_pct", "context_total", "time_spent", "time", "session", "hostname", "cache_read", "cache_write", "cache_hit", "session_name", "usage", "collab"],
		flags: archive,
		meta: {
			"legacy.path": "statusLine.rightSegments",
		},
	};
	/// Per-segment status line presentation overrides.
	pub static CL_STATUS_LINE_SEGMENT_OPTIONS = cl_status_line_segment_options: Kv {
		default: Kv::new(),
		flags: archive,
		meta: {
			"legacy.path": "statusLine.segmentOptions",
		},
	};
	/// Use the preset clock format, or force a 12-hour or 24-hour local clock.
	pub static CL_STATUS_LINE_TIME_FORMAT = cl_status_line_time_format: WallClockFormatSetting {
		default: WallClockFormatSetting::Preset,
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Clock Format",
			"ui.option.preset": "Preset",
			"ui.option.preset.desc": "Full and Nerd preset default",
			"ui.option.12h": "12-hour",
			"ui.option.12h.desc": "Show am or pm",
			"ui.option.24h": "24-hour",
			"ui.option.24h.desc": "Use 0 through 23",
			"legacy.path": "statusLine.segmentOptions.time.format",
		},
	};
	/// Use the preset clock choice, always hide seconds, or always show seconds.
	pub static CL_STATUS_LINE_TIME_SHOW_SECONDS = cl_status_line_time_show_seconds: WallClockSecondsSetting {
		default: WallClockSecondsSetting::Preset,
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Status Line",
			"ui.label": "Clock Seconds",
			"ui.option.preset": "Preset",
			"ui.option.preset.desc": "Full hides seconds; Nerd shows them",
			"ui.option.hide": "Hidden",
			"ui.option.hide.desc": "Update once a minute",
			"ui.option.show": "Shown",
			"ui.option.show.desc": "Update once a second",
			"legacy.path": "statusLine.segmentOptions.time.showSeconds",
		},
	};
	/// Show per-turn token usage on assistant messages.
	pub static CL_DISPLAY_SHOW_TOKEN_USAGE = cl_display_show_token_usage: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "Show Token Usage",
			"legacy.path": "display.showTokenUsage",
		},
	};
	/// Show total prompt-to-yield time, including tool calls, on assistant
	/// message usage rows.
	pub static CL_DISPLAY_SHOW_TURN_TIME = cl_display_show_turn_time: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "Show Turn Time",
			"legacy.path": "display.showTurnTime",
		},
	};
	/// Maximum visible items in the autocomplete dropdown.
	pub static CL_AUTOCOMPLETE_MAX_VISIBLE = cl_autocomplete_max_visible: i64 {
		default: 10,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Autocomplete Items",
			"legacy.path": "autocompleteMaxVisible",
		},
	};
	/// Mark misspelled prompt words with the active macOS dictionaries.
	pub static CL_SPELLING_TYPO_DETECTION = cl_spelling_typo_detection: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Typo Detection (macOS)",
			"ui.when": "os=macos",
			"legacy.path": "spelling.typoDetection",
		},
	};
	/// Show macOS dictionary word completions as inline hints accepted with Tab.
	pub static CL_SPELLING_AUTOCOMPLETE = cl_spelling_autocomplete: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Word Autocomplete (macOS)",
			"ui.when": "os=macos",
			"legacy.path": "spelling.autocomplete",
		},
	};
	/// Apply confident macOS spelling corrections after completed words.
	pub static CL_SPELLING_AUTOCORRECT = cl_spelling_autocorrect: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Autocorrect (macOS)",
			"ui.when": "os=macos",
			"legacy.path": "spelling.autocorrect",
		},
	};
	/// Suggest emojis from `:name:` shortcodes and expand text emoticons.
	pub static CL_EMOJI_AUTOCOMPLETE = cl_emoji_autocomplete: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Emoji Autocomplete",
			"legacy.path": "emojiAutocomplete",
		},
	};
	/// When a paste reaches this many lines, offer a menu to wrap it in a code
	/// block, wrap it in XML tags, or save it to a file. Zero disables the menu.
	pub static CL_PASTE_LARGE_MENU_THRESHOLD = cl_paste_large_menu_threshold: i64 {
		default: 100,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Large Paste Menu",
			"legacy.path": "paste.largeMenuThreshold",
		},
	};
	/// Enable per-session goal mode and the hidden goal tool.
	pub static CL_GOAL_ENABLED = cl_goal_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tasks",
			"ui.group": "Modes",
			"ui.label": "Goal Mode",
			"legacy.path": "goal.enabled",
		},
	};
	/// Display the active Goal director in the status footer.
	pub static CL_GOAL_STATUS_IN_FOOTER = cl_goal_status_in_footer: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "goal.statusInFooter",
		},
	};
	/// Presentation modes in which Goal may automatically continue.
	pub static CL_GOAL_CONTINUATION_MODES = cl_goal_continuation_modes: Vec<Str> {
		default: vec![Str::new_static("interactive")],
		suggest: ["interactive"],
		flags: archive,
		meta: {
			"legacy.path": "goal.continuationModes",
		},
	};
}
