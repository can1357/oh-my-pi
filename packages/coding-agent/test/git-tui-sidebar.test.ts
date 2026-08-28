import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { parseFileSelection, parseVerdict } from "../src/cli/git-tui/ai-stage";
import { AvatarLoader } from "../src/cli/git-tui/avatar";
import { Sidebar, type SidebarAction } from "../src/cli/git-tui/sidebar";
import { GitModel } from "../src/cli/git-tui/state";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

/** Repo with three untracked files under two directories: a/one.txt, a/two.txt, b/three.txt. */
async function withDirtyRepo(run: (harness: SidebarHarness) => Promise<void>): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-tui-sidebar-"));
	try {
		await $`git init --initial-branch=main`.cwd(repo).quiet();
		await $`git config user.name "Test User"`.cwd(repo).quiet();
		await $`git config user.email "test@example.com"`.cwd(repo).quiet();
		await Bun.write(path.join(repo, "seed.txt"), "seed\n");
		await $`git add seed.txt`.cwd(repo).quiet();
		await $`git commit -m base`.cwd(repo).quiet();
		await Bun.write(path.join(repo, "a/one.txt"), "one\n");
		await Bun.write(path.join(repo, "a/two.txt"), "two\n");
		await Bun.write(path.join(repo, "b/three.txt"), "three\n");
		await run(await SidebarHarness.create(repo));
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

/** Repo where a/ holds both a modified tracked file and an untracked one: a/tracked.txt (M), a/new.txt (?). */
async function withMixedRepo(run: (harness: SidebarHarness) => Promise<void>): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-tui-sidebar-mixed-"));
	try {
		await $`git init --initial-branch=main`.cwd(repo).quiet();
		await $`git config user.name "Test User"`.cwd(repo).quiet();
		await $`git config user.email "test@example.com"`.cwd(repo).quiet();
		await Bun.write(path.join(repo, "a/tracked.txt"), "before\n");
		await $`git add a/tracked.txt`.cwd(repo).quiet();
		await $`git commit -m base`.cwd(repo).quiet();
		await Bun.write(path.join(repo, "a/tracked.txt"), "after\n");
		await Bun.write(path.join(repo, "a/new.txt"), "new\n");
		await run(await SidebarHarness.create(repo));
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

/** Drives a real Sidebar against a real GitModel, applying raised actions like the root component. */
class SidebarHarness {
	readonly actions: SidebarAction[] = [];
	readonly model: GitModel;
	readonly sidebar: Sidebar;

	private constructor(model: GitModel) {
		this.model = model;
		this.sidebar = new Sidebar({
			model,
			avatars: new AvatarLoader(() => {}),
			onSelectFile: () => {},
			onAction: action => this.actions.push(action),
			onFocusDiff: () => {},
			requestRender: () => {},
		});
	}

	static async create(repo: string): Promise<SidebarHarness> {
		const model = new GitModel(repo);
		await model.refresh();
		const harness = new SidebarHarness(model);
		harness.sidebar.reconcile();
		return harness;
	}

	/** Apply the last raised stage/unstage action the way GitTuiComponent#runAction does. */
	async applyLastAction(): Promise<void> {
		const action = this.actions.at(-1);
		if (!action || (action.type !== "stage" && action.type !== "unstage"))
			throw new Error("no stage/unstage action was raised");
		if (action.type === "stage") await this.model.stage(action.selection?.files);
		else await this.model.unstage(action.selection?.files);
		await this.model.refresh();
		this.sidebar.reconcile();
	}
}

describe("git tui sidebar staging", () => {
	test("staging a file keeps selection on the next row instead of jumping to the top", async () => {
		await withDirtyRepo(async ({ sidebar, model, actions }) => {
			// Tree order: [Stage All] → dir a/ → a/one.txt → a/two.txt → dir b/ → b/three.txt.
			sidebar.handleInput("j");
			sidebar.handleInput("j");
			expect(sidebar.selectedFile?.path).toBe("a/one.txt");

			sidebar.handleInput(" ");
			const action = actions.at(-1);
			expect(action).toEqual({
				type: "stage",
				selection: {
					files: [expect.objectContaining({ path: "a/one.txt", area: "unstaged" })],
					label: "a/one.txt",
				},
			});
			await model.stage(action?.type === "stage" ? action.selection?.files : undefined);
			await model.refresh();
			sidebar.reconcile();

			// Regression: the removed row used to fall back to targets[0] (the Stage All header).
			expect(sidebar.selectedFile?.path).toBe("a/two.txt");
			expect(sidebar.selectedFile?.area).toBe("unstaged");
		});
	});

	test("space on a directory stages every file underneath it", async () => {
		await withDirtyRepo(async harness => {
			const { sidebar, model, actions } = harness;
			sidebar.handleInput("j"); // dir a/
			sidebar.handleInput(" ");
			expect(actions.at(-1)).toEqual({
				type: "stage",
				selection: {
					files: [expect.objectContaining({ path: "a/one.txt" }), expect.objectContaining({ path: "a/two.txt" })],
					label: "a/",
				},
			});
			await harness.applyLastAction();

			expect(model.staged.map(file => file.path).sort()).toEqual(["a/one.txt", "a/two.txt"]);
			expect(model.unstaged.map(file => file.path)).toEqual(["b/three.txt"]);
			// Selection survives onto the next row of the unstaged section.
			expect(sidebar.selected?.kind).toBe("dir");
		});
	});

	test("u on a staged directory unstages it; s on it is a no-op", async () => {
		await withDirtyRepo(async harness => {
			const { sidebar, model } = harness;
			sidebar.handleInput("j"); // dir a/
			sidebar.handleInput(" ");
			await harness.applyLastAction();

			// Walk into the staged section: dir b/ → b/three.txt → [Unstage All] → dir a/.
			sidebar.handleInput("j");
			sidebar.handleInput("j");
			sidebar.handleInput("j");
			expect(sidebar.selected?.kind).toBe("dir");

			const before = harness.actions.length;
			sidebar.handleInput("s"); // wrong direction for a staged dir
			expect(harness.actions.length).toBe(before);

			sidebar.handleInput("u");
			expect(harness.actions.at(-1)).toEqual({
				type: "unstage",
				selection: {
					files: [
						expect.objectContaining({ path: "a/one.txt", area: "staged" }),
						expect.objectContaining({ path: "a/two.txt", area: "staged" }),
					],
					label: "a/",
				},
			});
			await harness.applyLastAction();
			expect(model.staged).toEqual([]);
			expect(model.unstaged.map(file => file.path).sort()).toEqual(["a/one.txt", "a/two.txt", "b/three.txt"]);
		});
	});
	test("pure additions form their own list; staging their dir skips modified siblings", async () => {
		await withMixedRepo(async harness => {
			const { sidebar, model, actions } = harness;
			// Targets: [Stage All] → dir a/ (changes) → a/tracked.txt → dir a/ (additions) → a/new.txt.
			sidebar.handleInput("j");
			expect(sidebar.selected?.kind).toBe("dir");
			sidebar.handleInput("j");
			expect(sidebar.selectedFile?.path).toBe("a/tracked.txt");
			sidebar.handleInput("j");
			expect(sidebar.selected?.kind).toBe("dir");
			sidebar.handleInput("j");
			expect(sidebar.selectedFile?.path).toBe("a/new.txt");

			// Space on the additions-list a/ dir stages only the new file, not the modified sibling.
			sidebar.handleInput("k");
			sidebar.handleInput(" ");
			expect(actions.at(-1)).toEqual({
				type: "stage",
				selection: { files: [expect.objectContaining({ path: "a/new.txt" })], label: "a/" },
			});
			await harness.applyLastAction();
			expect(model.staged.map(file => file.path)).toEqual(["a/new.txt"]);
			expect(model.unstaged.map(file => file.path)).toEqual(["a/tracked.txt"]);
		});
	});
	test("clicking the section header label folds it instead of staging everything", async () => {
		await withDirtyRepo(async ({ sidebar, actions }) => {
			const lines = sidebar.render(40, 30);
			const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
			const headerRow = lines.findIndex(line => strip(line).includes("Unstaged Files"));
			expect(headerRow).toBeGreaterThanOrEqual(0);

			// Regression (#e0a92099dd follow-up): a label click used to fall through
			// to the row-level stage-all target and stage the whole changeset.
			sidebar.handleClick(headerRow, 2);
			expect(actions).toEqual([]);
			expect(sidebar.selected).toEqual({ kind: "section", area: "unstaged" });

			// Folded: chevron flips and the section's rows leave render + keyboard nav.
			const folded = sidebar.render(40, 30);
			expect(strip(folded[headerRow] ?? "")).toContain("▸ Unstaged Files");
			expect(folded.some(line => strip(line).includes("one.txt"))).toBe(false);
			sidebar.handleInput("j");
			expect(sidebar.selected).toEqual({ kind: "section", area: "staged" });

			// Second label click unfolds.
			sidebar.handleInput("k");
			sidebar.handleClick(headerRow, 2);
			const unfolded = sidebar.render(40, 30);
			expect(strip(unfolded[headerRow] ?? "")).toContain("▾ Unstaged Files");
			expect(unfolded.some(line => strip(line).includes("one.txt"))).toBe(true);
		});
	});

	test("only the header pill stages everything; selection stays on the header", async () => {
		await withDirtyRepo(async ({ sidebar, actions }) => {
			const lines = sidebar.render(40, 30);
			const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
			const headerRow = lines.findIndex(line => strip(line).includes("Unstaged Files"));
			const pillCol = strip(lines[headerRow] ?? "").indexOf("Stage All");
			expect(pillCol).toBeGreaterThan(0);

			sidebar.handleClick(headerRow, pillCol + 1);
			expect(actions).toEqual([{ type: "stage" }]);
			expect(sidebar.selected).toEqual({ kind: "section", area: "unstaged" });
		});
	});

	test("wheel scroll away from the selection survives idle re-renders", async () => {
		await withDirtyRepo(async ({ sidebar }) => {
			const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
			// Select the last file so the follow-selection clamp scrolls the list down.
			for (let i = 0; i < 5; i++) sidebar.handleInput("j");
			expect(sidebar.selectedFile?.path).toBe("b/three.txt");
			const scrolled = sidebar.render(40, 12);
			expect(strip(scrolled[0] ?? "")).not.toContain("file change");

			// Wheel back to the top; an idle re-render (2s refresh tick) must not
			// snap the viewport back down to keep the selection visible.
			sidebar.handleWheel(-4);
			sidebar.render(40, 12);
			const idle = sidebar.render(40, 12);
			expect(strip(idle[0] ?? "")).toContain("file change");

			// An explicit selection change still pulls the row into view.
			sidebar.handleInput("j");
			const followed = sidebar.render(40, 12);
			expect(followed.some(line => strip(line).includes("Staged Files"))).toBe(true);
		});
	});

	test("empty commit action generates before a populated action commits", async () => {
		await withDirtyRepo(async ({ sidebar, actions }) => {
			sidebar.handleInput("G");
			expect(sidebar.selected?.kind).toBe("commit-button");

			sidebar.handleInput("\r");
			expect(actions.at(-1)).toEqual({ type: "generate" });

			sidebar.setGeneratedCommit({
				type: "fix",
				scope: "git-tui",
				summary: "corrected generated commit flow",
				body: ["Preserved staged-tree analysis."],
				footers: [],
			});
			expect(sidebar.summary.getValue()).toBe("fix(git-tui): corrected generated commit flow");
			expect(sidebar.description.getText()).toBe("- Preserved staged-tree analysis.");

			sidebar.handleInput("\r");
			expect(actions.at(-1)).toEqual({
				type: "commit",
				message: "fix(git-tui): corrected generated commit flow\n\n- Preserved staged-tree analysis.",
				amend: false,
				stageAll: true,
			});
		});
	});
	test("wand pill opens the AI textbox; enter raises stage-ai with the typed prompt", async () => {
		await withDirtyRepo(async ({ sidebar, actions }) => {
			sidebar.setFocused(true);
			const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
			const lines = sidebar.render(44, 30);
			const headerRow = lines.findIndex(line => strip(line).includes("Unstaged Files"));
			const header = strip(lines[headerRow] ?? "");
			// Non-nerd preset renders the wand pill as ✦ next to Stage All.
			const wandCol = header.indexOf("✦");
			expect(wandCol).toBeGreaterThan(header.indexOf("Stage All"));

			// Clicking the wand opens the textbox row under the header without staging anything.
			sidebar.handleClick(headerRow, wandCol);
			expect(actions).toEqual([]);
			expect(sidebar.editing).toBe(true);

			for (const ch of "all comment changes") sidebar.handleInput(ch);
			sidebar.handleInput("\r");
			expect(actions).toEqual([{ type: "stage-ai", prompt: "all comment changes" }]);
			// Submission closes the box and clears the typed prompt.
			expect(sidebar.aiInput.getValue()).toBe("");
			expect(sidebar.render(44, 30).some(line => strip(line).includes("What should we stage?"))).toBe(false);
		});
	});

	test("escape closes the AI textbox without raising an action and clears the draft", async () => {
		await withDirtyRepo(async ({ sidebar, actions }) => {
			sidebar.setFocused(true);
			const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
			const lines = sidebar.render(44, 30);
			const headerRow = lines.findIndex(line => strip(line).includes("Unstaged Files"));
			sidebar.handleClick(headerRow, strip(lines[headerRow] ?? "").indexOf("✦"));
			for (const ch of "abc") sidebar.handleInput(ch);

			expect(sidebar.handleEscape()).toBe(true);
			expect(actions).toEqual([]);
			expect(sidebar.aiInput.getValue()).toBe("");
			// Empty prompt + enter must not raise an action either.
			sidebar.handleClick(headerRow, strip(lines[headerRow] ?? "").indexOf("✦"));
			sidebar.handleInput("\r");
			expect(actions).toEqual([]);
		});
	});
});

describe("git tui ai-stage file selection parsing", () => {
	const paths = ["src/a.ts", "src/b.ts", "docs/notes.md"];

	test("verbatim echoes pick, with or without list decoration", () => {
		expect(parseFileSelection("src/a.ts\ndocs/notes.md", paths)).toEqual([1, 3]);
		// Bullets and the "(kind, +a −d)" annotation from the presented list survive.
		expect(parseFileSelection("- src/b.ts (modified, +4 −2)", paths)).toEqual([2]);
		expect(parseFileSelection("none", paths)).toEqual([]);
		expect(parseFileSelection("", paths)).toEqual([]);
	});

	test("prose mentions pick on path boundaries only", () => {
		expect(parseFileSelection("I would stage src/a.ts and nothing else", paths)).toEqual([1]);
		// `src/a.ts` inside a longer path is a different file, not a pick.
		expect(parseFileSelection("- vendored/src/a.ts", paths)).toEqual([]);
		expect(parseFileSelection("maybe src/a.ts.bak", paths)).toEqual([]);
	});
});

describe("git tui ai-stage verdict parsing", () => {
	test("earliest bare yes accepts; no, mixed order, and noise reject", () => {
		expect(parseVerdict("yes")).toBe(true);
		expect(parseVerdict("Yes.")).toBe(true);
		expect(parseVerdict("I would say yes")).toBe(true);
		expect(parseVerdict("no")).toBe(false);
		expect(parseVerdict("no, though parts could be yes")).toBe(false);
		expect(parseVerdict("yes — but actually no")).toBe(true);
		expect(parseVerdict("")).toBe(false);
		expect(parseVerdict("maybe")).toBe(false);
		// Substrings must not match: "eyes"/"nose" carry no verdict.
		expect(parseVerdict("eyes nose")).toBe(false);
	});
});
