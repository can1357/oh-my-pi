/**
 * Stdout-pipe smoke child for terminal-output-isolation.test.ts — NOT a test
 * file, and NOT run inside a PTY.
 *
 * Production only isolates output when stdout is a TTY (terminal-output-guard
 * returns null for non-TTY stdout), and ProcessTerminal writes no frames to
 * piped output by design. This child therefore asserts the complement of the
 * isolation suite: with stdout piped, NOTHING is redirected — an inherited
 * grandchild's stdout/stderr must pass straight through the caller's pipes,
 * and no omp log may appear under the isolated HOME.
 *
 * The driver spawns it with all stdio piped, writes `c` (inherited child) and
 * `q` (quit) into stdin, and asserts the pipe contents.
 */
import { TUI } from "@oh-my-pi/pi-tui";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { installIsolationScenario } from "./terminal-output-isolation-scenario";

if (process.stdout.isTTY) {
	process.stderr.write("pipe smoke: stdout must NOT be a TTY\n");
	process.exit(2);
}

const tui = new TUI(new ProcessTerminal());

function quit(): never {
	tui.stop();
	process.exit(0);
}

installIsolationScenario(tui, quit);
process.once("SIGTERM", () => quit());
tui.start();
