import chalk from "@oh-my-pi/pi-utils/chalk";
import type { CommitCommandArgs } from "./types";

const FLAG_ALIASES = new Map<string, string>([
	["-c", "--context"],
	["-m", "--model"],
]);

export function parseCommitArgs(args: string[]): CommitCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "commit") {
		return undefined;
	}

	const result: CommitCommandArgs = {
		push: false,
		dryRun: false,
		noChangelog: false,
	};

	for (let i = 1; i < args.length; i += 1) {
		const raw = args[i] ?? "";
		const flag = FLAG_ALIASES.get(raw) ?? raw;
		switch (flag) {
			case "--push":
				result.push = true;
				break;
			case "--dry-run":
				result.dryRun = true;
				break;
			case "--no-changelog":
				result.noChangelog = true;
				break;
			case "--legacy":
				result.legacy = true;
				break;
			case "--context": {
				const value = args[i + 1];
				if (!value || value.startsWith("-")) {
					process.stderr.write(`${chalk.red("Error: --context requires a value")}\n`);
					process.exit(1);
				}
				result.context = value;
				i += 1;
				break;
			}
			case "--model": {
				const value = args[i + 1];
				if (!value || value.startsWith("-")) {
					process.stderr.write(`${chalk.red("Error: --model requires a value")}\n`);
					process.exit(1);
				}
				result.model = value;
				i += 1;
				break;
			}
			case "--help":
			case "-h":
				break;
			default:
				if (flag.startsWith("-")) {
					process.stderr.write(`${chalk.red(`Error: Unknown flag ${flag}`)}\n`);
					process.exit(1);
				}
		}
	}

	return result;
}

export function printCommitHelp(): void {
	const lines = [
		"Usage:",
		"  omp commit [options]",
		"",
		"Options:",
		"  --push           Push after committing",
		"  --dry-run        Preview without committing",
		"  --no-changelog   Skip changelog updates",
		"  --legacy         Use legacy deterministic pipeline",
		"  --context, -c    Additional context for the model",
		"  --model, -m      Override model selection",
		"  --help, -h       Show this help message",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}
