/**
 * Redirected-stderr probe. Runs in a PTY subprocess: a ProcessTerminal is
 * active and same-terminal stderr is guarded by the unified guard. A
 * callback-free process.stderr.write against an unwritable log target
 * (/dev/full) must not kill the process as an unhandled stream error — the
 * diagnostics channel failing is not a reason for the UI to die.
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
const ret = process.stderr.write("stderr-storage-failure-marker\n");
note(`write-returned=${ret}`);
await Bun.sleep(200);
note(`suppressed-after=${isTerminalOutputSuppressed()}`);
try {
	terminal.stop();
	note("stopped-cleanly=true");
} catch (err) {
	note(`stop-threw=${String(err).slice(0, 200)}`);
}
