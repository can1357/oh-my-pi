import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { type SidebarAction } from "@oh-my-pi/pi-coding-agent/cli/git-tui/model/sidebar";
import type { ChangedFile } from "@oh-my-pi/pi-coding-agent/cli/git-tui/model/state";
import { GitModel } from "../src/cli/git-tui/state";
import { SidebarModel, type SidebarTarget } from "../src/ui/apps/git/sidebar-model";
import { paintSidebar } from "../src/ui/styles/apps/git/sidebar";
import { initTheme } from "../src/ui/theme/service";

beforeAll(() => {
	initTheme({ dark: "dark", light: "dark", capabilities: { truecolor: true, colors: 16_777_216, dark: true } });
});

/** A key press as the driver decodes `input` (`j`, ` `, `\r`, `G`). */
function key(input: string): KeyEvent {
	if (input === "\r") return { id: "enter", kind: "press", raw: input };
	if (input === " ") return { id: "space", text: " ", kind: "press", raw: input };
	const lower = input.toLowerCase();
	return { id: input === lower ? input : `shift+${lower}`, text: input, kind: "press", raw: input };
}

/** The selection with its identity key dropped (what the assertions compare). */
function shape(target: SidebarTarget | undefined): unknown {
	if (!target) return undefined;
	if (target.kind === "entry") return { kind: target.entry.kind };
	const { key: _key, ...rest } = target;
	return rest;
}

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

/** Drives a real sidebar against a real GitModel, applying raised actions like the app does. */
class SidebarHarness {
	readonly actions: SidebarAction[] = [];
	readonly model: GitModel;
	readonly sidebar: {
		handleInput(input: string): void;
		handleClick(row: number, col: number): void;
		handleWheel(delta: number): void;
		handleEscape(): boolean;
		render(width: number, height: number): string[];
		setFocused(focused: boolean): void;
		setGeneratedCommit: SidebarModel["setGeneratedCommit"];
		reconcile(): void;
		readonly selected: unknown;
		readonly selectedFile: ChangedFile | null;
		readonly editing: boolean;
		readonly summary: string;
		readonly description: string;
		readonly aiPrompt: string;
	};

	private constructor(model: GitModel) {
		this.model = model;
		const sidebar = new SidebarModel(() => model, { onAction: action => this.actions.push(action) });
		this.sidebar = {
			handleInput: input => void sidebar.handleKey(key(input)),
			handleClick: (row, col) => sidebar.handleClick(row, col),
			handleWheel: delta => sidebar.handleWheel(delta),
			handleEscape: () => sidebar.handleEscape(),
			render: (width, height) => paintSidebar(currentTheme(), sidebar.layout(width, height), width),
			setFocused: focused => sidebar.setFocused(focused),
			setGeneratedCommit: commit => sidebar.setGeneratedCommit(commit),
			reconcile: () => void sidebar.reconcile(),
			get selected() {
				return shape(sidebar.selected());
			},
			get selectedFile() {
				return sidebar.selectedFile;
			},
			get editing() {
				return sidebar.editing() !== undefined;
			},
			get summary() {
				return sidebar.summary().text;
			},
			get description() {
				return sidebar.description().text;
			},
			get aiPrompt() {
				return sidebar.aiPrompt().text;
			},
		};
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
			expect(sidebar.selected).toEqual({ kind: "dir" });
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
			expect(sidebar.selected).toEqual({ kind: "dir" });

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
	test("staging a directory with mixed tracked and untracked files stages both", async () => {
		await withMixedRepo(async harness => {
			const { sidebar, model, actions } = harness;
			// Targets: [Stage All] → dir a/ → a/tracked.txt → a/new.txt.
			sidebar.handleInput("j");
			expect(sidebar.selected).toEqual({ kind: "dir" });
			sidebar.handleInput("j");
			expect(sidebar.selectedFile?.path).toBe("a/tracked.txt");
			sidebar.handleInput("j");
			expect(sidebar.selectedFile?.path).toBe("a/new.txt");

			// Space on the a/ dir stages the modified and the untracked file alike.
			sidebar.handleInput("k");
			sidebar.handleInput("k");
			sidebar.handleInput(" ");
			expect(actions.at(-1)).toEqual({
				type: "stage",
				selection: {
					files: [
						expect.objectContaining({ path: "a/tracked.txt" }),
						expect.objectContaining({ path: "a/new.txt" }),
					],
					label: "a/",
				},
			});
			await harness.applyLastAction();
			expect(model.staged.map(file => file.path).sort()).toEqual(["a/new.txt", "a/tracked.txt"]);
			expect(model.unstaged).toEqual([]);
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
			expect(sidebar.selected).toEqual({ kind: "commit-button" });

			sidebar.handleInput("\r");
			expect(actions.at(-1)).toEqual({ type: "generate" });

			sidebar.setGeneratedCommit({
				type: "fix",
				scope: "git-tui",
				summary: "corrected generated commit flow",
				body: ["Preserved staged-tree analysis."],
			});
			expect(sidebar.summary).toBe("fix(git-tui): corrected generated commit flow");
			expect(sidebar.description).toBe("- Preserved staged-tree analysis.");

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
			expect(sidebar.aiPrompt).toBe("");
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
			expect(sidebar.aiPrompt).toBe("");
			// Empty prompt + enter must not raise an action either.
			sidebar.handleClick(headerRow, strip(lines[headerRow] ?? "").indexOf("✦"));
			sidebar.handleInput("\r");
			expect(actions).toEqual([]);
		});
	});
});
