import chalk from "chalk";

/**
 * Wraps a command function with consistent error handling.
 * - Catches errors and logs user-friendly messages
 * - Shows stack trace only when DEBUG env var is set
 * - Sets non-zero exit code on error
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<void>>(fn: T): T {
	return (async (...args: any[]) => {
		try {
			await fn(...args);
		} catch (err) {
			const error = err as Error;
			console.log(chalk.red(`Error: ${error.message}`));
			if (process.env.DEBUG) {
				console.log(chalk.dim(error.stack));
			}
			process.exitCode = 1;
		}
	}) as T;
}
