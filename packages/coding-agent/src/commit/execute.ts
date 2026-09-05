/**
 * Shared commit-execution helpers for the agentic and legacy `omp commit`
 * pipelines: readable failure reporting for refusing git hooks and a push
 * wrapper that keeps a requested `--push` honest.
 */

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ChangelogApplyResult } from "./changelog";

/**
 * A commit or push failure that has already been reported to the user with a
 * readable message. It is thrown so the CLI exits non-zero without the runtime
 * dumping a stack trace — in a bundled build that trace is several kilobytes of
 * minified source, which buries the one line the user needs (issue #7834).
 *
 * `runCommitCommand`'s caller (`commands/commit.ts`) maps this to exit code 1.
 */
export class CommitAbortedError extends Error {
	constructor() {
		super("commit aborted");
		this.name = "CommitAbortedError";
	}
}

/**
 * Print a git-command failure — most often a `pre-commit`/`commit-msg` hook
 * that exited non-zero — as an indented message under `context`, then abort.
 *
 * @param context Label for the failed step, e.g. `"Commit 1 of 2 failed"`.
 * @param error The failure to surface; its captured stderr/stdout is shown.
 * @param note Optional trailing status line (split-plan progress, recovery).
 */
export function abortOnGitFailure(context: string, error: vcs.VcsError, note?: string): never {
	const detail = error.stderr.trim() || error.stdout.trim() || error.message;
	const body = detail
		.split("\n")
		.map(line => `    ${line}`)
		.join("\n");
	process.stderr.write(`✗ ${context}:\n${body}\n`);
	if (note) process.stderr.write(`  ${note}\n`);
	throw new CommitAbortedError();
}

/**
 * Report a failed commit step and abort, after reverting generated changelog
 * writes so a refusing hook leaves the index and worktree exactly as found.
 * Non-git errors are rethrown after the same rollback.
 */
export async function abortOnCommitFailure(
	context: string,
	error: unknown,
	changelog: ChangelogApplyResult | undefined,
): Promise<never> {
	let note: string | undefined;
	if (changelog && changelog.updated.length > 0) {
		try {
			await changelog.rollback();
			note = "Generated changelog entries were reverted.";
		} catch (rollbackError) {
			const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
			note = `Failed to revert generated changelog entries: ${message}`;
		}
	}
	if (vcs.isVcsError(error)) abortOnGitFailure(context, error, note);
	if (note) process.stderr.write(`  ${note}\n`);
	throw error;
}

/**
 * Push the current branch, reporting a refused push (missing upstream, rejected
 * ref) through {@link abortOnGitFailure} instead of letting the raw
 * `VcsError` escape. Prints the success line on completion.
 */
export async function pushOrAbort(cwd: string): Promise<void> {
	try {
		await vcs.requireGit(cwd).push({});
	} catch (error) {
		if (vcs.isVcsError(error)) abortOnGitFailure("Push failed", error);
		throw error;
	}
	process.stdout.write("Pushed to remote.\n");
}
