import type { Database } from "bun:sqlite";
import { transaction } from "../db";

/** Whether the bank carries the beam bank's fts_facts external-content index. */
export function bankHasFactsFts(db: Database): boolean {
	return (
		db
			.query("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'fts_facts'")
			.get() !== null
	);
}

// External-content FTS is only refreshed by the INSERT/DELETE triggers, so
// in-place UPDATEs (re-stored facts, belief revisions) would leave fts_facts
// stale without this one. Beam banks (initBeam) and banks opened directly
// through the standalone graph store both need it, so the SQL is defined here
// exactly once.
export const factsFtsUpdateTriggerSql = [
	"CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN",
	"	INSERT INTO fts_facts(fts_facts, rowid, subject, predicate, object)",
	"	VALUES ('delete', old.rowid, old.subject, old.predicate, old.object);",
	"	INSERT INTO fts_facts(rowid, subject, predicate, object)",
	"	VALUES (new.rowid, new.subject, new.predicate, new.object);",
	"END",
].join("\n");

/**
 * The memory tier that owns a fact source id — working is checked first,
 * the same order as scope inheritance — or NULL when the id lives in no
 * tier (fixtures, orphaned references). Persisted on fact rows as
 * provenance so tier-scoped cleanup (id collisions) can retire one tier's
 * derivatives without touching the other tier's.
 */
/**
 * The channel id recorded on a fact source row (working checked first, same
 * order as provenance) — persisted on extracted facts so channel-scoped
 * sources stay recallable through their channel, not only through the
 * session that wrote them. NULL for standalone graph banks and for sources
 * without a channel.
 */
export function sourceChannelOf(db: Database, sourceMemoryId: string | null): string | null {
	if (sourceMemoryId == null || sourceMemoryId === "") return null;
	try {
		const working = db.prepare("SELECT channel_id FROM working_memory WHERE id = ?").get(sourceMemoryId) as { channel_id: string | null } | null;
		const episode = db.prepare("SELECT channel_id FROM episodic_memory WHERE id = ?").get(sourceMemoryId) as { channel_id: string | null } | null;
		if (working !== null && episode !== null) return null; // ambiguous id: no channel grant
		if (working !== null) {
			return typeof working.channel_id === "string" && working.channel_id !== "" ? working.channel_id : null;
		}
		if (episode !== null) {
			return typeof episode.channel_id === "string" && episode.channel_id !== "" ? episode.channel_id : null;
		}
	} catch {
		return null;
	}
	return null;
}

function tierTableHas(db: Database, table: string, id: string): boolean {
	try {
		return db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== null;
	} catch {
		// Standalone graph banks carry no memory tier tables.
		return false;
	}
}

export function sourceTierOf(db: Database, sourceMemoryId: string | null): string | null {
	if (sourceMemoryId == null || sourceMemoryId === "") return null;
	const inWorking = tierTableHas(db, "working_memory", sourceMemoryId);
	const inEpisode = tierTableHas(db, "episodic_memory", sourceMemoryId);
	// Present in BOTH tiers: the untyped id is ambiguous, so stamp NULL —
	// recall keeps the conservative both-tiers probe. A working-first stamp
	// would let an episode-derived fact validate against the unrelated
	// working row (and vice versa).
	if (inWorking && inEpisode) return null;
	if (inWorking) return "working";
	if (inEpisode) return "episodic";
	return null;
}

/**
 * Install the FTS update trigger when the bank has an fts_facts index. An
 * external-content index only reflects rows written while the trigger was
 * active, so whenever the trigger is being enabled for the first time on this
 * index (fresh create, or adopting a facts table that predates the index, as
 * when a standalone-graph bank is opened through the beam) the index must be
 * backfilled with a rebuild first — otherwise the first UPDATE on a
 * pre-existing fact issues an FTS `delete` for a row the index never saw
 * (SQLITE_CORRUPT_VTAB).
 */
export function ensureFactsFtsUpdateTrigger(db: Database): void {
	if (!bankHasFactsFts(db)) return;
	const hasTrigger =
		db.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'facts_au'").get() !== null;
	// The backfill and the trigger install must commit as one unit: a fact
	// update committed between a standalone rebuild and the trigger creation
	// would never be mirrored into the index (stale recall, and a later
	// trigger-driven delete targeting terms that were never indexed).
	transaction(db, () => {
		if (!hasTrigger) {
			db.run("INSERT INTO fts_facts(fts_facts) VALUES ('rebuild')");
		}
		db.run(factsFtsUpdateTriggerSql);
	});
}
