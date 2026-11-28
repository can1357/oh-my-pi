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

/** A compaction as a v1 file holds it: the entry it keeps from is named by file index. */
type V1Compaction = Omit<CompactionEntry, "firstKeptEntryId"> & {
	firstKeptEntryId?: string;
	firstKeptEntryIndex?: number;
};

/** Ids the v1 → v2 migration has assigned so far, in file order. */
interface V1ToV2State {
	ids: Set<string>;
	prevId: string | null;
}

/**
 * v1 → v2 for one entry, in file order: assign its id and parent, and turn a
 * compaction's `firstKeptEntryIndex` into the `firstKeptEntryId` that
 * `keptEntryId` gives for that file index, or leave `firstKeptEntryId` as it
 * is when that is `null`. Mutates in place.
 */
function migrateEntryV1ToV2(
	entry: FileEntry,
	state: V1ToV2State,
	keptEntryId: (index: number, compaction: V1Compaction) => string | undefined | null,
): void {
	if (entry.type === "session") {
		entry.version = 2;
		return;
	}

	entry.id = generateId(state.ids);
	state.ids.add(entry.id);
	entry.parentId = state.prevId;
	state.prevId = entry.id;

	// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
	if (entry.type === "compaction") {
		const comp = entry as V1Compaction;
		if (typeof comp.firstKeptEntryIndex === "number") {
			const id = keptEntryId(comp.firstKeptEntryIndex, comp);
			if (id !== null) comp.firstKeptEntryId = id;
			delete comp.firstKeptEntryIndex;
		}
	}
}

/** v2 → v3 for one entry: rename the hookMessage role to custom. Mutates in place. */
function migrateEntryV2ToV3(entry: FileEntry): void {
	if (entry.type === "session") {
		entry.version = 3;
		return;
	}

	if (entry.type === "message") {
		const msg = entry.message as { role?: string };
		if (msg.role === "hookMessage") {
			(entry.message as { role: string }).role = "custom";
		}
	}
}

/** True for a non-header entry without an id: a session whose entries all look like this predates ids. */
export function lacksEntryId(entry: FileEntry): boolean {
	return entry.type !== "session" && (typeof entry.id !== "string" || entry.id.length === 0);
}

/**
 * A count of a transcript's entries toward its "unindexed" verdict: it has
 * non-header entries and none of them has an id, so it may predate ids
 * altogether (see {@link migrateToCurrentVersion}).
 */
export class UnindexedCount {
	#sawEntry = false;
	#sawId = false;

	/** Counts `entry`; true when it is a non-header entry with an id, which settles the verdict as false. */
	add(entry: FileEntry): boolean {
		if (entry.type === "session") return false;
		this.#sawEntry = true;
		if (lacksEntryId(entry)) return false;
		this.#sawId = true;
		return true;
	}

	/** The verdict on the entries counted so far. */
	get unindexed(): boolean {
		return this.#sawEntry && !this.#sawId;
	}
}

/**
 * The migrations a session needs, applied one entry at a time in file order:
 * a streamed load migrates each entry as it arrives, and
 * {@link migrateToCurrentVersion} migrates a whole file's entries the same
 * way. `header` is the file's first header, if it has one; `unindexed` is
 * whether the file has non-header entries and none of them has an id (see
 * {@link lacksEntryId}); a current-version file needs it to decide.
 */
export class SessionEntryMigration {
	readonly #header: SessionHeader | undefined;
	readonly #v1ToV2: boolean;
	readonly #v2ToV3: boolean;
	readonly #state: V1ToV2State = { ids: new Set(), prevId: null };
	/** The id each entry seen so far was given, `null` for a header, by file index. */
	readonly #seenIds: (string | null)[] = [];
	/** Compactions waiting for a later record's original id, keyed by its file index. */
	#pendingKeptEntries?: Map<number, V1Compaction[]>;

	constructor(header: SessionHeader | undefined, unindexed: boolean) {
		this.#header = header;
		const version = header?.version ?? 1;
		this.#v1ToV2 = version < 2 || unindexed;
		this.#v2ToV3 = version < 3;
		this.needed = !(version >= CURRENT_SESSION_VERSION && !unindexed);
	}

	/** Whether this session needs any migration; {@link migrate} is a no-op otherwise. */
	readonly needed: boolean;

	/** Migrate the next entry in file order, the header first. */
	migrate(entry: FileEntry): void {
		if (!this.needed) return;
		if (this.#v1ToV2) {
			const position = this.#seenIds.length;
			const byTarget = this.#pendingKeptEntries;
			if (byTarget) {
				const pending = byTarget.get(position);
				if (pending && entry.type !== "session") {
					for (const compaction of pending) compaction.firstKeptEntryId = entry.id;
				}
				byTarget.delete(position);
			}
			migrateEntryV1ToV2(entry, this.#state, (index, compaction) => {
				// The compaction itself, which holds its new id by now.
				if (index === position) return entry.id;
				// A forward target has not been renumbered yet. Leave the field alone
				// unless a non-header record actually arrives at that position.
				if (index > position && Number.isInteger(index)) {
					const targets = (this.#pendingKeptEntries ??= new Map());
					const waiting = targets.get(index);
					if (waiting) waiting.push(compaction);
					else targets.set(index, [compaction]);
					return null;
				}
				return this.#seenIds[index] ?? null;
			});
			this.#seenIds.push(entry.type === "session" ? null : entry.id);
		}
		if (this.#v2ToV3) migrateEntryV2ToV3(entry);
		// Only the file's first header: v1 → v2 leaves any later one at version 2.
		else if (entry === this.#header) entry.version = CURRENT_SESSION_VERSION;
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const count = new UnindexedCount();
	for (const entry of entries) {
		if (count.add(entry)) break;
	}
	const migration = new SessionEntryMigration(header, count.unindexed);
	if (!migration.needed) return false;
	for (const entry of entries) migration.migrate(entry);
	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}
