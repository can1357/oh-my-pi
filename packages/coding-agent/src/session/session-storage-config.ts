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

	const envPath = env[SESSION_SQL_DSN_FILE_ENV]?.trim();
	const dsnFile = envPath || cfgSessionSqlDsnFile.layered(settings)?.trim();
	if (!dsnFile) {
		throw new SessionStorageConfigError(
			`session storage is sql but no connection-string file is named: set ${SESSION_SQL_DSN_FILE_ENV} or ${SESSION_SQL_DSN_FILE_SETTING}`,
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
		client = new SQL(dsn, { max: SESSION_SQL_POOL_MAX, idleTimeout: SESSION_SQL_POOL_IDLE_TIMEOUT_SECONDS });
	} catch {
		throw new SessionStorageConfigError(
			`${source} names ${dsnFile}, but its contents are not a connection URL the database driver accepts`,
		);
	}
	try {
		return await SqlSessionStorage.create({ client });
	} catch (err) {
		void client.end().catch(() => undefined);
		const error = toError(err);
		const code = "code" in error ? error.code : undefined;
		const detail = typeof code === "string" && code.length > 0 ? `${error.message} (${code})` : error.message;
		throw new SessionStorageConfigError(
			`${source} names ${dsnFile}, but the session database could not be opened: ${detail}`,
			{ cause: error },
		);
	}
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
