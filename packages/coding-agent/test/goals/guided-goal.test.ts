import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type AgentMessage, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalToolDefault } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgGrepEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
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
	goalTool: Tool;
	tempDir: TempDir;
	cleanup: () => Promise<void>;
};

async function createHarness(options?: { goalEnabled?: boolean; toolNames?: string[] }): Promise<GuidedGoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-guided-goal-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": options?.goalEnabled ?? true,
		"plan.enabled": true,
		"tools.xdev": true,
	});
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		authStorage,
		model,
		toolNames: options?.toolNames ?? ["read"],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		workspaceTree: { rootPath: tempDir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	mode.ui.requestRender = vi.fn();
	return {
		mode,
		session,
		settings,
		get goalTool() {
			const tool = session.getToolByName("goal");
			if (!tool) throw new Error("Expected hidden goal tool to be registered");
			return tool;
		},
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
			expect(cfgGoalToolDefault.get(harness.settings)).toBe(false);
			expect(harness.session.getEnabledToolNames()).not.toContain("goal");
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

	it("preserves the explicit interview grant across an unrelated live tool-setting change", async () => {
		const harness = await createHarness({ toolNames: ["read", "write"] });
		try {
			await startInterview(harness);
			expect(cfgGoalToolDefault.get(harness.settings)).toBe(false);
			expect(harness.session.getGoalModeState()).toBeUndefined();
			expect(harness.session.getEnabledToolNames()).toContain("goal");

			cfgGrepEnabled.set(harness.settings, false);
			expect(cfgGrepEnabled.get(harness.settings)).toBe(false);
			await Promise.resolve();
			await harness.session.runToolRegistryMutation(async () => {});

			expect(harness.session.getEnabledToolNames()).toContain("goal");
			// Exercise canonical XD routing, not just direct access to the goal instance.
			const write = harness.session.agent.state.tools.find(tool => tool.name === "write");
			expect(write).toBeDefined();
			const result = await write!.execute("guided_after_settings", {
				path: "xd://goal",
				content: JSON.stringify({ op: "create", objective: "Ship after changing grep settings" }),
			} as never);
			expect(result.isError ?? false).toBe(false);
			expect(harness.session.getGoalModeState()).toMatchObject({
				enabled: true,
				goal: { objective: "Ship after changing grep settings", status: "active" },
			});
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

	it("does not expose the goal tool when goal mode is disabled", async () => {
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

	it.each([
		{ name: "restricted", overrides: { restrictToolNames: true }, toolNames: ["read", "goal"] },
		{ name: "subagent", overrides: { taskDepth: 1 }, toolNames: undefined },
		{ name: "explicit", overrides: {}, toolNames: ["read"] },
		{ name: "empty", overrides: {}, toolNames: [] },
	])("does not auto-include the goal tool in $name tool lists", async ({ overrides, toolNames }) => {
		const harness = await createHarness();
		try {
			const tools = await createTools(
				createToolSession(harness.tempDir.path(), harness.settings, overrides),
				toolNames?.slice(),
			);
			expect(tools.map(tool => tool.name)).not.toContain("goal");
		} finally {
			await harness.cleanup();
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
