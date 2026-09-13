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
 * string. There is no fallback to file storage: a misconfigured `sql` refuses
 * to start rather than quietly writing sessions somewhere else.
 */

import { toError } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import type { Settings } from "../config/settings";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { SqlSessionStorage } from "./sql-session-storage";
import { cfgSessionSqlDsnFile, cfgSessionStorage } from "./storage-settings";

export const SESSION_STORAGE_ENV = "OMP_SESSION_STORAGE";
export const SESSION_SQL_DSN_FILE_ENV = "OMP_SESSION_SQL_DSN_FILE";
const SESSION_STORAGE_SETTING = cfgSessionStorage.id;
const SESSION_SQL_DSN_FILE_SETTING = cfgSessionSqlDsnFile.id;

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

	const client = new SQL(dsn);
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
