/**
 * Hand a session to another machine, check who owns it, or rewrite the SQL
 * session database's row keys.
 *
 * `omp session pack <session> <out.tar>` writes a self-contained archive,
 * `omp session unpack <archive.tar> --cwd <dir>` lands it in `<dir>`'s session
 * directory (printing the session file path as the only stdout line),
 * `omp session moved <session> --to <label>` marks the copy left behind stale
 * so resuming it forks instead of continuing it,
 * `omp session lease --json -- <id>...` reports which sessions a running omp owns
 * without taking their ownership leases, and
 * `omp session migrate-keys --root <dir>...` / `omp session rollback-keys --root <dir>`
 * move the configured SQL database's row keys to and from the layout an older
 * omp wrote (docs/session.md, "Row keys").
 */
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionHelp as commandHelp } from "../cli/command-help";
import { installSessionStorageForCommand, resolveSessionFileArg } from "../cli/session-arg";
import { runSessionKeysCommand } from "../cli/session-keys-cli";
import { SessionMoveRefusedError } from "../session/session-manager";
import { defaultSessionStorage, probeSessionLeases } from "../session/session-storage";
import {
	assertSessionsOnDisk,
	NO_SESSION_LEASE_REASON,
	SessionStorageUnsupportedError,
} from "../session/session-storage-config";
import {
	markSessionMoved,
	packSession,
	SessionTransferError,
	unpackSession,
	type UnpackMode,
} from "../session/session-transfer";

/** Actions that rewrite the SQL session database's row keys; they never open the configured storage. */
const KEY_ACTIONS = ["migrate-keys", "rollback-keys"] as const;
type KeyAction = (typeof KEY_ACTIONS)[number];
const ACTIONS = ["pack", "unpack", "moved", "lease", ...KEY_ACTIONS] as const;
type SessionAction = (typeof ACTIONS)[number];
type FileAction = Exclude<SessionAction, KeyAction>;

const USAGE: Record<SessionAction, string> = {
	pack: "omp session pack <session> <out.tar>",
	unpack: "omp session unpack <archive.tar> --cwd <dir>",
	moved: "omp session moved <session> --to <label>",
	lease: "omp session lease [--json] -- <session-id>...",
	"migrate-keys": "omp session migrate-keys --root <dir> [--root <dir>...] [--dry-run]",
	"rollback-keys": "omp session rollback-keys --root <dir> [--dry-run]",
};

const UNPACK_NOTE: Record<UnpackMode, string> = {
	created: "Unpacked session",
	replaced: "Replaced the local copy of this session",
	forked: "The local copy of this session diverged; unpacked as a fork",
};

/**
 * Why each action needs session files on disk. Under `session.storage: sql`
 * a session is a database row: there is no file to pack, place, or mark, and
 * no ownership lease to probe, so each refuses rather than act on files that
 * are not the session.
 */
const DISK_ONLY_REASONS: Record<FileAction, string> = {
	pack: "it archives a session file and its artifact directory from disk, and this store keeps the transcripts as database rows",
	unpack: "it places a session file and its artifact directory on disk, where this store would never read them",
	moved: "it marks the session file on disk as moved away, and this store keeps the session as a database row",
	lease: NO_SESSION_LEASE_REASON,
};

function isSessionAction(value: string): value is SessionAction {
	return ACTIONS.some(action => action === value);
}

function isKeyAction(action: SessionAction): action is KeyAction {
	return KEY_ACTIONS.some(keyAction => keyAction === action);
}

/**
 * Probe each id's ownership lease without taking it. JSON consumers (omp-web)
 * get `{held, unknown}`; ids in neither list are free, including ids that name
 * no session.
 */
function printSessionLeases(sessionIds: string[], json: boolean): void {
	const report = probeSessionLeases(sessionIds);
	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	for (const id of report.held) process.stdout.write(`held\t${id}\n`);
	for (const id of report.unknown) process.stdout.write(`unknown\t${id}\n`);
}

export default class Session extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "pack, unpack, moved, lease, migrate-keys, or rollback-keys",
			required: true,
			options: ACTIONS,
		}),
		source: Args.string({
			description: "Session .jsonl path or id (pack, moved); archive path (unpack); session ids (lease)",
			required: false,
		}),
		output: Args.string({
			description: "Archive file to write (pack)",
			required: false,
		}),
	};

	static flags = {
		cwd: Flags.string({ description: "Directory the session continues in on this machine (unpack)" }),
		to: Flags.string({ description: "Where the session went, e.g. a machine name (moved)" }),
		json: Flags.boolean({ description: "Print {held, unknown} session id lists as JSON (lease)" }),
		root: Flags.string({
			description:
				"A sessions root the legacy keys were written under (migrate-keys, repeatable); the one root sessions/ keys restore beneath (rollback-keys)",
			multiple: true,
		}),
		"dry-run": Flags.boolean({ description: "Print the plan and change nothing (migrate-keys, rollback-keys)" }),
	};

	static examples = [
		"# Pack a session with its artifacts and image blobs\n  omp session pack ~/.omp/agent/sessions/<project>/<file>.jsonl /tmp/session.tar",
		"# Unpack it on another machine; prints the session file path\n  omp session unpack /tmp/session.tar --cwd ~/src/project",
		"# Mark the local copy stale; resuming it later forks it\n  omp session moved <file>.jsonl --to cloud",
		"# List which of these sessions a running omp owns, without taking ownership (`--` keeps ids starting with `-` from parsing as options)\n  omp session lease --json -- <id> <id>",
		"# Preview, then run, the one-time key migration of the configured SQL session database\n  omp session migrate-keys --root /home/me/.omp/agent/sessions --dry-run\n  omp session migrate-keys --root /home/me/.omp/agent/sessions",
		"# Turn the keys back into the local paths an older omp reads\n  omp session rollback-keys --root /home/me/.omp/agent/sessions",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Session);
		const action = args.action ?? "";
		if (!isSessionAction(action)) throw new CliUsageError(`Unknown action: ${action}`);
		const usage = USAGE[action];
		if (isKeyAction(action)) {
			if (flags.cwd !== undefined || flags.to !== undefined || flags.json) {
				throw new CliUsageError(`--cwd, --to and --json do not apply to ${action}. Usage: ${usage}`);
			}
			if (argv.length > 1) throw new CliUsageError(`Unexpected argument "${argv[1]}". Usage: ${usage}`);
			const roots = flags.root ?? [];
			if (roots.length === 0) throw new CliUsageError(`Missing --root <dir>. Usage: ${usage}`);
			if (action === "rollback-keys" && roots.length > 1) {
				throw new CliUsageError(`rollback-keys restores every sessions/ key beneath one --root. Usage: ${usage}`);
			}
			const exitCode = await runSessionKeysCommand({
				direction: action === "migrate-keys" ? "migrate" : "rollback",
				roots,
				dryRun: flags["dry-run"] === true,
				cwd: process.cwd(),
				env: process.env,
			});
			if (exitCode !== 0) process.exitCode = exitCode;
			return;
		}
		if (flags.root !== undefined || flags["dry-run"]) {
			throw new CliUsageError(`--root and --dry-run only apply to migrate-keys and rollback-keys. Usage: ${usage}`);
		}
		if (!(await installSessionStorageForCommand())) return;
		try {
			assertSessionsOnDisk(defaultSessionStorage(), `omp session ${action}`, DISK_ONLY_REASONS[action]);
		} catch (error) {
			if (!(error instanceof SessionStorageUnsupportedError)) throw error;
			process.stderr.write(`${chalk.red(`error: ${error.message}`)}\n`);
			process.exitCode = 1;
			return;
		}
		if (action === "lease") {
			if (flags.cwd !== undefined || flags.to !== undefined) {
				throw new CliUsageError(`--cwd and --to do not apply to lease. Usage: ${usage}`);
			}
			const sessionIds = argv.slice(1);
			if (sessionIds.length === 0) throw new CliUsageError(`Missing session id. Usage: ${usage}`);
			printSessionLeases(sessionIds, flags.json === true);
			return;
		}
		if (flags.json) throw new CliUsageError(`--json only applies to lease. Usage: ${usage}`);
		if (argv.length > (action === "pack" ? 3 : 2)) {
			throw new CliUsageError(`Unexpected argument "${argv.at(-1)}". Usage: ${usage}`);
		}
		const source = args.source;
		if (!source) throw new CliUsageError(`Missing ${action === "unpack" ? "archive" : "session"}. Usage: ${usage}`);
		if (action !== "unpack" && flags.cwd !== undefined) {
			throw new CliUsageError(`--cwd only applies to unpack. Usage: ${usage}`);
		}
		if (action !== "moved" && flags.to !== undefined) {
			throw new CliUsageError(`--to only applies to moved. Usage: ${usage}`);
		}

		try {
			switch (action) {
				case "pack": {
					if (!args.output) throw new CliUsageError(`Missing output archive path. Usage: ${usage}`);
					const result = await packSession(await this.#resolveSession(source), args.output);
					if (result.missingBlobs.length > 0) {
						process.stderr.write(
							`${chalk.yellow(`warning: ${result.missingBlobs.length} referenced blob(s) are missing from the local blob store and were not packed; those images will not load after unpacking.`)}\n`,
						);
					}
					process.stdout.write(`${result.archivePath}\n`);
					return;
				}
				case "unpack": {
					if (!flags.cwd) throw new CliUsageError(`Missing --cwd <dir>. Usage: ${usage}`);
					const result = await unpackSession(source, { cwd: flags.cwd });
					process.stderr.write(`${chalk.dim(`${UNPACK_NOTE[result.mode]} (${result.id}).`)}\n`);
					process.stdout.write(`${result.sessionFile}\n`);
					return;
				}
				case "moved": {
					if (flags.to === undefined) throw new CliUsageError(`Missing --to <label>. Usage: ${usage}`);
					await markSessionMoved(await this.#resolveSession(source), flags.to);
					return;
				}
			}
		} catch (error) {
			if (error instanceof SessionTransferError || error instanceof SessionMoveRefusedError) {
				process.stderr.write(`${chalk.red(`error: ${error.message}`)}\n`);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
	}

	/** A session path or id resolved to a file, with lookup failures reported as transfer errors. */
	async #resolveSession(source: string): Promise<string> {
		try {
			return await resolveSessionFileArg(source, process.cwd());
		} catch (error) {
			throw new SessionTransferError(error instanceof Error ? error.message : String(error));
		}
	}
}
