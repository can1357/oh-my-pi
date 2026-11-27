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
import {
	getReviewTargetIssue,
	resolveBaseBranchTarget,
	type ResolvedReviewTarget,
} from "../extensibility/custom-commands/bundled/review/target";

export interface ReviewLaunch {
	base: string;
	head?: string;
	launchArgv: string[];
}

const REVIEW_RESTORE_FLAGS: ReadonlySet<string> = new Set([
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--restore",
	"--session",
	"--fork",
	"--from-claude",
	"--from-codex",
]);
const REVIEW_UNSUPPORTED_FLAGS: ReadonlySet<string> = new Set(["--export", "--goal", "--no-ui"]);

function rejectReviewOnlyFlag(arg: string): void {
	if (!arg.startsWith("-")) return;
	const equals = arg.indexOf("=");
	const name = equals === -1 ? arg : arg.slice(0, equals);
	if (REVIEW_RESTORE_FLAGS.has(name)) {
		throw new CliUsageError(`omp review starts a fresh session; remove ${name}.`);
	}
	if (REVIEW_UNSUPPORTED_FLAGS.has(name)) {
		throw new CliUsageError(`omp review does not support ${name}.`);
	}
}

/** Focus text is positional; an @-prefixed token must not silently disappear. */
export function reviewFocus(args: ParsedArgs): string | undefined {
	const focus = [...args.messages, ...args.fileArgs.map(file => `@${file}`)].join(" ").trim();
	return focus || undefined;
}

export function parseReviewLaunch(argv: readonly string[]): ReviewLaunch {
	const launch: string[] = [];
	let base: string | undefined;
	let head: string | undefined;
	let baseSpecified = false;
	let headSpecified = false;
	let baseMissingValue = false;
	let headMissingValue = false;
	let sawSeparator = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--") {
			sawSeparator = true;
			launch.push(arg);
			continue;
		}
		if (sawSeparator) {
			launch.push(arg);
			continue;
		}
		if (arg === "--base" || arg === "--head") {
			const next = argv[index + 1];
			const hasValue = next !== undefined && next !== "--" && !next.startsWith("-");
			const value = hasValue ? next : "";
			if (hasValue) index += 1;
			if (arg === "--base") {
				baseSpecified = true;
				base = value;
				baseMissingValue ||= !hasValue || !value.trim();
			} else {
				headSpecified = true;
				head = value;
				headMissingValue ||= !hasValue || !value.trim();
			}
			continue;
		}
		if (arg.startsWith("--base=")) {
			baseSpecified = true;
			base = arg.slice("--base=".length);
			baseMissingValue ||= !base.trim();
			continue;
		}
		if (arg.startsWith("--head=")) {
			headSpecified = true;
			head = arg.slice("--head=".length);
			headMissingValue ||= !head.trim();
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			// `parseArgs` silently ignores a string flag with no value. Reject
			// launch-only flags that this command never supports before the
			// command can accidentally continue with a default model turn.
			rejectReviewOnlyFlag(arg);
			launch.push(arg);
			// Keep a forwarded flag's value attached so focus text like "--head"
			// is only interpreted as a review option when it is in option position.
			if (flagConsumesValue(arg, argv[index + 1])) launch.push(argv[++index]!);
			continue;
		}
		launch.push(arg);
	}

	const trimmedBase = base?.trim();
	if (!baseSpecified || baseMissingValue || !trimmedBase) {
		throw new CliUsageError("--base requires a non-empty ref.");
	}
	const trimmedHead = head?.trim();
	if (headSpecified && (headMissingValue || !trimmedHead)) {
		throw new CliUsageError("--head requires a non-empty ref.");
	}
	return {
		base: trimmedBase,
		head: trimmedHead,
		launchArgv: ["--print", "--allow-home", "--wait-async", ...launch],
	};
}

export function validateReviewLaunch(args: ParsedArgs): void {
	const unsupported: string[] = [];
	if (args.mode === "acp" || args.mode === "rpc" || args.mode === "rpc-ui") {
		unsupported.push(`--mode ${args.mode}`);
	}
	if (args.export !== undefined) unsupported.push("--export");
	if (args.goal !== undefined) unsupported.push("--goal");
	if (args.noUi) unsupported.push("--no-ui");
	if (unsupported.length > 0) {
		throw new CliUsageError(`omp review does not support ${unsupported.join(", ")}.`);
	}

	const restore: string[] = [];
	if (args.continue) restore.push("--continue");
	if (args.resume !== undefined) restore.push("--resume");
	if (args.restore) restore.push("--restore");
	if (args.fork !== undefined) restore.push("--fork");
	if (args.fromClaude) restore.push("--from-claude");
	if (args.fromCodex) restore.push("--from-codex");
	if (restore.length > 0) {
		throw new CliUsageError(`omp review starts a fresh session; remove ${restore.join(", ")}.`);
	}

	if (args.noTools || (args.tools !== undefined && !args.tools.includes("task"))) {
		throw new CliUsageError("omp review requires the task tool; include task in --tools or remove --no-tools.");
	}
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
			required: true,
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
			validateReviewLaunch(launchArgs);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		const { base, head } = reviewLaunch;
		const reviewCwd = launchArgs.cwd ? path.resolve(launchArgs.cwd) : process.cwd();

		let target: ResolvedReviewTarget;
		try {
			target = await resolveBaseBranchTarget(reviewCwd, base, head ?? "HEAD", {
				pinRange: true,
			});
			const issue = getReviewTargetIssue(target);
			if (issue) throw new Error(issue);
		} catch (error) {
			const usage = new CliUsageError(errorMessage(error));
			if (reportCliUsageError(usage)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}

		try {
			await runRootCommand(launchArgs, reviewLaunch.launchArgv, {
				initialPrompt: parsed => buildReviewPrompt(target, reviewFocus(parsed)),
				freshSession: true,
			});
		} catch (error) {
			if (reportCliUsageError(error)) {
				// Startup has already created long-lived handles (theme watcher,
				// settings timers, model registry). Exit like the launch command
				// instead of waiting for them to drain.
				process.exit(2);
			}
			throw error;
		}
	}
}
