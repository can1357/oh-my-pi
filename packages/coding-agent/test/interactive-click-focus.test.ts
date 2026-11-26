import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { cfgExtensionAssistantTextRenderers } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { jsx, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal, transcriptText } from "./helpers/mode-terminal";

describe("inline click-to-focus geometry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;
	let eventBus: EventBus;
	/** Whether the shell renders natively (Tern took the screen). */
	const native = signal(false);
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-click-focus-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = createModeTerminal({ columns: 120, rows: 32 });
		eventBus = new EventBus();
		native.set(false);
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, eventBus, term.frame);
		vi.spyOn(mode.shell, "native").mockImplementation(() => native());
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** A live `task` card whose one running agent is `id`; resolves once its row is on screen. */
	async function showLiveTask(id: string): Promise<void> {
		// The built-in `task` card (the fixture session registers no tools).
		vi.spyOn(session, "hasBuiltInTool").mockImplementation(name => name === "task");
		const card = mode.presentToolCall({ name: "task", args: {}, tool: undefined, id: "task-1", cwd: tempDir.path() });
		const progress: AgentProgress = {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "do clickable work",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		card.updateResult(
			{
				content: [{ type: "text", text: "Running 1 agent..." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 1, progress: [progress] },
			},
			true,
			"task-1",
		);
		await term.waitFor(() => term.screen().some(row => row.includes(id)));
	}

	it("focuses the agent whose live task row is clicked in the transcript", async () => {
		cfgTuiMouse.set(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const focus = vi.spyOn(mode, "focusAgentSession").mockResolvedValue();
		await showLiveTask("ClickWorker");

		const row = term.screen().findIndex(line => line.includes("ClickWorker"));
		term.mouse({ x: 5, y: row });
		await term.waitFor(() => focus.mock.calls.length > 0);
		expect(focus.mock.calls).toEqual([["ClickWorker"]]);

		// The status line names no agent.
		focus.mockClear();
		term.mouse({ x: 5, y: term.screen().length - 1 });
		await term.settle();
		expect(focus).not.toHaveBeenCalled();
	});

	it("bands the hovered live task row and clears it off-target", async () => {
		cfgTuiMouse.set(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		await showLiveTask("HoverWorker");
		const workerRow = () => term.screen().findIndex(line => line.includes("HoverWorker"));
		const workerBg = (): string => {
			const row = workerRow();
			return JSON.stringify(Array.from({ length: 20 }, (_, x) => term.engine.cell(x, row)?.bg));
		};
		const before = workerBg();

		term.mouse({ x: 5, y: workerRow(), button: "none", action: "move" });
		await term.waitFor(() => workerBg() !== before);
		expect(workerBg()).not.toBe(before);

		// Moving onto the status line restores the row's colors.
		term.mouse({ x: 5, y: term.screen().length - 1, button: "none", action: "move" });
		await term.waitFor(() => workerBg() === before);
		expect(workerBg()).toBe(before);

		// Turning mouse capture off mid-hover drops the band; back on, motion bands the row again.
		term.mouse({ x: 5, y: workerRow(), button: "none", action: "move" });
		await term.waitFor(() => workerBg() !== before);
		cfgTuiMouse.set(mode.settings, false);
		await term.waitFor(() => workerBg() === before);
		expect(workerBg()).toBe(before);
		cfgTuiMouse.set(mode.settings, true);
		await term.settle();
		term.mouse({ x: 5, y: workerRow(), button: "none", action: "move" });
		await term.waitFor(() => workerBg() !== before);
		expect(workerBg()).not.toBe(before);
	});

	it("expands and collapses the pinned jump list through SGR clicks", async () => {
		cfgTuiMouse.set(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();

		for (let index = 0; index < 5; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: `ToggleAgent${index}`,
				index,
				agent: "task",
				agentSource: "bundled",
				description: `toggle job ${index}`,
				status: "started",
				parentToolCallId: "tool-call",
				detached: true,
			});
		}
		const clickRow = async (marker: string): Promise<void> => {
			await term.waitFor(() => term.screen().some(row => row.includes(marker)));
			const viewport = term.screen();
			const screenRow = viewport.findIndex(row => row.includes(marker));
			expect(screenRow).toBeGreaterThanOrEqual(0);
			term.feed(`\x1b[<0;5;${screenRow + 1}M`);
		};

		// Collapsed by default: three rows plus the expander.
		await term.waitFor(() => term.screen().some(row => row.includes("more — expand")));
		expect(term.screen().some(row => row.includes("ToggleAgent3"))).toBe(false);

		// Clicking the expander paints the slotted window with a collapse row.
		await clickRow("more — expand");
		await term.waitFor(() => term.screen().some(row => row.includes("show less")));
		expect(term.screen().some(row => row.includes("ToggleAgent4"))).toBe(true);
		// Clicking it again collapses back to a few rows.
		await clickRow("show less");
		await term.waitFor(() => term.screen().some(row => row.includes("more — expand")));
		expect(term.screen().some(row => row.includes("ToggleAgent3"))).toBe(false);
	});

	/**
	 * Install a runner whose one extension claims `schemes` (`demo:` by default) and records each
	 * `link_activate` URL.
	 */
	function installDemoLinkExtension(schemes: string[] = ["demo"]): {
		activated: string[];
		firstActivation: Promise<void>;
		extension: Extension;
		runner: ExtensionRunner;
	} {
		const activated: string[] = [];
		const first = Promise.withResolvers<void>();
		const handlers: Extension["handlers"] = new Map();
		handlers.set("link_activate", [
			async (...args: unknown[]) => {
				const [event] = args;
				if (event && typeof event === "object" && "url" in event && typeof event.url === "string") {
					activated.push(event.url);
				}
				first.resolve();
			},
		]);
		const extension: Extension = {
			path: "/test/links.ts",
			resolvedPath: "/test/links.ts",
			handlers,
			tools: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: [],
			transcriptPresenters: [],
			linkSchemes: schemes,
			urlSchemes: new Map(),
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const runner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			tempDir.path(),
			session.sessionManager,
			modelRegistry,
			undefined,
			mode.settings,
		);
		Object.defineProperty(session, "extensionRunner", { configurable: true, get: () => runner });
		return { activated, firstActivation: first.promise, extension, runner };
	}

	function appendReply(text: string, timestamp = 1): void {
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		});
	}

	/** A one-line panel that records the text (or id) of every key it takes. */
	function keyCatcher(text: string, keys: string[]) {
		return jsx("col", {
			children: [jsx("text", { text })],
			onKey: (key: KeyEvent) => {
				keys.push(key.text ?? key.id);
				return true;
			},
		});
	}

	/** Whether a hint tag (drawn in reverse video) covers the first cell of `label` on screen. */
	function tagDrawnOver(label: string): boolean {
		const rows = term.screen();
		const row = rows.findIndex(line => line.includes(label));
		return row >= 0 && term.engine.cell(rows[row]!.indexOf(label), row)?.reverse === true;
	}

	/** Draw one assistant reply with `text` and wait until `visible` shows on screen. */
	async function showReply(text: string, visible: string): Promise<void> {
		appendReply(text);
		await mode.renderInitialMessages();
		await term.waitFor(() => term.screen().some(row => row.includes(visible)));
	}

	it("leaves a link change before the startup replay to that replay, drawing the transcript once", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { extension } = installDemoLinkExtension([]);
		appendReply("Open [the details](demo:open/7) now.");
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		// A startup notice (MCP, LSP) lands in the chat before the replay; then a scheme is claimed.
		mode.showWarning("early notice");
		extension.linkSchemes.push("demo");
		mode.syncExtensionLinks();
		// Any rebuild the change queued runs as a microtask, before this continuation.
		await Promise.resolve();
		await mode.renderInitialMessages({ preserveExistingChat: true });
		const chat = transcriptText(mode.shell);
		expect(chat.split("Open the details now.").length - 1).toBe(1);
		expect(chat.split("early notice").length - 1).toBe(1);
	});

	it("hands a click on an extension-owned link to its extension with tui.mouse on, other links unchanged", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		cfgTuiMouse.set(mode.settings, true);
		const { activated, firstActivation } = installDemoLinkExtension();
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();

		const from = term.memory.output.length;
		const written = () => term.memory.output.slice(from);
		await showReply("Open [the details](demo:open/7) or read [the docs](https://example.com/docs).", "the details");
		// The terminal never receives the extension URL, so it has no hyperlink of its own to open.
		expect(written().join("")).not.toContain("demo:open/7");
		expect(written().join("")).toContain("https://example.com/docs");
		const viewport = term.screen();
		const screenRow = viewport.findIndex(row => row.includes("the details"));
		// The extension link draws without its URL; the web link keeps the suffix.
		expect(viewport[screenRow]).not.toContain("demo:open/7");
		expect(viewport[screenRow]).toContain("the docs (https://example.com/docs)");

		const click = (label: string) =>
			term.feed(`\x1b[<0;${viewport[screenRow]!.indexOf(label) + 2};${screenRow + 1}M`);
		// A click on the web link raises nothing; the extension link's click reaches its extension.
		click("the docs");
		click("the details");
		await firstActivation;
		expect(activated).toEqual(["demo:open/7"]);
	});

	it("picks an extension link by its hint tag with tui.mouse off; Esc cancels without picking", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { activated, firstActivation } = installDemoLinkExtension();
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		// A user rebinding of the hint key is honored.
		mode.keybindings.setUserBindings({ "app.links.hint": "alt+k" });
		expect(cfgTuiMouse.get(mode.settings)).toBe(false);
		expect(session.extensionRunner?.getUIContext()?.getLinkClicksAvailable()).toBe(true);

		await showReply("Open [the details](demo:open/7) or read [the docs](https://example.com/docs).", "the details");
		// The hint key opens the link browser, every extension link tagged: the tag is the letter it covers, `t`.
		const tagged = () => tagDrawnOver("the details");
		const browsing = () => term.screen().some(row => row.includes("Extension links"));
		const hintKey = "\x1bk";

		// Esc leaves without any pick, and the next letter types into the editor again.
		term.feed(hintKey);
		await term.waitFor(() => browsing() && tagged());
		term.feed("\x1b");
		await term.waitFor(() => !browsing());
		term.feed("a");
		await term.waitFor(() => mode.composer.text() === "a");
		expect(activated).toEqual([]);

		// The tag drawn over the label picks it, closing the browser.
		term.feed(hintKey);
		await term.waitFor(() => browsing() && tagged());
		term.feed("t");
		await firstActivation;
		expect(activated).toEqual(["demo:open/7"]);
		await term.waitFor(() => !browsing());
		expect(mode.composer.text()).toBe("a");
		expect(mode.shell.focused()).toBe(mode.composer.field);

		// An overlay opening over the browser (e.g. an extension's custom UI) gets the keys; no link is picked.
		term.feed(hintKey);
		await term.waitFor(() => browsing() && tagged());
		const overlayInput: string[] = [];
		const overlay = mode.shell.overlays.show(() => keyCatcher("overlay", overlayInput));
		term.feed("a");
		await term.waitFor(() => overlayInput.length > 0);
		expect(overlayInput).toEqual(["a"]);
		expect(activated).toEqual(["demo:open/7"]);
		overlay.close();
		term.feed("\x1b");
		await term.waitFor(() => !browsing());

		// The hint key does nothing while a dialog in the editor area (ask, selectors) has focus: it takes the key.
		const dialogInput: string[] = [];
		const dialog = mode.showEditorAreaDialog(() => keyCatcher("dialog", dialogInput));
		term.feed(hintKey);
		await term.waitFor(() => dialogInput.length > 0);
		expect(browsing()).toBe(false);
		dialog.close();
		expect(activated).toEqual(["demo:open/7"]);
	});

	it("reports links as unavailable with the hint key unbound until tui.mouse turns on", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		installDemoLinkExtension();
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const ui = session.extensionRunner?.getUIContext();
		expect(ui?.getLinkClicksAvailable()).toBe(true);
		mode.keybindings.setUserBindings({ "app.links.hint": [] });
		expect(ui?.getLinkClicksAvailable()).toBe(false);
		cfgTuiMouse.set(mode.settings, true);
		// The mode picks the change up from its settings listener, after `set` returns.
		await term.waitFor(() => ui?.getLinkClicksAvailable() === true);
		expect(ui?.getLinkClicksAvailable()).toBe(true);
	});

	it("redraws a focused subagent's reply when its extension handles a click on its link", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		cfgTuiMouse.set(mode.settings, true);
		const extension = (handlers: Extension["handlers"], renderers: Extension["assistantTextRenderers"]) => ({
			path: "/test/links.ts",
			resolvedPath: "/test/links.ts",
			handlers,
			tools: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: renderers,
			transcriptPresenters: [],
			linkSchemes: ["demo"],
			urlSchemes: new Map(),
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		});
		const runner = (ext: Extension) =>
			new ExtensionRunner(
				[ext],
				new ExtensionRuntime(),
				tempDir.path(),
				session.sessionManager,
				modelRegistry,
				undefined,
				mode.settings,
			);
		// The main session's copy of the extension: interactive UI, never sees the click.
		const mainRunner = runner(extension(new Map(), []));
		// The subagent's own copy: a headless runner, as the task executor builds it.
		let opened = false;
		const handled = Promise.withResolvers<void>();
		const childHandlers: Extension["handlers"] = new Map();
		childHandlers.set("link_activate", [
			async (...args: unknown[]) => {
				opened = true;
				const ctx = args[1] as { ui: { rerenderMessage(timestamp: number): void } };
				ctx.ui.rerenderMessage(1);
				handled.resolve();
			},
		]);
		const childRunner = runner(
			extension(childHandlers, [
				({ text }) => (opened ? text.replace("[the details](demo:toggle)", "OPENED") : undefined),
			]),
		);
		Object.defineProperty(session, "extensionRunner", { configurable: true, get: () => mainRunner });
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		// Focus the subagent: its transcript, renderers and link schemes come from its runner.
		const focused = new Proxy(session, {
			get: (target, property) => {
				if (property === "extensionRunner") return childRunner;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		Object.defineProperty(mode, "viewSession", { configurable: true, get: () => focused });
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Open [the details](demo:toggle) now." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		});
		await mode.renderInitialMessages();
		await term.waitFor(() => term.screen().some(row => row.includes("the details")));
		// The subagent's runner has no UI of its own, yet its links are picked here: it says so too.
		expect(mainRunner.getUIContext()?.getLinkClicksAvailable()).toBe(true);
		expect(childRunner.hasUI()).toBe(false);
		expect(childRunner.getUIContext()?.getLinkClicksAvailable()).toBe(true);
		const viewport = term.screen();
		const screenRow = viewport.findIndex(row => row.includes("the details"));
		term.feed(`\x1b[<0;${viewport[screenRow]!.indexOf("the details") + 2};${screenRow + 1}M`);
		await handled.promise;
		await term.waitFor(() => term.screen().some(row => row.includes("OPENED")));
		expect(term.screen().some(row => row.includes("Open OPENED now."))).toBe(true);

		// Disabling the extension live suspends only the main copy; the subagent's copy stops drawing too.
		mainRunner.setSuspendedExtensions(() => true);
		await Promise.resolve();
		const chat = transcriptText(mode.shell);
		expect(chat).toContain("Open the details (demo:toggle) now.");
		expect(await childRunner.emitLinkActivate("demo:toggle")).toBe(false);
	});

	it("re-runs assistant text renderers when Tern's native view takes the screen and hands it back", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { extension, runner } = installDemoLinkExtension();
		// Draws the link only while it can be picked here, its target inline otherwise.
		extension.assistantTextRenderers.push(({ text }) =>
			runner.getUIContext()?.getLinkClicksAvailable()
				? undefined
				: text.replace("[the details](demo:open/7)", "INLINE"),
		);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		await showReply("Open [the details](demo:open/7) now.", "the details");
		const chat = () => transcriptText(mode.shell);
		expect(chat()).toContain("Open the details now.");
		try {
			native.set(true);
			// The redraw's rebuild runs as a microtask, before this continuation.
			await Promise.resolve();
			expect(chat()).toContain("Open INLINE now.");
		} finally {
			native.set(false);
		}
		await Promise.resolve();
		expect(chat()).toContain("Open the details now.");
	});

	it("drops a suspended extension's link scheme and renderers from the transcript, and restores them on resume", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { extension, runner } = installDemoLinkExtension();
		extension.assistantTextRenderers.push(({ text }) => text.replace("now", "NOW"));
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		await showReply("Open [the details](demo:open/7) now.", "the details");
		const chat = () => transcriptText(mode.shell);
		expect(chat()).toContain("Open the details NOW.");

		// A live `disabledExtensions` edit suspends it: its scheme is no longer claimed, its renderer gone.
		runner.setSuspendedExtensions(() => true);
		expect(runner.getLinkSchemes()).toEqual([]);
		await Promise.resolve();
		expect(chat()).toContain("Open the details (demo:open/7) now.");

		runner.setSuspendedExtensions(() => false);
		await Promise.resolve();
		expect(chat()).toContain("Open the details NOW.");
	});

	it("browses to a link scrolled off the screen, picks it by tag, and redraws its reply", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { activated, extension } = installDemoLinkExtension();
		// Opening the early link expands its reply; the handler asks omp to redraw it.
		let expanded = false;
		extension.assistantTextRenderers.push(({ text, message }) =>
			expanded && message.timestamp === 1
				? text.replace("here.", "here.\n\nEXPANDED one.\n\nEXPANDED two.")
				: undefined,
		);
		const handled = Promise.withResolvers<void>();
		extension.handlers.get("link_activate")!.push(async (...args: unknown[]) => {
			expanded = true;
			// The runner hands every link_activate handler its ExtensionContext as the second argument.
			const ctx = args[1] as { ui: { rerenderMessage(timestamp: number): void } };
			ctx.ui.rerenderMessage(1);
			handled.resolve();
		});
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		expect(cfgTuiMouse.get(mode.settings)).toBe(false);

		appendReply("Early [the early link](demo:early) here.", 1);
		for (let index = 0; index < 40; index++) appendReply(`Filler paragraph ${index}.`, 10 + index);
		appendReply("Late [the late link](demo:late) here.", 2);
		await mode.renderInitialMessages();
		await term.waitFor(() => term.screen().some(row => row.includes("the late link")));
		// The early link has scrolled into terminal scrollback, where no tag can reach it.
		expect(term.screen().some(row => row.includes("the early link"))).toBe(false);

		const resets = vi.spyOn(mode.shell.host!, "replayHistory");
		const hintKey = "\x1bo";
		const screen = () => term.screen();
		// The hint key opens the browser, at the bottom, every link tagged.
		term.feed(hintKey);
		await term.waitFor(() => screen().some(row => row.includes("Extension links")));
		expect(screen().some(row => row.includes("Extension links"))).toBe(true);
		expect(tagDrawnOver("the late link")).toBe(true);
		expect(screen().some(row => row.includes("Early"))).toBe(false);

		// Scrolled to the top, the early link is tagged; typing its tag raises link_activate for it.
		term.feed("\x1b[H");
		await term.waitFor(() => tagDrawnOver("the early link"));
		expect(tagDrawnOver("the early link")).toBe(true);
		term.feed("t");
		await handled.promise;
		expect(activated).toEqual(["demo:early"]);

		// The pick closes the browser; the reply redrawn by the handler (in scrollback) replays history once.
		await term.waitFor(() => !screen().some(row => row.includes("Extension links")));
		expect(transcriptText(mode.shell)).toContain("EXPANDED two.");
		await term.settle();
		expect(resets).toHaveBeenCalledTimes(1);
		expect(mode.shell.focused()).toBe(mode.composer.field);
	});

	it("opens the link browser from the hint key when no extension link is on screen", async () => {
		const statuses: string[] = [];
		const showStatus = mode.showStatus.bind(mode);
		vi.spyOn(mode, "showStatus").mockImplementation((message, options) => {
			statuses.push(message);
			showStatus(message, options);
		});
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		installDemoLinkExtension();
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const screen = () => term.screen();

		// Nothing in the transcript draws a link: the status says so and nothing opens.
		await showReply("Nothing to pick in this reply.", "Nothing to pick");
		term.feed("\x1bo");
		await term.waitFor(() => statuses.includes("No extension links in the transcript"));
		expect(statuses).toContain("No extension links in the transcript");
		expect(mode.shell.overlays.open()).toBe(false);

		appendReply("Early [the early link](demo:early) here.", 1);
		for (let index = 0; index < 40; index++) appendReply(`Filler paragraph ${index}.`, 10 + index);
		await mode.renderInitialMessages();
		await term.waitFor(() => screen().some(row => row.includes("Filler paragraph 39.")));
		expect(screen().some(row => row.includes("the early link"))).toBe(false);
		term.feed("\x1bo");
		await term.waitFor(() => screen().some(row => row.includes("Extension links")));
		expect(screen().some(row => row.includes("Extension links"))).toBe(true);
	});

	it("finds a link an assistant text renderer draws into a reply, once the reply is redrawn with it", async () => {
		const statuses: string[] = [];
		const showStatus = mode.showStatus.bind(mode);
		vi.spyOn(mode, "showStatus").mockImplementation((message, options) => {
			statuses.push(message);
			showStatus(message, options);
		});
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { extension } = installDemoLinkExtension();
		let linked = false;
		extension.assistantTextRenderers.push(({ text, message }) =>
			linked && message.timestamp === 1
				? text.replace("Early reply", "Early [the early link](demo:early)")
				: undefined,
		);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const screen = () => term.screen();
		appendReply("Early reply here.", 1);
		for (let index = 0; index < 20; index++) appendReply(`Filler paragraph ${index}.`, 10 + index);
		await mode.renderInitialMessages();
		await term.waitFor(() => screen().some(row => row.includes("Filler paragraph 19.")));

		// No reply draws a link yet: the hint key says so and opens nothing.
		term.feed("\x1bo");
		await term.waitFor(() => statuses.includes("No extension links in the transcript"));
		expect(mode.shell.overlays.open()).toBe(false);

		// The extension redraws the early reply, now with a link (in scrollback): the key finds it.
		linked = true;
		session.extensionRunner!.getUIContext().rerenderMessage(1);
		term.feed("\x1bo");
		await term.waitFor(() => screen().some(row => row.includes("Extension links")));
		expect(statuses.filter(status => status === "No extension links in the transcript")).toHaveLength(1);
	});

	it("closes the link browser when extension renderers are turned off or the extension is suspended", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { runner } = installDemoLinkExtension();
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const screen = () => term.screen();
		await showReply("See [the late link](demo:late) here.", "the late link");
		const openBrowser = async () => {
			term.feed("\x1bo");
			await term.waitFor(() => tagDrawnOver("the late link"));
			term.feed("\x1bo");
			await term.waitFor(() => screen().some(row => row.includes("Extension links")));
			expect(mode.shell.overlays.open()).toBe(true);
		};
		const expectClosed = async () => {
			await term.waitFor(() => !screen().some(row => row.includes("Extension links")));
			expect(screen().some(row => row.includes("Extension links"))).toBe(false);
			expect(mode.shell.overlays.open()).toBe(false);
			expect(mode.shell.focused()).toBe(mode.composer.field);
		};

		// Suspended live, its renderers and scheme are gone: the browser's copy would draw with them.
		await openBrowser();
		runner.setSuspendedExtensions(() => true);
		await expectClosed();
		runner.setSuspendedExtensions(() => false);
		// Resumed, the reply is rebuilt with its link drawn as a label again.
		await term.waitFor(() => screen().some(row => row.includes("See the late link here.")));

		await openBrowser();
		cfgExtensionAssistantTextRenderers.set(mode.settings, false);
		await expectClosed();
	});

	it("leaves the keys with an overlay drawn over the link browser when the browser closes under it", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { runner } = installDemoLinkExtension();
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const screen = () => term.screen();
		await showReply("See [the late link](demo:late) here.", "the late link");
		term.feed("\x1bo");
		await term.waitFor(() => tagDrawnOver("the late link"));
		term.feed("\x1bo");
		await term.waitFor(() => screen().some(row => row.includes("Extension links")));
		// A link handler's `ctx.ui.custom(…, { overlay: true })` draws over the browser and takes the keys.
		const keys: string[] = [];
		const handle = mode.shell.overlays.show(() => keyCatcher("Handler panel", keys));
		const panel = handle.node;
		expect(mode.shell.focused()).toBe(panel);

		runner.setSuspendedExtensions(() => true);
		await term.waitFor(() => !screen().some(row => row.includes("Extension links")));
		expect(mode.shell.focused()).toBe(panel);
		term.feed("x");
		await term.settle();
		expect(keys).toEqual(["x"]);
		handle.close();
		expect(mode.shell.focused()).toBe(mode.composer.field);
	});

	it("closes the link browser when a picked link's handler opens a dialog, so the dialog gets the keys", async () => {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const { extension } = installDemoLinkExtension();
		const answered = Promise.withResolvers<boolean>();
		extension.handlers.get("link_activate")!.push(async (...args: unknown[]) => {
			const ctx = args[1] as { ui: { confirm(title: string, message: string): Promise<boolean> } };
			answered.resolve(await ctx.ui.confirm("Open the link?", "It goes somewhere."));
		});
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.settle();
		const screen = () => term.screen();
		await showReply("See [the late link](demo:late) here.", "the late link");

		term.feed("\x1bo");
		await term.waitFor(() => tagDrawnOver("the late link"));
		term.feed("\x1bo");
		await term.waitFor(() => screen().some(row => row.includes("Extension links")));
		term.feed("t");
		await term.waitFor(() => screen().some(row => row.includes("Open the link?")));
		expect(screen().some(row => row.includes("Extension links"))).toBe(false);
		expect(mode.shell.overlays.open()).toBe(false);
		// The keys reach the dialog: Enter takes its first choice.
		term.feed("\r");
		expect(await answered.promise).toBe(true);
	});
});
