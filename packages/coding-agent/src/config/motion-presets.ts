// The `tui.motion` preset: one switch over every animation, for sessions nobody is watching
// closely (dozens of panes, a shared screen) or for reduced-motion needs. Free of coding-agent imports so the
// flag table and the setting declarations can import it during CLI bootstrap; the `Derived` that
// applies it lives beside the setting handles in `modes/settings.ts`.
import { DEFAULT_MAX_FPS } from "@oh-my-pi/pi-tui/frame-rate";
import { DEFAULT_SPINNER_INTERVAL_MS, SPINNER_INTERVAL_STATIC } from "@oh-my-pi/pi-tui/spinner-clock";
import type { ShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";

export const MOTION_MODES = ["full", "reduced", "none"] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

/** Every animation knob the preset governs. */
export interface MotionSettings {
	/** Spinner period in ms (`tui.spinnerInterval`); 0 = static glyphs. */
	spinnerInterval: number;
	/** Frame-rate ceiling (`tui.maxFps`). */
	maxFps: number;
	/** Working-row text sweep (`display.shimmer`). */
	shimmer: ShimmerMode;
	/** Decorative one-off motion with no knob of its own: the status-line speculation blink and brand fade. */
	effects: boolean;
}

/**
 * Preset values. `full` is exactly the historical behaviour; `reduced` keeps motion legible at a
 * fraction of the frames; `none` stops every animation. Neither lowers the frame ceiling: the
 * animations pace themselves, and the ceiling would only throttle content (streaming text) — that is
 * what an explicit `tui.maxFps` is for.
 */
export const MOTION_PRESETS: Readonly<Record<MotionMode, Readonly<MotionSettings>>> = {
	full: { spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS, maxFps: DEFAULT_MAX_FPS, shimmer: "classic", effects: true },
	reduced: { spinnerInterval: 250, maxFps: DEFAULT_MAX_FPS, shimmer: "disabled", effects: false },
	none: { spinnerInterval: SPINNER_INTERVAL_STATIC, maxFps: DEFAULT_MAX_FPS, shimmer: "disabled", effects: false },
};

/** Which of the governed settings the user set explicitly (file, flag, or env); each wins over the preset. */
export interface ExplicitMotionSettings {
	spinnerInterval?: number;
	maxFps?: number;
	shimmer?: ShimmerMode;
}

/**
 * The effective animation settings: the preset's values, overridden by every knob the user set
 * explicitly. `effects` has no knob of its own and follows the preset.
 */
export function resolveMotion(mode: MotionMode, explicit: ExplicitMotionSettings): MotionSettings {
	const preset = MOTION_PRESETS[mode];
	return {
		spinnerInterval: explicit.spinnerInterval ?? preset.spinnerInterval,
		maxFps: explicit.maxFps ?? preset.maxFps,
		shimmer: explicit.shimmer ?? preset.shimmer,
		effects: preset.effects,
	};
}

/** Canonicalize a configured motion mode; accepts the three names, case-insensitive. */
export function parseMotionMode(value: unknown): MotionMode {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	if ((MOTION_MODES as readonly string[]).includes(text)) return text as MotionMode;
	throw new Error(`Motion mode must be one of ${MOTION_MODES.join(", ")}, got ${JSON.stringify(value)}.`);
}
