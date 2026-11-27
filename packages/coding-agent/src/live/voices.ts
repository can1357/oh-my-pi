/** Voices Codex-backed realtime sessions accept, offered as `live.voice` suggestions. */
export const LIVE_VOICE_OPTIONS = [
	{ value: "arbor", label: "Arbor" },
	{ value: "aube", label: "Aube" },
	{ value: "breeze", label: "Breeze" },
	{ value: "bubbie", label: "Bubbie" },
	{ value: "cove", label: "Cove" },
	{ value: "ember", label: "Ember" },
	{ value: "haetsal", label: "Haetsal" },
	{ value: "hanul", label: "Hanul" },
	{ value: "himari", label: "Himari" },
	{ value: "juniper", label: "Juniper" },
	{ value: "leher", label: "Leher" },
	{ value: "maple", label: "Maple" },
	{ value: "marin", label: "Marin" },
	{ value: "miko", label: "Miko" },
	{ value: "neer", label: "Neer" },
	{ value: "porto", label: "Porto" },
	{ value: "rindo", label: "Rindo" },
	{ value: "rio", label: "Rio" },
	{ value: "rivage", label: "Rivage" },
	{ value: "selva", label: "Selva" },
	{ value: "sol", label: "Sol" },
	{ value: "sonna", label: "Sonna" },
	{ value: "spruce", label: "Spruce" },
	{ value: "tinta", label: "Tinta" },
	{ value: "vale", label: "Vale" },
	{ value: "viola", label: "Viola" },
] as const;

/** Voice used when no live voice preference is configured. */
export const DEFAULT_LIVE_VOICE = "sol";
