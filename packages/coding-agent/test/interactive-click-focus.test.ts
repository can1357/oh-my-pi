import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { cfgExtensionAssistantTextRenderers } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

describe("inline click-to-focus geometry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let eventBus: EventBus;
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
		term = new VirtualTerminal(120, 32);
		eventBus = new EventBus();
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, eventBus, composer);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("maps a painted live task row back to its agent id", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const card = new ToolExecutionComponent(
			"task",
			{},
			{},
			undefined,
			{
				requestRender: () => mode.ui.requestRender(),
				requestComponentRender: () => {},
				resetDisplay: () => {},
			},
			tempDir.path(),
		);
		mode.chatContainer.addChild(card);
		const progress: AgentProgress = {
			index: 0,
			id: "ClickWorker",
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
		);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("ClickWorker")));

		// Screen row (0-based from the top) into mutable-viewport coordinates,
		// exactly as the SGR click router computes it.
		const viewport = plainRows(term.getViewport());
		const screenRow = viewport.findIndex(row => row.includes("ClickWorker"));
		expect(screenRow).toBeGreaterThanOrEqual(0);
		const top = mode.ui.getMutableViewport().top;
		expect(mode.resolveViewportClickCandidates(screenRow - top)).toEqual(["ClickWorker"]);

		// Chrome rows (the status line at the bottom) name no agent.
		expect(mode.resolveViewportClickCandidates(viewport.length - 1 - top)).toEqual([]);
	});

	it("bands the hovered live card and clears it off-target", async () => {
		cfgTuiMouse.set(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const card = new ToolExecutionComponent(
			"task",
			{},
			{},
			undefined,
			{
				requestRender: () => mode.ui.requestRender(),
				requestComponentRender: () => {},
				resetDisplay: () => {},
			},
			tempDir.path(),
		);
		mode.chatContainer.addChild(card);
		card.updateResult(
			{
				content: [{ type: "text", text: "Running 1 agent..." }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 1,
					progress: [
						{
							index: 0,
							id: "HoverWorker",
							agent: "task",
							agentSource: "bundled",
							status: "running",
							task: "hoverable work",
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							requests: 1,
							tokens: 0,
							cost: 0,
							durationMs: 0,
						},
					],
				},
			},
			true,
		);
		mode.ui.requestRender();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("HoverWorker")));

		const workerBg = (): number[] | undefined => {
			const rows = plainRows(term.getViewport());
			const row = rows.findIndex(line => line.includes("HoverWorker"));
			return row < 0 ? undefined : term.getViewportRowBackgroundValues(row);
		};
		const changed = (snapshot: number[] | undefined): boolean => {
			const now = workerBg();
			return now !== undefined && JSON.stringify(now) !== JSON.stringify(snapshot);
		};
		// Settle on a fresh frame so spans match the painted rows, then snapshot.
		mode.ui.requestRender();
		await term.waitForRender();
		const before = workerBg();
		expect(before).toBeDefined();
		// Motion is single-shot against the last painted spans, which can lag
		// one frame behind a just-mounted card: force a fresh frame, re-locate
		// by content, and retry until the band lands. The final expect still
		// fails loudly when nothing ever paints.
		for (let attempt = 0; attempt < 20; attempt++) {
			mode.ui.requestRender();
			await term.waitForRender();
			const rows = plainRows(term.getViewport());
			const row = rows.findIndex(line => line.includes("HoverWorker"));
			expect(row).toBeGreaterThanOrEqual(0);
			term.sendInput(`\x1b[<32;5;${row + 1}M`);
			await term.waitForRender(() => changed(before));
			if (changed(before)) break;
			if (attempt === 19) expect(changed(before)).toBe(true);
		}

		// Motion over the card bands its row.
		expect(changed(before)).toBe(true);

		// The live composer frame itself carries the band while hovered.
		const frame = mode.composer.renderFrame({ columns: 120, rows: 32 });
		expect(frame.viewport.filter(line => line.includes("\x1b[48")).length).toBeGreaterThan(0);

		// Disabling capture mid-hover clears the controller cache too: after
		// re-enabling, motion over the same card must restore the band instead
		// of looking unchanged and skipping the repaint.
		cfgTuiMouse.set(mode.settings, false);
		mode.ui.requestRender();
		await term.waitForRender(() => !changed(before));
		expect(workerBg()).toEqual(before);

		cfgTuiMouse.set(mode.settings, true);
		mode.ui.requestRender();
		await term.waitForRender();
		const cardRow = plainRows(term.getViewport()).findIndex(line => line.includes("HoverWorker"));
		expect(cardRow).toBeGreaterThanOrEqual(0);
		term.sendInput(`\x1b[<32;5;${cardRow + 1}M`);
		await term.waitForRender(() => changed(before));
		expect(changed(before)).toBe(true);

		// Moving onto the status line restores the exact prior colors.
		const bottomRow = term.getViewport().length - 1;
		term.sendInput(`\x1b[<32;5;${bottomRow + 1}M`);
		await term.waitForRender(() => !changed(before));
		expect(workerBg()).toEqual(before);
	});

	it("expands and collapses the pinned jump list through SGR clicks", async () => {
		cfgTuiMouse.set(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

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
			await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes(marker)));
			const viewport = plainRows(term.getViewport());
			const screenRow = viewport.findIndex(row => row.includes(marker));
			expect(screenRow).toBeGreaterThanOrEqual(0);
			term.sendInput(`\x1b[<0;5;${screenRow + 1}M`);
		};

		// Collapsed by default: three rows plus the expander.
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("more — expand")));
		expect(plainRows(term.getViewport()).some(row => row.includes("ToggleAgent3"))).toBe(false);

		// Clicking the expander paints the slotted window with a collapse row.
		await clickRow("more — expand");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("show less")));
		expect(plainRows(term.getViewport()).some(row => row.includes("ToggleAgent4"))).toBe(true);
		// Clicking it again collapses back to a few rows.
		await clickRow("show less");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("more — expand")));
		expect(plainRows(term.getViewport()).some(row => row.includes("ToggleAgent3"))).toBe(false);
	});

	it("hands a click on an extension-owned link to its extension once tui.mouse turns on, other links unchanged", async () => {
		const statuses: string[] = [];
		const showStatus = mode.showStatus.bind(mode);
		vi.spyOn(mode, "showStatus").mockImplementation((message, options) => {
			statuses.push(message);
			showStatus(message, options);
		});
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const clicks: string[] = [];
		const clicked = Promise.withResolvers<void>();
		const handlers: Extension["handlers"] = new Map();
		handlers.set("link_activate", [
			async (...args: unknown[]) => {
				const [event] = args;
				if (event && typeof event === "object" && "url" in event && typeof event.url === "string") {
					clicks.push(event.url);
				}
				clicked.resolve();
			},
		]);
		const extension: Extension = {
			path: "/test/links.ts",
			resolvedPath: "/test/links.ts",
			handlers,
			tools: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: [],
			linkSchemes: ["demo"],
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
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		session.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Open [the details](demo:open/7) or read [the docs](https://example.com/docs)." },
			],
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
		const written: string[] = [];
		const write = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			written.push(data);
			write(data);
		});
		await mode.renderInitialMessages();
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("the details")));
		// With tui.mouse off the claimed link is inert, and omp says how to enable it, once.
		expect(statuses.filter(message => message.includes("tui.mouse"))).toHaveLength(1);
		// Turning click routing on mid-session redraws the reply so its link can be hit.
		cfgTuiMouse.set(mode.settings, true);
		await term.waitForRender();
		cfgTuiMouse.set(mode.settings, false);
		await term.waitForRender();
		cfgTuiMouse.set(mode.settings, true);
		await term.waitForRender();
		expect(statuses.filter(message => message.includes("tui.mouse"))).toHaveLength(1);
		// The terminal never receives the extension URL, so it has no hyperlink of its own to open.
		expect(written.join("")).not.toContain("demo:open/7");
		expect(written.join("")).toContain("https://example.com/docs");
		const viewport = plainRows(term.getViewport());
		const screenRow = viewport.findIndex(row => row.includes("the details"));
		// The extension link draws without its URL; the web link keeps the suffix.
		expect(viewport[screenRow]).not.toContain("demo:open/7");
		expect(viewport[screenRow]).toContain("the docs (https://example.com/docs)");

		const click = (label: string) =>
			term.sendInput(`\x1b[<0;${viewport[screenRow]!.indexOf(label) + 2};${screenRow + 1}M`);
		// A click on the web link raises nothing; the extension link's click reaches its extension.
		click("the docs");
		click("the details");
		await clicked.promise;
		expect(clicks).toEqual(["demo:open/7"]);

		// Hovering the extension link asks for a hand pointer; moving off it restores the default.
		const move = (col: number) => term.sendInput(`\x1b[<35;${col + 1};${screenRow + 1}M`);
		written.length = 0;
		move(viewport[screenRow]!.indexOf("the details") + 1);
		await term.waitForRender();
		expect(written.join("")).toContain("\x1b]22;pointer\x1b\\");
		written.length = 0;
		move(viewport[screenRow]!.indexOf("the docs") + 1);
		await term.waitForRender();
		expect(written.join("")).toContain("\x1b]22;default\x1b\\");
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
			linkSchemes: ["demo"],
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
		await term.waitForRender();
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
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("the details")));
		const viewport = plainRows(term.getViewport());
		const screenRow = viewport.findIndex(row => row.includes("the details"));
		term.sendInput(`\x1b[<0;${viewport[screenRow]!.indexOf("the details") + 2};${screenRow + 1}M`);
		await handled.promise;
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("OPENED")));
		expect(plainRows(term.getViewport()).some(row => row.includes("Open OPENED now."))).toBe(true);
	});
});
