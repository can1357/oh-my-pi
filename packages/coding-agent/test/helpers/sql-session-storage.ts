import type { SqlSessionStorageAdapter } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { SQL } from "bun";

type SqlClient = InstanceType<typeof SQL>;

/**
 * The parts stored for `path` in `<table>_parts`, in `start_offset` order —
 * the documented layout an external reader or the rollback statement consumes.
 */
export async function readStoredParts(
	client: SqlClient,
	table: string,
	path: string,
	adapter: SqlSessionStorageAdapter = "sqlite",
): Promise<string[]> {
	const rows = (await client.unsafe(
		`SELECT content FROM ${table}_parts WHERE path = ${adapter === "postgres" ? "$1" : "?"} ORDER BY start_offset`,
		[path],
	)) as Array<{ content: string }>;
	return rows.map(row => row.content);
}

/**
 * A session's content as the documented schema stores it: the row's `content`
 * followed by its parts in `start_offset` order; `null` when no row exists.
 */
export async function readStoredSession(
	client: SqlClient,
	table: string,
	path: string,
	adapter: SqlSessionStorageAdapter = "sqlite",
): Promise<string | null> {
	const rows = (await client.unsafe(
		`SELECT content FROM ${table} WHERE path = ${adapter === "postgres" ? "$1" : "?"}`,
		[path],
	)) as Array<{ content: string }>;
	const row = rows[0];
	if (!row) return null;
	return row.content + (await readStoredParts(client, table, path, adapter)).join("");
}

/** Every stored session, ordered by path, reassembled like {@link readStoredSession}. */
export async function readStoredSessions(
	client: SqlClient,
	table: string,
	adapter: SqlSessionStorageAdapter = "sqlite",
): Promise<Array<{ path: string; content: string }>> {
	const rows = (await client.unsafe(`SELECT path FROM ${table} ORDER BY path`)) as Array<{ path: string }>;
	const sessions: Array<{ path: string; content: string }> = [];
	for (const { path } of rows) {
		sessions.push({ path, content: (await readStoredSession(client, table, path, adapter)) ?? "" });
	}
	return sessions;
}
