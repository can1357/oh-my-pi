/** Session relocation and exit policy for worktrees created by `/wt`. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { sanitizeDisplayLines, sanitizeDisplayWarnings, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { $which, logger } from "@oh-my-pi/pi-utils";
import type { SettingValueOf } from "../config/registry";
import type { Settings } from "../config/settings";
import { cfgWorktreeCleanSource, type cfgWorktreeOnExit } from "../task/settings";
import { formatIsolationBackend } from "../task/worktree";
import type { SessionWorktree } from "../worktree/backend";
import { creationBackend, worktreeBackend, worktreeOrigin } from "../worktree/worktrees";
import type { AgentSession } from "./agent-session";

/** State of a session-owned worktree at exit. */
export interface SessionWorktreeState {
	/** Worktree has uncommitted or untracked changes. */
	dirty: boolean;
	/** Branch tip moved off `baseCommit`; the branch is kept on removal. */
	moved: boolean;
	/** Worktree `HEAD` is not the branch tip, so its commits may be on no branch. */
	offBranch: boolean;
}

/** `worktree.onExit` policy for worktrees this launch created. */
export type WorktreeExitPolicy = SettingValueOf<typeof cfgWorktreeOnExit>;

/** What to do with a session-owned worktree when the session exits. */
export type WorktreeExitAction = "keep" | "remove" | "prompt";

/**
 * Map the `worktree.onExit` policy and the worktree's state to an exit action.
 * `remove` only removes worktrees with nothing to lose; `force` removes every
 * worktree; anything else prompts.
 */
export function decideWorktreeExit(policy: WorktreeExitPolicy, state: SessionWorktreeState): WorktreeExitAction {
	if (policy === "keep") return "keep";
	if (policy === "force") return "remove";
	if (policy === "remove" && !state.dirty && !state.moved && !state.offBranch) return "remove";
	return "prompt";
}

/** Reports whether `cwd` is a primary Git checkout with commits, not an existing worktree. */
export async function canAutoCreateWorktree(cwd: string, settings?: Settings): Promise<boolean> {
	const repository = vcs.git(cwd);
	if (!repository || (await worktreeOrigin(cwd, settings))) return false;
	return Boolean(await repository.headSha());
}

/** Default `/wt` branch name: `wt/<yyyymmdd-hhmmss>`. */
export function defaultSessionWorktreeBranch(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wt/${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** One-line confirmation shown after the session moved into `worktree`. */
export function formatSessionWorktreeSummary(worktree: SessionWorktree, sourceCleaned = false): string {
	const changeStatus = !worktree.keptChanges
		? "started from clean HEAD"
		: sourceCleaned
			? "uncommitted changes moved, source checkout cleaned"
			: "uncommitted changes carried over";
	const where = `Moved to worktree ${worktree.path} on branch ${worktree.branch}`;
	if (worktree.ovnfs) {
		const { checkout } = worktree.ovnfs;
		return `${where} (ovnfs checkout ${checkout}, ${changeStatus}; \`ovnfs land ${checkout}\` lands its commits).`;
	}
	const how =
		worktree.clonedWith === undefined ? "checked out" : `cloned via ${formatIsolationBackend(worktree.clonedWith)}`;
	return `${where} (${how}, ${changeStatus}).`;
}

/**
 * If `worktree.cleanSource` is enabled, resets and cleans the source checkout.
 * Catches git errors and returns `{ cleaned: true }` on success, or `{ cleaned: false, errorMessage }` on failure.
 */
export async function cleanSourceCheckoutIfConfigured(
	sourceCwd: string,
	settings: Settings,
): Promise<{ cleaned: boolean; errorMessage?: string }> {
	if (!cfgWorktreeCleanSource.get(settings)) {
		return { cleaned: false };
	}
	try {
		const repository = vcs.requireGit(sourceCwd);
		await repository.reset("hard", "HEAD");
		await repository.clean({});
		return { cleaned: true };
	} catch (error) {
		logger.warn("failed to clean source checkout after /wt", { cwd: sourceCwd, error });
		return {
			cleaned: false,
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Bytes at the end of a failed hook's output that are searched for its last line. */
const HOOK_OUTPUT_TAIL_BYTES = 4096;

/**
 * Runs the `post-checkout` hook of a worktree `/wt` created, a linked git worktree or an ovnfs
 * checkout, with the arguments `git worktree add` gives it, then has `session` rediscover skills and
 * slash commands so it sees what the hook added. An ovnfs checkout has its own git dir without
 * `hooks/`, so there only a hook found through `core.hooksPath` runs. Never throws: a failing hook
 * keeps the worktree and comes back as a display-ready warning.
 */
export async function runSessionWorktreeHook(
	worktree: SessionWorktree,
	session: Pick<AgentSession, "isDisposed" | "refreshSkillsAndCommands">,
): Promise<string[]> {
	// Without a `git` executable no hook can run: stay silent, as `/wt` was before it ran hooks.
	if (!$which("git")) return [];
	const warnings: string[] = [];
	try {
		const hook = await vcs.runPostCheckoutHook(worktree.path, worktree.baseCommit);
		if (hook.exitCode !== 0) {
			// `git hook run` sends the hook's stdout to stderr; the fallback for git older than 2.36 keeps
			// them apart, and stderr's last line wins.
			const tails = [hook.stdout, hook.stderr].map(bytes =>
				new TextDecoder().decode(bytes.subarray(-HOOK_OUTPUT_TAIL_BYTES)),
			);
			const lastLine = sanitizeDisplayLines(tails.join("\n"))
				.map(line => line.trim())
				.findLast(Boolean);
			warnings.push(`post-checkout hook exited with ${hook.exitCode}${lastLine ? `: ${lastLine}` : ""}`);
		}
	} catch (error) {
		warnings.push(`post-checkout hook could not run: ${error instanceof Error ? error.message : String(error)}`);
	}
	// The session can end while the hook runs.
	if (!session.isDisposed) {
		try {
			await session.refreshSkillsAndCommands();
		} catch (error) {
			warnings.push(`skill and command rescan failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return sanitizeDisplayWarnings(warnings.map(warning => `Worktree created, but ${warning}`));
}

/**
 * Create the worktree for `/wt`: an ovnfs checkout when `isolation.backend` is
 * auto and ovnfs is found, else a linked git worktree. Throws with a
 * user-facing message when `cwd` is not a git checkout, `branch` already
 * exists, the checkout name is taken, or git or ovnfs refuses.
 */
export async function createSessionWorktree(
	cwd: string,
	settings: Settings,
	branch: string,
	options: { keepChanges?: boolean } = {},
): Promise<SessionWorktree> {
	const keepChanges = options.keepChanges ?? true;
	try {
		await settings.flush();
	} catch (err) {
		throw new Error(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
	}
	const repository = vcs.git(cwd);
	if (!repository) {
		throw new Error(`Not inside a git repository: ${cwd}`);
	}
	if (!/^[^\s~^:?*[\\]+$/.test(branch) || branch.startsWith("-") || branch.endsWith("/") || branch.includes("..")) {
		throw new Error(`Invalid branch name: ${branch}`);
	}
	const branchRef = `refs/heads/${branch}`;
	if (await repository.refExists(branchRef)) {
		throw new Error(`Branch '${branch}' already exists; pick another name.`);
	}
	const baseCommit = await repository.headSha();
	if (!baseCommit) {
		throw new Error(`Cannot create a worktree: ${cwd} has no commits.`);
	}
	return creationBackend(settings).create({
		repository,
		settings,
		branch,
		sourceCwd: cwd,
		baseCommit,
		keptChanges: keepChanges,
	});
}

/** State of `wt` plus a fingerprint that changes whenever any file, ref, or `HEAD` in it changes. */
interface WorktreeSnapshot {
	state: SessionWorktreeState;
	fingerprint: string;
	/** Worktree directory still exists as a git checkout. */
	present: boolean;
}

async function snapshotSessionWorktree(wt: SessionWorktree): Promise<WorktreeSnapshot> {
	const { checkout: worktreeRepo, branchRepo, missingBranchRepoMeansMoved } = await worktreeBackend(wt).inspect(wt);
	let moved = missingBranchRepoMeansMoved;
	let tip: string | null | undefined;
	if (branchRepo) {
		tip = await branchRepo.resolveRef(`refs/heads/${wt.branch}`);
		moved = tip !== null && tip !== undefined && tip !== wt.baseCommit;
	}
	if (!worktreeRepo) {
		return { state: { dirty: false, moved, offBranch: false }, fingerprint: `missing\0${tip ?? ""}`, present: false };
	}
	const status = await worktreeRepo.statusPorcelain({ untracked: "all", nulTerminated: true });
	const head = await worktreeRepo.headSha();
	// Porcelain codes do not change when an already-modified file is edited again,
	// so fold in each changed path's size and mtime.
	const parts = [head ?? "", tip ?? "", status];
	const entries = status.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		// Renames and copies are followed by their source path as a separate entry.
		if (entry[0] === "R" || entry[0] === "C") i++;
		const file = entry.slice(3);
		const stat = await fs.stat(path.join(wt.path, file)).catch(() => undefined);
		parts.push(stat ? `${file}:${stat.size}:${stat.mtimeMs}` : `${file}:-`);
	}
	return {
		state: { dirty: status.length > 0, moved, offBranch: Boolean(head) && head !== tip },
		fingerprint: Bun.hash(parts.join("\0")).toString(16),
		present: true,
	};
}

/**
 * Gets the state of `wt`. A missing worktree is not dirty and not off-branch; a
 * deleted branch has not moved; a missing source repo counts as moved so the
 * branch is never deleted; a missing ovnfs checkout took its branch along, so
 * it has not moved. Throws when the daemon serving an ovnfs checkout cannot start.
 */
export async function inspectSessionWorktree(wt: SessionWorktree): Promise<SessionWorktreeState> {
	return (await snapshotSessionWorktree(wt)).state;
}

/** Describes what removing a worktree in `state` would lose, for the exit prompt. */
function describeWorktreeRisk(wt: SessionWorktree, state: SessionWorktreeState): string {
	const issues: string[] = [];
	if (state.dirty) issues.push("has uncommitted changes");
	if (state.moved) issues.push("has new commits (branch is kept)");
	if (state.offBranch) issues.push(`HEAD is not on ${wt.branch}; commits only reachable from HEAD are lost`);
	return issues.join("; ");
}

/** A worktree chosen for removal at exit. */
export interface WorktreeExitPlan {
	worktree: SessionWorktree;
	/**
	 * Snapshot fingerprint at the time removal was decided or approved; the
	 * worktree is kept if it changed since. Absent under `force`: removed regardless.
	 */
	approvedFingerprint?: string;
}

/**
 * Applies `policy` to `owned` and returns the worktrees to remove, newest first.
 * Calls `confirm` for each worktree that needs a prompt; inspection errors go to
 * `warn` and keep that worktree.
 */
export async function planWorktreeExit(
	owned: readonly SessionWorktree[],
	policy: WorktreeExitPolicy,
	confirm: (title: string, message: string) => Promise<boolean>,
	warn: (message: string) => void,
): Promise<WorktreeExitPlan[]> {
	if (policy === "keep") return [];
	const plan: WorktreeExitPlan[] = [];
	// Newest first: a `/wt` worktree may have been forked from an older owned one.
	for (const worktree of owned.toReversed()) {
		try {
			const { state, fingerprint } = await snapshotSessionWorktree(worktree);
			const action = decideWorktreeExit(policy, state);
			if (action === "keep") continue;
			if (action === "remove") {
				plan.push(policy === "force" ? { worktree } : { worktree, approvedFingerprint: fingerprint });
				continue;
			}
			const risk = describeWorktreeRisk(worktree, state);
			const message = `${shortenPath(worktree.path)} (${worktree.branch})${risk ? `: ${risk}` : ""}`;
			if (await confirm("Remove worktree?", message)) plan.push({ worktree, approvedFingerprint: fingerprint });
		} catch (err) {
			warn(err instanceof Error ? err.message : String(err));
		}
	}
	return plan;
}

/**
 * Removes the planned worktrees in order, keeping any with an `approvedFingerprint`
 * that changed at all since removal was decided or approved. Returns one message
 * per kept or failed worktree, plus a resume note when the worktree holding the
 * process cwd is removed.
 */
export async function removeExitWorktrees(plan: readonly WorktreeExitPlan[]): Promise<string[]> {
	const messages: string[] = [];
	for (const { worktree, approvedFingerprint } of plan) {
		try {
			const { state, fingerprint, present } = await snapshotSessionWorktree(worktree);
			// A vanished worktree holds nothing to lose; `state.moved` still guards the branch.
			if (present && approvedFingerprint !== undefined && fingerprint !== approvedFingerprint) {
				messages.push(`Kept worktree ${shortenPath(worktree.path)}: it changed while the session was closing.`);
				continue;
			}
			// Git cannot open the source repo while our cwd is the deleted worktree.
			const rel = path.relative(worktree.path, process.cwd());
			const holdsCwd = !rel.startsWith("..") && !path.isAbsolute(rel);
			if (holdsCwd) process.chdir(worktree.sourceCwd);
			await removeSessionWorktree(worktree, state.moved);
			if (holdsCwd) {
				const commits = state.moved ? `; its commits are on branch ${worktree.branch}` : "";
				messages.push(
					`Removed worktree ${shortenPath(worktree.path)}. Resuming opens in the directory you launch omp from${commits}.`,
				);
			}
		} catch (err) {
			messages.push(err instanceof Error ? err.message : String(err));
		}
	}
	return messages;
}

/**
 * Force-remove `wt`; also delete its branch unless it `moved` (has new commits).
 * An ovnfs checkout's moved branch is first copied into the source repo, where
 * it is kept. Throws a user-facing error when git or ovnfs refuses a step; the
 * checkout then stays.
 */
export async function removeSessionWorktree(wt: SessionWorktree, moved: boolean): Promise<void> {
	await worktreeBackend(wt).remove(wt, moved);
}
