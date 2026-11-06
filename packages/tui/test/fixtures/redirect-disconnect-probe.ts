/**
 * Redirect-disconnect probe. Runs in a PTY subprocess: a ProcessTerminal is
 * active and the guard's redirect target is an unwritable file (/dev/full).
 * A callback-free stdout write must NOT be treated as a terminal disconnect
 * — the terminal is healthy, only the log storage failed — so the process
 * must survive with the terminal still running.
 */
import * as fs from "node:fs";
import { isTerminalOutputSuppressed, setTerminalOutputRedirectTarget } from "@oh-my-pi/pi-utils";
import { ProcessTerminal } from "../../src/terminal";

const state = process.argv[2];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const terminal = new ProcessTerminal({ conpty: false });
terminal.start(
	() => {},
	() => {},
);
note(`suppressed-start=${isTerminalOutputSuppressed()}`);
setTerminalOutputRedirectTarget("/dev/full");
const ret = process.stdout.write("storage-failure-marker\n");
note(`write-returned=${ret}`);
await Bun.sleep(200);
note(`suppressed-after=${isTerminalOutputSuppressed()}`);
try {
	terminal.stop();
	note("stopped-cleanly=true");
} catch (err) {
	note(`stop-threw=${String(err).slice(0, 200)}`);
}
