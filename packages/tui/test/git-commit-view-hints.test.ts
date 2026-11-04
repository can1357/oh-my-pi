/**
 * On a clean tree the git sidebar renders the HEAD commit view instead of the
 * worktree view, and in that view stage and discard cannot fire: the diff pane
 * bails out for `area: "commit"` rows in `#patchTargetFor`/`#discardCurrentFile`
 * and the sidebar only builds stage/discard actions for the unstaged/staged
 * sections. These tests pin that the footer stops advertising the dead keys and
 * that the commit view names itself, without touching the worktree wording.
 */
import { describe, expect, it } from "bun:test";
import { stripTerminalSequences } from "@oh-my-pi/pi-tui/utils";
import { gitFooterHints } from "../src/apps/git/git-tui";
import { Sidebar } from "../src/apps/git/sidebar";
import type { ChangedFile, GitViewState, HeadCommit } from "../src/apps/git/state";
import { initTheme } from "../src/theme/theme";

const file = (path: string, area: ChangedFile["area"], additions = 1, deletions = 0): ChangedFile => ({
	path,
	kind: "modified",
	area,
	additions,
	deletions,
});

const head = (files: readonly ChangedFile[]): HeadCommit => ({
	sha: "abcdef0123456789abcdef0123456789abcdef01",
	shortSha: "abcdef0",
	subject: "Tighten the git viewer",
	body: "",
	authorName: "Robin",
	authorEmail: "robin@example.com",
	authorDate: "2026-10-01T10:00:00.000Z",
	parents: ["1111111111111111111111111111111111111111"],
	files,
	filesLoaded: true,
});

const state = (over: Partial<GitViewState> = {}): GitViewState => ({
	cwd: "/repo",
	branch: "main",
	clean: false,
	unstaged: [],
	staged: [],
	headCommit: null,
	...over,
});

/** The ANSI sidebar renderer — the path that renders the static footer and commit rows. */
const renderSidebar = async (model: GitViewState): Promise<string> => {
	await initTheme();
	return stripTerminalSequences(
		new Sidebar({
			model,
			avatars: { get: () => null },
			onSelectFile: () => {},
			onAction: () => {},
			onFocusDiff: () => {},
			requestRender: () => {},
		})
			.render(48, 24)
			.join("\n"),
	);
};

describe("git footer hints", () => {
	it("advertises stage and discard while the worktree has changes", () => {
		for (const focus of ["sidebar", "diff"] as const) {
			const hints = gitFooterHints(false, focus);
			expect(hints).toContain("stage");
			expect(hints).toContain("discard");
		}
	});

	it("drops stage and discard in the commit view, where both keys are no-ops", () => {
		for (const focus of ["sidebar", "diff"] as const) {
			const hints = gitFooterHints(true, focus);
			expect(hints).not.toContain("stage");
			expect(hints).not.toContain("discard");
		}
	});

	it("keeps the keys that still work in the commit view", () => {
		expect(gitFooterHints(true, "sidebar")).toContain("quit");
		expect(gitFooterHints(true, "diff")).toContain("view");
	});

	it("drops commit and select in the commit view, where both are no-ops", () => {
		for (const focus of ["sidebar", "diff"] as const) {
			expect(gitFooterHints(true, focus)).not.toContain("commit");
		}
		expect(gitFooterHints(true, "diff")).not.toContain("select");
		expect(gitFooterHints(false, "diff")).toContain("commit");
		expect(gitFooterHints(false, "diff")).toContain("select");
	});
});

describe("git commit view wording", () => {
	it("says the working tree is clean and attributes the counts to the commit", async () => {
		const out = await renderSidebar(
			state({
				clean: true,
				headCommit: head([file("src/a.ts", "commit", 40, 2), file("README.md", "commit", 60, 4)]),
			}),
		);
		expect(out).toContain("Working tree clean");
		expect(out).toContain("showing committed abcdef0");
		expect(out).toContain("2 files in abcdef0");
		expect(out).not.toContain("2 modified");
	});

	it("leaves the worktree view describing changes on the branch", async () => {
		const out = await renderSidebar(
			state({
				unstaged: [file("src/a.ts", "unstaged")],
				staged: [file("README.md", "staged")],
			}),
		);
		expect(out).toContain("2 file changes on");
		expect(out).not.toContain("Working tree clean");
	});
});
