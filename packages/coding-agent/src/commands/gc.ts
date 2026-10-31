/**
 * Run on-disk storage maintenance.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { gcHelp as commandHelp } from "../cli/command-help";
import { collectGcErrors, type GcCommandArgs, runGcCommand } from "../cli/gc-cli";

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
				"Give up the live copy of an archived session by id prefix or archive path (runs alone; the only step that deletes one)",
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
		const result = await runGcCommand(cmd);
		const errors = collectGcErrors(result);
		if (errors.length > 0) {
			process.stderr.write(
				`GC completed with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${errors.map(error => `- ${error}`).join("\n")}\n`,
			);
			process.exitCode = 1;
		}
	}
}
