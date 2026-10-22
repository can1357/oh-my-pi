/**
 * Deferred-start probe. Runs in a PTY subprocess: ProcessTerminal.start with
 * deferInput returns before any frame is written, so nothing has forced the
 * shared stream error listeners to exist yet. A callback-free redirected
 * write against an unwritable log target in that window must not kill the
 * process as an unhandled stream error.
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
	undefined,
	{ deferInput: true },
);
note(`suppressed-start=${isTerminalOutputSuppressed()}`);
setTerminalOutputRedirectTarget("/dev/full");
const ret = process.stderr.write("deferred-start-marker\n");
note(`write-returned=${ret}`);
await Bun.sleep(200);
note(`suppressed-after=${isTerminalOutputSuppressed()}`);
try {
	terminal.stop();
	note("stopped-cleanly=true");
} catch (err) {
	note(`stop-threw=${String(err).slice(0, 200)}`);
}
