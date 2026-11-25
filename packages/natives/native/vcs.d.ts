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
		| "HeadMoved"
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
		| "OutputTooLarge"
		/** The installed repo guard ({@link setRepoGuard}) refused the repository. */
		| "Refused";
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** True when `error` is a native VCS failure. */
export declare function isVcsError(error: unknown): error is VcsError;

/** True when a cherry-pick failed because the commit is already applied. */
export declare function isEmptyCherryPick(error: unknown): error is VcsError & { code: "EmptyCherryPick" };

/**
 * Install `guard` (`undefined` removes it): before every git operation on a repository (each async
 * method and `headSync` of any handle {@link git}, {@link repo} or {@link repoForDisplay} returned,
 * before or after the install, {@link detachGitDir}, {@link copyGitObjects} and
 * {@link runPostCheckoutHook}) it is asked about the repository's git entry (`.git`), git dir and
 * common dir; `false` fails the operation with a `Refused` {@link VcsError}, like a failed git call
 * (`headSync` throws it synchronously).
 */
export declare function setRepoGuard(
	guard: ((paths: readonly [gitEntryPath: string, gitDir: string, commonDir: string]) => boolean) | undefined,
): void;

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export declare function git(dir: string): VcsGitRepo | null;
/** Discover the repository owning `dir`; `null` outside any repository. */
export declare function repo(dir: string): VcsRepo | null;
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

/**
 * Preserve isolation-local Git objects in the source without changing its refs or index. Symlinked
 * object files are skipped, never followed; both repositories are subject to the repo guard.
 */
export declare function copyGitObjects(isolationRoot: string, sourceRoot: string): Promise<void>;

/** Run Git's checkout hook in a new linked worktree and return its output and exit status. */
export declare function runPostCheckoutHook(
	worktreeRoot: string,
	head: string,
): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;

/** Join patch fragments, preserving each part's trailing newline. */
export declare function joinPatches(parts: string[]): string;

/** Validate hunk selections against a raw diff. */
export declare function validateHunkSelections(
	rawDiff: string,
	selections: VcsHunkSelection[],
): VcsHunkSelectionError[];
