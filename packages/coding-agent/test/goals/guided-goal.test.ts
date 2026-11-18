import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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
	toolRegistry: Map<string, Tool>;
	tempDir: TempDir;
	cleanup: () => Promise<void>;
};

type GuidedGoalHarnessOptions = {
	goalEnabled?: boolean;
	guidedAsk?: boolean;
	askEnabled?: boolean;
	ask?: "active" | "excluded" | "replacement";
	xdev?: boolean;
	rebuildSystemPrompt?: () => Promise<{ systemPrompt: string[] }>;
};

async function createHarness(options?: GuidedGoalHarnessOptions): Promise<GuidedGoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-guided-goal-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": options?.goalEnabled ?? true,
		...(options?.guidedAsk !== undefined && { "goal.guidedAsk": options.guidedAsk }),
		"ask.enabled": options?.askEnabled ?? true,
		"astGrep.enabled": options?.xdev ?? false,
		"plan.enabled": true,
		"tools.xdev": options?.xdev ?? false,
	});
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	const toolRegistry = new Map<string, Tool>();
	const toolSession = createToolSession(tempDir.path(), settings, { toolRegistry });
	const initialTools = await createTools(toolSession, options?.xdev ? ["read", "write"] : ["read"]);
	const builtInToolNames = toolSession.xdev?.builtInNames ?? new Set(initialTools.map(tool => tool.name));
	if (options?.ask) {
		// Include a still-active built-in even when ask.enabled has been cut off,
		// as the setting and the live presentation are independently gated.
		const builtInAsk = new AskTool({ ...toolSession, hasUI: true });
		const ask: Tool =
			options.ask === "replacement"
				? {
						name: "ask",
						label: "Extension Ask",
						description: "Extension-provided tool",
						parameters: builtInAsk.parameters,
						async execute() {
							throw new Error("The replacement is not an interview picker");
						},
					}
				: builtInAsk;
		toolRegistry.set("ask", ask);
		if (options.ask !== "replacement") builtInToolNames.add("ask");
		if (options.ask !== "excluded") initialTools.push(ask);
	}
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: initialTools,
			messages: [],
		},
	});
	toolSession.isToolActive = name => agent.state.tools.some(tool => tool.name === name);
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		builtInToolNames,
		xdev: toolSession.xdev,
		rebuildSystemPrompt: options?.rebuildSystemPrompt ?? (async () => ({ systemPrompt: ["Test"] })),
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
		toolRegistry,
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

/** Initialize the real event subscriptions and lift the editor's bootstrap submit gate. */
async function initMode(harness: GuidedGoalHarness): Promise<void> {
	vi.spyOn(vcs, "repo").mockReturnValue(null);
	vi.spyOn(vcs, "git").mockReturnValue(null);
	await harness.mode.init({ suppressWelcomeIntro: true });
}

/** Start a conversational interview without contacting a provider. */
async function startInterview(harness: GuidedGoalHarness): Promise<void> {
	await initMode(harness);
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

async function enableLateTools(harness: GuidedGoalHarness): Promise<void> {
	const { session, toolRegistry, settings, tempDir } = harness;
	const lateTools = await createTools(createToolSession(tempDir.path(), settings), ["grep", "ast_grep"]);
	for (const tool of lateTools) toolRegistry.set(tool.name, tool);
	await session.setActiveToolPresentation([...session.getEnabledToolNames(), "grep", "ast_grep"], ["ast_grep"]);
}

function expectConversationalQuestions(text: string): void {
	expect(text).toMatch(/\b(?:one|single)\b[^.;]*\bquestion\b/i);
	expect(text).toMatch(/\bno\s+tool calls\b/i);
	expect(text).not.toMatch(/\bask\(\)/);
}

function expectBatchedAskQuestions(text: string): void {
	expect(text).toMatch(/\bask\(\)[^.]*\bevery\s+question and confirmation\b/i);
	expect(text).toMatch(/\b(?:batch|group)\b[^.]*\bindependent\s+questions?\b[^.]*\bsingle\b[^.]*\bask\(\)/i);
	expect(text).toMatch(/\b(?:no|never)\b[^.]*\bquestions?\b[^.]*\bassistant text\b/i);
	expect(text).not.toMatch(/\bno\s+tool calls\b/i);
}

describe("guided goal setup", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("kicks off the interview as a hidden developer prompt and exposes the goal tool", async () => {
		const harness = await createHarness({ ask: "active" });
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
			expectConversationalQuestions(text);
			expect(harness.session.getActiveToolNames()).toContain("ask");
			// The goal tool is activated up front so the agent can create the goal
			// once the interview concludes.
			expect(harness.session.getEnabledToolNames()).toContain("goal");
		} finally {
			await harness.cleanup();
		}
	});

	it.each([
		["the ask setting is disabled", { ask: "active", askEnabled: false }],
		["there is no registered ask", {}],
		["the built-in is excluded from the roster", { ask: "excluded" }],
		["an extension replaced the built-in", { ask: "replacement" }],
	] satisfies [string, GuidedGoalHarnessOptions][])("falls back to conversation when %s", async (_, options) => {
		const harness = await createHarness({ ...options, guidedAsk: true });
		try {
			const { mode, session } = harness;
			const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
			const before = session.getEnabledToolNames();

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(true);

			expect(prompt).toHaveBeenCalledTimes(1);
			expectConversationalQuestions(prompt.mock.calls[0]![0]);
			expect(new Set(session.getEnabledToolNames())).toEqual(new Set([...before, "goal"]));
			expect(mode.isGuidedGoalInterviewActive()).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	it("dispatches one batched ask interview and removes its temporary goal when the run ends without a goal", async () => {
		const harness = await createHarness({ guidedAsk: true, ask: "active" });
		try {
			const { mode, session } = harness;
			let toolsAtDispatch: string[] = [];
			const prompt = vi.spyOn(session, "prompt").mockImplementation(async () => {
				toolsAtDispatch = session.getActiveToolNames();
				return true;
			});

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(true);

			expect(prompt).toHaveBeenCalledTimes(1);
			const [text, options] = prompt.mock.calls[0]!;
			expect(options).toEqual({ synthetic: true });
			expectBatchedAskQuestions(text);
			expect(new Set(toolsAtDispatch)).toEqual(new Set(["read", "ask", "goal"]));
			expect(mode.isGuidedGoalInterviewActive()).toBe(false);
			expect(new Set(session.getActiveToolNames())).toEqual(new Set(["read", "ask"]));
		} finally {
			await harness.cleanup();
		}
	});

	it("waits for the queued ask kickoff to run before removing the temporary goal, preserving late tools and mounts", async () => {
		const harness = await createHarness({ guidedAsk: true, ask: "active", xdev: true });
		try {
			await initMode(harness);
			const { mode, session } = harness;
			const { agent } = session;
			let streaming = true;
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
			// Drive the two terminal events separately; hold the idle drain so the
			// second run does not start until the test delivers the real queued message.
			await session.runModeExitTeardown(async () => {
				expect(await mode.handleGuidedGoalCommand("ship it")).toBe(true);
				const kickoff = agent.peekFollowUpQueue().at(-1);
				if (kickoff?.role !== "developer") throw new Error("expected a queued developer kickoff");
				expect(kickoff.synthetic).toBe(true);

				streaming = false;
				await endTurn(harness, [
					assistantTurn([{ type: "toolCall", id: "earlier-read", name: "read", arguments: { path: "x" } }]),
				]);
				expect(mode.isGuidedGoalInterviewActive()).toBe(true);
				expect(session.getEnabledToolNames()).toContain("goal");
				await enableLateTools(harness);
				expect(session.getActiveToolNames()).toContain("grep");
				expect(session.getMountedXdevToolNames()).toContain("ast_grep");

				expect(agent.popLastFollowUp()).toBe(kickoff);
				agent.emitExternalEvent({ type: "agent_start" });
				agent.emitExternalEvent({ type: "message_start", message: kickoff });
				agent.emitExternalEvent({ type: "message_end", message: kickoff });
				await endTurn(harness, [kickoff, assistantTurn([{ type: "text", text: "No goal was created." }])]);
				// Terminal listeners launch their cleanup asynchronously. Join the
				// public tool-mutation queue before reading the final roster.
				await session.runToolRegistryMutation(async () => {});
				expect(mode.isGuidedGoalInterviewActive()).toBe(false);
				expect(new Set(session.getActiveToolNames())).toEqual(new Set(["read", "write", "ask", "grep"]));
				expect(session.getMountedXdevToolNames()).toEqual(["ast_grep"]);
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

	it("does not leave the conversational interview active when the kickoff fails", async () => {
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

	it.each(["active", "excluded"] as const)(
		"carries only temporary goal ownership into the goal lifecycle with ask %s",
		async ask => {
			const harness = await createHarness({ guidedAsk: true, ask });
			try {
				await initMode(harness);
				const { mode, session, goalTool } = harness;
				const before = session.getEnabledToolNames();
				vi.spyOn(session, "prompt").mockImplementation(async () => {
					await goalTool.execute("call-1", { op: "create", objective: "## Objective\nShip it." });
					return true;
				});

				expect(await mode.handleGuidedGoalCommand("ship it")).toBe(true);
				expect(mode.isGuidedGoalInterviewActive()).toBe(false);
				expect(session.getGoalModeState()?.enabled).toBe(true);
				expect(new Set(session.getEnabledToolNames())).toEqual(new Set([...before, "goal"]));

				await mode.handleGoalModeCommand("pause");
				expect(session.getGoalModeState()?.goal.status).toBe("paused");
				expect(new Set(session.getEnabledToolNames())).toEqual(new Set(before));
			} finally {
				await harness.cleanup();
			}
		},
	);

	it.each([
		["a temporary goal", false],
		["a pre-existing goal", true],
	])("leaves the live roster intact when kickoff fails with %s", async (_, preExistingGoal) => {
		const harness = await createHarness({ guidedAsk: true, ask: "active" });
		try {
			const { mode, session } = harness;
			if (preExistingGoal) await session.setActiveToolsByName([...session.getEnabledToolNames(), "goal"]);
			const before = session.getEnabledToolNames();
			vi.spyOn(session, "prompt").mockRejectedValue(new Error("provider down"));
			const error = vi.spyOn(mode, "showError").mockImplementation(() => {});

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(error).toHaveBeenCalledWith("provider down");
			expect(mode.isGuidedGoalInterviewActive()).toBe(false);
			expect(new Set(session.getEnabledToolNames())).toEqual(new Set(before));
		} finally {
			await harness.cleanup();
		}
	});

	it("warns once on cleanup failure and still lets the next draft through the editor", async () => {
		const rebuildSystemPrompt = vi.fn(async () => ({ systemPrompt: ["Test"] }));
		const harness = await createHarness({ guidedAsk: true, ask: "active", rebuildSystemPrompt });
		try {
			await initMode(harness);
			const { mode, session } = harness;
			const warning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});
			vi.spyOn(session, "prompt").mockImplementation(async () => {
				rebuildSystemPrompt.mockRejectedValue(new Error("cannot rebuild tool presentation"));
				return true;
			});

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(true);
			expect(mode.isGuidedGoalInterviewActive()).toBe(false);

			const nextInput = mode.getUserInput();
			expect(mode.editor.disableSubmit).toBe(false);
			mode.editor.setText("continue in plain conversation");
			mode.editor.submit();
			expect((await nextInput).text).toBe("continue in plain conversation");
			expect(warning).toHaveBeenCalledTimes(1);
			expect(warning.mock.calls[0]![0]).toMatch(/goal tool/i);
		} finally {
			await harness.cleanup();
		}
	});
});
