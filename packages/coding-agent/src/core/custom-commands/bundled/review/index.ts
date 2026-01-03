/**
 * /review command - Interactive code review launcher
 *
 * Provides a menu to select review mode:
 * 1. Review against a base branch (PR style)
 * 2. Review uncommitted changes
 * 3. Review a specific commit
 * 4. Custom review instructions
 */

import type { HookCommandContext } from "../../../hooks/types";
import type { CustomCommand, CustomCommandAPI } from "../../types";

export function createReviewCommand(api: CustomCommandAPI): CustomCommand {
	return {
		name: "review",
		description: "Launch interactive code review",

		async execute(_args: string[], ctx: HookCommandContext): Promise<string | undefined> {
			if (!ctx.hasUI) {
				return "Use the Task tool to run the 'reviewer' agent to review recent code changes.";
			}

			// Main menu
			const mode = await ctx.ui.select("Review Mode", [
				"1. Review against a base branch (PR Style)",
				"2. Review uncommitted changes",
				"3. Review a specific commit",
				"4. Custom review instructions",
			]);

			if (!mode) return undefined;

			const modeNum = parseInt(mode[0], 10);

			switch (modeNum) {
				case 1: {
					// PR-style review against base branch
					const branches = await getGitBranches(api);
					if (branches.length === 0) {
						ctx.ui.notify("No git branches found", "error");
						return undefined;
					}

					const baseBranch = await ctx.ui.select("Select base branch to compare against", branches);
					if (!baseBranch) return undefined;

					const currentBranch = await getCurrentBranch(api);
					return `Use the Task tool to run the "reviewer" agent with this task:

Review the changes between "${baseBranch}" and "${currentBranch}".

Run \`git diff ${baseBranch}...${currentBranch}\` to see the changes, then analyze the modified files.`;
				}

				case 2: {
					// Uncommitted changes
					const status = await getGitStatus(api);
					if (!status.trim()) {
						ctx.ui.notify("No uncommitted changes found", "warning");
						return undefined;
					}

					return `Use the Task tool to run the "reviewer" agent with this task:

Review all uncommitted changes in the working directory.

Run \`git diff\` for unstaged changes and \`git diff --cached\` for staged changes.`;
				}

				case 3: {
					// Specific commit
					const commits = await getRecentCommits(api, 20);
					if (commits.length === 0) {
						ctx.ui.notify("No commits found", "error");
						return undefined;
					}

					const selected = await ctx.ui.select("Select commit to review", commits);
					if (!selected) return undefined;

					// Extract commit hash from selection (format: "abc1234 message")
					const hash = selected.split(" ")[0];

					return `Use the Task tool to run the "reviewer" agent with this task:

Review commit ${hash}.

Run \`git show ${hash}\` to see the changes introduced by this commit.`;
				}

				case 4: {
					// Custom instructions
					const instructions = await ctx.ui.editor(
						"Enter custom review instructions",
						"Review the following:\n\n",
					);
					if (!instructions?.trim()) return undefined;

					return `Use the Task tool to run the "reviewer" agent with this task:

${instructions}`;
				}

				default:
					return undefined;
			}
		},
	};
}

async function getGitBranches(api: CustomCommandAPI): Promise<string[]> {
	try {
		const result = await api.exec("git", ["branch", "-a", "--format=%(refname:short)"]);
		if (result.code !== 0) return [];
		return result.stdout
			.split("\n")
			.map((b) => b.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function getCurrentBranch(api: CustomCommandAPI): Promise<string> {
	try {
		const result = await api.exec("git", ["branch", "--show-current"]);
		return result.stdout.trim() || "HEAD";
	} catch {
		return "HEAD";
	}
}

async function getGitStatus(api: CustomCommandAPI): Promise<string> {
	try {
		const result = await api.exec("git", ["status", "--porcelain"]);
		return result.stdout;
	} catch {
		return "";
	}
}

async function getRecentCommits(api: CustomCommandAPI, count: number): Promise<string[]> {
	try {
		const result = await api.exec("git", ["log", `-${count}`, "--oneline", "--no-decorate"]);
		if (result.code !== 0) return [];
		return result.stdout
			.split("\n")
			.map((c) => c.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

export default createReviewCommand;
