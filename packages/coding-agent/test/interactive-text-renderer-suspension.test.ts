import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { cfgExtensionAssistantTextRenderers } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal, transcriptText } from "./helpers/mode-terminal";

describe("interactive extension suspension", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-text-renderer-suspension-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = createModeTerminal({ columns: 120, rows: 32 });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, new EventBus(), term.frame);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Start the mode with one extension whose text renderer upper-cases "now", and store a reply. */
	async function initWithShoutingExtension(): Promise<ExtensionRunner> {
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const extension: Extension = {
			path: "/test/shout.ts",
			resolvedPath: "/test/shout.ts",
			handlers: new Map(),
			tools: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: [({ text }) => text.replace("now", "NOW")],
			transcriptPresenters: [],
			linkSchemes: [],
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
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Read this now." }],
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
		return runner;
	}

	const chat = () => transcriptText(mode.shell);

	it("hides only the suspended extension's widgets and restores them on resume", async () => {
		const runtime = new ExtensionRuntime();
		const bus = new EventBus();
		const cwd = tempDir.path();
		let lateUpdate: (() => void) | undefined;
		const widget = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.setWidget("above", ["SUSPEND ABOVE"]);
					ctx.ui.setWidget("below", () => ({ render: () => ["SUSPEND BELOW"] }), { placement: "belowEditor" });
					lateUpdate = () => {
						ctx.ui.setWidget("above", ["LATE UPDATE"]);
						ctx.ui.setWidget("keep", undefined);
					};
				});
			},
			cwd,
			bus,
			runtime,
			path.join(cwd, "widget.ts"),
		);
		const other = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.setWidget("keep", ["KEEP WIDGET"]);
				});
			},
			cwd,
			bus,
			runtime,
			path.join(cwd, "other.ts"),
		);
		const runner = new ExtensionRunner([widget, other], runtime, cwd, session.sessionManager, modelRegistry);
		Object.defineProperty(session, "extensionRunner", { configurable: true, get: () => runner });
		await mode.init({ suppressWelcomeIntro: true });
		const has = (rows: string[], text: string) => rows.some(row => row.includes(text));
		const bothVisible = (rows: string[]) =>
			has(rows, "SUSPEND ABOVE") && has(rows, "SUSPEND BELOW") && has(rows, "KEEP WIDGET");
		await term.waitFor(bothVisible);

		runner.setSuspendedExtensions(extension => extension === widget);
		lateUpdate?.();
		await term.waitFor(
			rows =>
				!has(rows, "SUSPEND ABOVE") &&
				!has(rows, "SUSPEND BELOW") &&
				!has(rows, "LATE UPDATE") &&
				has(rows, "KEEP WIDGET"),
		);

		runner.setSuspendedExtensions(() => false);
		await term.waitFor(bothVisible);
	});

	it("stops drawing with them while suspended, and draws with them again on resume", async () => {
		const runner = await initWithShoutingExtension();
		await mode.renderInitialMessages();
		expect(chat()).toContain("Read this NOW.");

		// A live `disabledExtensions` edit suspends it: the transcript is drawn without its renderer.
		runner.setSuspendedExtensions(() => true);
		// A redraw may be queued as a microtask.
		await Promise.resolve();
		expect(chat()).toContain("Read this now.");

		runner.setSuspendedExtensions(() => false);
		// A redraw may be queued as a microtask.
		await Promise.resolve();
		expect(chat()).toContain("Read this NOW.");
	});

	it("redraws a transcript replay that was building when the extension was suspended", async () => {
		const runner = await initWithShoutingExtension();
		await mode.renderInitialMessages();
		expect(chat()).toContain("Read this NOW.");

		// Suspend after the replay built its components with the renderer, before it commits.
		const renderIncrementally = mode.renderSessionContextIncrementally.bind(mode);
		let suspendAfterPass = true;
		mode.renderSessionContextIncrementally = async (context, options, renderChunk) => {
			await renderIncrementally(context, options, renderChunk);
			if (!suspendAfterPass) return;
			suspendAfterPass = false;
			runner.setSuspendedExtensions(() => true);
		};
		await mode.renderInitialMessages();
		expect(suspendAfterPass).toBe(false);
		expect(chat()).toContain("Read this now.");
		expect(chat()).not.toContain("NOW");
	});
});
