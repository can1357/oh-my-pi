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
 *
 * Contract: `/plan` cycles plan → plan_paused → none. Three consecutive
 * invocations from a fresh session land on `enabled=false, paused=false` with a
 * `mode_change` to `"none"`, so mode-gated commands such as `/goal` unblock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";
import { key, sendKey } from "./ui/composer/harness";

describe("InteractiveMode plan mode exit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let streamFn: StreamFn | undefined;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		initTheme();
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
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			new EventBus(),
			createModeTerminal().frame,
		);
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

	it("restores a stashed draft after a local /plan exit", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handlePlanModeCommand();
		mode.composer.setText("saved draft");
		sendKey(mode.composer.node, mode.composer.field, key("\x13"));
		mode.composer.setText("/plan exit");
		mode.composer.setText(""); // Enter detaches the submitted text before onSubmit.

		await mode.composer.onSubmit?.("/plan exit");

		expect(mode.planModeEnabled).toBe(false);
		expect(mode.composer.text()).toBe("saved draft");
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

	it("third /plan returns the session to mode 'none' instead of re-entering plan", async () => {
		// First /plan → enter plan mode.
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		expect(mode.planModePaused).toBe(false);
		expect(session.sessionManager.buildSessionContext().mode).toBe("plan");

		// Second /plan → pause (PLAN.md is empty so no confirm prompt).
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(true);
		expect(session.sessionManager.buildSessionContext().mode).toBe("plan_paused");

		// Third /plan → fully disable instead of cycling back into plan mode.
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(false);
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	it("after exiting through paused, /plan starts a fresh plan session (not a re-entry)", async () => {
		await mode.handlePlanModeCommand(); // enter
		await mode.handlePlanModeCommand(); // pause
		await mode.handlePlanModeCommand(); // off — clears the reentry marker

		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		// `reentry` mirrors `#planModeHasEntered`. The fresh /plan after a full
		// exit should look like a first entry, not a resume, so plan-mode prompts
		// don't read "you're back in plan mode" on what is logically a new run.
		expect(session.getPlanModeState()?.reentry).toBe(false);
	});

	it("allows /plan to pause an active plan mode after plan.enabled is disabled", async () => {
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		cfgPlanEnabled.set(session.settings, false);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);

		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(true);
	});
});
