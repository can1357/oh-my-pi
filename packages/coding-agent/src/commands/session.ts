/**
 * Hand a session to another machine.
 *
 * `omp session pack <session> <out.tar>` writes a self-contained archive,
 * `omp session unpack <archive.tar> --cwd <dir>` lands it in `<dir>`'s session
 * directory (printing the session file path as the only stdout line), and
 * `omp session moved <session> --to <label>` marks the copy left behind stale
 * so resuming it forks instead of continuing it.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionHelp as commandHelp } from "../cli/command-help";
import { resolveSessionFileArg } from "../cli/session-arg";
import { SessionMoveRefusedError } from "../session/session-manager";
import {
	markSessionMoved,
	packSession,
	SessionTransferError,
	unpackSession,
	type UnpackMode,
} from "../session/session-transfer";

const ACTIONS = ["pack", "unpack", "moved"] as const;
type SessionAction = (typeof ACTIONS)[number];

const USAGE: Record<SessionAction, string> = {
	pack: "omp session pack <session> <out.tar>",
	unpack: "omp session unpack <archive.tar> --cwd <dir>",
	moved: "omp session moved <session> --to <label>",
};

const UNPACK_NOTE: Record<UnpackMode, string> = {
	created: __ompTranslate("Unpacked session"),
	replaced: __ompTranslate("Replaced the local copy of this session"),
	forked: __ompTranslate("The local copy of this session diverged; unpacked as a fork"),
};

function isSessionAction(value: string): value is SessionAction {
	return ACTIONS.some(action => action === value);
}

export default class Session extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: __ompTranslate("pack, unpack, or moved"),
			required: true,
			options: ACTIONS,
		}),
		source: Args.string({
			description: __ompTranslate("Session .jsonl path or id (pack, moved); archive path (unpack)"),
			required: false,
		}),
		output: Args.string({
			description: __ompTranslate("Archive file to write (pack)"),
			required: false,
		}),
	};

	static flags = {
		cwd: Flags.string({ description: __ompTranslate("Directory the session continues in on this machine (unpack)") }),
		to: Flags.string({ description: __ompTranslate("Where the session went, e.g. a machine name (moved)") }),
	};

	static examples = [
		"# Pack a session with its artifacts and image blobs\n  omp session pack ~/.omp/agent/sessions/<project>/<file>.jsonl /tmp/session.tar",
		"# Unpack it on another machine; prints the session file path\n  omp session unpack /tmp/session.tar --cwd ~/src/project",
		"# Mark the local copy stale; resuming it later forks it\n  omp session moved <file>.jsonl --to cloud",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Session);
		const action = args.action ?? "";
		if (!isSessionAction(action)) throw new CliUsageError(__ompTranslate("Unknown action: {0}", `${action}`));
		const usage = USAGE[action];
		if (argv.length > (action === "pack" ? 3 : 2)) {
			throw new CliUsageError(__ompTranslate('Unexpected argument "{0}". Usage: {1}', `${argv.at(-1)}`, `${usage}`));
		}
		const source = args.source;
		if (!source)
			throw new CliUsageError(
				__ompTranslate(
					"Missing {0}. Usage: {1}",
					`${action === "unpack" ? __ompTranslate("archive") : __ompTranslate("session")}`,
					`${usage}`,
				),
			);
		if (action !== "unpack" && flags.cwd !== undefined) {
			throw new CliUsageError(__ompTranslate("--cwd only applies to unpack. Usage: {0}", `${usage}`));
		}
		if (action !== "moved" && flags.to !== undefined) {
			throw new CliUsageError(__ompTranslate("--to only applies to moved. Usage: {0}", `${usage}`));
		}

		try {
			switch (action) {
				case "pack": {
					if (!args.output)
						throw new CliUsageError(__ompTranslate("Missing output archive path. Usage: {0}", `${usage}`));
					const result = await packSession(await this.#resolveSession(source), args.output);
					if (result.missingBlobs.length > 0) {
						process.stderr.write(
							`${chalk.yellow(__ompTranslate("warning: {0} referenced blob(s) are missing from the local blob store and were not packed; those images will not load after unpacking.", `${result.missingBlobs.length}`))}\n`,
						);
					}
					process.stdout.write(`${result.archivePath}\n`);
					return;
				}
				case "unpack": {
					if (!flags.cwd) throw new CliUsageError(__ompTranslate("Missing --cwd <dir>. Usage: {0}", `${usage}`));
					const result = await unpackSession(source, { cwd: flags.cwd });
					process.stderr.write(`${chalk.dim(`${UNPACK_NOTE[result.mode]} (${result.id}).`)}\n`);
					process.stdout.write(`${result.sessionFile}\n`);
					return;
				}
				case "moved": {
					if (flags.to === undefined)
						throw new CliUsageError(__ompTranslate("Missing --to <label>. Usage: {0}", `${usage}`));
					await markSessionMoved(await this.#resolveSession(source), flags.to);
					return;
				}
			}
		} catch (error) {
			if (error instanceof SessionTransferError || error instanceof SessionMoveRefusedError) {
				process.stderr.write(`${chalk.red(__ompTranslate("error: {0}", `${error.message}`))}\n`);
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
