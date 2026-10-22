/**
 * Child fixture for terminal-output-isolation.test.ts — NOT a test file.
 *
 * Runs a real `ProcessTerminal` + `TUI` as a standalone bun process inside a
 * native `PtySession` PTY started by the test driver. The suite process never
 * touches its own fd 1/2: every terminal side effect happens inside this
 * child, on the PTY, exactly like a production omp run. The child environment
 * is scrubbed by the driver, so the headless test-runtime default is off and
 * the real terminal pipeline (including the native output pump) runs.
 *
 * Fallback mode: when the driver launches with PI_TEST_RUNTIME=1 (public
 * bun-test-runtime knob → production keeps the native pump off) plus
 * OMP_ISOLATION_FALLBACK=1, this fixture opts back into the real terminal via
 * the public setTerminalHeadless(false) seam. The pump-less fallback render
 * path then drives the same isolation contract — no internals touched.
 *
 * Scenario protocol: see terminal-output-isolation-scenario.ts (keys c/p/e/i/q,
 * ST_* status markers, LIVE_<cols>x<rows> geometry report from the child's own
 * process.stdout).
 */
import * as fs from "node:fs";
import { getLogsDir, setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { TUI } from "@oh-my-pi/pi-tui";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { installIsolationScenario } from "./terminal-output-isolation-scenario";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	process.stderr.write("isolation fixture: stdin/stdout must be a TTY (run inside a PTY)\n");
	process.exit(2);
}

if (process.env.OMP_ISOLATION_FALLBACK === "1") {
	setTerminalHeadless(false);
}

const logDirectoryFile = process.env.OMP_ISOLATION_LOG_DIRECTORY_FILE;
if (logDirectoryFile) fs.writeFileSync(logDirectoryFile, getLogsDir());

const tui = new TUI(new ProcessTerminal());

function quit(): never {
	tui.stop();
	process.exit(0);
}

installIsolationScenario(tui, quit);
process.once("SIGTERM", () => quit());
tui.start();
