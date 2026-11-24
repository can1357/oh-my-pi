import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ReviewDiffFile } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/annotation-types";
import type { ExtensionRows } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SpotlightDetails, SpotlightOriginal } from "@oh-my-pi/pi-coding-agent/tools/details/spotlight";
import { nativeRendering, signal } from "@oh-my-pi/pi-tui";
import { loadCase } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDashboardController } from "../../src/autoresearch/dashboard";
import type { AutoresearchDashboardRuntime } from "../../src/ui/apps/autoresearch";
import { presentFullscreen } from "../../src/ui/apps/fullscreen";
import { GitHelp, gitHelpSheet } from "../../src/ui/apps/git";
import { AnnotationReview, annotationReviewSheet } from "../../src/ui/overlays/panels/annotation-review";
import { AnnotationReviewModel } from "../../src/ui/overlays/panels/annotation-review-model";
import { CodexResetFireworks, FIREWORKS_SHEET } from "../../src/ui/overlays/panels/codex-reset-fireworks";
import { PAUSE_SHEET, PauseScreen } from "../../src/ui/overlays/panels/pause-screen";
import { PLAN_SAVE_SHEET, PlanSave } from "../../src/ui/overlays/panels/plan-save";
import { CONSOLE_SHEET, PtyConsole, PtyConsoleModel } from "../../src/ui/overlays/panels/pty-console";
import { SpotlightSheet, spotlightOverlay } from "../../src/ui/overlays/panels/spotlight-sheet";
import { sheetView, showSheet } from "../../src/ui/overlays/sheet";
import { initTheme } from "../../src/ui/theme/service";
import { createModeTerminal } from "../helpers/mode-terminal";
import { nativeShell } from "../helpers/native-shell";

const ESCAPE = "\x1b[27u";
const ENTER = "\r";

type NativeUi = Awaited<ReturnType<typeof nativeShell>>;

/** The sheet Tern holds in `layer`, and the screen inside it. */
function sheetOf(ui: NativeUi) {
	const overlay = ui.node("overlay");
	expect(overlay.parent).toBe("layer");
	const [screen, ...rest] = ui.children(overlay);
	expect(rest).toEqual([]);
	return { props: overlay.p, screen: screen! };
}

describe("sheets Tern draws", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-native-sheets-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/** Open a sheet over a draft; the returned check passes once it closed, the composer has the keys and the draft. */
	async function overDraft(ui: NativeUi, open: () => void | Promise<void>): Promise<() => void> {
		mode.composer.setText("unsent draft");
		const home = mode.shell.focused();
		await open();
		expect(mode.shell.overlays.open()).toBe(true);
		return () => {
			expect(mode.shell.overlays.open()).toBe(false);
			expect(mode.shell.focused()).toBe(home);
			expect(mode.composer.text()).toBe("unsent draft");
			expect(() => ui.node("overlay")).toThrow();
		};
	}

	it("mounts /session as the Session info sheet and closes it on Escape", async () => {
		await using ui = await nativeShell(mode.shell);
		const theme = currentTheme();
		const report = [
			`${theme.fg("dim", "File:")} /tmp/s.jsonl`,
			`${theme.fg("dim", "ID:")} 0193-abcd`,
			"",
			theme.style("strong", "Provider"),
			`${theme.fg("dim", "Name:")} parity`,
			"",
			theme.style("strong", "Messages"),
			`${theme.fg("dim", "User:")} 2`,
			`${theme.fg("dim", "Append-Only:")} on`,
			"",
			theme.style("strong", "MCP Servers"),
			theme.fg("dim", "None connected"),
		].join("\n");
		const closed = await overDraft(ui, () => mode.showSessionInfo(report));

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.sessionInfo",
			size: "md",
			anchor: "center",
			head: "Session info",
			modal: true,
		});
		expect(screen.k).toBe("col");
		expect(screen.p.role).toBeUndefined();
		// The id leads the identity fields; a provider fact printed with the counts joins the provider.
		const [identity] = ui.children(screen);
		expect(ui.children(identity!).map(field => field.id.split("/").at(-1))).toEqual(["id", "file"]);
		expect(ui.node("kv").p).toMatchObject({
			role: "omp.info.kv",
			items: [
				{ k: "Name", v: [{ s: "mono", t: "parity" }] },
				{ k: "Append-only", v: [{ s: "mono", t: "on" }] },
			],
		});
		// A line that is no `Key: value` pair is a note of its group.
		const servers = ui.children(screen).at(-2)!;
		expect(servers.p.head).toBe("MCP servers");
		expect(ui.children(servers).map(note => [note.k, note.p.role, note.p.spans])).toEqual([
			["text", "omp.info.note", [{ s: "dim", t: "None connected" }]],
		]);

		ui.type(ESCAPE);
		closed();
	});

	it("mounts the jobs sheet as Background jobs and closes it from its Close control", async () => {
		await using ui = await nativeShell(mode.shell);
		vi.spyOn(session, "getAsyncJobTree").mockReturnValue({ running: [], recent: [], agents: [] });
		const closed = await overDraft(ui, () => mode.showJobsSheet());

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.jobs",
			size: "lg",
			anchor: "center",
			head: "Background jobs",
			modal: true,
		});
		expect(screen.p.role).toBeUndefined();

		const close = ui.children(ui.children(screen).at(-1)!).at(-1)!;
		ui.send({ ev: "action", sf: ui.sf, id: close.id, act: "close" });
		closed();
	});

	it("titles the plan review sheet by the plan's heading and cancels it on Escape", async () => {
		await using ui = await nativeShell(mode.shell);
		const planPath = resolveLocalUrlToPath("local://ship-plan.md", {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# Ship the sheets\n\n## Steps\n\nWrap them.\n");
		mode.planModeEnabled = true;
		const closed = await overDraft(ui, async () => {
			expect(await mode.openPlanReview()).toBe(true);
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.planReview",
			size: "lg",
			anchor: "center",
			head: "Ship the sheets",
			modal: true,
		});
		expect(screen.p.role).toBeUndefined();
		expect(ui.node("doc").p.text).toContain("## Steps");

		ui.type(ESCAPE);
		for (let turn = 0; turn < 50 && mode.shell.overlays.open(); turn++) await Bun.sleep(1);
		closed();
	});

	it("falls back to the default title for a plan without a title heading and picks with Enter", async () => {
		await using ui = await nativeShell(mode.shell);
		const choice = mode.showPlanReview("## One\n\nA.\n\n## Two\n\nB.\n", "Plan review", [
			{ id: "apply", label: "Approve" },
		]);
		expect(sheetOf(ui).props.head).toBe("Plan review");
		ui.type(ENTER);
		expect(await choice).toBe("apply");
	});

	it("asks for the plan path in a small bottom sheet whose field takes the keys", async () => {
		await using ui = await nativeShell(mode.shell);
		const results: ({ path: string } | undefined)[] = [];
		const closed = await overDraft(ui, () => {
			const handle = showSheet(mode.shell, PLAN_SAVE_SHEET, () =>
				PlanSave({
					suggestedPath: signal("plans/suggested.md"),
					onDone: result => {
						results.push(result);
						handle.close();
					},
				}),
			);
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.planSave",
			size: "sm",
			anchor: "bottom",
			head: "Save plan",
			modal: true,
		});
		expect(screen.p.role).toBeUndefined();
		expect(ui.node("button", "cancel").p.title).toBe("Cancel  esc");

		const field = ui.node("input");
		ui.send({ ev: "edit", sf: ui.sf, id: field.id, from: 0, to: 0, len: 0, text: "notes/plan.md", cursor: 13 });
		expect(ui.node("input").p.text).toBe("notes/plan.md");
		ui.type(ENTER);
		expect(results).toEqual([{ path: "notes/plan.md" }]);
		closed();
	});

	it("mounts the spotlight sheet under its head line", async () => {
		await using ui = await nativeShell(mode.shell);
		const spotlight: SpotlightDetails & { original: SpotlightOriginal } = {
			tool: "bash",
			steps: ["window"],
			inChars: 48_800,
			outChars: 2_400,
			inTokens: 52_000,
			outTokens: 12_000,
			savedTokens: 40_000,
			original: {
				url: "local://7.log",
				lines: 3,
				start: 1,
				heat: "1-29",
				kept: [[1, 1]],
			},
		};
		const closed = await overDraft(ui, () => {
			const handle = showSheet(mode.shell, spotlightOverlay(spotlight), () =>
				SpotlightSheet({
					spotlight,
					original: "INFO boot\nINFO step\nERROR refused",
					reduced: "INFO boot\n… [2-3]",
					onClose: () => handle.close(),
				}),
			);
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toMatchObject({ role: "omp.overlay.spotlight", size: "lg", anchor: "center", modal: true });
		expect(props.head).toStartWith("⭐ Spotlight · bash · ");
		expect(screen.p.role).toBeUndefined();

		ui.type(ESCAPE);
		closed();
	});

	it("drops the fireworks sheet from the top edge without a title", async () => {
		await using ui = await nativeShell(mode.shell);
		const closed = await overDraft(ui, () => {
			const handle = showSheet(mode.shell, FIREWORKS_SHEET, () =>
				CodexResetFireworks({
					event: { kind: "unscheduled-weekly-reset" },
					startedAt: 0,
					onClose: () => handle.close(),
				}),
			);
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({ role: "omp.overlay.fireworks", anchor: "top", size: "md", modal: true });
		expect(screen.p.role).toBeUndefined();
		expect(ui.node("shimmer").p.text).toBe("OpenAI reset");

		ui.type(ESCAPE);
		closed();
	});

	it("pauses in a sheet over the session, not on a page, and resumes on Enter", async () => {
		await using ui = await nativeShell(mode.shell);
		const resumed = Promise.withResolvers<void>();
		let done: Promise<void> | undefined;
		const closed = await overDraft(ui, () => {
			done = presentFullscreen(mode.shell, () => ({
				view: () =>
					PauseScreen({
						since: () => 0,
						work: () => ({ unsettledTurns: 0, unfinishedJobs: 0 }),
						onResume: () => resumed.resolve(),
					}),
				sheet: PAUSE_SHEET,
				done: resumed.promise,
			}));
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.pause",
			size: "md",
			anchor: "center",
			head: "Paused",
			modal: true,
		});
		expect(screen.p.role).toBeUndefined();

		ui.type(ENTER);
		await done;
		closed();
	});

	it("gives an extension overlay a modal bottom sheet and its view the keys", async () => {
		await using ui = await nativeShell(mode.shell);
		const keys: string[] = [];
		let finish: (() => void) | undefined;
		let shown: Promise<void> | undefined;
		const closed = await overDraft(ui, async () => {
			shown = mode.showHookCustom<void>(
				(_ui, _theme, _keybindings, done): ExtensionRows => {
					finish = () => done();
					return { render: () => ["Parity overlay"], handleInput: data => void keys.push(data) };
				},
				{ overlay: true },
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({ anchor: "bottom", size: "lg", modal: true });
		expect(screen.k).toBe("rows");
		ui.type("q");
		expect(keys).toEqual(["q"]);

		finish?.();
		await shown;
		closed();
	});

	it("opens a fullscreen extension overlay as a page of its own", async () => {
		await using ui = await nativeShell(mode.shell);
		let finish: (() => void) | undefined;
		const shown = mode.showHookCustom<void>(
			(_ui, _theme, _keybindings, done): ExtensionRows => {
				finish = () => done();
				return { render: () => ["Parity page"] };
			},
			{ overlay: true, fullscreen: true },
		);
		await Promise.resolve();
		await Promise.resolve();

		// The view is the page's `main`; no sheet wraps it.
		expect(ui.node("rows").parent).toBe("main");
		expect(() => ui.node("overlay")).toThrow();

		finish?.();
		await shown;
		expect(mode.shell.overlays.open()).toBe(false);
	});

	it("mounts the interactive console as the full Console sheet and forwards keys to the program", async () => {
		await using ui = await nativeShell(mode.shell);
		const input: string[] = [];
		const kill = vi.fn();
		let finish: (() => void) | undefined;
		let shown: Promise<void> | undefined;
		const closed = await overDraft(ui, async () => {
			shown = mode.showHookCustom<void>(
				(host, _theme, _keybindings, done) => {
					finish = () => done();
					const size = host.size();
					const model = new PtyConsoleModel("printf ready", PtyConsoleModel.gridFor(size.columns, size.rows), {
						onInput: data => void input.push(data),
						onKill: kill,
						onResize: () => {},
					});
					return sheetView(nativeRendering(), CONSOLE_SHEET, PtyConsole({ model }));
				},
				{ overlay: true },
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.console",
			anchor: "bottom",
			size: "full",
			head: "Console",
			modal: true,
		});
		expect(screen.p.role).toBeUndefined();
		// The screen is fixed to the PTY grid, which leaves the sheet's padding free.
		expect(ui.node("ansi").p.cols).toBe(mode.shell.size().columns - 8);
		expect(ui.node("button", "kill").p).toMatchObject({ title: "Force kill  esc", actions: { click: "kill" } });

		ui.type("y");
		expect(input).toEqual(["y"]);
		ui.click("button", "kill");
		expect(kill).toHaveBeenCalledTimes(1);

		finish?.();
		await shown;
		closed();
	});

	it("titles the autoresearch sheet by the experiment and closes it on q", async () => {
		await using ui = await nativeShell(mode.shell);
		const recorded = await loadCase("apps/autoresearch-dashboard/overlay-running-with-last-summary.dark");
		const runtime = (recorded.inputs as { runtime: AutoresearchDashboardRuntime }).runtime;
		let shown: Promise<void> | undefined;
		const closed = await overDraft(ui, async () => {
			shown = createDashboardController().showOverlay(
				{
					hasUI: true,
					ui: { setWidget: () => {}, custom: (factory, options) => mode.showHookCustom(factory, options) },
				},
				runtime,
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.autoresearch",
			anchor: "bottom",
			size: "lg",
			head: [{ t: "Speed up the parser" }, { s: "muted", t: " · Autoresearch" }],
			modal: true,
		});
		expect(screen.p.role).toBe("omp.app.autoresearch");

		ui.type("q");
		await shown;
		closed();
	});

	it("titles the annotation sheet by what is under review", async () => {
		await using ui = await nativeShell(mode.shell);
		const file: ReviewDiffFile = {
			path: "src/value.ts",
			oldPath: "src/value.ts",
			newPath: "src/value.ts",
			occurrence: 1,
			rawDiff: "diff --git a/src/value.ts b/src/value.ts\n@@ -1 +1 @@\n-a\n+b",
			rows: [
				{ kind: "hunk", raw: "@@ -1 +1 @@", hunkHeader: "@@ -1 +1 @@" },
				{ kind: "removed", raw: "-a", content: "a", oldLine: 1, hunkHeader: "@@ -1 +1 @@" },
				{ kind: "added", raw: "+b", content: "b", newLine: 1, hunkHeader: "@@ -1 +1 @@" },
			],
			linesAdded: 1,
			linesRemoved: 1,
			isBinary: false,
		};
		const results: unknown[] = [];
		let shown: Promise<void> | undefined;
		const closed = await overDraft(ui, async () => {
			shown = mode.showHookCustom<void>(
				(host, _theme, _keybindings, done) => {
					const review = new AnnotationReviewModel(
						{ kind: "diff", files: [file], mode: "Uncommitted changes against `main`" },
						{
							onComplete: result => {
								results.push(result);
								done();
							},
						},
						{ theme: currentTheme, size: () => host.size() },
					);
					return sheetView(nativeRendering(), annotationReviewSheet(review), AnnotationReview({ model: review }));
				},
				{ overlay: true, fullscreen: true },
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		const { props, screen } = sheetOf(ui);
		expect(props).toEqual({
			role: "omp.overlay.codeReview",
			anchor: "center",
			size: "full",
			head: [{ t: "Code review" }, { s: "muted", t: "Uncommitted changes against " }, { s: "code", t: "main" }],
			modal: true,
		});
		expect(screen.p.role).toBeUndefined();

		ui.type(ESCAPE);
		await shown;
		expect(results).toEqual([undefined]);
		closed();
	});

	it("names the git shortcuts sheet and closes it on q", async () => {
		await using ui = await nativeShell(mode.shell);
		const closed = await overDraft(ui, () => {
			const handle = mode.shell.overlays.show(
				() =>
					sheetView(
						true,
						gitHelpSheet(mode.shell.native(), () => mode.shell.size().columns),
						GitHelp({ onClose: () => handle.close() }),
					),
				{ focus: root => root.children()[0] ?? root },
			);
		});

		const { props, screen } = sheetOf(ui);
		// A large sheet whose shortcut tables are taller than this narrow pane fills it.
		expect(props).toEqual({
			role: "omp.overlay.hotkeys",
			head: "Keyboard shortcuts",
			anchor: "center",
			size: "full",
			modal: true,
		});
		expect(screen.p.role).toBe("omp.app.git.help");

		ui.type("q");
		closed();
	});
});
