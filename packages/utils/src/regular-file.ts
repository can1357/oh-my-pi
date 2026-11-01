/**
 * Reading a file that a user, or any other process, can put something else at:
 * the `.env` and settings files every command reads, and the config files a
 * session reads when it starts.
 *
 * Anything can stand at such a name, directly or through a link: a FIFO, a
 * socket, a device, a directory. Reading one is not safe. A FIFO with no
 * writer, or a device nobody drives, waits for ever; a FIFO that is being
 * written to hands over bytes that were meant for someone else, and once read
 * they are gone from it. An open with `O_NONBLOCK` alone does not make it
 * safe: the open returns at once, and the read after it reads the FIFO like
 * any stream. So every open here is non-blocking, and the descriptor's own
 * `fstat` — not a look at the name, which can change after it — decides
 * whether what was opened is a regular file before a byte is read. Anything
 * else throws {@link NotARegularFile}, which the caller reports or turns into
 * its own error; nothing is skipped without a decision at the call.
 *
 * The one exception is a file that a tool serves through a pipe on purpose:
 * 1Password mounts `.env` files that way. {@link readRegularFileOrPipeTextSync}
 * reads such a pipe, but only to its end within a bound.
 *
 * `env.ts` imports this module at the very start of every command, before the
 * logger exists, so it depends on nothing but `fs-error`.
 */
import * as fs from "node:fs/promises";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync, type Stats } from "node:fs";
import { isEnoent } from "./fs-error";

/** What a name stands for when it is not a regular file, in a reader's words: "a FIFO", "a socket", "a device". */
function kindOf(stat: Stats): string {
	if (stat.isDirectory()) return "a directory";
	if (stat.isFIFO()) return "a FIFO";
	if (stat.isSocket()) return "a socket";
	if (stat.isCharacterDevice() || stat.isBlockDevice()) return "a device";
	return "a special file";
}

/**
 * A name that stands, itself or through a link, for something other than a
 * regular file — and so was not read. The message names the file, why it was
 * not read and what to do, so a caller can show it as it is.
 */
export class NotARegularFile extends Error {
	constructor(
		readonly file: string,
		readonly kind: string,
	) {
		super(
			`omp did not read ${file}: it is ${kind}, not a regular file, and reading it would wait on it or take ` +
				`what is written to it. Move it aside, or put a regular file there, to use it.`,
		);
		this.name = "NotARegularFile";
	}
}

/**
 * Read-only, never waiting on a FIFO or a device before the check, and never
 * making a terminal the process's controlling one. Windows has neither flag,
 * and no FIFO at a path.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);

/** An open that failed with ENXIO met a socket, or a device nobody drives: something is there, and it is no regular file. */
function refusedOpen(file: string, error: unknown): never {
	if (error instanceof Error && "code" in error && error.code === "ENXIO") {
		throw new NotARegularFile(file, "a socket or a device");
	}
	throw error;
}

/**
 * A descriptor on `file` only when what it opens is a regular file: undefined
 * when nothing is at the name, {@link NotARegularFile} when anything else is,
 * and any other error as it came. Links are followed; what they lead to is
 * judged.
 */
export async function openRegularFile(file: string): Promise<fs.FileHandle | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, OPEN_FLAGS);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		refusedOpen(file, error);
	}
	let stat: Stats;
	try {
		stat = await handle.stat();
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
	if (stat.isFile()) return handle;
	await handle.close().catch(() => undefined);
	throw new NotARegularFile(file, kindOf(stat));
}

/** {@link openRegularFile} for a caller that cannot wait: a descriptor number, which the caller closes. */
export function openRegularFileSync(file: string): number | undefined {
	let fd: number;
	try {
		fd = openSync(file, OPEN_FLAGS);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		refusedOpen(file, error);
	}
	let stat: Stats;
	try {
		stat = fstatSync(fd);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	if (stat.isFile()) return fd;
	closeSync(fd);
	throw new NotARegularFile(file, kindOf(stat));
}

/**
 * The text of the regular file at `file`, read through the one descriptor
 * {@link openRegularFile} judged: undefined when nothing is there,
 * {@link NotARegularFile} when anything else is.
 */
export async function readRegularFileText(file: string): Promise<string | undefined> {
	const handle = await openRegularFile(file);
	if (!handle) return undefined;
	try {
		return await handle.readFile("utf8");
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** {@link readRegularFileText} for a caller that cannot wait. */
export function readRegularFileTextSync(file: string): string | undefined {
	const fd = openRegularFileSync(file);
	if (fd === undefined) return undefined;
	try {
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * The text of an optional file a command can go on without: undefined when
 * nothing is there, and undefined — reported once through
 * {@link reportSkippedFile} — when something other than a regular file is.
 * Any other failure throws.
 */
export async function readOptionalFileText(file: string): Promise<string | undefined> {
	try {
		return await readRegularFileText(file);
	} catch (error) {
		if (!(error instanceof NotARegularFile)) throw error;
		reportSkippedFile(error);
		return undefined;
	}
}

/** {@link readOptionalFileText} for a caller that cannot wait. */
export function readOptionalFileTextSync(file: string): string | undefined {
	try {
		return readRegularFileTextSync(file);
	} catch (error) {
		if (!(error instanceof NotARegularFile)) throw error;
		reportSkippedFile(error);
		return undefined;
	}
}

/**
 * A named pipe that was not written to its end in the time allowed. `started`
 * tells whether a writer sent any of it; what it sent is not used, because half
 * a file is not the file.
 */
export class PipeNotAnswered extends Error {
	constructor(
		readonly file: string,
		readonly started: boolean,
	) {
		super(
			`${file} is a named pipe, and ${started ? "what was writing it stopped before the end" : "nothing wrote to it"}`,
		);
		this.name = "PipeNotAnswered";
	}
}

/** How often a wait for a pipe's writer looks again. */
const PIPE_POLL_MS = 10;

/** Signals a person or a supervisor sends to stop a process. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Take the stop-signal listeners off for a synchronous wait, and return what
 * puts them back. No listener can run while the wait blocks the event loop, so a
 * signal that has one only queues until the wait ends; with none, the signal's
 * own action ends the process at once. So Ctrl-C stops the wait when it is pressed.
 */
function detachStopListeners(): () => void {
	const taken = STOP_SIGNALS.map(signal => ({ signal, listeners: process.rawListeners(signal) }));
	for (const { signal, listeners } of taken) {
		for (const listener of listeners) process.removeListener(signal, listener as NodeJS.SignalsListener);
	}
	return () => {
		for (const { signal, listeners } of taken) {
			for (const listener of listeners) process.on(signal, listener as NodeJS.SignalsListener);
		}
	};
}

/**
 * The text of `file` when it is a regular file, or when it is a named pipe
 * that a writer fills to its end within `pipe.deadlineMs` of the open — for a
 * file that a tool serves through a pipe on purpose (1Password mounts `.env`
 * files that way). `pipe.onWait` runs once when the pipe has not reached its
 * end after `pipe.noticeAfterMs`, told whether any of it has come. Undefined when nothing is at the name;
 * {@link NotARegularFile} for a socket, device or directory;
 * {@link PipeNotAnswered} when the pipe does not reach its end in time.
 *
 * The wait polls with `Bun.sleepSync`, so nothing else on the event loop runs
 * during it, timers and signal listeners included. For the wait, SIGINT and
 * SIGTERM listeners are taken off, so either signal ends the process at once.
 */
export function readRegularFileOrPipeTextSync(
	file: string,
	pipe: { deadlineMs: number; noticeAfterMs: number; onWait(started: boolean): void },
): string | undefined {
	let fd: number;
	try {
		fd = openSync(file, OPEN_FLAGS);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		refusedOpen(file, error);
	}
	let reattachStopListeners: (() => void) | undefined;
	try {
		const stat = fstatSync(fd);
		if (stat.isFile()) return readFileSync(fd, "utf8");
		if (!stat.isFIFO()) throw new NotARegularFile(file, kindOf(stat));
		const opened = Date.now();
		const buffer = Buffer.alloc(64 * 1024);
		const chunks: Buffer[] = [];
		let noticed = false;
		for (;;) {
			let n: number;
			try {
				n = readSync(fd, buffer, 0, buffer.length, null);
			} catch (error) {
				// A writer holds the pipe open and has nothing more yet.
				if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
				n = -1;
			}
			if (n > 0) {
				chunks.push(Buffer.from(buffer.subarray(0, n)));
				continue;
			}
			// End of file after the writer's bytes: the whole file. End of file
			// before any byte is a writer that has not come yet.
			if (n === 0 && chunks.length > 0) return Buffer.concat(chunks).toString("utf8");
			const waited = Date.now() - opened;
			if (waited >= pipe.deadlineMs) throw new PipeNotAnswered(file, chunks.length > 0);
			if (!noticed && waited >= pipe.noticeAfterMs) {
				noticed = true;
				pipe.onWait(chunks.length > 0);
			}
			reattachStopListeners ??= detachStopListeners();
			Bun.sleepSync(PIPE_POLL_MS);
		}
	} finally {
		reattachStopListeners?.();
		closeSync(fd);
	}
}

/** The error a read by name gave when nothing was at `file`, for a reader that opened it through {@link openRegularFile}. */
export function absentFile(file: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", path: file });
}

/** Where notes about files omp did not read go: standard error until a UI that owns the terminal takes them. */
let fileNoteSink = (note: string): void => {
	process.stderr.write(`${note}\n`);
};

const reportedSkips = new Map<string, string>();

/**
 * Report that an optional file was not read, once per file per process,
 * through the current sink. `skip.message` names the file, why it was not
 * read and what to do; the command goes on without the file.
 */
export function reportSkippedFile(skip: { readonly file: string; readonly message: string }): void {
	if (reportedSkips.has(skip.file)) return;
	reportedSkips.set(skip.file, skip.message);
	fileNoteSink(skip.message);
}

/**
 * Say now that omp is waiting on a file. Not kept for
 * {@link routeSkippedFileNotes}: by the time a UI takes the notes, the wait is over.
 */
export function reportFileWait(note: string): void {
	fileNoteSink(note);
}

/**
 * Send later notes about files not read to `sink` instead of standard error,
 * and return the notes already reported. An interactive UI calls this before it
 * takes the terminal, which clears what was written to it, and shows both.
 */
export function routeSkippedFileNotes(sink: (note: string) => void): string[] {
	fileNoteSink = sink;
	return [...reportedSkips.values()];
}
