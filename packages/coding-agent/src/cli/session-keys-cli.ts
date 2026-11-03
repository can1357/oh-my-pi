/**
 * `omp session migrate-keys` and `omp session rollback-keys`: rewrite the row
 * keys of the configured SQL session database between the layout an older
 * Oh My Pi wrote and the current one ({@link migrateSessionRowKeys},
 * {@link rollbackSessionRowKeys}). They open the database from the same
 * connection-string file as the configured storage, but never through
 * `SqlSessionStorage.create`, which refuses a table holding legacy keys.
 * Every database error they print has the connection string's secrets
 * redacted ({@link sessionDatabaseErrorDetail}).
 */
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import {
	openSessionSqlClient,
	type SessionSqlConnection,
	SessionStorageConfigError,
	sessionDatabaseError,
	sessionDatabaseErrorDetail,
} from "../session/session-storage-config";
import {
	migrateSessionRowKeys,
	rollbackSessionRowKeys,
	type SessionKeyChangeResult,
} from "../session/sql-session-key-migration";
import { sessionTableName } from "../session/sql-session-storage";

export interface SessionKeysCommandArgs {
	/** `migrate`: legacy keys to the current layout; `rollback`: back to local paths. */
	direction: "migrate" | "rollback";
	/** The sessions roots (migrate), or the one restore root (rollback). */
	roots: readonly string[];
	dryRun: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The session table. Default: the store's default, the table `session.storage: sql` opens. */
	table?: string;
}

/** The plan and outcome for a person: what each key does, every refusal, and what changed. */
function formatResult(args: SessionKeysCommandArgs, table: string, result: SessionKeyChangeResult): string {
	const { plan } = result;
	const lines: string[] = [];
	const title = args.direction === "migrate" ? "Migrate the row keys of" : "Roll back the row keys of";
	const roots = args.direction === "migrate" ? "sessions roots" : "restore root";
	lines.push(`${title} ${table} and ${table}_parts; ${roots}: ${args.roots.join(", ")}`);
	lines.push(
		`Keys: ${plan.keys.files} in ${table}, ${plan.keys.parts} in ${table}_parts, ${plan.keys.distinct} distinct`,
	);
	const { counts } = plan;
	if (args.direction === "migrate") {
		lines.push(`  ${counts.unchanged} already current, unchanged`);
		lines.push(`  ${counts.rootRelative} legacy keys under a sessions root to sessions/…`);
		lines.push(`  ${counts.absolute} legacy keys outside every sessions root to abs:…`);
		lines.push(`  ${counts.respelled} of the legacy keys resolved from a non-canonical spelling`);
	} else {
		lines.push(`  ${counts.rootRelative} sessions/… keys to paths under ${args.roots[0]}`);
		lines.push(`  ${counts.absolute} abs:… keys to their absolute paths`);
	}
	if (plan.refusals.length > 0) {
		lines.push("Refused; nothing changed:");
		for (const refusal of plan.refusals) {
			lines.push(`  ${refusal.kind}: ${refusal.reason}`);
			for (const key of refusal.keys) lines.push(`    ${JSON.stringify(key)}`);
		}
	} else if (args.dryRun) {
		lines.push(`Dry run: ${plan.moves.size} keys would move; nothing changed.`);
	} else if (result.applied) {
		lines.push(`Moved ${plan.moves.size} keys in one transaction; both tables hold exactly the planned keys.`);
	} else {
		lines.push("Nothing to move.");
	}
	return `${lines.join("\n")}\n`;
}

/** Print `message` as the command's error line. */
function printError(message: string): void {
	process.stderr.write(`${chalk.red(`error: ${message}`)}\n`);
}

/** Check the connection, run the key change, and print its plan and outcome; the exit code. */
async function changeKeys(
	connection: SessionSqlConnection,
	args: SessionKeysCommandArgs,
	table: string,
): Promise<number> {
	const { client } = connection;
	try {
		await client.unsafe("SELECT 1");
	} catch (err) {
		printError(sessionDatabaseError(connection, err).message);
		return 1;
	}
	let result: SessionKeyChangeResult;
	try {
		result =
			args.direction === "migrate"
				? await migrateSessionRowKeys({ client, table, roots: args.roots, dryRun: args.dryRun })
				: await rollbackSessionRowKeys({ client, table, restoreRoot: args.roots[0] ?? "", dryRun: args.dryRun });
	} catch (err) {
		// Every statement ran in one transaction, which a thrown error rolls back.
		printError(`the key change failed and was rolled back: ${sessionDatabaseErrorDetail(connection, err)}`);
		return 1;
	}
	process.stdout.write(formatResult(args, table, result));
	if (result.plan.refusals.length === 0) return 0;
	printError("the key change was refused; nothing changed");
	return 1;
}

/**
 * Run one key change against the configured database and print its plan
 * and outcome. Returns the exit code: 1 on a refusal, a configuration that
 * names no usable database, or a failed change (which the transaction rolled
 * back); 0 otherwise. No error of the database client leaves this function:
 * each is printed redacted, because the fatal handler would print its text
 * whole.
 */
export async function runSessionKeysCommand(args: SessionKeysCommandArgs): Promise<number> {
	const table = sessionTableName(args.table);
	let connection: SessionSqlConnection;
	try {
		connection = await openSessionSqlClient({
			settings: await Settings.loadReadOnly({ cwd: args.cwd }),
			env: args.env,
		});
	} catch (err) {
		if (!(err instanceof SessionStorageConfigError)) throw err;
		printError(err.message);
		return 1;
	}
	let exitCode = 1;
	try {
		exitCode = await changeKeys(connection, args, table);
	} catch (err) {
		printError(sessionDatabaseErrorDetail(connection, err));
	}
	try {
		await connection.client.end();
	} catch (err) {
		printError(`closing the session database failed: ${sessionDatabaseErrorDetail(connection, err)}`);
		exitCode = 1;
	}
	return exitCode;
}
