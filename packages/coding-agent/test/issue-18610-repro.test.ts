import { expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { resolveLocalUrlToPath } from "../src/internal-urls";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

test("a dismissed review cannot inject an approved plan after /plan pauses", async () => {
	resetSettingsForTest();
	initTheme();
	const dir = TempDir.createSync("@pi-18610-");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	await Settings.init({ inMemory: true, cwd: dir.path() });
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const messageCounts: number[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: (_model, context) => {
			messageCounts.push(context.messages.length);
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "The plan has two steps." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		},
	});
	const manager = SessionManager.inMemory(dir.path());
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
	});
	const mode = new InteractiveMode(session, "test");
	try {
		await mode.handlePlanModeCommand();
		const planFilePath = mode.planModePlanFilePath;
		if (!planFilePath) throw new Error("Plan mode did not set a plan path");
		await Bun.write(
			resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			}),
			"# Plan\n\nEdit files to answer a question.",
		);
		let overlay: PlanReviewOverlay | undefined;
		const show = mode.ui.showOverlay.bind(mode.ui);
		vi.spyOn(mode.ui, "showOverlay").mockImplementation((component, options) => {
			if (component instanceof PlanReviewOverlay) overlay = component;
			return show(component, options);
		});
		const opened = Promise.withResolvers<void>();
		const review = mode.handlePlanApproval(
			{ planFilePath, planExists: true, title: "Plan" },
			{ abortTurn: false, onOpened: () => opened.resolve() },
		);
		await opened.promise;
		if (!overlay) throw new Error("Plan review did not open");
		overlay.handleInput("\x03");
		await review;
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.handlePlanModeCommand();
		await session.prompt("What does the second step mean?");
		expect(manager.buildSessionContext().mode).toBe("plan_paused");
		expect(messageCounts).toEqual([1]);
	} finally {
		mode.stop();
		await session.dispose();
		auth.close();
		dir.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	}
});

test("pausing plan mode closes an open review so it cannot approve the paused plan", async () => {
	resetSettingsForTest();
	initTheme();
	const dir = TempDir.createSync("@pi-18610-open-review-");
	await Settings.init({ inMemory: true, cwd: dir.path() });
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const manager = SessionManager.inMemory(dir.path());
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	const mode = new InteractiveMode(session, "test");
	try {
		await mode.handlePlanModeCommand();
		const planFilePath = mode.planModePlanFilePath;
		if (!planFilePath) throw new Error("Plan mode did not set a plan path");
		await Bun.write(
			resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			}),
			"# Plan\n\nEdit files.",
		);
		let overlay: PlanReviewOverlay | undefined;
		const show = mode.ui.showOverlay.bind(mode.ui);
		vi.spyOn(mode.ui, "showOverlay").mockImplementation((component, options) => {
			if (component instanceof PlanReviewOverlay) overlay = component;
			return show(component, options);
		});
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		const opened = Promise.withResolvers<void>();
		const review = mode.handlePlanApproval(
			{ planFilePath, planExists: true, title: "Plan" },
			{ abortTurn: false, onOpened: () => opened.resolve() },
		);
		await opened.promise;
		if (!overlay) throw new Error("Plan review did not open");

		await mode.handlePlanModeCommand();
		// A late Enter on the stale review would otherwise pick "Approve and execute".
		overlay.handleInput("\r");
		await review;

		expect(mode.planModePaused).toBe(true);
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
	} finally {
		mode.stop();
		await session.dispose();
		auth.close();
		dir.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	}
});
