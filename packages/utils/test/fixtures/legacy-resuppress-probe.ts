/**
 * Re-suppress probe. Runs in a PTY subprocess: a consumer releases the legacy
 * stderr guard while the unified guard is active (the release is queued), then
 * re-suppresses before the TUI stops. The queued release must be cancelled —
 * fd 2 stays on the legacy log across the unified teardown, and only the
 * consumer's own final restore returns it to the terminal.
 */
import * as fs from "node:fs";
import { restoreTerminalOutput, suppressTerminalOutput } from "../../src/terminal-output-guard";
import { isTerminalStderrSuppressed, restoreTerminalStderr, suppressTerminalStderr } from "../../src/stderr-guard";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const target = `${directory}/legacy-stderr.log`;
fs.writeFileSync(target, "");
note(`legacy=${suppressTerminalStderr({ redirectPath: target })}`);
note(`unified=${suppressTerminalOutput() !== null}`);
// Queued: arrives while the unified guard owns the teardown ordering.
restoreTerminalStderr();
// The consumer changes its mind and suppresses again before the TUI stops.
note(`resuppressed=${suppressTerminalStderr()}`);
restoreTerminalOutput();
note(`still-suppressed-after-tui=${isTerminalStderrSuppressed()}`);
fs.writeSync(2, "after-tui-stop-marker\n");
restoreTerminalStderr();
note(`final-restored=${!isTerminalStderrSuppressed()}`);
fs.writeSync(2, "after-final-restore-marker\n");
