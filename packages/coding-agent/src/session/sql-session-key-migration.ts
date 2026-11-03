/**
 * One-time rewrites of SQL session row keys between the layout an older Oh My
 * Pi wrote (the writer's absolute local path) and the one
 * {@link sessionRowKey} writes (`sessions/<path under the sessions root>` or
 * `abs:<absolute path>`), and back. `omp session migrate-keys` and
 * `omp session rollback-keys` run them.
 *
 * Every decision is made here with exact string comparison, never by the
 * database's collation: each key is classified with the functions the
 * store's reader uses, and a plan that would leave a row unreadable, make two
 * rows one, or not fit the `path` column is refused as a whole. An accepted
 * plan runs in one transaction over both tables. Every changing key first
 * moves to a temporary key, then to its final key, so no chain or swap of
 * keys meets a primary-key conflict; the transaction re-reads both tables'
 * keys and commits only when they are exactly the planned ones.
 */
import * as path from "node:path";
import {
	ABSOLUTE_KEY_PREFIX,
	detectAdapter,
	ensureSqliteBusyTimeout,
	ROOT_KEY_PREFIX,
	runSqlTransaction,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
	sessionRowKey,
	sessionRowPath,
	sessionTableName,
} from "./sql-session-storage";

/** Prefix of the temporary keys a move passes through; no stored key may start with it. */
export const TEMPORARY_KEY_PREFIX = "omp-key-migration:";

/** Keys per `UPDATE`: three bound values each (the `CASE` pair and the `IN` list) stay under SQLite's 999. */
const KEYS_PER_STATEMENT = 200;

/** The keys of both tables, as the database stores them, and what the `path` column holds. */
export interface SessionKeyInventory {
	adapter: SqlSessionStorageAdapter;
	/** Each distinct key of `<table>` and its row count. */
	files: ReadonlyMap<string, number>;
	/** Each distinct key of `<table>_parts` and its row count; empty when that table does not exist. */
	parts: ReadonlyMap<string, number>;
	/** Most characters the `path` column of either table holds; `undefined` when unbounded. */
	maxKeyLength: number | undefined;
}

export type SessionKeyRefusalKind =
	/** A sessions root that is not absolute, names the directory another names, or lies under another. */
	| "root"
	/** A key that starts with {@link TEMPORARY_KEY_PREFIX}. */
	| "reserved-key"
	/** A legacy key that is not an absolute path: it has no base directory to resolve against. */
	| "relative-key"
	/** A `sessions/…` or `abs:…` key the reader would skip. */
	| "unreadable-key"
	/** A key a rollback cannot turn back: neither `sessions/…` nor `abs:…`. */
	| "legacy-key"
	/** Two or more keys that would become one. */
	| "collision"
	/** A new key longer than the `path` column holds. */
	| "too-long"
	/** Keys MySQL's `PAD SPACE` collation compares equal: they differ only in trailing spaces. */
	| "trailing-space";

/** One reason a plan cannot run, with every key (or root) it concerns. */
export interface SessionKeyRefusal {
	kind: SessionKeyRefusalKind;
	/** What is wrong with each key listed, or with the listed keys together. */
	reason: string;
	keys: string[];
}

/** The distinct keys of both tables by what the plan does with them; refused keys are in no count. */
export interface SessionKeyCounts {
	/** Keys in the current layout that stay as they are (migration only). */
	unchanged: number;
	/** Keys moving to (migration) or from (rollback) `sessions/…`. */
	rootRelative: number;
	/** Keys moving to (migration) or from (rollback) `abs:…`. */
	absolute: number;
	/** Of the legacy keys moving, those not spelled as their canonical path (migration only). */
	respelled: number;
}

export interface SessionKeyPlan {
	/** Distinct keys read: of `<table>`, of `<table>_parts`, and of both. */
	keys: { files: number; parts: number; distinct: number };
	counts: SessionKeyCounts;
	/** Old key → new key, for every key that changes. */
	moves: ReadonlyMap<string, string>;
	/** Why the plan cannot run; empty when it can. A refused plan changes nothing. */
	refusals: SessionKeyRefusal[];
}

export interface SessionKeyChangeOptions {
	/** Connected `Bun.SQL` client; the change runs in one transaction on it. */
	client: SqlSessionStorageClient;
	/** Override the adapter detected from `client.options.adapter`. */
	adapter?: SqlSessionStorageAdapter;
	/** Session table name, as for `SqlSessionStorage`. Default: `omp_session_files`. */
	table?: string;
	/** Plan only: read both tables and change nothing. */
	dryRun: boolean;
	/**
	 * Rewrite each value (a key, a root) before a refusal reason or an error
	 * quotes it, for example to remove the connection string. It runs on the
	 * raw value, before quoting escapes it. Default: no rewriting.
	 */
	redact?: (text: string) => string;
}

export interface SessionKeyMigrationOptions extends SessionKeyChangeOptions {
	/** Every sessions root the legacy keys were written under. */
	roots: readonly string[];
}

export interface SessionKeyRollbackOptions extends SessionKeyChangeOptions {
	/** The one sessions root every `sessions/…` key restores beneath. */
	restoreRoot: string;
}

export interface SessionKeyChangeResult {
	plan: SessionKeyPlan;
	/** Whether the keys moved: false on a dry run, a refused plan, or a plan with nothing to move. */
	applied: boolean;
}

/**
 * `file` resolved as a POSIX path (`.` and `..` segments, repeated and
 * trailing `/`) without following symbolic links, as the store's
 * `path.resolve` does; `undefined` unless `file` is absolute.
 */
function canonicalPath(file: string): string | undefined {
	return path.posix.isAbsolute(file) ? path.posix.resolve(file) : undefined;
}

/** Whether the canonical path `file` lies strictly beneath the canonical directory `root`. */
function isUnder(file: string, root: string): boolean {
	return file !== root && file.startsWith(root === "/" ? "/" : `${root}/`);
}

function emptyCounts(): SessionKeyCounts {
	return { unchanged: 0, rootRelative: 0, absolute: 0, respelled: 0 };
}

/** Every distinct key of both tables, in code-unit order. */
function allKeys(inventory: SessionKeyInventory): string[] {
	return [...new Set([...inventory.files.keys(), ...inventory.parts.keys()])].sort();
}

/** Add a refusal listing `keys`, when there are any. */
function refuse(refusals: SessionKeyRefusal[], kind: SessionKeyRefusalKind, reason: string, keys: string[]): void {
	if (keys.length > 0) refusals.push({ kind, reason, keys });
}

/** How a reason or an error quotes a value (`redact` it, then JSON-quote it). */
type Quote = (value: string) => string;

/**
 * The {@link Quote} that runs `redact` on the raw value and then JSON-quotes
 * it: quoting first would escape a secret holding `"`, `\` or a control
 * character into a spelling the redactor does not look for.
 */
function quoter(redact: (text: string) => string = text => text): Quote {
	return value => JSON.stringify(redact(value));
}

/**
 * The canonical form of each sessions root, refusing a root that is not
 * absolute, two roots that name one directory, and a root under another (a
 * key under both would have two new keys).
 */
function canonicalRoots(roots: readonly string[], refusals: SessionKeyRefusal[], quote: Quote): string[] {
	if (roots.length === 0) refusals.push({ kind: "root", reason: "no sessions root was given", keys: [] });
	refuse(
		refusals,
		"root",
		"not an absolute path",
		roots.filter(root => canonicalPath(root) === undefined),
	);
	const spellings = groupBy(
		roots.filter(root => canonicalPath(root) !== undefined),
		root => canonicalPath(root) ?? root,
	);
	const canonical = [...spellings.keys()];
	for (const [directory, listed] of spellings) {
		if (listed.length > 1) refuse(refusals, "root", `these name one directory, ${quote(directory)}`, listed);
		for (const other of canonical) {
			if (!isUnder(other, directory)) continue;
			refuse(refusals, "root", `nested: ${quote(other)} lies under ${quote(directory)}`, [
				...listed,
				...(spellings.get(other) ?? []),
			]);
		}
	}
	return canonical;
}

/**
 * The plan of a key migration: each legacy key (an absolute path, as an
 * older Oh My Pi wrote it) resolved as a POSIX path and keyed `sessions/` and
 * its path under the one root it lies beneath, else `abs:` and that path.
 * Keys already in the current layout stay, if every root's reader would read
 * them back. Refuses a relative legacy key, a current key some root's reader
 * skips, keys that would become one, a key longer than the column holds,
 * and bad roots. `redact` rewrites each value a refusal reason quotes.
 */
export function planSessionKeyMigration(
	inventory: SessionKeyInventory,
	roots: readonly string[],
	redact?: (text: string) => string,
): SessionKeyPlan {
	const quote = quoter(redact);
	const refusals: SessionKeyRefusal[] = [];
	const canonical = canonicalRoots(roots, refusals, quote);
	const counts = emptyCounts();
	const targets = new Map<string, string>();
	const reserved: string[] = [];
	const relative: string[] = [];
	const unreadable: string[] = [];
	for (const key of allKeys(inventory)) {
		if (key.startsWith(TEMPORARY_KEY_PREFIX)) {
			reserved.push(key);
		} else if (key.startsWith(ROOT_KEY_PREFIX) || key.startsWith(ABSOLUTE_KEY_PREFIX)) {
			// The store skips a key it would not write back for the path it maps to.
			if (canonical.every(root => sessionRowPath(key, root) !== undefined)) {
				targets.set(key, key);
				counts.unchanged++;
			} else {
				unreadable.push(key);
			}
		} else {
			const file = canonicalPath(key);
			if (file === undefined) {
				relative.push(key);
				continue;
			}
			const root = canonical.find(candidate => isUnder(file, candidate));
			const next = root === undefined ? ABSOLUTE_KEY_PREFIX + file : sessionRowKey(file, root);
			// The reader of the root it lies under (of every root, for an `abs:` key) maps it back to `file`.
			const readable =
				root === undefined
					? canonical.every(candidate => sessionRowPath(next, candidate) === file)
					: sessionRowPath(next, root) === file;
			if (!readable) {
				unreadable.push(key);
				continue;
			}
			targets.set(key, next);
			if (root === undefined) counts.absolute++;
			else counts.rootRelative++;
			if (file !== key) counts.respelled++;
		}
	}
	refuse(
		refusals,
		"reserved-key",
		`starts with the reserved prefix ${JSON.stringify(TEMPORARY_KEY_PREFIX)}`,
		reserved,
	);
	refuse(
		refusals,
		"relative-key",
		"a relative path, with no base directory to resolve it against; delete or rename the row first",
		relative,
	);
	refuse(
		refusals,
		"unreadable-key",
		"the store would not read it back under a listed sessions root: a sessions/ key with an empty, . or .. " +
			"segment, or an abs: key that is not an absolute canonical path or lies under a listed root",
		unreadable,
	);
	return finishPlan(inventory, targets, counts, refusals, quote);
}

/**
 * The plan of a key rollback to the layout an older Oh My Pi reads: each
 * `sessions/<path>` key becomes `<restoreRoot>/<path>`, each `abs:<path>` key
 * `<path>`. Every root-relative key restores beneath the one restore root,
 * whatever root it was written under. Refuses a `sessions/` key with an
 * empty, `.` or `..` segment (the last one included), an `abs:` key that is
 * not an absolute canonical path, a key in neither layout, keys that would
 * become one, a key longer than the column holds, and a relative root.
 * `redact` rewrites each value a refusal reason quotes.
 */
export function planSessionKeyRollback(
	inventory: SessionKeyInventory,
	restoreRoot: string,
	redact?: (text: string) => string,
): SessionKeyPlan {
	const quote = quoter(redact);
	const refusals: SessionKeyRefusal[] = [];
	const root = canonicalPath(restoreRoot);
	if (root === undefined) refuse(refusals, "root", "not an absolute path", [restoreRoot]);
	const counts = emptyCounts();
	const targets = new Map<string, string>();
	const reserved: string[] = [];
	const legacy: string[] = [];
	const unreadable: string[] = [];
	for (const key of allKeys(inventory)) {
		if (key.startsWith(TEMPORARY_KEY_PREFIX)) {
			reserved.push(key);
		} else if (key.startsWith(ROOT_KEY_PREFIX)) {
			// The reader's own mapping, which refuses every empty, `.` or `..` segment.
			const file = sessionRowPath(key, root ?? "/");
			if (file === undefined) {
				unreadable.push(key);
				continue;
			}
			targets.set(key, file);
			counts.rootRelative++;
		} else if (key.startsWith(ABSOLUTE_KEY_PREFIX)) {
			const file = key.slice(ABSOLUTE_KEY_PREFIX.length);
			if (canonicalPath(file) !== file) {
				unreadable.push(key);
				continue;
			}
			targets.set(key, file);
			counts.absolute++;
		} else {
			legacy.push(key);
		}
	}
	refuse(
		refusals,
		"reserved-key",
		`starts with the reserved prefix ${JSON.stringify(TEMPORARY_KEY_PREFIX)}`,
		reserved,
	);
	refuse(refusals, "legacy-key", "neither a sessions/… nor an abs:… key", legacy);
	refuse(
		refusals,
		"unreadable-key",
		"names no canonical path: a sessions/ key with an empty, . or .. segment, or an abs: key that is not an " +
			"absolute canonical path",
		unreadable,
	);
	return finishPlan(inventory, targets, counts, refusals, quote);
}

/** Refuse keys that would become one or not fit the column, and collect the moves. */
function finishPlan(
	inventory: SessionKeyInventory,
	targets: ReadonlyMap<string, string>,
	counts: SessionKeyCounts,
	refusals: SessionKeyRefusal[],
	quote: Quote,
): SessionKeyPlan {
	const sources = groupBy(targets.keys(), key => targets.get(key) ?? key);
	for (const [next, keys] of sources) {
		if (keys.length > 1) refuse(refusals, "collision", `these would all become ${quote(next)}`, keys);
	}
	const moves = new Map<string, string>();
	for (const [key, next] of targets) if (next !== key) moves.set(key, next);

	const max = inventory.maxKeyLength;
	if (max !== undefined) {
		// The column counts characters (code points), not UTF-16 units.
		const tooLong = [...moves].filter(([, next]) => [...next].length > max).map(([key]) => key);
		refuse(refusals, "too-long", `the new key is longer than the ${max} characters the path column holds`, tooLong);
		if (moves.size > 0 && temporaryKey(moves.size - 1).length > max) {
			refuse(
				refusals,
				"too-long",
				`the temporary keys are longer than the ${max} characters the path column holds`,
				[...moves.keys()],
			);
		}
	}
	if (inventory.adapter === "mysql") {
		// `utf8mb4_bin` pads with spaces: `WHERE path = 'a'` also matches `'a '`,
		// and a primary key holds only one of them.
		const trimmed = (key: string): string => key.replace(/ +$/, "");
		for (const keys of groupBy(allKeys(inventory), trimmed).values()) {
			if (keys.length < 2) continue;
			refuse(
				refusals,
				"trailing-space",
				"these differ only in trailing spaces, which MySQL compares as equal",
				keys,
			);
		}
		for (const targetKeys of groupBy(sources.keys(), trimmed).values()) {
			if (targetKeys.length < 2) continue;
			refuse(
				refusals,
				"trailing-space",
				`these would become keys that differ only in trailing spaces, which MySQL compares as equal: [${targetKeys.map(quote).join(",")}]`,
				targetKeys.flatMap(next => sources.get(next) ?? []),
			);
		}
	}
	const distinct = new Set([...inventory.files.keys(), ...inventory.parts.keys()]).size;
	return {
		keys: { files: inventory.files.size, parts: inventory.parts.size, distinct },
		counts,
		moves,
		refusals,
	};
}

/** `items` grouped by `keyOf`, each group in iteration order. */
function groupBy<T>(items: Iterable<T>, keyOf: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key);
		if (group) group.push(item);
		else groups.set(key, [item]);
	}
	return groups;
}

/** The `index`th temporary key a move passes through. */
function temporaryKey(index: number): string {
	return `${TEMPORARY_KEY_PREFIX}${index}`;
}

/** Where both tables are and what their `path` column holds, read inside the transaction. */
interface TableLayout {
	table: string;
	/** `<table>_parts`, when it exists. */
	parts: string | undefined;
	maxKeyLength: number | undefined;
}

/** One row per `path` column of the table named by the bound value; none when the table does not exist. */
const PATH_COLUMN_QUERY: Record<SqlSessionStorageAdapter, string> = {
	sqlite: "SELECT NULL AS max_length FROM pragma_table_info(?) WHERE name = 'path'",
	postgres:
		"SELECT c.character_maximum_length AS max_length FROM information_schema.columns AS c " +
		"JOIN pg_catalog.pg_class AS r ON r.relname = c.table_name " +
		"JOIN pg_catalog.pg_namespace AS n ON n.oid = r.relnamespace AND n.nspname = c.table_schema " +
		"WHERE r.oid = to_regclass($1) AND c.column_name = 'path'",
	mysql:
		"SELECT CHARACTER_MAXIMUM_LENGTH AS max_length FROM information_schema.columns " +
		"WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'path'",
};

async function readLayout(
	transaction: SqlSessionStorageTransaction,
	adapter: SqlSessionStorageAdapter,
	table: string,
): Promise<TableLayout> {
	const lengths: number[] = [];
	const found: boolean[] = [];
	for (const name of [table, `${table}_parts`]) {
		const rows = (await transaction.unsafe(PATH_COLUMN_QUERY[adapter], [name])) as Array<{ max_length: unknown }>;
		found.push(rows.length > 0);
		for (const { max_length } of rows) if (max_length !== null) lengths.push(Number(max_length));
	}
	if (!found[0]) throw new Error(`the database has no session table ${table} with a path column`);
	return {
		table,
		parts: found[1] ? `${table}_parts` : undefined,
		maxKeyLength: lengths.length > 0 ? Math.min(...lengths) : undefined,
	};
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Each distinct key of `table` and its row count, grouped by exact bytes whatever the collation. */
async function readKeys(
	transaction: SqlSessionStorageTransaction,
	adapter: SqlSessionStorageAdapter,
	table: string | undefined,
): Promise<Map<string, number>> {
	const keys = new Map<string, number>();
	if (table === undefined) return keys;
	// MySQL groups `path` by its PAD SPACE collation; its bytes group exactly.
	const query =
		adapter === "mysql"
			? `SELECT CAST(path AS BINARY) AS key_bytes, count(*) AS n FROM ${table} GROUP BY key_bytes`
			: `SELECT path AS key_bytes, count(*) AS n FROM ${table} GROUP BY path`;
	const rows = (await transaction.unsafe(query)) as Array<{ key_bytes: string | Uint8Array; n: unknown }>;
	for (const row of rows) {
		const key = typeof row.key_bytes === "string" ? row.key_bytes : utf8.decode(row.key_bytes);
		keys.set(key, Number(row.n));
	}
	return keys;
}

async function readInventory(
	transaction: SqlSessionStorageTransaction,
	adapter: SqlSessionStorageAdapter,
	layout: TableLayout,
): Promise<SessionKeyInventory> {
	return {
		adapter,
		files: await readKeys(transaction, adapter, layout.table),
		parts: await readKeys(transaction, adapter, layout.parts),
		maxKeyLength: layout.maxKeyLength,
	};
}

/**
 * Keep every other writer off both tables until the transaction ends:
 * PostgreSQL locks them, MySQL locks every row and gap it scans, and a
 * SQLite transaction holds the database's write lock from `BEGIN IMMEDIATE`.
 */
async function lockTables(
	transaction: SqlSessionStorageTransaction,
	adapter: SqlSessionStorageAdapter,
	layout: TableLayout,
): Promise<void> {
	const tables = layout.parts === undefined ? [layout.table] : [layout.table, layout.parts];
	if (adapter === "postgres") await transaction.unsafe(`LOCK TABLE ${tables.join(", ")} IN EXCLUSIVE MODE`);
	else if (adapter === "mysql") {
		for (const table of tables) await transaction.unsafe(`SELECT count(*) AS n FROM ${table} FOR UPDATE`);
	}
}

/** Rewrite `table`'s keys per `pairs` (from → to), a bounded number of keys per statement, values bound. */
async function rewriteKeys(
	transaction: SqlSessionStorageTransaction,
	adapter: SqlSessionStorageAdapter,
	table: string,
	pairs: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
	for (let start = 0; start < pairs.length; start += KEYS_PER_STATEMENT) {
		const chunk = pairs.slice(start, start + KEYS_PER_STATEMENT);
		const values: string[] = [];
		const bind = (value: string): string => {
			values.push(value);
			return adapter === "postgres" ? `$${values.length}` : "?";
		};
		const cases = chunk.map(([from, to]) => `WHEN ${bind(from)} THEN ${bind(to)}`).join(" ");
		const list = chunk.map(([from]) => bind(from)).join(", ");
		await transaction.unsafe(`UPDATE ${table} SET path = CASE path ${cases} END WHERE path IN (${list})`, values);
	}
}

/** Whether two key inventories of one table hold the same keys with the same row counts. */
function sameKeys(expected: ReadonlyMap<string, number>, actual: ReadonlyMap<string, number>): boolean {
	if (expected.size !== actual.size) return false;
	for (const [key, count] of expected) if (actual.get(key) !== count) return false;
	return true;
}

/**
 * Move every key of `moves` (old key → new key) in both tables, inside the
 * caller's transaction: first to a unique temporary key, then to its new
 * key, so a key may take another moving key's old key (a chain or a swap).
 * Then re-read both tables and throw, so that the transaction rolls back,
 * unless each holds exactly the keys it held before with `moves` applied,
 * with the same row counts. `before`, when given, is those keys as read
 * earlier in this transaction. No stored key may start with
 * {@link TEMPORARY_KEY_PREFIX}, and no two keys, old or new, may become one row.
 * `redact` rewrites each key the error quotes.
 */
export async function applySessionKeyMoves(
	transaction: SqlSessionStorageTransaction,
	options: {
		adapter: SqlSessionStorageAdapter;
		table?: string;
		moves: ReadonlyMap<string, string>;
		before?: SessionKeyInventory;
		redact?: (text: string) => string;
	},
): Promise<void> {
	const { adapter, moves } = options;
	const quote = quoter(options.redact);
	const layout = await readLayout(transaction, adapter, sessionTableName(options.table));
	const before = options.before ?? (await readInventory(transaction, adapter, layout));
	const tables = layout.parts === undefined ? [layout.table] : [layout.table, layout.parts];
	const toTemporary = [...moves.keys()].map((key, index) => [key, temporaryKey(index)] as const);
	const toFinal = [...moves.values()].map((next, index) => [temporaryKey(index), next] as const);
	for (const table of tables) await rewriteKeys(transaction, adapter, table, toTemporary);
	for (const table of tables) await rewriteKeys(transaction, adapter, table, toFinal);

	const after = await readInventory(transaction, adapter, layout);
	for (const [table, previous, current] of [
		[layout.table, before.files, after.files],
		[`${layout.table}_parts`, before.parts, after.parts],
	] as const) {
		const expected = new Map<string, number>();
		for (const [key, count] of previous) expected.set(moves.get(key) ?? key, count);
		if (sameKeys(expected, current)) continue;
		const missing = [...expected.keys()].filter(key => current.get(key) !== expected.get(key));
		const extra = [...current.keys()].filter(key => expected.get(key) !== current.get(key));
		throw new Error(
			`after the move ${table} does not hold the planned keys (missing or miscounted: ` +
				`[${missing.slice(0, 5).map(quote).join(",")}]; unexpected: [${extra.slice(0, 5).map(quote).join(",")}])`,
		);
	}
}

async function changeKeys(
	options: SessionKeyChangeOptions,
	plan: (inventory: SessionKeyInventory) => SessionKeyPlan,
): Promise<SessionKeyChangeResult> {
	const { client, dryRun, redact } = options;
	const adapter = options.adapter ?? detectAdapter(client);
	const table = sessionTableName(options.table);
	if (adapter === "sqlite") await ensureSqliteBusyTimeout(client);
	const outcome: { result?: SessionKeyChangeResult } = {};
	await runSqlTransaction(client, adapter, async transaction => {
		const layout = await readLayout(transaction, adapter, table);
		if (!dryRun) await lockTables(transaction, adapter, layout);
		const before = await readInventory(transaction, adapter, layout);
		const planned = plan(before);
		outcome.result = { plan: planned, applied: false };
		if (dryRun || planned.refusals.length > 0 || planned.moves.size === 0) return;
		await applySessionKeyMoves(transaction, { adapter, table, before, moves: planned.moves, redact });
		outcome.result = { plan: planned, applied: true };
	});
	if (!outcome.result) throw new Error("the key change transaction ended without a plan");
	return outcome.result;
}

/**
 * Migrate the legacy keys of `<table>` and `<table>_parts` in one transaction
 * ({@link planSessionKeyMigration}). A refused plan changes nothing; so does
 * a dry run. Stop every Oh My Pi process that writes the tables first.
 */
export function migrateSessionRowKeys(options: SessionKeyMigrationOptions): Promise<SessionKeyChangeResult> {
	return changeKeys(options, inventory => planSessionKeyMigration(inventory, options.roots, options.redact));
}

/**
 * Turn the keys of `<table>` and `<table>_parts` back into the local paths an
 * older Oh My Pi reads, in one transaction ({@link planSessionKeyRollback}).
 * A refused plan changes nothing; so does a dry run.
 */
export function rollbackSessionRowKeys(options: SessionKeyRollbackOptions): Promise<SessionKeyChangeResult> {
	return changeKeys(options, inventory => planSessionKeyRollback(inventory, options.restoreRoot, options.redact));
}
