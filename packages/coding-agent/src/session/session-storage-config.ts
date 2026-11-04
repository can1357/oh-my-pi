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
 * refuse in those terms.
 *
 * There is one fallback, and it is narrow: a launch that resumes a session
 * whose transcript is already a file on disk continues on the file store when
 * the database cannot be used, loudly and with a ledger line, because such a
 * resume tears nothing — the whole conversation is in that file either way.
 * Every other `sql` launch refuses to start, and once this run has written to
 * the database no fallback is possible at all. `session-storage-fallback.ts`
 * states the rule and owns the ledger.
 */

import { isEnoent, toError } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { Settings } from "../config/settings";
import { FileSessionStorage, type SessionStorage, setDefaultSessionStorage } from "./session-storage";
import {
	fallbackEvent,
	fallbackLedgerPath,
	recordSessionStorageFallback,
	type SessionStorageFallbackReason,
	sqlStoreHasWritten,
} from "./session-storage-fallback";
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
	/**
	 * Asked only when `sql` is selected and its store cannot be used: the id of
	 * the session this launch resumes, when that session's transcript is already
	 * a file on disk, else `null`. Such a resume may go on reading and writing
	 * that file and loses nothing, so it falls back; every other launch refuses.
	 * Omitted, nothing falls back.
	 */
	resumableFileSession?: () => Promise<string | null>;
}

export async function resolveSessionStorage({
	settings,
	env,
	resumableFileSession,
}: ResolveSessionStorageInput): Promise<SessionStorage> {
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

	/**
	 * The sql store cannot be used. Fall back to the file store when — and only
	 * when — this launch resumes a session whose transcript is already a file
	 * and this run has written nothing to the database; otherwise refuse with
	 * `message`. See `session-storage-fallback.ts` for why that is the only
	 * safe moment.
	 */
	const fallbackOrRefuse = async (
		reason: SessionStorageFallbackReason,
		dsnPath: string,
		message: string,
		cause?: unknown,
	): Promise<SessionStorage> => {
		const refuse = (): never => {
			throw new SessionStorageConfigError(message, cause === undefined ? undefined : { cause });
		};
		if (resumableFileSession === undefined || sqlStoreHasWritten()) return refuse();
		const sessionId = await resumableFileSession();
		// Re-read the latch: the probe above awaits, and a write this run
		// committed meanwhile makes the file store the wrong answer.
		if (sessionId === null || sqlStoreHasWritten()) return refuse();
		try {
			await recordSessionStorageFallback(
				fallbackEvent(sessionId, reason, dsnPath),
				fallbackLedgerPath(settings, env),
			);
		} catch (ledgerError) {
			// The count is the control, so a fallback that cannot be recorded is
			// not taken: refuse, naming both why sql failed and why the record did.
			throw new SessionStorageConfigError(`${message} (${toError(ledgerError).message})`, {
				cause: ledgerError,
			});
		}
		// Read the latch once more: recording the fallback awaits disk, and a
		// write committed in that window makes the file store the wrong answer
		// just as much as one committed during the probe. The ledger then holds
		// a line for a fallback that did not happen, which the refusal says.
		if (sqlStoreHasWritten()) {
			throw new SessionStorageConfigError(
				`${message} (a write reached the session database while this launch was deciding to ` +
					`continue on file storage, so it halts instead; its fallback ledger line stands for a ` +
					`fallback that did not happen)`,
			);
		}
		return new FileSessionStorage();
	};

	const envPath = env[SESSION_SQL_DSN_FILE_ENV]?.trim();
	const dsnFile = envPath || cfgSessionSqlDsnFile.layered(settings)?.trim();
	if (!dsnFile) {
		return await fallbackOrRefuse(
			"dsn-missing",
			"",
			`session storage is sql but no connection-string file is named: set ${SESSION_SQL_DSN_FILE_ENV} or ${SESSION_SQL_DSN_FILE_SETTING}`,
		);
	}
	const source = envPath ? SESSION_SQL_DSN_FILE_ENV : SESSION_SQL_DSN_FILE_SETTING;

	let dsn: string;
	try {
		dsn = (await Bun.file(dsnFile).text()).trim();
	} catch (err) {
		return await fallbackOrRefuse(
			isEnoent(err) ? "dsn-missing" : "dsn-unreadable",
			dsnFile,
			`${source} names ${dsnFile}, which could not be read: ${toError(err).message}`,
			err,
		);
	}
	if (!dsn) {
		return await fallbackOrRefuse("dsn-unreadable", dsnFile, `${source} names ${dsnFile}, which is empty`);
	}

	let client: SQL;
	try {
		client = new SQL(dsn, { max: SESSION_SQL_POOL_MAX, idleTimeout: SESSION_SQL_POOL_IDLE_TIMEOUT_SECONDS });
	} catch {
		return await fallbackOrRefuse(
			"dsn-unreadable",
			dsnFile,
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
		return await fallbackOrRefuse(
			"db-unreachable",
			dsnFile,
			`${source} names ${dsnFile}, but the session database could not be opened: ${detail}`,
			error,
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
