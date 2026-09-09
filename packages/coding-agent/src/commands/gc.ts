/**
 * Run on-disk storage maintenance.
 */

import { CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { gcHelp as commandHelp } from "../cli/command-help";
import { collectGcErrors, type GcCommandArgs, runGcCommand } from "../cli/gc-cli";
import { collectStorageReport, formatStorageReport } from "../cli/gc-report";

export default class Gc extends Command {
	static description = commandHelp.description;
	static flags = {
		apply: Flags.boolean({ description: "Apply changes (default is dry-run)" }),
		json: Flags.boolean({ description: "Output JSON" }),
		report: Flags.boolean({ description: "Report storage sizes without changing files or running GC" }),
		"agent-dir": Flags.string({ description: "Agent directory to maintain" }),
		blobs: Flags.boolean({ description: "Sweep unreferenced blobs" }),
		archive: Flags.boolean({ description: "Archive cold sessions" }),
		wal: Flags.boolean({ description: "Checkpoint history/model database WAL files" }),
		"cold-archive-after-days": Flags.integer({ description: "Minimum session age before archiving" }),
		"retain-newest-global": Flags.integer({ description: "Always keep this many newest sessions active" }),
		"retain-newest-per-cwd": Flags.integer({ description: "Always keep this many newest sessions per cwd active" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gc);
		if (flags.report) {
			const conflicts = [
				"apply",
				"blobs",
				"archive",
				"wal",
				"cold-archive-after-days",
				"retain-newest-global",
				"retain-newest-per-cwd",
			] as const;
			for (const flag of conflicts) {
				if (flags[flag] !== undefined) throw new CliUsageError(`--report cannot be combined with --${flag}`);
			}
			const report = await collectStorageReport(flags["agent-dir"]);
			process.stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatStorageReport(report));
			if (report.errors.length > 0) process.exitCode = 1;
			return;
		}
		const cmd: GcCommandArgs = {
			flags: {
				apply: flags.apply,
				json: flags.json,
				agentDir: flags["agent-dir"],
				blobs: flags.blobs,
				archive: flags.archive,
				wal: flags.wal,
				coldArchiveAfterDays: flags["cold-archive-after-days"],
				retainNewestGlobal: flags["retain-newest-global"],
				retainNewestPerCwd: flags["retain-newest-per-cwd"],
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
