/**
 * `omp project` — manage per-project sync scoping in `~/.omp/agent/projects.yml`.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { projectHelp as commandHelp } from "../cli/command-help";
import { PROJECT_ACTIONS, type ProjectAction, runProjectCommand } from "../cli/project-cli";

export default class Project extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "Project action",
			required: false,
			options: [...PROJECT_ACTIONS],
		}),
		// Second positional: a filesystem path (list/enable/disable/add/rm) or, for
		// `path`, the new local path to repoint the id at. Defaults to the cwd.
		target: Args.string({
			description: "Filesystem path (default cwd); for `path`, the new local path",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (list)" }),
		id: Flags.string({
			description: "Logical project id shared across machines (required for `add`/`path`)",
		}),
	};

	static examples = [
		`# List registered projects (marks the current directory)\n  ${APP_NAME} project`,
		`# Machine-readable listing\n  ${APP_NAME} project list --json`,
		`# Machine A: enable sync inside a git repo (id derived from the origin remote)\n  ${APP_NAME} project enable`,
		`# Machine A: name a non-git project explicitly\n  ${APP_NAME} project enable --id my-project`,
		`# Machine B: map the same project id onto a different checkout path…\n  ${APP_NAME} project add --id git:github.com/acme/foo ~/dev/foo`,
		`# …then turn sync on for it\n  ${APP_NAME} project enable --id git:github.com/acme/foo ~/dev/foo`,
		`# Pause replication without losing the mapping\n  ${APP_NAME} project disable`,
		`# Repoint an id at a moved checkout\n  ${APP_NAME} project path --id git:github.com/acme/foo ~/code/foo`,
		`# Remove a mapping entirely\n  ${APP_NAME} project rm --id git:github.com/acme/foo`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Project);
		const action = (args.action ?? "list") as ProjectAction;
		await runProjectCommand({
			action,
			target: args.target,
			flags: {
				json: flags.json,
				id: flags.id,
			},
		});
	}
}
