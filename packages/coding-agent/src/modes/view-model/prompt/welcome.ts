/**
 * Background self-update activity shown after the welcome banner's version
 * label: `updating` while a newer `version` downloads (`fraction` once bytes
 * are counted) or installs, `ready` once the next launch starts it, `failed`
 * when the attempt stopped.
 */
export type VersionUpdate =
	| { phase: "updating"; version: string; fraction?: number }
	| { phase: "ready"; version: string }
	| { phase: "failed"; version: string };
