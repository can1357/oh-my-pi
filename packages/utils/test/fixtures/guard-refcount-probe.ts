/**
 * Nested-suppression probe. Runs in a PTY subprocess: two acquisitions share
 * the guard, and only the final release may restore fd 1 to the terminal.
 */
import * as fs from "node:fs";
import { restoreTerminalOutput, suppressTerminalOutput } from "../../src/terminal-output-guard";

const state = process.argv[2];
const log = (line: string) => fs.appendFileSync(state, `${line}\n`);

const terminalIno = fs.fstatSync(1).ino;
const first = suppressTerminalOutput();
const second = suppressTerminalOutput();
log(`shared=${first !== null && first === second}`);
fs.writeSync(1, "while-isolated\n");

restoreTerminalOutput();
const stillIsolated = fs.fstatSync(1).ino !== terminalIno;
log(`isolated-after-first-release=${stillIsolated}`);

restoreTerminalOutput();
const restored = fs.fstatSync(1).ino === terminalIno;
log(`restored-after-final-release=${restored}`);
fs.writeSync(1, "after-restore\n");
