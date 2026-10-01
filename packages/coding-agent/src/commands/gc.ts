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
		archive: Flags.boolean({ description: "Archive cold sessions" }),
		wal: Flags.boolean({ description: "Checkpoint history/model database WAL files" }),
		stale: Flags.boolean({
			description: "Prune dangling session markers/breadcrumbs and old debug reports and collab replicas",
		}),
		"cold-archive-after-days": Flags.integer({ description: "Minimum session age before archiving" }),
		"retain-newest-global": Flags.integer({ description: "Always keep this many newest sessions active" }),
		"retain-newest-per-cwd": Flags.integer({ description: "Always keep this many newest sessions per cwd active" }),
		"stale-retain-newest": Flags.integer({
			description: "Always keep this many newest debug reports and collab replicas",
		}),
		"stale-retain-days": Flags.integer({ description: "Minimum debug report/collab replica age before pruning" }),
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
				coldArchiveAfterDays: flags["cold-archive-after-days"],
				retainNewestGlobal: flags["retain-newest-global"],
				retainNewestPerCwd: flags["retain-newest-per-cwd"],
				staleRetainNewest: flags["stale-retain-newest"],
				staleRetainDays: flags["stale-retain-days"],
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
