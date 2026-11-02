import { parseSessionSqlDsn } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SQL } from "bun";

/**
 * A `Bun.SQL` client for the test database `url`, opened as the session
 * store opens one ({@link parseSessionSqlDsn}): `pool_mode` is removed from
 * the URL, and `pool_mode=transaction` sends unnamed statements. So a test
 * URL can name a transaction pooler, `…/omp_sessions?pool_mode=transaction`,
 * and every statement runs as it would in production. The pool size stays
 * Bun's default or what `options` sets, because tests hold more connections
 * at once than the store does.
 */
export function sessionSqlTestClient(url: string, options: { max?: number } = {}): SQL {
	const { url: stripped, prepare } = parseSessionSqlDsn(url);
	return new SQL(stripped, { ...options, ...(prepare ? {} : { prepare: false }) });
}
