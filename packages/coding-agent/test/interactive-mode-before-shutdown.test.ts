import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeShutdownEvent,
	SessionBeforeShutdownResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode pre-quit extension gate", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let beforeShutdown: ExtensionHandler<SessionBeforeShutdownEvent, SessionBeforeShutdownResult>;
	let attempts: number;
	let laterHandlers: number;
	let shutdownEvents: number;
	let metadataAtShutdown: unknown;
	let quitCalled: { promise: Promise<void>; resolve: () => void };

	beforeAll(() => initTheme());

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-before-shutdown-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		beforeShutdown = () => undefined;
		attempts = 0;
		laterHandlers = 0;
		shutdownEvents = 0;
		metadataAtShutdown = undefined;
		quitCalled = Promise.withResolvers<void>();
		const handlers: Extension["handlers"] = new Map();
		handlers.set("session_before_shutdown", [
			async (...args: unknown[]) => {
				attempts++;
				return beforeShutdown(args[0] as SessionBeforeShutdownEvent, args[1] as ExtensionContext);
			},
			async () => {
				laterHandlers++;
			},
		]);
		handlers.set("session_shutdown", [
			async () => {
				shutdownEvents++;
				for (const entry of session.sessionManager.getEntries()) {
					if (entry.type === "custom" && entry.customType === "exit-metadata") metadataAtShutdown = entry.data;
				}
			},
		]);
		const extension: Extension = {
			path: "/test/before-shutdown.ts",
			resolvedPath: "/test/before-shutdown.ts",
			handlers,
			tools: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: [],
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
		const manager = SessionManager.inMemory(tempDir.path());
		const runner = new ExtensionRunner([extension], new ExtensionRuntime(), tempDir.path(), manager, modelRegistry);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: runner,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};
		vi.spyOn(postmortem, "quit").mockImplementation(async () => {
			quitCalled.resolve();
		});
		await mode.initHooksAndCustomTools();
	});

	afterEach(async () => {
		mode.stop();
		await session.dispose();
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("keeps the session alive for a metadata prompt and records the answer before shutdown notification", async () => {
		const entered = Promise.withResolvers<void>();
		beforeShutdown = async (_event, ctx) => {
			const answer = ctx.ui.input("Session outcome");
			entered.resolve();
			const goal = await answer;
			if (goal !== undefined) session.sessionManager.appendCustomEntry("exit-metadata", { goal });
		};
		const quitting = mode.shutdown();
		await entered.promise;
		expect(mode.isAwaitingShutdown).toBe(true);
		expect(mode.isShuttingDown).toBe(false);
		expect(session.isDisposed).toBe(false);
		expect(shutdownEvents).toBe(0);
		expect(postmortem.quit).not.toHaveBeenCalled();
		const prompt = mode.hookInput;
		if (!prompt) throw new Error("metadata input was not presented");
		prompt.handleInput("reached");
		prompt.handleInput("\r");
		await quitting;
		expect(metadataAtShutdown).toEqual({ goal: "reached" });
		expect(session.isDisposed).toBe(true);
		expect(shutdownEvents).toBe(1);
		expect(postmortem.quit).toHaveBeenCalledTimes(1);
	});

	it("cancels before disposal and permits a later quit attempt", async () => {
		beforeShutdown = () => (attempts === 1 ? { cancel: true } : undefined);
		mode.shutdownRequested = true;
		await mode.shutdown();
		expect(session.isDisposed).toBe(false);
		expect(mode.isAwaitingShutdown).toBe(false);
		expect(mode.isShuttingDown).toBe(false);
		expect(mode.shutdownRequested).toBe(false);
		expect(laterHandlers).toBe(0);
		expect(shutdownEvents).toBe(0);
		expect(postmortem.quit).not.toHaveBeenCalled();
		await mode.shutdown();
		expect(attempts).toBe(2);
		expect(laterHandlers).toBe(1);
		expect(session.isDisposed).toBe(true);
		expect(shutdownEvents).toBe(1);
		expect(postmortem.quit).toHaveBeenCalledTimes(1);
	});

	it("does not duplicate or bypass an in-flight quit on overlapping shutdown calls", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		beforeShutdown = async () => {
			entered.resolve();
			await release.promise;
		};
		const quitting = mode.shutdown();
		await entered.promise;
		await mode.shutdown();
		expect(attempts).toBe(1);
		expect(session.isDisposed).toBe(false);
		expect(postmortem.quit).not.toHaveBeenCalled();
		release.resolve();
		await quitting;
		expect(shutdownEvents).toBe(1);
		expect(postmortem.quit).toHaveBeenCalledTimes(1);
	});

	it.each(["bypass", "emergency exit"] as const)(
		"allows %s before a focused custom component can capture the key",
		async action => {
			new InputController(mode).setupKeyHandlers();
			const presented = Promise.withResolvers<void>();
			const captured: string[] = [];
			let disposed = 0;
			const component = {
				render: () => ["Custom exit prompt"],
				capturesInput: () => true,
				handleInput: (data: string) => captured.push(data),
				dispose: () => {
					disposed++;
				},
			};
			beforeShutdown = async (_event, ctx) => {
				await ctx.ui.custom(() => {
					presented.resolve();
					return component;
				});
			};
			const quitting = mode.shutdown();
			await presented.promise;
			await Promise.resolve();
			await Promise.resolve();
			expect(mode.ui.getFocused()).toBe(component);
			mode.ui.injectDebugInput("x");
			expect(captured).toEqual(["x"]);

			if (action === "bypass") {
				mode.ui.injectDebugInput("\x04");
				expect(captured).toEqual(["x"]);
				await quitting;
				expect(session.isDisposed).toBe(true);
				expect(shutdownEvents).toBe(1);
				expect(postmortem.quit).toHaveBeenCalledTimes(1);
			} else {
				const exit = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => {
					throw new Error("emergency exit");
				});
				expect(() => mode.ui.injectDebugInput("\x03")).toThrow("emergency exit");
				expect(exit).toHaveBeenCalledWith(130);
				expect(captured).toEqual(["x"]);
				mode.stop();
				await quitting;
				expect(shutdownEvents).toBe(0);
				expect(postmortem.quit).not.toHaveBeenCalled();
			}
			expect(disposed).toBe(1);
		},
	);

	it("bypasses an uncooperative handler on further Ctrl+D and still performs normal teardown", async () => {
		const entered = Promise.withResolvers<AbortSignal>();
		const late = Promise.withResolvers<SessionBeforeShutdownResult>();
		beforeShutdown = async event => {
			entered.resolve(event.signal);
			return late.promise;
		};
		const quitting = mode.shutdown();
		const signal = await entered.promise;
		mode.handleCtrlD();
		await quitting;
		expect(signal.aborted).toBe(true);
		expect(laterHandlers).toBe(0);
		expect(session.isDisposed).toBe(true);
		expect(shutdownEvents).toBe(1);
		expect(postmortem.quit).toHaveBeenCalledTimes(1);
		late.resolve({ cancel: true });
	});

	it("does not prompt for extension-requested shutdown", async () => {
		mode.requestShutdown();
		await quitCalled.promise;
		expect(attempts).toBe(0);
		expect(session.isDisposed).toBe(true);
		expect(shutdownEvents).toBe(1);
	});

	it("abandons a pending quit when its interactive UI stops", async () => {
		const entered = Promise.withResolvers<void>();
		beforeShutdown = async (_event, ctx) => {
			const answer = ctx.ui.input("Session outcome");
			entered.resolve();
			await answer;
		};
		const quitting = mode.shutdown();
		await entered.promise;
		mode.stop();
		await quitting;
		expect(session.isDisposed).toBe(false);
		expect(mode.hookInput).toBeUndefined();
		expect(shutdownEvents).toBe(0);
		expect(postmortem.quit).not.toHaveBeenCalled();
	});
});
