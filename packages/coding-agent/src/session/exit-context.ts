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
 * These are read on exit paths, signal teardown included, so reading never
 * throws and never waits on a filesystem: `pid` and `pane` need no I/O, and the
 * file reads run on a reader thread (`./exit-context-worker`) that the exiting
 * thread waits on for at most {@link EXIT_CONTEXT_IO_TIMEOUT_MS}. Sessions start
 * the thread early ({@link startExitContextReader}) so an exit does not wait for
 * it to load. A read that misses the deadline leaves `oomKills` and `intent`
 * absent; while it stays stuck, later exits skip the reads instead of waiting
 * again, and once it answers, the next exit records the intent it claimed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getExitIntentDir } from "@oh-my-pi/pi-utils/dirs";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { EXIT_CONTEXT_WORKER_ARG } from "../cli/worker-selectors";
import { writeFileAtomicallySync } from "../utils/atomic-file";
import {
	EXIT_CONTEXT_RESULT_OFFSET,
	type ExitContextIoRequest,
	type ExitContextIoResult,
} from "./exit-context-protocol";

/** Longest the exiting thread waits for the reader thread's answer. */
export const EXIT_CONTEXT_IO_TIMEOUT_MS = 1_500;

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
export interface ExitContextSources extends Omit<ExitContextIoRequest, "readIntent" | "state"> {
	pane: string | undefined;
}

const EXIT_CONTEXT_RESULT_BYTES = 1024;

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

/** The reader thread, idle between requests; `undefined` before the first start or after it died. */
let reader: Worker | undefined;

/**
 * A request that missed its deadline: its reader is still on it, and a later
 * exit takes its answer once it has one. It exists only while that reader
 * lives; a reader that dies drops it, so the next exit starts a new one.
 */
let lateRead: { worker: Worker; intentPath: string; state: SharedArrayBuffer } | undefined;

/**
 * Start the reader thread if it is not running, so a later exit only waits for
 * its file reads. Never throws; without a thread, exits record `pid` and `pane`.
 */
export function startExitContextReader(): Worker | undefined {
	if (reader) return reader;
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: [EXIT_CONTEXT_WORKER_ARG] })
			: new Worker(new URL("./exit-context-worker.ts", import.meta.url).href, { type: "module" });
		// An idle reader, or one stuck in a hung read, must not keep the process alive.
		worker.unref();
		worker.addEventListener("close", () => {
			if (reader === worker) reader = undefined;
			if (lateRead?.worker === worker) {
				// A late answer written before the thread died still counts.
				rememberIntent(lateRead.intentPath, takeAnswer(lateRead.state)?.intent);
				lateRead = undefined;
			}
		});
		reader = worker;
	} catch {
		reader = undefined;
	}
	return reader;
}

/** The answer in `state`, or `undefined` while the reader has not written one. */
function takeAnswer(state: SharedArrayBuffer): ExitContextIoResult | undefined {
	const header = new Int32Array(state, 0, 2);
	if (Atomics.load(header, 0) !== 1) return undefined;
	try {
		const bytes = new Uint8Array(state, EXIT_CONTEXT_RESULT_OFFSET, Atomics.load(header, 1));
		const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof result !== "object" || result === null) return {};
		const { oomKills, intent } = result as Record<string, unknown>;
		const answer: ExitContextIoResult = {};
		if (typeof oomKills === "number") answer.oomKills = oomKills;
		if (typeof intent === "string") answer.intent = intent;
		return answer;
	} catch {
		return {};
	}
}

function rememberIntent(intentPath: string, intent: string | undefined): void {
	if (intent !== undefined && !consumedIntents.has(intentPath)) consumedIntents.set(intentPath, intent);
}

/**
 * Read this process's exit context. Never throws, and never waits longer than
 * `timeoutMs` on the file reads; a source that is missing, unreadable or too
 * slow leaves its field absent.
 */
export function readExitContext(
	sources: ExitContextSources = defaultExitContextSources(),
	timeoutMs: number = EXIT_CONTEXT_IO_TIMEOUT_MS,
): ExitContext {
	const context: ExitContext = { pid: sources.pid };
	if (sources.pane) context.pane = sources.pane;
	const intentPath = path.join(sources.intentDir, String(sources.pid));
	const late = lateRead && takeAnswer(lateRead.state);
	if (lateRead && late === undefined) {
		// The reader is still stuck on an earlier request: record what needs no I/O.
		const consumed = consumedIntents.get(intentPath);
		if (consumed !== undefined) context.intent = consumed;
		return context;
	}
	if (lateRead) {
		rememberIntent(lateRead.intentPath, late?.intent);
		lateRead = undefined;
	}
	const worker = startExitContextReader();
	if (worker) {
		const state = new SharedArrayBuffer(EXIT_CONTEXT_RESULT_OFFSET + EXIT_CONTEXT_RESULT_BYTES);
		const request: ExitContextIoRequest = {
			pid: sources.pid,
			cgroupFile: sources.cgroupFile,
			cgroupRoot: sources.cgroupRoot,
			intentDir: sources.intentDir,
			processStartMs: sources.processStartMs,
			readIntent: !consumedIntents.has(intentPath),
			state,
		};
		try {
			worker.postMessage(request);
			Atomics.wait(new Int32Array(state, 0, 2), 0, 0, timeoutMs);
			const result = takeAnswer(state);
			if (result === undefined) {
				lateRead = { worker, intentPath, state };
			} else {
				if (result.oomKills !== undefined) context.oomKills = result.oomKills;
				rememberIntent(intentPath, result.intent);
			}
		} catch {}
	}
	const intent = consumedIntents.get(intentPath);
	if (intent !== undefined) context.intent = intent;
	return context;
}

/**
 * Leave `intent` for omp process `pid` to record at its next exit. The file
 * appears whole or not at all (written aside, then renamed over any earlier
 * word, Windows included), so the process never reads a partial word. Returns
 * the file path.
 */
export function writeExitIntent(pid: number, intent: ExitIntent, intentDir: string = getExitIntentDir()): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid pid: ${pid}`);
	fs.mkdirSync(intentDir, { recursive: true, mode: 0o700 });
	const target = path.join(intentDir, String(pid));
	writeFileAtomicallySync(target, `${intent}\n`, 0o600);
	return target;
}

/** Distribution smoke for source, npm-bundle, and compiled worker routing. */
export function smokeTestExitContextWorker(): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-exit-context-smoke-"));
	try {
		const pid = 2_147_483_000;
		writeExitIntent(pid, "stop", dir);
		const context = readExitContext(
			{
				pid,
				pane: undefined,
				cgroupFile: path.join(dir, "cgroup"),
				cgroupRoot: dir,
				intentDir: dir,
				processStartMs: 0,
			},
			// A cold start loads the reader thread first; sessions start it early.
			30_000,
		);
		if (context.intent !== "stop") throw new Error("exit context worker smoke mismatch");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
