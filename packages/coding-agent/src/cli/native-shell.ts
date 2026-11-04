/**
 * `omp zsh|bash|sh [args...]`: the pi-shell engine as a process shell, run
 * in this process through the native `runShellMain`.
 *
 * The argv after `omp` reaches the shell untouched (`omp zsh --help`, `-c`,
 * `-i`, `-l`, `--emulate`, scripts), its first word becoming the shell's
 * `argv[0]` (which picks the dialect). `cli.ts` dispatches here before the
 * command framework loads; the registered `zsh`/`bash`/`sh` commands exist
 * for `omp --help` and the generated completions.
 */

/** The shells `omp` runs natively, by command word. */
export const NATIVE_SHELLS: Readonly<Record<string, true>> = { zsh: true, bash: true, sh: true };

/** Whether `word` (the first argv word) names a native shell. */
export function isNativeShell(word: string | undefined): word is string {
	return word !== undefined && NATIVE_SHELLS[word] === true;
}

/**
 * Run the shell `argv[0]` names with the rest of `argv` as its command line,
 * then exit the process with its status.
 */
export async function runNativeShell(argv: string[]): Promise<never> {
	// Command boundary: only the shell path loads the native addon here.
	const { runShellMain } = await import("@oh-my-pi/pi-natives");
	process.exit(runShellMain(argv));
}
