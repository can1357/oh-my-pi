/**
 * Shared gopk activity-ingestion policy constants, in a dependency-free module
 * so the standalone ingester (compiled into gopk-ingest.exe) can import them
 * without dragging in the screenpipe bridge or the pi-utils barrel (which
 * eagerly loads the pi_natives native addon that cannot bundle into an exe).
 */

/**
 * Applications whose windows must never become activity evidence, even in
 * redacted-metadata form. Matched against the lowercased foreground process name.
 */
export const DENIED_APPLICATION_IDS: readonly string[] = [
	"1password",
	"bitwarden",
	"dashlane",
	"keepassxc",
	"keeper",
	"lastpass",
	"protonpass",
];

/** How long a rejected clip's raw pointer may linger before retention purges it. */
export const MAXIMUM_RAW_CLIP_RETENTION_MS = 10 * 60_000;
