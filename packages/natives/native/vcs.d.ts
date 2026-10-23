import type {
	VcsCloneOptions,
	VcsGitRepo,
	VcsGitRepoInfo,
	VcsHunkSelection,
	VcsHunkSelectionError,
	VcsJjWorkspace,
	VcsRepo,
} from "./index.js";
/** Portable capabilities that differ between Git and Jujutsu. */
export type VcsFeature = "stagedDiff" | "revDiff";

/**
 * A native VCS failure: a real `Error` constructed by the Rust layer on the
 * JS thread, carrying a machine-readable `code` and the CLI result fields.
 * Non-CLI failures synthesize `exitCode: 1` and mirror `message` into
 * `stderr`. Identify with {@link isVcsError} — `instanceof` cannot work for
 * foreign-constructed errors.
 */
export interface VcsError extends Error {
	name: "VcsError";
	code:
		| "NotARepository"
		| "RefNotFound"
		| "ObjectNotFound"
		| "EmptyCherryPick"
		| "Conflict"
		| "PatchFailed"
		| "Cli"
		| "CliTimeout"
		| "Io"
		| "Backend"
		| "Canceled"
		| "Unsupported"
		| "OutputTooLarge";
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** True when `error` is a native VCS failure. */
export declare function isVcsError(error: unknown): error is VcsError;

/** True when a cherry-pick failed because the commit is already applied. */
export declare function isEmptyCherryPick(error: unknown): error is VcsError & { code: "EmptyCherryPick" };

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export declare function git(dir: string): VcsGitRepo | null;
/** Discover the repository owning `dir`; `null` outside any repository. */
export declare function repo(dir: string): VcsRepo | null;
/**
 * {@link git} off the JS thread: rejects with the abort reason as soon as `signal` aborts, also
 * while a stalled checkout holds the lookup up.
 */
export declare function discoverGit(dir: string, signal?: AbortSignal): Promise<VcsGitRepo | null>;
/** {@link repo} off the JS thread, like {@link discoverGit}. */
export declare function discoverRepo(dir: string, signal?: AbortSignal): Promise<VcsRepo | null>;
/** Like {@link repo}, but equal-root jj+git ties prefer Jujutsu for display. Git-safe automation must keep using {@link repo}. */
export declare function repoForDisplay(dir: string): VcsRepo | null;

/** Like {@link repo}, asserting any requested backend capabilities. */
export declare function require(dir: string, ...features: VcsFeature[]): VcsRepo;

/** Like {@link git}, but throws a `NotARepository` {@link VcsError}. */
export declare function requireGit(dir: string): VcsGitRepo;

/** Repository metadata only (cheap fs walk) — for synchronous render paths. */
export declare function gitInfo(dir: string): VcsGitRepoInfo | null;

/** Discover the Jujutsu workspace containing `dir`; `null` when absent. */
export declare function jj(dir: string): VcsJjWorkspace | null;

/** Whether jj is the nearest VCS ancestor, making git automation unsafe. */
export declare function isPureJj(dir: string): boolean;

/** Clone a repository (git CLI under the hood for credential parity). */
export declare function clone(
	url: string,
	target: string,
	options?: VcsCloneOptions,
	signal?: AbortSignal,
): Promise<void>;

/** Sever a copied working tree from shared git metadata. */
export declare function detachGitDir(
	worktreeRoot: string,
	sourceCommonDir: string,
	signal?: AbortSignal,
): Promise<"no-git" | "independent" | "detached">;

/** Preserve isolation-local Git objects in the source without changing its refs or index. */
export declare function copyGitObjects(isolationRoot: string, sourceRoot: string): Promise<void>;

/**
 * This process as the owner of a worktree setup: `setupOwner` for `worktreeAdd`. Identifies the
 * process by pid and, where the platform reports it, start time.
 */
export declare function worktreeSetupOwner(): string;

/**
 * Wait up to 9 s for the running `worktreeAdd`s of this process to finish (registered as exit
 * cleanup; where the filesystem has no file locks they hold an `omp-worktree-add.claim`). The
 * claims of adds still running then are left in place: removing them would let another process add
 * the same path while this one still writes it. Such a leftover makes a later add fail naming the
 * file.
 */
export declare function releaseWorktreeAddClaims(): Promise<void>;

/**
 * Whether the owner of an unfinished worktree setup (`setupOwner` of a listed worktree) may still
 * be running it: its process exists and, where the owner recorded a start time and the platform
 * reports one, started then (else the pid was reused); or it is in another pid scope (host or
 * container), which this process can't judge. An owner from an earlier boot of this machine is
 * gone (Linux, with a machine id: a restart that cut a setup short doesn't leave it refused).
 */
export declare function isWorktreeSetupOwnerAlive(owner: string): boolean;

/** A `post-checkout` hook that exists but did not run, and why. */
export interface SkippedPostCheckoutHook {
	path: string;
	/** `no-git`: no git starts, or `git version` fails. `old-git`: older than 2.36, without `git hook run`. `inaccessible`: checking the hook file failed other than with ENOENT/ENOTDIR. */
	reason: "not-executable" | "no-git" | "old-git" | "inaccessible";
}

/**
 * Run Git's checkout hook in a new linked worktree and return its exit status and the
 * last 64 KiB of each output stream (the capture files are kept bounded while the hook runs: cut down on POSIX, sparse-deallocated on Windows where the filesystem supports it).
 * The git on `env`'s PATH locates the hook
 * (`git rev-parse --git-path`), seeing every config source; without a git that starts and
 * answers, the in-process lookup (`core.hooksPath`, path expanded, or the shared hooks
 * directory) does, so no git binary is needed when there is no hook. On Windows a
 * `post-checkout.exe` counts too, as in git. Only a missing path means no hook; anything else
 * there goes to git. The hook runs through `git hook run`, so, like hooks git runs itself and
 * unlike `git worktree add`'s, it sees `GIT_DIR` set to the new worktree's git dir. Returns
 * once `git hook run` exits, even if the hook left a background process running. `skipped` is
 * set when the hook exists but did not run: not executable (POSIX only), no working git on
 * PATH, a git older than 2.36, or a hook file that can't be checked. Its output is captured
 * in files under TMPDIR or, when none can be created there (missing, read-only, full), under
 * the worktree's git directory; only when neither works does it reject. `env` replaces the
 * inherited environment; pass one without ambient `GIT_DIR`-family variables. `detached`
 * (POSIX) runs the hook, and the git calls that locate it, in their own session, without the
 * caller's controlling terminal, so a prompt on /dev/tty fails instead of writing into a TUI.
 * Aborting `signal` kills the hook's process tree, descendants that moved into their own
 * session included (one that double-forks out to init escapes, and on Windows so do commands
 * MSYS `sh` started through its fork stubs), and rejects with the abort reason, also while a
 * lookup, a file check or a read is stalled; starting git (finding it on PATH, entering the
 * worktree) still happens on the calling thread. A `signal` implies `detached`. `inheritOutput`:
 * the hook writes to this process's stdout/stderr, as under `git worktree add`, and `stdout`/`stderr`
 * of the result are empty; nothing is captured.
 */
export declare function runPostCheckoutHook(
	worktreeRoot: string,
	head: string,
	options?: { signal?: AbortSignal; env?: Record<string, string>; detached?: boolean; inheritOutput?: boolean },
): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array; skipped?: SkippedPostCheckoutHook }>;

/** Join patch fragments, preserving each part's trailing newline. */
export declare function joinPatches(parts: string[]): string;

/** Validate hunk selections against a raw diff. */
export declare function validateHunkSelections(
	rawDiff: string,
	selections: VcsHunkSelection[],
): VcsHunkSelectionError[];

/** Stat-poll interval for {@link watch}. */
export declare const HEAD_WATCH_INTERVAL_MS: number;

/** Watch a repository for head changes; returns a disposer. */
export declare function watch(repo: VcsRepo, onChange: () => void, intervalMs?: number): () => void;
