import { type AnySetting, combine, Derived, effect, register, type Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import {
	type ExplicitMotionSettings,
	MOTION_MODES,
	type MotionMode,
	type MotionSettings,
	resolveMotion,
} from "../config/motion-presets";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-tui/app-keybindings";
import { cfgReadToolResultPreview } from "../tools/settings";
import { MAGIC_KEYWORDS, type MagicKeywordId } from "./magic-keywords";
import { TREE_FILTER_MODES } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import {
	CONTEXT_LINE_MODE_VALUES,
	CUSTOM_STATUS_LINE_DEFAULTS,
	STATUS_LINE_PRESET_VALUES,
	STATUS_LINE_SEGMENT_IDS,
	STATUS_LINE_SEPARATOR_VALUES,
} from "@oh-my-pi/pi-tui/status-line/schema";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { setEditorGapComposerShape } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { setEmojiAutocompleteEnabled } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { WORD_COMPLETION_METHODS } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { setInlineImageMaxColumns, setInlineImageMaxRows } from "@oh-my-pi/pi-tui/render/render-utils";
import { type ShimmerMode, setShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";
import { setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "@oh-my-pi/pi-tui/theme/theme";
import { DEFAULT_MAX_FPS, parseMaxFps, setMaxFps } from "@oh-my-pi/pi-tui/frame-rate";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import { DEFAULT_SPINNER_INTERVAL_MS, parseSpinnerInterval, setSpinnerInterval } from "@oh-my-pi/pi-tui/spinner-clock";

const EMPTY_UNKNOWN_RECORD: Record<string, unknown> = {};

// ────────────────────────────────────────────────────────────────────────
// General settings (no UI)
// ────────────────────────────────────────────────────────────────────────
export const cfgSetupVersion = register({ id: "setupVersion", type: "number", default: 0 });

export const cfgAutoResume = register({
	id: "autoResume",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Auto Resume",
		description: "Automatically resume the most recent session in the current directory",
	},
});

export const cfgGitEnabled = register({
	id: "git.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Git",
		label: "Enable Git Integration",
		description: "Show git branch, status, and PR information in the TUI and watch repository metadata.",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Appearance
// ────────────────────────────────────────────────────────────────────────

// Theme
export const cfgThemeDark = register({
	id: "theme.dark",
	type: "string",
	default: "titanium",
	ui: {
		tab: "appearance",
		group: "Theme",
		label: "Dark Theme",
		description: "Theme used when the terminal has a dark background",
		options: "runtime",
	},
});
effect(cfgThemeDark, name => setAutoThemeMapping("dark", name));

export const cfgThemeLight = register({
	id: "theme.light",
	type: "string",
	default: "light",
	ui: {
		tab: "appearance",
		group: "Theme",
		label: "Light Theme",
		description: "Theme used when the terminal has a light background",
		options: "runtime",
	},
});
effect(cfgThemeLight, name => setAutoThemeMapping("light", name));

export const cfgSymbolPreset = register({
	id: "symbolPreset",
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
			{
				value: "nerd",
				label: "Nerd Font",
				description: "Requires a Nerd Font, or a Glyph Protocol terminal (icons ship in-band)",
			},
			{ value: "ascii", label: "ASCII", description: "Maximum compatibility" },
		],
	},
});
effect(cfgSymbolPreset, setSymbolPreset);

export const cfgColorBlindMode = register({
	id: "colorBlindMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Theme",
		label: "Color-Blind Mode",
		description: "Use blue instead of green for diff additions",
	},
});
effect(cfgColorBlindMode, setColorBlindMode);

// Composer
export const cfgComposerShape = register({
	id: "composer.shape",
	type: "string",
	default: "band",
	ui: {
		tab: "appearance",
		group: "Composer",
		label: "Composer Shape",
		description: "Visual layout of the input editor and status line",
		options: "runtime",
	},
});
effect(cfgComposerShape, setEditorGapComposerShape);

export const cfgComposerTokenRate = register({
	id: "composer.tokenRate",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Composer",
		label: "Generation Rate",
		description:
			"Show a live generation tok/s readout: on the working row next to the session title, or in the native composer bar right after the thinking level, where the last reading stays between turns. Estimated from streamed deltas and corrected by the provider's billed output count as each message completes.",
	},
});

export const cfgComposerThinkingInModel = register({
	id: "composer.thinkingInModel",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Composer",
		label: "Thinking Level in Model Chip",
		description:
			"The native composer shows the thinking level as the model chip's icon instead of a separate chip; click the icon to cycle it",
	},
});

// Status line
export const cfgStatusLinePreset = register({
	id: "statusLine.preset",
	type: "enum",
	values: STATUS_LINE_PRESET_VALUES,
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
});

export const cfgStatusLineSeparator = register({
	id: "statusLine.separator",
	type: "enum",
	values: STATUS_LINE_SEPARATOR_VALUES,
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
});

export const cfgStatusLineContextLine = register({
	id: "statusLine.contextLine",
	type: "enum",
	values: CONTEXT_LINE_MODE_VALUES,
	default: "embedded",
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: "Context-Reactive Line",
		description: "How the line between the left and right segments reflects context usage (box composer only)",
		options: [
			{ value: "off", label: "Off", description: "Solid accent line, no context feedback" },
			{
				value: "percentage",
				label: "Percentage",
				description: "Used portion in accent color, remainder dimmed",
			},
			{
				value: "annotated",
				label: "Annotated",
				description: "Percentage plus ticks at the speculative and auto-compaction boundaries",
			},
			{
				value: "embedded",
				label: "Embedded",
				description: "Annotated line with the context percentage and window embedded in the gauge",
			},
		],
	},
});

export const cfgStatusLineSessionAccent = register({
	id: "statusLine.sessionAccent",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: "Session Accent",
		description: "Use the session name color for the editor border and status line gap",
	},
});

export const cfgStatusLineTransparent = register({
	id: "statusLine.transparent",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: "Transparent Status Line",
		description:
			"Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.",
	},
});

export const cfgStatusLineCompactThinkingLevel = register({
	id: "statusLine.compactThinkingLevel",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: "Compact Thinking Level",
		description:
			"Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix.",
	},
});

export const cfgStatusLineShowHookStatus = register({
	id: "statusLine.showHookStatus",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Status Line",
		label: "Show Hook Status",
		description: "Display hook status messages below the status line",
	},
});

export const cfgStatusLineLeftSegments = register({
	id: "statusLine.leftSegments",
	type: "array",
	default: CUSTOM_STATUS_LINE_DEFAULTS.left,
	items: { values: STATUS_LINE_SEGMENT_IDS, label: "status line segment" },
});

export const cfgStatusLineRightSegments = register({
	id: "statusLine.rightSegments",
	type: "array",
	default: CUSTOM_STATUS_LINE_DEFAULTS.right,
	items: { values: STATUS_LINE_SEGMENT_IDS, label: "status line segment" },
});

export const cfgStatusLineSegmentOptions = register({
	id: "statusLine.segmentOptions",
	type: "record",
	default: EMPTY_UNKNOWN_RECORD,
});

// Images and terminal
export const cfgTerminalShowImages = register({
	id: "terminal.showImages",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Images",
		label: "Show Inline Images",
		description: "Render images inline in the terminal",
		condition: "hasImageProtocol",
	},
});

export const cfgImagesAutoResize = register({
	id: "images.autoResize",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Images",
		label: "Auto-Resize Images",
		description: "Resize large images to 2000x2000 max for better model compatibility",
	},
});

export const cfgImagesBlockImages = register({
	id: "images.blockImages",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Images",
		label: "Block Images",
		description: "Prevent images from being sent to LLM providers",
	},
});

export const cfgTuiMaxInlineImageColumns = register({
	id: "tui.maxInlineImageColumns",
	type: "number",
	default: 100,
	description:
		"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
});
effect(cfgTuiMaxInlineImageColumns, setInlineImageMaxColumns);

export const cfgTuiMaxInlineImageRows = register({
	id: "tui.maxInlineImageRows",
	type: "number",
	default: 20,
	description:
		"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
});
effect(cfgTuiMaxInlineImageRows, setInlineImageMaxRows);

export const cfgTuiMaxInlineImages = register({
	id: "tui.maxInlineImages",
	type: "number",
	default: 8,
	description:
		"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).",
});

export const cfgTuiResizeScrollback = register({
	id: "tui.resizeScrollback",
	type: "enum",
	values: ["append", "rebuild", "preserve"] as const,
	default: "rebuild",
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Resize Scrollback",
		description: "How a settled terminal resize refreshes transcript rows retained in terminal scrollback",
		options: [
			{
				value: "append",
				label: "Append",
				description: "Replay the transcript at the new width below retained history",
			},
			{
				value: "rebuild",
				label: "Rebuild",
				description: "Erase all terminal scrollback, then replay one current-width transcript",
			},
			{
				value: "preserve",
				label: "Preserve",
				description: "Repaint only the viewport and keep history wrapped at its old width",
			},
		],
	},
});

export const cfgTerminalShowProgress = register({
	id: "terminal.showProgress",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Native Terminal Progress",
		description:
			"Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running (always on in Tern)",
	},
});

export const cfgTuiTextSizing = register({
	id: "tui.textSizing",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Large Headings (Kitty)",
		description:
			"Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.",
	},
});

export const cfgTuiRenderMermaid = register({
	id: "tui.renderMermaid",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Render Mermaid Diagrams",
		description: "Render Mermaid fenced code blocks as ASCII diagrams",
	},
});

export const cfgTuiReactions = register({
	id: "tui.reactions",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Agent Reactions",
		description: "Invite the agent to react to your message with an emoji badge on its bubble",
	},
});

export const cfgTuiCodexResetFireworks = register({
	id: "tui.codexResetFireworks",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Codex Reset Fireworks",
		get description() {
			return `Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until ${formatKeyHint("escape")}`;
		},
	},
});

export const cfgTuiTitleState = register({
	id: "tui.titleState",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Terminal Title Run State",
		description:
			"Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' under WSL), '>' when it's your turn, '!' when the agent is waiting on you",
	},
});

export const cfgTuiTitleSpinner = register({
	id: "tui.titleSpinner",
	type: "enum",
	values: ["braille", "pulse", "dots", "line"] as const,
	default: "braille",
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Terminal Title Spinner",
		description:
			"Glyph set for the working-state spinner in the terminal title — braille sweep, filling moon, single-dot cycle, or ASCII-safe line",
		options: [
			{ value: "braille", label: "Braille", description: "Classic ⠋⠙⠹ sweep (default)" },
			{ value: "pulse", label: "Pulse", description: "Moon filling ○◑● then emptying" },
			{ value: "dots", label: "Dots", description: "Single braille dots cycling" },
			{ value: "line", label: "Line", description: "ASCII - \\ | / for fonts without braille coverage" },
		],
	},
});

export const cfgTuiSpinnerInterval = register({
	id: "tui.spinnerInterval",
	type: "number",
	default: DEFAULT_SPINNER_INTERVAL_MS,
	env: "PI_SPINNER_INTERVAL",
	// `validate` runs on every load for every setting, with `undefined`/`null` when unconfigured. A
	// quoted number (`spinnerInterval: "250"`) is rejected here: the number-typed setting would
	// otherwise read it as its default while still counting as explicitly configured.
	validate: raw => {
		if (raw === undefined || raw === null) return;
		if (typeof raw !== "number")
			throw new Error(`tui.spinnerInterval must be a number of milliseconds, got ${JSON.stringify(raw)}.`);
		parseSpinnerInterval(raw);
	},
	normalize: parseSpinnerInterval,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Spinner Interval (ms)",
		description:
			"Milliseconds between frames of every spinner: the working row, live tool cards, the status-line brand spinner, and the terminal title. Each frame is a repaint the terminal must process (and under tmux control mode, every attached client), so a slower spinner saves CPU and battery. 0 shows static glyphs",
		options: [
			{ value: "0", label: "Static", description: "No animation: fixed glyphs, ':' in the title" },
			{ value: "80", label: "80 ms", description: "12.5 frames/s (default)" },
			{ value: "250", label: "250 ms", description: "4 frames/s" },
			{ value: "500", label: "500 ms", description: "2 frames/s" },
			{ value: "1000", label: "1 s", description: "1 frame/s" },
		],
	},
});

export const cfgTuiMaxFps = register({
	id: "tui.maxFps",
	type: "number",
	default: DEFAULT_MAX_FPS,
	env: "PI_MAX_FPS",
	// `validate` runs on every load for every setting, with `undefined`/`null` when unconfigured; a
	// quoted number is rejected for the same reason as `tui.spinnerInterval`.
	validate: raw => {
		if (raw === undefined || raw === null) return;
		if (typeof raw !== "number")
			throw new Error(`tui.maxFps must be a number of frames per second, got ${JSON.stringify(raw)}.`);
		parseMaxFps(raw);
	},
	normalize: parseMaxFps,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Max Frames Per Second",
		description:
			"Ceiling on how often the TUI repaints: animations and streaming text coalesce into frames no closer than this. Keystroke echo keeps the full rate, so the pane you type in stays crisp while background sessions go quiet. Each frame costs the terminal (and under tmux control mode, every attached client) a repaint",
		options: [
			{ value: "30", label: "30 fps", description: "Full rate (default)" },
			{ value: "15", label: "15 fps", description: "Half rate" },
			{ value: "4", label: "4 fps", description: "Quiet: for many panes or a shared screen" },
			{ value: "1", label: "1 fps", description: "Minimum: content still updates once a second" },
		],
	},
});

export const cfgTuiHyperlinks = register({
	id: "tui.hyperlinks",
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
});
// Also re-applied when a project-scoped reload (`/move`, cross-project resume, rollback) changes the
// effective value, so pi-tui renderers gating on the shared flag track it the same instant path links do.
effect(cfgTuiHyperlinks, applyHyperlinkSetting);

export const cfgTuiMouse = register({
	id: "tui.mouse",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Mouse Click-to-Focus",
		get description() {
			const shift = formatKeyHint("shift");
			return `Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes ${shift}+drag and wheel scroll becomes ${shift}+wheel while on`;
		},
	},
});

export const cfgTuiTight = register({
	id: "tui.tight",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Tight Layout",
		description: "Remove the 1-character horizontal padding from the left and right of the terminal output",
	},
});

export const cfgDisplayShimmer = register({
	id: "display.shimmer",
	type: "enum",
	values: ["classic", "kitt", "disabled"] as const,
	default: "classic",
	env: "PI_SHIMMER",
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
});

export const cfgTuiMotion = register({
	id: "tui.motion",
	type: "enum",
	values: MOTION_MODES,
	default: "full",
	env: "PI_MOTION",
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Motion",
		description:
			"One switch over every animation: spinner cadence, repaint ceiling, shimmer, and decorative blink/fade. A setting you set explicitly (spinner interval, max fps, shimmer) still wins over the preset. For many panes, a shared screen, or reduced-motion needs",
		options: [
			{ value: "full", label: "Full", description: "Every animation at its own setting (default)" },
			{
				value: "reduced",
				label: "Reduced",
				description: "Spinners at 250 ms, 4 fps ceiling, no shimmer, no blink/fade",
			},
			{
				value: "none",
				label: "None",
				description: "Static spinners and title, 4 fps ceiling, no shimmer, no blink/fade",
			},
		],
	},
});

/**
 * The effective animation settings: `tui.motion`'s preset, overridden by each governed setting the
 * user set explicitly (file, flag, or env). One derivation drives the TUI clocks and the shimmer so
 * the preset and the explicit knobs can never fight.
 */
class ResolvedMotion extends Derived<MotionSettings> {
	readonly #sources: readonly AnySetting[] = [cfgTuiMotion, cfgTuiSpinnerInterval, cfgTuiMaxFps, cfgDisplayShimmer];

	get sources(): readonly AnySetting[] {
		return this.#sources;
	}

	inputs(settings: Settings): readonly unknown[] {
		return [
			cfgTuiMotion.get(settings),
			cfgTuiSpinnerInterval.isConfigured(settings) ? cfgTuiSpinnerInterval.get(settings) : undefined,
			cfgTuiMaxFps.isConfigured(settings) ? cfgTuiMaxFps.get(settings) : undefined,
			cfgDisplayShimmer.isConfigured(settings) ? cfgDisplayShimmer.get(settings) : undefined,
		];
	}

	compute(inputs: readonly unknown[]): MotionSettings {
		const [mode, spinnerInterval, maxFps, shimmer] = inputs as [
			MotionMode,
			number | undefined,
			number | undefined,
			ShimmerMode | undefined,
		];
		const explicit: ExplicitMotionSettings = { spinnerInterval, maxFps, shimmer };
		return resolveMotion(mode, explicit);
	}
}

/** Effective animation settings; the terminal-title spinner reads its period from here too. */
export const cfgMotionResolved: Derived<MotionSettings> = new ResolvedMotion();
effect(cfgMotionResolved, motion => {
	setSpinnerInterval(motion.spinnerInterval);
	setMaxFps(motion.maxFps);
	setShimmerMode(motion.shimmer);
	setMotionEffects(motion.effects);
});

export const cfgDisplayPinnedAgents = register({
	id: "display.pinnedAgents",
	type: "enum",
	values: ["off", "collapsed", "full"] as const,
	default: "collapsed",
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Pinned Agents",
		description:
			"Pinned live-agent jump list above the editor (off hides it; collapsed shows a few rows with an expander; full lists all)",
		options: [
			{ value: "off", label: "Off", description: "Hide the pinned jump list" },
			{ value: "collapsed", label: "Collapsed", description: "Show a few rows with an expander" },
			{ value: "full", label: "Full", description: "Always list every live agent" },
		],
	},
});

export const cfgDisplaySubagentLivePreview = register({
	id: "display.subagentLivePreview",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Subagent Live Preview",
		description: "Show each pinned subagent's current (or most recent) tool call beneath its row",
	},
});

export const cfgDisplaySmoothStreaming = register({
	id: "display.smoothStreaming",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Smooth Streaming",
		description: "Reveal assistant text and streamed tool input smoothly while chunks arrive",
	},
});

export const cfgDisplayHideToolActivity = register({
	id: "display.hideToolActivity",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Hide Tool Activity",
		description: "Hide model-initiated tool calls and results from the transcript",
	},
});

export const cfgDisplayShowTokenUsage = register({
	id: "display.showTokenUsage",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Show Token Usage",
		description: "Show per-turn token usage on assistant messages",
	},
});

export const cfgDisplayShowTurnTime = register({
	id: "display.showTurnTime",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Show Turn Time",
		description: "Show the total prompt-to-yield time (including tool calls) on assistant message usage rows",
	},
});

export const cfgDisplayCacheMissMarker = register({
	id: "display.cacheMissMarker",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Cache Miss Marker",
		description: "Show a divider after an assistant turn whose request lost (missed) the prompt cache",
	},
});
effect(
	combine({
		hideToolActivity: cfgDisplayHideToolActivity,
		readToolResultPreview: cfgReadToolResultPreview,
		showImages: cfgTerminalShowImages,
		cacheMissMarker: cfgDisplayCacheMissMarker,
		showTokenUsage: cfgDisplayShowTokenUsage,
		showTurnTime: cfgDisplayShowTurnTime,
	}),
	setChatTranscriptDisplayPreferences,
);

export const cfgDisplayCollapseCompacted = register({
	id: "display.collapseCompacted",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Collapse Compacted History",
		description:
			"Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point",
	},
});

export const cfgShowHardwareCursor = register({
	id: "showHardwareCursor",
	type: "boolean",
	default: true, // will be computed based on platform if undefined
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Show Hardware Cursor",
		description: "Show terminal cursor for IME support",
	},
});

export const cfgTuiImeSafeCursor = register({
	id: "tui.imeSafeCursor",
	type: "boolean",
	default: false,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "IME-Safe Prompt Layout",
		description: "Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Interaction
// ────────────────────────────────────────────────────────────────────────

// Conversation flow
export const cfgSteeringMode = register({
	id: "steeringMode",
	type: "enum",
	values: ["all", "one-at-a-time"] as const,
	default: "one-at-a-time",
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Steering Mode",
		description: "How to process queued messages while agent is working",
	},
});

export const cfgFollowUpMode = register({
	id: "followUpMode",
	type: "enum",
	values: ["all", "one-at-a-time"] as const,
	default: "one-at-a-time",
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Follow-Up Mode",
		description: "How to drain follow-up messages after a turn completes",
	},
});

export const cfgInterruptMode = register({
	id: "interruptMode",
	type: "enum",
	values: ["immediate", "wait"] as const,
	default: "immediate",
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Interrupt Mode",
		description: "When steering messages interrupt tool execution",
	},
});

export const cfgTuiVimMode = register({
	id: "tui.vimMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Vim Editing Mode",
		get description() {
			return `Modal prompt editing. ${formatKeyHint("escape")} leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes`;
		},
	},
});

export const cfgTuiVimModeDisplay = register({
	id: "tui.vimModeDisplay",
	type: "enum",
	values: ["text", "icon", "none"] as const,
	default: "text",
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Vim Mode Indicator",
		description: "How the current Vim mode appears in the status line",
		condition: "vimModeEnabled",
		options: [
			{ value: "text", label: "Text", description: "Full mode name — NORMAL, INSERT, VISUAL, V-LINE" },
			{ value: "icon", label: "Icon", description: "Single compact glyph per mode" },
			{ value: "none", label: "Hidden", description: "Do not show the mode in the status line" },
		],
	},
});

export const cfgLoopMode = register({
	id: "loop.mode",
	type: "enum",
	values: ["prompt", "compact", "reset"] as const,
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
		],
	},
});

export const cfgLoopConditionTimeoutMs = register({
	id: "loop.conditionTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Loop Condition Timeout (ms)",
		description:
			"Max wait for a `/loop --while` / `--until` condition command before treating it as broken and stopping the loop. Set to 0 to wait indefinitely",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "10000", label: "10 seconds" },
			{ value: "30000", label: "30 seconds" },
			{ value: "120000", label: "2 minutes" },
		],
	},
});

// Input and startup
export const cfgComposerRecallClearedDrafts = register({
	id: "composer.recallClearedDrafts",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Recall Cleared Drafts",
		get description() {
			return `Keep drafts cleared with ${formatKeyHint("ctrl+c")} in local ${formatKeyHints(["up", "down"])} history until exit; disabling affects future clears`;
		},
	},
});

export const cfgDoubleEscapeAction = register({
	id: "doubleEscapeAction",
	type: "enum",
	values: ["rewind", "tree", "none"] as const,
	default: "rewind",
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Double-Escape Action",
		get description() {
			return `What pressing ${formatKeyHint("escape")} twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing`;
		},
	},
});

export const cfgBareExitOnEmptySession = register({
	id: "input.bareExitOnEmptySession",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Bare Exit on Empty Session",
		description:
			"Submitting exactly `exit`, `quit`, or `q` (any case) before the first message quits instead of prompting the model",
	},
});

export const cfgBareSlashCommands = register({
	id: "input.bareSlashCommands",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Bare Slash Commands",
		description:
			"Submitting exactly a command name without the leading `/` (e.g. `model`, `compact`) runs that slash command; once the session has messages, press Enter twice to confirm",
	},
});

export const cfgTreeFilterMode = register({
	id: "treeFilterMode",
	type: "enum",
	values: TREE_FILTER_MODES,
	default: "default",
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Session Tree Filter",
		description: "Default filter mode when opening the session tree",
	},
});

export const cfgAutocompleteMaxVisible = register({
	id: "autocompleteMaxVisible",
	type: "number",
	default: 10,
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
});

export const cfgSpellingTypoDetection = register({
	id: "spelling.typoDetection",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Typo Detection (macOS)",
		description: "Mark misspelled prompt words with the active macOS dictionaries",
		condition: "macOS",
	},
});

export const cfgSpellingAutocomplete = register({
	id: "spelling.autocomplete",
	type: "enum",
	values: WORD_COMPLETION_METHODS,
	default: "auto",
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Word Autocomplete",
		get description() {
			return `Show predicted word completions as inline hints: ${formatKeyHint("tab")} accepts with a space, ${formatKeyHint("right")} without`;
		},
		options: [
			{ value: "off", label: "Off", description: "No word completion" },
			{
				value: "auto",
				label: "Auto",
				description: "N-gram (nothing to download)",
			},
			{ value: "ngram", label: "N-gram", description: "Learns your vocabulary from prompt history" },
			{
				value: "smollm",
				label: "SmolLM",
				description: "Small on-device language model blended with N-gram (downloads weights on first use)",
			},
			...(process.platform === "darwin"
				? [{ value: "apple" as const, label: "Apple", description: "macOS dictionary completions" }]
				: []),
		],
	},
});

export const cfgSpellingAutocorrect = register({
	id: "spelling.autocorrect",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Autocorrect (macOS)",
		description: "Apply confident macOS spelling corrections after completed words",
		condition: "macOS",
	},
});

export const cfgEmojiAutocomplete = register({
	id: "emojiAutocomplete",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Input",
		label: "Emoji Autocomplete",
		description: "Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
	},
});
effect(cfgEmojiAutocomplete, setEmojiAutocompleteEnabled);

export const cfgPasteLargeMenuThreshold = register({
	id: "paste.largeMenuThreshold",
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
});

export const cfgStartupQuiet = register({
	id: "startup.quiet",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Quiet Startup",
		description: "Skip welcome screen and startup status messages",
	},
});

export const cfgStartupShowSplash = register({
	id: "startup.showSplash",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Show Startup Splash",
		description:
			"Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.",
	},
});

export const cfgStartupSetupWizard = register({
	id: "startup.setupWizard",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Setup Wizard",
		description: "Show newly added onboarding steps once per setup version",
	},
});

export const cfgStartupCheckUpdate = register({
	id: "startup.checkUpdate",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Check for Updates",
		description: "Check for omp updates on startup",
	},
});

export const cfgUpdateChannel = register({
	id: "update.channel",
	type: "enum",
	values: ["stable", "canary"] as const,
	default: "stable",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Update Channel",
		description: "Update channel used by omp update and the startup update check",
		options: [
			{ value: "stable", label: "Stable" },
			{ value: "canary", label: "Canary" },
		],
	},
});

export const cfgMarketplaceAutoUpdate = register({
	id: "marketplace.autoUpdate",
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
});

export const cfgStartupChangelogMode = register({
	id: "startup.changelogMode",
	type: "enum",
	values: ["summary", "expanded", "hidden"] as const,
	default: "summary",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Startup Changelog",
		description: "Choose whether update notes start as a summary, full details, or stay hidden",
		options: [
			{
				value: "summary",
				label: "Summary",
				description: "Show release and change counts with a /changelog hint",
			},
			{
				value: "expanded",
				label: "Expanded",
				description: "Show the recent release notes in full",
			},
			{
				value: "hidden",
				label: "Hidden",
				description: "Do not show release notes on startup",
			},
		],
	},
});

export const cfgMagicKeywordsEnabled = register({
	id: "magicKeywords.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Magic Keywords",
		label: "Magic Keywords",
		description: `Enable hidden notices for standalone ${MAGIC_KEYWORDS.map(keyword => keyword.word).join(", ")} keywords`,
	},
});

/** One `magicKeywords.<id>` toggle per registered keyword, keyed by keyword id. */
export const cfgMagicKeyword = Object.fromEntries(
	MAGIC_KEYWORDS.map(keyword => [
		keyword.id,
		register({
			id: `magicKeywords.${keyword.id}`,
			type: "boolean",
			default: true,
			ui: { tab: "interaction", group: "Magic Keywords", label: keyword.label, description: keyword.description },
		}),
	]),
) as Record<MagicKeywordId, Setting<boolean>>;

// Notifications
export const cfgCompletionNotify = register({
	id: "completion.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Completion Notification",
		description: "Notify when the agent finishes a turn",
	},
});

export const cfgErrorNotify = register({
	id: "error.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "off",
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Error Notification",
		description: "Notify when the agent stops with an error",
	},
});

export const cfgAskTimeout = register({
	id: "ask.timeout",
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
});

export const cfgAskNotify = register({
	id: "ask.notify",
	type: "enum",
	values: ["on", "off"] as const,
	default: "on",
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Ask Notification",
		description: "Notify when the ask tool is waiting for input",
	},
});

export const cfgRecapEnabled = register({
	id: "recap.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Idle Recap",
		description: "Generate a brief LLM recap of where things stand after the terminal has been idle",
	},
});

export const cfgRecapIdleSeconds = register({
	id: "recap.idleSeconds",
	type: "number",
	default: 240,
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Idle Recap Delay",
		description: "Seconds to wait while idle before showing the recap",
		options: [
			{ value: "60", label: "1 minute" },
			{ value: "120", label: "2 minutes" },
			{ value: "240", label: "4 minutes" },
			{ value: "300", label: "5 minutes" },
			{ value: "600", label: "10 minutes" },
		],
	},
});

/** Idle recap policy (`recap.*`). */
export const cfgRecap = combine({ enabled: cfgRecapEnabled, idleSeconds: cfgRecapIdleSeconds });
