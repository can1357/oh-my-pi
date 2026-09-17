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

/** Voices accepted by Grok-backed realtime sessions. */
export const GROK_LIVE_VOICE_OPTIONS = [
	{ value: "eve", label: "Eve" },
	{ value: "ara", label: "Ara" },
	{ value: "rex", label: "Rex" },
	{ value: "sal", label: "Sal" },
	{ value: "leo", label: "Leo" },
] as const;

/** Accepted values for the live voice setting. */
export const LIVE_VOICE_VALUES = LIVE_VOICE_OPTIONS.map(({ value }) => value);

/** Accepted values for the Grok live voice setting. */
export const GROK_LIVE_VOICE_VALUES = GROK_LIVE_VOICE_OPTIONS.map(({ value }) => value);

/** Voice used when no Codex live voice preference is configured. */
export const DEFAULT_LIVE_VOICE = "sol";

/** Voice used when no Grok live voice preference is configured. */
export const DEFAULT_GROK_LIVE_VOICE = "eve";

/** Fast membership lookup for Grok realtime voice ids. */
export const GROK_LIVE_VOICE_LOOKUP: Readonly<Record<string, true>> = {
	eve: true,
	ara: true,
	rex: true,
	sal: true,
	leo: true,
};

export const CODEX_LIVE_VOICE_OPTIONS = LIVE_VOICE_OPTIONS;
export const CODEX_LIVE_VOICE_VALUES = LIVE_VOICE_VALUES;
export const DEFAULT_CODEX_LIVE_VOICE = DEFAULT_LIVE_VOICE;
