/** Voices accepted by Codex-backed realtime sessions and exposed in settings. */
export const LIVE_VOICE_OPTIONS = [
	{ value: "arbor", label: "Arbor" },
	{ value: "breeze", label: "Breeze" },
	{ value: "cove", label: "Cove" },
	{ value: "ember", label: "Ember" },
	{ value: "juniper", label: "Juniper" },
	{ value: "maple", label: "Maple" },
	{ value: "sol", label: "Sol" },
	{ value: "spruce", label: "Spruce" },
	{ value: "vale", label: "Vale" },
] as const;

/** Accepted values for the live voice setting. */
export const LIVE_VOICE_VALUES = LIVE_VOICE_OPTIONS.map(({ value }) => value);

/** Voice used when no live voice preference is configured. */
export const DEFAULT_LIVE_VOICE = "sol";
