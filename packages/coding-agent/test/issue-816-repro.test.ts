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

describe("issue #816 — plan mode pendingModelSwitch leak", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-816-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
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

	it("does not switch to the plan-role model after exit when the entry switch was deferred by streaming", async () => {
		const planModel = modelRegistry.find("anthropic", "claude-haiku-4-5");
		if (!planModel) throw new Error("Expected claude-haiku-4-5 in registry");

		// Stream is active throughout entry: #applyPlanModeModel snapshots the
		// previous (default) model and queues a pending switch to the plan model
		// instead of applying it immediately.
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		// Avoid kicking off real session work during plan mode entry.
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);

		const setModelSpy = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);

		// Enter plan mode → snapshots default, queues pending switch to plan model.
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		// User confirms exit (e.g., approves plan / pauses plan mode).
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);

		// Stream ends → event-controller flushes any queued model switch.
		await mode.flushPendingModelSwitch();

		// Contract: the deferred plan-role switch must be discarded on exit.
		// Otherwise the next user turn lands on the plan-role model even though
		// the user is no longer in plan mode.
		expect(setModelSpy).not.toHaveBeenCalled();
	});

	it("discards a deferred plan-role change when the role returns to the active model", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handlePlanModeCommand();
		const activePlanModel = session.model;
		const haiku = modelRegistry.find("anthropic", "claude-haiku-4-5");
		const opus = modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!activePlanModel || !haiku || !opus) throw new Error("Expected plan models");
		const replacementPlanModel =
			activePlanModel.provider === haiku.provider && activePlanModel.id === haiku.id ? opus : haiku;

		let isStreaming = false;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => isStreaming });

		isStreaming = true;
		session.settings.setModelRole("plan", `${replacementPlanModel.provider}/${replacementPlanModel.id}`);
		session.settings.setModelRole("plan", `${activePlanModel.provider}/${activePlanModel.id}`);
		isStreaming = false;

		const setModelSpy = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);
		await mode.flushPendingModelSwitch();

		expect(setModelSpy).not.toHaveBeenCalled();
	});

	it("applies a plan-role reassignment to an active plan session", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handlePlanModeCommand();
		const activePlanModel = session.model;
		const haiku = modelRegistry.find("anthropic", "claude-haiku-4-5");
		const opus = modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!activePlanModel || !haiku || !opus) throw new Error("Expected plan models");
		const replacementPlanModel =
			activePlanModel.provider === haiku.provider && activePlanModel.id === haiku.id ? opus : haiku;

		const setModelSpy = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);
		session.settings.setModelRole("plan", `${replacementPlanModel.provider}/${replacementPlanModel.id}`);
		await Promise.resolve();

		expect(setModelSpy).toHaveBeenCalledWith(replacementPlanModel, undefined);
	});

	it("keeps plan state coherent when restoring the previous model fails", async () => {
		const planModel = modelRegistry.find("anthropic", "claude-haiku-4-5");
		if (!planModel) throw new Error("Expected claude-haiku-4-5 in registry");

		vi.spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);
		const setModelSpy = vi.spyOn(session, "setModelTemporary");

		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		expect(session.getPlanModeState()?.enabled).toBe(true);

		setModelSpy.mockRejectedValueOnce(new Error("model restore failed"));
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await expect(mode.handlePlanModeCommand()).rejects.toThrow("model restore failed");

		expect(mode.planModeEnabled).toBe(true);
		expect(session.getPlanModeState()?.enabled).toBe(true);
	});

	it("does not enter plan mode when plan.enabled is false", async () => {
		session.settings.set("plan.enabled", false);
		const warning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(false);
		expect(warning).toHaveBeenCalledWith("Plan mode is disabled. Enable it in settings (plan.enabled).");
	});

	it("allows /plan to pause an active plan mode after plan.enabled is disabled", async () => {
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		session.settings.set("plan.enabled", false);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);

		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(true);
	});
});
