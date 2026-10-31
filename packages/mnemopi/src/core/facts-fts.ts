import type { Database } from "bun:sqlite";

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
	if (!hasTrigger) {
		db.run("INSERT INTO fts_facts(fts_facts) VALUES ('rebuild')");
	}
	db.run(factsFtsUpdateTriggerSql);
}
