/**
 * Centralized logger for omp.
 *
 * Default: rotating `~/.omp/logs/omp.<DATE>.<PID>.log`, no console output (writing
 * to stdout/stderr would corrupt the TUI). Long-running headless services
 * (the auth broker, etc.) call {@link setTransports} to swap in a console
 * transport so a process supervisor (pm2, journald, k8s) captures the logs.
 *
 * Each entry includes `process.pid` so concurrent omp instances stay
 * traceable, and the fields of the enclosing {@link withContext} (a session's
 * `sessionId`) so sessions sharing one process stay apart. The file is created
 * on the first record written. Records are batched — one write per second or
 * per 64 KiB — while `warn`/`error` records are written at once together with
 * everything buffered before them; exit, fatal, and signal paths flush the
 * rest. `OMP_LOG_LEVEL` optionally limits the levels written to the file and
 * the console (default: all).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPromise } from "node:util/types";
import { getLogsDir, localDay } from "./dirs";
import { RotatingFileSink } from "./logger/rotating-file";
import { isPidAlive } from "./pid";
import { setStderrRedirectTarget } from "./stderr-guard";
import { drainModuleLoadEvents, type ModuleLoadEvent, stopModuleLoadTiming, timingModeIncludes } from "./timing-buffer";
import { isRecord } from "./type-guards";
/** Severity names accepted by the centralized logger. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** Structured log event forwarded to out-of-band sinks such as OpenTelemetry. */
export interface LogEvent {
	readonly level: LogLevel;
	readonly message: string;
	readonly context: Record<string, unknown> | undefined;
	readonly timestamp: Date;
}

/** Receives each structured log event after the local transport path runs. */
export type LogSink = (event: LogEvent) => void;

/**
 * Destination that takes this thread's log records in place of its own
 * transports and sinks (a worker thread routing records to the main thread's
 * logger); see {@link setLogForwarder}.
 */
export interface LogForwarder {
	/**
	 * Take one record. Its context is already merged over the enclosing
	 * {@link withContext} fields and reduced to plain JSON data, so it survives
	 * a structured clone; `timestamp` is when the record was logged.
	 */
	emit(event: LogEvent): void;
	/** Write every record emitted so far on the receiving side; backs {@link flush}. */
	flush(): void;
}

const logSinks = new Set<LogSink>();

/** Set by {@link setLogForwarder}: records go there instead of to local transports and sinks. */
let logForwarder: LogForwarder | undefined;

/**
 * Route every later record logged on this thread to `forwarder` instead of the
 * local transports and sinks, which then stay unused (no log file is opened);
 * {@link flush} asks the forwarder to flush. `undefined` restores local logging.
 * For worker threads, whose main thread owns the process log file.
 */
export function setLogForwarder(forwarder: LogForwarder | undefined): void {
	logForwarder = forwarder;
}

/**
 * Log a record another thread forwarded (see {@link setLogForwarder}): written
 * to the local transports with its own timestamp, then handed to the sinks. Its
 * context is taken as is; the caller's enclosing {@link withContext} is not
 * merged in. On a thread that forwards itself, the record is forwarded on.
 */
export function emitForeign(event: LogEvent): void {
	const forwarder = logForwarder;
	if (forwarder) {
		try {
			forwarder.emit(event);
		} catch {
			// Forwarding is as best-effort as local writes.
		}
		return;
	}
	try {
		emitLocally(event.level, event.message, event.context, event.timestamp);
	} catch {
		// Silently ignore logging failures
	}
	dispatchToSinks(event);
}

/** Forward one record logged on this thread; never throws. */
function forwardRecord(
	forwarder: LogForwarder,
	level: LogLevel,
	message: string,
	context: Record<string, unknown> | undefined,
): void {
	try {
		forwarder.emit({ level, message, context: forwardableContext(context), timestamp: new Date() });
	} catch {
		// Forwarding is as best-effort as local writes.
	}
}

/**
 * The call's context merged over the enclosing {@link withContext} fields (call
 * fields win, as for sinks), as plain JSON data: errors become
 * `{ name, message, stack, … }` exactly as in the log file. A context that
 * cannot be serialized (a cycle, a bigint) is dropped from the record.
 */
function forwardableContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	// An Error passed as the context carries its fields as non-enumerable properties.
	let merged = context instanceof Error ? errorToRecord(context) : context;
	const scoped = logContextStorage.getStore();
	if (scoped) {
		try {
			merged = { ...scoped, ...merged };
		} catch {
			// A throwing getter must not turn a log call into a failure; keep the call's own fields.
		}
	}
	if (merged === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(
			mayContainError(merged) ? JSON.stringify(merged, jsonReplacer) : JSON.stringify(merged),
		);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Register an out-of-band log sink and return a disposer. */
export function registerLogSink(sink: LogSink): () => void {
	logSinks.add(sink);
	return () => {
		logSinks.delete(sink);
	};
}

function emitToSinks(level: LogLevel, message: string, context: Record<string, unknown> | undefined): void {
	if (logSinks.size === 0) return;
	// The enclosing {@link withContext} fields reach sinks as they reach the file;
	// call-site fields win, and a record outside any context keeps its own object.
	const scoped = logContextStorage.getStore();
	let merged = context;
	if (scoped) {
		try {
			merged = { ...scoped, ...context };
		} catch {
			// A throwing getter must not turn a log call into a failure; sinks get the call's own fields.
		}
	}
	dispatchToSinks({ level, message, context: merged, timestamp: new Date() });
}

function dispatchToSinks(event: LogEvent): void {
	if (logSinks.size === 0) return;
	for (const sink of logSinks) {
		try {
			sink(event);
		} catch {
			// Sinks are side channels; they must never break local logging.
		}
	}
}

const PROCESS_LOG_PATTERN = /^omp\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log(?:\.(\d+))?$/;
/** Per-process audit files written by earlier releases; current sinks track rotations in memory. */
const PROCESS_AUDIT_PATTERN = /^\.omp\.(\d+)-audit\.json$/;
/** Shared daily logs (plain, size-rolled, or gzipped) written by the winston-era logger. */
const LEGACY_LOG_PATTERN = /^omp\.(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?(?:\.gz)?$/;
/** Hash-named audit files written by winston-daily-rotate-file. */
const LEGACY_AUDIT_PATTERN = /^\.[0-9a-f]{8,}-audit\.json$/;
const RETAINED_STALE_LOGS_PER_PROCESS_DAY = 1;
const RETAINED_STALE_LOG_DAYS = 5;

/**
 * Retain one newest completed-process log per process/day within the current
 * and previous four local calendar days, remove completed-process audit files
 * left by earlier releases, and age out legacy shared daily logs and their
 * hash-named audits past the same window. Live PID namespaces are never
 * touched. The calendar-day boundary preserves daily diagnostic coverage while
 * bounding completed-process storage and scans.
 */
async function pruneStaleProcessLogs(dir: string): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const current = new Date();
	const currentDate = localDay(current);
	const cutoff = new Date(current);
	cutoff.setDate(cutoff.getDate() - (RETAINED_STALE_LOG_DAYS - 1));
	const cutoffDate = localDay(cutoff);
	cutoff.setHours(0, 0, 0, 0);
	const cutoffMs = cutoff.getTime();

	// A lone in-window log survives regardless of PID liveness. Only probe a PID or
	// stat its files when there is something we might actually delete.
	const logsByProcessDay = new Map<string, string | string[]>();
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const name = entry.name;
		const log = PROCESS_LOG_PATTERN.exec(name);
		if (log) {
			const day = log[1]!;
			if (day < cutoffDate || day > currentDate) {
				if (!isPidAlive(Number(log[2]))) await removeBestEffort(path.join(dir, name));
				continue;
			}
			const base = log[3] ? name.slice(0, -log[3].length - 1) : name;
			const previous = logsByProcessDay.get(base);
			if (previous === undefined) logsByProcessDay.set(base, name);
			else if (typeof previous === "string") logsByProcessDay.set(base, [previous, name]);
			else previous.push(name);
			continue;
		}
		const audit = PROCESS_AUDIT_PATTERN.exec(name);
		if (audit) {
			if (!isPidAlive(Number(audit[1]))) await removeBestEffort(path.join(dir, name));
			continue;
		}
		const legacy = LEGACY_LOG_PATTERN.exec(name);
		if (legacy) {
			if (legacy[1]! < cutoffDate) await removeBestEffort(path.join(dir, name));
		} else if (LEGACY_AUDIT_PATTERN.test(name)) {
			const file = path.join(dir, name);
			try {
				if ((await fs.promises.stat(file)).mtimeMs < cutoffMs) await removeBestEffort(file);
			} catch {
				// Another process may have pruned the same legacy audit.
			}
		}
	}

	for (const [base, names] of logsByProcessDay) {
		if (typeof names === "string" || names.length <= RETAINED_STALE_LOGS_PER_PROCESS_DAY) continue;
		const pid = Number(PROCESS_LOG_PATTERN.exec(base)![2]);
		if (isPidAlive(pid)) continue;
		const ranked: Array<{ path: string; mtimeMs: number; rollover: number }> = [];
		for (const name of names) {
			const file = path.join(dir, name);
			try {
				const { mtimeMs } = await fs.promises.stat(file);
				ranked.push({ path: file, mtimeMs, rollover: Number(name.slice(base.length + 1)) });
			} catch {
				// Another process may have pruned the same stale namespace.
			}
		}
		ranked.sort(
			(a, b) => b.mtimeMs - a.mtimeMs || b.rollover - a.rollover || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
		for (let i = RETAINED_STALE_LOGS_PER_PROCESS_DAY; i < ranked.length; i++) {
			if (isPidAlive(pid)) break;
			await removeBestEffort(ranked[i]!.path);
		}
	}
}

async function removeBestEffort(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch {
		// Retention is best-effort; another process may have pruned the same file.
	}
}

const scheduledPruneDirs = new Set<string>();

/** Run shared retention only after logger construction has returned to the event loop. */
function schedulePruneStaleProcessLogs(dir: string): void {
	if (scheduledPruneDirs.has(dir)) return;
	scheduledPruneDirs.add(dir);
	const immediate = setImmediate(async () => {
		try {
			await pruneStaleProcessLogs(dir);
		} finally {
			scheduledPruneDirs.delete(dir);
		}
	});
	immediate.unref();
}

/** Ensure a logs directory exists; return the resolved path. */
function ensureDir(dir: string): string {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * JSON.stringify replacer that unwraps {@link Error} instances. Error's own
 * properties are non-enumerable, so a plain `JSON.stringify(err)` produces
 * `"{}"`. Without this, a context like `{ err }` lost every useful field and
 * forensic logs showed only an opaque empty object.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
	return value instanceof Error ? errorToRecord(value) : value;
}

/** An Error's fields as a plain object: name, message, stack, enumerable extras, and `cause`. */
function errorToRecord(value: Error): Record<string, unknown> {
	const out: Record<string, unknown> = {
		name: value.name,
		message: value.message,
		stack: value.stack,
	};
	// Preserve `.cause` and any custom enumerable fields the caller attached.
	const errAsRecord = value as unknown as Record<string, unknown>;
	for (const k in errAsRecord) out[k] = errAsRecord[k];
	if (value.cause !== undefined) out.cause = value.cause;
	return out;
}

// Values visited by the Error pre-scan before falling back to the replacer.
const ERROR_SCAN_BUDGET = 128;

/**
 * Whether `value` may contain an {@link Error} that {@link jsonReplacer} must
 * unwrap. Walks what `JSON.stringify` serializes (arrays and own enumerable
 * keys); objects with a `toJSON` other than `Date` may return an Error, and an
 * exhausted budget answers true.
 */
function mayContainError(root: unknown): boolean {
	const stack: unknown[] = [root];
	let budget = ERROR_SCAN_BUDGET;
	while (stack.length > 0) {
		const value = stack.pop();
		if (value === null || typeof value !== "object") continue;
		if (value instanceof Error) return true;
		if (--budget < 0) return true;
		if (value instanceof Date) continue;
		if ("toJSON" in value && typeof value.toJSON === "function") return true;
		for (const child of Object.values(value)) stack.push(child);
	}
	return false;
}

function padTimestampPart(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

function formatLocalTimestamp(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	return (
		`${padTimestampPart(date.getFullYear(), 4)}-${padTimestampPart(date.getMonth() + 1)}-${padTimestampPart(date.getDate())}` +
		`T${padTimestampPart(date.getHours())}:${padTimestampPart(date.getMinutes())}:${padTimestampPart(date.getSeconds())}` +
		`.${padTimestampPart(date.getMilliseconds(), 3)}${offsetSign}${padTimestampPart(Math.floor(absoluteOffset / 60))}` +
		`:${padTimestampPart(absoluteOffset % 60)}`
	);
}

const FORMAT_TOKEN_PATTERN = /%[scdjifoO%]/;

const logContextStorage = new AsyncLocalStorage<Readonly<Record<string, unknown>>>();

/**
 * Run `fn` with `context`'s fields on every record logged while it runs,
 * including from the promises, timers and callbacks it starts. A nested call
 * replaces the enclosing context, as a subagent's session replaces its
 * parent's; a field passed to the log call itself wins. Fields are read as each
 * record is written, so a getter stays current.
 */
export function withContext<T>(context: Readonly<Record<string, unknown>>, fn: () => T): T {
	return logContextStorage.run(context, fn);
}

/**
 * Run `fn` outside any {@link withContext}: for process-wide work started on
 * behalf of one caller, such as a shared server's read loop, whose later
 * records belong to no single caller.
 */
export function withoutContext<T>(fn: () => T): T {
	return logContextStorage.exit(fn);
}

/**
 * Serialize one log record: timestamp, level, pid, message, then the `scoped`
 * ({@link withContext}) fields and the context fields.
 */
function formatLogRecord(
	level: LogLevel,
	message: string,
	context: Record<string, unknown> | undefined,
	timestamp: string,
	scoped: Readonly<Record<string, unknown>> | undefined,
): string {
	const metadata =
		!FORMAT_TOKEN_PATTERN.test(message) && context !== null && typeof context === "object" ? context : undefined;
	const entry: Record<string, unknown> = {
		timestamp,
		level,
		pid: process.pid,
		message: metadata?.message ? `${message} ${metadata.message}` : message,
	};
	if (scoped) {
		for (const key of Object.keys(scoped)) {
			if (key !== "level" && key !== "timestamp" && key !== "message") entry[key] = scoped[key];
		}
	}
	if (metadata) {
		for (const key of Object.keys(metadata)) {
			if (key !== "level" && key !== "timestamp" && key !== "message") entry[key] = metadata[key];
		}
		// An Error passed as the context carries these as non-enumerable fields.
		if (metadata.stack) entry.stack = metadata.stack;
		if (metadata.cause) entry.cause = metadata.cause;
	}
	return mayContainError(entry) ? JSON.stringify(entry, jsonReplacer) : JSON.stringify(entry);
}

/** Longest a buffered file record waits before it is written. */
const FILE_FLUSH_INTERVAL_MS = 1_000;
/** Buffered bytes at which the file batch is written immediately. */
const FILE_FLUSH_BYTES = 64 * 1024;

let exitFlushInstalled = false;
/** Set once the process is exiting: every later record is written immediately. */
let exiting = false;

function flushOnExit(): void {
	exiting = true;
	flush();
}

/** Build a rotating file sink with process-local rotation and shared retention. */
function makeFileTransport(dir?: string): RotatingFileSink {
	const logsDir = ensureDir(dir ?? getLogsDir());
	schedulePruneStaleProcessLogs(logsDir);
	if (!exitFlushInstalled) {
		exitFlushInstalled = true;
		// Natural exit and process.exit(); signal and fatal exits that bypass the
		// `exit` event flush through postmortem's exitProcess().
		process.on("exit", flushOnExit);
	}
	// The sink opens (and creates) its file on the first batch written.
	return new RotatingFileSink({
		directory: logsDir,
		filenamePrefix: "omp",
		filenameSuffix: String(process.pid),
		maxBytes: 10 * 1024 * 1024,
		maxFiles: 5,
		batch: { intervalMs: FILE_FLUSH_INTERVAL_MS, maxBytes: FILE_FLUSH_BYTES },
		// Keep the stderr guard's fd 2 on the file this sink is writing.
		onRotate: setStderrRedirectTarget,
	});
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
/** `warn` and `error` records are written at once, with everything buffered before them. */
const IMMEDIATE_FLUSH_RANK = LOG_LEVEL_RANK.warn;

/**
 * Rank of the most verbose level the local transports (file and console)
 * write: `OMP_LOG_LEVEL` (error|warn|info|debug, case-insensitive), default
 * `debug` (everything).
 */
function resolveLevelRank(): number {
	const requested = process.env.OMP_LOG_LEVEL?.trim().toLowerCase();
	return requested && Object.hasOwn(LOG_LEVEL_RANK, requested)
		? LOG_LEVEL_RANK[requested as LogLevel]
		: LOG_LEVEL_RANK.debug;
}

/**
 * Write buffered file records to disk now. The file transport batches records
 * (one write per second or per 64 KiB) and writes `warn`/`error` records
 * immediately; process exit flushes on its own. Call this before handing the
 * log file to something that reads it in-process. Never throws.
 */
export function flush(): void {
	try {
		if (logForwarder) logForwarder.flush();
		else activeTransports?.file?.flush();
	} catch {
		// Flushing diagnostics must never mask the caller's own work or failure.
	}
}

/**
 * Desired transport configuration, applied when local logging is initialized.
 * Default: file ON (TUI-safe), console OFF.
 */
let transportOpts: { console?: boolean; file?: boolean | string } = { file: true };

interface LocalTransports {
	readonly file: RotatingFileSink | undefined;
	readonly console: boolean;
	/** Rank of the most verbose level written to {@link file} and the console. */
	readonly levelRank: number;
}

/** Local transports, constructed lazily on first log emission. */
let activeTransports: LocalTransports | undefined;

/** The file holding the latest local log record; absent when file logging is inactive. */
export function currentLogFile(): string | undefined {
	return activeTransports?.file?.currentPath;
}

function buildTransports(opts: { console?: boolean; file?: boolean | string }): LocalTransports {
	return {
		file: opts.file ? makeFileTransport(typeof opts.file === "string" ? opts.file : undefined) : undefined,
		console: opts.console === true,
		levelRank: resolveLevelRank(),
	};
}

function getLocalTransports(): LocalTransports {
	activeTransports ??= buildTransports(transportOpts);
	return activeTransports;
}

/**
 * Write one record to the local transports. A `foreignTimestamp` marks a record
 * another thread logged ({@link emitForeign}): it keeps that time and gets no
 * {@link withContext} fields of this call stack, while the file still rotates by
 * the current day so a late record cannot reopen an earlier day's file.
 */
function emitLocally(
	level: LogLevel,
	message: string,
	context: Record<string, unknown> | undefined,
	foreignTimestamp?: Date,
): void {
	const transports = getLocalTransports();
	const rank = LOG_LEVEL_RANK[level];
	if (rank > transports.levelRank || (!transports.file && !transports.console)) return;
	const now = new Date();
	const scoped = foreignTimestamp ? undefined : logContextStorage.getStore();
	const line = formatLogRecord(level, message, context, formatLocalTimestamp(foreignTimestamp ?? now), scoped);
	transports.file?.write(line, rank <= IMMEDIATE_FLUSH_RANK || exiting, localDay(now));
	if (transports.console) fs.writeSync(1, `${line}${os.EOL}`);
}

/**
 * Replace the active log transports. Pass `console: true, file: false` for
 * long-running services (the auth broker, etc.) that want their structured
 * logs piped into a process supervisor instead of the rotating file.
 * The previous file transport writes its buffered records before closing, and
 * the level (`OMP_LOG_LEVEL`) is re-read on each reconfiguration.
 */
export function setTransports(opts: { console?: boolean; file?: boolean | string }): void {
	transportOpts = opts;
	if (!activeTransports) return; // applied lazily when local logging is first initialized
	const previousTransports = activeTransports;
	activeTransports = { file: undefined, console: false, levelRank: previousTransports.levelRank };
	previousTransports.file?.close();
	activeTransports = buildTransports(opts);
}

/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function error(message: string, context?: Record<string, unknown>): void {
	if (logForwarder) return forwardRecord(logForwarder, "error", message, context);
	try {
		emitLocally("error", message, context);
	} catch {
		// Silently ignore logging failures
	}
	emitToSinks("error", message, context);
}

/**
 * Log a warning message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function warn(message: string, context?: Record<string, unknown>): void {
	if (logForwarder) return forwardRecord(logForwarder, "warn", message, context);
	try {
		emitLocally("warn", message, context);
	} catch {
		// Silently ignore logging failures
	}
	emitToSinks("warn", message, context);
}

/**
 * Log an informational message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function info(message: string, context?: Record<string, unknown>): void {
	if (logForwarder) return forwardRecord(logForwarder, "info", message, context);
	try {
		emitLocally("info", message, context);
	} catch {
		// Silently ignore logging failures
	}
	emitToSinks("info", message, context);
}

/**
 * Log a debug message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function debug(message: string, context?: Record<string, unknown>): void {
	if (logForwarder) return forwardRecord(logForwarder, "debug", message, context);
	try {
		emitLocally("debug", message, context);
	} catch {
		// Silently ignore logging failures
	}
	emitToSinks("debug", message, context);
}

/**
 * Streaming startup markers, enabled by `PI_DEBUG_STARTUP`. Unlike the
 * PI_TIMING tree (printed only after startup completes), these write one
 * synchronous stderr line as each phase begins/ends, so a hard hang still
 * shows the last phase that started. `fs.writeSync(2)` is used deliberately:
 * it cannot be reordered or buffered past a synchronous block of the event
 * loop (dlopen, sync fs on a dead mount, spawnSync).
 */
export function startupMarker(text: string): void {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {
		// stderr unavailable; markers are best-effort
	}
}

const LOGGED_TIMING_THRESHOLD_MS = 0.5;

interface Span {
	op: string;
	start: number;
	end?: number;
	parent?: Span;
	children: Span[];
	/** Marker / point event without a duration. */
	point?: boolean;
}
const spanStorage = new AsyncLocalStorage<Span>();
let gRootSpan: Span | undefined;
let gRecordTimings = false;

let observedModules: ModuleLoadEvent[] = [];

export function shouldExitAfterTimings(): boolean {
	return timingModeIncludes("x") || timingModeIncludes("full");
}

/**
 * Print collected timings as an indented tree.
 * All offsets and the total use Bun's monotonic process clock. Overlap means overlapping
 * wall intervals, not concurrent CPU work. Open spans are measured up to the snapshot.
 */
export function printTimings(endpoint = "report snapshot"): void {
	const snapshot = performance.now();
	const root = gRootSpan;
	if (!root) {
		console.error("\n--- Startup Timings ---\n(no markers)\n");
		return;
	}

	const lines = [
		"",
		"--- Startup timings (wall clock; overlapping rows are not additive) ---",
		`Before app timing: ${fmtMs(root.start)} (not attributed)`,
	];
	for (const child of root.children) printSpan(child, snapshot, 0, lines);

	const window = snapshot - root.start;
	const covered = descendantCoverage(root, snapshot);
	lines.push(`App timing window: ${fmtMs(window)} (${fmtMs(covered)} in spans; ${fmtMs(window - covered)} unmarked)`);
	const events = drainModuleLoadEvents();
	for (const event of events) observedModules.push(event);
	if (observedModules.length > 0) printModuleTimings(observedModules, lines);
	else if (timingModeIncludes("modules") || timingModeIncludes("full"))
		lines.push("Modules: no completed instrumented TS/TSX modules observed");
	lines.push(
		`Total: ${snapshot.toFixed(1)}ms (Bun process clock → ${endpoint})`,
		"--------------------------------------",
		"",
	);
	console.error(lines.join("\n"));
}

/**
 * Begin recording startup timings under a new root span.
 * Idempotent: a second call while already recording is a no-op, so an explicit
 * starter (main.ts) and any future early starter can coexist.
 */
export function startTiming(): void {
	if (gRecordTimings) return;
	gRootSpan = {
		op: "(root)",
		start: performance.now(),
		parent: undefined,
		children: [],
	};
	gRecordTimings = true;
}

function shortenLoadPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
	const home = process.env.HOME;
	if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
	return p;
}

/**
 * End timing window and clear buffers.
 */
export function endTiming(): void {
	gRootSpan = undefined;
	gRecordTimings = false;
	observedModules = [];
	stopModuleLoadTiming();
}

/**
 * Ops of the currently-open span chain (root → deepest), following the most
 * recently started unfinished child at each level. Lets a startup watchdog
 * name the phase a stalled startup is stuck in.
 */
export function openSpanPath(): string[] {
	const ops: string[] = [];
	let node = gRootSpan;
	while (node) {
		let next: Span | undefined;
		for (let i = node.children.length - 1; i >= 0; i--) {
			if (node.children[i].end === undefined) {
				next = node.children[i];
				break;
			}
		}
		if (!next) break;
		ops.push(next.op);
		node = next;
	}
	return ops;
}

interface Interval {
	start: number;
	end: number;
}

/** Wall time covered at least once; gaps between intervals do not count. */
function coveredWall(intervals: Interval[]): number {
	intervals.sort((a, b) => a.start - b.start);
	let covered = 0;
	let until = -Infinity;
	for (const { start, end } of intervals) {
		if (end <= start || end <= until) continue;
		covered += end - Math.max(start, until);
		until = end;
	}
	return covered;
}

function descendantCoverage(span: Span, snapshot: number): number {
	const intervals: Interval[] = [];
	const end = span.end ?? snapshot;
	// Detached tasks can outlive their enclosing span. Count their tails in the root
	// window, but never charge a parent for a descendant outside the parent's lifetime.
	const collect = (children: readonly Span[]): void => {
		for (const child of children) {
			if (child.point || child.start >= end) continue;
			intervals.push({ start: Math.max(span.start, child.start), end: Math.min(end, child.end ?? snapshot) });
			if (child.children.length) collect(child.children);
		}
	};
	collect(span.children);
	return coveredWall(intervals);
}

function fmtMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)}ms`;
	if (ms < 100) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(0)}ms`;
}

function printSpan(span: Span, snapshot: number, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	if (span.point) {
		lines.push(`${indent}• ${span.op} @${fmtMs(span.start)}`);
		return;
	}
	const duration = (span.end ?? snapshot) - span.start;
	if (duration < LOGGED_TIMING_THRESHOLD_MS && span.end !== undefined && span.children.length === 0) return;
	const unmarked = span.children.length
		? ` (${fmtMs(duration - descendantCoverage(span, snapshot))} outside child spans)`
		: "";
	const overlap = isParallel(span, snapshot) ? " [overlaps sibling]" : "";
	const open = span.end === undefined ? " [open at snapshot]" : "";
	lines.push(`${indent}${span.op}: ${fmtMs(duration)}${unmarked}${overlap}${open} @${fmtMs(span.start)}`);
	for (const child of span.children) printSpan(child, snapshot, depth + 1, lines);
}

const MODULE_TOP = 10;

/** Observed read and evaluation intervals, not dependency waits or an attribution of startup CPU. */
function printModuleTimings(events: readonly ModuleLoadEvent[], lines: string[]): void {
	const reads = coveredWall(events.map(event => ({ start: event.readStart, end: event.readEnd })));
	const bodies = coveredWall(events.map(event => ({ start: event.bodyStart, end: event.bodyEnd })));
	lines.push(
		`Modules (instrumented; ${events.length} completed TS/TSX evaluations):`,
		`  Source reads: ${fmtMs(reads)} covered; evaluation including top-level await: ${fmtMs(bodies)} covered.`,
		"  Separate wall intervals; may overlap app spans and each other. Linking and dependency waits are not measured.",
	);
	const ranked = [...events].sort((a, b) => b.bodyEnd - b.bodyStart - (a.bodyEnd - a.bodyStart));
	const limit = timingModeIncludes("full") ? ranked.length : Math.min(MODULE_TOP, ranked.length);
	for (let i = 0; i < limit; i++) {
		const event = ranked[i];
		lines.push(
			`  ${shortenLoadPath(event.path)}: eval ${fmtMs(event.bodyEnd - event.bodyStart)}, read ${fmtMs(event.readEnd - event.readStart)}`,
		);
	}
	if (limit < ranked.length) lines.push(`  … ${ranked.length - limit} more (PI_TIMING=full to show all)`);
}

/** Only other application spans at the same level can mark this row as overlapping. */
function isParallel(span: Span, snapshot: number): boolean {
	const end = span.end ?? snapshot;
	if (!span.parent || span.start >= end) return false;
	return span.parent.children.some(
		sibling =>
			sibling !== span &&
			!sibling.point &&
			sibling.start < (sibling.end ?? snapshot) &&
			sibling.start < end &&
			span.start < (sibling.end ?? snapshot),
	);
}

/**
 * Time a span. Three forms:
 *   time(op)                    — point event (zero-duration breadcrumb)
 *   time(op, fn, ...args)        — wrap fn in a span; returns fn's return value (sync or Promise)
 *
 * Spans nest hierarchically via AsyncLocalStorage: a child started inside another span's fn
 * (even across awaits) becomes that span's child. Parallel children are recorded as siblings
 * with overlapping intervals.
 */
export function time(op: string): void;
export function time<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T;
export function time<T, A extends unknown[]>(op: string, fn?: (...args: A) => T, ...args: A): T | undefined {
	const recording = gRecordTimings && gRootSpan !== undefined;

	if (fn === undefined) {
		startupMarker(op);
		if (!recording) return undefined as T;
		const parent = spanStorage.getStore() ?? gRootSpan!;
		const now = performance.now();
		parent.children.push({ op, start: now, end: now, parent, children: [], point: true });
		return undefined as T;
	}

	if (!recording && !process.env.PI_DEBUG_STARTUP) {
		return fn(...args);
	}

	startupMarker(`${op}:start`);
	let span: Span | undefined;
	if (recording) {
		const parent = spanStorage.getStore() ?? gRootSpan!;
		span = { op, start: performance.now(), parent, children: [] };
		parent.children.push(span);
	}

	const finish = (ok: boolean): void => {
		if (span) span.end = performance.now();
		startupMarker(ok ? `${op}:done` : `${op}:fail`);
	};
	try {
		const result = span ? spanStorage.run(span, () => fn(...args)) : fn(...args);
		if (isPromise(result)) {
			return result.then(
				value => {
					finish(true);
					return value;
				},
				error => {
					finish(false);
					throw error;
				},
			) as T;
		}
		finish(true);
		return result;
	} catch (error) {
		finish(false);
		throw error;
	}
}
