/**
 * Hand a session to another machine, or check who owns it.
 *
 * `omp session pack <session> <out.tar>` writes a self-contained archive,
 * `omp session unpack <archive.tar> --cwd <dir>` lands it in `<dir>`'s session
 * directory (printing the session file path as the only stdout line),
 * `omp session moved <session> --to <label>` marks the copy left behind stale
 * so resuming it forks instead of continuing it, and
 * `omp session lease --json -- <id>...` reports which sessions a running omp owns
 * without taking their ownership leases.
 */
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionHelp as commandHelp } from "../cli/command-help";
import { resolveSessionFileArg } from "../cli/session-arg";
import { SessionMoveRefusedError } from "../session/session-manager";
import { probeSessionLeases } from "../session/session-storage";
import {
	markSessionMoved,
	packSession,
	SessionTransferError,
	unpackSession,
	type UnpackMode,
} from "../session/session-transfer";

const ACTIONS = ["pack", "unpack", "moved", "lease"] as const;
type SessionAction = (typeof ACTIONS)[number];

const USAGE: Record<SessionAction, string> = {
	pack: "omp session pack <session> <out.tar>",
	unpack: "omp session unpack <archive.tar> --cwd <dir>",
	moved: "omp session moved <session> --to <label>",
	lease: "omp session lease [--json] -- <session-id>...",
};

const UNPACK_NOTE: Record<UnpackMode, string> = {
	created: "Unpacked session",
	replaced: "Replaced the local copy of this session",
	forked: "The local copy of this session diverged; unpacked as a fork",
};

function isSessionAction(value: string): value is SessionAction {
	return ACTIONS.some(action => action === value);
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
			description: "pack, unpack, moved, or lease",
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
	};

	static examples = [
		"# Pack a session with its artifacts and image blobs\n  omp session pack ~/.omp/agent/sessions/<project>/<file>.jsonl /tmp/session.tar",
		"# Unpack it on another machine; prints the session file path\n  omp session unpack /tmp/session.tar --cwd ~/src/project",
		"# Mark the local copy stale; resuming it later forks it\n  omp session moved <file>.jsonl --to cloud",
		"# List which of these sessions a running omp owns, without taking ownership (`--` keeps ids starting with `-` from parsing as options)\n  omp session lease --json -- <id> <id>",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Session);
		const action = args.action ?? "";
		if (!isSessionAction(action)) throw new CliUsageError(`Unknown action: ${action}`);
		const usage = USAGE[action];
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
