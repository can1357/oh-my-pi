import type { Database } from "bun:sqlite";

type PragmaTableInfoRow = {
	name: string;
};

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): boolean {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as PragmaTableInfoRow[];
	for (const row of rows) {
		if (row.name === column) {
			return false;
		}
	}
	db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	return true;
}

function runAll(db: Database, statements: readonly string[]): void {
	for (const statement of statements) {
		db.run(statement);
	}
}

export function initBeam(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS working_memory (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			embed_text TEXT DEFAULT NULL,
			source TEXT,
			timestamp TEXT,
			session_id TEXT DEFAULT 'default',
			importance REAL DEFAULT 0.5,
			metadata_json TEXT,
			veracity TEXT DEFAULT 'unknown',
			memory_type TEXT DEFAULT 'unknown',
			consolidated_at TEXT,
			recall_count INTEGER DEFAULT 0,
			last_recalled TIMESTAMP DEFAULT NULL,
			valid_until TIMESTAMP DEFAULT NULL,
			superseded_by TEXT DEFAULT NULL,
			scope TEXT DEFAULT 'global',
			author_id TEXT DEFAULT NULL,
			author_type TEXT DEFAULT NULL,
			channel_id TEXT DEFAULT NULL,
			trust_tier TEXT DEFAULT 'STATED',
			validator TEXT DEFAULT NULL,
			validated_at TIMESTAMP DEFAULT NULL,
			validation_count INTEGER DEFAULT 0,
			event_date TEXT DEFAULT NULL,
			event_date_precision TEXT DEFAULT 'unknown',
			temporal_tags TEXT DEFAULT '[]',
			corrected_by INTEGER DEFAULT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS episodic_memory (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT UNIQUE NOT NULL,
			content TEXT NOT NULL,
			source TEXT,
			timestamp TEXT,
			session_id TEXT DEFAULT 'default',
			importance REAL DEFAULT 0.5,
			metadata_json TEXT,
			summary_of TEXT DEFAULT '',
			veracity TEXT DEFAULT 'unknown',
			tier INTEGER DEFAULT 1,
			degraded_at TEXT,
			memory_type TEXT DEFAULT 'unknown',
			binary_vector BLOB,
			recall_count INTEGER DEFAULT 0,
			last_recalled TIMESTAMP DEFAULT NULL,
			valid_until TIMESTAMP DEFAULT NULL,
			superseded_by TEXT DEFAULT NULL,
			scope TEXT DEFAULT 'global',
			author_id TEXT DEFAULT NULL,
			author_type TEXT DEFAULT NULL,
			channel_id TEXT DEFAULT NULL,
			trust_tier TEXT DEFAULT 'STATED',
			validator TEXT DEFAULT NULL,
			validated_at TIMESTAMP DEFAULT NULL,
			validation_count INTEGER DEFAULT 0,
			event_date TEXT DEFAULT NULL,
			event_date_precision TEXT DEFAULT 'unknown',
			temporal_tags TEXT DEFAULT '[]',
			corrected_by INTEGER DEFAULT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_wm_timestamp ON working_memory(timestamp)",
		"CREATE INDEX IF NOT EXISTS idx_wm_source ON working_memory(source)",
		"CREATE INDEX IF NOT EXISTS idx_em_session ON episodic_memory(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_em_timestamp ON episodic_memory(timestamp)",
		"CREATE INDEX IF NOT EXISTS idx_em_source ON episodic_memory(source)",
	]);

	addColumnIfMissing(db, "episodic_memory", "tier", "INTEGER DEFAULT 1");
	addColumnIfMissing(db, "episodic_memory", "degraded_at", "TEXT");
	db.run("CREATE INDEX IF NOT EXISTS idx_em_tier ON episodic_memory(tier)");
	addColumnIfMissing(db, "working_memory", "veracity", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "episodic_memory", "veracity", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "working_memory", "memory_type", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "working_memory", "embed_text", "TEXT DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "memory_type", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "episodic_memory", "binary_vector", "BLOB");
	const consolidatedAtAdded = addColumnIfMissing(db, "working_memory", "consolidated_at", "TEXT");
	if (consolidatedAtAdded) {
		db.run("UPDATE working_memory SET consolidated_at = ? WHERE consolidated_at IS NULL", [new Date().toISOString()]);
	}
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_wm_unconsolidated ON working_memory(session_id, timestamp) WHERE consolidated_at IS NULL",
	);

	db.run(`
		CREATE TABLE IF NOT EXISTS scratchpad (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			session_id TEXT DEFAULT 'default',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_sp_session ON scratchpad(session_id)");

	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
			content,
			content='episodic_memory',
			content_rowid='rowid'
		)
	`);
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_working USING fts5(
			id UNINDEXED,
			content
		)
	`);
	runAll(db, [
		`CREATE TRIGGER IF NOT EXISTS em_ai AFTER INSERT ON episodic_memory BEGIN
			INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS em_ad AFTER DELETE ON episodic_memory BEGIN
			INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS em_au AFTER UPDATE ON episodic_memory BEGIN
			INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
			INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
		END`,
		"DROP TRIGGER IF EXISTS wm_ai",
		`CREATE TRIGGER IF NOT EXISTS wm_ai AFTER INSERT ON working_memory BEGIN
			INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
		END`,
		`CREATE TRIGGER IF NOT EXISTS wm_ad AFTER DELETE ON working_memory BEGIN
			DELETE FROM fts_working WHERE id = old.id;
		END`,
		"DROP TRIGGER IF EXISTS wm_au",
		`CREATE TRIGGER IF NOT EXISTS wm_au AFTER UPDATE OF content, embed_text ON working_memory BEGIN
			DELETE FROM fts_working WHERE id = old.id;
			INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
		END`,
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_facts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			message_idx INTEGER,
			fact_type TEXT,
			key TEXT,
			value TEXT,
			context_snippet TEXT,
			importance REAL DEFAULT 0.5,
			timestamp TEXT,
			version_id INTEGER DEFAULT 0,
			previous_value TEXT,
			updated_msg_idx INTEGER,
			valid_from_msg_idx INTEGER,
			valid_to_msg_idx INTEGER,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_facts_key ON memoria_facts(key)",
		"CREATE INDEX IF NOT EXISTS idx_facts_type ON memoria_facts(fact_type)",
		"CREATE INDEX IF NOT EXISTS idx_facts_session ON memoria_facts(session_id)",
	]);
	addColumnIfMissing(db, "memoria_facts", "version_id", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "memoria_facts", "previous_value", "TEXT");
	addColumnIfMissing(db, "memoria_facts", "updated_msg_idx", "INTEGER");
	addColumnIfMissing(db, "memoria_facts", "valid_from_msg_idx", "INTEGER");
	addColumnIfMissing(db, "memoria_facts", "valid_to_msg_idx", "INTEGER");
	addColumnIfMissing(db, "memoria_facts", "source_memory_id", "TEXT");

	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_timelines (
			event_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			date TEXT,
			message_idx INTEGER,
			description TEXT,
			source TEXT,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_timelines_date ON memoria_timelines(date)",
		"CREATE INDEX IF NOT EXISTS idx_timelines_session ON memoria_timelines(session_id)",
	]);
	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_instructions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			message_idx INTEGER,
			instruction TEXT,
			active INTEGER DEFAULT 1,
			topic TEXT,
			context_snippet TEXT,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_instr_session ON memoria_instructions(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_instr_active ON memoria_instructions(active)",
	]);
	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_preferences (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			message_idx INTEGER,
			preference TEXT,
			topic TEXT,
			evolution TEXT,
			context_snippet TEXT,
			source_memory_id TEXT
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_pref_session ON memoria_preferences(session_id)");
	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_kg (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			subject TEXT,
			predicate TEXT,
			object TEXT,
			message_idx INTEGER,
			confidence REAL DEFAULT 0.7,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_kg_subject ON memoria_kg(subject)",
		"CREATE INDEX IF NOT EXISTS idx_kg_predicate ON memoria_kg(predicate)",
		"CREATE INDEX IF NOT EXISTS idx_kg_session ON memoria_kg(session_id)",
	]);
	for (const table of ["memoria_timelines", "memoria_instructions", "memoria_preferences", "memoria_kg"] as const) {
		addColumnIfMissing(db, table, "source_memory_id", "TEXT");
	}

	db.run(`
		CREATE TABLE IF NOT EXISTS consolidation_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT,
			items_consolidated INTEGER,
			summary_preview TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS memory_embeddings (
			memory_id TEXT PRIMARY KEY,
			embedding_json TEXT NOT NULL,
			model TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	addColumnIfMissing(db, "working_memory", "recall_count", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "working_memory", "last_recalled", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "recall_count", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "episodic_memory", "last_recalled", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "working_memory", "valid_until", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "working_memory", "superseded_by", "TEXT DEFAULT NULL");
	addColumnIfMissing(db, "working_memory", "scope", "TEXT DEFAULT 'global'");
	addColumnIfMissing(db, "episodic_memory", "valid_until", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "superseded_by", "TEXT DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "scope", "TEXT DEFAULT 'global'");
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_em_scope_imp ON episodic_memory(scope, importance) WHERE superseded_by IS NULL",
		"CREATE INDEX IF NOT EXISTS idx_wm_session_recall ON working_memory(session_id, last_recalled) WHERE valid_until IS NULL",
		"CREATE INDEX IF NOT EXISTS idx_mem_emb_type ON memory_embeddings(memory_id, model)",
	]);

	for (const table of ["working_memory", "episodic_memory"] as const) {
		addColumnIfMissing(db, table, "author_id", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "author_type", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "channel_id", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "trust_tier", "TEXT DEFAULT 'STATED'");
		addColumnIfMissing(db, table, "validator", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "validated_at", "TIMESTAMP DEFAULT NULL");
		addColumnIfMissing(db, table, "validation_count", "INTEGER DEFAULT 0");
	}
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_wm_author ON working_memory(author_id)",
		"CREATE INDEX IF NOT EXISTS idx_wm_channel ON working_memory(channel_id)",
		"CREATE INDEX IF NOT EXISTS idx_em_author ON episodic_memory(author_id)",
		"CREATE INDEX IF NOT EXISTS idx_em_channel ON episodic_memory(channel_id)",
		"CREATE INDEX IF NOT EXISTS idx_wm_validator ON working_memory(validator)",
		"CREATE INDEX IF NOT EXISTS idx_wm_validated_at ON working_memory(validated_at)",
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS memory_validations (
			validation_id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			validator TEXT NOT NULL,
			validated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			action TEXT NOT NULL,
			new_content TEXT,
			note TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_validations_memory ON memory_validations(memory_id)",
		"CREATE INDEX IF NOT EXISTS idx_validations_validator ON memory_validations(validator)",
		`CREATE TRIGGER IF NOT EXISTS trim_validations_to_3
		AFTER INSERT ON memory_validations
		BEGIN
			DELETE FROM memory_validations
			WHERE memory_id = NEW.memory_id
			  AND validation_id NOT IN (
				SELECT validation_id FROM memory_validations
				WHERE memory_id = NEW.memory_id
				ORDER BY validation_id DESC
				LIMIT 3
			  );
		END`,
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS facts (
			fact_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			subject TEXT NOT NULL,
			predicate TEXT NOT NULL,
			object TEXT NOT NULL,
			timestamp TEXT,
			source_msg_id TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)",
		"CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_msg_id)",
	]);
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_facts USING fts5(
			subject, predicate, object, content='facts'
		)
	`);
	runAll(db, [
		`CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
			INSERT INTO fts_facts(rowid, subject, predicate, object)
			VALUES (new.rowid, new.subject, new.predicate, new.object);
		END`,
		`CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
			INSERT INTO fts_facts(fts_facts, rowid, subject, predicate, object)
			VALUES ('delete', old.rowid, old.subject, old.predicate, old.object);
		END`,
	]);

	for (const table of ["working_memory", "episodic_memory"] as const) {
		addColumnIfMissing(db, table, "event_date", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "event_date_precision", "TEXT DEFAULT 'unknown'");
		addColumnIfMissing(db, table, "temporal_tags", "TEXT DEFAULT '[]'");
		addColumnIfMissing(db, table, "corrected_by", "INTEGER DEFAULT NULL");
	}
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_wm_event_date ON working_memory(event_date)",
		"CREATE INDEX IF NOT EXISTS idx_em_event_date ON episodic_memory(event_date)",
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS annotations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			value TEXT NOT NULL,
			source TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_annot_memory_kind ON annotations(memory_id, kind)",
		"CREATE INDEX IF NOT EXISTS idx_annot_kind_value ON annotations(kind, value)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_annot_unique ON annotations(memory_id, kind, value)",
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS triples (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			subject TEXT NOT NULL,
			predicate TEXT NOT NULL,
			object TEXT NOT NULL,
			valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			valid_until TEXT,
			source TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject)",
		"CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate)",
		"CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object)",
		"CREATE INDEX IF NOT EXISTS idx_triples_valid_from ON triples(valid_from)",
	]);
}
