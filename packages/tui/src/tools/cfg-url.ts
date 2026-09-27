/** Canonical prefix for settings URLs. */
export const CFG_URL_PREFIX = "cfg://";

/** Trailing write segment that persists a `cfg://` change instead of scoping it to the session. */
export const CFG_SAVE_SEGMENT = "save";

/** Setting addressed by a `cfg://` URL. */
export interface CfgTarget {
	/** Setting path segments; empty for the root. `/` and `.` both separate segments. */
	segments: string[];
	/** Whether the URL ends in the `/save` suffix, which is removed from {@link segments}. */
	save: boolean;
}

/**
 * Parse a `cfg://` URL (`cfg://advisor/enabled`, `cfg://advisor.enabled/save`).
 * Returns `null` for other schemes; query and fragment are ignored.
 */
export function parseCfgUrl(input: string): CfgTarget | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(CFG_URL_PREFIX)) return null;
	const segments = trimmed
		.slice(CFG_URL_PREFIX.length)
		.replace(/[?#].*$/s, "")
		.split(/[/.]/)
		.filter(Boolean);
	const save = segments.length > 1 && segments.at(-1) === CFG_SAVE_SEGMENT;
	if (save) segments.pop();
	return { segments, save };
}
