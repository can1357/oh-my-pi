import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { beginStartupComposer } from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import {
	applyStartupComposerPreferences,
	type ComposerLease,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-frame";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { getProjectDir, isInteractiveHost, setInteractiveHost, setProjectDir } from "@oh-my-pi/pi-utils";
import type { StartupPreferences } from "../src/modes/interactive/startup-cache";
import type { StatusPrediction } from "../src/modes/interactive/status-prediction";
import { initTheme } from "../src/ui/theme/service";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

import {
	cfgAutocompleteMaxVisible,
	cfgComposerShape,
	cfgComposerTokenRate,
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupQuiet,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
	cfgTuiImeSafeCursor,
	cfgTuiResizeScrollback,
	cfgTuiScreen,
	cfgTuiVimMode,
} from "@oh-my-pi/pi-coding-agent/modes/settings";

let savedInteractiveHost: boolean;
beforeEach(() => {
	savedInteractiveHost = isInteractiveHost();
});

// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
afterEach(() => {
	clearOmpExtensionCliRoots();
	setInteractiveHost(savedInteractiveHost);
});

describe("outer startup collaboration gate", () => {
	it.each(["completes", "fails"] as const)("keeps guest mutations gated until outer startup %s", async result => {
		const originalProject = getProjectDir();
		const originalIsTTY = process.stdin.isTTY;
		resetSettingsForTest();
		await initTheme();
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"collab.autoStart": "control",
				"collab.relayUrl": "ws://localhost:8788",
				"collab.webUrl": "https://collab.example",
			},
		});
		setProjectDir(testSession.tempDir);
		const activeSettings = await Settings.init({ inMemory: true, cwd: testSession.tempDir });
		cfgStartupCheckUpdate.override(activeSettings, false);
		cfgStartupChangelogMode.override(activeSettings, "hidden");
		cfgStartupSetupWizard.override(activeSettings, false);
		cfgStartupShowSplash.override(activeSettings, false);
		cfgMarketplaceAutoUpdate.override(activeSettings, "off");
		installInMemoryRelay();
		const publish = registry.publishCollabHost;
		vi.spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
			publish(source, { ...options, dir: testSession.tempDir }),
		);
		vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		const enteredReplay = Promise.withResolvers<InteractiveMode>();
		const releaseReplay = Promise.withResolvers<void>();
		const enteredCleanup = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const startupFailure = new Error("initial replay failed");
		const finished = new Error("finished observing startup");
		const renderInitialMessages = InteractiveMode.prototype.renderInitialMessages;
		vi.spyOn(InteractiveMode.prototype, "renderInitialMessages").mockImplementation(
			async function (this: InteractiveMode, options) {
				await renderInitialMessages.call(this, options);
				enteredReplay.resolve(this);
				await releaseReplay.promise;
				if (result === "fails") throw startupFailure;
			},
		);
		vi.spyOn(InteractiveMode.prototype, "getUserInput").mockRejectedValue(finished);
		type GuestOutcome = "refused" | "prompt" | "abort" | "agent";
		let outcome = Promise.withResolvers<GuestOutcome>();
		vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);
		const prompt = vi.spyOn(testSession.session, "promptCustomMessage").mockImplementation(async () => {
			outcome.resolve("prompt");
			return true;
		});
		const abort = vi.spyOn(testSession.session, "abort").mockImplementation(async () => {
			outcome.resolve("abort");
		});
		const ensureLive = vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async () => {
			outcome.resolve("agent");
			return testSession.session;
		});
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const authStorage = await AuthStorage.create(path.join(testSession.tempDir, "startup-auth.db"));
		beginStartupComposer({
			driver: memoryTerminal({ columns: 80, rows: 24 }).options,
			version: "test",
			cache: false,
		});
		const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
		const running = runRootCommand(parseArgs(rawArgs), rawArgs, {
			settings: activeSettings,
			discoverAuthStorage: async () => authStorage,
			createAgentSession: async options => {
				if (!options?.preloadedExtensions || !options.eventBus) throw new Error("Missing startup context");
				await options.sessionManager?.close();
				return {
					session: testSession.session,
					setToolUIContext: () => {},
					extensionsResult: options.preloadedExtensions,
					eventBus: options.eventBus,
				};
			},
		}).then(
			() => undefined,
			error => error,
		);
		let mode: InteractiveMode | undefined;
		let writer: CollabSocket | undefined;
		try {
			mode = await Promise.race([
				enteredReplay.promise,
				running.then(error => {
					throw error ?? new Error("startup exited before replay");
				}),
			]);
			await mode.collabController.idle();
			const host = mode.collabHost;
			if (!host) throw new Error("early startup room missing");
			expect(await registry.listCollabHosts({ dir: testSession.tempDir })).toMatchObject([{ access: "control" }]);
			const link = parseCollabLink(host.link);
			if ("error" in link) throw new Error(link.error);
			const welcomed = Promise.withResolvers<boolean>();
			const asked = Promise.withResolvers<number>();
			writer = new CollabSocket({ wsUrl: link.wsUrl, role: "guest", key: await importRoomKey(link.key) });
			writer.onFrame = frame => {
				if (frame.t === "welcome") welcomed.resolve(frame.readOnly === true);
				if (frame.t === "error") outcome.resolve("refused");
				if (frame.t === "ui-request") asked.resolve(frame.request.reqId);
			};
			const guest = writer;
			guest.onOpen = () =>
				guest.send({
					t: "hello",
					proto: COLLAB_PROTO,
					name: "writer",
					writeToken: link.writeToken ? Buffer.from(link.writeToken).toString("base64url") : undefined,
				});
			guest.connect();
			expect(await welcomed.promise).toBe(false);
			const mutations: CollabFrame[] = [
				{ t: "prompt", text: "during replay" },
				{ t: "abort" },
				{ t: "agent-cmd", cmd: "chat", agentId: "startup-agent", text: "during replay" },
			];
			for (const frame of mutations) {
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send(frame);
				expect(await outcome.promise).toBe("refused");
			}
			expect(prompt).not.toHaveBeenCalled();
			expect(abort).not.toHaveBeenCalled();
			expect(ensureLive).not.toHaveBeenCalled();
			const answer = host.requestGuestUi({ kind: "select", title: "Startup question", options: ["Yes", "No"] });
			if (!answer) throw new Error("startup dialog unavailable");
			guest.send({ t: "ui-response", reqId: await asked.promise, value: "Yes" });
			expect(await answer).toEqual({ kind: "answered", value: "Yes" });

			if (result === "fails") {
				const shutdown = mode.collabController.shutdown.bind(mode.collabController);
				vi.spyOn(mode.collabController, "shutdown").mockImplementation(async reason => {
					enteredCleanup.resolve();
					await releaseCleanup.promise;
					await shutdown(reason);
				});
			}
			releaseReplay.resolve();
			if (result === "fails") {
				await enteredCleanup.promise;
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send({ t: "prompt", text: "during failure cleanup" });
				expect(await outcome.promise).toBe("refused");
				expect(prompt).not.toHaveBeenCalled();
				releaseCleanup.resolve();
				expect(await running).toBe(startupFailure);
				expect(await registry.listCollabHosts({ dir: testSession.tempDir })).toEqual([]);
			} else {
				expect(await running).toBe(finished);
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send({ t: "prompt", text: "after startup" });
				expect(await outcome.promise).toBe("prompt");
				expect(prompt).toHaveBeenCalledWith(
					expect.objectContaining({ content: "after startup", attribution: "user" }),
					expect.objectContaining({ streamingBehavior: "steer" }),
				);
			}
		} finally {
			releaseReplay.resolve();
			releaseCleanup.resolve();
			await running;
			writer?.close();
			await mode?.collabController.shutdown("test cleanup");
			mode?.stop();
			stopPendingStartupComposer();
			vi.restoreAllMocks();
			uninstallInMemoryRelay();
			authStorage.close();
			// setProjectDir chdir'd into tempDir; Windows cannot delete the process cwd.
			setProjectDir(originalProject);
			await testSession.cleanup();
			resetSettingsForTest();
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});
});

describe("startup prepaint frame", () => {
	let settings: Settings;
	let config: StartupPreferences;
	let term: ModeTerminal;
	let exit: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		resetSettingsForTest();
		initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: cfgStartupQuiet.get(settings),
			composerShape: cfgComposerShape.get(settings),
			resizeScrollback: cfgTuiResizeScrollback.get(settings),
			autocompleteMaxVisible: cfgAutocompleteMaxVisible.get(settings),
			vim: cfgTuiVimMode.get(settings),
			imeSafeCursor: cfgTuiImeSafeCursor.get(settings),
			screen: cfgTuiScreen.get(settings),
		};
	});

	afterEach(async () => {
		stopPendingStartupComposer();
		vi.restoreAllMocks();
		term?.dispose();
		resetSettingsForTest();
	});

	/** Start the prepaint frame on an in-memory terminal (`columns`×`rows`) and take its lease. */
	async function prepaint(
		options: {
			columns?: number;
			rows?: number;
			version?: string;
			preferences?: Partial<StartupPreferences>;
			status?: StatusPrediction;
			/** Answer the TSP hello: the frame renders natively, as under Tern. */
			tern?: boolean;
		} = {},
	): Promise<ComposerLease> {
		term = createModeTerminal({ columns: options.columns ?? 100, rows: options.rows ?? 32 });
		exit = vi.fn();
		beginStartupComposer({
			driver: options.tern ? { ...term.memory.options, env: { PI_TUI_NATIVE: "1" } } : term.memory.options,
			version: options.version ?? "test",
			cache: false,
			exit,
			preferences: { ...config, ...options.preferences },
			...(options.status ? { status: options.status } : {}),
		});
		const lease = takeStartupComposerLease();
		if (!lease) throw new Error("no prepaint lease");
		if (options.tern) term.feed('\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":[]}\x1b\\');
		await lease.ready;
		await term.settle();
		return lease;
	}

	/** The interactive mode adopting `lease`'s started frame. */
	function adopt(lease: ComposerLease, session: ConstructorParameters<typeof InteractiveMode>[0], version = "test") {
		const mode = new InteractiveMode(session, version, undefined, undefined, undefined, undefined, lease.frame);
		lease.adopt();
		return mode;
	}

	const screen = (): string => term.screen().join("\n");

	it("keeps one live composer and terminal across handoff, holding Enter until the mode takes over", async () => {
		const lease = await prepaint();
		const host = lease.frame.shell.host;
		expect(host).toBeDefined();
		term.type("alpha");
		term.press("enter");
		await term.waitFor(() => lease.frame.composer.text() === "alpha");
		await term.settle();
		// Nothing submits before the interactive mode wires the pipeline.
		expect(lease.frame.composer.text()).toBe("alpha");

		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session);
		try {
			term.type(" beta");
			await term.waitFor(() => mode.composer.text() === "alpha beta");
			expect(mode.composer).toBe(lease.frame.composer);
			expect(mode.shell.host).toBe(host);
		} finally {
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("adopts the live draft with final theme, keybindings, and submit behavior", async () => {
		const lease = await prepaint();
		term.type("alpha ");
		term.paste("one\ntwo");
		term.type(" omega");
		term.press("left");
		await term.waitFor(() => lease.frame.composer.text().endsWith(" omega"));
		await term.settle();

		const expectedDraft = lease.frame.composer.expandedText();
		const expectedCursor = lease.frame.composer.cursor();
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: { symbolPreset: "ascii" },
		});
		let mode: InteractiveMode | undefined;

		try {
			initTheme({ symbolPreset: "ascii" });
			cfgComposerShape.set(settings, "box");
			vi.spyOn(KeybindingsManager, "create").mockReturnValue(KeybindingsManager.inMemory({ "app.clear": "ctrl+x" }));
			mode = adopt(lease, testSession.session);
			const host = mode.shell.host;
			expect(mode.composer).toBe(lease.frame.composer);
			await mode.init({ suppressWelcomeIntro: true });

			expect(mode.shell.host).toBe(host);
			expect(mode.composer.expandedText()).toBe(expectedDraft);
			expect(mode.composer.cursor()).toBe(expectedCursor);
			// The box shape in the ascii preset.
			await term.waitFor(rows => rows.some(row => row.trimStart().startsWith("+")));
			expect(screen()).not.toContain("╭");

			term.press("ctrl+c");
			await term.settle();
			expect(mode.composer.expandedText()).toBe(expectedDraft);
			term.press("ctrl+x");
			await term.waitFor(() => mode!.composer.text() === "");
			term.type("ready");
			await term.waitFor(() => mode!.composer.text() === "ready");

			const submitted = mode.getUserInput();
			term.press("enter");
			expect(await submitted).toEqual(expect.objectContaining({ text: "ready" }));
			expect(mode.composer.text()).toBe("");
		} finally {
			mode?.stop();
			await mode?.shell.stop();
			await testSession.cleanup();
			initTheme();
		}
	});

	it("keeps submit gated during initialization, then dispatches with steer", async () => {
		const lease = await prepaint();
		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session);
		const enteredInit = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		vi.spyOn(mode, "refreshSlashCommandState").mockImplementation(async () => {
			enteredInit.resolve();
			await releaseInit.promise;
		});
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			const initializing = mode.init({ suppressWelcomeIntro: true });
			await enteredInit.promise;
			term.type("alpha");
			term.press("enter");
			await term.waitFor(() => mode.composer.text() === "alpha");
			await term.settle();

			expect(prompt).not.toHaveBeenCalled();
			expect(mode.composer.text()).toBe("alpha");

			releaseInit.resolve();
			await initializing;
			// Init wired the submit pipeline and lifted the gate: an Enter before
			// the input loop's first getUserInput dispatches directly with steer
			// instead of being silently dropped.
			term.press("enter");
			await term.waitFor(() => prompt.mock.calls.length > 0);
			expect(prompt).toHaveBeenCalledWith("alpha", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.composer.text()).toBe("");
		} finally {
			releaseInit.resolve();
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("turns kitty enhanced paste on when the interactive mode adopts an already started frame", async () => {
		// The prepaint starts the terminal before InteractiveMode wires the input
		// controller, so enhanced paste (ESC[?5522h) cannot wait for a start event.
		const lease = await prepaint();
		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session);
		const written = () => term.memory.output.join("");

		try {
			expect(written()).not.toContain("\x1b[?5522h");
			await mode.init({ suppressWelcomeIntro: true });
			expect(written().split("\x1b[?5522h")).toHaveLength(2);
		} finally {
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("accepts input while the initial CLI prompt's first turn is still running", async () => {
		const lease = await prepaint();
		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session);
		const turn = Promise.withResolvers<boolean>();
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			await mode.init({ suppressWelcomeIntro: true });

			// The `omp "prompt"` launch shape: the CLI message is dispatched after
			// init and its first turn is still in flight when the user types. The
			// input loop has not reached getUserInput yet.
			prompt.mockReturnValueOnce(turn.promise);
			const initialTurn = testSession.session.prompt("count to 25", { streamingBehavior: "steer" });

			term.type("also add tests");
			term.press("enter");
			await term.waitFor(() => prompt.mock.calls.length >= 2);
			expect(prompt).toHaveBeenCalledWith("also add tests", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.composer.text()).toBe("");

			turn.resolve(true);
			await initialTurn;
		} finally {
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("stops an unadopted prepaint frame on dispose, and leaves an adopted one running", async () => {
		const abandoned = await prepaint();
		abandoned.dispose();
		abandoned.dispose();
		await term.waitFor(() => abandoned.frame.shell.host === undefined);
		term.dispose();

		const adopted = await prepaint();
		adopted.adopt();
		adopted.dispose();
		await term.settle();
		expect(adopted.frame.shell.host).toBeDefined();
		await adopted.frame.shell.stop();
	});

	it("bounds a tall startup draft after adoption in a short terminal", async () => {
		const lease = await prepaint({ columns: 80, rows: 8 });
		lease.frame.composer.setText(Array.from({ length: 18 }, (_, index) => `line-${index}`).join("\n"));
		await term.waitFor(() => lease.frame.composer.text().includes("line-17"));
		const draft = lease.frame.composer.expandedText();
		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session);

		try {
			await mode.init({ suppressWelcomeIntro: true });
			await term.settle();
			expect(mode.composer.expandedText()).toBe(draft);
			expect(draft.split("\n")).toHaveLength(18);
			const visible = term.screen().filter(row => row.includes("line-"));
			expect(visible.length).toBeGreaterThan(0);
			expect(visible.length).toBeLessThanOrEqual(4);
			expect(screen()).not.toContain("Starting OMP");
		} finally {
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("clears a startup draft on Ctrl+C, then exits on the next before the mode takes over", async () => {
		const lease = await prepaint();
		term.type("draft");
		await term.waitFor(() => lease.frame.composer.text() === "draft");
		term.press("ctrl+c");
		await term.waitFor(() => lease.frame.composer.text() === "");
		term.feed("\x1b[99;5:3u"); // Kitty key-up is not a second Ctrl+C.
		await term.settle();
		expect(exit).not.toHaveBeenCalled();
		term.press("ctrl+c");
		await term.waitFor(() => exit.mock.calls.length > 0);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("forward-deletes a startup draft before interactive keybindings load, exiting once it is empty", async () => {
		const lease = await prepaint();
		term.type("draft");
		term.press("left"); // so Ctrl+D has a character ahead of the cursor
		term.press("ctrl+d");
		await term.waitFor(() => lease.frame.composer.text() === "draf");
		expect(exit).not.toHaveBeenCalled();

		for (let i = 0; i < 4; i++) term.press("backspace");
		await term.waitFor(() => lease.frame.composer.text() === "");
		term.press("ctrl+d");
		await term.waitFor(() => exit.mock.calls.length > 0);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("keeps the emergency exit live after adoption until interactive handlers replace it", async () => {
		const lease = await prepaint();
		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session);
		try {
			// InputController.setupKeyHandlers() has not run yet; a stalled startup must
			// still honor Ctrl+D so a raw-mode user can abort.
			term.press("ctrl+d");
			await term.waitFor(() => exit.mock.calls.length > 0);
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("renders the complete interactive welcome scene on the first frame, keeping the composer row as it updates", async () => {
		const lease = await prepaint({ columns: 80, rows: 32, version: "9.9.9", preferences: { quiet: false } });
		await term.waitFor(rows => rows.some(row => row.includes("v9.9.9")));
		expect(screen()).not.toContain("Starting OMP");
		const composerRow = term.screen().findLastIndex(row => row.trim() !== "");
		lease.frame.welcome.version.set("10.0.0-authoritative");
		await term.waitFor(rows => rows.some(row => row.includes("v10.0.0-authoritative")));
		expect(term.screen().findLastIndex(row => row.trim() !== "")).toBe(composerRow);
		await lease.frame.shell.stop();
	});

	it("adopted welcome survives handoff with authoritative data", async () => {
		// The prepaint's speculative version; InteractiveMode's is authoritative.
		const lease = await prepaint({ columns: 80, rows: 32, version: "9.9.8", preferences: { quiet: false } });
		await term.waitFor(rows => rows.some(row => row.includes("v9.9.8")));
		const prepaintComposerRow = term.screen().findLastIndex(row => row.trim() !== "");

		term.type("draft message");
		await term.waitFor(() => lease.frame.composer.text() === "draft message");
		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session, "9.9.9");

		try {
			term.type(" between");
			await term.waitFor(() => mode.composer.text() === "draft message between");
			await mode.init({ suppressWelcomeIntro: true });
			await term.waitFor(rows => rows.some(row => row.includes("v9.9.9")));
			await term.settle();

			expect(mode.composer.expandedText()).toBe("draft message between");
			const output = screen();
			expect(output).not.toContain("v9.9.8");
			expect((output.match(/v9\.9\.9/g) || []).length).toBe(1);
			expect(term.screen().findLastIndex(row => row.trim() !== "")).toBe(prepaintComposerRow);
		} finally {
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("draws the predicted status bar before the session exists, then the live one", async () => {
		const lease = await prepaint({
			columns: 100,
			status: {
				settings: { preset: "default" },
				facts: {
					model: { id: "prophet-9", name: "Prophet 9", thinking: true, contextWindow: 200_000 },
					thinkingLevel: "high",
					usingSubscription: false,
					autoCompact: true,
					context: { tokens: 6_000, window: 200_000, percent: 3 },
				},
			},
		});
		await term.waitFor(rows => rows.some(row => row.includes("Prophet 9")));

		const testSession = await createTestSession({ inMemory: true });
		const mode = adopt(lease, testSession.session);
		try {
			await mode.init({ suppressWelcomeIntro: true });
			await term.waitFor(rows => !rows.some(row => row.includes("Prophet 9")));
		} finally {
			mode.stop();
			await mode.shell.stop();
			await testSession.cleanup();
		}
	});

	it("hands a natively drawn predicted bar to the live one with the rate readout on", async () => {
		// Tern mirrors the bar's slots the moment they change: the rate readout reads the viewed
		// session while the mode is still being built.
		cfgComposerTokenRate.set(settings, true);
		const lease = await prepaint({
			tern: true,
			status: {
				settings: { preset: "default" },
				facts: {
					model: { id: "prophet-9", name: "Prophet 9", thinking: true, contextWindow: 200_000 },
					usingSubscription: false,
					autoCompact: true,
					context: { tokens: 6_000, window: 200_000, percent: 3 },
				},
			},
		});
		const testSession = await createTestSession({ inMemory: true });
		try {
			expect(lease.frame.shell.native()).toBe(true);
			const mode = adopt(lease, testSession.session);
			mode.stop();
		} finally {
			await lease.frame.shell.stop();
			await testSession.cleanup();
		}
	});

	it("preferences feed applies quiet mode", async () => {
		// Settings resolve while the prepaint is still the startup owner (before any lease is taken).
		term = createModeTerminal({ columns: 80, rows: 32 });
		beginStartupComposer({
			driver: term.memory.options,
			version: "9.9.9",
			cache: false,
			preferences: { ...config, quiet: false },
		});
		await term.waitFor(rows => rows.some(row => row.includes("v9.9.9")));

		applyStartupComposerPreferences({ ...config, quiet: true, composerShape: "box", theme: {} });
		await term.waitFor(rows => !rows.some(row => row.includes("v9.9.9")));

		term.type("still editable");
		await term.waitFor(rows => rows.some(row => row.includes("still editable")));
	});

	it("starts a fullscreen session on the alternate screen without erasing the shell's scrollback", async () => {
		const lease = await prepaint({ columns: 80, rows: 24, preferences: { screen: "fullscreen" } });
		expect(term.engine.isMainScreen).toBe(false);
		expect(term.memory.output.join("")).not.toContain("\x1b[3J");
		await lease.frame.shell.stop();
		expect(term.engine.isMainScreen).toBe(true);
	});

	it("switches a prepaint started from a stale cached screen mode to the resolved one", async () => {
		term = createModeTerminal({ columns: 80, rows: 24 });
		beginStartupComposer({ driver: term.memory.options, version: "test", cache: false, preferences: config });
		await term.waitFor(rows => rows.length > 0);
		expect(term.engine.isMainScreen).toBe(true);
		applyStartupComposerPreferences({ ...config, screen: "fullscreen", theme: {} });
		await term.waitFor(() => !term.engine.isMainScreen);
	});

	// Cold launch first clears native history while painting the prepaint welcome.
	// Once InteractiveMode is ready, a normal replay can offer resumed transcript
	// rows and repaint the viewport without another destructive reset. On conhost a
	// second ED3-then-ED2 reset would archive the prepaint frame into scrollback
	// after ED3 already ran, leaving a stale welcome above the live UI (#9597).
	describe("cold-launch native history reset", () => {
		// Every destructive reset emits one erase-scrollback (ED3). Count that
		// operation without coupling to the ED2/ED3 ordering.
		const ERASE_SCROLLBACK = "\x1b[3J";

		/** Erase-scrollback operations in `output`. */
		function countResets(output: readonly string[]): number {
			const all = output.join("");
			let n = 0;
			for (let i = all.indexOf(ERASE_SCROLLBACK); i !== -1; i = all.indexOf(ERASE_SCROLLBACK, i + 1)) n++;
			return n;
		}

		// `resuming` mirrors `main.ts` `runInteractiveMode`: `false` on a plain `omp`
		// launch, `true` for --continue/--resume/--fork.
		async function coldLaunch(resuming: boolean): Promise<{
			resets: number;
			welcomeRows: number;
			scrollBuffer: string;
		}> {
			const lease = await prepaint({ rows: 30, version: "18.0.4" });
			const testSession = await createTestSession({ inMemory: true });
			if (resuming) {
				testSession.sessionManager.appendMessage(userMsg("resume marker question"));
				testSession.sessionManager.appendMessage(assistantMsg("resume marker answer"));
			}
			const mode = adopt(lease, testSession.session, "18.0.4");
			try {
				await mode.init({ suppressWelcomeIntro: resuming, clearInitialTerminalHistory: true });
				await mode.renderInitialMessages({ preserveExistingChat: true });
				if (resuming) await term.waitFor(() => term.text().includes("resume marker answer"));
				await term.settle();
				const rows = term.text().split("\n");
				return {
					resets: countResets(term.memory.output),
					welcomeRows: rows.filter(l => l.includes("18.0.4")).length,
					scrollBuffer: rows.join("\n"),
				};
			} finally {
				mode.stop();
				await mode.shell.stop();
				await testSession.cleanup();
			}
		}

		it("clears native history once on a fresh launch, leaving one welcome header", async () => {
			const { resets, welcomeRows } = await coldLaunch(false);
			// The first clear already owns the final welcome frame; the replay must not
			// clear again, or conhost promotes that frame into scrollback (duplicate).
			expect(resets).toBe(1);
			expect(welcomeRows).toBe(1);
		});

		it("replays a resumed transcript without clearing native history again", async () => {
			const { resets, scrollBuffer, welcomeRows } = await coldLaunch(true);
			expect(resets).toBe(1);
			expect(scrollBuffer).toContain("resume marker answer");
			expect(welcomeRows).toBe(1);
		});
	});
});
