import { Snowflake } from "@oh-my-pi/pi-utils";
import { type CompactionEntry, CURRENT_SESSION_VERSION, type FileEntry, type SessionHeader } from "./session-entries";

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(-8);
		if (!byId.has(id)) return id;
	}
	return Snowflake.next(); // fallback to full snowflake id
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msg = entry.message as { role?: string };
			if (msg.role === "hookMessage") {
				(entry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * Migrate v3 → v4: stamp the header only. Genuinely a no-op on every other
 * entry — v3 and earlier files were written before `tool_execution_started`/
 * `tool_execution_settled` existed, so there is no legacy shape to translate
 * or backfill into them ("a v3→v4 migration cannot invent
 * structure for old result messages"). A migrated v4 file therefore
 * legitimately mixes untouched legacy entries with, going forward, new
 * journal entries a v4+ writer appends.
 */
function migrateV3ToV4(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 4;
			break;
		}
	}
}

/** A session file whose header version exceeds what this build understands. */
export class SessionVersionTooNewError extends Error {
	constructor(
		readonly version: number,
		readonly supported: number,
	) {
		super(
			`Session file is version ${version}, but this build only supports up to version ${supported}. ` +
				"Update to a newer version to open it.",
		);
		this.name = "SessionVersionTooNewError";
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 *
 * A header newer than `CURRENT_SESSION_VERSION` fails closed instead of being
 * treated as already-migrated: `version >= current` is not a
 * forward-compatibility check, and this build cannot honor a schema it
 * predates.
 */
export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version > CURRENT_SESSION_VERSION) throw new SessionVersionTooNewError(version, CURRENT_SESSION_VERSION);
	if (version === CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) migrateV3ToV4(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}
