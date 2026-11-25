import { afterAll, beforeAll, expect, it } from "bun:test";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import type { GitTuiHost } from "../../../../src/cli/git-tui/model/git-tui";
import type {
	AssetFileContents,
	ChangedFile,
	FileContents,
	GitTuiModel,
	GitViewState,
} from "../../../../src/cli/git-tui/model/state";
import { GitApp, GitAppModel } from "../../../../src/ui/apps/git";
import { presentGitApp } from "../../../../src/cli/git-tui";
import { setKeyHintPlatform } from "../../../../src/ui/keys/format";
import { ensureTheme } from "../../../../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "../../../helpers/mode-terminal";
import { nativeShell } from "../../../helpers/native-shell";
import { type AppDriver, appSuite } from "../harness";

process.env.TZ = "UTC";

// Key hints draw macOS modifier glyphs (`⌥↑`) here on every host; Linux spells them out (`Alt+↑`).
beforeAll(() => setKeyHintPlatform("darwin"));
afterAll(() => setKeyHintPlatform(undefined));

interface AppInputs {
	readonly model: GitViewState;
	readonly contents: string | AssetFileContents | { kind: "text"; oldText: string; newText: string };
	readonly aiStage: Awaited<ReturnType<GitTuiHost["aiStage"]>>;
	readonly generateCommitMessage: Awaited<ReturnType<GitTuiHost["generateCommitMessage"]>>;
}

type Mutable = { -readonly [K in keyof GitViewState]: GitViewState[K] };

/** One turn of the event loop (pending promise chains run to their next macrotask). */
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Let pending promises and short async chains finish. */
async function settle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) await turn();
}

/** The capture's repository: stage/unstage move files, discard drops them, commit empties staged. */
function fakeModel(inputs: Pick<AppInputs, "model" | "contents">): GitTuiModel {
	const state = structuredClone(inputs.model) as Mutable;
	let dirty = false;
	const move = (files: readonly ChangedFile[] | undefined, from: "unstaged" | "staged", to: "unstaged" | "staged") => {
		const moving = files ?? state[from];
		const keys = new Set(moving.map(file => file.path));
		state[from] = state[from].filter(file => !keys.has(file.path));
		state[to] = [...state[to], ...moving.map(file => ({ ...file, area: to }))];
		dirty = true;
	};
	return {
		get cwd() {
			return state.cwd;
		},
		get branch() {
			return state.branch;
		},
		get clean() {
			return state.clean;
		},
		get unstaged() {
			return state.unstaged;
		},
		get staged() {
			return state.staged;
		},
		get headCommit() {
			return state.headCommit;
		},
		refresh: async () => {
			const changed = dirty;
			dirty = false;
			return changed;
		},
		loadChangeStats: async () => false,
		loadHeadFiles: async () => false,
		streamContents: async (): Promise<FileContents> => {
			// The capture showed its first frame before the contents arrived.
			await turn();
			const contents = inputs.contents;
			if (typeof contents === "string") throw new Error("git failed:\n  bad object");
			if (contents.kind === "asset") return contents;
			return {
				kind: "text",
				oldText: contents.oldText,
				newText: contents.newText,
				streamResult: undefined as never,
			};
		},
		stage: async files => move(files, "unstaged", "staged"),
		unstage: async files => move(files, "staged", "unstaged"),
		discard: async files => {
			const keys = new Set(files.map(file => file.path));
			state.unstaged = state.unstaged.filter(file => !keys.has(file.path));
			state.staged = state.staged.filter(file => !keys.has(file.path));
			dirty = true;
		},
		commit: async () => {
			state.staged = [];
			dirty = true;
		},
		applyPatch: async () => {},
	};
}

/** The real fullscreen entry on a memory terminal; no repository operation can reach live Git. */
async function withGitScreen(run: (term: ModeTerminal, app: GitAppModel, closed: Promise<void>) => Promise<void>) {
	ensureTheme();
	const term = createModeTerminal({ columns: 140, rows: 32 });
	const shell = term.frame.shell;
	await term.start();
	shell.setInlineMouse("any");
	const model = fakeModel({
		model: {
			cwd: "/fixture",
			branch: "test",
			clean: false,
			unstaged: [{ path: "fixture.txt", kind: "modified", area: "unstaged" }],
			staged: [],
			headCommit: null,
		},
		contents: { kind: "asset", old: { kind: "empty" }, new: { kind: "binary", byteLength: 1 } },
	});
	const closed = presentGitApp(shell, {
		model,
		createAvatarSource: () => ({ get: () => null }),
		aiStage: async () => {
			throw new Error("unexpected AI stage");
		},
		generateCommitMessage: async () => {
			throw new Error("unexpected commit generation");
		},
	});
	const view = shell.overlays.top()!.node.children()[0]!;
	const app = (view.props() as { term: { app: GitAppModel } }).term.app;
	try {
		await term.waitFor(screen => screen[0]?.includes("Stage File") === true);
		await run(term, app, closed);
	} finally {
		app.quit();
		await closed;
		await shell.stop();
		shell.surface.dispose();
		term.dispose();
	}
}

it("draws the shortcuts as bare text over four fifths of the screen, hiding the app beneath", () =>
	withGitScreen(async (term, app, closed) => {
		term.feed("?");
		await term.waitFor(screen => screen.some(row => row.includes("Move the selection")));
		const screen = term.screen();
		const at = screen.findIndex(row => row.includes("Keyboard shortcuts"));
		// 112 of 140 columns, centered: no frame around the text, blank to the sheet's right edge.
		expect(screen[at]!.slice(14, 126).trimEnd()).toBe(" Keyboard shortcuts");
		expect(screen.some(row => row[14] === "╭" || row[14] === "│")).toBe(false);
		const move = screen.find(row => row.includes("Move the selection"))!;
		expect(move.slice(14, 126).trim()).toBe("↑ ↓      Move the selection");
		term.press("escape");
		await term.waitFor(() => !app.helpOpen());
		app.quit();
		await closed;
	}));

it("keeps Git keyboard focus across the responsive breakpoint, including under help", () =>
	withGitScreen(async (term, app, closed) => {
		const hover = () => term.engine.encodeMouse({ x: 1, y: 0, action: "move" });
		const shell = term.frame.shell;
		const focus = shell.focused();
		expect(hover()).toBe(""); // Git requests drag, not inline all-motion tracking.
		const stageCol = term.screen()[0]!.indexOf("Stage File") + 5;
		const pressStage = () => term.feed(`\x1b[<0;${stageCol + 1};1M`);
		term.feed("?");
		pressStage(); // A queued report, before the sheet has painted.
		await term.waitFor(screen => screen.some(row => row.includes("Move the selection")));
		pressStage(); // Even a terminal sending reports despite the sheet's request cannot click through it.
		expect(app.model.unstaged.map(file => file.path)).toEqual(["fixture.txt"]);
		term.press("escape");
		await term.waitFor(screen => !screen.some(row => row.includes("Move the selection")));
		pressStage(); // Positive control: the same cell stages the in-memory file without the modal.
		await term.waitFor(screen => screen[0]?.includes("Unstage File") === true);
		term.feed("?");
		term.resize(90, 32);
		term.press("escape");
		await term.waitFor(() => !app.helpOpen());
		expect(shell.focused()).toBe(focus);
		const before = app.focus();
		term.press("tab");
		expect(app.focus()).not.toBe(before);
		term.feed("q");
		await turn();
		expect(shell.overlays.open()).toBe(false);
		await closed;
		expect(shell.focused()).toBe(term.frame.composer.field);
		expect(hover()).not.toBe(""); // The session's all-motion reporting is back.
	}));

it("routes bracketed paste to the active Git field only", () =>
	withGitScreen(async (term, app) => {
		term.paste("cqs");
		expect(app.sidebar.summary().text).toBe("");
		expect(app.sidebar.editing()).toBeUndefined();

		term.feed("c");
		term.type("ab");
		term.press("left");
		term.paste("fix\r\nit");
		expect(app.sidebar.summary()).toEqual({ text: "afixitb", cursor: 6 });
		term.press("enter");
		term.paste("first\r\nsecond");
		// Input behind an Enter is delivered on the next event-loop turn, to whatever the Enter focused.
		await Bun.sleep(5);
		expect(app.sidebar.description().text).toBe("first\nsecond");

		const section = term.screen().findIndex(row => row.includes("Unstaged Files"));
		expect(section).toBeGreaterThan(0);
		term.mouse({ x: 137, y: section }); // wand at the right end of the unstaged section
		expect(app.sidebar.editing()).toBe("stage-ai-input");
		term.paste("tests only");
		expect(app.sidebar.aiPrompt().text).toBe("tests only");
		expect(app.model.staged).toEqual([]);
	}));

it("sends Tern the toolbar and sidebar as buttons whose clicks stage and close", async () => {
	ensureTheme();
	await using ui = await nativeShell();
	const model = fakeModel({
		model: {
			cwd: "/fixture",
			branch: "test",
			clean: false,
			unstaged: [{ path: "fixture.txt", kind: "modified", area: "unstaged" }],
			staged: [],
			headCommit: null,
		},
		contents: { kind: "text", oldText: "a\n", newText: "b\n" },
	});
	const closed = presentGitApp(ui.shell, {
		model,
		createAvatarSource: () => ({ get: () => null }),
		aiStage: async () => {
			throw new Error("unexpected AI stage");
		},
		generateCommitMessage: async () => {
			throw new Error("unexpected commit generation");
		},
	});
	await settle();
	expect(ui.node("button", "prev-hunk").p).toEqual({
		role: "omp.app.ibtn",
		variant: "quiet",
		icon: "chev-up",
		title: "Previous change (⌥↑)",
		aria: "Previous change (⌥↑)",
		actions: { click: "prev-hunk" },
	});
	expect(ui.node("button", "stage-file").p).toEqual({
		role: "omp.btn",
		text: "Stage file",
		title: "Stage fixture.txt",
		keys: ["s"],
		actions: { click: "stage-file" },
	});
	expect(ui.node("button", "stage-all").p).toMatchObject({ role: "omp.app.qbtn", variant: "quiet", size: "sm" });
	expect(ui.node("button", "ai").p).toMatchObject({
		role: "omp.app.ibtn",
		icon: "wand",
		aria: "Stage by description",
	});
	expect(ui.node("tabs", "views").p.variant).toBe("segmented");
	expect(ui.node("tabs", "style").p.variant).toBe("segmented");
	expect(ui.node("button", "commit").p).toMatchObject({ role: "omp.btn", text: "Generate message" });

	ui.click("button", "stage-file");
	await settle();
	expect(model.staged.map(file => file.path)).toEqual(["fixture.txt"]);
	expect(ui.node("button", "stage-file").p).toMatchObject({ text: "Unstage file", title: "Unstage fixture.txt" });
	expect(ui.node("button", "unstage-all").p.text).toBe("Unstage all");

	ui.click("button", "close");
	await closed;
	expect(ui.shell.overlays.open()).toBe(false);
});

it("scrolls the focused Git commit diff with arrow and page keys without switching files", async () => {
	ensureTheme();
	await using ui = await nativeShell();
	ui.send({ ev: "features", features: ["aside", "settle", "scroll"] });
	const model = fakeModel({
		model: {
			cwd: "/fixture",
			branch: "test",
			clean: true,
			unstaged: [],
			staged: [],
			headCommit: {
				sha: "0123456789",
				shortSha: "0123456",
				subject: "Change two files",
				body: "",
				authorName: "Test",
				authorEmail: "test@example.com",
				authorDate: "2026-01-01T00:00:00Z",
				parents: ["1234567890"],
				files: [
					{ path: "a.txt", kind: "added", area: "commit" },
					{ path: "b.txt", kind: "added", area: "commit" },
				],
				filesLoaded: true,
			},
		},
		contents: {
			kind: "text",
			oldText: "",
			newText: Array.from({ length: 100 }, (_, line) => `Added line ${line + 1}\n`).join(""),
		},
	});
	const closed = presentGitApp(ui.shell, {
		model,
		createAvatarSource: () => ({ get: () => null }),
		aiStage: async () => {
			throw new Error("unexpected AI stage");
		},
		generateCommitMessage: async () => {
			throw new Error("unexpected commit generation");
		},
	});
	await settle();
	const diff = ui.node("diff");
	expect(diff.p.path).toBe("a.txt");
	ui.type("\x1b[A");
	expect(ui.scrolls()).toEqual([]);

	ui.type("\r");
	await settle();
	for (const key of ["\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) {
		ui.type(key);
		await settle();
	}
	expect(ui.scrolls()).toEqual([
		[diff.id, "line-down"],
		[diff.id, "line-up"],
		[diff.id, "page-down"],
		[diff.id, "page-down"],
		[diff.id, "page-up"],
	]);
	expect(ui.node("diff").p.path).toBe("a.txt");

	ui.type("]");
	await settle();
	expect(ui.node("diff").p.path).toBe("b.txt");
	ui.type("q");
	await closed;
});

/** SGR mouse bytes as a pointer event (0-based cells). */
function decodeMouse(data: string): MouseEvent | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	const code = Number(match[1]);
	const button =
		code & 64 ? (code & 1 ? "wheel-down" : "wheel-up") : ((["left", "middle", "right"] as const)[code & 3] ?? "none");
	return {
		row: Number(match[3]) - 1,
		col: Number(match[2]) - 1,
		button,
		action: match[4] === "M" ? "press" : "release",
		mods: code & 4 ? ["shift"] : [],
	};
}

const click = (row: number, col: number, button = 0) => [
	`\x1b[<${button};${col + 1};${row + 1}M`,
	`\x1b[<${button};${col + 1};${row + 1}m`,
];
const wheel = (row: number, col: number, down: boolean) => `\x1b[<${down ? 65 : 64};${col + 1};${row + 1}M`;

appSuite({
	dir: "apps/git",
	mount(_caseName, corpusCase) {
		const inputs = corpusCase.inputs as AppInputs;
		const host: GitTuiHost = {
			model: fakeModel(inputs),
			createAvatarSource: () => ({ get: () => null }),
			aiStage: async () => inputs.aiStage,
			generateCommitMessage: async () => inputs.generateCommitMessage,
		};
		const app = new GitAppModel(host, { columns: () => 80 });
		void app.run();
		const keys =
			(...data: string[]) =>
			async (d: AppDriver) => {
				for (const bytes of data) {
					const mouse = decodeMouse(bytes);
					if (mouse) app.handleMouse(mouse);
					else d.press(bytes);
					await settle();
				}
			};
		const native = (event: Parameters<AppDriver["emit"]>[0]) => async (d: AppDriver) => {
			d.emit(event);
			await settle();
		};
		// The capture addressed actions to arbitrary keys; the app's root takes them.
		const action = (act: string) => native({ type: "action", key: "", act, mods: [] });
		const VIEWS = "main/bar/1/views";
		return {
			view: () => GitApp({ app, media: () => true }),
			height: 30,
			fresh: true,
			ready: async () => {
				for (let i = 0; i < 10; i++) await Promise.resolve();
			},
			dispose: () => {
				app.quit();
				app.dispose();
			},
			steps: {
				loaded: () => settle(12),
				"tab focuses diff": keys("\t"),
				"cursor j j down k": keys("j", "j", "\x1b[B", "k"),
				"shift+down twice selects lines": keys("\x1b[1;2B", "\x1b[1;2B"),
				"escape clears selection": keys("\x1b"),
				"view v (cycle)": keys("v"),
				"view 2 (inline)": keys("2"),
				"view 3 (hunk)": keys("3"),
				"view 4 (file)": keys("4"),
				"view 1 (split)": keys("1"),
				"wrap w": keys("w"),
				"whitespace b": keys("b"),
				"whitespace b again": keys("b"),
				"alt+down next hunk twice, alt+up": keys("\x1b[1;3B", "\x1b[1;3B", "\x1b[1;3A"),
				"scroll l h G": keys("l", "h", "G"),
				"scroll g pgdn pgup": keys("g", "\x1b[6~", "\x1b[5~"),
				"next file ]": keys("]"),
				"next file ] again": keys("]"),
				"previous file [": keys("["),
				"s stages file": keys("s"),
				"delete asks to discard": keys("\x1b[3~"),
				"hunk view, space stages hunk": keys("3", " "),
				"x discard hunk asks, x confirms": keys("x", "x"),
				"tab to sidebar and move": keys("\t", "\x1b[B", "\x1b[B", "\x1b[D", "\x1b[C"),
				"t path style": keys("t"),
				"t tree style": keys("t"),
				"enter opens file": keys("\r"),
				"native commit with empty summary generates a message": action("commit"),
				"commit form typing": keys("\t", "c", "f", "i", "x"),
				"escape leaves form": keys("\x1b"),
				"click header row": keys(...click(0, 1)),
				"click toolbar every 3 columns": async d => {
					for (let col = 0; col < 120; col += 3) await keys(...click(1, col))(d);
				},
				"click sidebar row 5": keys(...click(5, 100)),
				"click diff row 8": keys(...click(8, 20)),
				"shift click diff row 12": keys(...click(12, 20, 4)),
				"click minimap": keys(...click(10, 80)),
				"wheel diff, sidebar, header": keys(
					wheel(10, 20, true),
					wheel(10, 20, true),
					wheel(10, 100, true),
					wheel(0, 10, true),
				),
				"native select view inline": native({ type: "select", key: VIEWS, item: "inline" }),
				"native next/prev hunk, whitespace, wrap, stage file": async d => {
					for (const act of ["next-hunk", "prev-hunk", "whitespace", "wrap", "stage-file", "noop"])
						await action(act)(d);
				},
				"native activate view hunk": native({ type: "activate", key: VIEWS, item: "hunk" }),
				"ai stage prompt": async d => {
					await keys("\t")(d);
					await action("stage-ai")(d);
					await keys(..."tests only", "\r")(d);
				},
				"native commit commits the summary": action("commit"),
				"down down enter": keys("\x1b[B", "\x1b[B", "\r"),
				"diff keys on commit file (stage/discard inert)": keys("\t", "j", "s", "x", "\x1b[3~", "4", "\x1b[1;3B"),
				"click sidebar row 4": keys(...click(4, 100)),
				"keys tab j v w b ] c": keys("\t", "j", "v", "w", "b", "]", "c"),
				"next file, tab, view 1": keys("]", "\t", "1"),
				"next file": keys("]"),
			},
		};
	},
});
