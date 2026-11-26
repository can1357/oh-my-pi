/**
 * `omp review` — run the interactive PR-style review flow as a headless command.
 */

import { errorMessage } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runRootCommand } from "../main";
import { parseArgs, reportCliUsageError } from "../cli/args";
import { reviewHelp as commandHelp } from "../cli/command-help";
import { CliUsageError } from "../cli/usage-error";
import { buildReviewPrompt } from "../extensibility/custom-commands/bundled/review/prompt";
import { getReviewTargetIssue, resolveBaseBranchTarget } from "../extensibility/custom-commands/bundled/review/target";

function reportUsage(message: string): void {
	reportCliUsageError(new CliUsageError(message));
	process.exitCode = 2;
}

export default class Review extends Command {
	static description = commandHelp.description;

	static args = {
		focus: Args.string({
			description: "Additional review focus",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		base: Flags.string({
			description: "Base ref to compare against (for example origin/main)",
		}),
		head: Flags.string({
			description: "Head ref to review (default: HEAD)",
		}),
	};

	static examples = [
		"omp review --base origin/main",
		"omp review --base origin/main --head HEAD",
		'omp review --base origin/main --head feat/my-branch "focus on the parser"',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Review);
		const base = flags.base?.trim();
		const head = flags.head?.trim();

		if (!base) {
			reportUsage("--base requires a non-empty ref.");
			return;
		}
		if (head === "") {
			reportUsage("--head requires a non-empty ref.");
			return;
		}

		let prompt: string;
		try {
			const target = await resolveBaseBranchTarget(process.cwd(), base, head ?? "HEAD", {
				pinRange: true,
			});
			const issue = getReviewTargetIssue(target);
			if (issue) throw new Error(issue);
			prompt = buildReviewPrompt(target, args.focus?.join(" ").trim() || undefined);
		} catch (error) {
			const usage = new CliUsageError(errorMessage(error));
			if (reportCliUsageError(usage)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}

		await runRootCommand(parseArgs(["--print", "--allow-home"]), [], {
			initialPrompt: prompt,
			freshSession: true,
		});
	}
}
