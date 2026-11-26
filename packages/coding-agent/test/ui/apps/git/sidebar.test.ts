import { signal } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { SidebarAction } from "../../../../src/cli/git-tui/model/sidebar";
import type { ChangedFile, GitViewState, HeadCommit } from "../../../../src/cli/git-tui/model/state";
import { GitSidebar, itemKey, lineAt, SidebarModel } from "../../../../src/ui/apps/git";
import { type AppDriver, appSuite } from "../harness";

process.env.TZ = "UTC";

interface SidebarInputs {
	readonly height: number;
	readonly focused: boolean;
	readonly model: GitViewState;
}

const DEFAULT_HEAD: HeadCommit = {
	sha: "abcdef0123456789abcdef0123456789abcdef01",
	shortSha: "abcdef0",
	subject: "Tighten the git viewer so the subject wraps across several lines when narrow",
	body: "Body line one\n\nBody line two is longer and should wrap when the sidebar is narrow enough to wrap it",
	authorName: "Robin Q Public",
	authorEmail: "robin@example.com",
	authorDate: "2023-10-01T10:00:00.000Z",
	parents: ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"],
	files: [
		{ path: "src/a.ts", area: "commit", kind: "modified", additions: 40, deletions: 2 },
		{ path: "src/b/c.ts", area: "commit", kind: "added", additions: 60 },
		{ path: "README.md", area: "commit", kind: "deleted", additions: 0, deletions: 4 },
	],
	filesLoaded: true,
};

const changed = (
	path: string,
	area: ChangedFile["area"],
	kind: ChangedFile["kind"] = "modified",
	additions?: number,
	deletions?: number,
): ChangedFile => ({
	path,
	area,
	kind,
	...(additions === undefined ? {} : { additions }),
	...(deletions === undefined ? {} : { deletions }),
});

type Mutable = { -readonly [K in keyof GitViewState]: GitViewState[K] };

/** The host's side of a sidebar action: stage/unstage move files, discard drops them. */
function applyAction(state: Mutable, action: SidebarAction): void {
	if (action.type === "stage" || action.type === "unstage") {
		const from: "unstaged" | "staged" = action.type === "stage" ? "unstaged" : "staged";
		const to: "unstaged" | "staged" = action.type === "stage" ? "staged" : "unstaged";
		const moving = action.selection?.files ?? state[from];
		state[from] = state[from].filter(file => !moving.includes(file));
		state[to] = [...state[to], ...moving.map(file => ({ ...file, area: to }))];
	} else if (action.type === "discard") {
		const files = action.selection.files;
		state.unstaged = state.unstaged.filter(file => !files.includes(file));
		state.staged = state.staged.filter(file => !files.includes(file));
	}
}

const type = (d: AppDriver, text: string) => {
	for (const ch of text) d.press(ch);
};
const action = (act: string) => (d: AppDriver) => void d.emit({ type: "action", key: "", act, mods: [] });

appSuite({
	dir: "apps/git-sidebar",
	mount(_caseName, corpusCase) {
		const inputs = corpusCase.inputs as SidebarInputs;
		const state: Mutable = structuredClone(inputs.model) as Mutable;
		const height = signal(inputs.height);
		const sidebar: SidebarModel = new SidebarModel(() => state, {
			onAction: act => {
				applyAction(state, act);
				sidebar.reconcile();
			},
		});
		sidebar.reconcile();
		sidebar.setFocused(inputs.focused);
		const clickLabel = (label: string) => (d: AppDriver) => {
			const rows = paintNode(d.env, d.root, 80, height()).rows.map(stripEscapes);
			const row = rows.findIndex(text => text.includes(label));
			if (row >= 0) sidebar.handleClick(row, Bun.stringWidth(rows[row]!.slice(0, rows[row]!.indexOf(label))));
		};
		const pick =
			(item: string, kind: "select" | "activate" = "select", list = "changes/unstaged") =>
			(d: AppDriver) =>
				void d.emit({ type: kind, key: list, item });
		const reconcileWith = (fn: () => void) => () => {
			fn();
			sidebar.reconcile();
		};
		return {
			view: () => GitSidebar({ model: sidebar }),
			height: () => height(),
			fresh: true,
			steps: {
				"collapse directory": d => {
					d.press("j");
					d.press("\x1b[D");
				},
				"left on child jumps to parent": d => {
					for (const key of ["\x1b[C", "j", "j", "\x1b[D"]) d.press(key);
				},
				"path style toggled": d => d.press("t"),
				"wheel down": () => sidebar.handleWheel(1),
				"wheel up": () => sidebar.handleWheel(-1),
				"wheel down 2": () => sidebar.handleWheel(2),
				"wheel 3": () => sidebar.handleWheel(3),
				"wheel -2": () => sidebar.handleWheel(-2),
				"click rows 0 1 3 4 5": () => {
					for (const row of [0, 1, 3, 4, 5]) sidebar.handleClick(row, 2);
				},
				"click rows 0 5 10 14 15 16": () => {
					for (const row of [0, 5, 10, 14, 15, 16]) sidebar.handleClick(row, 3);
				},
				"click row 5": () => sidebar.handleClick(5, 3),
				"click row 1": () => sidebar.handleClick(1, 1),
				"click 'Unstaged' header": clickLabel("Unstaged"),
				"click 'Staged' header": clickLabel("Staged"),
				"click 'Stage All' pill": clickLabel("Stage All"),
				"click 'Unstage All' pill": clickLabel("Unstage All"),
				"ai prompt typing": d => type(d, "tests only"),
				"ai prompt escape": () => void sidebar.handleEscape(),
				"native stage-ai reopens prompt": action("stage-ai"),
				"ai prompt typing docs": d => type(d, "docs"),
				"ai prompt native edit": d =>
					void d.emit({ type: "edit", key: "", from: 0, to: 0, text: "x", cursor: 1, len: 0 }),
				"ai prompt submit": d => d.press("\r"),
				"fold unstaged": action("fold-unstaged"),
				"fold staged": action("fold-staged"),
				"unfold both": d => {
					action("fold-unstaged")(d);
					action("fold-staged")(d);
				},
				"native select src/a.ts": pick(itemKey("file:unstaged:src/a.ts")),
				"native select src/a.ts again": pick(itemKey("file:unstaged:src/a.ts")),
				"native select directory": pick(itemKey("dir:unstaged:src/deep/nested")),
				"native activate staged pkg/x.ts": pick(itemKey("file:staged:pkg/x.ts"), "activate", "changes/staged"),
				"native select path style": pick("path"),
				"native select unknown item": pick("nope"),
				"native select commit file src/a.ts": pick(itemKey("file:commit:src/a.ts"), "select", "commit-files"),
				"native select commit dir src/b": pick(itemKey("dir:commit:src/b"), "select", "commit-files"),
				"edit summary": action("edit-summary"),
				"summary typed past 72 chars": d =>
					type(d, "fix: a summary that is long enough to go past the seventy-two character limit!"),
				"summary native edit": d =>
					void d.emit({ type: "edit", key: "", from: 0, to: 3, text: "feat", cursor: 4, len: 3 }),
				"edit description": action("edit-description"),
				"description two lines": d => {
					type(d, "line one");
					d.press("\n");
					type(d, "line two");
				},
				"description native edit": d =>
					void d.emit({ type: "edit", key: "", from: 0, to: 0, text: "> ", cursor: 2, len: 0 }),
				"description cursor up twice": d => {
					d.press("\x1b[A");
					d.press("\x1b[A");
				},
				escape: () => void sidebar.handleEscape(),
				"amend toggled": action("amend"),
				generating: () => sidebar.setGenerating(true),
				"generated commit message": () => {
					sidebar.setGeneratedCommit({ type: "fix", scope: "git", summary: "corrected", body: ["one", "two"] });
					sidebar.setGenerating(false);
				},
				"native commit": action("commit"),
				"form cleared": () => sidebar.clearForm(),
				"fields set directly: amend, generating, path style, summary 'direct'": () => {
					sidebar.amend.set(true);
					sidebar.generating.set(true);
					sidebar.viewStyle.set("path");
					sidebar.summary.set(lineAt("direct"));
				},
				unfocused: () => sidebar.setFocused(false),
				focused: () => sidebar.setFocused(true),
				refocused: () => sidebar.setFocused(true),
				blurred: () => sidebar.setFocused(false),
				"host drops first unstaged file, branch main (no reconcile)": () => {
					sidebar.setFocused(false);
					state.unstaged = state.unstaged.slice(1);
					state.branch = "main";
					sidebar.refresh();
				},
				reconciled: () => void sidebar.reconcile(),
				"select next then previous file": () => {
					sidebar.setFocused(true);
					sidebar.selectAdjacentFile(1);
					sidebar.selectAdjacentFile(-1, sidebar.selectedFile);
				},
				"select next file": () => void sidebar.selectAdjacentFile(1),
				"focus commit form": () => void sidebar.focusCommitForm(),
				"height 4": () => height.set(4),
				"height 40": () => height.set(40),
				"native stage all": action("stage-all"),
				"native unstage all": action("unstage-all"),
				"tree goes clean": reconcileWith(() => {
					state.unstaged = [];
					state.staged = [];
					state.clean = true;
				}),
				"commit files loading": reconcileWith(() => {
					state.headCommit = { ...state.headCommit!, files: [], filesLoaded: false };
				}),
				"30 commit files, no body, root commit, unparseable date": reconcileWith(() => {
					state.headCommit = {
						...state.headCommit!,
						body: "",
						parents: [],
						authorDate: "garbage",
						files: Array.from({ length: 30 }, (_, i) =>
							changed(`p${i % 3}/f${i}.ts`, "commit", "modified", i, 1),
						),
						filesLoaded: true,
					};
				}),
				"tree dirty again": reconcileWith(() => {
					state.clean = false;
					state.unstaged = [changed("x/y.ts", "unstaged")];
				}),
				"first commit appears": reconcileWith(() => {
					state.headCommit = DEFAULT_HEAD;
				}),
			},
		};
	},
});
