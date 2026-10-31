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

/** Install the FTS update trigger when the bank has an fts_facts index. */
export function ensureFactsFtsUpdateTrigger(db: Database): void {
	if (bankHasFactsFts(db)) db.run(factsFtsUpdateTriggerSql);
}
