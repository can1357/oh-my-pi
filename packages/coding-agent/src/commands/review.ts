/**
 * `omp review` — run the interactive PR-style review flow as a headless command.
 */

import * as path from "node:path";
import { errorMessage } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runRootCommand } from "../main";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { reviewHelp as commandHelp } from "../cli/command-help";
import { flagConsumesValue } from "../cli/flag-tables";
import { CliUsageError } from "../cli/usage-error";
import { buildReviewPrompt } from "../extensibility/custom-commands/bundled/review/prompt";
import { getReviewTargetIssue, resolveBaseBranchTarget } from "../extensibility/custom-commands/bundled/review/target";

export interface ReviewLaunch {
	base: string;
	head?: string;
	focus: string;
	launchArgv: string[];
}

export function parseReviewLaunch(argv: readonly string[]): ReviewLaunch {
	const launch: string[] = [];
	const focus: string[] = [];
	let base: string | undefined;
	let head: string | undefined;
	let sawSeparator = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--") {
			sawSeparator = true;
			continue;
		}
		if (sawSeparator) {
			focus.push(arg);
			continue;
		}
		if (arg === "--base" || arg === "--head") {
			const next = argv[index + 1];
			const hasValue = next !== undefined && next !== "--" && !next.startsWith("-");
			const value = hasValue ? next : "";
			if (hasValue) index += 1;
			if (arg === "--base") base = value;
			else head = value;
			continue;
		}
		if (arg.startsWith("--base=")) {
			base = arg.slice("--base=".length);
			continue;
		}
		if (arg.startsWith("--head=")) {
			head = arg.slice("--head=".length);
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			launch.push(arg);
			// Keep a forwarded flag's value attached so focus text like "--head"
			// is only interpreted as a review option when it is in option position.
			if (flagConsumesValue(arg, argv[index + 1])) launch.push(argv[++index]!);
			continue;
		}
		focus.push(arg);
	}

	const trimmedBase = base?.trim();
	if (!trimmedBase) throw new CliUsageError("--base requires a non-empty ref.");
	const trimmedHead = head?.trim();
	if (head !== undefined && !trimmedHead) throw new CliUsageError("--head requires a non-empty ref.");
	return {
		base: trimmedBase,
		head: trimmedHead,
		focus: focus.join(" ").trim(),
		launchArgv: ["--print", "--allow-home", "--wait-async", ...launch],
	};
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
		let reviewLaunch: ReviewLaunch;
		let launchArgs: ParsedArgs;
		try {
			reviewLaunch = parseReviewLaunch(this.argv);
			launchArgs = parseArgs(reviewLaunch.launchArgv);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		const { base, head, focus } = reviewLaunch;
		const reviewCwd = launchArgs.cwd ? path.resolve(launchArgs.cwd) : process.cwd();

		let prompt: string;
		try {
			const target = await resolveBaseBranchTarget(reviewCwd, base, head ?? "HEAD", {
				pinRange: true,
			});
			const issue = getReviewTargetIssue(target);
			if (issue) throw new Error(issue);
			prompt = buildReviewPrompt(target, focus || undefined);
		} catch (error) {
			const usage = new CliUsageError(errorMessage(error));
			if (reportCliUsageError(usage)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}

		await runRootCommand(launchArgs, reviewLaunch.launchArgv, {
			initialPrompt: prompt,
			freshSession: true,
		});
	}
}
