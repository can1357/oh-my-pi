import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionContext,
	ExtensionFactory,
	ModeChangedEvent,
	SessionModeResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function refusal(result: SessionModeResult): string {
	if (result.ok) throw new Error("Expected the transition to be refused");
	return result.code;
}

function changed(result: SessionModeResult): boolean {
	if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
	return result.changed;
}

describe("ctx.sessionModes in the interactive TUI", () => {
	let registry: ModelRegistry;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => {
		initTheme();
		registry = new ModelRegistry(createInMemoryAuthStorage());
		registry.authStorage.keys.setRuntime("openai", "test-key");
	});
	beforeEach(() => {
		resetSettingsForTest();
		// init() starts a ProcessTerminal; keep it off the real terminal.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		// Settings.init() binds a global singleton to this case's (now deleted) temp cwd.
		resetSettingsForTest();
	});
	afterAll(() => registry.authStorage.close());

	async function createSession(extension: ExtensionFactory, settings: Record<string, unknown> = {}) {
		const dir = TempDir.createSync("omp-session-modes-");
		cleanups.push(() => dir.removeSync());
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated({
				"plan.enabled": true,
				"goal.enabled": true,
				"goal.continuationModes": [],
				"compaction.enabled": false,
				...settings,
			}),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: false,
			workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		cleanups.push(() => session.dispose());
		const provider = createMockModel({ handler: () => ({ content: ["done"] }) });
		session.agent.streamFn = provider.stream;
		return { session, provider };
	}

	/** A real TUI over a loaded extension that records `mode_changed` and keeps a context. */
	async function tui(extra?: ExtensionFactory, settings?: Record<string, unknown>) {
		const events: ModeChangedEvent[] = [];
		let ctx: ExtensionContext | undefined;
		const { session, provider } = await createSession(pi => {
			// First, so the case's own handlers observe state at emit time.
			extra?.(pi);
			pi.on("session_start", (_event, context) => {
				ctx = context;
			});
			pi.on("mode_changed", event => {
				events.push(event);
			});
		}, settings);
		const mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		cleanups.push(() => mode.stop());
		await mode.init();
		const modes = ctx?.sessionModes;
		if (!modes) throw new Error("TUI context must expose sessionModes");
		return { session, provider, mode, modes, events };
	}

	it("a /mission command enters plan, sends its own prompt, and exits without approving or deleting the draft", async () => {
		let planActiveDuringTurn: boolean | undefined;
		const { session, provider, modes, events } = await tui(pi => {
			pi.registerCommand("mission", {
				description: "plan a mission",
				handler: async (args, ctx) => {
					const entered = await ctx.sessionModes!.set({ mode: "plan", action: "enter" });
					if (!entered.ok) throw new Error(entered.message);
					pi.sendUserMessage(args);
				},
			});
		});
		const turnEnded = Promise.withResolvers<void>();
		provider.fallback = () => {
			planActiveDuringTurn = session.getPlanModeState()?.enabled === true;
			return { content: ["planned"] };
		};
		session.subscribe(event => {
			if (event.type === "agent_end") turnEnded.resolve();
		});
		const tools = session.getEnabledToolNames();

		// The extension's own message is a separate turn queued behind the command.
		await session.prompt("/mission chart the repository");
		await turnEnded.promise;
		await session.waitForIdle();
		expect(planActiveDuringTurn).toBe(true);
		expect(provider.calls).toHaveLength(1);
		const draft = modes.getState().plan.planFilePath!;
		const draftPath = resolveLocalUrlToPath(draft, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(draftPath, "# Mission\nKeep me.\n");

		expect(changed(await modes.set({ mode: "plan", action: "exit" }))).toBe(true);
		expect(modes.getState().plan).toEqual({ status: "inactive" });
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(tools);
		expect(await Bun.file(draftPath).text()).toBe("# Mission\nKeep me.\n");
		expect(provider.calls).toHaveLength(1);
		expect(events.map(event => [event.previous.plan.status, event.state.plan.status])).toEqual([
			["inactive", "active"],
			["active", "inactive"],
		]);
	});

	it("keeps the slash commands' conflicts, reports repeats as unchanged, and emits nothing for them", async () => {
		const { session, modes, events } = await tui();
		const tools = session.getEnabledToolNames();
		expect(changed(await modes.set({ mode: "vibe", action: "enter" }))).toBe(true);
		expect(changed(await modes.set({ mode: "vibe", action: "enter" }))).toBe(false);
		expect(refusal(await modes.set({ mode: "plan", action: "enter" }))).toBe("conflict");
		expect(refusal(await modes.set({ mode: "goal", action: "enter", objective: "ship" }))).toBe("conflict");
		expect(events).toHaveLength(1);
		expect(changed(await modes.set({ mode: "vibe", action: "exit" }))).toBe(true);
		expect(session.getVibeModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(tools);
		expect(changed(await modes.set({ mode: "vibe", action: "exit" }))).toBe(false);
		expect(events).toHaveLength(2);
	});

	it("refuses a transition during a turn without touching it, then applies once idle", async () => {
		const { session, provider, modes } = await tui();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		provider.fallback = async () => {
			started.resolve();
			await release.promise;
			return { content: ["released"] };
		};
		const tools = session.getEnabledToolNames();
		const turn = session.prompt("hold");
		await started.promise;
		try {
			expect(refusal(await modes.set({ mode: "plan", action: "enter" }))).toBe("busy");
			expect(session.isStreaming).toBe(true);
			expect(session.getEnabledToolNames()).toEqual(tools);
			expect(modes.getState().plan.status).toBe("inactive");
		} finally {
			release.resolve();
			await turn;
		}
		expect(changed(await modes.set({ mode: "plan", action: "enter" }))).toBe(true);
	});

	it("runs the goal lifecycle with a budget, submits no prompt, and restores tools on drop", async () => {
		const { session, provider, modes } = await tui();
		const tools = session.getEnabledToolNames();
		expect(
			changed(await modes.set({ mode: "goal", action: "enter", objective: "Ship beta", tokenBudget: 5000 })),
		).toBe(true);
		expect(modes.getState().goal).toEqual({ status: "active", objective: "Ship beta", tokenBudget: 5000 });
		expect(session.getEnabledToolNames()).toContain("goal");
		expect(refusal(await modes.set({ mode: "goal", action: "enter", objective: "Something else" }))).toBe(
			"invalid_request",
		);
		expect(changed(await modes.set({ mode: "goal", action: "pause" }))).toBe(true);
		expect(modes.getState().goal.status).toBe("paused");
		// Pausing leaves goal mode: the goal tool goes away until resume.
		expect(session.getEnabledToolNames()).toEqual(tools);
		expect(changed(await modes.set({ mode: "goal", action: "resume" }))).toBe(true);
		expect(changed(await modes.set({ mode: "goal", action: "drop" }))).toBe(true);
		expect(modes.getState().goal).toEqual({ status: "inactive" });
		expect(session.getEnabledToolNames()).toEqual(tools);
		expect(provider.calls).toEqual([]);
	});

	it("rolls back a goal whose tool fails to activate, so a later entry succeeds", async () => {
		const { session, modes } = await tui();
		const tools = session.getEnabledToolNames();
		vi.spyOn(session, "setActiveToolsByName").mockRejectedValueOnce(new Error("tool activation failed"));
		await expect(modes.set({ mode: "goal", action: "enter", objective: "Doomed" })).rejects.toThrow(
			"tool activation failed",
		);
		expect(modes.getState().goal).toEqual({ status: "inactive" });
		expect(session.getGoalModeState()?.goal.status ?? "dropped").toBe("dropped");
		expect(session.getEnabledToolNames()).toEqual(tools);
		expect(changed(await modes.set({ mode: "goal", action: "enter", objective: "Retry" }))).toBe(true);
		expect(modes.getState().goal).toMatchObject({ status: "active", objective: "Retry" });
	});

	it("reports native /goal transitions only after the goal tool has been toggled", async () => {
		const seen: Array<[string, boolean]> = [];
		const live: { session?: AgentSession } = {};
		const harness = await tui(pi => {
			pi.on("mode_changed", event => {
				seen.push([event.state.goal.status, live.session!.getEnabledToolNames().includes("goal")]);
			});
		});
		live.session = harness.session;
		await harness.mode.handleGoalModeCommand("set Ship gamma");
		await harness.mode.handleGoalModeCommand("pause");
		expect(seen).toEqual([
			["active", true],
			["paused", false],
		]);
	});

	it("refuses transitions from session_start until saved modes are restored", async () => {
		const codes: string[] = [];
		const { modes } = await tui(pi => {
			pi.on("session_start", async (_event, ctx) => {
				const result = await ctx.sessionModes!.set({ mode: "plan", action: "enter" });
				codes.push(result.ok ? "ok" : result.code);
			});
		});
		expect(codes).toEqual(["busy"]);
		expect(changed(await modes.set({ mode: "plan", action: "enter" }))).toBe(true);
	});

	it("reports automatic goal completion only once the goal tool is gone", async () => {
		const seen: Array<[string, boolean]> = [];
		const live: { session?: AgentSession } = {};
		const completed = Promise.withResolvers<void>();
		const { session, provider, modes } = await tui(pi => {
			pi.on("mode_changed", event => {
				seen.push([event.state.goal.status, live.session!.getEnabledToolNames().includes("goal")]);
				if (event.state.goal.status === "inactive") completed.resolve();
			});
		});
		live.session = session;
		let calls = 0;
		provider.fallback = () =>
			calls++ === 0
				? { content: [{ type: "toolCall", name: "goal", arguments: { op: "complete" } }] }
				: { content: ["done"] };
		changed(await modes.set({ mode: "goal", action: "enter", objective: "Finish quickly" }));
		await session.prompt("finish");
		// Teardown runs from agent_end, after the turn settles.
		await completed.promise;
		expect(modes.getState().goal).toEqual({ status: "inactive" });
		expect(seen).toEqual([
			["active", true],
			["inactive", false],
		]);
	});

	it("does not report goal accounting as a mode change", async () => {
		const { session, provider, modes, events } = await tui();
		provider.fallback = () => ({ content: ["progress"], usage: { input: 1200, output: 300 } });
		changed(await modes.set({ mode: "goal", action: "enter", objective: "Count tokens" }));
		const reported = events.length;
		await session.prompt("work on it");
		await session.waitForIdle();
		expect(session.getGoalModeState()?.goal.tokensUsed).toBeGreaterThan(0);
		expect(events).toHaveLength(reported);
	});

	it("reports slash-command changes to late readers and lets handlers chain transitions", async () => {
		const { mode, modes, events } = await tui(pi => {
			pi.on("mode_changed", async (event, ctx) => {
				if (event.state.loop.status !== "active") return;
				await ctx.sessionModes!.set({ mode: "loop", action: "exit" });
			});
		});
		await mode.handleLoopCommand("3");
		await Bun.sleep(0);
		// The chaining handler runs first, so the recorder may see the nested exit before the entry.
		expect(events.map(event => `${event.previous.loop.status}->${event.state.loop.status}`).sort()).toEqual([
			"active->inactive",
			"inactive->active",
		]);
		expect(modes.getState().loop.status).toBe("inactive");
		await mode.handlePlanModeCommand();
		await Bun.sleep(0);
		expect(modes.getState().plan.status).toBe("active");
		expect(
			events.some(event => event.previous.plan.status === "inactive" && event.state.plan.status === "active"),
		).toBe(true);
	});

	it("refuses a nested call from the transition's own goal_updated handler instead of deadlocking", async () => {
		const nested: string[] = [];
		const { modes } = await tui(pi => {
			pi.on("goal_updated", async (_event, ctx) => {
				nested.push(refusal(await ctx.sessionModes!.set({ mode: "goal", action: "drop" })));
			});
		});
		changed(await modes.set({ mode: "goal", action: "enter", objective: "No deadlock" }));
		expect(nested[0]).toBe("busy");
		expect(modes.getState().goal.status).toBe("active");
	});

	it("rejects malformed requests and honors settings gates", async () => {
		const { modes } = await tui(undefined, { "plan.enabled": false });
		expect(refusal(await modes.set({ mode: "plan", action: "enter" }))).toBe("disabled");
		for (const request of [
			{ mode: "goal", action: "enter", objective: " " },
			{ mode: "goal", action: "enter", objective: "x", tokenBudget: 0 },
			{ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 1.5 } },
			// Cannot be decremented, so the loop would never end.
			{ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 1e20 } },
			{ mode: "loop", action: "enter", condition: { command: "", until: true } },
			{ mode: "loop", action: "enter", prompt: "  " },
			{ mode: "goal", action: "resume" },
			{ mode: "turbo", action: "enter" },
		]) {
			expect(refusal(await modes.set(request as Parameters<typeof modes.set>[0]))).toBe("invalid_request");
		}
		expect(modes.getState()).toEqual({
			plan: { status: "inactive" },
			vibe: { status: "inactive" },
			goal: { status: "inactive" },
			loop: { status: "inactive" },
		});
	});

	it("refuses every transition when extension mode control is turned off, while state stays readable", async () => {
		const { modes } = await tui(undefined, { "extensionHandlers.modeControl": false });
		expect(refusal(await modes.set({ mode: "plan", action: "enter" }))).toBe("disabled");
		expect(refusal(await modes.set({ mode: "loop", action: "exit" }))).toBe("disabled");
		expect(modes.getState().plan.status).toBe("inactive");
	});

	it("reports a session switch once it settles and refuses transitions while it runs", async () => {
		const seenMidSwitch: boolean[] = [];
		const live: { session?: AgentSession } = {};
		const { session, modes, events } = await tui(pi => {
			pi.on("mode_changed", () => {
				seenMidSwitch.push(live.session!.isSessionTransitioning);
			});
		});
		live.session = session;
		await session.prompt("hello");
		await session.waitForIdle();
		changed(await modes.set({ mode: "plan", action: "enter" }));
		const planSession = session.sessionFile!;

		// A request racing the switch is refused instead of landing in either session.
		const switching = session.newSession();
		expect(refusal(await modes.set({ mode: "vibe", action: "enter" }))).toBe("busy");
		await switching;
		await Bun.sleep(0);
		expect(modes.getState().vibe.status).toBe("inactive");

		changed(await modes.set({ mode: "plan", action: "enter" }));
		await Bun.sleep(0);
		events.length = 0;
		seenMidSwitch.length = 0;
		// Plan → plan: restore clears plan mode and re-enters it; neither step is reported.
		await session.switchSession(planSession);
		await Bun.sleep(0);
		expect(events).toEqual([]);
		expect(modes.getState().plan.status).toBe("active");

		// Plan → none: reported once, after the switch, so the handler can act on it.
		await session.newSession();
		await Bun.sleep(0);
		expect(events.map(event => [event.previous.plan.status, event.state.plan.status])).toEqual([
			["active", "inactive"],
		]);
		expect(seenMidSwitch).toEqual([false]);
		expect(changed(await modes.set({ mode: "vibe", action: "enter" }))).toBe(true);
	});

	it("repeats an extension's loop prompt after the turn it sent, and resumes a paused loop", async () => {
		const { session, mode, modes } = await tui(pi => {
			pi.registerCommand("grind", {
				description: "loop a prompt",
				handler: async (args, ctx) => {
					const entered = await ctx.sessionModes!.set({ mode: "loop", action: "enter", prompt: args });
					if (!entered.ok) throw new Error(entered.message);
					pi.sendUserMessage(args);
				},
			});
		});
		// The TUI sits idle waiting for input while the extension's turn runs.
		const nextInput = mode.getUserInput();
		await session.prompt("/grind polish the docs");
		await session.waitForIdle();
		// The loop's next iteration resolves the pending input with the extension's prompt.
		expect(await nextInput).toMatchObject({ text: "polish the docs" });

		mode.pauseLoop();
		expect(modes.getState().loop.status).toBe("paused");
		expect(changed(await modes.set({ mode: "loop", action: "enter" }))).toBe(true);
		expect(modes.getState().loop.status).toBe("active");
		expect(
			refusal(await modes.set({ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 2 } })),
		).toBe("invalid_request");
	});

	it("is absent outside the TUI so headless extensions can detect it", async () => {
		let ctx: ExtensionContext | undefined;
		const { session } = await createSession(pi => {
			pi.on("session_start", (_event, context) => {
				ctx = context;
			});
		});
		await initializeExtensions(session as AgentSession, {
			mode: "print",
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		expect(ctx).toBeDefined();
		expect(ctx?.sessionModes).toBeUndefined();
	});
});
