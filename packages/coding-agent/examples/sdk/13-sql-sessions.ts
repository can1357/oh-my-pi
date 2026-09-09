/**
 * SQL-Backed Sessions (PostgreSQL / MySQL / SQLite)
 *
 * Store session JSONL in a SQL database via `bun:sql`. One table, one row
 * per session file — works against PostgreSQL, MySQL/MariaDB, and SQLite
 * with the dialect picked automatically from the connection URL.
 *
 * Useful when:
 * - sessions need to be queryable from existing analytics infra (just JOIN
 *   against the rest of your warehouse);
 * - a managed Postgres/MySQL instance is already in place and adding Redis
 *   isn't worth the operational surface;
 * - you want a single durable file at rest (SQLite) without coding directly
 *   against `bun:sqlite`.
 *
 * Tool artifacts and image blobs are out of scope: `ArtifactManager` /
 * `BlobStore` keep writing to `~/.omp/agent/...`. Reach for object storage
 * if you need those off-host too.
 */

import { createAgentSession, SessionManager, SqlSessionStorage } from "@oh-my-pi/pi-coding-agent";
import { SQL } from "bun";

// Pick one — Bun.SQL auto-detects the dialect from the URL scheme.
//
//   postgres://user:pass@host:5432/db
//   mysql://user:pass@host:3306/db
//   sqlite:/absolute/path/to/sessions.sqlite
//   sqlite::memory:                                // ephemeral
const client = new SQL(process.env.SESSIONS_DB_URL ?? "sqlite::memory:");

// `create()` runs `CREATE TABLE IF NOT EXISTS` (with the right DDL for the
// dialect) and warms the in-memory mirror with every existing row.
const storage = await SqlSessionStorage.create({
	client,
	table: "omp_session_files", // optional, this is the default
	// createTable: false,       // set if migrations are owned elsewhere
});

const sessionDir = "/sessions/my-project";

// 1) Fresh persistent session, JSONL backed by SQL.
const { session } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd(), sessionDir, storage),
});
console.log(`New SQL session (${storage.adapter}):`, session.sessionFile);

// 2) Continue the most recent session for this `sessionDir`.
const { session: continued } = await createAgentSession({
	sessionManager: await SessionManager.continueRecent(process.cwd(), sessionDir, storage),
});
console.log("Resumed:", continued.sessionFile);

// 3) Enumerate every session row under this directory prefix.
const sessions = await SessionManager.list(process.cwd(), sessionDir, storage);
console.log(`Found ${sessions.length} sessions under ${sessionDir}`);

// On graceful shutdown, drain any background writes the writer queued and
// close the connection.
await storage.drain();
await client.end?.();
