/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses the embedded bash engine (pi-shell) through native bindings for shell
 * execution.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type MinimizerOptions,
	type PipeStreams,
	PtySession,
	RunTrace,
	Shell,
	type ShellFilesystem,
	type ShellOptions,
	type ShellRunResult,
} from "@oh-my-pi/pi-natives";
import { isShellTrace, type ShellTrace } from "@oh-my-pi/pi-wire";
import { isEnoent, isPidAlive, logger } from "@oh-my-pi/pi-utils";
import { $env } from "@oh-my-pi/pi-utils/env";
import { isCmdShell, isExecutable, type ShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import { Settings } from "../config/settings";
import type { MinimizedMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { attachShellTrace } from "@oh-my-pi/pi-tui/tools/shell-viz";
import {
	resolveOutputMaxColumns,
	resolveOutputSinkArtifactMaxBytes,
	resolveOutputSinkHeadBytes,
} from "../tools/output-meta";
import { quotePosixArgv } from "../utils/shell-quote";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import { loadDirenvEnv } from "./direnv";
import { buildNonInteractiveEnv } from "./non-interactive-env";

import {
	cfgBashDirenv,
	cfgBashDirenvLoadTimeoutMs,
	cfgShellMinimizer,
	cfgShellPath,
	type ShellMinimizerSettings,
} from "./settings";

export interface BashExecutorOptions {
	cwd?: string;
	/** Milliseconds before aborting the command; 0 disables the executor deadline. */
	timeout?: number;
	onChunk?: (chunk: string) => void;
	/**
	 * Receives the sink's current inline view ({@link OutputSink.preview}: the
	 * body the final result will carry so far) at the `onChunk` cadence. Use it
	 * for live previews instead of re-buffering `onChunk` chunks.
	 */
	onPreview?: (text: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/**
	 * Directory of the agent session's saved shell states (`shellStateDir`), a file per
	 * kind of session shell (the bash tool's and `!` commands' may differ). The persistent shell
	 * writes there, after each command it completes, what it changed since its setup: variables,
	 * functions, aliases and options. A new shell of the same kind (a resumed or returned-to
	 * session) replays that on its own setup, so the current environment and shell configuration
	 * reach it wherever the session left them alone. A state whose replay fails, hangs or crashes
	 * the process is deleted; the commands that follow never put it in question.
	 */
	stateDir?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Run through the configured user shell instead of the embedded shell parsing directly. */
	useUserShell?: boolean;
	/** Run supported user shells (zsh/fish) on a headless PTY; requires `useUserShell`. */
	pty?: BashPtyOptions;
	/**
	 * Refuse git commands that discard or move shared work (`bash.gitGuard`),
	 * enforced by the embedded shell's `git` builtin.
	 */
	gitGuard?: boolean;
	/** ovnfs command for the git guard's separate-checkout guidance. */
	ovnfs?: string;
	/**
	 * Filesystem for `scheme://` paths in this run of the embedded shell (a URL
	 * `cwd` included). External shells and processes never see it.
	 */
	filesystem?: ShellFilesystem;
	/**
	 * Receives a copy of every byte crossing the command's pipes in the
	 * embedded shell (`proc://<id>/streams`). The user-shell paths ignore it.
	 */
	streams?: PipeStreams;
	/**
	 * Receives the embedded shell's live trace of the command (pi-shell's
	 * `RunTrace` snapshot) every {@link TRACE_POLL_MS} while it changed, and
	 * once more after the run settles. The PTY path never calls it.
	 */
	onTrace?: (trace: ShellTrace) => void;
	/**
	 * Invoked once the embedded shell starts the command, with a probe of the
	 * live pids it spawned (empty once the run ends). Not called on the
	 * user-shell paths.
	 */
	onStart?: (pids: () => readonly number[]) => void;
	/**
	 * Invoked before the run when the session's persistent shell is busy with
	 * another command, so this one runs in a fork of it instead: it sees the
	 * session's shell state as of before that command, and the state it sets
	 * is discarded.
	 */
	onSessionShellBusy?: () => void;
	/**
	 * Asked once the run settles: `false` means the agent session that owns
	 * `sessionKey` was left (new, fork, switch, branch) while the command ran,
	 * so the persistent shell it used is dropped instead of kept for a next call.
	 */
	isSessionCurrent?: () => boolean;
	/**
	 * `false` skips the shell output minimizer (`shellMinimizer.*`) for this run: the session's Spotlight
	 * experiment shapes the output instead. Default: the setting decides.
	 */
	minimize?: boolean;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * Invoked when the native minimizer rewrote the command's output, giving
	 * the caller a chance to persist the lossless original capture (typically
	 * via the session's `ArtifactManager`). The returned id is spliced into
	 * the sink output as `artifact://<id>` so the agent can retrieve the raw
	 * bytes. Return `undefined` to skip the footer.
	 */
	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<string | undefined>;
}

/** Viewport + raw-output callback enabling the user-shell PTY path (`!` hotkey). */
export interface BashPtyOptions {
	cols: number;
	rows: number;
	/** Receives raw PTY bytes (ANSI intact) for virtual-terminal rendering. */
	onChunk: (chunk: string) => void;
	/**
	 * Receives a writer for the PTY's stdin once the command starts, so the user
	 * can answer prompts (`read`, shell-startup questions). Writes after exit are dropped.
	 */
	onStdin?: (write: (data: string) => void) => void;
}

/** A command's captured output (the sink's summary, column-cap and middle-elision fields included) and how it ended. */
export interface BashResult extends OutputSummary {
	exitCode: number | undefined;
	cancelled: boolean;
	/** True when the command was killed by its timeout deadline (not a user abort). */
	timedOut?: boolean;
	/** The final trace snapshot of an embedded-shell run started with `onTrace`. */
	trace?: ShellTrace;
	/** The native minimizer's rewrite, set when its output replaced the raw stream. */
	minimized?: MinimizedMeta;
	workingDir?: string;
	/** Terminal graphics extracted from raw stdout before sanitization or truncation. */
	images?: ImageContent[];
}

/** POSIX-safe variable name — gates which direnv unsets we inject into the
 *  command line, so a hostile `.envrc` can't smuggle shell syntax through
 *  `unset`. `.envrc` never produces non-identifier names in practice. */
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `scheme://` working directory: it exists only in the embedded shell's injected filesystem. */
const URL_CWD_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Cadence of the `onTrace` poll while an embedded run is in flight. */
const TRACE_POLL_MS = 80;

/**
 * Polls `trace` every {@link TRACE_POLL_MS} while the run is in flight and
 * forwards each changed snapshot; `stop()` takes the final one.
 *
 * An invalid snapshot is logged once and skipped: the poll runs from a timer,
 * where a throw would escape as an uncaught exception and end the session,
 * and the trace is only a visualization of the run.
 */
function pollRunTrace(trace: RunTrace, onTrace: (trace: ShellTrace) => void): { stop: () => ShellTrace | undefined } {
	let last = -1;
	let latest: ShellTrace | undefined;
	let warned = false;
	const poll = () => {
		const version = trace.version();
		if (version === last) return;
		last = version;
		const snapshot: unknown = JSON.parse(trace.snapshot());
		if (!isShellTrace(snapshot)) {
			if (!warned) logger.warn("Native shell returned an invalid execution trace", { version });
			warned = true;
			return;
		}
		latest = snapshot;
		attachShellTrace(latest, trace);
		onTrace(latest);
	};
	const timer = setInterval(poll, TRACE_POLL_MS);
	return {
		stop: () => {
			clearInterval(timer);
			poll();
			return latest;
		},
	};
}

export interface DirenvPreflightOptions {
	/** Caller-supplied env overlay; these values win over direnv-provided ones. */
	callerEnv?: Record<string, string>;
	signal?: AbortSignal;
	/** Full direnv-load budget (`bash.direnvLoadTimeoutMs`). A positive
	 *  `callerTimeoutMs` clamps the effective load below this; `0`/undefined
	 *  leaves the full budget. */
	timeoutMs?: number;
	/** The caller's command deadline (ms). A positive value clamps the direnv
	 *  load so a cold `.envrc` can't outlast a short-timeout command; `0` or
	 *  undefined means "no caller clamp" — the load keeps its full `timeoutMs`
	 *  budget (a disabled command deadline is NOT a 0 ms load). Centralizing the
	 *  clamp here keeps every backend (executeBash, ACP terminal, PTY) on one
	 *  contract instead of each re-deriving it. */
	callerTimeoutMs?: number;
	/** `bash.direnv` setting — `"off"` skips the load entirely. */
	direnvSetting: "auto" | "off";
	/** Shell wrapper prefix (profiler/strace) to place *after* the unset prefix,
	 *  matching `executeBash`'s ordering. Backends that apply their own shell
	 *  wrapping (ACP `wrapShellLineForClientTerminal`) omit this. */
	commandPrefix?: string | undefined;
}

/**
 * Load the repo's direnv/devenv env and fold it into a `(command, env)` pair so
 * every bash backend (one-shot `executeBash`, ACP client terminal, PTY) exposes
 * the same devenv tools. Encapsulates: load the diff, merge `set` under the
 * caller's overlay (caller wins), and prepend a regex-gated `unset -v` for
 * variables the `.envrc` removes (skipping any the caller re-supplied).
 *
 * Returns the possibly-prefixed command plus the merged env, or the inputs
 * unchanged (`env` = `callerEnv`) when direnv is off, absent, or has no `.envrc`.
 * Pure transform: does NOT layer non-interactive env defaults — that stays the
 * caller's job (so interactive PTY/ACP paths keep their own env shape).
 */
export async function applyDirenvPreflight(
	command: string,
	cwd: string,
	opts: DirenvPreflightOptions,
): Promise<{ command: string; env: Record<string, string> | undefined }> {
	const withPrefix = (line: string): string => (opts.commandPrefix ? `${opts.commandPrefix} ${line}` : line);
	// A positive caller deadline clamps the direnv load below its full budget so
	// a cold `.envrc` can't outlast a short-timeout command; `0`/undefined means
	// "no caller clamp" (a disabled command deadline is not a 0 ms load). Every
	// backend routes through here, so the clamp lives in one place.
	const loadTimeoutMs =
		opts.callerTimeoutMs !== undefined && opts.callerTimeoutMs > 0
			? Math.min(opts.timeoutMs ?? opts.callerTimeoutMs, opts.callerTimeoutMs)
			: opts.timeoutMs;
	const direnvDiff =
		opts.direnvSetting === "off" ? null : await loadDirenvEnv(cwd, { timeoutMs: loadTimeoutMs, signal: opts.signal });
	if (!direnvDiff) {
		return { command: withPrefix(command), env: opts.callerEnv };
	}
	// The caller's explicit env still wins over direnv-provided values.
	const mergedEnv = { ...direnvDiff.set, ...opts.callerEnv };
	// direnv can also *remove* inherited variables (a `.envrc` doing
	// `unset AWS_PROFILE`). An env overlay can only add/override, so prepend a
	// real `unset` for those — unless the caller re-supplied the same var
	// explicitly, in which case the caller wins.
	const direnvUnsets = direnvDiff.unset.filter(
		name => !(opts.callerEnv && name in opts.callerEnv) && SAFE_ENV_NAME.test(name),
	);
	const unsetPrefix = direnvUnsets.length > 0 ? `unset -v ${direnvUnsets.join(" ")}; ` : "";
	return { command: `${unsetPrefix}${withPrefix(command)}`, env: mergedEnv };
}

const shellSessions = new Map<string, Shell>();
/** Each session shell's last saved state ({@link saveShellState}). */
const shellStates = new WeakMap<Shell, Uint8Array>();
/** The shell whose state each state file holds, by file: absent until a write succeeds. */
const stateFileWriters = new Map<string, WeakRef<Shell>>();
/** Session shells still being created (resumed from a saved state), by key. */
const pendingShellSessions = new Map<string, Promise<Shell>>();
/** Last pending write per state file, so writes land in command order. */
const stateWrites = new Map<string, Promise<void>>();
/** Markers of the replays running in this process ({@link resumeMarker}). */
const resumeMarkers = new Set<string>();
const brokenShellSessions = new Set<string>();
const shellSessionQuarantines = new Map<string, Promise<unknown>>();
/** Session keys with a command currently in flight on the persistent Shell. */
const shellSessionsInUse = new Set<string>();

/**
 * Shells retained past their turn because a background (`nohup`/`&`) job is
 * still running. A per-call `:async:` Shell is normally dropped at teardown,
 * which SIGKILLs its children via kill-on-drop. Keeping the reference alive lets
 * the process survive across turns; the Shell is dropped once its last
 * background job exits (reaped by the poll loop below). Children stay
 * kill-on-drop, so they still die when the harness tears the Shell down on exit.
 */
const retainedShells = new Set<Shell>();
const RETAIN_REAP_INTERVAL_MS = 5_000;
// Native cancellation may spend two seconds unwinding the shell before its
// N-API chunk bridge drains. The JS watchdog must not race that teardown.
const NATIVE_TIMEOUT_FALLBACK_GRACE_MS = 5_000;
// Upper bound on how long a quarantined session's cleanup may pend before the
// record is force-released. Native cancellation normally settles `runPromise`
// in ~2s, but a wedged native run (e.g. a grandchild holding the stdout pipe)
// could otherwise leave the run promise pending for the life of the process,
// leaking the session key in `brokenShellSessions`/`shellSessionQuarantines`
// (#10308). The backing timer is unref'd so it never keeps the process alive.
const QUARANTINE_CLEANUP_TIMEOUT_MS = 30_000;
// Native cancellation drops externals with TERM, then sends KILL from a
// background thread after the one-second grace. Keep a shutdown barrier even
// after the bash result has returned, so process exit cannot cut off that KILL.
const abortedShells = new Map<string, Set<Promise<void>>>();
const ABORT_KILL_GRACE_MS = 1_250;
const ABORT_CLEANUP_LIMIT_MS = 5_000;

function trackAbortedShell(
	agentSessionKey: string | undefined,
	runPromise: Promise<ShellRunResult>,
	abortPromise: Promise<void>,
): void {
	if (!agentSessionKey) return;
	const pending = abortedShells.get(agentSessionKey) ?? new Set<Promise<void>>();
	abortedShells.set(agentSessionKey, pending);
	const deadline = Promise.withResolvers<void>();
	const timer = setTimeout(deadline.resolve, ABORT_CLEANUP_LIMIT_MS);
	timer.unref?.();
	const cleanup = Promise.race([
		Promise.allSettled([runPromise, abortPromise]).then(() => Bun.sleep(ABORT_KILL_GRACE_MS)),
		deadline.promise,
	]).finally(() => clearTimeout(timer));
	pending.add(cleanup);
	void cleanup.then(() => {
		pending.delete(cleanup);
		if (pending.size === 0 && abortedShells.get(agentSessionKey) === pending) abortedShells.delete(agentSessionKey);
	});
}

/**
 * Wait for the shell-state writes still pending ({@link BashExecutorOptions.stateDir}) before exit,
 * and clear the markers of replays still running: an orderly exit is no crash.
 */
export async function drainShellStateWrites(): Promise<void> {
	await Promise.all([
		...stateWrites.values(),
		...Array.from(resumeMarkers, marker => fs.rm(marker, { force: true }).catch(() => undefined)),
	]);
}

/** Wait for an agent session's cancelled commands to finish native TERM→KILL escalation before exit. */
export async function drainAbortedShells(agentSessionKey: string | undefined): Promise<void> {
	if (!agentSessionKey) return;
	const pending = [...(abortedShells.get(agentSessionKey) ?? [])];
	for (const [key, cleanups] of abortedShells) {
		if (key.startsWith(`${agentSessionKey}:async:`)) pending.push(...cleanups);
	}
	await Promise.all(pending);
}

async function retainShellWithLiveBackgroundJobs(shell: Shell): Promise<void> {
	let live: number;
	try {
		live = await shell.liveBackgroundJobCount();
	} catch {
		return;
	}
	if (live <= 0) return;
	retainedShells.add(shell);
	const interval = setInterval(() => {
		void shell
			.liveBackgroundJobCount()
			.then(remaining => {
				if (remaining > 0) return;
				clearInterval(interval);
				retainedShells.delete(shell);
			})
			.catch(() => {
				clearInterval(interval);
				retainedShells.delete(shell);
			});
	}, RETAIN_REAP_INTERVAL_MS);
	interval.unref?.();
}

/**
 * A timer promise that resolves after {@link QUARANTINE_CLEANUP_TIMEOUT_MS}.
 * Used to bound quarantine cleanup; the timer is unref'd so it never keeps the
 * process alive on its own.
 */
function quarantineCleanupDeadline(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, QUARANTINE_CLEANUP_TIMEOUT_MS);
	timer.unref?.();
	return promise;
}

function quarantineShellSession(
	sessionKey: string,
	runPromise: Promise<ShellRunResult>,
	abortCleanupPromise: Promise<void> | undefined,
): void {
	brokenShellSessions.add(sessionKey);
	const settled = abortCleanupPromise
		? Promise.allSettled([runPromise, abortCleanupPromise])
		: Promise.allSettled([runPromise]);
	// Defensive bound: a never-settling `runPromise` must not pin the quarantine
	// record for the life of the process (#10308).
	const cleanup = Promise.race([settled, quarantineCleanupDeadline()]);
	shellSessionQuarantines.set(sessionKey, cleanup);
	void cleanup
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === cleanup) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

/** A surface label as it appears in a namespaced shell key (`loop-condition`). */
const SHELL_SESSION_LABEL = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Whether a shell cache key belongs to `agentSessionKey`, matching the session
 * key the shell was cached under: the id itself (the bash tool's own shells) or
 * one namespace of it, `<label>:<id>` (a `/loop` condition uses
 * `loop-condition:<id>`). A per-job `<id>:async:<jobId>` key names no session,
 * and a label must read like one, so a key whose prefix is
 * a path (`/work/repo:main`) is another session's, not a namespace.
 * The id itself is matched before any colon is read, so a session whose own id
 * contains one (a cwd-derived `/work/repo:main`) still releases its shells.
 */
function isShellSessionOwnedBy(key: string, agentSessionKey: string): boolean {
	const sessionField = key.split("\n", 1)[0];
	if (sessionField === agentSessionKey) return true;
	const separator = sessionField.indexOf(":");
	if (separator === -1) return false;
	if (!SHELL_SESSION_LABEL.test(sessionField.slice(0, separator))) return false;
	return sessionField.slice(separator + 1) === agentSessionKey;
}

/**
 * Drops every persistent Shell owned by an agent session (see
 * {@link isShellSessionOwnedBy}: the id itself or one namespace of it). The map
 * is process-global, so without this each disposed session keeps its native
 * shell for the life of the process. A Shell with live background jobs is
 * retained until they exit, matching the `:async:` teardown; an in-flight run
 * keeps its own reference and retains live background jobs when it settles.
 */
export function releaseShellSessions(agentSessionKey: string | undefined): void {
	if (!agentSessionKey) return;
	for (const [key, shell] of shellSessions) {
		if (!isShellSessionOwnedBy(key, agentSessionKey)) continue;
		shellSessions.delete(key);
		if (!shellSessionsInUse.has(key)) void retainShellWithLiveBackgroundJobs(shell);
	}
	// A shell still being created is not cached when it settles: its call drops it after running.
	for (const key of pendingShellSessions.keys()) {
		if (isShellSessionOwnedBy(key, agentSessionKey)) pendingShellSessions.delete(key);
	}
}

/**
 * The file in `stateDir` for one kind of session shell: what sets its commands apart (shell,
 * prefix, git guard, minimizer), not what changes from one process to the next (the environment,
 * the snapshot's path).
 */
function shellStateFile(stateDir: string, kind: readonly string[]): string {
	return path.join(stateDir, `${Bun.hash(kind.join("\n")).toString(36)}.bin`);
}

/**
 * Present, holding the pid, while a process replays the saved state in `stateFile` on a new shell:
 * left by a process the replay crashed.
 */
function resumeMarker(stateFile: string): string {
	return `${stateFile}.resuming`;
}

/** Upper bound on a resumed shell's setup and replay; past it the state is taken to hang the shell. */
const STATE_RESUME_TIMEOUT_MS = 30_000;

/**
 * A new shell for the session, resumed from `stateFile` when it holds a saved state. The state is
 * replayed here, by a no-op run before the caller's command: a state that breaks the shell (a
 * replay that fails, hangs or crashes the process) is deleted and the shell starts fresh, while
 * the caller's own command (a build that times out, a cancelled test run) never puts the state in
 * question. A state this build cannot resume (another version saved it, or it is damaged) is
 * logged and skipped. The caller's `signal` stops the replay (its setup may source a slow shell
 * config) without putting the state in question: the shell, whose session the cancelled setup
 * never finished, replays it again on its next run.
 */
async function createSessionShell(
	shellOptions: ShellOptions,
	stateFile: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Shell> {
	if (!stateFile) return new Shell(shellOptions);
	await stateWrites.get(stateFile);
	const marker = resumeMarker(stateFile);
	let state: Uint8Array;
	try {
		// A live pid is a replay in flight (another process or call resuming the same state).
		const pid = Number.parseInt(await Bun.file(marker).text(), 10);
		if (!(pid > 0 && isPidAlive(pid))) {
			logger.warn("Saved shell state dropped: replaying it crashed the process", { stateFile });
			discardShellState(stateFile);
			return new Shell(shellOptions);
		}
	} catch (err) {
		if (!isEnoent(err)) logger.warn("Failed to read the shell state marker", { stateFile, error: String(err) });
	}
	try {
		state = await Bun.file(stateFile).bytes();
	} catch (err) {
		if (!isEnoent(err)) logger.warn("Failed to read saved shell state", { stateFile, error: String(err) });
		return new Shell(shellOptions);
	}
	let shell: Shell;
	try {
		shell = new Shell({ ...shellOptions, state });
	} catch (err) {
		// Another version's state, or a damaged one: the next save replaces it.
		logger.warn("Saved shell state not resumed", { stateFile, error: String(err) });
		return new Shell(shellOptions);
	}
	try {
		await Bun.write(marker, String(process.pid));
		resumeMarkers.add(marker);
	} catch (err) {
		logger.warn("Failed to mark the shell state resuming", { stateFile, error: String(err) });
	}
	let failure: string | undefined;
	try {
		const result = await shell.run({ command: ":", timeoutMs: STATE_RESUME_TIMEOUT_MS, signal });
		if (result.timedOut) failure = "timed out";
		else if (result.exitCode !== 0 && !signal?.aborted) failure = `exit status ${result.exitCode}`;
	} catch (err) {
		if (!signal?.aborted) failure = String(err);
	}
	resumeMarkers.delete(marker);
	if (failure === undefined) {
		try {
			await fs.rm(marker, { force: true });
		} catch (err) {
			logger.warn("Failed to clear the shell state marker", { stateFile, error: String(err) });
		}
		return shell;
	}
	logger.warn("Saved shell state dropped: replaying it broke the shell", { stateFile, error: failure });
	void shell.abort().catch(() => undefined);
	discardShellState(stateFile);
	return new Shell(shellOptions);
}

/**
 * Write `shell`'s state to `stateFile` after the writes queued before it; nothing when the file
 * already holds it. Of two live shells sharing the file (one kind, different environments), the
 * last to complete a command wins. The file is replaced whole (written aside, then renamed), so a
 * crash mid-write leaves the previous state.
 */
function saveShellState(shell: Shell, stateFile: string): void {
	const fresh = shell.saveState();
	if (fresh) shellStates.set(shell, fresh);
	// `saveState()` returns nothing when the shell did not change since its last call: the file still
	// needs its state when another shell, or a failed write, left something else there.
	const state = fresh ?? (stateFileWriters.get(stateFile)?.deref() === shell ? undefined : shellStates.get(shell));
	if (!state) return;
	stateFileWriters.delete(stateFile);
	queueStateWrite(stateFile, async () => {
		const temp = `${stateFile}.${process.pid}.tmp`;
		// Owner-only on POSIX: the state holds the shell's variables (tokens it fetched included).
		await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
		await fs.writeFile(temp, state, { mode: 0o600 });
		await fs.rename(temp, stateFile);
		stateFileWriters.set(stateFile, new WeakRef(shell));
	});
}

/** Delete `stateFile` after the writes queued before it: the session's next shell starts fresh. */
function discardShellState(stateFile: string): void {
	queueStateWrite(stateFile, async () => {
		// After the writes queued before it: none of them names a writer of the deleted file.
		stateFileWriters.delete(stateFile);
		await Promise.all([fs.rm(stateFile, { force: true }), fs.rm(resumeMarker(stateFile), { force: true })]);
	});
}

/** Run `write` on `stateFile` after the ones queued before it, logging a failure. */
function queueStateWrite(stateFile: string, write: () => Promise<unknown>): void {
	const previous = stateWrites.get(stateFile) ?? Promise.resolve();
	const done = previous.then(write).then(
		() => undefined,
		err => logger.warn("Failed to update saved shell state", { stateFile, error: String(err) }),
	);
	stateWrites.set(stateFile, done);
	void done.finally(() => {
		if (stateWrites.get(stateFile) === done) stateWrites.delete(stateFile);
	});
}

function resolveShellCwd(cwd: string | undefined): string | undefined {
	// Preserve the caller's logical cwd string. The embedded shell uses this value to update `PWD` and its
	// internal working directory, so realpathing here collapses symlinks before the shell sees them.
	return cwd;
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
		sourceOutlineLevel: group.sourceOutlineLevel === "default" ? undefined : group.sourceOutlineLevel,
		legacyFilters: group.legacyFilters,
	};
}

function shellBasename(shell: string): string {
	return shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isBashShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash");
}

const UNSUPPORTED_UNQUOTED_CD_CHARS = "\\$`;&|<>(){}*?[]!#\"'";

function hasUnsupportedUnquotedCdSyntax(value: string): boolean {
	for (const char of value) {
		if (/\s/.test(char) || UNSUPPORTED_UNQUOTED_CD_CHARS.includes(char)) return true;
	}
	return false;
}

export function isPersistentShellCdCommand(command: string): boolean {
	if (/[\r\n]/.test(command)) return false;

	const trimmed = command.trim();
	if (trimmed === "cd") return true;
	if (!trimmed.startsWith("cd") || !/[ \t]/.test(trimmed[2] ?? "")) return false;

	let rest = trimmed.slice(2).trim();
	if (rest === "" || rest === "--") return true;

	let hasOptionTerminator = false;
	if (/^--[ \t]/.test(rest)) {
		hasOptionTerminator = true;
		rest = rest.slice(2).trimStart();
	}
	if (rest === "") return true;

	const quote = rest[0];
	let target: string;
	let quoted = false;
	if (quote === `"` || quote === "'") {
		if (rest.length < 2 || rest[rest.length - 1] !== quote) return false;
		target = rest.slice(1, -1);
		if (target.includes(quote)) return false;
		if (quote === `"` && /[\\$`\r\n]/.test(target)) return false;
		quoted = true;
	} else {
		if (hasUnsupportedUnquotedCdSyntax(rest)) return false;
		target = rest;
	}

	if (target === "") return false;
	if (/^[+-]\d+$/.test(target)) return false;
	if (!hasOptionTerminator && target.startsWith("-") && target !== "-") return false;
	if (!quoted && target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return false;
	return true;
}

function needsInteractiveShellArg(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("zsh") || basename.includes("fish");
}

function supportsAutoUserShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash") || basename.includes("zsh") || basename.includes("fish");
}

function hasInteractiveShellArg(args: string[]): boolean {
	return args.some(arg => arg === "--interactive" || /^-[^-]*i/.test(arg));
}

function ensureInteractiveShellArgs(shell: string, args: string[]): string[] {
	if (!needsInteractiveShellArg(shell)) return args;

	// fish sources the same config files (config.fish + conf.d) for interactive
	// shells as for login shells, so the inherited `-l` adds nothing — it only
	// marks the shell as login, firing `status is-login` blocks in user config
	// (agent/keychain setup, path mutation) on every `!` command. zsh keeps `-l`
	// because .zprofile is login-only. Args originate from procmgr's
	// getShellArgs(), so login only ever appears as a standalone `-l`/`--login`.
	const effectiveArgs = shellBasename(shell).includes("fish")
		? args.filter(arg => arg !== "-l" && arg !== "--login")
		: args;

	if (hasInteractiveShellArg(effectiveArgs)) return effectiveArgs;

	const commandIndex = effectiveArgs.findIndex(arg => arg === "-c" || arg === "--command");
	if (commandIndex !== -1) {
		return [...effectiveArgs.slice(0, commandIndex), "-i", ...effectiveArgs.slice(commandIndex)];
	}

	const compactCommandIndex = effectiveArgs.findIndex(arg => /^-[^-]*c[^-]*$/.test(arg));
	if (compactCommandIndex !== -1) {
		return effectiveArgs.map((arg, index) => (index === compactCommandIndex ? arg.replace("c", "ic") : arg));
	}

	return [...effectiveArgs, "-i"];
}

function buildUserShellCommand(shell: string, args: string[], command: string): string {
	return quotePosixArgv([shell, ...ensureInteractiveShellArgs(shell, args), command]);
}

function resolveUserShellConfig(settings: Settings, baseConfig: ShellConfig): ShellConfig {
	const customShellPath = cfgShellPath.get(settings);
	const envShell = Bun.env.SHELL;
	if (customShellPath || process.platform === "win32" || !envShell || envShell === baseConfig.shell) {
		return baseConfig;
	}
	if (!supportsAutoUserShell(envShell) || !isExecutable(envShell)) {
		return baseConfig;
	}

	return {
		...baseConfig,
		shell: envShell,
		env: {
			...baseConfig.env,
			SHELL: envShell,
		},
	};
}

/**
 * Env for the user-shell PTY path: keep the non-interactive guards (pagers,
 * editors, credential prompts) but restore color — the PTY makes stdout a
 * TTY, so TERM/NO_COLOR/CI are all that keep tools monochrome.
 */
function buildUserShellPtyEnv(
	shellEnv: Record<string, string>,
	commandEnv: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = { ...shellEnv, ...commandEnv, TERM: "xterm-256color" };
	delete env.NO_COLOR;
	delete env.CI;
	return env;
}

/**
 * Run a user-shell command on a headless PTY. Interactive zsh/fish startup
 * (zle, job control, gitstatus) requires a real TTY — piping through the
 * embedded shell produces `can't change option: zle` noise and colorless
 * output. Raw bytes stream to `pty.onChunk` for virtual-terminal rendering;
 * the sink keeps the sanitized capture for the transcript and the model.
 */
async function executeUserShellPty(run: {
	shell: string;
	args: string[];
	command: string;
	cwd: string | undefined;
	env: Record<string, string>;
	pty: BashPtyOptions;
	timeoutMs: number | undefined;
	signal: AbortSignal | undefined;
	sink: OutputSink;
	graphics: TerminalGraphicsDecoder;
	dump: (notice?: string) => Promise<OutputSummary & { images?: ImageContent[] }>;
}): Promise<BashResult> {
	const session = new PtySession();
	const result = await session.startArgv(
		{
			application: run.shell,
			args: [...ensureInteractiveShellArgs(run.shell, run.args), run.command],
			cwd: run.cwd,
			env: run.env,
			timeoutMs: run.timeoutMs,
			signal: run.signal,
			cols: run.pty.cols,
			rows: run.pty.rows,
		},
		(err, chunk) => {
			if (err || !chunk) return;
			run.pty.onChunk(chunk);
			// Preserve raw bytes for the terminal display, but extract graphics
			// before the transcript sink sanitizes or truncates the clean text.
			const clean = run.graphics.push(chunk);
			if (clean) run.sink.push(clean.replace(/\r\n?/gu, "\n"));
		},
		err => {
			if (err) return;
			run.pty.onStdin?.(data => {
				try {
					session.write(data);
				} catch {
					// The command exited between the keystroke and the write.
				}
			});
		},
	);
	if (result.timedOut) {
		return {
			exitCode: undefined,
			cancelled: true,
			timedOut: true,
			...(await run.dump(
				run.timeoutMs !== undefined
					? `Command timed out after ${Math.round(run.timeoutMs / 1000)} seconds`
					: "Command timed out",
			)),
		};
	}
	if (result.cancelled) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await run.dump("Command cancelled")),
		};
	}
	return {
		exitCode: result.exitCode,
		cancelled: false,
		...(await run.dump()),
	};
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = await Settings.init();
	const baseShellConfig = settings.getShellConfig();
	const shellConfig =
		options?.useUserShell === true ? resolveUserShellConfig(settings, baseShellConfig) : baseShellConfig;
	const { shell, args, env: shellEnv, prefix } = shellConfig;
	const bashShell = isBashShell(shell);
	// `!` hotkey commands on zsh/fish run in a real PTY: interactive shell
	// startup (zle, job control, gitstatus) needs a TTY, and tools only emit
	// color when stdout is one. bash keeps the snapshot + embedded-shell path;
	// `cd` keeps the persistent shell so the session cwd can follow it.
	const ptyRequest = options?.pty;
	const usePty =
		ptyRequest !== undefined &&
		options?.useUserShell === true &&
		!bashShell &&
		supportsAutoUserShell(shell) &&
		$env.PI_NO_PTY !== "1" &&
		!isPersistentShellCdCommand(command);
	const minimizer = options?.minimize === false ? undefined : buildMinimizerOptions(cfgShellMinimizer.get(settings));

	const commandCwd = resolveShellCwd(options?.cwd);
	const virtualCwd = commandCwd !== undefined && URL_CWD_RE.test(commandCwd);
	if (virtualCwd && (usePty || !options?.filesystem)) {
		throw new Error(`Working directory ${commandCwd} needs the embedded shell with an injected filesystem`);
	}
	// Fold the repo's direnv/devenv env into the command + env so devenv tools
	// land on PATH; the caller's explicit `env` still wins. Thread the caller's
	// signal + timeout so an aborted / short-timeout call can't hang on a cold
	// `.envrc` load before the abort listener is installed. The helper applies
	// the configured shell `prefix` after any `unset -v` it prepends. A URL cwd
	// has no `.envrc` on the host. The rc snapshot is independent, so both load
	// concurrently.
	const [snapshotPath, preflight] = await Promise.all([
		bashShell ? getOrCreateSnapshot(shell, shellEnv) : null,
		applyDirenvPreflight(command, commandCwd ?? process.cwd(), {
			callerEnv: options?.env,
			signal: options?.signal,
			timeoutMs: cfgBashDirenvLoadTimeoutMs.get(settings),
			callerTimeoutMs: options?.timeout,
			direnvSetting: virtualCwd ? "off" : cfgBashDirenv.get(settings),
			commandPrefix: prefix,
		}),
	]);
	const commandEnv = buildNonInteractiveEnv(preflight.env, { inheritLocale: options?.useUserShell === true });
	const runCdInPersistentShell = options?.useUserShell === true && !prefix && isPersistentShellCdCommand(command);
	// Never wrap in cmd.exe: it is only the Windows no-bash fallback for spawn
	// paths, and the embedded shell runs the POSIX line better directly.
	const finalCommand =
		options?.useUserShell === true && !bashShell && !isCmdShell(shell) && !runCdInPersistentShell
			? buildUserShellCommand(shell, args, preflight.command)
			: preflight.command;

	// Create output sink for truncation and artifact handling
	const graphics = new TerminalGraphicsDecoder();
	const onChunk = usePty ? undefined : options?.onChunk;
	const onPreview = usePty ? undefined : options?.onPreview;
	const sink: OutputSink = new OutputSink({
		onChunk:
			onChunk || onPreview
				? chunk => {
						onChunk?.(chunk);
						onPreview?.(sink.preview());
					}
				: undefined,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: onChunk || onPreview ? (options?.chunkThrottleMs ?? 50) : 0,
	});

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	let graphicsFinished = false;
	let decodedImages: ImageContent[] = [];
	const enqueueChunk = (chunk: string) => {
		if (!acceptingChunks) return;
		const clean = graphics.push(chunk);
		if (clean) sink.push(clean);
	};
	const dump = async (notice?: string): Promise<OutputSummary & { images?: ImageContent[] }> => {
		if (!graphicsFinished) {
			graphicsFinished = true;
			const tail = graphics.finish();
			if (tail) sink.push(tail);
			decodedImages = await graphics.images();
		}
		return {
			...(await sink.dump(notice)),
			...(decodedImages.length > 0 ? { images: decodedImages } : {}),
		};
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await dump("Command cancelled")),
		};
	}

	if (usePty && ptyRequest) {
		const requestedMs = options?.timeout;
		try {
			return await executeUserShellPty({
				shell,
				args,
				command: preflight.command,
				cwd: commandCwd,
				env: buildUserShellPtyEnv(shellEnv, commandEnv),
				pty: ptyRequest,
				timeoutMs: requestedMs === 0 ? undefined : Math.max(1_000, requestedMs ?? 300_000),
				signal: options?.signal,
				sink,
				graphics,
				dump,
			});
		} finally {
			await sink.dispose();
		}
	}

	// The embedded shell reads its builtin switches from the session env; a
	// different env also keys a separate persistent session.
	const sessionEnv = options?.gitGuard
		? { ...shellEnv, PI_GIT_GUARD: "1", PI_GIT_GUARD_OVNFS: options.ovnfs ?? "" }
		: shellEnv;
	const shellOptions = {
		sessionEnv,
		snapshotPath: snapshotPath ?? undefined,
		minimizer,
	};
	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, sessionEnv, options?.sessionKey, minimizer);
	const stateFile = options?.stateDir
		? shellStateFile(options.stateDir, [
				shell,
				prefix ?? "",
				options.gitGuard ? `git-guard:${options.ovnfs ?? ""}` : "",
				minimizer ? JSON.stringify(minimizer) : "",
			])
		: undefined;
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	// A persistent Shell runs one command at a time (the native session is a
	// mutex-guarded queue and `abort()` kills every in-flight run on it). When
	// parallel bash calls overlap on the same key, the first one owns the
	// persistent session; the rest run in one-shot forks of it, which start
	// from the session's state before the owner's command. A quarantined
	// session gets a fresh one-shot shell.
	const sessionBusy = shellSessionsInUse.has(sessionKey);
	const ownsPersistentSession = !persistentSessionBroken && !sessionBusy;
	let shellSession: Shell | undefined;
	if (ownsPersistentSession) {
		// Claimed before any await: an overlapping call sees the session busy.
		shellSessionsInUse.add(sessionKey);
		shellSession = shellSessions.get(sessionKey);
		if (!shellSession) {
			const created = createSessionShell(shellOptions, stateFile, options?.signal);
			pendingShellSessions.set(sessionKey, created);
			let current: boolean;
			try {
				shellSession = await created;
			} catch (err) {
				shellSessionsInUse.delete(sessionKey);
				throw err;
			} finally {
				// Released while it was created (`releaseShellSessions`): run once, then drop it.
				current = pendingShellSessions.get(sessionKey) === created;
				if (current) pendingShellSessions.delete(sessionKey);
			}
			if (current) shellSessions.set(sessionKey, shellSession);
		}
	}
	const busyShell = sessionBusy
		? (shellSessions.get(sessionKey) ?? (await pendingShellSessions.get(sessionKey)?.catch(() => undefined)))
		: undefined;
	// A quarantined session's one-shot shell (or a busy one's whose creation failed) resumes the
	// saved state too.
	const executionShell =
		shellSession ?? busyShell?.fork() ?? (await createSessionShell(shellOptions, stateFile, options?.signal));
	if (sessionBusy) options?.onSessionShellBusy?.();
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	let abortCleanupPromise: Promise<void> | undefined;
	const abortShell = (): Promise<void> => {
		abortCleanupPromise ??= executionShell.abort().catch(() => undefined);
		return abortCleanupPromise;
	};
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		void abortShell();
	};
	const abortDeferred = Promise.withResolvers<"abort">();
	const abortHandler = () => {
		abortCurrentExecution();
		abortDeferred.resolve("abort");
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
		// Aborted while the shell was prepared (a resumed shell's replay, the snapshot).
		if (userSignal.aborted) abortHandler();
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutDeferred = Promise.withResolvers<"timeout">();
	const requestedTimeoutMs = options?.timeout;
	const deadlineTimeoutMs = requestedTimeoutMs === 0 ? undefined : Math.max(1_000, requestedTimeoutMs ?? 300_000);
	const nativeTimeoutMs = requestedTimeoutMs !== undefined && requestedTimeoutMs > 0 ? requestedTimeoutMs : undefined;
	const nativeOwnsTimeout = nativeTimeoutMs !== undefined;
	if (deadlineTimeoutMs !== undefined) {
		const fallbackTimeoutMs = nativeOwnsTimeout
			? deadlineTimeoutMs + NATIVE_TIMEOUT_FALLBACK_GRACE_MS
			: deadlineTimeoutMs;
		timeoutTimer = setTimeout(() => {
			// Explicit timeouts are enforced inside pi-natives via `timeoutMs`.
			// Give native cancellation time to flush pipeline output and drain the
			// N-API bridge before this result-only watchdog quarantines the run.
			if (!nativeOwnsTimeout) {
				abortCurrentExecution();
			}
			timeoutDeferred.resolve("timeout");
		}, fallbackTimeoutMs);
	}

	let resetSession = false;
	const runTrace = options?.onTrace ? new RunTrace(finalCommand) : undefined;
	const tracePoll = runTrace && options?.onTrace ? pollRunTrace(runTrace, options.onTrace) : undefined;
	// The last snapshot once the run settled (any outcome); `stop()` is idempotent past the first call.
	let finalTrace: ShellTrace | undefined;
	const settleTrace = (): { trace: ShellTrace } | Record<string, never> => {
		if (tracePoll) {
			finalTrace ??= tracePoll.stop();
		}
		return finalTrace ? { trace: finalTrace } : {};
	};

	try {
		const runPromise = executionShell.run(
			{
				command: finalCommand,
				cwd: commandCwd,
				env: commandEnv,
				timeoutMs: nativeTimeoutMs,
				signal: runAbortController.signal,
				filesystem: options?.filesystem,
				streams: options?.streams,
				trace: runTrace,
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
		);
		options?.onStart?.(() => executionShell.pids());

		const winner = await Promise.race<
			{ kind: "result"; result: ShellRunResult } | { kind: "timeout" } | { kind: "abort" }
		>([
			runPromise.then(result => ({ kind: "result" as const, result })),
			timeoutDeferred.promise.then(kind => ({ kind })),
			abortDeferred.promise.then(kind => ({ kind })),
		]);

		if (winner.kind === "timeout" || winner.kind === "abort") {
			acceptingChunks = false;
			const cleanupPromise = abortShell();
			if (shellSession) {
				resetSession = true;
				quarantineShellSession(sessionKey, runPromise, cleanupPromise);
			} else {
				void Promise.allSettled([runPromise, cleanupPromise]);
			}
			if (winner.kind === "abort") {
				trackAbortedShell(options?.sessionKey, runPromise, cleanupPromise);
			}
			let notice = "Command cancelled";
			if (winner.kind === "timeout" && deadlineTimeoutMs !== undefined) {
				const seconds = Math.round(deadlineTimeoutMs / 1000);
				// With an explicit timeout the native shell owns enforcement and
				// this JS timer is only a backstop. If it still wins, the native
				// run never returned — any output is stuck in the undrained pipe,
				// so this is not a confirmed empty run (#10308).
				notice = nativeOwnsTimeout
					? `Command timed out after ${seconds} seconds; the shell backend did not respond, so any output above may be incomplete`
					: `Command timed out after ${seconds} seconds`;
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(winner.kind === "timeout" ? { timedOut: true } : {}),
				...settleTrace(),
				...(await dump(notice)),
			};
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}

		// Handle timeout
		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				timedOut: true,
				...settleTrace(),
				...(await dump(annotation)),
			};
		}

		// Handle cancellation
		if (winner.result.cancelled) {
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...settleTrace(),
				...(await dump("Command cancelled")),
			};
		}

		// When the native minimizer rewrote the output, persist the original and
		// swap the sink's accumulated raw stream for the minimized text with an
		// `artifact://<id>` footer so the agent can retrieve the raw bytes
		// losslessly. The minimized text is a lossy summary, so substitute it
		// only once the original is addressable — a caller that returns no id
		// (or an unavailable allocator) must keep the raw stream rather than
		// silently dropping the diagnostics the summary elided.
		const minimized = winner.result.minimized;
		let minimizedMeta: MinimizedMeta | undefined;
		if (minimized && minimized.text !== minimized.originalText) {
			const info = {
				filter: minimized.filter,
				inputBytes: minimized.inputBytes,
				outputBytes: minimized.outputBytes,
			};
			const artifactId = options?.onMinimizedSave
				? await options.onMinimizedSave(minimized.originalText, info)
				: undefined;
			if (artifactId) {
				minimizedMeta = { ...info, artifactId };
				// The decoder above already owns image extraction from the streamed
				// lossless output. Scrub any graphics frames repeated by the native
				// minimizer without feeding them back into that decoder.
				const minimizedGraphics = new TerminalGraphicsDecoder();
				const minimizedText = minimizedGraphics.push(minimized.text) + minimizedGraphics.finish();
				sink.replace(minimizedText);
				const sep = minimizedText.endsWith("\n") ? "" : "\n";
				sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
			}
		}

		// Normal completion
		return {
			exitCode: winner.result.exitCode,
			cancelled: false,
			workingDir: winner.result.workingDir,
			...(minimizedMeta ? { minimized: minimizedMeta } : {}),
			...settleTrace(),
			...(await dump()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		settleTrace();
		await sink.dispose();
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (ownsPersistentSession) {
			shellSessionsInUse.delete(sessionKey);
			if (stateFile) {
				// A timeout, cancel or failure keeps the state the last completed command left.
				if (!resetSession && shellSession) saveShellState(shellSession, stateFile);
			}
			const releasedWhileInUse = shellSessions.get(sessionKey) !== shellSession;
			if (
				resetSession ||
				releasedWhileInUse ||
				options?.sessionKey?.includes(":async:") ||
				options?.isSessionCurrent?.() === false
			) {
				// `:async:` keys are per-job (jobId is unique), and a left session is
				// never asked for again, so the Shell would otherwise stay in the
				// process-global map forever after completion. A session removed by
				// `releaseShellSessions()` while in use deferred background-job
				// retention until its in-flight command settled here.
				if (!releasedWhileInUse) {
					shellSessions.delete(sessionKey);
				}
				// Dropping the only reference to a per-call `:async:` or released
				// Shell SIGKILLs any `nohup`/`&` children (kill-on-drop). If the
				// command left a live background job, retain the Shell so the process
				// survives across turns; it is reaped once its last job exits and
				// still dies with the harness. Skip on resetSession (cancel/error) —
				// those tear down.
				if (!resetSession && shellSession) {
					await retainShellWithLiveBackgroundJobs(shellSession);
				}
			}
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
	minimizer?: MinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}
