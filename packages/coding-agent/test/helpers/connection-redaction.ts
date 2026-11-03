/**
 * Passwords whose quoted spelling differs from the raw one, and the checks
 * that a diagnostic shows none of their spellings: omp redacts a value
 * before it quotes it, so quoting cannot escape a secret past the redactor.
 */
import { expect } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	openSessionSqlClient,
	type SessionSqlConnection,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The round-6 reviewer's passwords: a quote, a backslash and a newline (each
 * escaped by JSON quoting), and short Unicode and quote passwords, which the
 * redactor replaces only as a token.
 */
export const ESCAPABLE_PASSWORDS = ['p"w!', "p\\w!", "p\nw!", "雪🔑é", 'é"x'] as const;

/**
 * A connection whose redactor is that of a connection string with
 * `password`. Its client never connects (`Bun.SQL` connects on the first
 * statement); end it when done.
 */
export async function redactorFor(password: string): Promise<SessionSqlConnection> {
	const dir = TempDir.createSync("@omp-redaction-dsn-");
	try {
		const dsnFile = dir.join("dsn");
		await Bun.write(dsnFile, `postgres://app:${encodeURIComponent(password)}@127.0.0.1:1/sessions\n`);
		return await openSessionSqlClient({ settings: Settings.isolated(), env: { OMP_SESSION_SQL_DSN_FILE: dsnFile } });
	} finally {
		dir.removeSync();
	}
}

/** `password` raw, JSON-escaped once, and JSON-escaped twice (a JSON log line of a quoted value). */
function spellings(password: string): string[] {
	const once = JSON.stringify(password).slice(1, -1);
	const twice = JSON.stringify(once).slice(1, -1);
	return [...new Set([password, once, twice])];
}

/** `printed`, which must hold no spelling of `password`, as a value whose mismatch names `label` and the spelling. */
export function expectNoSpelling(label: string, printed: string, password: string): void {
	for (const spelling of spellings(password)) {
		expect({ label, spelling, leaks: printed.includes(spelling) }).toEqual({ label, spelling, leaks: false });
	}
}
