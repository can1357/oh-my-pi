/**
 * Contract: once plan mode is toggled off into the *paused* state, the guards
 * that block goal/vibe entry must say the plan session is paused (and how to
 * fully exit) rather than the stale "Exit plan mode first." — which reads as
 * self-contradictory right after the user just exited plan mode (#11692).
 *
 * While the plan session is still *active*, the guard keeps the original
 * "Exit plan mode first." wording.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("InteractiveMode paused-plan guard message", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-plan-paused-guard-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: () => {
					throw new Error("No test stream configured");
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

	it("warns that plan mode is paused (not 'Exit plan mode first.') when a paused session blocks vibe/goal", async () => {
		// Enter plan mode, then toggle off — no draft content, so this pauses.
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(true);

		const warn = vi.spyOn(mode, "showWarning");

		await mode.handleVibeModeCommand();
		await mode.handleGoalModeCommand();

		// Both the /vibe and /goal guards fired; a paused blocker must name the
		// paused state and point at /plan recovery — not the active-mode exit copy.
		const messages = warn.mock.calls.map(call => String(call[0]));
		expect(messages).toHaveLength(2);
		for (const message of messages) {
			expect(message.toLowerCase()).toContain("paused");
			expect(message).toContain("/plan");
		}
	});

	it("keeps 'Exit plan mode first.' while the plan session is still active", async () => {
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		const warn = vi.spyOn(mode, "showWarning");

		await mode.handleVibeModeCommand();

		// Active session: instruct exit, without the paused wording.
		const messages = warn.mock.calls.map(call => String(call[0]));
		expect(messages).toHaveLength(1);
		expect(messages[0].toLowerCase()).toContain("exit plan mode");
		expect(messages[0].toLowerCase()).not.toContain("paused");
	});
});
