/**
 * Legacy-API probe. Runs in a PTY subprocess and exercises the stderr-guard
 * surface released in 16.5.1 through its old names. Phase A proves the legacy
 * suppression is fd-2-only: stdout keeps the terminal. Phase B proves the
 * legacy calls delegate safely while the unified guard owns the descriptors.
 * Descriptor identity is compared with fstat (dev, ino) so the probe works
 * wherever the suite runs, including hosts without /proc.
 */
import * as fs from "node:fs";
import { restoreTerminalOutput, suppressTerminalOutput } from "../../src/terminal-output-guard";
import { isTerminalStderrSuppressed, restoreTerminalStderr, suppressTerminalStderr } from "../../src/stderr-guard";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const terminalFd1 = fs.fstatSync(1);
const onTerminalFd1 = () => {
	const current = fs.fstatSync(1);
	return current.dev === terminalFd1.dev && current.ino === terminalFd1.ino;
};
const target = `${directory}/legacy-stderr.log`;

// Phase A: legacy suppression must leave fd 1 alone.
note(`suppressed=${suppressTerminalStderr({ redirectPath: target })}`);
note(`fd1-kept=${onTerminalFd1()}`);
fs.writeSync(1, "stdout-live-marker\n");
fs.writeSync(2, "legacy-marker\n");
note(`active=${isTerminalStderrSuppressed()}`);
restoreTerminalStderr();
note(`restored=${!isTerminalStderrSuppressed()}`);
fs.writeSync(2, "post-restore-marker\n");

// Phase B: with the unified guard active, legacy calls report suppression and
// never fight the guard over the descriptors.
note(`unified=${suppressTerminalOutput() !== null}`);
note(`delegated=${suppressTerminalStderr()}`);
note(`fd1-still-redirected=${!onTerminalFd1()}`);
restoreTerminalStderr();
note(`still-suppressed-after-legacy-restore=${isTerminalStderrSuppressed()}`);
fs.writeSync(1, "still-hidden-marker\n");
restoreTerminalOutput();
note(`all-restored=${!isTerminalStderrSuppressed()}`);
fs.writeSync(1, "stdout-back-marker\n");
