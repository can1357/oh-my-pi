/**
 * Shell CLI command handlers.
 *
 * Handles `omp shell` subcommand for testing the native brush-core shell.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Shell } from "@oh-my-pi/pi-natives";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { buildMinimizerOptions } from "../exec/bash-executor";
import { cfgShellMinimizer } from "../exec/settings";
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
		process.stderr.write(__ompTranslate("Error: shell console requires an interactive TTY.\n"));
		process.exit(1);
	}

	const cwd = cmd.cwd ? path.resolve(cmd.cwd) : getProjectDir();
	const settings = await Settings.init({ cwd });
	const { shell, env: shellEnv } = settings.getShellConfig();
	const snapshotPath = cmd.noSnapshot || !shell.includes("bash") ? null : await getOrCreateSnapshot(shell, shellEnv);
	const minimizer = buildMinimizerOptions(cfgShellMinimizer.get(settings));
	const shellSession = new Shell({ sessionEnv: shellEnv, snapshotPath: snapshotPath ?? undefined, minimizer });

	let active = false;
	let lastChar: string | null = null;

	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const prompt = chalk.cyan(`${APP_NAME} shell> `);

	const printHelp = () => {
		process.stdout.write(
			`${chalk.bold(__ompTranslate("Shell Console Commands"))}

` +
				__ompTranslate(
					"{0}\n  .help           Show this help\n  .exit, exit     Exit the console\n\n",
					`${chalk.bold(__ompTranslate("Special Commands:"))}`,
				) +
				__ompTranslate(
					"{0}\n  --cwd, -C <path>     Set working directory for commands\n  --timeout, -t <ms>   Timeout per command in milliseconds\n  --no-snapshot        Skip sourcing snapshot from user shell\n\n",
					`${chalk.bold(__ompTranslate("Options:"))}`,
				) +
				__ompTranslate(
					"{0}\n  Runs in a persistent brush-core shell session.\n  Variables and functions defined in one command persist for the next.\n\n",
					`${chalk.bold(__ompTranslate("Notes:"))}`,
				),
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
	process.stdout.write(chalk.dim(__ompTranslate("Type .help for commands.\n")));

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
					process.stderr.write(chalk.yellow(__ompTranslate("Command timed out.\n")));
				} else if (result.cancelled) {
					process.stderr.write(chalk.yellow(__ompTranslate("Command cancelled.\n")));
				} else if (result.exitCode !== 0 && result.exitCode !== undefined) {
					process.stderr.write(chalk.yellow(__ompTranslate("Exit code: {0}\n", `${result.exitCode}`)));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(chalk.red(__ompTranslate("Error: {0}\n", `${message}`)));
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
	process.stdout.write(
		__ompTranslate(
			"{0} - Interactive shell console for testing\n\n{1}\n  {2} shell [options]\n\n{3}\n  --cwd, -C <path>     Set working directory for commands\n  --timeout, -t <ms>   Timeout per command in milliseconds\n  --no-snapshot        Skip sourcing snapshot from user shell\n  -h, --help           Show this help\n\n{4}\n  {5} shell\n  {6} shell --cwd ./tmp\n  {7} shell --timeout 2000\n",
			`${chalk.bold(`${APP_NAME} shell`)}`,
			`${chalk.bold(__ompTranslate("Usage:"))}`,
			`${APP_NAME}`,
			`${chalk.bold(__ompTranslate("Options:"))}`,
			`${chalk.bold(__ompTranslate("Examples:\u0004help.command.examples"))}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
		),
	);
}
