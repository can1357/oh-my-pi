/**
 * Reader thread of `readExitContext` (`./exit-context`): does every filesystem
 * read the `session_exit` entry's optional fields need, so a slow or hung
 * filesystem stalls this thread and never the exiting main thread, which waits
 * a bounded time for the answer and goes on without it.
 *
 * The thread starts with the first session and idles until a request comes, so
 * an exit does not wait for it to load. Each request carries a
 * `SharedArrayBuffer`: the answer is JSON in its bytes after the header, then
 * header word 1 gets its length and word 0 is set to 1 and notified. The intent
 * is taken by the claim protocol in `./exit-context-claim`, which this thread
 * runs against the real filesystem and the process's board
 * (`./exit-context-protocol`), so sessions on every thread record the word.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import {
	claimedCopyPath,
	claimedCopyPrefix,
	type ExitContextClaimEffect,
	type ExitContextClaimOutcome,
	type ExitContextFile,
	runExitIntentClaim,
} from "./exit-context-claim";
import {
	EXIT_CONTEXT_IO_TIMEOUT_MS,
	EXIT_CONTEXT_RESULT_OFFSET,
	type ExitContextIoRequest,
	type ExitContextIoResult,
	recordExitIntent,
	recordedExitIntent,
} from "./exit-context-protocol";

/** Most bytes read from any one source. */
const SOURCE_READ_LIMIT_BYTES = 4096;

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;

/** A regular file's first {@link SOURCE_READ_LIMIT_BYTES}, or `undefined` when it is missing, unreadable or not a regular file. */
function readSmallFile(filePath: string): ExitContextFile | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, OPEN_FLAGS);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return undefined;
		const buffer = Buffer.allocUnsafe(SOURCE_READ_LIMIT_BYTES);
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		return { text: buffer.toString("utf8", 0, length), mtimeMs: stat.mtimeMs };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

/** `oom_kill` from the `memory.events` of the cgroup v2 that `cgroupFile` names. */
function readOomKills(request: ExitContextIoRequest): number | undefined {
	const membership = readSmallFile(request.cgroupFile)?.text;
	if (!membership) return undefined;
	const line = membership.split("\n").find(entry => entry.startsWith("0::/"));
	if (!line) return undefined;
	const events = readSmallFile(path.join(request.cgroupRoot, line.slice("0::".length), "memory.events"))?.text;
	if (!events) return undefined;
	for (const entry of events.split("\n")) {
		const [key, value] = entry.split(" ");
		if (key !== "oom_kill" || value === undefined || !/^\d+$/.test(value)) continue;
		const count = Number(value);
		return Number.isSafeInteger(count) ? count : undefined;
	}
	return undefined;
}

/**
 * Take the intent file by renaming it to `claimedPath`. The rename takes
 * exactly the file this pass sees: a sender that publishes a new word at the
 * path meanwhile keeps it for the next read, where an unlink of the path would
 * delete it unread. False when there is no regular file to take.
 */
function takeIntentFile(intentPath: string, claimedPath: string): boolean {
	try {
		if (!fs.lstatSync(intentPath).isFile()) return false;
		fs.renameSync(intentPath, claimedPath);
		return true;
	} catch {
		return false;
	}
}

/** Every claimed copy of `pid` in `intentDir`: this pass's, a dead reader's, a dead process's. */
function listClaimedCopies(intentDir: string, pid: number): string[] {
	const prefix = claimedCopyPrefix(pid);
	try {
		return fs
			.readdirSync(intentDir)
			.filter(name => name.startsWith(prefix))
			.map(name => path.join(intentDir, name));
	} catch {
		return [];
	}
}

/** One step of the claim, against the real filesystem and the process's board. */
function performClaimEffect(
	request: ExitContextIoRequest,
	boardDeadline: number,
	effect: ExitContextClaimEffect,
): ExitContextClaimOutcome {
	// The board's lock is held only for memory work; a reader that waits past
	// this answers for its own thread instead of holding up the exit.
	const boardTimeout = boardDeadline - performance.now();
	switch (effect.kind) {
		case "recorded":
			return { kind: "recorded", word: recordedExitIntent(request.board, boardTimeout, effect.intentPath) };
		case "take":
			return { kind: "take", taken: takeIntentFile(effect.intentPath, effect.claimedPath) };
		case "list":
			return { kind: "list", claimedPaths: listClaimedCopies(request.intentDir, request.pid) };
		case "read":
			return { kind: "read", file: readSmallFile(effect.claimedPath) };
		case "record":
			return {
				kind: "record",
				word: recordExitIntent(request.board, boardTimeout, effect.intentPath, effect.word),
			};
		case "remove":
			try {
				fs.unlinkSync(effect.claimedPath);
			} catch {}
			return { kind: "remove" };
	}
}

function answer(request: ExitContextIoRequest): void {
	const result: ExitContextIoResult = {};
	const oomKills = readOomKills(request);
	if (oomKills !== undefined) result.oomKills = oomKills;
	const boardDeadline = performance.now() + EXIT_CONTEXT_IO_TIMEOUT_MS;
	const intent = runExitIntentClaim(
		{
			intentPath: path.join(request.intentDir, String(request.pid)),
			claimedPath: claimedCopyPath(request.intentDir, request.pid),
			processStartMs: request.processStartMs,
		},
		effect => performClaimEffect(request, boardDeadline, effect),
	);
	if (intent !== undefined) result.intent = intent;
	const encoded = new TextEncoder().encode(JSON.stringify(result));
	const header = new Int32Array(request.state, 0, 2);
	const bytes = new Uint8Array(request.state, EXIT_CONTEXT_RESULT_OFFSET);
	// The answer is a few dozen bytes; an oversized one would be cut and fail to parse, leaving every field absent.
	const length = Math.min(encoded.length, bytes.length);
	bytes.set(encoded.subarray(0, length));
	Atomics.store(header, 1, length);
	Atomics.store(header, 0, 1);
	Atomics.notify(header, 0);
}

const handle = (message: unknown): void => {
	answer(message as ExitContextIoRequest);
};

if (!parentPort) throw new Error("exit-context-worker: missing parentPort");
const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else parentPort.on("message", handle);
