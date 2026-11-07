/**
 * Redirect-write failure probe. Runs in a PTY subprocess: fd 1 is redirected
 * onto an unwritable target (/dev/full fails every write with ENOSPC). A
 * callback-free `process.stdout.write` must survive the failure — return
 * false and deliver the error through the stream's asynchronous error path —
 * instead of throwing synchronously into the caller, where an incidental
 * diagnostic write would trigger fatal teardown exactly when storage fails.
 */
import * as fs from "node:fs";
import {
	restoreTerminalOutput,
	setTerminalOutputRedirectTarget,
	suppressTerminalOutput,
} from "../../src/terminal-output-guard";

const state = process.argv[2];
const note = (line: string) => fs.appendFileSync(state, `${line}\n`);

process.stdout.on("error", err => {
	note(`error-delivered=${err instanceof Error}`);
});

setTerminalOutputRedirectTarget("/dev/full");
if (suppressTerminalOutput() === null) {
	note("suppressed=false");
} else {
	note("suppressed=true");
	let ret: unknown = "unset";
	try {
		ret = process.stdout.write("unwritable-marker\n");
		note(`survived=true ret=${String(ret)}`);
	} catch (err) {
		note(`survived=false threw=${err instanceof Error}`);
	}
	// With a completion callback the error must still arrive there.
	let callbackError: unknown = "unset";
	process.stdout.write("callback-marker\n", (err?: Error | null) => {
		callbackError = err ?? null;
	});
	restoreTerminalOutput();
	await Bun.sleep(50);
	note(`callback-error=${callbackError === null ? "null" : callbackError instanceof Error}`);
}
