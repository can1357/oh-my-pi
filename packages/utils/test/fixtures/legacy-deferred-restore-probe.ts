/**
 * Deferred-restore probe. Runs in a PTY subprocess: a consumer acquires the
 * legacy stderr guard before the unified guard starts, releases it while the
 * unified guard is active, and then the unified guard releases. The single
 * legacy restore call must have taken effect by the time the unified guard is
 * done — fd 2 must be back on the terminal, not still writing the log.
 */
import * as fs from "node:fs";
import { restoreTerminalOutput, suppressTerminalOutput } from "../../src/terminal-output-guard";
import { isTerminalStderrSuppressed, restoreTerminalStderr, suppressTerminalStderr } from "../../src/stderr-guard";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const target = `${directory}/legacy-stderr.log`;
note(`legacy=${suppressTerminalStderr({ redirectPath: target })}`);
note(`unified=${suppressTerminalOutput() !== null}`);
restoreTerminalStderr();
// The release must be deferred: fd 2 stays on the legacy log while the TUI
// is live, instead of repointing at the viewport mid-frame.
fs.writeSync(2, "during-tui-marker\n");
restoreTerminalOutput();
note(`suppressed-after=${isTerminalStderrSuppressed()}`);
fs.writeSync(2, "after-tui-stop-marker\n");
