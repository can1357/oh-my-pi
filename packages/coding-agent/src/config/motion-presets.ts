// The `tui.motion` presets. Free of coding-agent imports so the flag table can import it during CLI
// bootstrap; the derivation that applies them lives beside the setting handles in `modes/settings.ts`.
import { DEFAULT_SPINNER_INTERVAL_MS, SPINNER_INTERVAL_STATIC } from "@oh-my-pi/pi-tui/spinner-clock";

export const MOTION_MODES = ["full", "reduced", "none"] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

/**
 * Per preset: the spinner period an unset `tui.spinnerInterval` takes, and whether decorative motion
 * (shimmer, blink, fade, `fx`) runs.
 */
export const MOTION_PRESETS: Readonly<
	Record<MotionMode, { readonly spinnerInterval: number; readonly effects: boolean }>
> = {
	full: { spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS, effects: true },
	reduced: { spinnerInterval: 250, effects: false },
	none: { spinnerInterval: SPINNER_INTERVAL_STATIC, effects: false },
};

/** Canonicalize a motion mode; accepts the three names, case-insensitive. */
export function parseMotionMode(value: unknown): MotionMode {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	if ((MOTION_MODES as readonly string[]).includes(text)) return text as MotionMode;
	throw new Error(`Motion mode must be one of ${MOTION_MODES.join(", ")}, got ${JSON.stringify(value)}.`);
}
