/**
 * Manage task agents.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { agentsHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: AgentsAction[] = ["unpack", "show"];

export default class Agents extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Agents action",
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Agent name (for show)",
			required: false,
		}),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dir: Flags.string({ description: "Output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Write to ~/.omp/agent/agents (default)" }),
		project: Flags.boolean({ description: "Write to ./.omp/agents" }),
	};

	static examples = [
		"# Export bundled agents into user config (default)\n  omp agents unpack",
		"# Export bundled agents into project config\n  omp agents unpack --project",
		"# Overwrite existing local agent files\n  omp agents unpack --project --force",
		"# Export into a custom directory\n  omp agents unpack --dir ./tmp/agents --json",
		"# Show the model, tier, compaction, tools and other values scout runs with, and what set each\n  omp agents show scout",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp("omp", "agents", Agents);
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			name: args.name,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
			},
		};

		await initTheme();
		await runAgentsCommand(cmd);
	}
}
