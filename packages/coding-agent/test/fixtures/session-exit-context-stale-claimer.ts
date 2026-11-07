/**
 * A process for session-exit-context.test.ts whose main-thread reader is held
 * on its way into the rename that takes the intent file — long enough that an
 * earlier design declared it dead and took its claim over. While it is held, a
 * session on another thread takes the file and records the word, and the sender
 * publishes a new one. The word the held reader finally takes must be recorded
 * or left on disk, never deleted unread.
 *
 * strace delays the first rename of each thread it traces, so every thread that
 * must not be held renames something of its own first: this one directly, and
 * the other session's reader through a warm-up read of a word left for pid 1.
 *
 * Prints one JSON line: `{ recovered, fresh, afterWake, freshAfterWake, files }`.
 *
 * Usage: <intent dir>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExitContext } from "@oh-my-pi/pi-coding-agent/session/exit-context";
import {
	type ExitContextSources,
	readExitContext,
	startExitContextReader,
	writeExitIntent,
} from "@oh-my-pi/pi-coding-agent/session/exit-context";
import type { ExitContextThreadRequest } from "./session-exit-context-thread";

const dir = process.argv[2];
if (!dir) throw new Error("usage: <intent dir>");
const intentPath = path.join(dir, String(process.pid));
const sources: ExitContextSources = {
	pid: process.pid,
	pane: undefined,
	cgroupFile: path.join(dir, "no-cgroup"),
	cgroupRoot: dir,
	intentDir: dir,
	processStartMs: 0,
};

// This thread's own delayed rename, spent on a file nothing else looks at, so
// the sender's publish below is not the one strace holds.
fs.writeFileSync(path.join(dir, "warm"), "warm\n");
fs.renameSync(path.join(dir, "warm"), path.join(dir, "warm-done"));
fs.unlinkSync(path.join(dir, "warm-done"));

// One read with no word to take: the reader thread is loaded and idle, and its
// delayed rename is still to come.
if (!startExitContextReader()) throw new Error("no reader thread");
readExitContext({ ...sources, pid: 1 }, 30_000);

// A session on another thread, as a worker-thread subagent has.
const thread = new Worker(new URL("./session-exit-context-thread.ts", import.meta.url).href, { type: "module" });
const inbox: unknown[] = [];
const waiters: ((message: unknown) => void)[] = [];
thread.addEventListener("message", event => {
	const waiter = waiters.shift();
	if (waiter) waiter(event.data);
	else inbox.push(event.data);
});
const next = (): Promise<unknown> => {
	const waiting = inbox.shift();
	if (waiting !== undefined) return Promise.resolve(waiting);
	const { promise, resolve } = Promise.withResolvers<unknown>();
	waiters.push(resolve);
	return promise;
};
await next();
// Its reader spends its delayed rename on a word left for pid 1, so it takes
// this process's word at once below.
fs.writeFileSync(path.join(dir, "1"), "warm\n");
thread.postMessage({ sources: { ...sources, pid: 1 } } satisfies ExitContextThreadRequest);
await next();

// A plain write, not `writeExitIntent`: the word must be there before the reader's rename.
fs.writeFileSync(intentPath, "restart\n");
// Do not wait: the reader is held on its way into the rename that takes the file.
readExitContext(sources, 0);
await Bun.sleep(1_000);

thread.postMessage({ sources } satisfies ExitContextThreadRequest);
const recovered = (await next()) as ExitContext;

// The sender publishes a new word while the first reader is still inside its rename.
writeExitIntent(process.pid, "stop", dir);
const fresh = fs.readFileSync(intentPath, "utf8");
// Past the hold: the first reader wakes and finishes the pass it started.
await Bun.sleep(7_000);
const afterWake = readExitContext(sources, 30_000);
const freshAfterWake = fs.existsSync(intentPath) ? fs.readFileSync(intentPath, "utf8") : null;
process.stdout.write(
	`${JSON.stringify({ recovered, fresh, afterWake, freshAfterWake, files: fs.readdirSync(dir) })}\n`,
);
thread.terminate();
process.exit(0);
