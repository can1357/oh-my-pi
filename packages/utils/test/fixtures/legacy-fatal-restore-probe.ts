/**
 * Fatal-restore probe. Runs in a PTY subprocess with only the legacy stderr
 * guard active and replays the postmortem fatal-report descriptor restore:
 * force-restore the unified guard, then the legacy guard, then write the
 * report to fd 2. The report must reach the terminal, not the log file.
 */
import * as fs from "node:fs";
import { restoreTerminalForFatalReport } from "../../src/postmortem";
import { suppressTerminalStderr } from "../../src/stderr-guard";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const target = `${directory}/legacy-stderr.log`;
note(`suppressed=${suppressTerminalStderr({ redirectPath: target })}`);

// postmortem.fatal() descriptor sequence.
restoreTerminalForFatalReport();

fs.writeSync(2, "fatal-report-marker\n");
