/**
 * Grep CLI command handlers.
 *
 * Handles `omp grep` subcommand for testing grep tool on Windows.
 */
import * as path from "node:path";
import { GrepOutputMode, grep } from "@oh-my-pi/pi-natives";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { expandPath } from "../tools/path-utils";

export interface GrepCommandArgs {
	pattern: string;
	path: string;
	glob?: string;
	limit: number;
	context: number;
	mode: GrepOutputMode;
	gitignore: boolean;
}

/**
 * Parse grep subcommand arguments.
 * Returns undefined if not a grep command.
 */
export function parseGrepArgs(args: string[]): GrepCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "grep") {
		return undefined;
	}

	const result: GrepCommandArgs = {
		pattern: "",
		path: ".",
		limit: 20,
		context: 2,
		mode: GrepOutputMode.Content,
		gitignore: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--glob" || arg === "-g") {
			result.glob = args[++i];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = parseInt(args[++i], 10);
		} else if (arg === "--context" || arg === "-C") {
			result.context = parseInt(args[++i], 10);
		} else if (arg === "--files" || arg === "-f") {
			result.mode = GrepOutputMode.FilesWithMatches;
		} else if (arg === "--count" || arg === "-c") {
			result.mode = GrepOutputMode.Count;
		} else if (arg === "--no-gitignore") {
			result.gitignore = false;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length >= 1) {
		result.pattern = positional[0];
	}
	if (positional.length >= 2) {
		result.path = positional[1];
	}

	return result;
}

export async function runGrepCommand(cmd: GrepCommandArgs): Promise<void> {
	if (!cmd.pattern) {
		console.error(chalk.red("Error: Pattern is required"));
		process.exit(1);
	}

	const searchPath = path.resolve(expandPath(cmd.path));
	console.log(chalk.dim(`Searching in: ${searchPath}`));
	console.log(chalk.dim(`Pattern: ${cmd.pattern}`));
	console.log(
		chalk.dim(`Mode: ${cmd.mode}, Limit: ${cmd.limit}, Context: ${cmd.context}, Gitignore: ${cmd.gitignore}`),
	);

	console.log("");

	try {
		const result = await grep({
			pattern: cmd.pattern,
			path: searchPath,
			glob: cmd.glob,
			mode: cmd.mode,
			maxCount: cmd.limit,
			context: cmd.mode === GrepOutputMode.Content ? cmd.context : undefined,
			hidden: true,
			gitignore: cmd.gitignore,
		});

		console.log(chalk.green(`Total matches: ${result.totalMatches}`));
		console.log(chalk.green(`Files with matches: ${result.filesWithMatches}`));
		console.log(chalk.green(`Files searched: ${result.filesSearched}`));
		if (result.limitReached) {
			console.log(chalk.yellow(`Limit reached: true`));
		}
		console.log("");

		for (const match of result.matches) {
			const displayPath = match.path.replace(/\\/g, "/");

			if (cmd.mode === GrepOutputMode.Content) {
				if (match.contextBefore) {
					for (const ctx of match.contextBefore) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log(`${chalk.cyan(displayPath)}:${chalk.yellow(String(match.lineNumber))}: ${match.line}`);
				if (match.contextAfter) {
					for (const ctx of match.contextAfter) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log("");
			} else if (cmd.mode === GrepOutputMode.Count) {
				console.log(`${chalk.cyan(displayPath)}: ${match.matchCount ?? 0} matches`);
			} else {
				console.log(chalk.cyan(displayPath));
			}
		}
	} catch (err) {
		console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
		process.exit(1);
	}
}

export function printGrepHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} grep`)} - Test grep tool

${chalk.bold("Usage:")}
  ${APP_NAME} grep <pattern> [path] [options]

${chalk.bold("Arguments:")}
  pattern   Regex pattern to search for
  path      Directory or file to search (default: .)

${chalk.bold("Options:")}
  -g, --glob <pattern>  Filter files by glob pattern
  -l, --limit <n>       Max matches (default: 20)
  -C, --context <n>     Context lines (default: 2)
  -f, --files           Output file names only
  -c, --count           Output match counts per file
  -h, --help            Show this help
  --no-gitignore        Include files excluded by .gitignore

${chalk.bold("Environment:")}
  PI_WALK_WORKERS=N    Set filesystem walker workers (default 4, 0 = auto)

${chalk.bold("Examples:")}
  ${APP_NAME} grep "import" src/
  ${APP_NAME} grep "TODO" . --glob "*.ts"
  ${APP_NAME} grep "function" --files
`);
}
