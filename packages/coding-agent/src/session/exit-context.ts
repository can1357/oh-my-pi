/**
 * Process facts a `session_exit` entry records, so a reader can tell apart who
 * ended the process and why: a signal alone looks the same for a pane move, a
 * restart, a memory-scope stop and a closed pane.
 *
 * - `pid`: this process.
 * - `pane`: `$TMUX_PANE`, when set.
 * - `oomKills`: the `oom_kill` count in `memory.events` of this process's cgroup
 *   v2 (counts kills in the cgroup and below it, e.g. a child in the same scope).
 * - `intent`: the word a sender left in `<exit-intent dir>/<pid>` before it
 *   signalled (`omp session exit-intent <pid> <word>`).
 *
 * The reads run on exit paths, signal teardown included, so they are
 * synchronous, never throw, and are bounded: each source is one non-blocking
 * open of a regular file (a FIFO or other special file is refused, not waited
 * on) and at most {@link SOURCE_READ_LIMIT_BYTES} read. They touch the same
 * local state tree the session's own synchronous exit flush writes to.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getExitIntentDir } from "@oh-my-pi/pi-utils/dirs";

/** Most bytes read from any one source. */
const SOURCE_READ_LIMIT_BYTES = 4096;

/** Longest intent recorded; a longer word is cut to this many characters. */
export const EXIT_INTENT_MAX_CHARS = 64;

/** The intents `omp session exit-intent` writes. Readers record any word as given. */
export const EXIT_INTENTS = ["move", "restart", "stop"] as const;
export type ExitIntent = (typeof EXIT_INTENTS)[number];

/** The optional fields `session_exit.data` gains from {@link readExitContext}. */
export interface ExitContext {
	pid: number;
	pane?: string;
	oomKills?: number;
	intent?: string;
}

/** Where {@link readExitContext} reads from; tests point these at fakes. */
export interface ExitContextSources {
	pid: number;
	pane: string | undefined;
	/** `/proc/self/cgroup`: the `0::<path>` line names this process's cgroup v2. */
	cgroupFile: string;
	/** cgroup v2 mount point, `/sys/fs/cgroup`. */
	cgroupRoot: string;
	/** Directory of `<pid>` intent files. */
	intentDir: string;
	/** Epoch ms this process started; an intent file older than this was left for an earlier process with the same pid. */
	processStartMs: number;
}

/** The live sources of this process. */
export function defaultExitContextSources(): ExitContextSources {
	return {
		pid: process.pid,
		pane: process.env.TMUX_PANE,
		cgroupFile: "/proc/self/cgroup",
		cgroupRoot: "/sys/fs/cgroup",
		intentDir: getExitIntentDir(),
		processStartMs: performance.timeOrigin,
	};
}

/**
 * Intents already consumed, by file path. Every session in one process writes
 * its own `session_exit` at the same signal (a lead and its in-process
 * subagents); the first read deletes the file and the rest reuse the word.
 * Only a found word is kept, so a session that ends earlier without one does
 * not hide a word a sender leaves later.
 */
const consumedIntents = new Map<string, string>();

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

/** `oom_kill` from the `memory.events` of the cgroup v2 `cgroupFile` names, or `undefined`. */
function readOomKills(sources: ExitContextSources): number | undefined {
	const membership = readSmallFile(sources.cgroupFile)?.text;
	if (!membership) return undefined;
	const line = membership.split("\n").find(entry => entry.startsWith("0::/"));
	if (!line) return undefined;
	const eventsPath = path.join(sources.cgroupRoot, line.slice("0::".length), "memory.events");
	const events = readSmallFile(eventsPath)?.text;
	if (!events) return undefined;
	for (const entry of events.split("\n")) {
		const [key, value] = entry.split(" ");
		if (key !== "oom_kill" || value === undefined || !/^\d+$/.test(value)) continue;
		const count = Number(value);
		return Number.isSafeInteger(count) ? count : undefined;
	}
	return undefined;
}

function removeQuietly(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch {}
}

/** The word left for this process, consumed: the file is deleted after the read. */
function consumeExitIntent(sources: ExitContextSources): string | undefined {
	const filePath = path.join(sources.intentDir, String(sources.pid));
	const consumed = consumedIntents.get(filePath);
	if (consumed !== undefined) return consumed;
	const file = readSmallFile(filePath);
	if (!file) return undefined;
	removeQuietly(filePath);
	// Left for an earlier process that had this pid and died without reading it.
	if (file.mtimeMs < sources.processStartMs) return undefined;
	const word = file.text.trim().slice(0, EXIT_INTENT_MAX_CHARS);
	if (!word) return undefined;
	consumedIntents.set(filePath, word);
	return word;
}

/** Read this process's exit context. Never throws; an unreadable source leaves its field absent. */
export function readExitContext(sources: ExitContextSources = defaultExitContextSources()): ExitContext {
	const context: ExitContext = { pid: sources.pid };
	if (sources.pane) context.pane = sources.pane;
	const oomKills = readOomKills(sources);
	if (oomKills !== undefined) context.oomKills = oomKills;
	const intent = consumeExitIntent(sources);
	if (intent !== undefined) context.intent = intent;
	return context;
}

/**
 * Leave `intent` for omp process `pid` to record at its next exit. The file
 * appears whole or not at all (written aside, then renamed), so the process
 * never reads a partial word. Returns the file path.
 */
export function writeExitIntent(pid: number, intent: ExitIntent, intentDir: string = getExitIntentDir()): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid pid: ${pid}`);
	fs.mkdirSync(intentDir, { recursive: true, mode: 0o700 });
	const target = path.join(intentDir, String(pid));
	const staging = path.join(intentDir, `.${pid}.${process.pid}.${crypto.randomUUID()}.tmp`);
	try {
		fs.writeFileSync(staging, `${intent}\n`, { mode: 0o600, flag: "wx" });
		fs.renameSync(staging, target);
	} catch (error) {
		removeQuietly(staging);
		throw error;
	}
	return target;
}
