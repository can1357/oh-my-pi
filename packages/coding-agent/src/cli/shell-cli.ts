/**
 * Shell CLI command handlers.
 *
 * Handles `omp shell` subcommand for testing the native brush-core shell.
 */
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Shell } from "@oh-my-pi/pi-natives";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { buildMinimizerOptions } from "../exec/bash-executor";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";

export interface ShellCommandArgs {
	cwd?: string;
	timeoutMs?: number;
	noSnapshot?: boolean;
}

export function parseShellArgs(args: string[]): ShellCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "shell") {
		return undefined;
	}

	const result: ShellCommandArgs = {};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd" || arg === "-C") {
			result.cwd = args[++i];
		} else if (arg === "--timeout" || arg === "-t") {
			const parsed = Number.parseInt(args[++i], 10);
			if (Number.isFinite(parsed)) {
				result.timeoutMs = parsed;
			}
		} else if (arg === "--no-snapshot") {
			result.noSnapshot = true;
		}
	}

	return result;
}

export async function runShellCommand(cmd: ShellCommandArgs): Promise<void> {
	if (!process.stdin.isTTY) {
		process.stderr.write("Error: shell console requires an interactive TTY.\n");
		process.exit(1);
	}

	const cwd = cmd.cwd ? path.resolve(cmd.cwd) : getProjectDir();
	const settings = await Settings.init({ cwd });
	const { shell, env: shellEnv } = settings.getShellConfig();
	const snapshotPath = cmd.noSnapshot || !shell.includes("bash") ? null : await getOrCreateSnapshot(shell, shellEnv);
	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));
	const shellSession = new Shell({ sessionEnv: shellEnv, snapshotPath: snapshotPath ?? undefined, minimizer });

	let active = false;
	let lastChar: string | null = null;

	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const prompt = chalk.cyan(`${APP_NAME} shell> `);

	const printHelp = () => {
		process.stdout.write(
			`${chalk.bold("Shell Console Commands")}

` +
				`${chalk.bold("Special Commands:")}
  .help           Show this help
  .exit, exit     Exit the console

` +
				`${chalk.bold("Options:")}
  --cwd, -C <path>     Set working directory for commands
  --timeout, -t <ms>   Timeout per command in milliseconds
  --no-snapshot        Skip sourcing snapshot from user shell

` +
				`${chalk.bold("Notes:")}
  Runs in a persistent brush-core shell session.
  Variables and functions defined in one command persist for the next.

`,
		);
	};

	const interruptHandler = () => {
		if (active) {
			void shellSession.abort();
			return;
		}
		rl.close();
		process.exit(0);
	};

	process.on("SIGINT", interruptHandler);
	process.stdout.write(chalk.dim("Type .help for commands.\n"));

	try {
		while (true) {
			const line = (await rl.question(prompt)).trim();
			if (!line) {
				continue;
			}
			if (line === ".help") {
				printHelp();
				continue;
			}
			if (line === ".exit" || line === "exit" || line === "quit") {
				break;
			}

			active = true;
			lastChar = null;
			try {
				const result = await shellSession.run(
					{
						command: line,
						cwd,
						timeoutMs: cmd.timeoutMs,
					},
					(err, chunk) => {
						if (err) {
							process.stderr.write(`${err.message}\n`);
							return;
						}
						if (chunk.length > 0) {
							lastChar = chunk[chunk.length - 1] ?? null;
						}
						process.stdout.write(chunk);
					},
				);

				if (lastChar && lastChar !== "\n") {
					process.stdout.write("\n");
				}

				if (result.timedOut) {
					process.stderr.write(chalk.yellow("Command timed out.\n"));
				} else if (result.cancelled) {
					process.stderr.write(chalk.yellow("Command cancelled.\n"));
				} else if (result.exitCode !== 0 && result.exitCode !== undefined) {
					process.stderr.write(chalk.yellow(`Exit code: ${result.exitCode}\n`));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(chalk.red(`Error: ${message}\n`));
			} finally {
				active = false;
			}
		}
	} finally {
		process.off("SIGINT", interruptHandler);
		rl.close();
	}
}

export function printShellHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} shell`)} - Interactive shell console for testing

${chalk.bold("Usage:")}
  ${APP_NAME} shell [options]

${chalk.bold("Options:")}
  --cwd, -C <path>     Set working directory for commands
  --timeout, -t <ms>   Timeout per command in milliseconds
  --no-snapshot        Skip sourcing snapshot from user shell
  -h, --help           Show this help

${chalk.bold("Examples:")}
  ${APP_NAME} shell
  ${APP_NAME} shell --cwd ./tmp
  ${APP_NAME} shell --timeout 2000
`);
}
