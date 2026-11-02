/**
 * Resolve which {@link SessionStorage} this process persists sessions through.
 *
 * Precedence (highest first), mirroring `auth-broker-config.ts`:
 *   1. `OMP_SESSION_STORAGE` / `OMP_SESSION_SQL_DSN_FILE` env vars.
 *   2. `session.storage` / `session.sql.dsnFile` in config.yml (hidden from the
 *      settings UI).
 *
 * `file` — the default — is the JSONL tree under the sessions directory and
 * resolves without touching anything. `sql` reads the connection string from
 * the named file (trimmed; the file, not the environment, carries the
 * credential), opens it with `Bun.SQL` — the dialect follows the URL scheme —
 * and awaits {@link SqlSessionStorage.create}, whose `CREATE TABLE` round trip
 * is where an unreachable database fails. Every refusal names the variable or
 * setting that supplied the value and the path it named, never the connection
 * string: an unreadable or empty file, contents the driver cannot parse as a
 * connection URL (the driver's own error embeds the string, so it is not
 * attached as a cause either), and a database that cannot be opened each
 * refuse in those terms. There is no fallback to file storage: a misconfigured
 * `sql` refuses to start rather than quietly writing sessions somewhere else.
 */

import { toError } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { Settings } from "../config/settings";
import { FileSessionStorage, type SessionStorage, setDefaultSessionStorage } from "./session-storage";
import { SqlSessionStorage } from "./sql-session-storage";
import { cfgSessionSqlDsnFile, cfgSessionStorage } from "./storage-settings";

const SESSION_STORAGE_ENV = "OMP_SESSION_STORAGE";
const SESSION_SQL_DSN_FILE_ENV = "OMP_SESSION_SQL_DSN_FILE";
const SESSION_STORAGE_SETTING = cfgSessionStorage.id;
const SESSION_SQL_DSN_FILE_SETTING = cfgSessionSqlDsnFile.id;

// Bun opens every connection in a pool on its first query. Two connections let
// a separate-path append proceed while a rename holds its transaction, without
// spending Bun's default ten database backends for every omp process. Return
// them between turns; a lifetime cap would only churn actively used connections.
const SESSION_SQL_POOL_MAX = 2;
const SESSION_SQL_POOL_IDLE_TIMEOUT_SECONDS = 5;

/** A session-storage configuration the process refuses to start with. */
export class SessionStorageConfigError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionStorageConfigError";
	}
}

/**
 * A DSN parameter this store reads has a value it does not accept. It names
 * the parameter and that value, redacted as written before it is quoted, and
 * never the DSN.
 */
class SessionSqlDsnError extends Error {}

/**
 * DSN query parameter that names the pool mode of a connection pooler in
 * front of the database (pgbouncer's `pool_mode`; Cloud SQL Managed
 * Connection Pooling has the same modes). With `transaction`, the client
 * sends unnamed statements: a transaction pooler runs each transaction on
 * any server connection, re-preparing named statements as it goes, and its
 * `max_prepared_statements` budget is shared by every client. `session`
 * keeps named statements. The parameter is removed before the URL reaches
 * the driver, which would otherwise send it to the server as a setting.
 */
export const SESSION_SQL_POOL_MODE_PARAM = "pool_mode";

/**
 * `dsn` as the driver receives it, and whether the client may use named
 * prepared statements: {@link SESSION_SQL_POOL_MODE_PARAM} removed, and
 * `prepare` false when it is `transaction`. Throws {@link SessionSqlDsnError}
 * for any other pool mode than `transaction` or `session`.
 */
export function parseSessionSqlDsn(dsn: string): { url: string; prepare: boolean } {
	const query = dsn.indexOf("?");
	if (query < 0) return { url: dsn, prepare: true };
	let poolMode: string | undefined;
	const kept: string[] = [];
	for (const pair of dsn.slice(query + 1).split("&")) {
		const [name = "", value = ""] = pair.split("=", 2);
		if (name === SESSION_SQL_POOL_MODE_PARAM) poolMode = decodeURIComponent(value);
		else kept.push(pair);
	}
	const url = kept.length > 0 ? `${dsn.slice(0, query)}?${kept.join("&")}` : dsn.slice(0, query);
	const mode = poolMode?.toLowerCase();
	if (poolMode !== undefined && mode !== "transaction" && mode !== "session") {
		// The value can be any text of the file, a password too. Quoting it first
		// would escape a quote or a backslash in it past the redactor.
		const shown = connectionStringRedactor(dsn, url)(poolMode);
		throw new SessionSqlDsnError(
			`a ${SESSION_SQL_POOL_MODE_PARAM} of ${JSON.stringify(shown)}; expected "transaction" or "session"`,
		);
	}
	return { url, prepare: mode !== "transaction" };
}

/**
 * The session store's `Bun.SQL` client for `dsn`: at most
 * {@link SESSION_SQL_POOL_MAX} connections, idle ones closed after
 * {@link SESSION_SQL_POOL_IDLE_TIMEOUT_SECONDS}, and unnamed statements when
 * {@link SESSION_SQL_POOL_MODE_PARAM} is `transaction` (see
 * {@link parseSessionSqlDsn}). Throws {@link SessionSqlDsnError} for another
 * pool mode, and the driver's error when it cannot parse the URL.
 */
export function createSessionSqlClient(dsn: string): SQL {
	const { url, prepare } = parseSessionSqlDsn(dsn);
	return new SQL(url, {
		max: SESSION_SQL_POOL_MAX,
		idleTimeout: SESSION_SQL_POOL_IDLE_TIMEOUT_SECONDS,
		...(prepare ? {} : { prepare: false }),
	});
}

export interface ResolveSessionStorageInput {
	settings: Settings;
	env: NodeJS.ProcessEnv;
}

/** Resolve the configured storage; see the module doc for precedence and refusals. */
export async function resolveSessionStorage({ settings, env }: ResolveSessionStorageInput): Promise<SessionStorage> {
	const envKind = env[SESSION_STORAGE_ENV]?.trim();
	// The configured value unvalidated: the handle would read a typo as the `file` default,
	// and a misconfigured storage must refuse rather than quietly write sessions to files.
	// The environment comes from `env`, not the handle, for the same reason.
	const kind: unknown = envKind || (settings.rawValue(cfgSessionStorage) ?? cfgSessionStorage.default);
	if (kind === "file") return new FileSessionStorage();
	if (kind !== "sql") {
		const source = envKind ? SESSION_STORAGE_ENV : SESSION_STORAGE_SETTING;
		throw new SessionStorageConfigError(`${source} is ${JSON.stringify(kind)}; expected "file" or "sql"`);
	}

	return openSessionSqlStorage(await openSessionSqlClient({ settings, env }));
}

/**
 * The store `session.storage: sql` opens on `connection`. Every database
 * error it raises, and every diagnostic it builds from a row key, has the
 * connection string's secrets redacted ({@link SessionSqlConnection.redact}),
 * because notices, logs and the fatal handler print them. A failure to start
 * closes the client and refuses as {@link sessionDatabaseError}. `table`
 * overrides the default table, for a test that shares its database with
 * other clients.
 */
export async function openSessionSqlStorage(
	connection: SessionSqlConnection,
	options: { table?: string } = {},
): Promise<SqlSessionStorage> {
	try {
		return await SqlSessionStorage.create({
			client: connection.client,
			table: options.table,
			redact: connection.redact,
		});
	} catch (err) {
		void connection.client.end().catch(() => undefined);
		throw sessionDatabaseError(connection, err);
	}
}

/** A client of the session database, and where its connection string came from. */
export interface SessionSqlConnection {
	client: SQL;
	/** The variable or setting that named the connection-string file. */
	source: string;
	/** The connection-string file. */
	dsnFile: string;
	/**
	 * `text` with the connection string's secrets replaced by `<redacted>`
	 * (see {@link connectionStringRedactor}). Every message built from an
	 * error of `client` or from its rows goes through it, because a database
	 * error or a row can quote any text, the connection string included.
	 */
	redact: (text: string) => string;
}

const REDACTED = "<redacted>";
/**
 * A password at least this long is replaced wherever it occurs. A shorter one
 * would also match inside ordinary words (`pw` in `pwd`), so it is replaced
 * where it stands as a token (see {@link WORD_CHARACTER}).
 */
const MIN_SUBSTRING_PASSWORD_LENGTH = 4;
/**
 * The characters that may not touch a short password for it to count as a
 * token: a Unicode letter, mark or digit, or `_`. Any other character ends a
 * token: space, a quote, `=`, `:`, `/`, `@`, `,`, `-`, and `.`, so that a
 * password ending a sentence (`password is x.y.`) is still replaced. Error
 * text quotes a password between such characters; one directly beside a
 * letter or digit is part of a longer word, which reveals nothing of it.
 */
const WORD_CHARACTER = "[\\p{L}\\p{M}\\p{N}_]";

/** `text` as written and, when that differs and is valid, percent-decoded (`+` read as a space when `plus`). */
function spellings(text: string, plus = false): string[] {
	try {
		const decoded = decodeURIComponent(plus ? text.replaceAll("+", " ") : text);
		return decoded === text ? [text] : [text, decoded];
	} catch {
		return [text];
	}
}

/** `text` as a regular-expression pattern (`u` flag) that matches it literally. */
function literalPattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Replace, in one pass over a message, every spelling of the secrets in each
 * connection string of `dsns` (the one in the file, and the one the driver
 * connects with once {@link SESSION_SQL_POOL_MODE_PARAM} is removed): the
 * string itself, and when it parses as a URL, its normalized form, its
 * password and any `…pass…` query parameter, each as written and
 * percent-decoded, and `user:password` in each spelling. A password shorter
 * than {@link MIN_SUBSTRING_PASSWORD_LENGTH} is replaced where it stands as a
 * token, every other secret wherever it occurs. The longest secret wins, so
 * one inside another goes whole, and a `<redacted>` already in the text is
 * kept as it is, so redacting twice changes nothing.
 *
 * Threat model: it removes the connection string and its parts as drivers
 * and servers render them in their errors, and as omp itself quotes values,
 * which omp redacts before quoting. A value that someone with write access
 * stores in the database (a key, content, a trigger message) is data: a
 * driver may re-encode it, for example MySQL's `\xHH` bytes, and omp does not
 * redact that spelling; such a writer already knows what they stored.
 */
function connectionStringRedactor(...dsns: string[]): (text: string) => string {
	/** Each secret, and whether it is replaced only as a token. */
	const secrets = new Map<string, boolean>();
	for (const dsn of dsns) addConnectionStringSecrets(secrets, dsn);
	const alternatives = [...secrets]
		.filter(([secret]) => secret.length > 0)
		.sort(([a], [b]) => b.length - a.length)
		.map(([secret, token]) =>
			token ? `(?<!${WORD_CHARACTER})${literalPattern(secret)}(?!${WORD_CHARACTER})` : literalPattern(secret),
		);
	const pattern = new RegExp([literalPattern(REDACTED), ...alternatives].join("|"), "gu");
	return text => text.replace(pattern, REDACTED);
}

/** Add every spelling of the secrets in `dsn` to `secrets` (see {@link connectionStringRedactor}). */
function addConnectionStringSecrets(secrets: Map<string, boolean>, dsn: string): void {
	secrets.set(dsn, false);
	let url: URL | undefined;
	try {
		url = new URL(dsn);
	} catch {
		url = undefined;
	}
	if (url) {
		secrets.set(url.href, false);
		const passwords = url.password ? spellings(url.password) : [];
		for (const parameter of url.search.slice(1).split("&")) {
			const separator = parameter.indexOf("=");
			if (separator < 0) continue;
			const name = spellings(parameter.slice(0, separator), true).at(-1) ?? "";
			if (/pass/i.test(name)) passwords.push(...spellings(parameter.slice(separator + 1), true));
		}
		for (const password of passwords) {
			if (!secrets.has(password)) secrets.set(password, [...password].length < MIN_SUBSTRING_PASSWORD_LENGTH);
			for (const user of spellings(url.username)) secrets.set(`${user}:${password}`, false);
		}
	}
}

/**
 * Open a client of the session database from the connection-string file
 * `OMP_SESSION_SQL_DSN_FILE` or `session.sql.dsnFile` names, with the pool
 * policy of an omp-created client. `Bun.SQL` connects on the first statement,
 * so that is where an unreachable database fails; report it with
 * {@link sessionDatabaseError}. Throws {@link SessionStorageConfigError} when
 * no file is named, or the file is unreadable, empty, or not a connection URL,
 * never quoting the connection string.
 */
export async function openSessionSqlClient({
	settings,
	env,
}: ResolveSessionStorageInput): Promise<SessionSqlConnection> {
	const envPath = env[SESSION_SQL_DSN_FILE_ENV]?.trim();
	const dsnFile = envPath || cfgSessionSqlDsnFile.layered(settings)?.trim();
	if (!dsnFile) {
		throw new SessionStorageConfigError(
			`no connection-string file for the session database is named: set ${SESSION_SQL_DSN_FILE_ENV} or ${SESSION_SQL_DSN_FILE_SETTING}`,
		);
	}
	const source = envPath ? SESSION_SQL_DSN_FILE_ENV : SESSION_SQL_DSN_FILE_SETTING;

	let dsn: string;
	try {
		dsn = (await Bun.file(dsnFile).text()).trim();
	} catch (err) {
		throw new SessionStorageConfigError(
			`${source} names ${dsnFile}, which could not be read: ${toError(err).message}`,
			{
				cause: err,
			},
		);
	}
	if (!dsn) throw new SessionStorageConfigError(`${source} names ${dsnFile}, which is empty`);

	let client: SQL;
	try {
		client = createSessionSqlClient(dsn);
	} catch (err) {
		// The driver's own parse error embeds the connection string; this store's names only the parameter.
		const detail =
			err instanceof SessionSqlDsnError ? err.message : "not a connection URL the database driver accepts";
		throw new SessionStorageConfigError(`${source} names ${dsnFile}, but its contents are ${detail}`);
	}
	return { client, source, dsnFile, redact: connectionStringRedactor(dsn, parseSessionSqlDsn(dsn).url) };
}

/**
 * The description of `err`, a failure of `connection`'s client, to print:
 * its message, the errors an `AggregateError` gathers, and its code, with the
 * connection string's secrets redacted ({@link SessionSqlConnection.redact}).
 */
export function sessionDatabaseErrorDetail(connection: SessionSqlConnection, err: unknown): string {
	const error = toError(err);
	let detail = error.message;
	if (error instanceof AggregateError) {
		detail += `: ${error.errors.map(inner => toError(inner).message).join("; ")}`;
	}
	const code = "code" in error ? error.code : undefined;
	if (typeof code === "string" && code.length > 0) detail += ` (${code})`;
	return connection.redact(detail);
}

/**
 * `err`, a failure to open the database `connection` names, as the refusal
 * the start-up prints: the file and its source with the driver's error,
 * never the connection string. The driver's error is not attached as the
 * cause: the fatal handler prints causes, and its text is not redacted.
 */
export function sessionDatabaseError(connection: SessionSqlConnection, err: unknown): SessionStorageConfigError {
	return new SessionStorageConfigError(
		`${connection.source} names ${connection.dsnFile}, but the session database could not be opened: ` +
			sessionDatabaseErrorDetail(connection, err),
	);
}

/**
 * Resolve the configured storage and install it as the process default. A
 * command outside the root command (`omp anonymize`, `omp render`, `omp
 * share`, …) never reaches the start-up install, so it calls this before it
 * resolves or lists any session. Throws {@link SessionStorageConfigError} on
 * the same refusals as {@link resolveSessionStorage}.
 */
export async function installConfiguredSessionStorage(cwd: string = process.cwd()): Promise<SessionStorage> {
	const storage = await resolveSessionStorage({
		settings: await Settings.loadReadOnly({ cwd }),
		env: process.env,
	});
	setDefaultSessionStorage(storage);
	return storage;
}

/** A feature that works only on session files on disk, asked for while sessions are database rows. */
export class SessionStorageUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionStorageUnsupportedError";
	}
}

/**
 * Refuse `feature` unless `storage` keeps sessions as files on disk. Under
 * `session.storage: sql` a session is a row; a feature built on the files
 * would otherwise see none of them and report or act on a wrong picture.
 */
export function assertSessionsOnDisk(storage: SessionStorage, feature: string, reason: string): void {
	if (storage instanceof FileSessionStorage) return;
	throw new SessionStorageUnsupportedError(
		`${feature} is unavailable with ${SESSION_STORAGE_SETTING}: sql: ${reason}`,
	);
}

/** Why lease probes (`omp session lease`, RPC `get_session_lease`) refuse under `session.storage: sql`. */
export const NO_SESSION_LEASE_REASON =
	"SQL-stored sessions take no ownership lease, so every session would read as free";

/** Why `/join` refuses under `session.storage: sql`: guest replicas are local transcript files. */
export const COLLAB_REPLICA_DISK_ONLY_REASON =
	"collab replicas are local session files, and this store keeps sessions as database rows";

/** Why `gc.autoCompress` refuses under `session.storage: sql`: it compresses session files on disk. */
export const GC_AUTO_COMPRESS_DISK_ONLY_REASON =
	"compression rewrites session files on disk in place, and this store keeps sessions as database rows";

/**
 * Why the usage statistics features (`omp stats`, `/stats`, `/trace`, the
 * `/usage` activity heatmap) refuse under `session.storage: sql`: the stats store
 * ingests session files from disk.
 */
export const STATS_DISK_ONLY_REASON =
	"usage statistics are ingested from session files on disk, and this store keeps sessions as database rows the stats ingester never reads";
