import type { TermPresentation } from "@oh-my-pi/pi-tui/term/backend";

/** Environment variable that overrides `tui.mode` for one launch without saving it. */
export const PRESENTATION_ENV = "PI_TUI_MODE";

/** The CLI accepts these exact spellings; the environment also accepts surrounding space and any case. */
export function isTuiMode(value: unknown): value is TermPresentation {
	return value === "inline" || value === "fullscreen";
}

/**
 * Reads a {@link PRESENTATION_ENV} value (trimmed, any case); other text counts as unset.
 * The `tui.mode` setting and the startup prepaint, which paints before Settings load,
 * share this parser so the first frame always matches the resolved presentation.
 */
export function parsePresentationEnv(raw: string): TermPresentation | undefined {
	const value = raw.trim().toLowerCase();
	return isTuiMode(value) ? value : undefined;
}
