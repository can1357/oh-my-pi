/**
 * Emergency-restore probe. Runs in a PTY subprocess: the legacy stderr guard
 * owns fd 2 (as a consumer that suppressed stderr before any TUI started),
 * then a crash/signal path calls emergencyTerminalRestore(). Diagnostics
 * written after the emergency cleanup must reach the terminal, not the log
 * the legacy guard left fd 2 pointed at.
 */
import * as fs from "node:fs";
import { suppressTerminalStderr } from "@oh-my-pi/pi-utils";
import { emergencyTerminalRestore } from "../../src/terminal";

const directory = process.argv[2];
const state = process.argv[3];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const target = `${directory}/legacy-stderr.log`;
fs.writeFileSync(target, "");
note(`legacy=${suppressTerminalStderr({ redirectPath: target })}`);
fs.writeSync(2, "suppressed-marker\n");
emergencyTerminalRestore();
fs.writeSync(2, "emergency-marker\n");
