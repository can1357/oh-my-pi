/**
 * The Agent View over live omp sessions, and management of bundled task agents.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { runAgentsOverview } from "../cli/agents-view-cli";
import { agentsHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: AgentsAction[] = ["unpack"];

export default class Agents extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Agents action (omit to open the Agent View)",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (live sessions, or the unpack result)" }),
		cwd: Flags.string({ description: "Only list sessions working in this directory" }),
		select: Flags.string({ description: "Internal: session key selected when the Agent View opens" }),
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files (unpack)" }),
		dir: Flags.string({ description: "Output directory, overrides --user/--project (unpack)" }),
		user: Flags.boolean({ description: "Write to ~/.omp/agent/agents, the default (unpack)" }),
		project: Flags.boolean({ description: "Write to ./.omp/agents (unpack)" }),
	};

	static examples = [
		"# Open the Agent View: live sessions, attach, start background sessions\n  omp agents",
		"# List live sessions as JSON\n  omp agents --json",
		"# Only sessions working in the current project\n  omp agents --cwd .",
		"# Export bundled agents into user config (default)\n  omp agents unpack",
		"# Export bundled agents into project config\n  omp agents unpack --project",
		"# Overwrite existing local agent files\n  omp agents unpack --project --force",
		"# Export into a custom directory\n  omp agents unpack --dir ./tmp/agents --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		await initTheme();
		if (!args.action) {
			await runAgentsOverview({ json: flags.json, cwd: flags.cwd, select: flags.select });
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
			},
		};

		await runAgentsCommand(cmd);
	}
}
