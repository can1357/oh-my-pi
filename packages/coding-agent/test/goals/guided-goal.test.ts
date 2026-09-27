import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

type GuidedGoalHarness = {
	mode: InteractiveMode;
	session: AgentSession;
	settings: Settings;
	goalTool: GoalTool;
	tempDir: TempDir;
	cleanup: () => Promise<void>;
};

async function createHarness(options?: { goalEnabled?: boolean }): Promise<GuidedGoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-guided-goal-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": options?.goalEnabled ?? true,
		"plan.enabled": true,
	});
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	const initialTools = await createTools(createToolSession(tempDir.path(), settings), ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	// Mirror sdk.ts assembly: the goal tool is pre-registered (hidden) whenever
	// goal.enabled, so /guided-goal can activate it by name for the interview.
	const goalToolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
	});
	const goalTool = new GoalTool(goalToolSession);
	toolRegistry.set("goal", goalTool as unknown as Tool);
	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	mode.ui.requestRender = vi.fn();
	return {
		mode,
		session,
		settings,
		goalTool,
		tempDir,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
			resetSettingsForTest();
		},
	};
}

function assistantTurn(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Start the mode so it subscribes to session events, then kick off an interview. */
async function startInterview(harness: GuidedGoalHarness): Promise<void> {
	vi.spyOn(vcs, "repo").mockReturnValue(null);
	vi.spyOn(vcs, "git").mockReturnValue(null);
	await harness.mode.init({ suppressWelcomeIntro: true });
	vi.spyOn(harness.session, "prompt").mockResolvedValue(true);
	await harness.mode.handleGuidedGoalCommand("ship it");
}

/** Emit `agent_end` and resolve once the session has delivered it to subscribers (the mode included). */
async function endTurn(harness: GuidedGoalHarness, messages: AgentMessage[]): Promise<void> {
	const delivered = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe(event => {
		if (event.type === "agent_end") delivered.resolve();
	});
	try {
		harness.session.agent.emitExternalEvent({ type: "agent_end", messages });
		await delivered.promise;
	} finally {
		unsubscribe();
	}
}

describe("guided goal setup", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("kicks off the interview as a hidden developer prompt and exposes the goal tool", async () => {
		const harness = await createHarness();
		try {
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);
			const images: ImageContent[] = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];

			await harness.mode.handleGuidedGoalCommand("automate flaky test triage", {
				images,
				imageLinks: ["file:///shot.png"],
			});

			expect(promptSpy).toHaveBeenCalledTimes(1);
			const [text, promptOptions] = promptSpy.mock.calls[0]!;
			expect(promptOptions).toEqual({ synthetic: true, images, onAccepted: undefined });
			// The rough objective rides inside the kickoff, and the kickoff tells the
			// agent how to finish: `goal` tool, op create.
			expect(text).toContain("automate flaky test triage");
			expect(text).toContain('op: "create"');
			// The goal tool is activated up front so the agent can create the goal
			// once the interview concludes.
			expect(harness.session.getEnabledToolNames()).toContain("goal");
		} finally {
			await harness.cleanup();
		}
	});

	it("asks the agent to elicit the objective when no rough goal is given", async () => {
		const harness = await createHarness();
		try {
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			await harness.mode.handleGuidedGoalCommand();

			expect(promptSpy).toHaveBeenCalledTimes(1);
			const [text] = promptSpy.mock.calls[0]!;
			expect(text).not.toContain("<rough-goal>");
		} finally {
			await harness.cleanup();
		}
	});

	it("queues the kickoff as a synthetic follow-up while the agent is streaming", async () => {
		const harness = await createHarness();
		try {
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);
			const followUp = vi.spyOn(harness.session, "followUp").mockResolvedValue();

			await harness.mode.handleGuidedGoalCommand("ship it");

			expect(promptSpy).not.toHaveBeenCalled();
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(followUp.mock.calls[0]?.[2]).toEqual({ synthetic: true, onAccepted: undefined });
		} finally {
			await harness.cleanup();
		}
	});

	it("falls back to a synthetic follow-up when the prompt races an in-flight run", async () => {
		const harness = await createHarness();
		try {
			vi.spyOn(harness.session, "prompt").mockRejectedValue(new AgentBusyError());
			const followUp = vi.spyOn(harness.session, "followUp").mockResolvedValue();

			await harness.mode.handleGuidedGoalCommand("ship it");

			expect(followUp).toHaveBeenCalledTimes(1);
			expect(followUp.mock.calls[0]?.[2]).toEqual({ synthetic: true, onAccepted: undefined });
		} finally {
			await harness.cleanup();
		}
	});

	it("restores the stashed composer as soon as the kickoff is accepted, before its turn completes", async () => {
		const harness = await createHarness();
		try {
			await harness.mode.init({ suppressWelcomeIntro: true });
			const savedImage: ImageContent = { type: "image", data: "c2F2ZWQ=", mimeType: "image/png" };
			const submittedImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
			harness.mode.editor.pendingImages = [savedImage];
			harness.mode.editor.pendingImageLinks = ["file:///saved.png"];
			harness.mode.editor.setText("saved [Image #1]");
			harness.mode.editor.handleInput("\x13");
			harness.mode.editor.pendingImages = [submittedImage];
			harness.mode.editor.pendingImageLinks = ["file:///submitted.png"];
			harness.mode.editor.setText("/guided-goal ship [Image #1]");

			const accepted = Promise.withResolvers<void>();
			const turn = Promise.withResolvers<void>();
			const promptSpy = vi.spyOn(harness.session, "prompt").mockImplementation(async (_text, options) => {
				expect(harness.mode.editor.getText()).toBe("");
				expect(harness.mode.editor.pendingImages).toEqual([]);
				expect(options?.images).toEqual([submittedImage]);
				options?.onAccepted?.();
				accepted.resolve();
				await turn.promise;
				return true;
			});
			const submission = harness.mode.editor.onSubmit?.("/guided-goal ship [Image #1]");
			await accepted.promise;
			expect(harness.mode.editor.getText()).toBe("saved [Image #1]");
			expect(harness.mode.editor.pendingImages).toEqual([savedImage]);
			expect(harness.mode.editor.pendingImageLinks).toEqual(["file:///saved.png"]);
			turn.resolve();
			await submission;
			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(harness.mode.editor.getText()).toBe("saved [Image #1]");
		} finally {
			await harness.cleanup();
		}
	});

	it("retains a rejected guided-goal attempt without consuming the stash", async () => {
		const harness = await createHarness();
		try {
			await harness.mode.init({ suppressWelcomeIntro: true });
			harness.mode.editor.setText("saved draft");
			harness.mode.editor.handleInput("\x13");
			harness.mode.editor.setText("/guided-goal ship");
			const pending = Promise.withResolvers<boolean>();
			vi.spyOn(harness.session, "prompt").mockImplementation(() => pending.promise);
			const submission = harness.mode.editor.onSubmit?.("/guided-goal ship");
			expect(harness.mode.editor.getText()).toBe("");
			pending.resolve(false);
			await submission;
			expect(harness.mode.editor.getText()).toBe("/guided-goal ship");
			harness.mode.editor.clearDraft();
			harness.mode.editor.handleInput("\x13");
			expect(harness.mode.editor.getText()).toBe("saved draft");
		} finally {
			await harness.cleanup();
		}
	});

	it("restores the stash immediately after a streaming kickoff is queued", async () => {
		const harness = await createHarness();
		try {
			await harness.mode.init({ suppressWelcomeIntro: true });
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			harness.mode.editor.setText("saved draft");
			harness.mode.editor.handleInput("\x13");
			harness.mode.editor.setText("/guided-goal ship");
			await harness.mode.editor.onSubmit?.("/guided-goal ship");
			expect(harness.session.agent.peekFollowUpQueue()).toHaveLength(1);
			expect(harness.mode.editor.getText()).toBe("saved draft");
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps the attempted slash command and stash when a streaming kickoff fails to enqueue", async () => {
		const harness = await createHarness();
		try {
			await harness.mode.init({ suppressWelcomeIntro: true });
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			harness.mode.editor.setText("saved draft");
			harness.mode.editor.handleInput("\x13");
			harness.mode.editor.setText("/guided-goal ship");
			vi.spyOn(harness.session.agent, "followUp").mockImplementationOnce(() => {
				throw new Error("enqueue failed");
			});
			await harness.mode.editor.onSubmit?.("/guided-goal ship");
			expect(harness.session.agent.peekFollowUpQueue()).toHaveLength(0);
			expect(harness.mode.editor.getText()).toBe("/guided-goal ship");
			harness.mode.editor.clearDraft();
			harness.mode.editor.handleInput("\x13");
			expect(harness.mode.editor.getText()).toBe("saved draft");
		} finally {
			await harness.cleanup();
		}
	});

	it("preserves a rejected bare guided-goal command ahead of the stash", async () => {
		const harness = await createHarness({ goalEnabled: false });
		try {
			await harness.mode.init({ suppressWelcomeIntro: true });
			harness.mode.editor.setText("saved draft");
			harness.mode.editor.handleInput("\x13");
			harness.mode.editor.setText("/guided-goal");
			await harness.mode.editor.onSubmit?.("/guided-goal");
			expect(harness.mode.editor.getText()).toBe("/guided-goal");
			harness.mode.editor.clearDraft();
			harness.mode.editor.handleInput("\x13");
			expect(harness.mode.editor.getText()).toBe("saved draft");
		} finally {
			await harness.cleanup();
		}
	});

	it("refuses to start while goal mode is disabled, active, or paused", async () => {
		const disabled = await createHarness({ goalEnabled: false });
		try {
			const promptSpy = vi.spyOn(disabled.session, "prompt").mockResolvedValue(true);
			const warning = vi.spyOn(disabled.mode, "showWarning");

			await disabled.mode.handleGuidedGoalCommand("ship it");

			expect(promptSpy).not.toHaveBeenCalled();
			expect(warning).toHaveBeenCalledWith("Goal mode is disabled. Enable it in settings (goal.enabled).");
			expect(disabled.session.getEnabledToolNames()).not.toContain("goal");
		} finally {
			await disabled.cleanup();
		}

		const harness = await createHarness();
		try {
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);
			const status = vi.spyOn(harness.mode, "showStatus");
			const warning = vi.spyOn(harness.mode, "showWarning");

			harness.mode.goalModeEnabled = true;
			await harness.mode.handleGuidedGoalCommand("ship it");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(status).toHaveBeenCalledWith(
				"Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
			);

			harness.mode.goalModeEnabled = false;
			const now = Date.now();
			harness.session.setGoalModeState({
				enabled: false,
				mode: "active",
				goal: {
					id: "g1",
					objective: "Ship it",
					status: "paused",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: now,
					updatedAt: now,
				},
			});
			await harness.mode.handleGuidedGoalCommand("ship it");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(warning).toHaveBeenCalledWith(
				"Resume the current goal first, or drop it before setting a new objective.",
			);
		} finally {
			await harness.cleanup();
		}
	});

	it("goal tool create enables goal mode and emits goal_updated for the UI", async () => {
		const harness = await createHarness();
		try {
			const events: AgentSessionEvent[] = [];
			const unsubscribe = harness.session.subscribe(event => {
				if (event.type === "goal_updated") events.push(event);
			});

			const result = await harness.goalTool.execute("call-1", {
				op: "create",
				objective: "## Objective\nShip the release.",
			});

			expect(result.isError).not.toBe(true);
			expect(harness.session.getGoalModeState()?.enabled).toBe(true);
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("## Objective\nShip the release.");
			const lastEvent = events.at(-1);
			if (lastEvent?.type !== "goal_updated") {
				throw new Error("expected goal_updated event after tool-driven create");
			}
			expect(lastEvent.state?.enabled).toBe(true);
			unsubscribe();
		} finally {
			await harness.cleanup();
		}
	});

	it("allows explicit goal tool activation without an active goal, but keeps it out of the default set", async () => {
		const harness = await createHarness();
		try {
			const explicit = await createTools(createToolSession(harness.tempDir.path(), harness.settings), [
				"read",
				"goal",
			]);
			expect(explicit.map(tool => tool.name)).toContain("goal");

			const defaults = await createTools(createToolSession(harness.tempDir.path(), harness.settings));
			expect(defaults.map(tool => tool.name)).not.toContain("goal");
		} finally {
			await harness.cleanup();
		}

		const disabled = await createHarness({ goalEnabled: false });
		try {
			const explicit = await createTools(createToolSession(disabled.tempDir.path(), disabled.settings), [
				"read",
				"goal",
			]);
			expect(explicit.map(tool => tool.name)).not.toContain("goal");
		} finally {
			await disabled.cleanup();
		}
	});

	it("keeps the interview active across question turns and ends it once a turn makes tool calls", async () => {
		const harness = await createHarness();
		try {
			await startInterview(harness);
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(true);

			await endTurn(harness, [assistantTurn([{ type: "text", text: "Which option: a, b, or c?" }])]);
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(true);

			// Abandoned for real work: the interview is tool-free, so tool use ends it.
			await endTurn(harness, [
				assistantTurn([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }]),
			]);
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("ends the interview when the agent creates the goal", async () => {
		const harness = await createHarness();
		try {
			await startInterview(harness);
			await harness.goalTool.execute("call-1", { op: "create", objective: "## Objective\nShip it." });
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not leave the interview active when the kickoff fails", async () => {
		const harness = await createHarness();
		try {
			vi.spyOn(harness.session, "prompt").mockRejectedValue(new Error("provider down"));
			vi.spyOn(harness.mode, "showError").mockImplementation(() => {});

			await harness.mode.handleGuidedGoalCommand("ship it");

			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});
});
