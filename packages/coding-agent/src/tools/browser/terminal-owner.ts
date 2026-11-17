/**
 * Which omp the terminal env (a Tern pane, a cmux workspace) belongs to. The
 * interactive TUI claims it at startup; every command it runs (bash, eval
 * kernels, services) inherits the claim, so an omp started from one of them
 * (`omp -p` from a harness, a script) can tell that the pane in its env shows
 * another session and keep its browser tabs out of it.
 */

/** The pid of the interactive omp drawn in the terminal this process inherited. */
export const TERMINAL_OWNER_ENV = "PI_TERMINAL_OWNER_PID";

/** Claim the terminal for this process's interactive TUI. */
export function claimTerminal(env: Record<string, string | undefined> = process.env, pid = process.pid): void {
	env[TERMINAL_OWNER_ENV] = String(pid);
}

/** Whether the terminal in env is this process's: no omp claimed it, or this one did. */
export function ownsTerminal(env: Record<string, string | undefined> = process.env, pid = process.pid): boolean {
	const owner = env[TERMINAL_OWNER_ENV];
	return !owner || owner === String(pid);
}
