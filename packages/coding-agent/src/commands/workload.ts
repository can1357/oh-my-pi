import { postmortem } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { workloadHelp as commandHelp } from "../cli/command-help";
import { CliUsageError } from "../cli/usage-error";
import { runWorkloadCommand } from "../workload";

export default class Workload extends Command {
	static description = commandHelp.description;
	static args = {
		target: Args.string({
			description: "Workload name or path to a .yml file; omit to list discovered workloads",
			required: false,
		}),
	};
	static flags = {
		set: Flags.string({
			description: "Set a declared workload arg as k=v (repeatable)",
			multiple: true,
		}),
		json: Flags.boolean({
			description: "Output JSON",
		}),
		"dry-run": Flags.boolean({
			description: "Print the plan without executing any steps",
		}),
		concurrency: Flags.integer({
			char: "n",
			description: "Fan-out width; overrides the workload default",
		}),
	};

	static examples = [
		"omp workload",
		"omp workload audit-routes",
		"omp workload .omp/workloads/audit-routes.yml",
		"omp workload audit-routes --set target=src --set depth=2",
		"omp workload audit-routes --dry-run",
		"omp workload --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Workload);
		if (flags.concurrency !== undefined && flags.concurrency <= 0) {
			throw new CliUsageError("--concurrency must be a positive integer");
		}
		for (const entry of flags.set ?? []) {
			if (!entry.includes("=")) throw new CliUsageError(`Invalid --set "${entry}". Use --set name=value.`);
		}
		const result = await runWorkloadCommand({
			target: args.target,
			set: flags.set,
			json: flags.json,
			dryRun: flags["dry-run"],
			concurrency: flags.concurrency,
		});
		await postmortem.quit(result.exitCode);
	}
}
