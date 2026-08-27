import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, hasFsCode, isEacces, isEisdir, isEnoent, isEnotdir, Snowflake } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import {
	parseDiffHunks as parseCommitDiffHunks,
	parseFileDiffs,
	parseFileHunks,
	parseNumstat,
} from "../commit/git/diff";
import type { FileDiff, FileHunks, NumstatEntry } from "../commit/types";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** True when stdout or stderr hit {@link GIT_COMMAND_OUTPUT_LIMIT_BYTES} and the captured text is incomplete. */
	truncated: boolean;
}

export interface GitRepository {
	commonDir: string;
	gitDir: string;
	gitEntryPath: string;
	headPath: string;
	repoRoot: string;
	isReftable?: boolean;
}

export interface GitStatusSummary {
	staged: number;
	unstaged: number;
	untracked: number;
}

export type HunkSelection = {
	path: string;
	hunks: { type: "all" } | { type: "indices"; indices: number[] } | { type: "lines"; start: number; end: number };
};

export interface StageHunksOptions {
	readonly diffCached?: boolean;
	readonly rawDiff?: string;
	readonly signal?: AbortSignal;
}

/** Options for streaming `git show` bytes without buffering complete output. */
export interface GitShowStreamOptions {
	readonly format?: string;
	readonly maxOutputBytes?: number;
	readonly signal?: AbortSignal;
}
export interface HunkSelectionValidationError {
	readonly path: string;
	readonly message: string;
}

export interface DiffOptions {
	readonly allowFailure?: boolean;
	readonly base?: string;
	readonly binary?: boolean;
	readonly cached?: boolean;
	/** Unified context lines (`git diff --unified=<n>`). */
	readonly context?: number;
	readonly env?: Record<string, string | undefined>;
	readonly files?: readonly string[];
	readonly head?: string;
	/** Per-stream capture ceiling for unusually large but intentional diffs. */
	readonly maxOutputBytes?: number;
	readonly nameOnly?: boolean;
	readonly noIndex?: { left: string; right: string };
	readonly numstat?: boolean;
	readonly signal?: AbortSignal;
	readonly stat?: boolean;
	readonly requireComplete?: boolean;
}

export interface StatusOptions {
	readonly pathspecs?: readonly string[];
	readonly porcelainV1?: boolean;
	readonly signal?: AbortSignal;
	readonly untrackedFiles?: "all" | "no" | "normal";
	readonly z?: boolean;
}

export interface CommitAuthor {
	readonly date?: string;
	readonly email: string;
	readonly name: string;
}

export interface CommitDetails {
	readonly author: CommitAuthor;
	readonly message: string;
	/** Comma-free parent SHAs; empty for a root commit. */
	readonly parents: readonly string[];
	/** Full commit SHA. */
	readonly sha: string;
}

export interface CommitOptions {
	readonly allowEmpty?: boolean;
	readonly amend?: boolean;
	readonly author?: CommitAuthor;
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface PushOptions {
	readonly forceWithLease?: boolean;
	readonly refspec?: string;
	readonly remote?: string;
	readonly signal?: AbortSignal;
}

export interface PatchOptions {
	readonly cached?: boolean;
	readonly check?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly reverse?: boolean;
	readonly threeWay?: boolean;
	readonly signal?: AbortSignal;
}

export interface RestoreOptions {
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
	readonly source?: string;
	readonly staged?: boolean;
	readonly worktree?: boolean;
}

export interface FetchOptions {
	readonly signal?: AbortSignal;
	/** Deadline for the network transfer. Defaults to {@link GIT_NETWORK_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

export interface CloneOptions {
	readonly ref?: string;
	readonly sha?: string;
	readonly signal?: AbortSignal;
	/** Deadline for the network transfer. Defaults to {@link GIT_NETWORK_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

interface GitHeadBase extends GitRepository {
	headContent: string;
}

export interface GitRefHead extends GitHeadBase {
	branchName: string | null;
	commit: string | null;
	kind: "ref";
	ref: string;
}

export interface GitDetachedHead extends GitHeadBase {
	commit: string | null;
	kind: "detached";
}

export type GitHeadState = GitRefHead | GitDetachedHead;

export interface GitWorktreeEntry {
	branch?: string;
	detached: boolean;
	head?: string;
	path: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Error
// ════════════════════════════════════════════════════════════════════════════

export class GitCommandError extends Error {
	readonly args: readonly string[];
	readonly result: GitCommandResult;

	constructor(args: readonly string[], result: GitCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "GitCommandError";
		this.args = [...args];
		this.result = result;
	}
}

/**
 * A git subprocess produced more output than {@link GIT_COMMAND_OUTPUT_LIMIT_BYTES}
 * and its captured stdout was truncated. Thrown only for callers that opt into
 * completeness via `diff({ requireComplete: true })`, where operating on a partial
 * diff would silently corrupt downstream parsing — e.g. the split-commit builder,
 * which would otherwise throw a misleading "No diff found" for files sorting after
 * a large binary blob whose base85 payload pushed the diff past the cap.
 */
export class GitOutputTruncatedError extends Error {
	readonly args: readonly string[];
	readonly result: GitCommandResult;

	constructor(args: readonly string[], result: GitCommandResult) {
		const limitMiB = Math.round(GIT_COMMAND_OUTPUT_LIMIT_BYTES / (1024 * 1024));
		super(
			`git ${args.join(" ")} produced more than ${limitMiB} MiB of output; the captured result is truncated and incomplete.`,
		);
		this.name = "GitOutputTruncatedError";
		this.args = [...args];
		this.result = result;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Core execution
// ════════════════════════════════════════════════════════════════════════════

const NO_OPTIONAL_LOCKS = "--no-optional-locks";
const HEAD_REF_PREFIX = "ref:";
const LOCAL_BRANCH_PREFIX = "refs/heads/";
const DEFAULT_BRANCH_REFS = ["refs/remotes/origin/HEAD", "refs/remotes/upstream/HEAD"] as const;
const SHORT_LIVED_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
];
const AMBIENT_GIT_ENV = {
	GIT_DIR: undefined,
	GIT_COMMON_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
} satisfies Record<string, undefined>;

const GIT_NON_INTERACTIVE_ENV = {
	GIT_ASKPASS: "true",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: undefined,
	LC_MESSAGES: "C",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
} satisfies Record<string, string | undefined>;
const GH_NON_INTERACTIVE_ENV = {
	...GIT_NON_INTERACTIVE_ENV,
	GH_PROMPT_DISABLED: "1",
} satisfies Record<string, string | undefined>;

/** Default deadline for git and gh subprocesses spawned by the coding agent. */
export const GIT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Default deadline for git subprocesses that perform network transfers
 * (`clone`/`fetch`). Large-repo transfers legitimately outlive
 * {@link GIT_COMMAND_TIMEOUT_MS}, so they get a wider deadline; local plumbing
 * commands keep the short one.
 */
export const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
/** Maximum captured stdout or stderr bytes retained from git and gh subprocesses. */
export const GIT_COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
/**
 * Deadline for synchronous git plumbing commands launched via
 * {@link gitSpawnSyncText}. These run on the render path (e.g. reftable HEAD
 * resolution), so the deadline is short: a command that has not exited by then
 * is killed and reported as {@link GIT_COMMAND_TIMEOUT_EXIT_CODE} so the caller
 * degrades instead of freezing the UI indefinitely.
 */
export const GIT_SPAWN_SYNC_TIMEOUT_MS = 5_000;
/**
 * Stat-poll interval for {@link head.watch}. One `stat` per interval keeps an
 * always-on status line cheap while surfacing a branch switch within a second.
 */
export const HEAD_WATCH_INTERVAL_MS = 1000;

const GIT_COMMAND_TIMEOUT_EXIT_CODE = 124;
// Exit code returned when the `git` binary cannot be launched at all (spawn
// ENOENT). Mirrors the POSIX "command not found" code so read-only callers that
// degrade on any non-zero exit treat a missing git the same as a failed
// invocation instead of letting the raw spawn ENOENT escape as an unhandled
// rejection.
const GIT_SPAWN_ENOENT_EXIT_CODE = 127;
const GIT_OUTPUT_TRUNCATED_MARKER = "\n[git subprocess output truncated after 8 MiB]\n";
const GIT_COMMAND_TERMINATE_GRACE_MS = 5_000;

type CommandName = "git" | "gh";

function resolveTimeoutMs(timeoutMs: number | undefined, fallback: number = GIT_COMMAND_TIMEOUT_MS): number {
	if (timeoutMs === undefined) return fallback;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return fallback;
	return Math.trunc(timeoutMs);
}

function resolveOutputLimit(maxOutputBytes: number | undefined): number {
	if (maxOutputBytes === undefined) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) return GIT_COMMAND_OUTPUT_LIMIT_BYTES;
	return Math.trunc(maxOutputBytes);
}

function formatCommandLabel(command: CommandName, args: readonly string[]): string {
	return `${command} ${args.join(" ")}`.trim();
}

async function waitForChildExit(child: Subprocess, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	const timeout = Promise.withResolvers<false>();
	const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
	timer.unref?.();
	try {
		return await Promise.race([
			child.exited.then(
				() => true,
				() => true,
			),
			timeout.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function terminateTimedOutChild(child: Subprocess): Promise<void> {
	child.kill("SIGTERM");
	if (await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS)) return;
	child.kill("SIGKILL");
	await waitForChildExit(child, GIT_COMMAND_TERMINATE_GRACE_MS);
}

async function waitForExitWithTimeout(
	child: Subprocess,
	commandLabel: string,
	timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: false } | { timedOut: true; stderr: string }> {
	if (timeoutMs === 0) {
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after 0ms` };
	}
	const timeout = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => timeout.resolve("timeout"), timeoutMs);
	timer.unref?.();
	try {
		const result = await Promise.race([
			child.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
			timeout.promise.then(() => ({ kind: "timeout" as const })),
		]);
		if (result.kind === "exit") {
			return { timedOut: false, exitCode: result.exitCode };
		}
		await terminateTimedOutChild(child);
		return { timedOut: true, stderr: `${commandLabel} timed out after ${timeoutMs}ms` };
	} finally {
		clearTimeout(timer);
	}
}

async function readCappedText(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let remaining = maxBytes;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!truncated && value.length <= remaining) {
				chunks.push(decoder.decode(value, { stream: true }));
				remaining -= value.length;
				continue;
			}
			if (!truncated && remaining > 0) {
				chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
				remaining = 0;
			}
			truncated = true;
		}
		chunks.push(decoder.decode());
		if (truncated) chunks.push(GIT_OUTPUT_TRUNCATED_MARKER);
		return { text: chunks.join(""), truncated };
	} finally {
		reader.releaseLock();
	}
}

async function cancelOutput(stream: ReadableStream<Uint8Array>): Promise<void> {
	try {
		await stream.cancel();
	} catch {
		// Best-effort cleanup after a timeout; the subprocess has already been signaled.
	}
}

async function collectSubprocessResult(
	command: CommandName,
	args: readonly string[],
	child: Subprocess,
	options: Pick<CommandOptions, "maxOutputBytes" | "timeoutMs"> = {},
): Promise<GitCommandResult> {
	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
		throw new Error(`Failed to capture ${command} command output.`);
	}
	const maxOutputBytes = resolveOutputLimit(options.maxOutputBytes);
	const stdoutPromise = readCappedText(stdoutStream, maxOutputBytes);
	const stderrPromise = readCappedText(stderrStream, maxOutputBytes);
	const exit = await waitForExitWithTimeout(
		child,
		formatCommandLabel(command, args),
		resolveTimeoutMs(options.timeoutMs),
	);
	if (exit.timedOut) {
		void stdoutPromise.catch(() => undefined);
		void stderrPromise.catch(() => undefined);
		await Promise.all([cancelOutput(stdoutStream), cancelOutput(stderrStream)]);
		return { exitCode: GIT_COMMAND_TIMEOUT_EXIT_CODE, stdout: "", stderr: exit.stderr, truncated: false };
	}
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	return {
		exitCode: exit.exitCode ?? 0,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: stdout.truncated || stderr.truncated,
	};
}

interface CommandOptions {
	readonly env?: Record<string, string | undefined>;
	readonly maxOutputBytes?: number;
	readonly readOnly?: boolean;
	readonly signal?: AbortSignal;
	readonly stdin?: string | Uint8Array | ArrayBuffer | SharedArrayBuffer;
	readonly timeoutMs?: number;
}

function normalizeStdin(input: CommandOptions["stdin"]): "ignore" | Uint8Array {
	if (input === undefined) return "ignore";
	if (typeof input === "string") return new TextEncoder().encode(input);
	if (input instanceof Uint8Array) return input;
	return new Uint8Array(input);
}

function buildNonInteractiveEnv(
	env: Record<string, string | undefined>,
	pinnedEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const preservedCharacterLocale =
		env.LC_ALL !== undefined && /(?:^|[._-])utf-?8(?:$|[.@_-])/i.test(env.LC_ALL) ? env.LC_ALL : undefined;
	return {
		...env,
		...(preservedCharacterLocale === undefined ? {} : { LC_CTYPE: preservedCharacterLocale }),
		...pinnedEnv,
	};
}

function buildGitEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined> {
	return buildNonInteractiveEnv(
		{
			...process.env,
			GIT_OPTIONAL_LOCKS: "0",
			...AMBIENT_GIT_ENV,
			...overrides,
		},
		GIT_NON_INTERACTIVE_ENV,
	);
}

function buildGhEnv(): Record<string, string | undefined> {
	return buildNonInteractiveEnv({ ...process.env }, GH_NON_INTERACTIVE_ENV);
}

function ensureAvailable(): void {
	if (!$which("git")) {
		throw new Error("git is not installed.");
	}
}

/**
 * Launch a `git` plumbing command synchronously and decode stdout. Returns the
 * exit code plus trimmed stdout; a missing `git` binary (spawn ENOENT) is
 * reported as {@link GIT_SPAWN_ENOENT_EXIT_CODE} so sync read-only callers
 * degrade to `null` instead of throwing an uncaught error during rendering.
 *
 * A deadline ({@link GIT_SPAWN_SYNC_TIMEOUT_MS}) is enforced so a pathological
 * git invocation (lock contention, NFS stall, …) cannot hang the render path
 * indefinitely: a child killed by the deadline is reported as
 * {@link GIT_COMMAND_TIMEOUT_EXIT_CODE} rather than a successful exit.
 */
function gitSpawnSyncText(
	cwd: string,
	args: readonly string[],
	timeoutMs: number = GIT_SPAWN_SYNC_TIMEOUT_MS,
): { exitCode: number; stdout: string } {
	const commandArgs = withShortLivedGitConfig(withNoOptionalLocks(args));
	try {
		const result = Bun.spawnSync(["git", ...commandArgs], {
			cwd,
			env: buildGitEnv(),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			timeout: timeoutMs,
		});
		// Bun's timeout marker is authoritative even when process cleanup reports
		// exit code zero, so render-path callers never trust partial output.
		const exitCode = result.exitedDueToTimeout
			? GIT_COMMAND_TIMEOUT_EXIT_CODE
			: (result.exitCode ?? GIT_COMMAND_TIMEOUT_EXIT_CODE);
		return { exitCode, stdout: new TextDecoder().decode(result.stdout).trim() };
	} catch (err) {
		if (isEnoent(err)) return { exitCode: GIT_SPAWN_ENOENT_EXIT_CODE, stdout: "" };
		throw err;
	}
}

function formatCommandFailure(
	args: readonly string[],
	result: Pick<GitCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `git ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

async function git(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<GitCommandResult> {
	const commandArgs = withShortLivedGitConfig(options.readOnly ? withNoOptionalLocks(args) : [...args]);
	let child: Subprocess;
	try {
		child = Bun.spawn(["git", ...commandArgs], {
			cwd,
			env: buildGitEnv(options.env),
			signal: options.signal,
			stdin: normalizeStdin(options.stdin),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
	} catch (err) {
		if (isEnoent(err)) {
			// A deleted/nonexistent cwd also surfaces as a spawn ENOENT; only blame
			// the binary when the working directory actually exists.
			const stderr = fs.existsSync(cwd) ? "git is not installed." : `working directory does not exist: ${cwd}`;
			return { exitCode: GIT_SPAWN_ENOENT_EXIT_CODE, stdout: "", stderr, truncated: false };
		}
		throw err;
	}

	return await collectSubprocessResult("git", commandArgs, child, options);
}

function withNoOptionalLocks(args: readonly string[]): string[] {
	if (args.includes(NO_OPTIONAL_LOCKS)) return [...args];
	return [NO_OPTIONAL_LOCKS, ...args];
}

function withShortLivedGitConfig(args: readonly string[]): string[] {
	const prefix: string[] = [];
	for (const [key, value] of SHORT_LIVED_GIT_CONFIG) {
		if (hasGitConfig(args, key, value)) continue;
		prefix.push("-c", `${key}=${value}`);
	}
	return [...prefix, ...args];
}

function hasGitConfig(args: readonly string[], key: string, value: string): boolean {
	const expected = `${key}=${value}`;
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === "-c" && args[index + 1] === expected) {
			return true;
		}
	}
	return false;
}

async function runChecked(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<GitCommandResult> {
	ensureAvailable();
	const result = await git(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new GitCommandError(args, result);
	}
	return result;
}

async function runEffect(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<void> {
	await runChecked(cwd, args, options);
}

async function runText(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
	return (await runChecked(cwd, args, options)).stdout;
}

/** Stream stdout chunks while preserving the normal git timeout/error contract. */
async function* runByteStream(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): AsyncGenerator<Uint8Array> {
	ensureAvailable();
	const commandArgs = withShortLivedGitConfig(options.readOnly ? withNoOptionalLocks(args) : [...args]);
	let child: Subprocess;
	try {
		child = Bun.spawn(["git", ...commandArgs], {
			cwd,
			env: buildGitEnv(options.env),
			signal: options.signal,
			stdin: normalizeStdin(options.stdin),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
	} catch (error) {
		if (!isEnoent(error)) throw error;
		const stderr = fs.existsSync(cwd) ? "git is not installed." : `working directory does not exist: ${cwd}`;
		throw new GitCommandError(args, {
			exitCode: GIT_SPAWN_ENOENT_EXIT_CODE,
			stdout: "",
			stderr,
			truncated: false,
		});
	}
	const stdout = child.stdout;
	const stderr = child.stderr;
	if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
		await terminateTimedOutChild(child);
		throw new Error("Failed to stream git command output.");
	}

	const maxOutputBytes = resolveOutputLimit(options.maxOutputBytes);
	const stderrPromise = readCappedText(stderr, maxOutputBytes);
	const exitPromise = waitForExitWithTimeout(
		child,
		formatCommandLabel("git", commandArgs),
		resolveTimeoutMs(options.timeoutMs),
	);
	const reader = stdout.getReader();
	let bytes = 0;
	let settled = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.length;
			if (bytes > maxOutputBytes) {
				await terminateTimedOutChild(child);
				settled = true;
				const capturedError = await stderrPromise;
				throw new GitOutputTruncatedError(args, {
					exitCode: child.exitCode ?? GIT_COMMAND_TIMEOUT_EXIT_CODE,
					stdout: "",
					stderr: capturedError.text,
					truncated: true,
				});
			}
			yield value;
		}

		const exit = await exitPromise;
		settled = true;
		const capturedError = await stderrPromise;
		if (exit.timedOut) {
			throw new GitCommandError(args, {
				exitCode: GIT_COMMAND_TIMEOUT_EXIT_CODE,
				stdout: "",
				stderr: exit.stderr,
				truncated: false,
			});
		}
		if (exit.exitCode !== 0) {
			throw new GitCommandError(args, {
				exitCode: exit.exitCode ?? GIT_COMMAND_TIMEOUT_EXIT_CODE,
				stdout: "",
				stderr: capturedError.text,
				truncated: capturedError.truncated,
			});
		}
	} finally {
		reader.releaseLock();
		if (!settled) await terminateTimedOutChild(child);
		void stderrPromise.catch(() => undefined);
	}
}

async function tryText(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<string | undefined> {
	ensureAvailable();
	const result = await git(cwd, args, options);
	if (result.exitCode !== 0) return undefined;
	return result.stdout;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: per-repo write serialization
// ════════════════════════════════════════════════════════════════════════════

// Git uses lock files (`.git/config.lock`, commit-graph chain locks,
// `packed-refs.lock`, …) for many of its mutating operations. Each is created
// O_EXCL with no waiter, so concurrent in-process git invocations against the
// same repository fail immediately rather than block. Worktrees share the
// primary repo's `.git` directory, so racing across worktrees has the same
// failure mode. We give callers a single per-repo serialization point keyed by
// the primary repo root: any block that mutates repo state should hold this
// lock so unrelated callers cannot collide on git's internal locks.
const repoWriteChain = new Map<string, Promise<unknown>>();

/**
 * Serialize an async block that mutates a git repository against other
 * in-process callers operating on the same repository. The lock is keyed by
 * the primary repo root so worktrees of the same repo share a single queue.
 * Failures in one block do not poison the queue for the next caller.
 *
 * Not reentrant: do NOT nest acquisitions for the same repo. Helpers in this
 * module never auto-acquire — callers wrap the critical section themselves.
 */
export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const key = (await repo.primaryRoot(cwd, signal)) ?? cwd;
	const prior = repoWriteChain.get(key);
	const run = (async () => {
		if (prior) {
			try {
				await prior;
			} catch {
				// A prior caller failing must not block us from running.
			}
		}
		throwIfAborted(signal);
		return fn();
	})();
	repoWriteChain.set(key, run);
	try {
		return await run;
	} finally {
		if (repoWriteChain.get(key) === run) repoWriteChain.delete(key);
	}
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function trimScalar(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Argument builders
// ════════════════════════════════════════════════════════════════════════════

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff"];
	if (options.binary) args.push("--binary");
	if (options.cached) args.push("--cached");
	if (options.context !== undefined && Number.isFinite(options.context) && options.context >= 0) {
		args.push(`--unified=${Math.trunc(options.context)}`);
	}
	if (options.nameOnly) args.push("--name-only");
	if (options.stat) args.push("--stat");
	if (options.numstat) args.push("--numstat");
	if (options.noIndex) {
		args.push("--no-index", options.noIndex.left, options.noIndex.right);
		return args;
	}
	if (options.base) {
		args.push(options.base);
		if (options.head) args.push(options.head);
	}
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

function buildApplyArgs(patchPath: string, options: PatchOptions): string[] {
	const args = ["apply"];
	if (options.check) args.push("--check");
	if (options.cached) args.push("--cached");
	if (options.reverse) args.push("--reverse");
	if (options.threeWay) args.push("--3way");
	args.push("--binary", patchPath);
	return args;
}

async function writeTempPatch(content: string): Promise<string> {
	const tempPath = path.join(os.tmpdir(), `omp-git-patch-${Snowflake.next()}.patch`);
	await Bun.write(tempPath, content);
	return tempPath;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Repository resolution
// ════════════════════════════════════════════════════════════════════════════

type EntryType = "directory" | "file";

function isPermissionError(err: unknown): boolean {
	return isEacces(err) || hasFsCode(err, "EPERM");
}

function shouldRetry(err: unknown, n: number) {
	if (isEnoent(err) || isEisdir(err) || isEnotdir(err) || hasFsCode(err, "ENFILE") || hasFsCode(err, "EMFILE"))
		return false;
	if (hasFsCode(err, "EINTR")) return n < EINTR_MAX_RETRIES;
	if (n > EINTR_MAX_RETRIES) throw err;
	throw err;
}

/**
 * Bounded retry for synchronous I/O against `EINTR`. POSIX permits short syscalls
 * to be interrupted by signals; when that happens libc traditionally retries.
 * Node's sync wrappers surface the raw `EINTR` so we replicate the retry locally.
 * Path absence, path-type mismatches, descriptor exhaustion, and exhausted
 * `EINTR` retries return `null`. Other errors are rethrown.
 */
const EINTR_MAX_RETRIES = 3;
function retryOnEintrSync<T>(op: () => T): T | null {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return op();
		} catch (err) {
			if (shouldRetry(err, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintrSync: exhausted without resolution");
}
async function retryOnEintr<T>(op: () => Promise<T>): Promise<T | null> {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return await op();
		} catch (err) {
			if (shouldRetry(err, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintr: exhausted without resolution");
}

function getEntryTypeSync(gitEntryPath: string): EntryType | null {
	return retryOnEintrSync(() => {
		const stat = fs.statSync(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

async function getEntryType(gitEntryPath: string): Promise<EntryType | null> {
	return retryOnEintr(async () => {
		const stat = await fs.promises.stat(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

function readOptionalTextSync(filePath: string): string | null {
	return retryOnEintrSync(() => fs.readFileSync(filePath, "utf8"));
}

async function readOptionalText(filePath: string): Promise<string | null> {
	return retryOnEintr(async () => await Bun.file(filePath).text());
}

async function readOptionalBytes(filePath: string): Promise<Uint8Array | null> {
	return retryOnEintr(async () => await Bun.file(filePath).bytes());
}

function parseGitDirPointer(content: string): string | null {
	const match = /^gitdir:\s*(.+)\s*$/iu.exec(content.trim());
	return match?.[1] ?? null;
}

function resolveGitDirSync(gitEntryPath: string, entryType: EntryType): string | null {
	if (entryType === "directory") return gitEntryPath;
	const content = readOptionalTextSync(gitEntryPath);
	if (content === null) return null;
	const parsed = parseGitDirPointer(content);
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return getEntryTypeSync(gitDir) === "directory" ? gitDir : null;
}

async function resolveGitDir(gitEntryPath: string, entryType: EntryType): Promise<string | null> {
	if (entryType === "directory") return gitEntryPath;
	const content = await readOptionalText(gitEntryPath);
	if (content === null) return null;
	const parsed = parseGitDirPointer(content);
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return (await getEntryType(gitDir)) === "directory" ? gitDir : null;
}

function resolveCommonDirSync(gitDir: string): string {
	const content = readOptionalTextSync(path.join(gitDir, "commondir"));
	const relative = content?.trim();
	if (!relative) return gitDir;
	return path.resolve(gitDir, relative);
}

async function resolveCommonDir(gitDir: string): Promise<string> {
	const content = await readOptionalText(path.join(gitDir, "commondir"));
	const relative = content?.trim();
	if (!relative) return gitDir;
	return path.resolve(gitDir, relative);
}
function isLinkedWorktree(repository: GitRepository): boolean {
	return (
		repository.gitDir !== repository.commonDir &&
		getEntryTypeSync(path.join(repository.gitDir, "commondir")) === "file"
	);
}

async function isLinkedWorktreeAsync(repository: GitRepository): Promise<boolean> {
	return (
		repository.gitDir !== repository.commonDir &&
		(await getEntryType(path.join(repository.gitDir, "commondir"))) === "file"
	);
}

function primaryRootFromRepositorySync(repository: GitRepository): string {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (isLinkedWorktree(repository)) return repository.commonDir;
	return repository.repoRoot;
}

async function primaryRootFromRepository(repository: GitRepository): Promise<string> {
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	if (await isLinkedWorktreeAsync(repository)) return repository.commonDir;
	return repository.repoRoot;
}

function resolveRepoFromEntrySync(repoRoot: string, gitEntryPath: string, entryType: EntryType): GitRepository | null {
	const gitDir = resolveGitDirSync(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: resolveCommonDirSync(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

async function resolveRepoFromEntry(
	repoRoot: string,
	gitEntryPath: string,
	entryType: EntryType,
): Promise<GitRepository | null> {
	const gitDir = await resolveGitDir(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: await resolveCommonDir(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

function resolveRepositorySync(startDir: string): GitRepository | null {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = getEntryTypeSync(gitEntryPath);
		if (entryType) {
			try {
				const repository = resolveRepoFromEntrySync(current, gitEntryPath, entryType);
				if (repository) return repository;
			} catch (err) {
				if (entryType === "file" && isPermissionError(err)) return null;
				throw err;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function resolveRepository(startDir: string): Promise<GitRepository | null> {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = await getEntryType(gitEntryPath);
		if (entryType) {
			try {
				const repository = await resolveRepoFromEntry(current, gitEntryPath, entryType);
				if (repository) return repository;
			} catch (err) {
				if (entryType === "file" && isPermissionError(err)) return null;
				throw err;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Ref resolution
// ════════════════════════════════════════════════════════════════════════════

function getRefLookupDirs(repository: GitRepository): string[] {
	if (repository.gitDir === repository.commonDir) return [repository.gitDir];
	return [repository.gitDir, repository.commonDir];
}

function normalizeRefValue(content: string | null): string | null {
	const trimmed = content?.trim() ?? "";
	return trimmed || null;
}

function parsePackedRefs(content: string | null, targetRef: string): string | null {
	if (!content) return null;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
		const [sha, refName] = trimmed.split(" ", 2);
		if (refName === targetRef && sha) return sha;
	}
	return null;
}

function stripGitConfigComments(line: string): string {
	let clean = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			inQuotes = !inQuotes;
			clean += char;
		} else if (!inQuotes && (char === ";" || char === "#")) {
			break;
		} else {
			clean += char;
		}
	}
	return clean.trim();
}

function parseGitConfigHasReftable(content: string): boolean {
	let inExtensions = false;
	for (const line of content.split("\n")) {
		const trimmed = stripGitConfigComments(line);
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const section = trimmed.slice(1, -1).trim().toLowerCase();
			inExtensions = section === "extensions";
		} else if (inExtensions) {
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex !== -1) {
				const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
				let value = trimmed.slice(eqIndex + 1).trim();
				if (key === "refstorage") {
					if (value.startsWith('"') && value.endsWith('"')) {
						value = value.slice(1, -1).trim();
					}
					const lowerValue = value.toLowerCase();
					if (lowerValue === "reftable" || lowerValue.startsWith("reftable:")) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

function isReftableRepoSync(repository: GitRepository): boolean {
	if (repository.isReftable !== undefined) return repository.isReftable;
	const configPath = path.join(repository.commonDir, "config");
	const content = readOptionalTextSync(configPath);
	repository.isReftable = content ? parseGitConfigHasReftable(content) : false;
	return repository.isReftable;
}

async function isReftableRepo(repository: GitRepository): Promise<boolean> {
	if (repository.isReftable !== undefined) return repository.isReftable;
	const configPath = path.join(repository.commonDir, "config");
	const content = await readOptionalText(configPath);
	repository.isReftable = content ? parseGitConfigHasReftable(content) : false;
	return repository.isReftable;
}

async function resolveHeadStateReftable(repository: GitRepository, signal?: AbortSignal): Promise<GitHeadState | null> {
	throwIfAborted(signal);
	const symResult = await git(repository.repoRoot, ["symbolic-ref", "HEAD"], { readOnly: true, signal }).catch(err => {
		if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))) {
			throw err;
		}
		return null;
	});
	throwIfAborted(signal);
	const revResult = await git(repository.repoRoot, ["rev-parse", "--verify", "HEAD"], {
		readOnly: true,
		signal,
	}).catch(err => {
		if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))) {
			throw err;
		}
		return null;
	});
	const commit = revResult && revResult.exitCode === 0 ? revResult.stdout.trim() || null : null;

	if (symResult && symResult.exitCode === 0) {
		const ref = symResult.stdout.trim();
		const branchName = ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : null;
		return {
			...repository,
			kind: "ref",
			ref,
			branchName,
			commit,
			headContent: `${HEAD_REF_PREFIX} ${ref}`,
		};
	}

	return {
		...repository,
		kind: "detached",
		commit,
		headContent: commit || "",
	};
}

function resolveHeadStateReftableSync(repository: GitRepository): GitHeadState | null {
	const symResult = gitSpawnSyncText(repository.repoRoot, ["symbolic-ref", "HEAD"]);
	const revResult = gitSpawnSyncText(repository.repoRoot, ["rev-parse", "--verify", "HEAD"]);
	const commit = revResult.exitCode === 0 ? revResult.stdout || null : null;

	if (symResult.exitCode === 0) {
		const ref = symResult.stdout;
		const branchName = ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : null;
		return {
			...repository,
			kind: "ref",
			ref,
			branchName,
			commit,
			headContent: `${HEAD_REF_PREFIX} ${ref}`,
		};
	}

	return {
		...repository,
		kind: "detached",
		commit,
		headContent: commit || "",
	};
}

function readRefSync(repository: GitRepository, targetRef: string): string | null {
	if (isReftableRepoSync(repository)) {
		const symResult = gitSpawnSyncText(repository.repoRoot, ["symbolic-ref", targetRef]);
		if (symResult.exitCode === 0) {
			return `${HEAD_REF_PREFIX} ${symResult.stdout}`;
		}
		const revResult = gitSpawnSyncText(repository.repoRoot, ["rev-parse", "--verify", targetRef]);
		if (revResult.exitCode === 0) {
			return revResult.stdout || null;
		}
		return null;
	}

	for (const dir of getRefLookupDirs(repository)) {
		const value = normalizeRefValue(readOptionalTextSync(path.join(dir, targetRef)));
		if (value) return value;
	}
	for (const dir of getRefLookupDirs(repository)) {
		const value = parsePackedRefs(readOptionalTextSync(path.join(dir, "packed-refs")), targetRef);
		if (value) return value;
	}
	return null;
}

async function readRef(repository: GitRepository, targetRef: string, signal?: AbortSignal): Promise<string | null> {
	if (await isReftableRepo(repository)) {
		throwIfAborted(signal);
		const symResult = await git(repository.repoRoot, ["symbolic-ref", targetRef], { readOnly: true, signal }).catch(
			err => {
				if (
					signal?.aborted ||
					(err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))
				) {
					throw err;
				}
				return null;
			},
		);
		if (symResult && symResult.exitCode === 0) {
			return `${HEAD_REF_PREFIX} ${symResult.stdout.trim()}`;
		}
		throwIfAborted(signal);
		const revResult = await git(repository.repoRoot, ["rev-parse", "--verify", targetRef], {
			readOnly: true,
			signal,
		}).catch(err => {
			if (
				signal?.aborted ||
				(err instanceof Error && (err.name === "AbortError" || err.name === "ToolAbortError"))
			) {
				throw err;
			}
			return null;
		});
		if (revResult && revResult.exitCode === 0) {
			return revResult.stdout.trim() || null;
		}
		return null;
	}

	for (const dir of getRefLookupDirs(repository)) {
		const value = normalizeRefValue(await readOptionalText(path.join(dir, targetRef)));
		if (value) return value;
	}
	for (const dir of getRefLookupDirs(repository)) {
		const value = parsePackedRefs(await readOptionalText(path.join(dir, "packed-refs")), targetRef);
		if (value) return value;
	}
	return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Head state parsing
// ════════════════════════════════════════════════════════════════════════════

function parseHeadStateSync(repository: GitRepository, headContent: string): GitHeadState {
	const trimmed = headContent.trim();
	if (!trimmed?.startsWith(HEAD_REF_PREFIX)) {
		return { ...repository, commit: trimmed || null, headContent, kind: "detached" };
	}
	const refValue = trimmed.slice(HEAD_REF_PREFIX.length).trim();
	const branchName = refValue.startsWith(LOCAL_BRANCH_PREFIX) ? refValue.slice(LOCAL_BRANCH_PREFIX.length) : null;
	return {
		...repository,
		branchName,
		commit: readRefSync(repository, refValue),
		headContent,
		kind: "ref",
		ref: refValue,
	};
}

async function parseHeadState(repository: GitRepository, headContent: string): Promise<GitHeadState> {
	const trimmed = headContent.trim();
	if (!trimmed?.startsWith(HEAD_REF_PREFIX)) {
		return { ...repository, commit: trimmed || null, headContent, kind: "detached" };
	}
	const refValue = trimmed.slice(HEAD_REF_PREFIX.length).trim();
	const branchName = refValue.startsWith(LOCAL_BRANCH_PREFIX) ? refValue.slice(LOCAL_BRANCH_PREFIX.length) : null;
	return {
		...repository,
		branchName,
		commit: await readRef(repository, refValue),
		headContent,
		kind: "ref",
		ref: refValue,
	};
}

function parseDefaultBranchRef(refPath: string, target: string | null): string | null {
	if (!target?.startsWith(HEAD_REF_PREFIX)) return null;
	const resolvedRef = target.slice(HEAD_REF_PREFIX.length).trim();
	const remotePrefix = refPath.slice(0, -"HEAD".length);
	if (!resolvedRef.startsWith(remotePrefix)) return null;
	return resolvedRef.slice(remotePrefix.length) || null;
}

function stripRemotePrefix(refValue: string): string | null {
	const slash = refValue.indexOf("/");
	if (slash < 0) return refValue || null;
	return refValue.slice(slash + 1) || null;
}

function parseWorktreeList(text: string): GitWorktreeEntry[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return trimmed
		.split(/\n\s*\n/)
		.map(block => block.trim())
		.filter(Boolean)
		.map(block => {
			const entry: GitWorktreeEntry = { detached: false, path: "" };
			for (const line of block.split("\n")) {
				if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
				else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
				else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length);
				else if (line === "detached") entry.detached = true;
			}
			return entry;
		});
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Hunk selection
// ════════════════════════════════════════════════════════════════════════════

function extractFileHeader(diffText: string): string {
	const lines = diffText.split("\n");
	const headerLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("@@")) break;
		headerLines.push(line);
	}
	return headerLines.join("\n");
}

function selectHunks(file: FileHunks, selector: HunkSelection["hunks"]): FileHunks["hunks"] {
	if (selector.type === "indices") {
		const wanted = new Set(selector.indices.map(v => Math.max(1, Math.floor(v))));
		return file.hunks.filter(hunk => wanted.has(hunk.index + 1));
	}
	if (selector.type === "lines") {
		const start = Math.floor(selector.start);
		const end = Math.floor(selector.end);
		return file.hunks.filter(hunk => hunk.newStart <= end && hunk.newStart + hunk.newLines - 1 >= start);
	}
	return file.hunks;
}

export function createHunkSelectionValidator(
	rawDiff: string,
): (selections: readonly HunkSelection[]) => HunkSelectionValidationError[] {
	const fileDiffMap = new Map(parseFileDiffs(rawDiff).map(entry => [entry.filename, entry]));
	return selections => validateHunkSelectionsFromMap(fileDiffMap, selections);
}

function validateHunkSelectionsFromMap(
	fileDiffMap: ReadonlyMap<string, FileDiff>,
	selections: readonly HunkSelection[],
): HunkSelectionValidationError[] {
	const errors: HunkSelectionValidationError[] = [];

	for (const selection of selections) {
		const fileDiff = fileDiffMap.get(selection.path);
		if (!fileDiff) continue;
		if (selection.hunks.type === "all") continue;
		if (fileDiff.isBinary) {
			errors.push({ path: selection.path, message: `Cannot select hunks for binary file ${selection.path}` });
			continue;
		}
		const selected = selectHunks(parseFileHunks(fileDiff), selection.hunks);
		if (selected.length === 0) {
			errors.push({ path: selection.path, message: `No hunks selected for ${selection.path}` });
		}
	}

	return errors;
}

export function validateHunkSelections(
	rawDiff: string,
	selections: readonly HunkSelection[],
): HunkSelectionValidationError[] {
	return createHunkSelectionValidator(rawDiff)(selections);
}

function parseStatusPorcelain(text: string): GitStatusSummary {
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of text.split("\n")) {
		if (!line) continue;
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked += 1;
			continue;
		}
		if (x && x !== " " && x !== "?") staged += 1;
		if (y && y !== " ") unstaged += 1;
	}
	return { staged, unstaged, untracked };
}

// ════════════════════════════════════════════════════════════════════════════
// API: diff
// ════════════════════════════════════════════════════════════════════════════

/** Run `git diff` with the given options. Returns raw diff text. */
export const diff = Object.assign(
	async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
		const args = buildDiffArgs(options);
		if (options.allowFailure) {
			return (
				await git(cwd, args, {
					env: options.env,
					maxOutputBytes: options.maxOutputBytes,
					readOnly: true,
					signal: options.signal,
				})
			).stdout;
		}
		const result = await runChecked(cwd, args, {
			env: options.env,
			maxOutputBytes: options.maxOutputBytes,
			readOnly: true,
			signal: options.signal,
		});
		if (options.requireComplete && result.truncated) {
			throw new GitOutputTruncatedError(args, result);
		}
		return result.stdout;
	},
	{
		/** List changed file paths. */
		async changedFiles(
			cwd: string,
			options: Pick<DiffOptions, "cached" | "files" | "signal"> = {},
		): Promise<string[]> {
			return splitLines(await diff(cwd, { ...options, nameOnly: true }));
		},
		/** Parsed per-file add/remove counts. */
		async numstat(cwd: string, options: Pick<DiffOptions, "cached" | "signal"> = {}): Promise<NumstatEntry[]> {
			return parseNumstat(await diff(cwd, { ...options, numstat: true }));
		},
		/** Parsed diff hunks for the given files. */
		async hunks(
			cwd: string,
			files: readonly string[],
			options: { cached?: boolean; signal?: AbortSignal } = {},
		): Promise<FileHunks[]> {
			return parseCommitDiffHunks(
				await diff(cwd, { cached: options.cached ?? true, files, signal: options.signal }),
			);
		},
		/** Check whether a diff exists (uses `--quiet` for efficiency). */
		async has(cwd: string, options: Pick<DiffOptions, "cached" | "files" | "signal"> = {}): Promise<boolean> {
			const args = ["diff"];
			if (options.cached) args.push("--cached");
			args.push("--quiet");
			if (options.files?.length) args.push("--", ...options.files);
			const result = await git(cwd, args, { readOnly: true, signal: options.signal });
			if (result.exitCode === 0) return false;
			if (result.exitCode === 1) return true;
			throw new GitCommandError(args, result);
		},
		/** Diff between two tree-ish objects (`git diff-tree`). */
		async tree(
			cwd: string,
			base: string,
			headRef: string,
			options: { binary?: boolean; signal?: AbortSignal; allowFailure?: boolean } = {},
		): Promise<string> {
			const args = ["diff-tree", "-r", "-p"];
			if (options.binary) args.push("--binary");
			args.push(base, headRef);
			if (options.allowFailure) {
				return (await git(cwd, args, { readOnly: true, signal: options.signal })).stdout;
			}
			return runText(cwd, args, { readOnly: true, signal: options.signal });
		},
		/** Parse raw diff text into per-file diffs. */
		parseFiles(text: string): FileDiff[] {
			return parseFileDiffs(text);
		},
		/** Parse raw diff text into per-file hunks. */
		parseHunks(text: string): FileHunks[] {
			return parseCommitDiffHunks(text);
		},
	},
);

// ════════════════════════════════════════════════════════════════════════════
// API: status
// ════════════════════════════════════════════════════════════════════════════

/** Run `git status --porcelain`. Returns raw status text. */
export const status = Object.assign(
	async function status(cwd: string, options: StatusOptions = {}): Promise<string> {
		const args = ["status"];
		args.push(options.porcelainV1 ? "--porcelain=v1" : "--porcelain");
		if (options.z) args.push("-z");
		if (options.untrackedFiles) args.push(`--untracked-files=${options.untrackedFiles}`);
		if (options.pathspecs?.length) args.push("--", ...options.pathspecs);
		return runText(cwd, args, { readOnly: true, signal: options.signal });
	},
	{
		/** Parsed status counts (staged, unstaged, untracked). */
		async summary(cwd: string, signal?: AbortSignal): Promise<GitStatusSummary | null> {
			const result = await git(cwd, ["status", "--porcelain"], { readOnly: true, signal });
			if (result.exitCode !== 0) return null;
			return parseStatusPorcelain(result.stdout);
		},
		/** Parse porcelain status text into counts. */
		parse: parseStatusPorcelain,
	},
);

// ════════════════════════════════════════════════════════════════════════════
// API: stage
// ════════════════════════════════════════════════════════════════════════════

export const stage = {
	/** Stage files. Empty array stages all (`git add -A`). */
	async files(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
		const args = files.length === 0 ? ["add", "-A"] : ["add", "--", ...files];
		await runEffect(cwd, args, { signal });
	},

	/** Selectively stage hunks from the provided diff or the current working tree diff. */
	async hunks(cwd: string, selections: HunkSelection[], options: StageHunksOptions = {}): Promise<void> {
		if (selections.length === 0) return;
		const rawDiff = options.rawDiff ?? (await diff(cwd, { cached: options.diffCached, signal: options.signal }));
		const fileDiffs = parseFileDiffs(rawDiff);
		const fileDiffMap = new Map(fileDiffs.map(entry => [entry.filename, entry]));
		const patchParts: string[] = [];

		for (const selection of selections) {
			const fileDiff = fileDiffMap.get(selection.path);
			if (!fileDiff) throw new Error(`No diff found for ${selection.path}`);
			if (fileDiff.isBinary) {
				if (selection.hunks.type !== "all")
					throw new Error(`Cannot select hunks for binary file ${selection.path}`);
				patchParts.push(fileDiff.content);
				continue;
			}
			if (selection.hunks.type === "all") {
				patchParts.push(fileDiff.content);
				continue;
			}
			const fileHunks = parseFileHunks(fileDiff);
			const selected = selectHunks(fileHunks, selection.hunks);
			if (selected.length === 0) throw new Error(`No hunks selected for ${selection.path}`);
			const header = extractFileHeader(fileDiff.content);
			patchParts.push([header, ...selected.map(h => h.content)].join("\n"));
		}

		const patchText = patch.join(patchParts);
		if (!patchText.trim()) return;
		await patch.applyText(cwd, patchText, { cached: true, signal: options.signal });
	},

	/** Unstage files. Empty array unstages all (`git reset`). */
	async reset(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
		const args = files.length === 0 ? ["reset"] : ["reset", "--", ...files];
		await runEffect(cwd, args, { signal });
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: commit, push, checkout
// ════════════════════════════════════════════════════════════════════════════

/** Create a commit with the given message (passed via stdin). */
export async function commit(cwd: string, message: string, options: CommitOptions = {}): Promise<GitCommandResult> {
	const args = ["commit", "-F", "-"];
	if (options.author) {
		args.push(`--author=${options.author.name} <${options.author.email}>`);
		if (options.author.date) args.push(`--date=${options.author.date}`);
	}
	if (options.allowEmpty) args.push("--allow-empty");
	if (options.amend) args.push("--amend");
	if (options.files?.length) args.push("--", ...options.files);
	return runChecked(cwd, args, { signal: options.signal, stdin: message });
}

/** Push the current branch (branch-scoped: never follows tags). */
export async function push(cwd: string, options: PushOptions = {}): Promise<void> {
	// `--no-follow-tags` overrides a user's `push.followTags = true`, which
	// would otherwise ride every reachable annotated tag along with the
	// branch — rejected refs ("permission denied") on remotes the user
	// cannot tag (e.g. PR-head forks), failing the call after the branch
	// itself already updated. Tool pushes push exactly the named refspec.
	const args = ["push", "--no-follow-tags"];
	if (options.forceWithLease) args.push("--force-with-lease");
	if (options.remote) args.push(options.remote);
	if (options.refspec) args.push(options.refspec);
	await runEffect(cwd, args, { signal: options.signal });
}

/** Checkout a ref. */
export async function checkout(cwd: string, ref: string, signal?: AbortSignal): Promise<void> {
	await runEffect(cwd, ["checkout", ref], { signal });
}

/** Fetch a specific refspec from a remote. Network transfer: defaults to the {@link GIT_NETWORK_TIMEOUT_MS} deadline. */
export async function fetch(
	cwd: string,
	remote: string,
	source: string,
	target: string,
	options: FetchOptions = {},
): Promise<void> {
	await runEffect(cwd, ["fetch", remote, `+${source}:${target}`], {
		signal: options.signal,
		timeoutMs: resolveTimeoutMs(options.timeoutMs, GIT_NETWORK_TIMEOUT_MS),
	});
}

/** Read a tree-ish into the index. */
export async function readTree(
	cwd: string,
	treeish: string,
	options: Pick<CommandOptions, "env" | "signal"> = {},
): Promise<void> {
	await runEffect(cwd, ["read-tree", treeish], options);
}

/** Write the current index as a tree and return its object id. */
export async function writeTree(cwd: string, options: Pick<CommandOptions, "env" | "signal"> = {}): Promise<string> {
	return (await runText(cwd, ["write-tree"], options)).trim();
}

// ════════════════════════════════════════════════════════════════════════════
// API: worktree isolation
// ════════════════════════════════════════════════════════════════════════════

/** Outcome of {@link detachGitDir}. */
export type DetachGitDirResult =
	/** `worktreeRoot` had no `.git`; nothing to detach. */
	| "no-git"
	/** `.git` already resolves to an independent object DB — left untouched. */
	| "independent"
	/** Detached into a standalone repo borrowing `sourceCommonDir`'s objects. */
	| "detached";

/**
 * Sever a copied/mounted working tree from the git metadata it shares with a
 * source checkout, turning it into a standalone repository that borrows the
 * source object database through `objects/info/alternates`.
 *
 * Isolation backends (reflink/apfs/btrfs/rcopy…) materialise `merged` by
 * copying `worktreeRoot` byte-for-byte. When `worktreeRoot` is a **linked git
 * worktree** its `.git` is a pointer file (`gitdir: …/worktrees/<name>`), so
 * the copy still resolves HEAD/index/refs through the source repo — a task's
 * `git checkout`/`commit` inside the isolation then mutates the *parent*
 * checkout. The rcopy `git worktree add` path leaks the other way: task
 * branches land in the shared ref namespace and stack on each other.
 *
 * After detaching, the working tree keeps its files verbatim while:
 * - HEAD, refs, and the index are frozen to the snapshot at call time;
 * - all commits/branches the task creates stay private to the isolation;
 * - objects resolve against `sourceCommonDir` via alternates, so history reads
 *   and later `git fetch <merged>` object transfer keep working;
 * - the source checkout's HEAD, branch, index, and working tree are untouched.
 *
 * A full-copy `.git` (non-worktree source) already owns its object DB and is
 * returned as `"independent"` without modification. `worktreeRoot` without a
 * `.git` yields `"no-git"`.
 */
export async function detachGitDir(worktreeRoot: string, sourceCommonDir: string): Promise<DetachGitDirResult> {
	ensureAvailable();
	const gitEntry = path.join(worktreeRoot, ".git");
	let entryStat: fs.Stats;
	try {
		entryStat = await fs.promises.lstat(gitEntry);
	} catch (err) {
		if (isEnoent(err)) return "no-git";
		throw err;
	}
	// Canonicalize both sides before comparing: `rev-parse` resolves symlinks
	// (macOS `/tmp` → `/private/tmp`) while callers derive `sourceCommonDir`
	// lexically from the session cwd. A lexical mismatch here would silently
	// classify a shared linked-worktree copy as "independent" and skip the
	// detach entirely — leaving the parent-mutation leak in place.
	const parentCommon = await fs.promises.realpath(sourceCommonDir).catch(() => path.resolve(sourceCommonDir));
	const isoCommonRaw = (
		await runText(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			readOnly: true,
		})
	).trim();
	const isoCommon = await fs.promises.realpath(isoCommonRaw).catch(() => path.resolve(isoCommonRaw));
	// A full-copy `.git` already resolves to its own object DB — leave it alone.
	if (isoCommon !== parentCommon) return "independent";

	// Snapshot the state the standalone repo must preserve. HEAD may be a branch
	// ref (normal checkout), detached, or unborn (a fresh/orphan branch with no
	// commits — a linked worktree still shares the parent ref namespace, so it
	// must be severed too). Refs are frozen so `baseSha..branch` ranges and
	// history reads keep resolving after the source moves on.
	const headSha = (await tryText(worktreeRoot, ["rev-parse", "HEAD"], { readOnly: true }))?.trim() ?? "";
	const headRef = (await tryText(worktreeRoot, ["symbolic-ref", "-q", "HEAD"], { readOnly: true }))?.trim() ?? "";
	const refDump = headSha
		? (
				await runText(worktreeRoot, ["for-each-ref", "--format=%(objectname) %(refname)"], {
					readOnly: true,
				})
			).trim()
		: "";
	const objectFormat =
		(await tryText(worktreeRoot, ["rev-parse", "--show-object-format"], { readOnly: true }))?.trim() || "sha1";
	const userName = await config.get(worktreeRoot, "user.name");
	const userEmail = await config.get(worktreeRoot, "user.email");

	// Preserve the index verbatim rather than round-tripping through
	// write-tree/read-tree: the raw index carries skip-worktree bits (sparse
	// checkout), assume-unchanged flags, and exact stage entries. A rebuilt
	// index drops skip-worktree, so files intentionally absent from a sparse
	// working tree would read as deletions and delta capture would apply those
	// deletions back to the parent. Sparse config + patterns are carried too so
	// later git operations in the isolation keep honouring the sparse view.
	const indexPath = (
		await runText(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
			readOnly: true,
		})
	).trim();
	const indexBytes = await readOptionalBytes(indexPath);
	const sparseCheckout = await config.get(worktreeRoot, "core.sparseCheckout");
	const sparseCone = await config.get(worktreeRoot, "core.sparseCheckoutCone");
	const sparsePatternPath = (
		await runText(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"], {
			readOnly: true,
		})
	).trim();
	const sparsePatterns = await readOptionalText(sparsePatternPath);
	// Status parity with the source: an explicit core.filemode (e.g. false on
	// mounts ignoring the executable bit) must carry over, or the re-inited
	// repo's platform default makes clean files read as mode-changed and delta
	// capture would apply bogus chmod diffs back to the parent.
	const fileMode = await config.get(worktreeRoot, "core.fileMode");
	// A split index references sharedindex.* files beside the source index;
	// restoring the raw index without them makes every git read fail. Carry the
	// shared files (and the config) alongside the verbatim index bytes.
	const splitIndex = await config.get(worktreeRoot, "core.splitIndex");
	const sharedIndexFiles: Array<{ name: string; bytes: Uint8Array }> = [];
	if (indexBytes) {
		const indexDir = path.dirname(indexPath);
		let entries: string[] = [];
		try {
			entries = await fs.promises.readdir(indexDir);
		} catch {}
		for (const name of entries) {
			if (!name.startsWith("sharedindex.")) continue;
			const bytes = await readOptionalBytes(path.join(indexDir, name));
			if (bytes) sharedIndexFiles.push({ name, bytes });
		}
	}
	// A shallow source deliberately lacks parents beyond its `shallow` boundary
	// file; without it, history traversal over the borrowed objects treats the
	// boundary commit's missing parent as corruption.
	const shallowBoundary = await readOptionalText(path.join(parentCommon, "shallow"));

	// A pointer `.git` file whose worktree-admin dir back-references this exact
	// tree is the rcopy `git worktree add` registration. Remove that admin entry
	// so the source repo's worktree list stops tracking the isolation. A pointer
	// referencing the *source's* admin (a copied linked-worktree `.git`) is not
	// ours to delete — only the local pointer file is discarded. Compare via
	// realpath: git canonicalizes the back-reference (e.g. macOS `/var` →
	// `/private/var`), so a lexical path comparison would miss the match and
	// leave a stale registration in the source repo's worktree list.
	let ownWorktreeAdmin: string | undefined;
	if (entryStat.isFile()) {
		const pointer = parseGitDirPointer((await readOptionalText(gitEntry)) ?? "");
		if (pointer) {
			const adminDir = path.resolve(path.dirname(gitEntry), pointer);
			const backRef = (await readOptionalText(path.join(adminDir, "gitdir")))?.trim();
			if (backRef) {
				const [realBackRef, realGitEntry] = await Promise.all([
					fs.promises.realpath(backRef).catch(() => path.resolve(backRef)),
					fs.promises.realpath(gitEntry).catch(() => path.resolve(gitEntry)),
				]);
				if (realBackRef === realGitEntry) ownWorktreeAdmin = adminDir;
			}
		}
	}

	await fs.promises.rm(gitEntry, { recursive: true, force: true });
	if (ownWorktreeAdmin) await fs.promises.rm(ownWorktreeAdmin, { recursive: true, force: true });

	// Preserve the checked-out branch name so an unborn HEAD (fresh/orphan
	// branch with no commits) keeps its symbolic ref after `init` rather than
	// snapping to the init default; born HEADs get the ref rewritten below anyway.
	const initArgs = ["init", "--object-format", objectFormat, "-q"];
	const initialBranch = headRef.startsWith(LOCAL_BRANCH_PREFIX) ? headRef.slice(LOCAL_BRANCH_PREFIX.length) : "";
	if (initialBranch) initArgs.push("-b", initialBranch);
	await runEffect(worktreeRoot, initArgs);
	const objectsInfo = path.join(gitEntry, "objects", "info");
	await fs.promises.mkdir(objectsInfo, { recursive: true });
	const alternates = [path.join(parentCommon, "objects")];
	const chained = await readOptionalText(path.join(parentCommon, "objects", "info", "alternates"));
	if (chained) {
		for (const line of chained.split("\n")) {
			const entry = line.trim();
			if (!entry) continue;
			alternates.push(path.isAbsolute(entry) ? entry : path.resolve(parentCommon, "objects", entry));
		}
	}
	await Bun.write(path.join(objectsInfo, "alternates"), `${alternates.join("\n")}\n`);

	// Freeze refs when HEAD is born. Point HEAD at the raw SHA first so
	// `update-ref` writes land even for the branch HEAD currently names, then
	// restore the symbolic HEAD. An unborn HEAD has no refs to freeze; `init -b`
	// above already set the symbolic HEAD to the unborn branch.
	if (headSha) {
		await Bun.write(path.join(gitEntry, "HEAD"), `${headSha}\n`);
		if (refDump) {
			const commands = refDump
				.split("\n")
				.filter(Boolean)
				.map(line => {
					const sep = line.indexOf(" ");
					return `create ${line.slice(sep + 1)} ${line.slice(0, sep)}`;
				})
				.join("\n");
			await runEffect(worktreeRoot, ["update-ref", "--stdin"], { stdin: `${commands}\n` });
		}
		if (headRef) await Bun.write(path.join(gitEntry, "HEAD"), `ref: ${headRef}\n`);
	} else if (headRef && !initialBranch) {
		// Unborn detached HEAD (no branch, no commit) — restore the raw ref target.
		await Bun.write(path.join(gitEntry, "HEAD"), `ref: ${headRef}\n`);
	}

	// Carry the source identity so isolated commits have an author.
	if (userName) await config.set(worktreeRoot, "user.name", userName);
	if (userEmail) await config.set(worktreeRoot, "user.email", userEmail);
	if (fileMode !== undefined) await config.set(worktreeRoot, "core.fileMode", fileMode);
	if (splitIndex !== undefined) await config.set(worktreeRoot, "core.splitIndex", splitIndex);
	// Preserve the shallow boundary so history traversal over the borrowed
	// object DB stops at the boundary instead of failing on missing parents.
	if (shallowBoundary !== null) await Bun.write(path.join(gitEntry, "shallow"), shallowBoundary);

	// Restore sparse-checkout state before the index so skip-worktree entries
	// keep resolving against the carried patterns.
	if (sparseCheckout) await config.set(worktreeRoot, "core.sparseCheckout", sparseCheckout);
	if (sparseCone) await config.set(worktreeRoot, "core.sparseCheckoutCone", sparseCone);
	if (sparsePatterns !== null) {
		const infoDir = path.join(gitEntry, "info");
		await fs.promises.mkdir(infoDir, { recursive: true });
		await Bun.write(path.join(infoDir, "sparse-checkout"), sparsePatterns);
	}

	// Restore the index verbatim (skip-worktree, assume-unchanged, exact stage
	// entries) so the working tree's dirty set — including sparse-excluded files
	// — matches the source. Fall back to rebuilding from HEAD only when the
	// source had no index (a bare-ish/never-staged checkout).
	if (indexBytes) {
		for (const shared of sharedIndexFiles) {
			await Bun.write(path.join(gitEntry, shared.name), shared.bytes);
		}
		await Bun.write(path.join(gitEntry, "index"), indexBytes);
	} else if (headSha) {
		await readTree(worktreeRoot, headSha);
	}
	return "detached";
}

// ════════════════════════════════════════════════════════════════════════════
// API: show
// ════════════════════════════════════════════════════════════════════════════

/** Run `git show` on a revision. */
export const show = Object.assign(
	async function show(cwd: string, revision: string, options: GitShowStreamOptions = {}): Promise<string> {
		return runText(cwd, ["show", `--format=${options.format ?? ""}`, revision], {
			maxOutputBytes: options.maxOutputBytes,
			readOnly: true,
			signal: options.signal,
		});
	},
	{
		/** Stream raw `git show` stdout chunks without constructing one JS string. */
		stream(cwd: string, revision: string, options: GitShowStreamOptions = {}): AsyncGenerator<Uint8Array> {
			return runByteStream(cwd, ["show", `--format=${options.format ?? ""}`, revision], {
				maxOutputBytes: options.maxOutputBytes,
				readOnly: true,
				signal: options.signal,
			});
		},
		/** Get the path prefix of the current directory relative to the repo root. */
		async prefix(cwd: string, signal?: AbortSignal): Promise<string> {
			return (await runText(cwd, ["rev-parse", "--show-prefix"], { readOnly: true, signal })).trim();
		},
	},
);

/** Resolve Git LFS's local object directory without downloading content. */
export const lfs = {
	/**
	 * Return the repository's Git LFS media directory. Uses `git lfs env` when
	 * available so custom storage is honored, then falls back to `.git/lfs/objects`.
	 */
	async mediaDir(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const environment = await tryText(cwd, ["lfs", "env"], { readOnly: true, signal });
		const configured = environment
			?.split("\n")
			.find(line => line.startsWith("LocalMediaDir="))
			?.slice("LocalMediaDir=".length)
			.trim();
		if (configured) return path.resolve(cwd, configured);
		const repository = await resolveRepository(cwd);
		return repository ? path.join(repository.commonDir, "lfs", "objects") : null;
	},
};
/** Read commit message and author metadata for replay/rewrite flows. */
export async function commitDetails(cwd: string, revision: string, signal?: AbortSignal): Promise<CommitDetails> {
	const raw = await runText(cwd, ["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B", revision], {
		readOnly: true,
		signal,
	});
	const [sha = "", parentsRaw = "", name = "", email = "", date = "", ...messageParts] = raw.split("\0");
	return {
		author: { date, email, name },
		message: messageParts.join("\0").replace(/\n$/, ""),
		parents: parentsRaw.split(" ").filter(Boolean),
		sha,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// API: log
// ════════════════════════════════════════════════════════════════════════════

export const log = {
	/** Recent commit subjects (one-line each). */
	async subjects(cwd: string, count: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["log", `-n${count}`, "--pretty=format:%s"], { readOnly: true, signal }));
	},
	/** Recent commits as `<short-sha> <subject>` onelines. */
	async onelines(cwd: string, count: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(cwd, ["log", `-${count}`, "--oneline", "--no-decorate"], { readOnly: true, signal }),
		);
	},
};

export const revList = {
	/** Commits in `base..head`, oldest first. */
	async range(cwd: string, base: string, head: string, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["rev-list", "--reverse", `${base}..${head}`], { readOnly: true, signal }));
	},
	/** Commits reachable from `ref` that touched `file`, newest first, capped at `limit`. */
	async touching(cwd: string, ref: string, file: string, limit: number, signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(cwd, ["rev-list", `--max-count=${limit}`, ref, "--", file], { readOnly: true, signal }),
		);
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: branch
// ════════════════════════════════════════════════════════════════════════════

export const branch = {
	/** Current branch name, or null if detached/unavailable. */
	async current(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const headState = await resolveHead(cwd);
		if (headState?.kind === "ref") return headState.branchName ?? headState.ref;
		const result = await git(cwd, ["symbolic-ref", "--short", "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	/** Default branch name (from remote HEAD refs). */
	async default(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) {
			for (const refPath of DEFAULT_BRANCH_REFS) {
				const target = await readRef(repository, refPath, signal);
				const branchName = parseDefaultBranchRef(refPath, target);
				if (branchName) return branchName;
			}
		}
		for (const remoteRef of ["origin/HEAD", "upstream/HEAD"]) {
			const result = await git(cwd, ["rev-parse", "--abbrev-ref", remoteRef], { readOnly: true, signal });
			if (result.exitCode !== 0) continue;
			const branchName = stripRemotePrefix(result.stdout.trim());
			if (branchName) return branchName;
		}
		return null;
	},

	/** Create a new branch at the given start point. */
	async create(cwd: string, name: string, startPoint = "HEAD", signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["branch", name, startPoint], { signal });
	},

	/** Force-move a branch to a new start point. */
	async force(cwd: string, name: string, startPoint: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["branch", "--force", name, startPoint], { signal });
	},

	/** Delete a branch. Throws on failure. */
	async delete(cwd: string, name: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		await runEffect(cwd, ["branch", options.force === false ? "-d" : "-D", name], { signal: options.signal });
	},

	/** Delete a branch. Returns false on failure instead of throwing. */
	async tryDelete(
		cwd: string,
		name: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<boolean> {
		const result = await git(cwd, ["branch", options.force === false ? "-d" : "-D", name], {
			signal: options.signal,
		});
		return result.exitCode === 0;
	},

	/** Create and checkout a new branch. */
	async checkoutNew(cwd: string, name: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["checkout", "-b", name], { signal });
	},

	/** List branches. Pass `{ all: true }` to include remotes. */
	async list(cwd: string, options: { all?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
		const args = ["branch"];
		if (options.all) args.push("-a");
		args.push("--format=%(refname:short)");
		return splitLines(await runText(cwd, args, { readOnly: true, signal: options.signal }));
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: remote
// ════════════════════════════════════════════════════════════════════════════

export const remote = {
	/** List remote names. */
	async list(cwd: string, signal?: AbortSignal): Promise<string[]> {
		return splitLines(await runText(cwd, ["remote"], { readOnly: true, signal }));
	},

	/** Get the URL for a remote. */
	async url(cwd: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
		return trimScalar(await tryText(cwd, ["remote", "get-url", name], { readOnly: true, signal }));
	},

	/**
	 * Add a remote pointing at `url`. Idempotent: if a remote named `name`
	 * already exists with the same URL (e.g. an in-process race or a leftover
	 * remote from a previous run), this is treated as success. Throws when the
	 * remote exists with a different URL — that's a real conflict the caller
	 * needs to resolve, not paper over.
	 */
	async add(cwd: string, name: string, url: string, signal?: AbortSignal): Promise<void> {
		const result = await git(cwd, ["remote", "add", name, url], { signal });
		if (result.exitCode === 0) return;
		const existing = await remote.url(cwd, name, signal);
		if (existing !== undefined) {
			if (existing === url) return;
			throw new ToolError(`remote ${name} already exists with URL ${existing}, expected ${url}`);
		}
		throw new GitCommandError(["remote", "add", name, url], result);
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: ref
// ════════════════════════════════════════════════════════════════════════════

export const ref = {
	/** Check if a ref exists. */
	async exists(cwd: string, refName: string, signal?: AbortSignal): Promise<boolean> {
		if (refName === "HEAD") return (await head.sha(cwd, signal)) !== null;
		const repository = await resolveRepository(cwd);
		if (repository && refName.startsWith("refs/")) return (await readRef(repository, refName, signal)) !== null;
		const result = await git(cwd, ["show-ref", "--verify", "--quiet", refName], { readOnly: true, signal });
		return result.exitCode === 0;
	},

	/** Resolve a ref to its commit SHA. */
	async resolve(cwd: string, refName: string, signal?: AbortSignal): Promise<string | null> {
		if (refName === "HEAD") return head.sha(cwd, signal);
		const repository = await resolveRepository(cwd);
		if (repository && refName.startsWith("refs/")) return readRef(repository, refName, signal);
		const result = await git(cwd, ["rev-parse", refName], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	/** Tags pointing at a ref. */
	async tags(cwd: string, refName = "HEAD", signal?: AbortSignal): Promise<string[]> {
		return splitLines(
			await runText(
				cwd,
				[
					"for-each-ref",
					"--points-at",
					refName,
					"--sort=-version:refname",
					"--format=%(refname:strip=2)",
					"refs/tags",
				],
				{ readOnly: true, signal },
			),
		);
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: config
// ════════════════════════════════════════════════════════════════════════════

export const config = {
	async get(cwd: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
		return trimScalar(await tryText(cwd, ["config", "--get", key], { readOnly: true, signal }));
	},

	async set(cwd: string, key: string, value: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["config", key, value], { signal });
	},

	async getBranch(cwd: string, branchName: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
		return config.get(cwd, `branch.${branchName}.${key}`, signal);
	},

	async setBranch(cwd: string, branchName: string, key: string, value: string, signal?: AbortSignal): Promise<void> {
		return config.set(cwd, `branch.${branchName}.${key}`, value, signal);
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: worktree
// ════════════════════════════════════════════════════════════════════════════

export const worktree = {
	async add(
		cwd: string,
		worktreePath: string,
		refName: string,
		options: { detach?: boolean; signal?: AbortSignal } = {},
	): Promise<void> {
		const args = ["worktree", "add"];
		if (options.detach) args.push("--detach");
		args.push(worktreePath, refName);
		await runEffect(cwd, args, { signal: options.signal });
	},

	async remove(
		cwd: string,
		worktreePath: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<void> {
		const args = ["worktree", "remove"];
		if (options.force ?? true) args.push("-f");
		args.push(worktreePath);
		await runEffect(cwd, args, { signal: options.signal });
	},

	async tryRemove(
		cwd: string,
		worktreePath: string,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<boolean> {
		const args = ["worktree", "remove"];
		if (options.force ?? true) args.push("-f");
		args.push(worktreePath);
		const result = await git(cwd, args, { signal: options.signal });
		return result.exitCode === 0;
	},

	async list(cwd: string, signal?: AbortSignal): Promise<GitWorktreeEntry[]> {
		return parseWorktreeList(await runText(cwd, ["worktree", "list", "--porcelain"], { readOnly: true, signal }));
	},

	async prune(cwd: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["worktree", "prune"], { signal });
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: patch
// ════════════════════════════════════════════════════════════════════════════

export const patch = {
	/** Apply a patch file. */
	async apply(cwd: string, patchPath: string, options: PatchOptions = {}): Promise<void> {
		await runEffect(cwd, buildApplyArgs(patchPath, options), { env: options.env, signal: options.signal });
	},

	/** Apply a patch from a string (writes to a temp file). */
	async applyText(cwd: string, patchText: string, options: PatchOptions = {}): Promise<void> {
		if (!patchText.trim()) return;
		const tempPath = await writeTempPatch(patchText);
		try {
			await patch.apply(cwd, tempPath, options);
		} finally {
			await fs.promises.rm(tempPath, { force: true });
		}
	},

	/** Check if a patch file can be applied cleanly. */
	async canApply(cwd: string, patchPath: string, options: Omit<PatchOptions, "check"> = {}): Promise<boolean> {
		const result = await git(cwd, buildApplyArgs(patchPath, { ...options, check: true }), {
			env: options.env,
			readOnly: true,
			signal: options.signal,
		});
		return result.exitCode === 0;
	},

	/** Check if a patch string can be applied cleanly. */
	async canApplyText(cwd: string, patchText: string, options: Omit<PatchOptions, "check"> = {}): Promise<boolean> {
		if (!patchText.trim()) return true;
		const tempPath = await writeTempPatch(patchText);
		try {
			return await patch.canApply(cwd, tempPath, options);
		} finally {
			await fs.promises.rm(tempPath, { force: true });
		}
	},

	/**
	 * Join patch parts into a single patch string.
	 *
	 * Each part is terminated with a single `\n` if it lacks one, then parts are
	 * concatenated verbatim — matching git's native multi-file diff layout. Parts
	 * are NOT separated by an extra blank line and trailing newlines are NOT
	 * stripped: a `GIT binary patch` block ends in a blank line that
	 * `git apply --binary` requires, and stripping it corrupts the patch (#8899).
	 */
	join(parts: string[]): string {
		return parts.map(part => (part.endsWith("\n") ? part : `${part}\n`)).join("");
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: cherryPick
// ════════════════════════════════════════════════════════════════════════════

export const cherryPick = Object.assign(
	async function cherryPick(cwd: string, revision: string, signal?: AbortSignal): Promise<void> {
		await runEffect(cwd, ["cherry-pick", revision], { signal });
	},
	{
		async abort(cwd: string, signal?: AbortSignal): Promise<void> {
			await runEffect(cwd, ["cherry-pick", "--abort"], { signal });
		},
		/**
		 * Skip the current commit of an in-progress cherry-pick sequence and
		 * continue with the rest of the range. Use after {@link isEmptyError}
		 * reports the current attempt collapsed to a no-op — the alternative,
		 * `--abort`, throws away every remaining commit in the range.
		 */
		async skip(cwd: string, signal?: AbortSignal): Promise<void> {
			await runEffect(cwd, ["cherry-pick", "--skip"], { signal });
		},
		/**
		 * True when a cherry-pick failure was caused by the current commit
		 * being empty against HEAD — either redundant with an already-applied
		 * change, or auto-resolved to HEAD by a 3-way merge. Callers should
		 * `--skip` in this case to advance the sequencer rather than aborting
		 * the whole range: an empty commit is not a merge conflict, and any
		 * later commits in the range still deserve to land.
		 */
		isEmptyError(err: unknown): boolean {
			return err instanceof GitCommandError && /the previous cherry-pick is now empty/i.test(err.result.stderr);
		},
	},
);

// ════════════════════════════════════════════════════════════════════════════
// API: stash
// ════════════════════════════════════════════════════════════════════════════

export const stash = {
	/** Stash working tree + index changes. Returns true when git created a new stash entry. */
	async push(cwd: string, message?: string): Promise<boolean> {
		ensureAvailable();
		const previousStash = await ref.resolve(cwd, "refs/stash");
		const args = ["stash", "push", "--include-untracked"];
		if (message) args.push("-m", message);
		await runEffect(cwd, args);
		const nextStash = await ref.resolve(cwd, "refs/stash");
		return nextStash !== null && nextStash !== previousStash;
	},
	/** Pop the most recent stash entry, optionally restoring its staged state. */
	async pop(cwd: string, options?: { index?: boolean }): Promise<void> {
		const args = ["stash", "pop"];
		if (options?.index) args.push("--index");
		await runEffect(cwd, args);
	},
	/**
	 * Return the working-tree patch that `stash@{0}` would apply, in a form
	 * that `git apply --check` can consume. Empty string when no stash entry
	 * exists or the stash contains no diffable working-tree changes.
	 */
	async showPatch(cwd: string): Promise<string> {
		return (await tryText(cwd, ["stash", "show", "-p", "--binary", "stash@{0}"], { readOnly: true })) ?? "";
	},
	/** Return untracked paths stored in the top stash entry. */
	async untrackedFiles(cwd: string): Promise<string[]> {
		const output = await tryText(cwd, ["ls-tree", "-r", "-z", "--name-only", "stash@{0}^3"], { readOnly: true });
		return output?.split("\0").filter(Boolean) ?? [];
	},
	/**
	 * Attempt to restore the top stash entry. On success returns `true` and
	 * git drops the stash entry. On conflict returns `false`, leaves the stash
	 * entry preserved for manual resolution, and guarantees the failed restore
	 * leaves no unmerged index entries or partially-restored untracked files.
	 *
	 * The historical raw `pop` catches the failure in a `finally` block and
	 * only logs — it leaves `.git/index` with stage 1/2/3 unmerged entries
	 * that survive indefinitely, corrupting every subsequent overlay-isolated
	 * task that reads through this repo's `.git/`. See issue #4175.
	 */
	async tryPop(cwd: string, options?: { index?: boolean }): Promise<boolean> {
		// Preflight: `git stash pop` internally does a 3-way merge, so a plain
		// `git apply --check` is too strict — it rejects hunks whose context
		// drifted from HEAD even when 3-way merge would resolve them cleanly.
		// Match pop's semantics with `--3way --check`, which succeeds iff the
		// patch either applies directly or merges without conflict against
		// the patch's `index abc..def` base blobs.
		const workingPatch = await stash.showPatch(cwd);
		if (workingPatch.trim() && !(await patch.canApplyText(cwd, workingPatch, { threeWay: true }))) {
			return false;
		}
		const restoredUntracked = await stash.untrackedFiles(cwd);
		try {
			await stash.pop(cwd, options);
			return true;
		} catch {
			// Preflight can still miss mode-only or delete/modify conflicts. If
			// the pop left unmerged entries, wipe them: HEAD holds the merged
			// state so `reset --hard HEAD` restores a clean index and working
			// tree without losing the cherry-picked commits. A failed pop can
			// still restore unrelated untracked files before exiting while
			// preserving the stash entry, so clean only the untracked paths
			// recorded in that stash. The user's WIP remains recoverable via
			// `git stash pop`.
			try {
				await reset(cwd, { hard: true });
			} catch {
				/* best-effort cleanup — do not mask the primary conflict */
			}
			if (restoredUntracked.length > 0) {
				try {
					await clean(cwd, { includeIgnored: true, literalPathspecs: true, paths: restoredUntracked });
				} catch {
					/* best-effort cleanup — do not mask the primary conflict */
				}
			}
			return false;
		}
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: clone, restore, clean
// ════════════════════════════════════════════════════════════════════════════

export async function clone(url: string, targetDir: string, options: CloneOptions = {}): Promise<void> {
	ensureAvailable();
	const absoluteTarget = path.resolve(targetDir);
	await fs.promises.mkdir(path.dirname(absoluteTarget), { recursive: true });

	// `git clone --depth 1 --single-branch` only fetches the tip of the target
	// branch, so any subsequent `git checkout <sha>` for a non-tip commit fails
	// with "reference is not a tree". When the caller pinned a specific SHA we
	// fall back to a full clone so the object is guaranteed to be present.
	const shallow = !options.sha;
	const args = ["clone"];
	if (shallow) args.push("--depth", "1");
	if (options.ref) args.push("--branch", options.ref, "--single-branch");
	else if (shallow) args.push("--single-branch");
	args.push(url, absoluteTarget);

	try {
		await runEffect(path.dirname(absoluteTarget), args, {
			signal: options.signal,
			timeoutMs: resolveTimeoutMs(options.timeoutMs, GIT_NETWORK_TIMEOUT_MS),
		});
		if (options.sha) {
			try {
				await checkout(absoluteTarget, options.sha, options.signal);
			} catch {
				await fs.promises.rm(absoluteTarget, { force: true, recursive: true });
				throw new Error(`Failed to checkout SHA ${options.sha} in cloned repository ${url}`);
			}
		}
	} catch (err) {
		await fs.promises.rm(absoluteTarget, { force: true, recursive: true });
		throw err;
	}
}

export async function restore(cwd: string, options: RestoreOptions = {}): Promise<void> {
	const args = ["restore"];
	if (options.source) args.push(`--source=${options.source}`);
	if (options.staged) args.push("--staged");
	if (options.worktree) args.push("--worktree");
	if (options.files?.length) args.push("--", ...options.files);
	await runEffect(cwd, args, { signal: options.signal });
}

/**
 * Run `git reset` with options. Default is a soft reset (no flag); pass `hard: true` for a destructive reset.
 *
 * NOTE: stage.reset() handles the per-file unstaging case. This helper exists for tree-wide resets.
 */
export async function reset(
	cwd: string,
	options: { hard?: boolean; mixed?: boolean; soft?: boolean; target?: string; signal?: AbortSignal } = {},
): Promise<void> {
	const args = ["reset"];
	if (options.hard) args.push("--hard");
	else if (options.mixed) args.push("--mixed");
	else if (options.soft) args.push("--soft");
	if (options.target) args.push(options.target);
	await runEffect(cwd, args, { signal: options.signal });
}

export async function clean(
	cwd: string,
	options: {
		ignoredOnly?: boolean;
		includeIgnored?: boolean;
		literalPathspecs?: boolean;
		paths?: readonly string[];
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const args = [options.literalPathspecs ? "--literal-pathspecs" : undefined, "clean"].filter(
		(arg): arg is string => arg !== undefined,
	);
	args.push(options.ignoredOnly ? "-fdX" : options.includeIgnored ? "-fdx" : "-fd");
	if (options.paths?.length) args.push("--", ...options.paths);
	await runEffect(cwd, args, { signal: options.signal });
}

// ════════════════════════════════════════════════════════════════════════════
// API: ls
// ════════════════════════════════════════════════════════════════════════════

export const ls = {
	/** List files tracked or untracked by git. */
	async files(
		cwd: string,
		options: { others?: boolean; excludeStandard?: boolean; signal?: AbortSignal } = {},
	): Promise<string[]> {
		const args = ["ls-files"];
		if (options.others) args.push("--others");
		if (options.excludeStandard) args.push("--exclude-standard");
		return splitLines(await runText(cwd, args, { readOnly: true, signal: options.signal }));
	},

	/** List untracked files (excludes ignored). */
	async untracked(cwd: string, signal?: AbortSignal): Promise<string[]> {
		return ls.files(cwd, { others: true, excludeStandard: true, signal });
	},

	/** List paths present in a ref, optionally filtered to specific paths. */
	async tree(cwd: string, ref: string, files: readonly string[] = [], signal?: AbortSignal): Promise<string[]> {
		const args = ["ls-tree", "--name-only", "-r", "-z", ref];
		if (files.length > 0) args.push("--", ...files);
		const raw = await runText(cwd, args, { readOnly: true, signal });
		return raw.split("\0").filter(entry => entry.length > 0);
	},

	/** List submodule paths (recursive). */
	async submodules(cwd: string, signal?: AbortSignal): Promise<string[]> {
		const output = await git(cwd, ["submodule", "--quiet", "foreach", "--recursive", "echo $sm_path"], {
			readOnly: true,
			signal,
		});
		return splitLines(output.stdout);
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: head
// ════════════════════════════════════════════════════════════════════════════

export const head = {
	/** Full HEAD state (branch, commit, repo info). */
	async resolve(cwd: string, signal?: AbortSignal): Promise<GitHeadState | null> {
		const repository = await resolveRepository(cwd);
		if (!repository) return null;
		if (await isReftableRepo(repository)) {
			return resolveHeadStateReftable(repository, signal);
		}
		const content = await readOptionalText(repository.headPath);
		if (content === null) return null;
		return parseHeadState(repository, content);
	},

	/** Full HEAD state (synchronous). */
	resolveSync(cwd: string): GitHeadState | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository) return null;
		if (isReftableRepoSync(repository)) {
			return resolveHeadStateReftableSync(repository);
		}
		const content = readOptionalTextSync(repository.headPath);
		if (content === null) return null;
		return parseHeadStateSync(repository, content);
	},

	/** Current HEAD commit SHA. */
	async sha(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const headState = await head.resolve(cwd, signal);
		if (headState?.commit) return headState.commit;
		const result = await git(cwd, ["rev-parse", "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	/** Abbreviated HEAD commit SHA. */
	async short(cwd: string, length = 7, signal?: AbortSignal): Promise<string | null> {
		const result = await git(cwd, ["rev-parse", `--short=${length}`, "HEAD"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	/**
	 * Watch the repository's HEAD for branch moves. Returns a disposer.
	 *
	 * Deliberately stat-polls via `fs.watchFile` instead of `fs.watch`: git
	 * swaps HEAD with `HEAD.lock` + atomic rename, which unlinks the HEAD inode
	 * — and Bun's inotify-backed `fs.watch` permanently stops delivering events
	 * after observing a rename in the watched directory (oven-sh/bun#24875), so
	 * an event watcher fires once and then freezes on Linux (issue #8412 was
	 * the same freeze for file-inode watches on every platform). A path-based
	 * stat poll re-resolves the path each interval and survives inode swaps
	 * everywhere. Reftable repos keep ref state in `<gitDir>/reftable` (their
	 * HEAD file is a static stub), so the poll targets that directory instead.
	 */
	watch(repository: GitRepository, onChange: () => void): () => void {
		const target = isReftableRepoSync(repository) ? path.join(repository.gitDir, "reftable") : repository.headPath;
		const listener = (curr: fs.Stats, prev: fs.Stats) => {
			if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
		};
		fs.watchFile(target, { interval: HEAD_WATCH_INTERVAL_MS }, listener).unref();
		return () => fs.unwatchFile(target, listener);
	},
};

// ════════════════════════════════════════════════════════════════════════════
// API: repo
// ════════════════════════════════════════════════════════════════════════════

export const repo = {
	/** Resolve the repository root (may be a worktree root). */
	async root(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) return repository.repoRoot;
		const result = await git(cwd, ["rev-parse", "--show-toplevel"], { readOnly: true, signal });
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	},

	/** Resolve the primary checkout root, or the shared common dir for bare-repo worktrees. */
	async primaryRoot(cwd: string, signal?: AbortSignal): Promise<string | null> {
		const repository = await resolveRepository(cwd);
		if (repository) return primaryRootFromRepository(repository);
		const repoRoot = await repo.root(cwd, signal);
		if (!repoRoot) return null;
		const commonDir = await runText(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			readOnly: true,
			signal,
		});
		if (path.basename(commonDir.trim()) === ".git") return path.dirname(commonDir.trim());
		return repoRoot;
	},

	/**
	 * Sync sibling of {@link primaryRoot}. Resolves only via on-disk `.git`/
	 * `commondir` walking — no subprocess fallback — so it stays usable from
	 * paths where async I/O is impractical (e.g. `computeBankScope`). Returns
	 * `null` when `cwd` is outside a repository. Bare-repo worktrees resolve to
	 * the shared common dir (`foo.git`) because they have no primary checkout.
	 */
	primaryRootSync(cwd: string): string | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository) return null;
		return primaryRootFromRepositorySync(repository);
	},

	/**
	 * Linked-worktree metadata for `cwd`, or `null` when `cwd` is the primary
	 * checkout (or outside a repository). `root` is the worktree's own checkout
	 * root; `primaryRoot` is the shared main checkout that names the project.
	 * Resolves purely via on-disk `.git`/`commondir` walking — no subprocess —
	 * so the status line may call it on every render.
	 */
	linkedWorktreeSync(cwd: string): { root: string; primaryRoot: string } | null {
		const repository = resolveRepositorySync(cwd);
		if (!repository || !isLinkedWorktree(repository)) return null;
		return { root: repository.repoRoot, primaryRoot: primaryRootFromRepositorySync(repository) };
	},

	/** Full GitRepository metadata (sync). */
	resolveSync(cwd: string): GitRepository | null {
		return resolveRepositorySync(cwd);
	},

	/** Full GitRepository metadata. */
	resolve(cwd: string): Promise<GitRepository | null> {
		return resolveRepository(cwd);
	},

	/** Check if the repository uses the reftable reference storage format (sync). */
	isReftableSync(repository: GitRepository): boolean {
		return isReftableRepoSync(repository);
	},

	/** Check if the repository uses the reftable reference storage format. */
	isReftable(repository: GitRepository): Promise<boolean> {
		return isReftableRepo(repository);
	},
};

// Helper used during head resolution — defined here to reference `head` namespace.
async function resolveHead(cwd: string, signal?: AbortSignal): Promise<GitHeadState | null> {
	return head.resolve(cwd, signal);
}

// ════════════════════════════════════════════════════════════════════════════
// API: github (GitHub CLI)
// ════════════════════════════════════════════════════════════════════════════

export interface GhCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GhCommandOptions {
	repoProvided?: boolean;
	trimOutput?: boolean;
}

function formatGhFailure(args: readonly string[], stdout: string, stderr: string, options?: GhCommandOptions): string {
	const message = (stderr || stdout).trim();
	if (message.includes("gh auth login") || message.includes("not logged into any GitHub hosts")) {
		return "GitHub CLI is not authenticated. Run `gh auth login`.";
	}
	if (
		!options?.repoProvided &&
		(message.includes("not a git repository") ||
			message.includes("no git remotes found") ||
			message.includes("unable to determine current repository"))
	) {
		return "GitHub repository context is unavailable. Pass `repo` explicitly or run the tool inside a GitHub checkout.";
	}
	if (message.length > 0) return message;
	return `GitHub CLI command failed: gh ${args.join(" ")}`;
}

export const github = {
	/** Check if `gh` CLI is installed. */
	available(): boolean {
		return Boolean($which("gh"));
	},

	/** Run a raw `gh` CLI command. Does not throw on non-zero exit. */
	async run(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<GhCommandResult> {
		throwIfAborted(signal);
		if (!$which("gh")) {
			throw new ToolError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.");
		}
		try {
			const child = Bun.spawn(["gh", ...args], {
				cwd,
				env: buildGhEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				signal,
			});
			const { stdout, stderr, exitCode } = await collectSubprocessResult("gh", args, child, {});
			throwIfAborted(signal);
			const trim = options?.trimOutput !== false;
			return {
				exitCode: exitCode ?? 0,
				stdout: trim ? stdout.trim() : stdout,
				stderr: trim ? stderr.trim() : stderr,
			};
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError();
			throw error;
		}
	},

	/** Run `gh` and parse stdout as JSON. Throws on non-zero exit or invalid JSON. */
	async json<T>(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<T> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		}
		if (!result.stdout) {
			throw new ToolError("GitHub CLI returned empty output.");
		}
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new ToolError("GitHub CLI returned invalid JSON output.");
		}
	},

	/** Run `gh` and return stdout as text. Throws on non-zero exit. */
	async text(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<string> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		}
		return result.stdout;
	},
};
