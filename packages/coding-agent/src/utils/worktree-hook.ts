/**
 * The `post-checkout` hook of worktrees omp creates for `/wt`, `github` `pr_checkout` and
 * `omp worktree add`: running it as `git worktree add` does, describing the outcome for display,
 * and discarding a new worktree whose setup was cut short.
 */
import * as fs from "node:fs/promises";
import type { VcsGitRepo, VcsWorktreeAddOptions, VcsWorktreeAddResult, VcsWorktreeEntry } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { filterChildShellEnvAsync, logger, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayWarning, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";

/** Display lines for a new worktree's `post-checkout` hook; both unset when it ran cleanly or there is none. */
export interface WorktreeCheckoutHookResult {
	/** The hook ran and failed: exit status and its last output line. */
	error?: string;
	/** The hook exists but did not run; see {@link vcs.SkippedPostCheckoutHook} for the reasons. */
	skipped?: string;
}

/**
 * Width left for a hook warning after the longest lead-in a caller puts before it (`/wt` shows
 * "Warning: Worktree created, but …"), so the whole rendered line stays within one display line.
 */
const WARNING_WIDTH = TRUNCATE_LENGTHS.LINE - Bun.stringWidth("Warning: Worktree created, but ");

const displayLine = (text: string, width = WARNING_WIDTH) => truncateToWidth(sanitizeDisplayWarning(text), width);

/** Warning line for a `post-checkout` hook that exists but did not run; sanitized and home-shortened. Only the path is cut, never the reason. */
export function describeSkippedHook(skipped: vcs.SkippedPostCheckoutHook): string {
	const why = {
		"not-executable": "is not executable, so git skipped it",
		"no-git": "did not run: no working git found",
		"old-git": "did not run: running hooks needs Git 2.36 or newer",
		inaccessible: "did not run: it could not be read",
	}[skipped.reason];
	const lead = "post-checkout hook ";
	return `${lead}${displayLine(skipped.path, WARNING_WIDTH - Bun.stringWidth(`${lead} ${why}`))} ${why}`;
}

/** The hook's warnings, failure first; each completes "Worktree created, but …". */
export function worktreeHookWarnings(hook: WorktreeCheckoutHookResult | undefined): string[] {
	return [hook?.error, hook?.skipped].filter(warning => warning !== undefined);
}

/**
 * Run a new linked worktree's `post-checkout` hook, as `git worktree add` does, without the
 * agent's own `GIT_DIR`-family variables and in its own session, so a prompt on the terminal
 * fails instead of writing into the TUI. Lines are sanitized, home-shortened and truncated for
 * display. Aborting `signal` stops the hook and rejects.
 */
export async function runWorktreeCheckoutHook(
	worktreeRoot: string,
	head: string,
	signal?: AbortSignal,
): Promise<WorktreeCheckoutHookResult> {
	// Its dotenv reads off the JS thread, raced against the abort like the hook itself.
	const env = await filterChildShellEnvAsync(process.env, undefined, signal);
	const hook = await vcs.runPostCheckoutHook(worktreeRoot, head, { signal, env, detached: true });
	const result: WorktreeCheckoutHookResult = {};
	if (hook.skipped) result.skipped = describeSkippedHook(hook.skipped);
	if (hook.exitCode !== 0) {
		const decoder = new TextDecoder();
		const output = sanitizeText(`${decoder.decode(hook.stdout)}\n${decoder.decode(hook.stderr)}`).trim();
		const last = output.split("\n").at(-1);
		// Composed first, then truncated as a whole, so the exit status always counts against the line limit.
		result.error = displayLine(
			last
				? `post-checkout hook exited with ${hook.exitCode}: ${last}`
				: `post-checkout hook exited with ${hook.exitCode}`,
		);
	}
	return result;
}

/** A worktree {@link addWorktreeWithHook} created, its resolved path, and its hook's outcome. */
export interface WorktreeSetup {
	added: VcsWorktreeAddResult;
	/** `worktreePath` with symlinks resolved. */
	path: string;
	hook: WorktreeCheckoutHookResult;
	/**
	 * Short name (no `refs/heads/`) of the branch the worktree is on once set up: the requested
	 * `branch`, or the one a hook renamed it to with `git branch -m`.
	 */
	branch: string;
}

/**
 * `worktreePath` with symlinks resolved, raced against `signal`, so a stalled filesystem (e.g. a
 * `worktree.base` on a network mount) cannot outlast an abort.
 */
export function resolveWorktreePath(worktreePath: string, signal?: AbortSignal): Promise<string> {
	// A function, not a started lookup: on an already-aborted signal it never runs, so its failure can't go unhandled.
	return untilAborted(signal, () => fs.realpath(worktreePath));
}

/** The post-checkout hook removed the new worktree; its path and branch may be another process's by now. */
export class WorktreeRemovedByHookError extends Error {
	constructor(worktreePath: string) {
		super(`The post-checkout hook removed the new worktree at ${worktreePath}; it was not set up`);
		this.name = "WorktreeRemovedByHookError";
	}
}

/**
 * Add a linked worktree of `branch` at the unused `worktreePath` (the hook may move it; the
 * returned path is where it ended up), then run its `post-checkout`
 * hook. Until the hook is done the worktree carries this process's setup mark, so another omp
 * process does not take it over (`pr_checkout` would reuse it); git commands, the hook's
 * included, see it as `git worktree add` leaves it. If the hook stage fails or `signal` aborts
 * before the setup mark is removed, the worktree is discarded and `branch` put back where the
 * checkout left it, so a retry starts over instead of reusing a half-set-up checkout or finding
 * the branch diverged. A branch the hook renamed the new branch to is deleted and the original
 * put back, but only when its reflog shows that rename and it did not exist before the hook. After
 * a successful hook (and only then: a hook that failed keeps its worktree, with a warning, whatever
 * state it left) the worktree is still refused (and discarded likewise) when its `.git` no longer
 * leads to its git directory, when HEAD is detached, or when it is on another branch than `branch`
 * (a proven rename is kept: the returned branch is its new name). All of these are checked before
 * the setup mark is cleared. The discard itself takes no signal and runs to completion. A failed
 * `worktreeAdd` discards nothing: another process may own the path by then. If the hook removed
 * the worktree, or another process replaced it at the same git directory (a different setup mark,
 * on the success and the failure path alike), the call fails with {@link WorktreeRemovedByHookError}
 * (success path) or rethrows its own error (failure path) and touches neither the path nor the
 * branch, which another process may have taken since. On the failure path `branch` is put back at
 * its checkout tip only while provably this setup's: recreated while absent, or moved when this
 * setup's own worktree was on it, always by compare-and-swap.
 */
export async function addWorktreeWithHook(
	repository: VcsGitRepo,
	worktreePath: string,
	branch: string,
	options: VcsWorktreeAddOptions,
	signal?: AbortSignal,
): Promise<WorktreeSetup> {
	signal?.throwIfAborted();
	// No signal: the native checkout runs to completion regardless, and an abort-rejected call would
	// not say whether this attempt created the worktree.
	const setupOwner = vcs.worktreeSetupOwner();
	const added = await repository.worktreeAdd(worktreePath, branch, { ...options, setupOwner });
	let head: string | null | undefined;
	// Local branches before the hook ran: a branch absent from it was created by the hook.
	let branchesBefore: Set<string> | undefined;
	// A hook may move its worktree, as under `git worktree add`; everything after it uses the current path.
	let current = worktreePath;
	let gitDir: string | undefined;
	// Set once the hook is known to have removed the worktree: its path and branch may be another process's by now.
	let gone = false;
	try {
		// The branch is still the checked-out one here; the hook may rename it or move the worktree, not the git dir.
		const listed = await untilAborted(signal, () => repository.worktrees());
		gitDir = listed.find(entry => entry.branch === `refs/heads/${branch}`)?.gitDir;
		signal?.throwIfAborted();
		head = await repository.resolveRef(`refs/heads/${branch}`, signal);
		branchesBefore = new Set(await untilAborted(signal, () => repository.listBranches(false)));
		const hook = head ? await runWorktreeCheckoutHook(worktreePath, head, signal) : {};
		// Raced like the path lookup below, so an abort rejects with its reason.
		const located = await currentWorktreeEntry(repository, gitDir, signal);
		if (located === undefined) {
			gone = true;
			throw new WorktreeRemovedByHookError(worktreePath);
		}
		// Ownership first: a replacement at our git dir is another process's, so its state is no hook outcome of ours.
		if (located !== null && located.setupOwner !== setupOwner) {
			gone = true;
			throw new WorktreeRemovedByHookError(worktreePath);
		}
		current = located?.path ?? current;
		// A hook that failed keeps its worktree with a warning, whatever state it left behind, so only a
		// successful hook is held to the link and branch checks.
		const setUpBranch =
			located && gitDir !== undefined && hook.error === undefined
				? await checkedBranch(repository, branch, gitDir, located, branchesBefore, signal)
				: branch;
		// The abort may also have landed as the hook finished: either way, or with a stalled `worktree.base`,
		// the caller must not move into the worktree, so it is discarded below.
		const resolved = await resolveWorktreePath(current, signal);
		// The commit point: with the mark gone another omp process may reuse the worktree, so an abort from
		// here on is too late to discard it, as one just after the return would be.
		if (gitDir === undefined) {
			await repository.worktreeEndSetup(current).catch(error => {
				// Set up all the same; other omp processes only wait for it until this one exits.
				logger.warn("could not mark a new worktree as set up", { path: current, error: String(error) });
			});
		} else {
			// By saved identity, never by path: a replacement at this path carries another process's mark.
			const cleared = await repository.worktreeReplaceSetupOwner(gitDir, setupOwner, null).catch(error => {
				logger.warn("could not mark a new worktree as set up", { path: current, error: String(error) });
				return true;
			});
			if (!cleared) {
				gone = true;
				throw new WorktreeRemovedByHookError(worktreePath);
			}
		}
		return { added, path: resolved, hook, branch: setUpBranch };
	} catch (error) {
		let hookBranch: string | undefined;
		if (!gone) {
			// The hook may have moved the worktree before it was cut short; discard where it is now.
			try {
				const located = await currentWorktreeEntry(repository, gitDir);
				// Missing, or a replacement at our git dir carrying another mark: either way not ours to touch.
				if (located === undefined || (located !== null && located.setupOwner !== setupOwner)) gone = true;
				else {
					current = located?.path ?? current;
					if (located && !located.detached && located.branch?.startsWith("refs/heads/")) {
						hookBranch = located.branch.slice("refs/heads/".length);
					}
				}
			} catch (lookupError) {
				logger.warn("could not locate a new worktree its hook may have moved", {
					path: current,
					error: String(lookupError),
				});
			}
		}
		if (gone) {
			logger.warn("a new worktree was removed by its post-checkout hook; leaving its path and branch alone", {
				path: worktreePath,
				branch,
			});
		} else {
			// Read while our worktree still has the renamed branch checked out: nobody else can move it
			// through a checkout, so this is the tip the hook left and the only one safe to delete.
			let renamedTip: string | undefined;
			if (gitDir !== undefined && branchesBefore && hookBranch !== undefined && hookBranch !== branch) {
				try {
					renamedTip = (await repository.resolveRef(`refs/heads/${hookBranch}`)) ?? undefined;
				} catch (tipError) {
					logger.warn("could not read the tip of a branch a cut-short post-checkout hook renamed", {
						branch: hookBranch,
						error: String(tipError),
					});
				}
			}
			await discardNewWorktree(repository, current, gitDir, setupOwner);
			if (gitDir !== undefined && branchesBefore && hookBranch !== undefined) {
				await deleteRenamedBranch(repository, branch, hookBranch, branchesBefore, renamedTip);
			}
			if (head) await restoreBranch(repository, branch, head, hookBranch === branch);
		}
		throw error;
	}
}

/**
 * The listing entry of the registration `gitDir`, or `null` when `gitDir` is undefined (nothing to
 * look up). When `gitDir` is listed nowhere the worktree is gone (the hook deleted it) and the
 * result is `undefined`: its path may by now belong to another process. The git directory survives
 * `git worktree move` and a branch rename.
 */
async function currentWorktreeEntry(
	repository: VcsGitRepo,
	gitDir: string | undefined,
	signal?: AbortSignal,
): Promise<VcsWorktreeEntry | null | undefined> {
	if (gitDir === undefined) return null;
	const listed = await untilAborted(signal, () => repository.worktrees());
	return listed.find(entry => entry.gitDir === gitDir);
}

/**
 * Whether the `.git` of the directory `worktreePath` leads back to the registration `gitDir`: a
 * repository discovered at the path has `gitDir` as its git directory and the path as its root
 * (symlinks resolved). Any failure (no repository, an unresolvable path) means it does not. The
 * native worktree removal deletes the registration a `.git` points to, so only a link that passes
 * may reach it. Also used by `pr_checkout`'s stale-worktree recovery.
 */
export async function linkLeadsTo(worktreePath: string, gitDir: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const found = await untilAborted(signal, () => vcs.discoverGit(worktreePath, signal));
		if (!found) return false;
		const info = found.info();
		const [foundGitDir, expectedGitDir, foundRoot, expectedRoot] = await untilAborted(signal, () =>
			Promise.all([
				fs.realpath(info.gitDir),
				fs.realpath(gitDir),
				fs.realpath(info.repoRoot),
				fs.realpath(worktreePath),
			]),
		);
		return foundGitDir === expectedGitDir && foundRoot === expectedRoot;
	} catch (error) {
		signal?.throwIfAborted();
		logger.debug("a new worktree's .git could not be followed", { path: worktreePath, error: String(error) });
		return false;
	}
}

/**
 * Refuse a worktree a successful hook left unusable, and name the branch it is on. Throws when its
 * `.git` no longer leads to `gitDir`, when HEAD is detached, or when it is on a branch other than
 * `branch` without proof of a rename. A rename is adopted (its new short name returned) only when
 * the new name is not in `before`, `refs/heads/<branch>` is gone, and the reflog of the new name
 * shows the rename from `branch`: the same proof the rollback needs to delete it.
 */
async function checkedBranch(
	repository: VcsGitRepo,
	branch: string,
	gitDir: string,
	entry: VcsWorktreeEntry,
	before: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<string> {
	if (!(await linkLeadsTo(entry.path, gitDir, signal))) {
		throw new Error(
			`The post-checkout hook broke the new worktree at ${entry.path}: its .git no longer leads to the worktree's git directory`,
		);
	}
	const prefix = "refs/heads/";
	if (entry.detached || !entry.branch?.startsWith(prefix)) {
		throw new Error(`The post-checkout hook detached HEAD in the new worktree at ${entry.path}`);
	}
	const other = entry.branch.slice(prefix.length);
	if (other === branch) return branch;
	const renamed =
		!before.has(other) &&
		!(await repository.refExists(`${prefix}${branch}`, signal)) &&
		(await repository.branchRenamedFrom(other, branch, signal));
	if (!renamed) {
		throw new Error(`The post-checkout hook switched the new worktree at ${entry.path} from ${branch} to ${other}`);
	}
	return other;
}

/**
 * Remove a worktree this attempt's own `worktreeAdd` created, or, when it is no longer
 * discoverable (its `.git` file is gone) or its `.git` no longer leads to `gitDir` (the native
 * removal would delete whichever registration the link names), delete its directory. A native removal deletes the
 * registration with its setup mark; after the directory fallback the mark is cleared by
 * compare-and-swap on `gitDir` and `owner`, never by path, which another process may have reused
 * by then. If it could not be removed, it keeps the mark: it stays owned by this live process, so
 * other omp processes do not reuse the half-set-up checkout. Takes no signal, as the caller's may
 * already be aborted; failures are logged, not thrown, so the original error reaches the caller.
 */
async function discardNewWorktree(
	repository: VcsGitRepo,
	worktreePath: string,
	gitDir: string | undefined,
	owner: string,
): Promise<void> {
	const warn = (error: unknown) =>
		logger.warn("could not remove a worktree whose setup was cut short", {
			path: worktreePath,
			error: String(error),
		});
	let removed: boolean;
	try {
		const nativeSafe = gitDir === undefined || (await linkLeadsTo(worktreePath, gitDir));
		removed = nativeSafe && (await repository.worktreeRemove(worktreePath, true));
		if (!removed) await fs.rm(worktreePath, { recursive: true, force: true });
	} catch (error) {
		warn(error);
		return;
	}
	try {
		if (!removed) {
			if (gitDir === undefined) await repository.worktreeEndSetup(worktreePath);
			else await repository.worktreeReplaceSetupOwner(gitDir, owner, null);
		}
		await repository.worktreePrune();
	} catch (error) {
		warn(error);
	}
}

/**
 * Put `branch` back at `head` after a cut-short hook, only while it is provably this setup's: it is
 * recreated while absent, and moved off another commit only when this setup's own worktree was on it
 * at rollback (`ownCheckout`). Anything else may be another process's branch and is left alone. The
 * update is a compare-and-swap, so a branch changed since it was read is left too. Failures are logged.
 */
async function restoreBranch(
	repository: VcsGitRepo,
	branch: string,
	head: string,
	ownCheckout: boolean,
): Promise<void> {
	try {
		const now = await repository.resolveRef(`refs/heads/${branch}`);
		if (now === head) return;
		if (now == null) {
			if (!(await repository.swapBranch(branch, null, head))) {
				logger.warn("a branch a cut-short post-checkout hook deleted was recreated meanwhile; leaving it", {
					branch,
				});
			}
		} else if (ownCheckout) {
			if (!(await repository.swapBranch(branch, now, head))) {
				logger.warn("a branch a cut-short post-checkout hook moved changed meanwhile; leaving it", { branch });
			}
		} else {
			logger.warn("a branch moved while a post-checkout hook ran is not provably this setup's; leaving it", {
				branch,
			});
		}
	} catch (error) {
		logger.warn("could not restore a branch moved by a cut-short post-checkout hook", {
			branch,
			error: String(error),
		});
	}
}

/**
 * Delete `renamed`, the branch a cut-short hook renamed `branch` to, once its worktree is gone. Only
 * when `branch` no longer exists, `renamed` is not in `before` (the hook created it), and the reflog
 * of `renamed` shows the hook renamed `branch` to it, so a branch that existed earlier or that
 * another process created is never deleted. The deletion is a compare-and-swap against `tip`, the
 * tip read while the worktree still had `renamed` checked out, so a commit another process added
 * after the discard freed the branch keeps it. Failures are logged.
 */
async function deleteRenamedBranch(
	repository: VcsGitRepo,
	branch: string,
	renamed: string,
	before: ReadonlySet<string>,
	tip: string | undefined,
): Promise<void> {
	if (renamed === branch || before.has(renamed)) return;
	try {
		if (await repository.refExists(`refs/heads/${branch}`)) return;
		if (!(await repository.branchRenamedFrom(renamed, branch))) {
			logger.warn(
				"a branch the cut-short hook left the worktree on is kept: no rename from the original in its reflog",
				{ branch: renamed, original: branch },
			);
			return;
		}
		if (tip === undefined) {
			logger.warn("a branch a cut-short post-checkout hook renamed is kept: its tip could not be read", {
				branch: renamed,
			});
			return;
		}
		if (!(await repository.swapBranch(renamed, tip, null))) {
			logger.warn("a branch a cut-short post-checkout hook renamed changed since the rollback began; keeping it", {
				branch: renamed,
			});
		}
	} catch (error) {
		logger.warn("could not delete a branch a cut-short post-checkout hook renamed", {
			branch: renamed,
			error: String(error),
		});
	}
}
