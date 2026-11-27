import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { jsx, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { getProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { type Keybinding, KEYBINDINGS } from "../src/config/keybindings/app-keybindings";
import { KeybindingsManager } from "../src/config/keybindings/keybindings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { routeTranscriptKeys } from "../src/modes/interactive/fullscreen";
import * as startupCache from "../src/modes/interactive/startup-cache";
import { StartupCache, type StartupPreferences } from "../src/modes/interactive/startup-cache";
import { transcriptMarks } from "../src/modes/interactive/transcript-marks";
import { PRESENTATION_ENV, parsePresentationEnv } from "../src/modes/presentation-env";
import { cfgTuiMode } from "../src/modes/settings";
import {
	applyStartupComposerPreferences,
	beginStartupComposer,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "../src/modes/startup-composer";
import { UiHelpers } from "../src/modes/utils/ui-helpers";
import { registerComposerShape } from "../src/ui/composer";
import { hotkeyGroups } from "../src/ui/keys/hotkeys";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { createModeTerminal, type ModeTerminal, pressKey } from "./helpers/mode-terminal";
import { nativeShell } from "./helpers/native-shell";
import { createTestSession, type TestSessionContext } from "./utilities";

const BASE: StartupPreferences = {
	quiet: true,
	composerShape: "box",
	resizeScrollback: "rebuild",
	autocompleteMaxVisible: 5,
	vim: false,
	imeSafeCursor: false,
	mode: "inline",
};

/** Set `PI_TUI_MODE` (undefined: unset); returns the restore. */
function presentationEnv(value: string | undefined): () => void {
	const saved = Bun.env[PRESENTATION_ENV];
	if (value === undefined) delete Bun.env[PRESENTATION_ENV];
	else Bun.env[PRESENTATION_ENV] = value;
	return () => {
		if (saved === undefined) delete Bun.env[PRESENTATION_ENV];
		else Bun.env[PRESENTATION_ENV] = saved;
	};
}

let term: ModeTerminal | undefined;
let restoreEnv: () => void = () => {};
let dir: TempDir | undefined;
let cache: StartupCache | undefined;

afterEach(() => {
	stopPendingStartupComposer();
	vi.restoreAllMocks();
	restoreEnv();
	restoreEnv = () => {};
	term?.dispose();
	term = undefined;
	cache?.close();
	cache = undefined;
	dir?.removeSync();
	dir = undefined;
});

/** Start a frame from its last prediction without resolving this launch's settings. */
async function prepaint(preferences: Partial<StartupPreferences>, tuiMode?: StartupPreferences["mode"]) {
	term = createModeTerminal({ columns: 80, rows: 24 });
	beginStartupComposer({
		driver: term.memory.options,
		version: "test",
		cache: false,
		exit: () => {},
		tuiMode,
		preferences: { ...BASE, ...preferences },
	});
	const lease = takeStartupComposerLease();
	if (!lease) throw new Error("no startup frame");
	await lease.ready;
	await term.settle();
	return lease;
}

describe("startup prepaint presentation", () => {
	it("parses PI_TUI_MODE in any case, ignoring other text", () => {
		expect(parsePresentationEnv(" FullScreen ")).toBe("fullscreen");
		expect(parsePresentationEnv("INLINE")).toBe("inline");
		expect(parsePresentationEnv("full")).toBeUndefined();
		expect(parsePresentationEnv("")).toBeUndefined();
	});

	it("honors CLI over the environment, and speculates only on the alternate screen", async () => {
		type Mode = StartupPreferences["mode"];
		const cases: [string | undefined, Mode, Mode | undefined, Mode | null][] = [
			["fullscreen", "inline", undefined, "fullscreen"],
			[" Inline ", "fullscreen", undefined, "inline"],
			["full", "fullscreen", undefined, "fullscreen"],
			[undefined, "inline", undefined, null],
			["inline", "inline", "fullscreen", "fullscreen"],
			["fullscreen", "fullscreen", "inline", "inline"],
		];
		for (const [env, cached, cli, expected] of cases) {
			restoreEnv = presentationEnv(env);
			const lease = await prepaint({ mode: cached }, cli);
			expect(lease.frame.presentation.peek()).toBe(expected);
			const output = term!.memory.output.join("");
			expect(output.includes("\x1b[?1049h")).toBe(expected === "fullscreen");
			expect(output.includes("\x1b[3J")).toBe(expected === "inline");
			await lease.frame.shell.stop();
			term?.dispose();
			restoreEnv();
		}
	});

	it.each(["stale inline cache", "missing cache"])("preserves shell history with a %s", async cacheState => {
		restoreEnv = presentationEnv(undefined);
		dir = TempDir.createSync("@omp-prepaint-history-");
		cache = StartupCache.open(path.join(dir.path(), "composer.db"));
		vi.spyOn(startupCache, "sharedStartupCache").mockReturnValue(cache);
		if (cacheState === "stale inline cache") cache.write(dir.path(), BASE, {});
		const terminal = (term = createModeTerminal({ columns: 80, rows: 8 }));
		terminal.engine.write(Array.from({ length: 13 }, (_, i) => `shell line ${i}\r\n`).join(""));
		const original = terminal.text();
		const exit = vi.fn();
		beginStartupComposer({ driver: terminal.memory.options, cwd: dir.path(), version: "test", exit });
		// Positive handshake: the startup handler has received input, so settings did not win
		// the race by accident. Subsequent typing and paste must reach the adopted composer.
		terminal.press("ctrl+d");
		await terminal.waitFor(() => exit.mock.calls.length === 1);
		terminal.type("early ");
		terminal.paste("draft");
		await terminal.settle();
		expect(terminal.text()).toBe(original);
		expect(terminal.memory.output.join("")).not.toContain("\x1b[3J");

		applyStartupComposerPreferences({
			...BASE,
			mode: "fullscreen",
			presentation: "fullscreen",
			pointer: "select",
			copyOnRelease: true,
			theme: {},
		});
		const lease = takeStartupComposerLease()!;
		try {
			await lease.ready;
			await terminal.waitFor(rows => rows.some(row => row.includes("early draft")));
			expect(lease.frame.composer.text()).toBe("early draft");
			expect(terminal.memory.output.join("")).toContain("\x1b[?1049h");
		} finally {
			await lease.frame.shell.stop();
		}
		expect(terminal.memory.output.join("")).not.toContain("\x1b[3J");
		expect(terminal.text()).toBe(original);
	});

	it.each(["inline", "fullscreen"] as const)("uses resolved %s when settings beat the host handshake", async saved => {
		restoreEnv = presentationEnv(undefined);
		const terminal = (term = createModeTerminal({ columns: 80, rows: 24 }));
		beginStartupComposer({
			driver: terminal.memory.options,
			cache: false,
			preferences: { ...BASE, mode: saved === "inline" ? "fullscreen" : "inline" },
		});
		applyStartupComposerPreferences({
			...BASE,
			mode: saved,
			presentation: saved,
			pointer: "select",
			copyOnRelease: true,
			theme: {},
		});
		const lease = takeStartupComposerLease()!;
		try {
			await lease.ready;
			await terminal.settle();
			const output = terminal.memory.output.join("");
			expect(output.includes("\x1b[?1049h")).toBe(saved === "fullscreen");
			expect(output.split("\x1b[3J").length - 1).toBe(saved === "inline" ? 1 : 0);
		} finally {
			await lease.frame.shell.stop();
		}
	});

	it("cancels prepaint while the host is still negotiating, without drawing late or keeping stdin", async () => {
		restoreEnv = presentationEnv(undefined);
		const terminal = (term = createModeTerminal());
		const driver = terminal.memory.options;
		beginStartupComposer({ driver, cache: false, preferences: { ...BASE, mode: "fullscreen" } });
		expect(driver.stdin?.isRaw).toBe(true);
		stopPendingStartupComposer();
		await terminal.waitFor(() => driver.stdin?.isRaw === false);
		expect(terminal.memory.output.join("")).not.toMatch(/\x1b\[\?1049h|\x1b\[3J/);
		expect(terminal.text()).toBe("");
	});

	it("does not flush an unresolved prepaint into shell history when startup exits", async () => {
		restoreEnv = presentationEnv(undefined);
		const lease = await prepaint({ mode: "inline", quiet: false });
		const terminal = term!;
		terminal.type("abandoned draft");
		await terminal.waitFor(() => lease.frame.composer.text() === "abandoned draft");
		await lease.frame.shell.stop();
		expect(terminal.memory.output.join("")).not.toMatch(/abandoned draft|vtest|\x1b\[3J/);
		expect(terminal.text()).toBe("");
	});

	it("caches the saved mode for the next first frame, never the launch override", async () => {
		restoreEnv = presentationEnv("fullscreen");
		dir = TempDir.createSync("@omp-presentation-cache-");
		cache = StartupCache.open(path.join(dir.path(), "composer.db"));
		vi.spyOn(startupCache, "sharedStartupCache").mockReturnValue(cache);
		const cwd = dir.path();
		term = createModeTerminal({ columns: 80, rows: 24 });
		beginStartupComposer({ driver: term.memory.options, version: "test", cwd, exit: () => {}, preferences: BASE });
		// Resolved as main.ts does once Settings load: saved inline, this launch fullscreen.
		const settings = Settings.isolated();
		cfgTuiMode.set(settings, "inline");
		applyStartupComposerPreferences({
			...BASE,
			mode: cfgTuiMode.layered(settings),
			presentation: cfgTuiMode.get(settings),
			pointer: "select",
			copyOnRelease: true,
			theme: {},
		});
		const lease = takeStartupComposerLease();
		if (!lease) throw new Error("no startup frame");
		expect(lease.frame.presentation.peek()).toBe("fullscreen");
		expect(cache.read(cwd).preferences?.mode).toBe("inline");
		await lease.ready;
		await lease.frame.shell.stop();
	});

	it.each(["env", "CLI"])("refreshes the cache on a saved mode edit beneath a %s override", async source => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		dir = TempDir.createSync("@omp-presentation-live-");
		cache = StartupCache.open(path.join(dir.path(), "composer.db"));
		vi.spyOn(startupCache, "sharedStartupCache").mockReturnValue(cache);
		const project = getProjectDir();
		cache.write(project, BASE, {});
		restoreEnv = presentationEnv(source === "env" ? "inline" : "fullscreen");
		const testSession = await createTestSession({ inMemory: true });
		if (source === "CLI") cfgTuiMode.override(testSession.session.settings, "inline");
		term = createModeTerminal();
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			term.frame,
		);
		try {
			cfgTuiMode.set(testSession.session.settings, "fullscreen");
			expect(cache.read(project).preferences?.mode).toBe("fullscreen");
			// The launch override keeps this session inline.
			expect(term.frame.presentation.peek()).toBe("inline");
			cfgTuiMode.set(testSession.session.settings, "inline");
			expect(cache.read(project).preferences?.mode).toBe("inline");
		} finally {
			mode.stop();
			await testSession.cleanup();
			resetSettingsForTest();
		}
	});
});

const TRANSCRIPT_ACTIONS: readonly Keybinding[] = [
	"app.transcript.pageUp",
	"app.transcript.pageDown",
	"app.transcript.top",
	"app.transcript.bottom",
	"app.transcript.lineUp",
	"app.transcript.lineDown",
	"app.transcript.previousUser",
	"app.transcript.nextUser",
	"app.transcript.copyHighlight",
	"app.transcript.find",
];

describe("transcript key defaults", () => {
	it("keep their chords next to other actions' defaults (Alt+K also pins in the resume picker)", () => {
		const keys = KeybindingsManager.inMemory();
		expect(keys.matchesId("pageUp", "app.transcript.pageUp")).toBe(true);
		expect(keys.keysFor("app.transcript.lineUp")).toEqual(["alt+k"]);
		expect(keys.keysFor("app.session.pin")).toEqual(["alt+k"]);
		expect(keys.matchesId("alt+pageUp", "app.transcript.previousUser")).toBe(true);
		expect(keys.keysFor("app.transcript.find")).toEqual(["alt+/"]);
		expect(keys.conflicts()).toEqual([]);
	});

	it("list the effective search key in the fullscreen hotkeys", () => {
		const keys = KeybindingsManager.inMemory({ "app.transcript.find": "f7" });
		const group = hotkeyGroups(keys).find(group => group.title === "Fullscreen transcript");
		expect(group?.rows.find(row => row.action === "Find in transcript")?.keys).toEqual([{ keys: ["f7"] }]);
	});

	it("give every default chord to a user binding of the same chord", () => {
		for (const action of TRANSCRIPT_ACTIONS) {
			const chord = KEYBINDINGS[action].defaultKeys;
			if (typeof chord !== "string") throw new Error(`${action} has one default chord`);
			const keys = KeybindingsManager.inMemory({ "app.model.select": chord });
			expect({ action, keys: keys.keysFor(action) }).toEqual({ action, keys: [] });
			expect(keys.keysFor("app.model.select").map(String)).toEqual([chord.toLowerCase()]);
		}
	});

	it("yield to a claim spelled in another case or modifier order, and come back when it goes", () => {
		// Config chords are case-insensitive: the user's spelling still takes the chord.
		const keys = KeybindingsManager.inMemory(
			JSON.parse('{"tui.editor.cursorUp":"Alt+K","app.model.select":"PageUp"}'),
		);
		expect(keys.matchesId("alt+k", "app.transcript.lineUp")).toBe(false);
		expect(keys.matchesId("alt+k", "tui.editor.cursorUp")).toBe(true);
		expect(keys.matchesId("pageUp", "app.transcript.pageUp")).toBe(false);
		keys.setUserBindings({});
		expect(keys.matchesId("alt+k", "app.transcript.lineUp")).toBe(true);
	});

	it("keep an explicit transcript binding and ignore unknown claimants", () => {
		expect(
			KeybindingsManager.inMemory({ "tui.editor.cursorUp": "alt+k", "app.transcript.lineUp": "alt+k" }).keysFor(
				"app.transcript.lineUp",
			),
		).toEqual(["alt+k"]);
		const unknown = JSON.parse('{"unknown.action":"alt+k"}');
		expect(KeybindingsManager.inMemory(unknown).keysFor("app.transcript.lineUp")).toEqual(["alt+k"]);
	});
});

describe("transcript marks", () => {
	it("colors each prompt by its turn: success, warning, error, failure, and running last", () => {
		const ctx = createInteractiveModeContext();
		const running = signal(false);
		const marks = transcriptMarks({
			nodes: ctx.shell.transcript.nodes,
			blockOf: node => ctx.shell.transcript.blockOf(node),
			entry: block => ctx.transcriptEntry(block),
			running,
		});
		const prompt = (text: string) => {
			const block = ctx.presentMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
			if (!block) throw new Error("a prompt draws a block");
			return block;
		};
		const failed = (stopReason: "error" | "aborted"): AssistantMessage => ({
			...createAssistantMessage(""),
			stopReason,
			errorMessage: "boom",
		});

		const ok = prompt("one");
		ctx.presentAssistant(createAssistantMessage("fine"));
		const toolFailure = prompt("two");
		const tool = ctx.presentToolCall({
			name: "bash",
			args: { command: "false" },
			tool: undefined,
			id: "call-1",
			cwd: "/",
		});
		tool.updateResult({ content: [{ type: "text", text: "exit 1" }], isError: true }, false, "call-1");
		const errored = prompt("three");
		ctx.presentAssistant(failed("error"));
		const aborted = prompt("four");
		ctx.presentAssistant(failed("aborted"));
		const retried = prompt("five");
		const attempt = ctx.presentAssistant(failed("error"));
		ctx.presentAssistant(createAssistantMessage("recovered"));

		expect(marks().map(mark => mark.node)).toEqual([ok, toolFailure, errored, aborted, retried].map(b => b.node));
		expect(marks().map(mark => mark.kind)).toEqual(["success", "warning", "error", "error", "error"]);

		// A recovered auto-retry attempt is not the turn's outcome.
		const recovery = { kind: "auto-retry", status: "recovered", attempt: 1, note: "retried" };
		attempt.message.set({
			...failed("error"),
			retryRecovery: recovery as unknown as NonNullable<AssistantMessage["retryRecovery"]>,
		});
		expect(marks().at(-1)?.kind).toBe("success");

		// Retry exhaustion fails the turn; an ordinary error notice does not.
		prompt("six");
		const helpers = new UiHelpers(ctx);
		helpers.showError("Something else went wrong");
		expect(marks().at(-1)?.kind).toBe("success");
		helpers.showError("Retry failed after 3 attempts: boom", { failsTurn: true });
		expect(marks().at(-1)?.kind).toBe("error");

		prompt("seven");
		running.set(true);
		expect(marks().map(mark => mark.kind)).toEqual([
			"success",
			"warning",
			"error",
			"error",
			"success",
			"error",
			"running",
		]);
	});
});

describe("fullscreen shell mouse", () => {
	it("maps presentation and level to tracking, turning alternate scroll off only for native", async () => {
		term = createModeTerminal();
		await term.start();
		const { frame } = term;
		let seen = term.memory.output.join("").length;
		const since = async (): Promise<string> => {
			await term!.settle();
			const all = term!.memory.output.join("");
			const fresh = all.slice(seen);
			seen = all.length;
			return fresh;
		};
		try {
			// Inline with `tui.mouse` off: no reporting.
			expect(await since()).not.toContain("\x1b[?1002h");
			frame.presentation.set("fullscreen");
			expect(await since()).toContain("\x1b[?1002h");
			frame.shell.setInlineMouse("any");
			expect(await since()).toContain("\x1b[?1003h");
			frame.shell.setInlineMouse("off");
			expect(await since()).toContain("\x1b[?1002h");

			frame.pointer.set("native");
			const released = await since();
			expect(released).toContain("\x1b[?1002l");
			expect(released).toContain("\x1b[?1007l");
			frame.pointer.set("wheel");
			const wheel = await since();
			expect(wheel).toContain("\x1b[?1002h");
			expect(wheel).toContain("\x1b[?1007h");

			// An overlay's own mouse wins over the native level, which then leaves alternate scroll alone.
			frame.pointer.set("native");
			await since();
			const overlay = frame.shell.overlays.show(() => jsx("col", { key: "sheet" }), {
				focus: false,
				mouse: "click",
			});
			const covered = await since();
			expect(covered).toContain("\x1b[?1000h");
			expect(covered).toContain("\x1b[?1007h");
			overlay.close();
			expect(await since()).toContain("\x1b[?1007l");

			// Leaving fullscreen restores alternate scroll; inline tracking stays off.
			frame.presentation.set("inline");
			const inline = await since();
			expect(inline).toContain("\x1b[?1007h");
			expect(inline).not.toContain("\x1b[?1002h");
		} finally {
			await frame.shell.stop();
		}
	});

	it("reapplies the active mouse and alternate-scroll modes after handing the terminal back", async () => {
		term = createModeTerminal();
		await term.start();
		const { frame, memory } = term;
		const host = frame.shell.host!;
		const resumed = async (whileStopped?: () => void): Promise<string> => {
			const from = await host.suspend(async () => {
				whileStopped?.();
				return memory.output.length;
			});
			return memory.output.slice(from).join("");
		};
		try {
			frame.presentation.set("fullscreen");
			for (const level of ["select", "wheel"] as const) {
				frame.pointer.set(level);
				expect(await resumed()).toContain("\x1b[?1002h\x1b[?1006h");
			}
			frame.shell.setInlineMouse("any");
			expect(await resumed()).toContain("\x1b[?1003h\x1b[?1006h");

			frame.pointer.set("native");
			const native = await resumed();
			expect(native).toContain("\x1b[?1007l");
			expect(native).not.toMatch(/\x1b\[\?100[023]h/);

			const overlay = frame.shell.overlays.show(() => jsx("col", { key: "sheet" }), {
				focus: false,
				mouse: "click",
			});
			const covered = await resumed();
			expect(covered).toContain("\x1b[?1000h\x1b[?1006h");
			expect(covered).not.toContain("\x1b[?1007l");
			// Closing the overlay while suspended makes the restored policy the native one, not the old click override.
			const uncovered = await resumed(() => overlay.close());
			expect(uncovered).toContain("\x1b[?1007l");
			expect(uncovered).not.toMatch(/\x1b\[\?100[023]h/);

			frame.shell.setInlineMouse("off");
			frame.presentation.set("inline");
			expect(await resumed()).not.toMatch(/\x1b\[\?100[0237][hl]/);
		} finally {
			await frame.shell.stop();
		}
	});

	it("places the caret on the clicked draft row after paging a fullscreen transcript with click targets off", async () => {
		const terminal = (term = createModeTerminal({ columns: 48, rows: 18 }));
		const { frame } = terminal;
		const { shell, composer } = frame;
		const removeShape = registerComposerShape({
			id: "test-pointer-rows",
			paddingX: 1,
			sideBorders: false,
			sideWidth: () => 1,
			row: ({ text, pad }) => ({ rows: ["", ` ${text}${pad} `], textRow: 1 }),
		});
		try {
			frame.presentation.set("fullscreen");
			frame.pointer.set("wheel");
			frame.setShape("test-pointer-rows");
			composer.setMaxLines(2);
			const draft = "hidden first\nhidden second\nvisible first\nlast target";
			composer.setText(draft);
			shell.transcript.append(() => jsx("rows", { lines: Array.from({ length: 45 }, (_, i) => `history ${i}`) }));
			await terminal.start();
			const host = shell.host!;
			await host.suspend(async () => {});
			const scroller = host.scroller!;
			await terminal.waitFor(() => scroller.state().metricsReady && scroller.state().offset > 0);
			const tail = scroller.state().offset;
			const click = (x: number, y: number) => {
				terminal.mouse({ x, y, button: "left", action: "press" });
				terminal.mouse({ x, y, button: "left", action: "release" });
			};
			// The scrollbar pages, but does not move the draft's caret.
			click(terminal.engine.columns - 1, 0);
			await shell.nextFrame();
			const detached = scroller.state().offset;
			expect(detached).toBeLessThan(tail);
			expect(composer.cursor()).toBe(draft.length);
			const screen = terminal.screen();
			expect(screen.some(line => line.includes("hidden second"))).toBe(false);
			const y = screen.findIndex(line => line.includes("last target"));
			expect(y).toBeGreaterThan(0);
			expect(screen[y - 1]!.trim()).toBe("");
			click(screen[y]!.indexOf("target"), y);
			expect(composer.cursor()).toBe(draft.indexOf("target"));
			expect(scroller.state().offset).toBe(detached);
		} finally {
			await shell.stop();
			removeShape();
		}
	});
});

describe("fullscreen transcript keys", () => {
	it("route reading keys only in fullscreen with the composer focused and no overlay or popup", async () => {
		term = createModeTerminal();
		await term.start();
		const { frame } = term;
		const { shell } = frame;
		const scroller = shell.host?.scroller;
		if (!scroller) throw new Error("the terminal renderer has a scroller");
		let completing = false;
		const openFind = vi.fn();
		const keys = KeybindingsManager.inMemory({ "app.transcript.find": "f7" });
		const remove = routeTranscriptKeys({
			shell,
			presentation: frame.presentation,
			field: () => frame.composer.field,
			completing: () => completing,
			keybindings: () => keys,
			openFind,
		});
		const page = vi.spyOn(scroller, "page");
		const drop = vi.spyOn(scroller, "dropHighlight");
		try {
			pressKey(shell, "pageUp");
			pressKey(shell, "f7");
			expect(page).not.toHaveBeenCalled();

			frame.presentation.set("fullscreen");
			pressKey(shell, "pageUp");
			expect(page.mock.calls).toEqual([[-1]]);

			completing = true;
			pressKey(shell, "pageDown");
			pressKey(shell, "f7");
			completing = false;
			const overlay = shell.overlays.show(() => jsx("col", { key: "sheet" }), { focus: false });
			pressKey(shell, "pageDown");
			pressKey(shell, "f7");
			overlay.close();
			expect(page.mock.calls).toEqual([[-1]]);
			pressKey(shell, "alt+/");
			expect(openFind).not.toHaveBeenCalled();
			pressKey(shell, "f7");
			expect(openFind).toHaveBeenCalledWith(scroller);

			pressKey(shell, "pageDown");
			expect(page.mock.calls).toEqual([[-1], [1]]);

			// Escape drops a selection and still reaches the composer.
			pressKey(shell, "escape");
			expect(drop).toHaveBeenCalledTimes(1);
		} finally {
			remove();
			await frame.shell.stop();
		}
	});
});

describe("fullscreen transcript find", () => {
	let mode: InteractiveMode;
	let terminal: ModeTerminal;
	let testSession: TestSessionContext;

	beforeEach(async () => {
		restoreEnv = presentationEnv("fullscreen");
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.spyOn(startupCache, "sharedStartupCache").mockReturnValue(undefined);
		testSession = await createTestSession({ inMemory: true });
		terminal = createModeTerminal({ columns: 72, rows: 12 });
		term = terminal;
		// No input loop or provider: only the real frame, editor, and transcript key routes.
		mode = new InteractiveMode(testSession.session, "test", undefined, undefined, undefined, undefined, term.frame);
		expect(term.frame.presentation.peek()).toBe("fullscreen");
	});

	afterEach(async () => {
		mode.stop();
		await mode.shell.stop();
		await testSession.cleanup();
		resetSettingsForTest();
	});

	it("finds pasted text live, cycles both ways above the field, and returns to the intact draft", async () => {
		const { shell, composer } = mode;
		const rows = Array.from({ length: 64 }, (_, i) =>
			i === 24 ? "first [tag]" : i === 48 ? "second [tag]" : `transcript row ${i}`,
		);
		shell.transcript.append(() => jsx("text", { text: rows.join("\n") }));
		await terminal.start();
		const scroller = shell.host!.scroller!;
		await terminal.waitFor(() => scroller.state().metricsReady && scroller.state().totalRows >= rows.length);
		composer.setText("keep draft");
		composer.setCursor(2);
		pressKey(shell, "ctrl+f");
		expect(composer.cursor()).toBe(3);
		pressKey(shell, "ctrl+shift+f");
		expect(composer.field.fieldSelection?.range(composer.cursor())).toEqual({ from: 3, to: 4 });
		pressKey(shell, "/");
		expect(composer.text()).toBe("kee/ draft");
		const caret = composer.cursor();
		scroller.toTop();
		scroller.scrollBy(3);
		await terminal.waitFor(
			screen => !scroller.state().following && screen[0]?.trimStart().startsWith("transcript row 3 ") === true,
		);
		terminal.feed("\x1b/");
		await terminal.waitFor(screen => screen.some(row => row.includes("Find in transcript")));
		expect(terminal.screen()[0]!.trimStart()).toStartWith("transcript row 3 ");
		expect(scroller.state().offset).toBe(3);
		expect(shell.focused()?.kind).toBe("input");
		const hints = terminal.screen().join("\n");
		expect(hints).toContain("next");
		expect(hints).toContain("previous");
		expect(hints).toContain("close");

		terminal.paste("[tag]");
		await terminal.waitFor(screen => screen.some(row => row.includes("first [tag]")));
		expect(terminal.screen().find(row => row.includes("Find in transcript"))).toContain("[tag]");
		pressKey(shell, "enter");
		await terminal.waitFor(screen => screen.some(row => row.includes("second [tag]")));
		pressKey(shell, "shift+enter");
		await terminal.waitFor(screen => screen.some(row => row.includes("first [tag]")));
		const foundOffset = scroller.state().offset;
		pressKey(shell, "x");
		await terminal.waitFor(screen => screen.some(row => row.includes("No matches")));
		pressKey(shell, "ctrl+u");
		await terminal.waitFor(screen => !screen.some(row => row.includes("No matches")));
		pressKey(shell, "escape");
		await terminal.waitFor(screen => !screen.some(row => row.includes("Find in transcript")));
		expect(shell.focused()).toBe(composer.field);
		expect(scroller.state().offset).toBe(foundOffset);
		expect(composer.cursor()).toBe(caret);
		expect(composer.text()).toBe("kee/ draft");
		pressKey(shell, "z");
		expect(composer.text()).toBe("kee/z draft");
	});

	it("ignores stale finds, yields to overlays and replacement dialogs, and leaves inline keys alone", async () => {
		await terminal.start();
		const { shell, composer } = mode;
		const scroller = shell.host!.scroller!;
		const slow = Promise.withResolvers<boolean>();
		const find = vi.spyOn(scroller, "findText").mockResolvedValue(true).mockReturnValueOnce(slow.promise);
		const clear = vi.spyOn(scroller, "clearFind");
		pressKey(shell, "alt+/");
		const field = shell.focused();
		expect(field?.kind).toBe("input");
		pressKey(shell, "a");
		await shell.nextFrame();
		pressKey(shell, "b");
		pressKey(shell, "left");
		expect(find.mock.calls).toEqual([
			["a", 1],
			["ab", 1],
		]);
		slow.resolve(false);
		await shell.nextFrame();
		expect(terminal.screen().join("\n")).not.toContain("No matches");

		const overlayKeys: string[] = [];
		const overlay = shell.overlays.show(() =>
			jsx("col", {
				onKey: (key: KeyEvent) => {
					overlayKeys.push(key.id);
					return true;
				},
			}),
		);
		expect(clear).toHaveBeenCalledTimes(1);
		pressKey(shell, "shift+enter");
		expect(overlayKeys).toEqual(["shift+enter"]);
		expect(find).toHaveBeenCalledTimes(2);
		await shell.nextFrame();
		overlay.close();
		shell.focus(null);
		expect(shell.focused()).toBe(field);
		await shell.nextFrame();
		expect(find).toHaveBeenCalledTimes(3);
		expect(find).toHaveBeenLastCalledWith("ab", 1);

		const dialog = mode.showEditorAreaDialog(() => jsx("input", { key: "other", text: "Other prompt" }));
		expect(clear).toHaveBeenCalledTimes(2);
		pressKey(shell, "alt+/");
		expect(shell.focused()).toBe(dialog.node);
		dialog.close();
		expect(shell.focused()).toBe(composer.field);
		pressKey(shell, "alt+/");
		expect(shell.focused()?.kind).toBe("input");
		const cover = shell.overlays.show(() => jsx("col", { key: "cover" }));
		terminal.frame.presentation.set("inline");
		expect(shell.focused()).toBe(cover.node);
		cover.close();
		expect(shell.focused()).toBe(composer.field);
		pressKey(shell, "alt+/");
		expect(shell.focused()).toBe(composer.field);
	});

	it("passes the search key through to the native composer", async () => {
		const { shell, composer } = mode;
		await using ui = await nativeShell(shell);
		shell.setHome(composer.field);
		const received: string[] = [];
		composer.addKeyHandler(key => {
			received.push(key.id);
			return true;
		});
		pressKey(shell, "alt+/");
		expect(received).toEqual(["alt+/"]);
		expect(ui.node("editor").id.startsWith("dock/")).toBe(true);
		expect(shell.focused()).toBe(composer.field);
	});
});
