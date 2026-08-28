import { describe, expect, test } from "bun:test";
import { buildProjects, projectChoices, type SessionNode, UNGROUPED } from "../src/projects/discover";

function session(over: Partial<SessionNode>): SessionNode {
	return {
		id: over.id ?? "s1",
		title: over.title ?? "A session",
		cwd: over.cwd ?? "/repos/kena",
		projectRoot: over.projectRoot ?? "/repos/kena",
		projectName: over.projectName ?? "kena",
		isWorktree: over.isWorktree ?? false,
		modified: over.modified ?? "2026-08-27T10:00:00.000Z",
	} as SessionNode;
}

describe("projectChoices", () => {
	test("never offers the ungrouped bucket as a directory", () => {
		// Its `root` is the `(no project)` label. Spawning a sidecar there would
		// create a folder by that name in whatever the app's cwd happens to be.
		const choices = projectChoices(
			buildProjects([session({ id: "old", cwd: "", projectRoot: "", projectName: "" })]),
		);

		expect(choices.map(c => c.cwd)).not.toContain(UNGROUPED);
		expect(choices).toEqual([]);
	});

	test("a worktree is offered in its own right, and named by its parent", () => {
		const choices = projectChoices(
			buildProjects([
				session({ id: "a", cwd: "/repos/kena" }),
				session({ id: "b", cwd: "/repos/kena/.wt/feature", isWorktree: true }),
			]),
		);

		expect(choices).toEqual([
			{ cwd: "/repos/kena", name: "kena", kind: "project", sessions: 1 },
			{ cwd: "/repos/kena/.wt/feature", name: "feature", kind: "worktree", parent: "kena", sessions: 1 },
		]);
	});

	test("counts only the sessions in the checkout itself, not the worktrees", () => {
		const choices = projectChoices(
			buildProjects([
				session({ id: "a", cwd: "/repos/kena" }),
				session({ id: "b", cwd: "/repos/kena" }),
				session({ id: "c", cwd: "/repos/kena/.wt/x", isWorktree: true }),
			]),
		);

		expect(choices[0]).toMatchObject({ cwd: "/repos/kena", sessions: 2 });
	});

	test("every offered cwd is an absolute path", () => {
		const choices = projectChoices(
			buildProjects([
				session({ id: "a", cwd: "/repos/kena" }),
				session({ id: "b", cwd: "/repos/taxiprime", projectRoot: "/repos/taxiprime", projectName: "taxiprime" }),
				session({ id: "old", cwd: "", projectRoot: "", projectName: "" }),
			]),
		);

		expect(choices.length).toBe(2);
		for (const choice of choices) expect(choice.cwd.startsWith("/")).toBe(true);
	});
});
