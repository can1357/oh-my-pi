/**
 * List and clean up agent-managed git worktrees under `~/.omp/wt`.
 */

import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { worktreeHelp as commandHelp } from "../cli/command-help";
import { addWorktree, clearWorktrees, listWorktrees } from "../cli/worktree-cli";
import { Settings } from "../config/settings";

export default class Worktree extends Command {
	static description = commandHelp.description;
	static aliases = ["wt"];

	static args = {
		// A positional action keeps `omp worktree` (the no-arg form) useful.
		action: Args.string({
			description: "list (default), clear, or add",
			required: false,
			options: ["list", "clear", "add"],
			default: "list",
		}),
		path: Args.string({
			description: "Worktree path (add)",
			required: false,
		}),
		commit: Args.string({
			description: "Commit-ish to check out (add)",
			required: false,
		}),
	};

	static flags = {
		cwd: Flags.string({
			char: "C",
			description: "Repository/base directory (add)",
		}),
		branch: Flags.string({
			char: "b",
			description: "Create a new branch (add)",
			exclusive: ["force-branch"],
		}),
		"force-branch": Flags.string({
			char: "B",
			description: "Create or reset a branch (add)",
			exclusive: ["branch"],
		}),
		detach: Flags.boolean({
			char: "d",
			description: "Detach HEAD (add)",
			default: false,
		}),
		quiet: Flags.boolean({
			char: "q",
			description: "Suppress add output",
			default: false,
		}),
		all: Flags.boolean({
			description: "Clear every entry, including live PR-checkout worktrees (clear)",
			default: false,
		}),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print what would be removed without touching the filesystem (clear)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		"omp worktree",
		"omp worktree list --json",
		"omp worktree add ../feature",
		"omp worktree add -b feature ../feature origin/main",
		"omp worktree add --detach ../review HEAD~2",
		"omp worktree clear",
		"omp worktree clear --dry-run",
		"omp worktree clear --all",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Worktree);
		// Load settings so the `worktree.base` override is applied before we scan
		// — otherwise this command would inspect ~/.omp/wt while the agent created
		// its worktrees under the configured base.
		if (args.action === "add") {
			if (!args.path) {
				console.error("Error: Missing required argument: path");
				process.exitCode = 1;
				return;
			}
			try {
				await addWorktree({
					cwd: flags.cwd,
					path: args.path,
					commit: args.commit,
					branch: flags.branch,
					forceBranch: flags["force-branch"],
					detach: flags.detach ?? false,
					quiet: flags.quiet ?? false,
				});
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			}
			return;
		}

		await Settings.init({ cwd: getProjectDir() });
		if (args.action === "clear") {
			await clearWorktrees({
				all: flags.all ?? false,
				dryRun: flags["dry-run"] ?? false,
				json: flags.json ?? false,
			});
			return;
		}
		await listWorktrees({ json: flags.json ?? false });
	}
}
