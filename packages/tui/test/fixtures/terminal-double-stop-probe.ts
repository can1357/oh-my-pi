/**
 * Double-stop probe. Runs in a PTY subprocess: two ProcessTerminals share the
 * reference-counted output guard; stopping one instance twice (emergency
 * cleanup followed by its owner's teardown) must not release the other
 * instance's acquisition — fd 1/2 stay isolated until the second instance
 * stops.
 */
import { spyOn } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import * as fs from "node:fs";
import { isTerminalOutputSuppressed } from "@oh-my-pi/pi-utils";
import { writeTerminalSequence } from "../../src/active-terminal";
import { emergencyTerminalRestore, ProcessTerminal } from "../../src/terminal";

const state = process.argv[2];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

const privateKitty = process.argv[3] === "kitty-private";
const kitty = process.argv[3] === "kitty" || privateKitty;
if (privateKitty) {
	// Bun's spy types accept callable exports, not native constructors.
	spyOn(natives, "TtyWriter").mockImplementation((() => {
		throw new Error("output pump unavailable");
	}) as never);
}
const modify = process.argv[3] === "modify";
const deferred = process.argv[3] === "deferred" || kitty || modify;
const olderDeferred = process.argv[3] === "older-deferred";
const a = new ProcessTerminal({ conpty: false });
a.start(
	() => {},
	() => {},
	undefined,
	{ deferInput: deferred },
);
const b = new ProcessTerminal({ conpty: false });
b.start(
	() => {},
	() => {},
	undefined,
	{ deferInput: olderDeferred },
);
if (modify) {
	await Bun.sleep(180);
	note(`newest-enhancement=${JSON.stringify(b.keyboardEnhancementEnterSequence)}`);
}
if (kitty) {
	process.stdin.emit("data", "\x1b[?0u");
	note(`newest-kitty=${b.kittyProtocolActive}`);
}
if (process.argv[3] === "emergency") {
	emergencyTerminalRestore();
	note(`emergency-isolated=${isTerminalOutputSuppressed()}`);
	note(`emergency-raw=${process.stdin.isRaw}`);
	fs.writeSync(1, "EMERGENCY_BOTH_RESTORED\n");
	process.exit(0);
}
const newestFirst = process.argv[3] === "newest" || deferred;
const stopping = newestFirst ? b : a;
const survivor = newestFirst ? a : b;
note(`after-start=${isTerminalOutputSuppressed()}`);
stopping.write("\x1b]0;STOP_OWNER_BEGIN\x07");
stopping.stop();
note(`after-first-stop=${isTerminalOutputSuppressed()}`);
// Emergency cleanup followed by the owner's teardown must remain local.
stopping.stop();
note(`after-double-stop=${isTerminalOutputSuppressed()}`);
note(`survivor-raw=${process.stdin.isRaw}`);
note(`survivor-paused=${process.stdin.isPaused()}`);
writeTerminalSequence("\x1b]0;SURVIVING_OWNER_SEQUENCE\x07");
survivor.write("\x1b]0;STOP_OWNER_END\x07");
if ((deferred || olderDeferred) && !modify) {
	survivor.enableInput();
	note(`enabled-raw=${process.stdin.isRaw}`);
	if (kitty) process.stdin.emit("data", "\x1b[?0u");
}
survivor.stop();
note(`after-final-stop=${isTerminalOutputSuppressed()}`);
note(`final-raw=${process.stdin.isRaw}`);
if (kitty) fs.writeSync(1, "KITTY_OWNERS_STOPPED\n");
if (modify) fs.writeSync(1, "MODIFY_OWNERS_STOPPED\n");
