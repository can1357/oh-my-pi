import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Issue #2510 — `/plan` only cycled between `plan` and `plan_paused`, never
 * returning to `none`. That left `/goal` and any other mode-gated command
 * permanently blocked because `planModePaused` stayed true.
 *
 * Contract: three consecutive `/plan` invocations from a fresh session must
 * land on `enabled=false, paused=false` and append a `mode_change` to `"none"`.
 */
describe("issue #2510 — /plan toggles plan → plan_paused → none", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-2510-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: defaultModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		HistoryStorage.close();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
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

		// Third /plan → fully disable. Pre-fix this re-entered plan mode and the
		// session cycled forever between plan ↔ plan_paused.
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
});
