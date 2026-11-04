/**
 * A process for session-exit-context.test.ts whose exit-context reader dies in
 * the middle of claiming an intent, once for each word it is given. The test
 * runs it under strace, which holds the reader thread in one call of the claim
 * (the rename that takes the file, or the unlink of the claimed copy).
 *
 * For each word, this process leaves that word for itself, starts an exit read
 * that does not wait, and terminates the reader once it has taken the file.
 * Then it reads once more and prints one JSON line: `{ claimed, afterDeath,
 * files }`, where `claimed` is every copy a dead reader left, `afterDeath` is
 * what the next exit records, and `files` is what is left in the directory.
 *
 * Usage: <intent dir> <word>...
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExitContextSources,
	readExitContext,
	startExitContextReader,
} from "@oh-my-pi/pi-coding-agent/session/exit-context";

const [dir, ...words] = process.argv.slice(2);
if (!dir || words.length === 0) throw new Error("usage: <intent dir> <word>...");
const sources: ExitContextSources = {
	pid: process.pid,
	pane: undefined,
	cgroupFile: path.join(dir, "no-cgroup"),
	cgroupRoot: dir,
	intentDir: dir,
	processStartMs: 0,
};

const claimed: string[] = [];
for (const word of words) {
	// A plain write, not `writeExitIntent`: strace holds renames, and this thread's must not be one of them.
	fs.writeFileSync(path.join(dir, String(process.pid)), `${word}\n`);
	const reader = startExitContextReader();
	if (!reader) throw new Error("no reader thread");
	const closed = Promise.withResolvers<void>();
	reader.addEventListener("close", () => closed.resolve());
	// Do not wait: the reader goes on with the claim on its own thread.
	readExitContext(sources, 0);
	const deadline = Date.now() + 30_000;
	let copies: string[] = [];
	while ((copies = fs.readdirSync(dir).filter(name => name.includes(".claimed-"))).length <= claimed.length) {
		if (Date.now() > deadline) throw new Error(`the reader never took the file: ${fs.readdirSync(dir)}`);
		await Bun.sleep(5);
	}
	reader.terminate();
	await closed.promise;
	claimed.push(...copies.filter(name => !claimed.includes(name)));
}

const afterDeath = readExitContext(sources, 30_000);
process.stdout.write(`${JSON.stringify({ claimed, afterDeath, files: fs.readdirSync(dir) })}\n`);
process.exit(0);
