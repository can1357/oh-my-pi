/**
 * Contract: exiting plan mode while a model turn is streaming interrupts that
 * turn immediately, rather than only affecting the next turn.
 *
 * Regression for #9699: `#enterPlanMode` steers a fresh plan context into a live
 * turn, but `#exitPlanMode` used to clear state without touching the in-flight
 * turn. The turn-start `plan-mode-active.md` block orders the model to keep
 * planning until it writes a plan, so a mid-turn user exit appeared to do nothing
 * — the agent kept acting in plan mode until it produced a plan. Exit must now
 * abort the streaming turn (mirroring `#exitVibeMode`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("InteractiveMode plan mode exit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let streamFn: StreamFn | undefined;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-plan-exit-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		// prompt() preflights credentials via modelRegistry.getApiKey; the in-memory
		// auth storage has no anthropic key, so stub it.
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		streamFn = undefined;
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (...args) => {
					if (!streamFn) throw new Error("No test stream configured");
					return streamFn(...args);
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("aborts the in-flight turn when exited mid-stream", async () => {
		const started = Promise.withResolvers<void>();
		let abortReason: unknown;
		streamFn = (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				options?.signal?.addEventListener(
					"abort",
					() => {
						abortReason = options.signal?.reason;
						stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
					},
					{ once: true },
				);
				started.resolve();
			});
			return stream;
		};

		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		const prompt = session.prompt("Investigate and plan");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		// Exit plan mode while the turn is still streaming.
		await mode.handlePlanModeCommand();
		await prompt;

		expect(mode.planModeEnabled).toBe(false);
		expect(session.isStreaming).toBe(false);
		expect(session.getPlanModeState()).toBeUndefined();
		expect(abortReason).toBe(USER_INTERRUPT_LABEL);
	});
});
