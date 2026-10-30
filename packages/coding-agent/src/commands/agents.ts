/**
 * Manage bundled task agents.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { agentsHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: AgentsAction[] = ["unpack"];

export default class Agents extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: __ompTranslate("Agents action"),
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: __ompTranslate("Overwrite existing agent files") }),
		json: Flags.boolean({ description: __ompTranslate("Output JSON") }),
		dir: Flags.string({ description: __ompTranslate("Output directory (overrides --user/--project)") }),
		user: Flags.boolean({ description: __ompTranslate("Write to ~/.omp/agent/agents (default)") }),
		project: Flags.boolean({ description: __ompTranslate("Write to ./.omp/agents") }),
	};

	static examples = [
		__ompTranslate("# Export bundled agents into user config (default)\n  omp agents unpack"),
		__ompTranslate("# Export bundled agents into project config\n  omp agents unpack --project"),
		__ompTranslate("# Overwrite existing local agent files\n  omp agents unpack --project --force"),
		__ompTranslate("# Export into a custom directory\n  omp agents unpack --dir ./tmp/agents --json"),
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp("omp", "agents", Agents);
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

		await initTheme();
		await runAgentsCommand(cmd);
	}
}
