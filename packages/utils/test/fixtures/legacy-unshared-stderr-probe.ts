/**
 * Unshared-stderr probe. Runs in a PTY subprocess: fd 2 is redirected to a
 * file BEFORE the unified guard starts, so the unified guard intentionally
 * leaves fd 2 alone. The legacy `suppressTerminalStderr()` default call must
 * report false in that state (fd 2 was never fenced), not silently claim the
 * unified guard covers it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { restoreTerminalOutput, suppressTerminalOutput, tryLibcFdOps } from "../../src/terminal-output-guard";
import { suppressTerminalStderr } from "../../src/stderr-guard";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const stderrFile = path.join(directory, "pre-redirected-stderr.log");
fs.writeFileSync(stderrFile, "");
// Redirect fd 2 before any guard runs, as `2>file` would.
const fileFd = fs.openSync(stderrFile, "a");
const libc = tryLibcFdOps();
if (!libc) {
	note("libc=false");
	fs.closeSync(fileFd);
} else {
	const savedRealStderr = libc.dup(2);
	libc.dup2(fileFd, 2);
	fs.closeSync(fileFd);
	// stdout is still the PTY: unified suppression starts, sees fd 2 no longer
	// shares the terminal, and must leave it untouched.
	const unified = suppressTerminalOutput();
	const defaultResult = suppressTerminalStderr();
	restoreTerminalOutput();
	libc.dup2(savedRealStderr, 2);
	fs.closeSync(savedRealStderr);
	note(`libc=true unified=${unified !== null} default=${defaultResult}`);
}
