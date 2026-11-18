import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgAskEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
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
	startMode: () => Promise<void>;
	cleanup: () => Promise<void>;
};

async function createHarness(options?: {
	goalEnabled?: boolean;
	askEnabled?: boolean;
	goalAvailable?: boolean;
}): Promise<GuidedGoalHarness> {
	vi.spyOn(vcs, "repo").mockReturnValue(null);
	vi.spyOn(vcs, "git").mockReturnValue(null);
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-guided-goal-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": options?.goalEnabled ?? true,
		"plan.enabled": true,
		"ask.enabled": options?.askEnabled ?? true,
		"astGrep.enabled": true,
		"astEdit.enabled": true,
	});
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	const availableTools = await createTools(createToolSession(tempDir.path(), settings), [
		"read",
		"ask",
		"write",
		"ast_grep",
		"ast_edit",
	]);
	const initialTools = availableTools.filter(tool => tool.name === "read");
	const toolRegistry = new Map<string, Tool>(availableTools.map(tool => [tool.name, tool] as const));
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: initialTools,
			messages: [],
		},
	});
	const xdev: XdevState = {
		tools: toolRegistry,
		mountedNames: new Set(),
		builtInNames: new Set(availableTools.map(tool => tool.name)),
		isActive: name => agent.state.tools.some(tool => tool.name === name),
	};
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		xdev,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		ensureGoalRegistered: options?.goalAvailable === false ? async () => false : undefined,
	});
	vi.spyOn(session, "prewarmModelConnection").mockImplementation(() => {});
	for (const tool of availableTools) {
		session.setToolBuiltIn(tool.name, true);
	}
	// Mirror sdk.ts assembly: the goal tool is pre-registered (hidden) whenever
	// goal.enabled, so /guided-goal can activate it by name for the interview.
	const goalToolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
	});
	const goalTool = new GoalTool(goalToolSession);
	if (options?.goalAvailable !== false) {
		toolRegistry.set("goal", goalTool as unknown as Tool);
		session.setToolBuiltIn("goal", true);
	}
	const mode = new InteractiveMode(
		session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		new Composer({ terminal: new VirtualTerminal(120, 40) }),
	);
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	mode.ui.requestRender = vi.fn();
	return {
		mode,
		session,
		settings,
		goalTool,
		tempDir,
		startMode: () => mode.init({ suppressWelcomeIntro: true }),
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
			resetSettingsForTest();
		},
	};
}

async function emitTerminalAgentEnd(harness: GuidedGoalHarness): Promise<void> {
	const delivered = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe(event => {
		if (event.type === "agent_end") delivered.resolve();
	});
	try {
		harness.session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
		await delivered.promise;
		// The mode starts restoration without blocking event delivery.
		await harness.session.runToolRegistryMutation(async () => {});
		await scheduler.yield();
	} finally {
		unsubscribe();
	}
}

/** Simulate delivery of the real synthetic follow-up without calling a model. */
function consumeQueuedKickoff(harness: GuidedGoalHarness): void {
	const [kickoff] = harness.session.agent.peekFollowUpQueue();
	if (kickoff?.role !== "developer" || kickoff.synthetic !== true) {
		throw new Error("Expected the queued guided-goal kickoff");
	}
	harness.session.dropQueuedMessages([kickoff]);
}

describe("guided goal setup", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("kicks off the interview as a hidden developer prompt and exposes its required tools", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getEnabledToolNames()).not.toContain("ask");
			let toolsDuringPrompt: string[] = [];
			const promptSpy = vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
				toolsDuringPrompt = harness.session.getEnabledToolNames();
				return true;
			});
			const images: ImageContent[] = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];

			await harness.mode.handleGuidedGoalCommand("automate flaky test triage", {
				images,
				imageLinks: ["file:///shot.png"],
			});

			expect(promptSpy).toHaveBeenCalledTimes(1);
			const [text, promptOptions] = promptSpy.mock.calls[0]!;
			expect(promptOptions).toEqual({ synthetic: true, images });
			// The supplied objective must reach the model.
			expect(text).toContain("automate flaky test triage");
			// Both mandatory interview tools are active while dispatching, then
			// restored when this mocked turn settles without creating a goal.
			expect(toolsDuringPrompt).toEqual(expect.arrayContaining(["ask", "goal"]));
			expect(harness.session.getEnabledToolNames()).not.toContain("ask");
			expect(harness.session.getEnabledToolNames()).not.toContain("goal");
		} finally {
			await harness.cleanup();
		}
	});

	it("refuses to start when the ask tool is unavailable", async () => {
		const harness = await createHarness({ askEnabled: false });
		try {
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			const started = await harness.mode.handleGuidedGoalCommand("ship it");

			expect(started).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(harness.session.getEnabledToolNames()).not.toContain("goal");
		} finally {
			await harness.cleanup();
		}
	});

	it("refuses to start when an extension replaces the built-in ask tool", async () => {
		const harness = await createHarness();
		try {
			harness.session.setToolBuiltIn("ask", false);
			const previousTools = harness.session.getEnabledToolNames();
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			const started = await harness.mode.handleGuidedGoalCommand("ship it");

			expect(started).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("rolls back when an extension replaces the built-in goal tool", async () => {
		const harness = await createHarness();
		try {
			harness.session.setToolBuiltIn("goal", false);
			const previousTools = harness.session.getEnabledToolNames();
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			const started = await harness.mode.handleGuidedGoalCommand("ship it");

			expect(started).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("preserves a goal tool that was explicitly enabled before the interview", async () => {
		const harness = await createHarness();
		try {
			await harness.session.setActiveToolsByName([...harness.session.getEnabledToolNames(), "goal"]);
			const previousTools = harness.session.getEnabledToolNames();
			vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(true);

			expect(previousTools).toContain("goal");
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("refuses to reactivate ask after the setting is disabled", async () => {
		const harness = await createHarness();
		try {
			cfgAskEnabled.override(harness.settings, false);
			const previousTools = harness.session.getEnabledToolNames();
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			const started = await harness.mode.handleGuidedGoalCommand("ship it");

			expect(started).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("rolls back when a required tool setting is disabled during activation", async () => {
		const harness = await createHarness();
		try {
			const previousTools = harness.session.getEnabledToolNames();
			const setActiveTools = harness.session.setActiveToolsByName.bind(harness.session);
			vi.spyOn(harness.session, "setActiveToolsByName").mockImplementation(async names => {
				await setActiveTools(names);
				cfgAskEnabled.override(harness.settings, false);
			});
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			const started = await harness.mode.handleGuidedGoalCommand("ship it");

			expect(started).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("refuses to start when the goal tool cannot be registered", async () => {
		const harness = await createHarness({ goalAvailable: false });
		try {
			const previousTools = harness.session.getEnabledToolNames();
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			const started = await harness.mode.handleGuidedGoalCommand("ship it");

			expect(started).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("starts a tool-backed interview without requiring a rough objective", async () => {
		const harness = await createHarness();
		try {
			const promptSpy = vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
				expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));
				return true;
			});

			expect(await harness.mode.handleGuidedGoalCommand()).toBe(true);

			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(promptSpy.mock.calls[0]?.[1]).toEqual({ synthetic: true });
		} finally {
			await harness.cleanup();
		}
	});

	it("queues the kickoff as a synthetic follow-up while the agent is streaming", async () => {
		const harness = await createHarness();
		try {
			await harness.startMode();
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);
			const followUp = vi.spyOn(harness.session, "followUp");

			await harness.mode.handleGuidedGoalCommand("ship it");

			expect(promptSpy).not.toHaveBeenCalled();
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(followUp.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ synthetic: true }));
			expect(harness.session.agent.peekFollowUpQueue()).toEqual([
				expect.objectContaining({ role: "developer", synthetic: true }),
			]);
			const input = harness.mode.getUserInput();
			expect(harness.mode.onInputCallback).toBeDefined();
			harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
			expect(await input).toEqual(expect.objectContaining({ text: "next turn" }));
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps goal-mode cleanup ownership when a queued kickoff creates the goal immediately", async () => {
		const harness = await createHarness();
		try {
			await harness.startMode();
			await harness.session.setActiveToolsByName([...harness.session.getEnabledToolNames(), "goal"]);
			const previousTools = harness.session.getEnabledToolNames();
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			const enqueue = harness.session.followUp.bind(harness.session);
			vi.spyOn(harness.session, "followUp").mockImplementation(async (...args) => {
				await enqueue(...args);
				consumeQueuedKickoff(harness);
				await harness.goalTool.execute("create-call", {
					op: "create",
					objective: "Ship the release.",
				});
			});

			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(true);
			expect(harness.session.getGoalModeState()?.enabled).toBe(true);
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);

			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => false });
			await emitTerminalAgentEnd(harness);

			expect(harness.session.getGoalModeState()?.enabled).toBe(true);
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));

			await harness.goalTool.execute("complete-call", { op: "complete" });
			await emitTerminalAgentEnd(harness);

			expect(harness.session.getGoalModeState()).toBeUndefined();
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects a second interview even if the earlier run ends before its queued kickoff", async () => {
		const harness = await createHarness();
		try {
			await harness.startMode();
			const previousTools = harness.session.getEnabledToolNames();
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			const followUp = vi.spyOn(harness.session, "followUp");

			const firstStarted = await harness.mode.handleGuidedGoalCommand("first goal");
			expect(firstStarted).toBe(true);
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => false });
			await emitTerminalAgentEnd(harness);
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));

			const secondStarted = await harness.mode.handleGuidedGoalCommand("second goal");

			expect(secondStarted).toBe(false);
			expect(followUp).toHaveBeenCalledTimes(1);

			consumeQueuedKickoff(harness);
			await emitTerminalAgentEnd(harness);
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("falls back to a synthetic follow-up when the prompt races an in-flight run", async () => {
		const harness = await createHarness();
		try {
			vi.spyOn(harness.session, "prompt").mockRejectedValue(new AgentBusyError());
			const followUp = vi.spyOn(harness.session, "followUp");

			await harness.mode.handleGuidedGoalCommand("ship it");

			expect(followUp).toHaveBeenCalledTimes(1);
			expect(followUp.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ synthetic: true }));
			expect(harness.session.agent.peekFollowUpQueue()).toEqual([
				expect.objectContaining({ role: "developer", synthetic: true }),
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("retries failed cleanup before starting another interview", async () => {
		const harness = await createHarness();
		try {
			const previousTools = harness.session.getEnabledToolNames();
			const setActiveTools = harness.session.setActiveToolPresentation.bind(harness.session);
			const promptSpy = vi
				.spyOn(harness.session, "prompt")
				.mockImplementationOnce(async () => {
					vi.spyOn(harness.session, "setActiveToolPresentation")
						.mockRejectedValueOnce(new Error("transient restore failure"))
						.mockImplementation(setActiveTools);
					throw new Error("kickoff failed");
				})
				.mockResolvedValue(true);
			const error = vi.spyOn(harness.mode, "showError");

			expect(await harness.mode.handleGuidedGoalCommand("first goal")).toBe(false);
			expect(error).toHaveBeenCalledWith("kickoff failed");
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));

			expect(await harness.mode.handleGuidedGoalCommand("second goal")).toBe(true);
			expect(promptSpy).toHaveBeenCalledTimes(2);
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("restores the original mounts and tools when the interview ends without a goal", async () => {
		const harness = await createHarness();
		try {
			await harness.startMode();
			await harness.session.setActiveToolPresentation(["read", "write", "ast_grep"], ["ast_grep"]);
			expect(harness.session.getMountedXdevToolNames()).toEqual(["ast_grep"]);
			const previousTools = harness.session.getEnabledToolNames();
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(true);
			consumeQueuedKickoff(harness);
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));
			// The interrupted interview loses its temporary tools and restores the
			// original presentation, not just the set of enabled names.
			await harness.session.setActiveToolPresentation(harness.session.getEnabledToolNames(), []);
			expect(harness.session.getMountedXdevToolNames()).toEqual([]);
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => false });

			await emitTerminalAgentEnd(harness);

			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
			expect(harness.session.getMountedXdevToolNames()).toEqual(["ast_grep"]);
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps the input loop alive until interview restoration recovers", async () => {
		const harness = await createHarness();
		const allowRestore = Promise.withResolvers<void>();
		try {
			await harness.startMode();
			const previousTools = harness.session.getEnabledToolNames();
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(true);
			consumeQueuedKickoff(harness);
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => false });

			const setActiveTools = harness.session.setActiveToolPresentation.bind(harness.session);
			const toolsRestored = Promise.withResolvers<void>();
			let restorationAttempts = 0;
			vi.spyOn(harness.session, "setActiveToolPresentation").mockImplementation(async (enabled, mounted) => {
				restorationAttempts += 1;
				if (restorationAttempts <= 2) throw new Error("transient restore failure");
				await allowRestore.promise;
				await setActiveTools(enabled, mounted);
				toolsRestored.resolve();
			});
			const warning = vi.spyOn(harness.mode, "showWarning");
			const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

			await emitTerminalAgentEnd(harness);
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));
			const input = harness.mode.getUserInput();
			expect(harness.mode.onInputCallback).toBeUndefined();
			expect(harness.mode.editor.disableSubmit).toBe(true);
			harness.mode.editor.setText("next turn");
			harness.mode.editor.handleInput("\r");
			await scheduler.yield();
			expect(prompt).not.toHaveBeenCalled();
			expect(harness.mode.editor.getText()).toBe("next turn");
			allowRestore.resolve();
			await toolsRestored.promise;
			await scheduler.yield();

			expect(warning).toHaveBeenCalled();
			expect(harness.mode.editor.disableSubmit).toBe(false);
			harness.mode.editor.handleInput("\r");
			expect(await input).toEqual(expect.objectContaining({ text: "next turn" }));
			expect(prompt).not.toHaveBeenCalled();
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			allowRestore.resolve();
			await harness.cleanup();
		}
	});

	it("restores pending interview ownership after a session switch rolls back", async () => {
		const harness = await createHarness();
		const targetDir = TempDir.createSync("@pi-guided-goal-switch-target-");
		try {
			const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
			targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
			await targetManager.ensureOnDisk();
			await targetManager.flush();
			const targetSessionFile = targetManager.getSessionFile();
			await targetManager.close();
			expect(targetSessionFile).toBeString();

			await harness.startMode();
			await harness.session.setActiveToolPresentation(["read", "write", "ast_grep"], ["ast_grep"]);
			const previousTools = harness.session.getEnabledToolNames();
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			const previousSessionId = harness.session.sessionId;
			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(true);
			await harness.session.setActiveToolPresentation(
				[...harness.session.getEnabledToolNames(), "ast_edit"],
				["ast_edit"],
			);
			const interviewTools = harness.session.getEnabledToolNames();
			const interviewMountedTools = harness.session.getMountedXdevToolNames();
			expect(interviewMountedTools).toEqual(["ast_edit"]);
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => false });
			const sourceCwd = harness.session.sessionManager.getCwd();
			let presentationAtTarget: { enabled: string[]; mounted: string[] } | undefined;

			expect(
				await harness.session.switchSession(targetSessionFile!, {
					onCwdChange: async (_newCwd, previousCwd) => {
						if (previousCwd !== sourceCwd) return true;
						presentationAtTarget = {
							enabled: harness.session.getEnabledToolNames(),
							mounted: harness.session.getMountedXdevToolNames(),
						};
						return false;
					},
				}),
			).toBe(false);
			expect(presentationAtTarget).toEqual({ enabled: previousTools, mounted: ["ast_grep"] });

			expect(harness.session.sessionId).toBe(previousSessionId);
			expect(harness.session.agent.peekFollowUpQueue()).toEqual([
				expect.objectContaining({ role: "developer", synthetic: true }),
			]);
			expect(harness.session.getEnabledToolNames()).toEqual(interviewTools);
			expect(harness.session.getMountedXdevToolNames()).toEqual(interviewMountedTools);
			expect(await harness.mode.handleGuidedGoalCommand("second goal")).toBe(false);
		} finally {
			await harness.cleanup();
			await targetDir.remove();
		}
	});

	it("restores a queued interview before starting a new session", async () => {
		const harness = await createHarness();
		const releaseFollowUp = Promise.withResolvers<void>();
		try {
			await harness.startMode();
			const previousTools = harness.session.getEnabledToolNames();
			const previousSessionId = harness.session.sessionId;
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			const followUpStarted = Promise.withResolvers<void>();
			const enqueue = harness.session.followUp.bind(harness.session);
			vi.spyOn(harness.session, "followUp").mockImplementation(async (...args) => {
				followUpStarted.resolve();
				await releaseFollowUp.promise;
				await enqueue(...args);
			});
			const guidedGoal = harness.mode.handleGuidedGoalCommand("ship it");
			await followUpStarted.promise;
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => false });

			let newSessionSettled = false;
			const newSession = harness.session.newSession().then(result => {
				newSessionSettled = true;
				return result;
			});
			await scheduler.yield();
			expect(newSessionSettled).toBe(false);
			releaseFollowUp.resolve();

			expect(await guidedGoal).toBe(true);
			expect(await newSession).toBe(true);
			expect(harness.session.sessionId).not.toBe(previousSessionId);
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
			expect(harness.session.agent.peekFollowUpQueue()).toEqual([]);
			vi.spyOn(harness.session, "prompt").mockResolvedValue(true);
			expect(await harness.mode.handleGuidedGoalCommand("new goal")).toBe(true);
		} finally {
			releaseFollowUp.resolve();
			await harness.cleanup();
		}
	});

	it("cancels a new session when pending interview restoration fails", async () => {
		const harness = await createHarness();
		try {
			await harness.startMode();
			const previousTools = harness.session.getEnabledToolNames();
			const previousSessionId = harness.session.sessionId;
			harness.session.agent.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Previous turn." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(true);
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => false });

			const setActiveTools = harness.session.setActiveToolPresentation.bind(harness.session);
			vi.spyOn(harness.session, "setActiveToolPresentation")
				.mockRejectedValueOnce(new Error("transient restore failure"))
				.mockImplementation(setActiveTools);
			const queuedKickoffDrained = Promise.withResolvers<AgentMessage[]>();
			const continueSpy = vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
				const drained = [...harness.session.agent.peekFollowUpQueue()];
				harness.session.agent.clearAllQueues();
				queuedKickoffDrained.resolve(drained);
			});

			expect(await harness.session.newSession()).toBe(false);
			expect(await queuedKickoffDrained.promise).toEqual([
				expect.objectContaining({ role: "developer", synthetic: true }),
			]);
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(harness.session.sessionId).toBe(previousSessionId);
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));

			expect(await harness.session.newSession()).toBe(true);
			expect(harness.session.sessionId).not.toBe(previousSessionId);
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps interview tools through goal creation and retries failed exit restoration", async () => {
		const harness = await createHarness();
		try {
			await harness.startMode();
			await harness.session.setActiveToolPresentation(["read", "write", "ast_grep"], ["ast_grep"]);
			expect(harness.session.getMountedXdevToolNames()).toEqual(["ast_grep"]);
			const promptSpy = vi
				.spyOn(harness.session, "prompt")
				.mockImplementationOnce(async () => {
					await harness.goalTool.execute("create-call", {
						op: "create",
						objective: "Ship the release.",
					});
					return true;
				})
				.mockResolvedValue(true);

			await harness.mode.handleGuidedGoalCommand("ship it");

			expect(harness.session.getGoalModeState()?.enabled).toBe(true);
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);

			// Change the live roster after goal creation. Goal exit owns only
			// the interview tools; it must not undo unrelated additions/removals.
			await harness.session.setActiveToolPresentation(["read", "write", "ask", "goal", "ast_edit"], ["ast_edit"]);
			expect(harness.session.getMountedXdevToolNames()).toEqual(["ast_edit"]);

			await harness.goalTool.execute("complete-call", { op: "complete" });
			const setActiveTools = harness.session.setActiveToolPresentation.bind(harness.session);
			const toolsRestored = Promise.withResolvers<void>();
			let restorationAttempts = 0;
			vi.spyOn(harness.session, "setActiveToolPresentation").mockImplementation(async (enabled, mounted) => {
				restorationAttempts += 1;
				if (restorationAttempts <= 2) throw new Error("transient goal exit failure");
				await setActiveTools(enabled, mounted);
				toolsRestored.resolve();
			});
			await emitTerminalAgentEnd(harness);

			expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
			expect(harness.session.getEnabledToolNames()).toEqual(expect.arrayContaining(["ask", "goal"]));
			const input = harness.mode.getUserInput();
			await toolsRestored.promise;
			await scheduler.yield();
			harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
			await input;

			expect(harness.session.getGoalModeState()).toBeUndefined();
			expect(harness.session.getEnabledToolNames()).toEqual(["read", "write", "ast_edit"]);
			expect(harness.session.getMountedXdevToolNames()).toEqual(["ast_edit"]);
			const restarted = await harness.mode.handleGuidedGoalCommand("next goal");

			expect(restarted).toBe(true);
			expect(promptSpy).toHaveBeenCalledTimes(2);
			expect(harness.session.getGoalModeState()).toBeUndefined();
			expect(harness.session.getEnabledToolNames()).toEqual(["read", "write", "ast_edit"]);
			expect(harness.session.getMountedXdevToolNames()).toEqual(["ast_edit"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("aborts a dispatching interview before shutdown restores its tools", async () => {
		const harness = await createHarness();
		const promptStarted = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		let shutdown: Promise<void> | undefined;
		try {
			await harness.startMode();
			const previousTools = harness.session.getEnabledToolNames();
			const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
			vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
				promptStarted.resolve();
				await releasePrompt.promise;
				return true;
			});
			const abort = vi.spyOn(harness.session, "abort").mockImplementation(async () => {
				releasePrompt.resolve();
			});

			const interview = harness.mode.handleGuidedGoalCommand("ship it");
			await promptStarted.promise;
			shutdown = harness.mode.shutdown();
			await scheduler.yield();

			expect(abort).toHaveBeenCalledTimes(1);
			await shutdown;
			await interview;
			expect(harness.session.getEnabledToolNames()).toEqual(previousTools);
			expect(quit).toHaveBeenCalledWith(0);
		} finally {
			releasePrompt.resolve();
			await shutdown;
			await harness.cleanup();
		}
	});

	it("clears a completed goal during shutdown after repeated restore failures", async () => {
		const harness = await createHarness();
		try {
			await harness.startMode();
			const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
			vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
				await harness.goalTool.execute("create-call", {
					op: "create",
					objective: "Ship the release.",
				});
				return true;
			});
			await harness.mode.handleGuidedGoalCommand("ship it");
			await harness.goalTool.execute("complete-call", { op: "complete" });
			vi.spyOn(harness.session, "setActiveToolPresentation").mockRejectedValue(
				new Error("persistent goal exit failure"),
			);
			await emitTerminalAgentEnd(harness);
			expect(harness.session.getGoalModeState()?.mode).toBe("exiting");

			await harness.mode.shutdown();

			expect(harness.session.getGoalModeState()).toBeUndefined();
			expect(quit).toHaveBeenCalledWith(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("refuses to start while goal mode is disabled, active, or paused", async () => {
		const disabled = await createHarness({ goalEnabled: false });
		try {
			const promptSpy = vi.spyOn(disabled.session, "prompt").mockResolvedValue(true);
			const warning = vi.spyOn(disabled.mode, "showWarning");

			expect(await disabled.mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(promptSpy).not.toHaveBeenCalled();
			expect(warning).toHaveBeenCalledTimes(1);
			expect(disabled.session.getEnabledToolNames()).not.toContain("goal");
		} finally {
			await disabled.cleanup();
		}

		const harness = await createHarness();
		try {
			await harness.startMode();
			await harness.goalTool.execute("create-call", { op: "create", objective: "Keep this goal" });
			expect(harness.session.getGoalModeState()?.enabled).toBe(true);
			const promptSpy = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);
			const status = vi.spyOn(harness.mode, "showStatus");
			const warning = vi.spyOn(harness.mode, "showWarning");

			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(status).toHaveBeenCalledTimes(1);

			await harness.session.goalRuntime.pauseGoal();
			expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(false);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(warning).toHaveBeenCalledTimes(1);
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("Keep this goal");
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

	it("routes c as a reply only while the kickoff is in progress", async () => {
		const harness = await createHarness();
		const kickoffStarted = Promise.withResolvers<void>();
		const finishKickoff = Promise.withResolvers<void>();
		let kickoff: Promise<boolean> | undefined;
		try {
			await harness.startMode();
			let streaming = false;
			Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => streaming });
			const prompt = vi
				.spyOn(harness.session, "prompt")
				.mockImplementationOnce(async () => {
					streaming = true;
					kickoffStarted.resolve();
					await finishKickoff.promise;
					streaming = false;
					return true;
				})
				.mockResolvedValue(true);
			const resume = vi.spyOn(harness.session, "resume").mockResolvedValue();

			kickoff = harness.mode.handleGuidedGoalCommand("ship it");
			await kickoffStarted.promise;
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(true);
			await harness.mode.editor.onSubmit?.("c");
			expect(prompt).toHaveBeenLastCalledWith("c", { streamingBehavior: "steer", images: undefined });
			expect(resume).not.toHaveBeenCalled();

			finishKickoff.resolve();
			expect(await kickoff).toBe(true);
			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);

			const input = harness.mode.getUserInput();
			expect(harness.mode.onInputCallback).toBeDefined();
			await harness.mode.editor.onSubmit?.("c");
			expect(harness.mode.onInputCallback).toBeUndefined();
			expect(await input).toEqual(expect.objectContaining({ text: "c", resume: true }));
			expect(prompt).toHaveBeenCalledTimes(2);
		} finally {
			finishKickoff.resolve();
			await kickoff;
			await harness.cleanup();
		}
	});

	it("does not leave the interview active when the kickoff fails", async () => {
		const harness = await createHarness();
		try {
			vi.spyOn(harness.session, "prompt").mockRejectedValue(new Error("provider down"));
			vi.spyOn(harness.mode, "showError").mockImplementation(() => {});

			expect(await harness.mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(harness.mode.isGuidedGoalInterviewActive()).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});
});
