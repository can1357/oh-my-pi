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
		| "Unsupported";
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
