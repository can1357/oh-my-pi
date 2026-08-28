/**
 * How a session's directory is attributed to a project.
 *
 * The desktop groups its sidebar by `projectRoot`, so getting this wrong splits
 * one project into several headings or merges two into one. The rule is worth a
 * test of its own because the call that feeds it — `vcs.gitInfo` — is a native
 * binding, and a machine whose prebuilt addon predates the vcs crate cannot run
 * it at all. The binding can be absent; the decision still has to be right.
 */
import { describe, expect, test } from "bun:test";
import { projectOf } from "@oh-my-pi/pi-coding-agent/cli/sessions-cli";

describe("projectOf", () => {
	test("a plain checkout is its own project", () => {
		expect(projectOf("/repo/sub", { repoRoot: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git" })).toEqual({
			projectRoot: "/repo",
			isWorktree: false,
		});
	});

	test("a linked worktree reports the primary checkout, not itself", () => {
		// What git writes for `git worktree add`: the worktree's own gitDir lives
		// inside the primary's `.git/worktrees/<name>`, and `commonDir` stays the
		// primary's `.git`.
		expect(
			projectOf("/repo/.wt/feature", {
				repoRoot: "/repo/.wt/feature",
				gitDir: "/repo/.git/worktrees/feature",
				commonDir: "/repo/.git",
			}),
		).toEqual({ projectRoot: "/repo", isWorktree: true });
	});

	test("a worktree parked outside its repository still points home", () => {
		// `omp worktree` puts these under ~/.omp/wt, nowhere near the repo — which
		// is why the test is the two directories differing, not the path shape.
		expect(
			projectOf("/home/u/.omp/wt/abc", {
				repoRoot: "/home/u/.omp/wt/abc",
				gitDir: "/home/u/code/app/.git/worktrees/abc",
				commonDir: "/home/u/code/app/.git",
			}),
		).toEqual({ projectRoot: "/home/u/code/app", isWorktree: true });
	});

	test("a directory that is not a repository groups under itself", () => {
		expect(projectOf("/tmp/scratch", null)).toEqual({ projectRoot: "/tmp/scratch", isWorktree: false });
	});
});
