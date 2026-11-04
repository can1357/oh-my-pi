/**
 * A process for session-exit-context.test.ts whose exit-context reader dies in
 * the middle of claiming an intent. The test runs it under strace, which holds
 * the reader thread in one call of the claim (the rename that takes the file,
 * or the unlink of the claimed copy). This process leaves a word for itself,
 * starts an exit read that does not wait, terminates the reader once the file
 * has been taken, waits past the claim's lease, and prints one JSON line:
 * `{ claimed, afterDeath, files }`, where `afterDeath` is what the next exit
 * records and `files` is what is left in the intent directory.
 *
 * Usage: <intent dir>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExitContextSources,
	readExitContext,
	startExitContextReader,
} from "@oh-my-pi/pi-coding-agent/session/exit-context";
import { EXIT_CONTEXT_IO_TIMEOUT_MS } from "@oh-my-pi/pi-coding-agent/session/exit-context-protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: <intent dir>");
const sources: ExitContextSources = {
	pid: process.pid,
	pane: undefined,
	cgroupFile: path.join(dir, "no-cgroup"),
	cgroupRoot: dir,
	intentDir: dir,
	processStartMs: 0,
};
// A plain write, not `writeExitIntent`: strace holds each thread's first rename, and this thread's must not be it.
fs.writeFileSync(path.join(dir, String(process.pid)), "restart\n");

const reader = startExitContextReader();
if (!reader) throw new Error("no reader thread");
const closed = Promise.withResolvers<void>();
reader.addEventListener("close", () => closed.resolve());

// Do not wait: the reader goes on with the claim on its own thread.
readExitContext(sources, 0);
const deadline = Date.now() + 30_000;
let claimed: string[] = [];
while ((claimed = fs.readdirSync(dir).filter(name => name.includes(".claimed-"))).length === 0) {
	if (Date.now() > deadline) throw new Error(`the reader never took the file: ${fs.readdirSync(dir)}`);
	await Bun.sleep(5);
}
reader.terminate();
await closed.promise;
// The claim's lease is wall-clock time by design: wait it out for real.
await Bun.sleep(EXIT_CONTEXT_IO_TIMEOUT_MS + 300);
const afterDeath = readExitContext(sources, 30_000);
process.stdout.write(`${JSON.stringify({ claimed, afterDeath, files: fs.readdirSync(dir) })}\n`);
process.exit(0);
