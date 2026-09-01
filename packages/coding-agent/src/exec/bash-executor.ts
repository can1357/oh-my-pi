/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import { ExponentialYield } from "@oh-my-pi/pi-agent-core/utils/yield";
import { type MinimizerOptions, PtySession, Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";
import { $env } from "@oh-my-pi/pi-utils/env";
import { isCmdShell, isExecutable, type ShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import { Settings, type ShellMinimizerSettings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { loadDirenvEnv } from "./direnv";
import { buildNonInteractiveEnv } from "./non-interactive-env";

export interface BashExecutorOptions {
	cwd?: string;
	/** Milliseconds before aborting the command; 0 disables the executor deadline. */
	timeout?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Run through the configured user shell instead of brush parsing directly. */
	useUserShell?: boolean;
	/** Run supported user shells (zsh/fish) on a headless PTY; requires `useUserShell`. */
	pty?: BashPtyOptions;
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
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	/** True when the command was killed by its timeout deadline (not a user abort). */
	timedOut?: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	workingDir?: string;
}

/** POSIX-safe variable name — gates which direnv unsets we inject into the
 *  command line, so a hostile `.envrc` can't smuggle shell syntax through
 *  `unset`. `.envrc` never produces non-identifier names in practice. */
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function resolveShellCwd(cwd: string | undefined): string | undefined {
	// Preserve the caller's logical cwd string. Brush uses this value to update `PWD` and its
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

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildUserShellCommand(shell: string, args: string[], command: string): string {
	return [shell, ...ensureInteractiveShellArgs(shell, args), command].map(quoteShellArg).join(" ");
}

function resolveUserShellConfig(settings: Settings, baseConfig: ShellConfig): ShellConfig {
	const customShellPath = settings.get("shellPath");
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
			// CRLF → LF for the capture; the sink strips ANSI itself.
			run.sink.push(chunk.replace(/\r\n?/gu, "\n"));
		},
	);
	if (result.timedOut) {
		return {
			exitCode: undefined,
			cancelled: true,
			timedOut: true,
			...(await run.sink.dump(
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
			...(await run.sink.dump("Command cancelled")),
		};
	}
	return {
		exitCode: result.exitCode,
		cancelled: false,
		...(await run.sink.dump()),
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
	const snapshotPath = bashShell ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));

	const commandCwd = resolveShellCwd(options?.cwd);
	// Fold the repo's direnv/devenv env into the command + env so devenv tools
	// land on PATH; the caller's explicit `env` still wins. Thread the caller's
	// signal + timeout so an aborted / short-timeout call can't hang on a cold
	// `.envrc` load before the abort listener is installed. The helper applies
	// the configured shell `prefix` after any `unset -v` it prepends.
	const preflight = await applyDirenvPreflight(command, commandCwd ?? process.cwd(), {
		callerEnv: options?.env,
		signal: options?.signal,
		timeoutMs: settings.get("bash.direnvLoadTimeoutMs"),
		callerTimeoutMs: options?.timeout,
		direnvSetting: settings.get("bash.direnv"),
		commandPrefix: prefix,
	});
	const commandEnv = buildNonInteractiveEnv(preflight.env);
	const runCdInPersistentShell = options?.useUserShell === true && !prefix && isPersistentShellCdCommand(command);
	// Never wrap in cmd.exe: it is only the Windows no-bash fallback for spawn
	// paths, and the embedded brush shell runs the POSIX line better directly.
	const finalCommand =
		options?.useUserShell === true && !bashShell && !isCmdShell(shell) && !runCdInPersistentShell
			? buildUserShellCommand(shell, args, preflight.command)
			: preflight.command;

	// Create output sink for truncation and artifact handling
	const sink = new OutputSink({
		onChunk: usePty ? undefined : options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: !usePty && options?.onChunk ? (options.chunkThrottleMs ?? 50) : 0,
	});

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	const enqueueChunk = (chunk: string) => {
		if (acceptingChunks) sink.push(chunk);
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await sink.dump("Command cancelled")),
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
			});
		} finally {
			await sink.dispose();
		}
	}

	const shellOptions = {
		sessionEnv: shellEnv,
		snapshotPath: snapshotPath ?? undefined,
		minimizer,
	};
	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey, minimizer);
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	// A persistent Shell runs one command at a time (the native session is a
	// mutex-guarded queue and `abort()` kills every in-flight run on it). When
	// parallel bash calls overlap on the same key, the first one owns the
	// persistent session; the rest degrade to isolated one-shot shells — the
	// same path quarantined sessions take.
	const sessionBusy = shellSessionsInUse.has(sessionKey);
	let shellSession = persistentSessionBroken || sessionBusy ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken && !sessionBusy) {
		shellSession = new Shell(shellOptions);
		shellSessions.set(sessionKey, shellSession);
	}
	const executionShell = shellSession ?? new Shell(shellOptions);
	const ownsPersistentSession = shellSession !== undefined;
	if (ownsPersistentSession) {
		shellSessionsInUse.add(sessionKey);
	}
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

	try {
		const runPromise = executionShell.run(
			{
				command: finalCommand,
				cwd: commandCwd,
				env: commandEnv,
				timeoutMs: nativeTimeoutMs,
				signal: runAbortController.signal,
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
		);

		const ey = new ExponentialYield();
		const winner = await ey.race<
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
				...(await sink.dump(notice)),
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
				...(await sink.dump(annotation)),
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
				...(await sink.dump("Command cancelled")),
			};
		}

		// When the native minimizer rewrote the output, swap the sink's accumulated
		// raw stream for the minimized text, persist the original as a session
		// artifact, and splice an `artifact://<id>` footer into the visible text so
		// the agent can retrieve the raw bytes losslessly.
		const minimized = winner.result.minimized;
		if (minimized && minimized.text !== minimized.originalText) {
			sink.replace(minimized.text);
			if (options?.onMinimizedSave) {
				const artifactId = await options.onMinimizedSave(minimized.originalText, {
					filter: minimized.filter,
					inputBytes: minimized.inputBytes,
					outputBytes: minimized.outputBytes,
				});
				if (artifactId) {
					const sep = minimized.text.endsWith("\n") ? "" : "\n";
					sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
				}
			}
		}

		// Normal completion
		return {
			exitCode: winner.result.exitCode,
			cancelled: false,
			workingDir: winner.result.workingDir,
			...(await sink.dump()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		await sink.dispose();
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (ownsPersistentSession) {
			shellSessionsInUse.delete(sessionKey);
			if (resetSession || options?.sessionKey?.includes(":async:")) {
				// `:async:` keys are per-job (jobId is unique), so the Shell would
				// otherwise stay in the process-global map forever after completion.
				shellSessions.delete(sessionKey);
				// Dropping the only reference to a per-call `:async:` Shell SIGKILLs
				// any `nohup`/`&` children (kill-on-drop). If the command left a live
				// background job, retain the Shell so the process survives across
				// turns; it is reaped once its last job exits and still dies with the
				// harness. Skip on resetSession (cancel/error) — those tear down.
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
