/**
 * Centralized logger for omp.
 *
 * Default: rotating `~/.omp/logs/omp.<DATE>.<PID>.log`, no console output (writing
 * to stdout/stderr would corrupt the TUI). Long-running headless services
 * (the auth broker, etc.) call {@link setTransports} to swap in a console
 * transport so a process supervisor (pm2, journald, k8s) captures the logs.
 *
 * Each entry includes `process.pid` so concurrent omp instances stay
 * traceable. The file is created on the first record written or when a terminal
 * guard acquires it for raw diagnostics. Records are batched — one write per
 * second or per 64 KiB — while `warn`/`error` records are written at once with
 * everything buffered before them; exit, fatal, and signal paths flush the
 * rest. `OMP_LOG_LEVEL` optionally limits structured file records (default: all).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import { isPromise } from "node:util/types";
import { localDay } from "./dirs";
import { configureProcessLog, flushProcessLog, getProcessLogSink } from "./logger/process-log";
import { drainModuleLoadEvents } from "./timing-buffer";
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

const logSinks = new Set<LogSink>();

/** Register an out-of-band log sink and return a disposer. */
export function registerLogSink(sink: LogSink): () => void {
	logSinks.add(sink);
	return () => {
		logSinks.delete(sink);
	};
}

function emitToSinks(level: LogLevel, message: string, context: Record<string, unknown> | undefined): void {
	if (logSinks.size === 0) return;
	const event: LogEvent = { level, message, context, timestamp: new Date() };
	for (const sink of logSinks) {
		try {
			sink(event);
		} catch {
			// Sinks are side channels; they must never break local logging.
		}
	}
}

/**
 * JSON.stringify replacer that unwraps {@link Error} instances. Error's own
 * properties are non-enumerable, so a plain `JSON.stringify(err)` produces
 * `"{}"`. Without this, a context like `{ err }` lost every useful field and
 * forensic logs showed only an opaque empty object.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
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
	return value;
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

/** Serialize one log record: timestamp, level, pid, message, then context fields. */
function formatLogRecord(
	level: LogLevel,
	message: string,
	context: Record<string, unknown> | undefined,
	timestamp: string,
): string {
	const metadata =
		!FORMAT_TOKEN_PATTERN.test(message) && context !== null && typeof context === "object" ? context : undefined;
	const entry: Record<string, unknown> = {
		timestamp,
		level,
		pid: process.pid,
		message: metadata?.message ? `${message} ${metadata.message}` : message,
	};
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

let exitFlushInstalled = false;
/** Set once the process is exiting: every later record is written immediately. */
let exiting = false;

function flushOnExit(): void {
	exiting = true;
	flush();
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
/** `warn` and `error` records are written at once, with everything buffered before them. */
const IMMEDIATE_FLUSH_RANK = LOG_LEVEL_RANK.warn;

/**
 * Rank of the most verbose level the file transport persists: `OMP_LOG_LEVEL`
 * (error|warn|info|debug, case-insensitive), default `debug` (everything).
 */
function resolveFileLevelRank(): number {
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
		flushProcessLog();
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
	readonly file: boolean;
	readonly console: boolean;
	/** Rank of the most verbose level written to {@link file}. */
	readonly fileLevelRank: number;
}

/** Local transports, constructed lazily on first log emission. */
let activeTransports: LocalTransports | undefined;

function buildTransports(opts: { console?: boolean; file?: boolean | string }): LocalTransports {
	return {
		file: Boolean(opts.file),
		console: opts.console === true,
		fileLevelRank: resolveFileLevelRank(),
	};
}

function getLocalTransports(): LocalTransports {
	if (!exitFlushInstalled) {
		exitFlushInstalled = true;
		process.on("exit", flushOnExit);
	}
	activeTransports ??= buildTransports(transportOpts);
	return activeTransports;
}

function emitLocally(level: LogLevel, message: string, context: Record<string, unknown> | undefined): void {
	const transports = getLocalTransports();
	const rank = LOG_LEVEL_RANK[level];
	const file = rank <= transports.fileLevelRank && transports.file ? getProcessLogSink() : undefined;
	if (!file && !transports.console) return;
	const now = new Date();
	const line = formatLogRecord(level, message, context, formatLocalTimestamp(now));
	file?.write(line, rank <= IMMEDIATE_FLUSH_RANK || exiting, localDay(now));
	if (transports.console) fs.writeSync(1, `${line}${os.EOL}`);
}

/**
 * Replace the active log transports. Pass `console: true, file: false` for
 * long-running services (the auth broker, etc.) that want their structured
 * logs piped into a process supervisor instead of the rotating file.
 * The previous file transport writes its buffered records before closing, and
 * the file level (`OMP_LOG_LEVEL`) is re-read on each reconfiguration.
 */
export function setTransports(opts: { console?: boolean; file?: boolean | string }): void {
	configureProcessLog(opts.file);
	transportOpts = opts;
	if (activeTransports) activeTransports = buildTransports(opts);
}

/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function error(message: string, context?: Record<string, unknown>): void {
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
	/** Absolute module path for module-load spans. */
	modulePath?: string;
	/** Own top-level module body / TLA duration for module-load spans. */
	moduleBodyMs?: number;
	/** Resolved static imports for module-load spans. */
	moduleImports?: string[];
}
const spanStorage = new AsyncLocalStorage<Span>();
let gRootSpan: Span | undefined;
let gRecordTimings = false;

export function timingModeIncludes(option: "full" | "x"): boolean {
	const value = process.env.PI_TIMING;
	if (!value) return false;
	if (value === option) return true;
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const code = i === value.length ? 44 : value.charCodeAt(i);
		const separator = code === 44 || code === 58 || code === 59 || code === 43 || code <= 32;
		if (!separator) continue;
		if (i > start && value.slice(start, i) === option) return true;
		start = i + 1;
	}
	return false;
}

export function shouldExitAfterTimings(): boolean {
	return timingModeIncludes("x") || timingModeIncludes("full");
}

/**
 * Print collected timings as an indented tree.
 * Each span shows wall duration; parents with children also show "(self)" for unattributed time.
 * Sibling spans are sorted by start time. Spans whose intervals overlap with siblings ran in parallel.
 */
export function printTimings(): void {
	if (!gRecordTimings || !gRootSpan) {
		console.error("\n--- Startup Timings ---\n(no markers)\n");
		return;
	}

	gRootSpan.end = performance.now();
	// Splice any preload-captured module-load events into the tree as root
	// children and back-extend the root window over them, so the static-import
	// phase that ran before the first explicit marker becomes visible (the
	// `(modules)` summary below) instead of being lumped into the opaque
	// `(before instrumentation)` figure.
	spliceModuleLoadBuffer();
	const lines: string[] = [];
	lines.push("");
	lines.push("--- Startup timings (hierarchical) ---");
	// performance.now() shares the process-start origin, so the root span's start
	// is the wall time before the first marker — runtime init plus any module
	// loads not captured below. With the module-load preload active this shrinks
	// to ~runtime init because the load phase is back-folded into the window.
	if (gRootSpan.start > LOGGED_TIMING_THRESHOLD_MS) {
		lines.push(`(before instrumentation): ${fmtMs(gRootSpan.start)} [runtime init + module load]`);
	}
	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of gRootSpan.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, 0, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, 0, lines);
	}
	// Surface the root's own unattributed time so the gap between the visible
	// top-level spans and Total isn't silently swallowed.
	const rootSelf = selfTimeOf(gRootSpan);
	if (gRootSpan.children.length > 0 && rootSelf > LOGGED_TIMING_THRESHOLD_MS) {
		lines.push(`(unattributed self): ${fmtMs(rootSelf)}`);
	}
	const totalMs = (gRootSpan.end - gRootSpan.start).toFixed(1);
	lines.push(`Total: ${totalMs}ms (since first marker)`);
	lines.push("--------------------------------------");
	lines.push("");
	console.error(lines.join("\n"));
	gRootSpan.end = undefined;
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

/**
 * Record an externally-measured span as a leaf child of the active span (or root
 * when no span is active). Used by {@link spliceModuleLoadBuffer} to fold
 * preload-captured module windows into the tree.
 */
export function recordModuleLoadSpan(
	path: string,
	start: number,
	durationMs: number,
	bodyMs?: number,
	imports: string[] = [],
): void {
	if (!gRecordTimings || !gRootSpan) return;
	const parent = spanStorage.getStore() ?? gRootSpan;
	const span: Span = {
		op: `load:${shortenLoadPath(path)}`,
		start,
		end: start + durationMs,
		parent,
		children: [],
		modulePath: path,
		moduleBodyMs: bodyMs,
		moduleImports: imports,
	};
	parent.children.push(span);
}

/**
 * Drain the preload's module-load buffer (see module-timer.ts) into the tree as
 * `load:` children of the root, then back-extend the root window to the earliest
 * captured read so the pre-marker load phase is counted in Total rather than
 * hidden as `(before instrumentation)`. No-op when nothing was captured (e.g. no
 * `--preload`, or a compiled binary where module reads are not interceptable).
 */
function spliceModuleLoadBuffer(): void {
	if (!gRootSpan) return;
	const events = drainModuleLoadEvents();
	if (events.length === 0) return;
	let earliest = gRootSpan.start;
	for (const event of events) {
		recordModuleLoadSpan(event.path, event.start, event.durationMs, event.bodyMs, event.imports);
		if (event.start < earliest) earliest = event.start;
	}
	gRootSpan.start = earliest;
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

function durationOf(span: Span): number {
	if (span.point || span.end === undefined) return 0;
	return span.end - span.start;
}

/** Self time = total - union of child intervals (handles parallel children correctly). */
function selfTimeOf(span: Span): number {
	const dur = durationOf(span);
	if (span.children.length === 0 || span.point) return dur;
	const intervals = span.children
		.filter(c => !c.point && c.end !== undefined)
		.map(c => [c.start, c.end as number] as const)
		.sort((a, b) => a[0] - b[0]);
	if (intervals.length === 0) return dur;
	let union = 0;
	let curStart = intervals[0][0];
	let curEnd = intervals[0][1];
	for (let i = 1; i < intervals.length; i++) {
		const [s, e] = intervals[i];
		if (s > curEnd) {
			union += curEnd - curStart;
			curStart = s;
			curEnd = e;
		} else if (e > curEnd) {
			curEnd = e;
		}
	}
	union += curEnd - curStart;
	return Math.max(0, dur - union);
}

function fmtMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)}ms`;
	if (ms < 100) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(0)}ms`;
}

const MODULE_LOAD_PREFIX = "load:";
const MODULE_LOAD_VERBOSE_TOP = 10;
const MODULE_TREE_MAX_DEPTH = 5;
const MODULE_TREE_ROOT_TOP = 5;
const MODULE_TREE_CHILD_TOP = 8;

interface ModuleTimingNode {
	span: Span;
	children: ModuleTimingNode[];
	parents: number;
	body: number;
}

function isModuleLoadSpan(span: Span): boolean {
	return span.op.startsWith(MODULE_LOAD_PREFIX);
}

function printSpan(span: Span, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	if (span.point) {
		lines.push(`${indent}• ${span.op}`);
		return;
	}
	const dur = durationOf(span);
	if (dur < LOGGED_TIMING_THRESHOLD_MS && span.children.length === 0) return;
	const parallel = isParallel(span);
	const tag = parallel ? " [parallel]" : "";
	const self = selfTimeOf(span);
	const selfStr = span.children.length > 0 && self > LOGGED_TIMING_THRESHOLD_MS ? ` (self ${fmtMs(self)})` : "";
	// Start offset from process origin: gaps between consecutive siblings are
	// the parent's own (unspanned) work, which duration alone cannot locate.
	lines.push(`${indent}${span.op}: ${fmtMs(dur)}${selfStr}${tag} @${span.start.toFixed(0)}ms`);

	// Split children into work spans and module-load spans for summarization.
	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of span.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, depth + 1, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, depth + 1, lines);
	}
}

/** Render module-load spans as a dependency-aware DAG/tree. */
function printModuleLoadSummary(loads: Span[], depth: number, lines: string[]): void {
	const childIndent = "  ".repeat(depth);
	const grandIndent = "  ".repeat(depth + 1);
	let unionStart = Number.POSITIVE_INFINITY;
	let unionEnd = 0;
	for (const span of loads) {
		if (span.end === undefined) continue;
		if (span.start < unionStart) unionStart = span.start;
		if (span.end > unionEnd) unionEnd = span.end;
	}
	const wall = unionEnd > unionStart ? unionEnd - unionStart : 0;
	const nodes = buildModuleTimingGraph(loads);
	lines.push(`${childIndent}(modules): ${loads.length} loaded, wall ${fmtMs(wall)}`);
	if (nodes.length === 0) return;

	const showAll = timingModeIncludes("full");
	const byBody = [...nodes].sort(compareModuleNodes);
	const topBody = showAll ? byBody : byBody.slice(0, MODULE_LOAD_VERBOSE_TOP);
	lines.push(`${grandIndent}top body/TLA:`);
	for (const node of topBody) {
		if (!showAll && node.body < LOGGED_TIMING_THRESHOLD_MS) break;
		lines.push(`${grandIndent}  ${node.span.op}: body ${fmtMs(node.body)} (total ${fmtMs(durationOf(node.span))})`);
	}
	if (!showAll && byBody.length > MODULE_LOAD_VERBOSE_TOP) {
		lines.push(`${grandIndent}  … ${byBody.length - MODULE_LOAD_VERBOSE_TOP} more (PI_TIMING=full to show all)`);
	}

	const roots = nodes.filter(node => node.parents === 0);
	const treeRoots = (roots.length > 0 ? roots : nodes).sort((a, b) => durationOf(b.span) - durationOf(a.span));
	const visibleRoots = showAll ? treeRoots : treeRoots.slice(0, MODULE_TREE_ROOT_TOP);
	lines.push(`${grandIndent}tree:`);
	const rendered = new Set<string>();
	for (const node of visibleRoots) {
		renderModuleTimingNode(node, depth + 2, lines, rendered, new Set<string>(), showAll);
	}
	if (!showAll && treeRoots.length > MODULE_TREE_ROOT_TOP) {
		lines.push(
			`${grandIndent}  … ${treeRoots.length - MODULE_TREE_ROOT_TOP} more roots (PI_TIMING=full to show all)`,
		);
	}
}

function buildModuleTimingGraph(loads: Span[]): ModuleTimingNode[] {
	const nodes = new Map<string, ModuleTimingNode>();
	for (const span of loads) {
		if (!span.modulePath || span.end === undefined) continue;
		nodes.set(span.modulePath, { span, children: [], parents: 0, body: span.moduleBodyMs ?? 0 });
	}
	for (const node of nodes.values()) {
		for (const childPath of node.span.moduleImports ?? []) {
			const child = nodes.get(childPath);
			if (!child || child === node) continue;
			node.children.push(child);
			child.parents++;
		}
	}
	for (const node of nodes.values()) {
		node.children.sort(compareModuleNodes);
	}
	return [...nodes.values()];
}

function compareModuleNodes(a: ModuleTimingNode, b: ModuleTimingNode): number {
	const bodyDiff = b.body - a.body;
	if (Math.abs(bodyDiff) > 0.001) return bodyDiff;
	return durationOf(b.span) - durationOf(a.span);
}

function renderModuleTimingNode(
	node: ModuleTimingNode,
	depth: number,
	lines: string[],
	rendered: Set<string>,
	ancestors: Set<string>,
	showAll: boolean,
): void {
	const path = node.span.modulePath;
	if (!path) return;
	const indent = "  ".repeat(depth);
	const total = durationOf(node.span);
	if (!showAll && total < LOGGED_TIMING_THRESHOLD_MS && node.children.length === 0) return;
	const wait = Math.max(0, total - node.body);
	const shared = node.parents > 1 ? " [shared]" : "";
	const timing =
		node.body > LOGGED_TIMING_THRESHOLD_MS || node.children.length > 0
			? ` (body ${fmtMs(node.body)}, wait ${fmtMs(wait)})`
			: "";
	const alreadyRendered = rendered.has(path);
	const cycle = ancestors.has(path);
	const suffix = cycle ? " [cycle]" : alreadyRendered ? " [already shown]" : "";
	lines.push(`${indent}${node.span.op}: ${fmtMs(total)}${timing}${shared}${suffix}`);
	if (cycle || alreadyRendered) return;
	rendered.add(path);
	ancestors.add(path);
	if (!showAll && ancestors.size >= MODULE_TREE_MAX_DEPTH) {
		if (node.children.length > 0) {
			lines.push(`${indent}  … ${node.children.length} imports deeper (PI_TIMING=full to show all)`);
		}
		ancestors.delete(path);
		return;
	}
	const visibleChildren = showAll ? node.children : node.children.slice(0, MODULE_TREE_CHILD_TOP);
	for (const child of visibleChildren) {
		renderModuleTimingNode(child, depth + 1, lines, rendered, ancestors, showAll);
	}
	if (!showAll && node.children.length > MODULE_TREE_CHILD_TOP) {
		lines.push(
			`${indent}  … ${node.children.length - MODULE_TREE_CHILD_TOP} more imports (PI_TIMING=full to show all)`,
		);
	}
	ancestors.delete(path);
}

/** A span is parallel if it overlaps a sibling that started before it. */
function isParallel(span: Span): boolean {
	const parent = span.parent;
	if (!parent || span.end === undefined) return false;
	for (const sibling of parent.children) {
		if (sibling === span || sibling.end === undefined || sibling.point) continue;
		// Overlap test: A overlaps B iff A.start < B.end && B.start < A.end
		if (sibling.start < span.end && span.start < sibling.end) return true;
	}
	return false;
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
