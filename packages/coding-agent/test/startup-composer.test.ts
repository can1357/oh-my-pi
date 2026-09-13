import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { COMPOSER_DEFAULTS, Composer, type ComposerPreferences } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	applyStartupComposerPreferences,
	beginStartupComposer,
	ComposerLease,
	setStartupComposerLspServers,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";
import { createTestSession } from "./utilities";

class CountingTerminal extends VirtualTerminal {
	starts = 0;
	stops = 0;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.starts += 1;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stops += 1;
		super.stop();
	}
}

class ThrowingStartTerminal extends CountingTerminal {
	override start(): void {
		this.starts += 1;
		throw new Error("terminal start failed");
	}
}
class InputTrackingTerminal extends CountingTerminal {
	startOptions: { deferInput?: boolean } | undefined;
	inputEnables = 0;
	override start(
		onInput: (data: string) => void,
		onResize: () => void,
		_onDisconnect?: () => void,
		options?: { deferInput?: boolean },
	): void {
		this.startOptions = options;
		super.start(onInput, onResize);
	}

	enableInput(): void {
		this.inputEnables += 1;
	}
}

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
		activeSettings.override("startup.checkUpdate", false);
		activeSettings.override("startup.changelogMode", "hidden");
		activeSettings.override("startup.setupWizard", false);
		activeSettings.override("startup.showSplash", false);
		activeSettings.override("marketplace.autoUpdate", "off");
		installInMemoryRelay();
		const publish = registry.publishCollabHost;
		vi.spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
			publish(source, { ...options, dir: testSession.tempDir }),
		);
		vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		const init = InteractiveMode.prototype.init;
		vi.spyOn(InteractiveMode.prototype, "init").mockImplementation(function (this: InteractiveMode, options) {
			vi.spyOn(this.statusLine, "watchBranch").mockImplementation(() => {});
			return init.call(this, options);
		});
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
		beginStartupComposer({ terminal: new VirtualTerminal(), version: "test", cache: false });
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
			await testSession.cleanup();
			resetSettingsForTest();
			setProjectDir(originalProject);
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});
});

describe("Composer prepaint", () => {
	let settings: Settings;

	let config: ComposerPreferences;
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: settings.get("startup.quiet"),
			composerShape: settings.get("composer.shape") ?? "box",
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
	});

	it("keeps one live editor and terminal across handoff", () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		const submit = vi.fn();
		composer.editor.onSubmit = submit;

		composer.start();
		terminal.sendInput("alpha");
		terminal.sendInput("\r");

		expect(composer.editor.getExpandedText()).toBe("alpha");
		expect(submit).not.toHaveBeenCalled();
		expect(terminal.starts).toBe(1);

		composer.transfer();
		composer.stop();
		terminal.sendInput(" beta");

		expect(composer.editor.getExpandedText()).toBe("alpha beta");
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(0);

		composer.ui.stop();
		expect(terminal.stops).toBe(1);
	});

	it("adopts the live draft with final theme, keybindings, and submit behavior", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		terminal.sendInput("alpha ");
		terminal.sendInput("\x1b[200~one\ntwo\x1b[201~");
		terminal.sendInput(" omega");
		terminal.sendInput("\x1b[D");

		const expectedDraft = composer.editor.getExpandedText();
		const expectedCursor = composer.editor.getCursor();
		const lease = new ComposerLease(composer);
		const adoptedComposer = lease.composer;
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: { symbolPreset: "ascii" },
		});
		let mode: InteractiveMode | undefined;

		try {
			await initTheme(false, "ascii");
			settings.set("composer.shape", "box");
			vi.spyOn(KeybindingsManager, "create").mockReturnValue(KeybindingsManager.inMemory({ "app.clear": "ctrl+x" }));
			mode = new InteractiveMode(
				testSession.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				adoptedComposer,
			);
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			await mode.init({ suppressWelcomeIntro: true });

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			expect(mode.editor.getCursor()).toEqual(expectedCursor);
			expect(terminal.starts).toBe(1);
			const adoptedEditor = Bun.stripANSI(mode.editor.render(40).join("\n"));
			expect(adoptedEditor.startsWith("+")).toBe(true);
			expect(adoptedEditor).not.toContain("╭");

			terminal.sendInput("\x03");
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			terminal.sendInput("\x18");
			expect(mode.editor.getExpandedText()).toBe("");
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("ready");
			expect(mode.editor.getExpandedText()).toBe("ready");

			const submitted = mode.getUserInput();
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			expect(await submitted).toEqual(expect.objectContaining({ text: "ready" }));
			expect(mode.editor.getExpandedText()).toBe("");
			expect(terminal.starts).toBe(1);
		} finally {
			mode?.stop();
			await testSession.cleanup();
			vi.restoreAllMocks();
			await initTheme();
		}
	});

	it("keeps submit gated during initialization, then dispatches with steer", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		const enteredInit = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		vi.spyOn(mode, "refreshSlashCommandState").mockImplementation(async () => {
			enteredInit.resolve();
			await releaseInit.promise;
		});
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(testSession.session, "maybeStartTitleGeneration").mockImplementation(() => {});
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			const initializing = mode.init({ suppressWelcomeIntro: true });
			await enteredInit.promise;
			terminal.sendInput("alpha");
			terminal.sendInput("\r");

			expect(prompt).not.toHaveBeenCalled();
			expect(mode.editor.getExpandedText()).toBe("alpha");
			expect(mode.editor.disableSubmit).toBe(true);

			releaseInit.resolve();
			await initializing;
			// Init wired the submit pipeline and lifted the gate: an Enter before
			// the input loop's first getUserInput dispatches directly with steer
			// instead of being silently dropped.
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length === 0; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("alpha", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");
		} finally {
			releaseInit.resolve();
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("accepts input while the initial CLI prompt's first turn is still running", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(testSession.session, "maybeStartTitleGeneration").mockImplementation(() => {});
		const turn = Promise.withResolvers<boolean>();
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			await mode.init({ suppressWelcomeIntro: true });

			// The `omp "prompt"` launch shape: the CLI message is dispatched after
			// init and its first turn is still in flight when the user types. The
			// input loop has not reached getUserInput yet.
			prompt.mockReturnValueOnce(turn.promise);
			const initialTurn = testSession.session.prompt("count to 25", { streamingBehavior: "steer" });

			terminal.sendInput("also add tests");
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length < 2; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("also add tests", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");

			turn.resolve(true);
			await initialTurn;
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("tracks terminal ownership until a lease is adopted", () => {
		const abandonedTerminal = new CountingTerminal();
		const abandonedComposer = new Composer({ preferences: config, terminal: abandonedTerminal });
		abandonedComposer.start();
		const abandonedLease = new ComposerLease(abandonedComposer);
		abandonedLease.dispose();
		abandonedLease.dispose();
		expect(abandonedTerminal.stops).toBe(1);

		const adoptedTerminal = new CountingTerminal();
		const adoptedComposer = new Composer({ preferences: config, terminal: adoptedTerminal });
		adoptedComposer.start();
		const adoptedLease = new ComposerLease(adoptedComposer);
		adoptedLease.adopt();
		adoptedLease.dispose();
		expect(adoptedTerminal.stops).toBe(0);
		adoptedLease.composer.ui.stop();
		expect(adoptedTerminal.stops).toBe(1);
	});

	it("restores a partially started terminal and leaves no pending owner", () => {
		const terminal = new ThrowingStartTerminal();
		expect(() => beginStartupComposer({ preferences: config, terminal, cache: false })).toThrow(
			"terminal start failed",
		);
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(1);
		expect(takeStartupComposerLease()).toBeUndefined();
	});

	it("bounds a tall startup draft after adoption in a short terminal", async () => {
		const terminal = new CountingTerminal(80, 8);
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		for (let index = 0; index < 18; index += 1) {
			terminal.sendInput(`line-${index}`);
			if (index < 17) terminal.sendInput("\n");
		}
		const draft = composer.editor.getExpandedText();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

		try {
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();
			expect(mode.editor.getExpandedText()).toBe(draft);
			expect(draft.split("\n")).toHaveLength(18);
			expect(mode.editor.render(80).length).toBeLessThanOrEqual(4);
			expect(terminal.getViewport().join("\n")).not.toContain("Starting OMP");
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("restores the terminal before an early double interrupt exits", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		let now = 1_000;
		const composer = new Composer({ preferences: config, terminal, exit, now: () => now });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x03");
		expect(composer.editor.getExpandedText()).toBe("");
		now += 100;
		terminal.sendInput("\x03");

		expect(terminal.stops).toBe(1);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("uses standard emergency exit before interactive keybindings load", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});
	it("keeps emergency exit live after adoption until interactive handlers replace it", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();
		const lease = new ComposerLease(composer);
		lease.adopt();

		// InputController.setupKeyHandlers() has not run yet; a stalled startup must
		// still honor Ctrl+D so a raw-mode user can abort.
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});

	it("first frame mirrors the canonical settings-schema defaults", () => {
		expect(COMPOSER_DEFAULTS).toEqual({
			quiet: getDefault("startup.quiet"),
			composerShape: getDefault("composer.shape") ?? "box",
			showHardwareCursor: getDefault("showHardwareCursor"),
			maxInlineImages: getDefault("tui.maxInlineImages"),
			resizeScrollback: getDefault("tui.resizeScrollback"),
			imeSafeCursor: getDefault("tui.imeSafeCursor"),
			autocompleteMaxVisible: getDefault("autocompleteMaxVisible"),
			spellingTypoDetection: getDefault("spelling.typoDetection"),
			spellingAutocomplete: getDefault("spelling.autocomplete"),
			spellingAutocorrect: getDefault("spelling.autocorrect"),
		});
	});
	it("renders the complete interactive welcome scene on the first frame", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			welcome: {
				version: "9.9.9",
				recentSessions: [{ name: "prior work", timeAgo: "5m ago" }],
			},
		});
		composer.start();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).toContain("Welcome back!");
		expect(output).toContain("omp");
		expect(output).toContain("9.9.9");
		expect(output).toContain("prior work");
		expect(output).not.toContain("Starting OMP");
		expect(output).toContain("╭");
		const initialEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╭"));
		composer.updateWelcome({
			modelName: "provider/model-with-an-authoritative-name-that-is-longer-than-the-left-column",
			providerName: "provider-with-a-long-name",
			lspServers: [{ name: "rust-analyzer", status: "connecting", fileTypes: [".rs"] }],
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("rust-analyzer")),
		);
		const updatedEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╭"));
		expect(updatedEditorRow).toBe(initialEditorRow);
		composer.stop();
	});

	it("adopted welcome survives handoff with authoritative data", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			welcome: {
				version: "9.9.9",
				modelName: "Claude Fable 5",
				providerName: "anthropic",
				recentSessions: [{ name: "prior work", timeAgo: "5m ago" }],
			},
		});
		composer.start();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);
		const prepaintRows = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(prepaintRows.join("\n")).toContain("Claude Fable 5");
		expect(prepaintRows.join("\n")).toContain("anthropic");
		const prepaintEditorRow = prepaintRows.findLastIndex(row => row.startsWith("╭"));

		terminal.sendInput("draft message");
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		let mode: InteractiveMode | undefined;

		try {
			mode = new InteractiveMode(
				testSession.session,
				"9.9.9",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				lease.composer,
			);
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
			const realTopBorder = vi
				.spyOn(mode.statusLine, "getTopBorder")
				.mockReturnValue({ content: "real status bar", width: 15, revision: 1 });
			terminal.sendInput(" between");
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			await terminal.waitForRender();
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();

			expect(terminal.starts).toBe(1);
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			const output = terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n");
			const modelName = testSession.session.model?.name ?? "";
			expect(output).toContain(modelName);
			realTopBorder.mockReturnValue({ content: "real status bar *18 ?5", width: 21, revision: 2 });
			mode.ui.requestRender();
			await terminal.waitForRender(() =>
				terminal.getViewport().some(row => Bun.stripANSI(row).includes("real status bar *18 ?5")),
			);
			const welcomeMatches = (output.match(/Welcome back!/g) || []).length;
			expect(welcomeMatches).toBe(1);
			const adoptedEditorRow = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.findLastIndex(row => row.startsWith("╭"));
			expect(adoptedEditorRow).toBe(prepaintEditorRow);
		} finally {
			mode?.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("preferences feed applies quiet mode", async () => {
		const terminal = new CountingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);
		expect(
			terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n"),
		).toContain("Welcome back!");

		applyStartupComposerPreferences({
			quiet: true,
			composerShape: "box",
			showHardwareCursor: config.showHardwareCursor,
			maxInlineImages: config.maxInlineImages,
			resizeScrollback: config.resizeScrollback,
			imeSafeCursor: config.imeSafeCursor,
			autocompleteMaxVisible: config.autocompleteMaxVisible,
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
			theme: {},
		});
		await terminal.waitForRender();

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).not.toContain("Welcome back!");

		terminal.sendInput("still editable");
		await terminal.waitForRender();
		expect(
			terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n"),
		).toContain("still editable");
	});

	it("LSP feed fills the welcome rows", async () => {
		const terminal = new CountingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);

		setStartupComposerLspServers([{ name: "rust-analyzer", status: "connecting", fileTypes: [".rs"] }]);
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("rust-analyzer")),
		);

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).toContain("rust-analyzer");
	});
	it("transfers the in-flight recent-session load across composer ownership", async () => {
		const terminal = new CountingTerminal(80, 32);
		const load = Promise.withResolvers<Array<{ name: string; timeAgo: string }>>();
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
			recentSessions: () => load.promise,
		});

		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		const rows = [{ name: "already loading", timeAgo: "just now" }];
		load.resolve(rows);
		expect(await lease?.recentSessions).toEqual(rows);
		lease?.dispose();
	});
	it("defers raw input until resolved settings arrive, adoption as fallback", async () => {
		// Regression contract: losing the deferral re-blinds typing during the
		// startup module-load stall; losing the enable leaves the keyboard dead
		// for the whole session.
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({ preferences: config, terminal, version: "9.9.9", cache: false });
		expect(terminal.startOptions?.deferInput).toBeTrue();
		expect(terminal.inputEnables).toBe(0);

		applyStartupComposerPreferences({ ...config, theme: {} });
		expect(terminal.inputEnables).toBe(1);

		// Adoption after preferences must not double-enable…
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});

	it("adoption enables raw input when settings never resolved", () => {
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({ preferences: config, terminal, version: "9.9.9", cache: false });
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});
});
