import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
			expect(promptOptions).toEqual({ synthetic: true, images });
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
			expect(followUp.mock.calls[0]?.[2]).toEqual({ synthetic: true });
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
			expect(followUp.mock.calls[0]?.[2]).toEqual({ synthetic: true });
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
});
