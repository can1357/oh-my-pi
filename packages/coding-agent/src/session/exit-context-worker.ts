/**
 * Reader thread of `readExitContext` (`./exit-context`): does every filesystem
 * read the `session_exit` entry's optional fields need, so a slow or hung
 * filesystem stalls this thread and never the exiting main thread, which waits
 * a bounded time for the answer and goes on without it.
 *
 * The thread starts with the first session and idles until a request comes, so
 * an exit does not wait for it to load. Each request carries a
 * `SharedArrayBuffer`: the answer is JSON in its bytes after the header, then
 * header word 1 gets its length and word 0 is set to 1 and notified. A word
 * the reader claims goes on the process's board (`./exit-context-protocol`),
 * so sessions on every thread of the process record it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import {
	EXIT_CONTEXT_IO_TIMEOUT_MS,
	EXIT_CONTEXT_RESULT_OFFSET,
	EXIT_INTENT_MAX_CHARS,
	type ExitContextIoRequest,
	type ExitContextIoResult,
	updateExitContextBoard,
	waitForExitContextBoardChange,
} from "./exit-context-protocol";

/** Most bytes read from any one source. */
const SOURCE_READ_LIMIT_BYTES = 4096;

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;

interface SmallFile {
	text: string;
	mtimeMs: number;
}

/** A regular file's first {@link SOURCE_READ_LIMIT_BYTES}, or `undefined` when it is missing, unreadable or not a regular file. */
function readSmallFile(filePath: string): SmallFile | undefined {
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
 * Claim `<intentDir>/<pid>` by renaming it aside, then read and delete the
 * claimed file. The rename takes exactly the file this read sees: a sender that
 * publishes a new word at the path meanwhile keeps it for the next read, where
 * an unlink of the path would delete it unread.
 */
function claimExitIntent(request: ExitContextIoRequest): string | undefined {
	const filePath = path.join(request.intentDir, String(request.pid));
	const claimed = path.join(request.intentDir, `.${request.pid}.claimed-${process.pid}-${crypto.randomUUID()}`);
	try {
		if (!fs.lstatSync(filePath).isFile()) return undefined;
		fs.renameSync(filePath, claimed);
	} catch {
		return undefined;
	}
	const file = readSmallFile(claimed);
	try {
		fs.unlinkSync(claimed);
	} catch {}
	// Left for an earlier process that had this pid and died without reading it.
	if (!file || file.mtimeMs < request.processStartMs) return undefined;
	const word = file.text.trim().slice(0, EXIT_INTENT_MAX_CHARS);
	return word || undefined;
}

/**
 * The process's word from `<intentDir>/<pid>`, claimed once for every thread of
 * the process. A word on the board is returned without touching the file. A
 * claim another reader has in progress is waited for, and taken over once it is
 * older than {@link EXIT_CONTEXT_IO_TIMEOUT_MS} (its reader may have died with
 * its thread). Only a found word goes on the board, so a later word stays
 * claimable. Without the board's lock, the file is claimed for this thread alone.
 */
function claimProcessIntent(request: ExitContextIoRequest): string | undefined {
	const filePath = path.join(request.intentDir, String(request.pid));
	const token = crypto.randomUUID();
	for (;;) {
		const step = updateExitContextBoard(request.board, EXIT_CONTEXT_IO_TIMEOUT_MS, filePath, (state, change) => {
			const word = state.words[filePath];
			if (word !== undefined) return { word };
			const claim = state.claims[filePath];
			const age = claim ? Date.now() - claim.since : Number.POSITIVE_INFINITY;
			if (age < EXIT_CONTEXT_IO_TIMEOUT_MS) return { change, waitMs: EXIT_CONTEXT_IO_TIMEOUT_MS - age };
			state.claims[filePath] = { token, since: Date.now() };
			return undefined;
		});
		if (!step) return claimExitIntent(request);
		if (step.value === undefined) break;
		if ("word" in step.value) return step.value.word;
		waitForExitContextBoardChange(request.board, step.value.change, step.value.waitMs);
	}
	const claimed = claimExitIntent(request);
	const shared = updateExitContextBoard(request.board, EXIT_CONTEXT_IO_TIMEOUT_MS, filePath, state => {
		if (state.claims[filePath]?.token === token) delete state.claims[filePath];
		if (claimed !== undefined && state.words[filePath] === undefined) state.words[filePath] = claimed;
		return state.words[filePath];
	});
	return shared?.value ?? claimed;
}

function answer(request: ExitContextIoRequest): void {
	const result: ExitContextIoResult = {};
	const oomKills = readOomKills(request);
	if (oomKills !== undefined) result.oomKills = oomKills;
	if (request.readIntent) {
		const intent = claimProcessIntent(request);
		if (intent !== undefined) result.intent = intent;
	}
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
