import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, hasFsCode, isEisdir, isEnoent, isEnotdir, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import {
	parseDiffHunks as parseCommitDiffHunks,
	parseFileDiffs,
	parseFileHunks,
	parseNumstat,
} from "../commit/git/diff";
import type { FileDiff, FileHunks, NumstatEntry } from "../commit/types";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
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
export interface HunkSelectionValidationError {
	readonly path: string;
	readonly message: string;
}

export interface DiffOptions {
	readonly allowFailure?: boolean;
	readonly base?: string;
	readonly binary?: boolean;
	readonly cached?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly files?: readonly string[];
	readonly head?: string;
	readonly nameOnly?: boolean;
	readonly noIndex?: { left: string; right: string };
	readonly numstat?: boolean;
	readonly signal?: AbortSignal;
	readonly stat?: boolean;
}

export interface StatusOptions {
	readonly pathspecs?: readonly string[];
	readonly porcelainV1?: boolean;
	readonly signal?: AbortSignal;
	readonly untrackedFiles?: "all" | "no" | "normal";
	readonly z?: boolean;
}

export interface CommitOptions {
	readonly allowEmpty?: boolean;
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
	readonly signal?: AbortSignal;
}

export interface RestoreOptions {
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
	readonly source?: string;
	readonly staged?: boolean;
	readonly worktree?: boolean;
}

export interface CloneOptions {
	readonly ref?: string;
	readonly sha?: string;
	readonly signal?: AbortSignal;
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
const REMOTE_ALREADY_EXISTS = /remote .* already exists/i;

interface CommandOptions {
	readonly env?: Record<string, string | undefined>;
	readonly readOnly?: boolean;
	readonly signal?: AbortSignal;
	readonly stdin?: string | Uint8Array | ArrayBuffer | SharedArrayBuffer;
}

function normalizeStdin(input: CommandOptions["stdin"]): "ignore" | Uint8Array {
	if (input === undefined) return "ignore";
	if (typeof input === "string") return new TextEncoder().encode(input);
	if (input instanceof Uint8Array) return input;
	return new Uint8Array(input);
}

function ensureAvailable(): void {
	if (!$which("git")) {
		throw new Error("git is not installed.");
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
	const child = Bun.spawn(["git", ...commandArgs], {
		cwd,
		env: options.env ? { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env } : undefined,
		signal: options.signal,
		stdin: normalizeStdin(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	if (!child.stdout || !child.stderr) {
		throw new Error("Failed to capture git command output.");
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { exitCode: exitCode ?? 0, stdout, stderr };
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
 * Any other error (and persistent EINTR after `EINTR_MAX_RETRIES`) is rethrown
 * for the caller's normal "optional metadata" classifier to handle.
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
			const repository = resolveRepoFromEntrySync(current, gitEntryPath, entryType);
			if (repository) return repository;
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
			const repository = await resolveRepoFromEntry(current, gitEntryPath, entryType);
			if (repository) return repository;
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
	ensureAvailable();
	const symArgs = withShortLivedGitConfig(withNoOptionalLocks(["symbolic-ref", "HEAD"]));
	const symResult = Bun.spawnSync(["git", ...symArgs], {
		cwd: repository.repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const revArgs = withShortLivedGitConfig(withNoOptionalLocks(["rev-parse", "--verify", "HEAD"]));
	const revResult = Bun.spawnSync(["git", ...revArgs], {
		cwd: repository.repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const commit = revResult.exitCode === 0 ? new TextDecoder().decode(revResult.stdout).trim() || null : null;

	if (symResult.exitCode === 0) {
		const ref = new TextDecoder().decode(symResult.stdout).trim();
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
		ensureAvailable();
		const symArgs = withShortLivedGitConfig(withNoOptionalLocks(["symbolic-ref", targetRef]));
		const symResult = Bun.spawnSync(["git", ...symArgs], {
			cwd: repository.repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		if (symResult.exitCode === 0) {
			const stdoutText = new TextDecoder().decode(symResult.stdout).trim();
			return `${HEAD_REF_PREFIX} ${stdoutText}`;
		}
		const revArgs = withShortLivedGitConfig(withNoOptionalLocks(["rev-parse", "--verify", targetRef]));
		const revResult = Bun.spawnSync(["git", ...revArgs], {
			cwd: repository.repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		if (revResult.exitCode === 0) {
			return new TextDecoder().decode(revResult.stdout).trim() || null;
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
			return (await git(cwd, args, { env: options.env, readOnly: true, signal: options.signal })).stdout;
		}
		return runText(cwd, args, { env: options.env, readOnly: true, signal: options.signal });
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
	if (options.allowEmpty) args.push("--allow-empty");
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

/** Fetch a specific refspec from a remote. */
export async function fetch(
	cwd: string,
	remote: string,
	source: string,
	target: string,
	signal?: AbortSignal,
): Promise<void> {
	await runEffect(cwd, ["fetch", remote, `+${source}:${target}`], { signal });
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
// API: show
// ════════════════════════════════════════════════════════════════════════════

/** Run `git show` on a revision. */
export const show = Object.assign(
	async function show(
		cwd: string,
		revision: string,
		options: { format?: string; signal?: AbortSignal } = {},
	): Promise<string> {
		return runText(cwd, ["show", `--format=${options.format ?? ""}`, revision], {
			readOnly: true,
			signal: options.signal,
		});
	},
	{
		/** Get the path prefix of the current directory relative to the repo root. */
		async prefix(cwd: string, signal?: AbortSignal): Promise<string> {
			return (await runText(cwd, ["rev-parse", "--show-prefix"], { readOnly: true, signal })).trim();
		},
	},
);

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
		if (REMOTE_ALREADY_EXISTS.test(result.stderr)) {
			const existing = await remote.url(cwd, name, signal);
			if (existing === url) return;
			throw new ToolError(`remote ${name} already exists with URL ${existing ?? "(unset)"}, expected ${url}`);
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

	/** Join patch parts into a single patch string. */
	join(parts: string[]): string {
		return `${parts
			.map(part => (part.endsWith("\n") ? part : `${part}\n`))
			.join("\n")
			.replace(/\n+$/, "")}\n`;
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
		await runEffect(path.dirname(absoluteTarget), args, { signal: options.signal });
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
	options: { ignoredOnly?: boolean; paths?: readonly string[]; signal?: AbortSignal } = {},
): Promise<void> {
	const args = ["clean", options.ignoredOnly ? "-fdX" : "-fd"];
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
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				signal,
			});
			if (!child.stdout || !child.stderr) {
				throw new ToolError("Failed to capture GitHub CLI output.");
			}
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
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
