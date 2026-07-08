CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  path        TEXT NOT NULL,
  anchor      TEXT,
  line_start  INTEGER,
  line_end    INTEGER,
  status      TEXT NOT NULL DEFAULT 'current',
  source_hash TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER,
  superseded_by TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);

CREATE TABLE IF NOT EXISTS edges (
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  kind      TEXT NOT NULL,
  weight    REAL NOT NULL DEFAULT 1.0,
  evidence  TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id, kind);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  title, summary, body, content=''
);
