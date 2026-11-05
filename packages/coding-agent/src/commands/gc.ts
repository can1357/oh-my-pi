/**
 * Run on-disk storage maintenance.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { gcHelp as commandHelp } from "../cli/command-help";
import { collectGcErrors, type GcCommandArgs, type GcResult, runGcCommand } from "../cli/gc-cli";

export default class Gc extends Command {
	static description = commandHelp.description;
	static flags = {
		apply: Flags.boolean({ description: "Apply changes (default is dry-run)" }),
		json: Flags.boolean({ description: "Output JSON" }),
		"agent-dir": Flags.string({ description: "Agent directory to maintain" }),
		blobs: Flags.boolean({ description: "Sweep unreferenced blobs" }),
		archive: Flags.boolean({ description: "Copy cold sessions into the archive, keeping the live copy" }),
		"forward-only": Flags.boolean({
			description:
				"Accept that a reclaimed session is reachable only from an omp with `gc --restore`; required by --reclaim --apply",
		}),
		wal: Flags.boolean({ description: "Checkpoint history/model database WAL files" }),
		stale: Flags.boolean({
			description: "Prune dangling session markers/breadcrumbs and old debug reports and collab replicas",
		}),
		compress: Flags.boolean({
			description: "Store idle sessions with filesystem compression in place (APFS, NTFS)",
		}),
		restore: Flags.string({
			description:
				"Bring an archived session back by id prefix or archive path (runs alone; copies, keeps the archive, frees no space)",
		}),
		reclaim: Flags.string({
			description:
				"Move the live copy of an archived session into the archive and free the archived copies it replaces, by id prefix or archive path (runs alone; deletes only copies)",
		}),
		quarantine: Flags.string({
			description:
				"Move a staging record a killed gc run left, and the directory it names, out of the session trees into gc-quarantine (runs alone; deletes nothing)",
		}),
		"cold-archive-after-days": Flags.integer({ description: "Minimum session age before archiving" }),
		"retain-newest-global": Flags.integer({ description: "Always keep this many newest sessions active" }),
		"retain-newest-per-cwd": Flags.integer({ description: "Always keep this many newest sessions per cwd active" }),
		"stale-retain-newest": Flags.integer({
			description: "Always keep this many newest debug reports and collab replicas",
		}),
		"stale-retain-days": Flags.integer({ description: "Minimum debug report/collab replica age before pruning" }),
		"compress-after-days": Flags.integer({ description: "Minimum idle days before compressing a session" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gc);
		// A preview writes nothing anywhere, a log line included. The file
		// transport would make `~/.omp/logs` and append to a file there — outside
		// the agent directory — the first time anything warns, and settings
		// discovery warns about a malformed `settings.json`. So a preview turns
		// the file off before anything can log, and says on stderr what it
		// would have logged as a warning or an error. The file stays off: putting
		// it back would build it, and make that directory, on the way out.
		let disposeStderrLog: (() => void) | undefined;
		if (flags.apply !== true) {
			logger.setTransports({ file: false });
			disposeStderrLog = logger.registerLogSink(({ level, message, context }) => {
				if (level !== "warn" && level !== "error") return;
				process.stderr.write(`omp gc: ${level}: ${message}${context ? ` ${JSON.stringify(context)}` : ""}\n`);
			});
		}
		const cmd: GcCommandArgs = {
			flags: {
				apply: flags.apply,
				json: flags.json,
				agentDir: flags["agent-dir"],
				blobs: flags.blobs,
				archive: flags.archive,
				wal: flags.wal,
				stale: flags.stale,
				compress: flags.compress,
				restore: flags.restore,
				forwardOnly: flags["forward-only"],
				reclaim: flags.reclaim,
				quarantine: flags.quarantine,
				coldArchiveAfterDays: flags["cold-archive-after-days"],
				retainNewestGlobal: flags["retain-newest-global"],
				retainNewestPerCwd: flags["retain-newest-per-cwd"],
				staleRetainNewest: flags["stale-retain-newest"],
				staleRetainDays: flags["stale-retain-days"],
				compressAfterDays: flags["compress-after-days"],
			},
		};
		let result: GcResult;
		try {
			result = await runGcCommand(cmd);
		} catch (error) {
			// A refusal before anything ran: bad flags, a lock somebody holds,
			// one an older gc left, a settings file that cannot be read. The
			// caller gets it as this command's error — a `--json` object on
			// stdout and a line on stderr — never as a stack trace with
			// nothing on stdout (#18224).
			const refusal = error instanceof Error ? error.message : String(error);
			if (flags.json) process.stdout.write(`${JSON.stringify({ error: refusal }, null, 2)}\n`);
			process.stderr.write(`GC did not run: ${refusal}\n`);
			process.exitCode = 1;
			return;
		} finally {
			disposeStderrLog?.();
		}
		const errors = collectGcErrors(result);
		if (errors.length > 0) {
			process.stderr.write(
				`GC completed with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${errors.map(error => `- ${error}`).join("\n")}\n`,
			);
			process.exitCode = 1;
		}
	}
}
