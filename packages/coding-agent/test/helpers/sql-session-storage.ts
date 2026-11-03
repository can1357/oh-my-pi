import {
	type SqlSessionStorageAdapter,
	sessionRowKey,
	sessionRowPath,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { SQL } from "bun";

type SqlClient = InstanceType<typeof SQL>;

async function readPartsByKey(
	client: SqlClient,
	table: string,
	key: string,
	adapter: SqlSessionStorageAdapter,
): Promise<string[]> {
	const rows = (await client.unsafe(
		`SELECT content FROM ${table}_parts WHERE path = ${adapter === "postgres" ? "$1" : "?"} ORDER BY start_offset`,
		[key],
	)) as Array<{ content: string }>;
	return rows.map(row => row.content);
}

async function readSessionByKey(
	client: SqlClient,
	table: string,
	key: string,
	adapter: SqlSessionStorageAdapter,
): Promise<string | null> {
	const rows = (await client.unsafe(
		`SELECT content FROM ${table} WHERE path = ${adapter === "postgres" ? "$1" : "?"}`,
		[key],
	)) as Array<{ content: string }>;
	const row = rows[0];
	if (!row) return null;
	return row.content + (await readPartsByKey(client, table, key, adapter)).join("");
}

/**
 * The parts stored for the local path `path` in `<table>_parts`, in
 * `start_offset` order — the documented layout an external reader or the
 * rollback statement consumes. The row is found by the key a store with the
 * default sessions root writes for `path` ({@link sessionRowKey}).
 */
export function readStoredParts(
	client: SqlClient,
	table: string,
	path: string,
	adapter: SqlSessionStorageAdapter = "sqlite",
): Promise<string[]> {
	return readPartsByKey(client, table, sessionRowKey(path), adapter);
}

/**
 * A session's content as the documented schema stores it: the row's `content`
 * followed by its parts in `start_offset` order; `null` when no row exists.
 */
export function readStoredSession(
	client: SqlClient,
	table: string,
	path: string,
	adapter: SqlSessionStorageAdapter = "sqlite",
): Promise<string | null> {
	return readSessionByKey(client, table, sessionRowKey(path), adapter);
}

/**
 * Every stored session, ordered by key, reassembled like {@link readStoredSession}
 * and named by the local path its key maps to (the raw key when it maps to none).
 */
export async function readStoredSessions(
	client: SqlClient,
	table: string,
	adapter: SqlSessionStorageAdapter = "sqlite",
): Promise<Array<{ path: string; content: string }>> {
	const rows = (await client.unsafe(`SELECT path FROM ${table} ORDER BY path`)) as Array<{ path: string }>;
	const sessions: Array<{ path: string; content: string }> = [];
	for (const { path: key } of rows) {
		const content = (await readSessionByKey(client, table, key, adapter)) ?? "";
		sessions.push({ path: sessionRowPath(key) ?? key, content });
	}
	return sessions;
}
