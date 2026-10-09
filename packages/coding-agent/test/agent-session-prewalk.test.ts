import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgPrewalkEnabled,
	cfgRetryBaseDelayMs,
	cfgRetryFallbackChains,
	cfgRetryFallbackRevertPolicy,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/**
 * Prewalk: one-way switch from the starting model to a fast/cheap target
 * at the first completed turn that starts execution — an edit/write tool,
 * or the todo-list init the plan nudge asks for — with a hidden plan nudge
 * before the switch and a hidden verify-before-finishing checklist after
 * it. This is the single mechanism that won out over fixed-turn and
 * ungated variants in benchmark testing — see the plan nudge / checklist /
 * continuation-safety-net prompts under `src/prompts/system/prewalk-*.md`.
 */
describe("AgentSession prewalk", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-prewalk-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		vi.restoreAllMocks();
		modelRegistry.clearSuppressedSelectors();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected bundled model ${id}`);
		return model;
	}

	const recordToolSchema = type({});
	const recordTool: AgentTool<typeof recordToolSchema, undefined> = {
		name: "record",
		label: "Record",
		description: "Read-only step",
		parameters: recordToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
	const bashToolSchema = type({});
	const bashTool: AgentTool<typeof bashToolSchema, undefined> = {
		name: "bash",
		label: "Bash",
		description: "Run a command",
		parameters: bashToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ran" }], details: undefined };
		},
	};
	const writeToolSchema = type({});
	const writeTool: AgentTool<typeof writeToolSchema, undefined> = {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: writeToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "wrote" }], details: undefined };
		},
	};
	const todoToolSchema = type({});
	const todoTool: AgentTool<typeof todoToolSchema, undefined> = {
		name: "todo",
		label: "Todo",
		description: "Track tasks",
		parameters: todoToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "listed" }], details: undefined };
		},
	};
	const toolRegistry = new Map<string, AgentTool>([
		[recordTool.name, recordTool as AgentTool],
		[bashTool.name, bashTool as AgentTool],
		[writeTool.name, writeTool as AgentTool],
		[todoTool.name, todoTool as AgentTool],
	]);

	function toolCall(id: string, name: string): MockResponse {
		return { content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" };
	}

	function createLifecycleSession(
		responses: MockResponse[],
		options: {
			enabled?: boolean;
			armed?: boolean;
			agentKind?: "main" | "sub";
			sessionManager?: SessionManager;
			target?: Model;
			startupTarget?: Model;
			targetThinkingLevel?: Effort | typeof AUTO_THINKING;
		} = {},
	) {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = options.target ?? modelOrThrow("claude-sonnet-4-6");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"prewalk.enabled": options.enabled ?? true,
		});
		// Resolution must honor role fallback lists and the target effort suffix.
		settings.setModelRole("smol", `anthropic/missing-model,${target.provider}/${target.id}:low`);
		const mock = createMockModel({ responses });
		const requested: string[] = [];
		const efforts: Array<ThinkingLevel | undefined> = [];
		const nudges: string[][] = [];
		let requestNudges: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [todoTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.High,
			},
			convertToLlm: messages => {
				requestNudges = messages.flatMap(message =>
					message.role === "custom" && message.customType.startsWith("prewalk-") ? [message.customType] : [],
				);
				return convertToLlm(messages);
			},
			streamFn: (model, context, streamOptions) => {
				requested.push(model.id);
				efforts.push(agent.state.thinkingLevel);
				nudges.push(requestNudges);
				return mock.stream(model, context, streamOptions);
			},
		});
		const created = new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.High,
			agentKind: options.agentKind,
			prewalk:
				options.armed === false
					? undefined
					: { target: options.startupTarget ?? target, thinkingLevel: options.targetThinkingLevel ?? Effort.Low },
		});
		session = created;
		return { session: created, primary, target, settings, requested, nudges, efforts };
	}

	it("classifies an auto prewalk target against the subagent solution space before continuing", async () => {
		const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		const created = createLifecycleSession(
			[toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
			{ agentKind: "sub", targetThinkingLevel: AUTO_THINKING },
		);

		await created.session.prompt("Edit the scratch file", { solutionSpace: "A single-line change" });

		expect(classifier).toHaveBeenCalledTimes(1);
		expect(classifier.mock.calls[0]?.[0]).toEqual({
			request: "Edit the scratch file",
			solutionSpace: "A single-line change",
		});
		expect(classifier.mock.calls[0]?.[1].model.id).toBe(created.target.id);
		expect(created.requested).toEqual([created.primary.id, created.primary.id, created.target.id]);
		expect(created.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(created.session.autoResolvedThinkingLevel()).toBe(Effort.Low);
		expect(created.efforts).toEqual([Effort.High, Effort.High, Effort.Low]);
	});

	it("reclassifies the auto target for its own model after an auto planning model", async () => {
		const classifier = vi
			.spyOn(autoThinkingClassifier, "classifyDifficulty")
			.mockImplementation(async (_input, options) =>
				options.model.id === "claude-sonnet-4-5" ? Effort.Medium : Effort.Low,
			);
		const created = createLifecycleSession(
			[toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
			{ targetThinkingLevel: AUTO_THINKING },
		);
		created.session.setThinkingLevel(AUTO_THINKING);

		await created.session.prompt("Fix the parser");

		expect(classifier.mock.calls.map(([, options]) => options.model.id)).toEqual([
			created.primary.id,
			created.target.id,
		]);
		expect(created.efforts).toEqual([Effort.Medium, Effort.Medium, Effort.Low]);
	});

	it("/new restores the previous prewalk source and effort, then requires a fresh todo before handoff", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			toolCall("fresh-write-before-todo", "write"),
			toolCall("fresh-todo", "todo"),
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		await created.session.prompt("old task");
		expect(created.session.model?.id).toBe(created.target.id);
		expect(created.session.thinkingLevel).toBe(Effort.Low);
		const boundary = created.requested.length;

		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(created.primary.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.High);
		expect(created.session.getPrewalkState()?.target.id).toBe(created.target.id);
		expect(created.session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([
			created.primary.id,
			created.primary.id,
			created.primary.id,
			created.target.id,
		]);
		expect(created.nudges[boundary]).not.toContain("prewalk-checklist");
	});

	it("/new restores the prewalk source and effort after automatic fallback and primary restoration", async () => {
		const fallback = modelOrThrow("claude-opus-4-6");
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			{ throw: "rate limit exceeded retry-after-ms=200" },
			{ content: ["fallback done"] },
			{ content: ["restored done"] },
			toolCall("fresh-write-before-todo", "write"),
			toolCall("fresh-todo", "todo"),
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		cfgRetryBaseDelayMs.override(created.settings, 5);
		cfgRetryFallbackChains.override(created.settings, {
			[`${created.target.provider}/${created.target.id}`]: [`${fallback.provider}/${fallback.id}:high`],
		});
		cfgRetryFallbackRevertPolicy.override(created.settings, "cooldown-expiry");
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		mockSchedulerWaitWithClock();

		await created.session.prompt("old task");
		expect(created.session.model?.id).toBe(created.target.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.Low);
		const retryBoundary = created.requested.length;
		await created.session.prompt("continue through a rate limit");
		await created.session.waitForIdle();
		expect(created.requested.slice(retryBoundary)).toEqual([created.target.id, fallback.id]);
		expect(created.session.model?.id).toBe(fallback.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.High);

		now += 240;
		await created.session.prompt("continue after the primary cooldown");
		await created.session.waitForIdle();
		expect(created.requested.slice(retryBoundary)).toEqual([created.target.id, fallback.id, created.target.id]);
		expect(created.session.model?.id).toBe(created.target.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.Low);

		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(created.primary.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.High);
		expect(created.session.getPrewalkState()?.target.id).toBe(created.target.id);
		expect(created.session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
		const freshBoundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(freshBoundary)).toEqual([
			created.primary.id,
			created.primary.id,
			created.primary.id,
			created.target.id,
		]);
		expect(created.nudges[freshBoundary]).not.toContain("prewalk-checklist");
	});

	it("/new restores automatic effort after a prewalk handoff pins target effort", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			toolCall("fresh-todo", "todo"),
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		created.session.setThinkingLevel(AUTO_THINKING);
		await created.session.prompt("old task");
		expect(created.session.isAutoThinking).toBe(false);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(created.primary.id);
		expect(created.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		const boundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([created.primary.id, created.primary.id, created.target.id]);
		expect(created.session.isAutoThinking).toBe(false);
	});

	it("/new restores planning effort after an effort-only prewalk on the same model", async () => {
		const created = createLifecycleSession(
			[
				toolCall("old-todo", "todo"),
				toolCall("old-write", "write"),
				{ content: ["old done"] },
				toolCall("fresh-todo", "todo"),
				toolCall("fresh-write", "write"),
				{ content: ["fresh done"] },
			],
			{ target: modelOrThrow("claude-sonnet-4-5") },
		);
		await created.session.prompt("old task");
		expect(created.session.thinkingLevel).toBe(Effort.Low);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.thinkingLevel).toBe(Effort.High);
		expect(created.session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
		await created.session.prompt("fresh task");
		expect(created.session.thinkingLevel).toBe(Effort.Low);
		expect(created.session.getPrewalkState()).toBeUndefined();
	});

	it("/new resolves the configured target instead of reusing a custom startup target", async () => {
		const startupTarget = modelOrThrow("claude-opus-4-6");
		const created = createLifecycleSession(
			[
				toolCall("old-todo", "todo"),
				toolCall("old-write", "write"),
				{ content: ["old done"] },
				toolCall("fresh-todo", "todo"),
				toolCall("fresh-write", "write"),
				{ content: ["fresh done"] },
			],
			{ startupTarget },
		);
		await created.session.prompt("old task");
		expect(created.session.model?.id).toBe(startupTarget.id);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.getPrewalkState()?.target.id).toBe(created.target.id);
		const boundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([created.primary.id, created.primary.id, created.target.id]);
	});

	it("/new before handoff clears the old todo gate and injects fresh planning guidance", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			{ content: ["old plan"] },
			{ content: ["old done"] },
			toolCall("fresh-write-before-todo", "write"),
			toolCall("fresh-todo", "todo"),
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		await created.session.prompt("old task");
		expect(created.session.model?.id).toBe(created.primary.id);
		const boundary = created.requested.length;
		expect(await created.session.newSession()).toBe(true);
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([
			created.primary.id,
			created.primary.id,
			created.primary.id,
			created.target.id,
		]);
		expect(created.nudges[boundary]).toEqual([]);
		expect(created.nudges[boundary + 1]).toContain("prewalk-plan");
	});

	it("/new re-arms configured prewalk after session-only /prewalk off", async () => {
		const created = createLifecycleSession([
			toolCall("cancelled-write", "write"),
			{ content: ["cancelled done"] },
			toolCall("fresh-todo", "todo"),
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		const ctx = {
			session: created.session,
			sessionManager: created.session.sessionManager,
			settings: created.settings,
			collabGuest: false,
			showStatus: vi.fn(),
			editor: { setText: vi.fn() },
			refreshSlashCommandState: vi.fn(),
		} as unknown as InteractiveModeContext;
		expect(await executeBuiltinSlashCommand("/prewalk off", { ctx })).toBe(true);
		expect(cfgPrewalkEnabled.get(created.settings)).toBe(true);
		await created.session.prompt("cancelled task");
		expect(created.requested).toEqual([created.primary.id, created.primary.id]);
		const boundary = created.requested.length;
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.getPrewalkState()?.target.id).toBe(created.target.id);
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([created.primary.id, created.primary.id, created.target.id]);
	});

	it("/new does not restore a prewalk source or re-arm when prewalk is disabled", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		await created.session.prompt("old task");
		cfgPrewalkEnabled.override(created.settings, false);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(created.target.id);
		expect(created.session.getPrewalkState()).toBeUndefined();
		const boundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([created.target.id, created.target.id]);
		expect(created.nudges[boundary]).toEqual([]);
	});

	it("/new drops an unfinished prewalk when disabled and a later enable needs a fresh todo", async () => {
		const created = createLifecycleSession(
			[
				toolCall("old-todo", "todo"),
				{ content: ["old plan"] },
				{ content: ["old done"] },
				toolCall("fresh-write-before-todo", "write"),
				toolCall("fresh-todo", "todo"),
				toolCall("fresh-write", "write"),
				{ content: ["fresh done"] },
			],
			{ enabled: false },
		);
		await created.session.prompt("old task");
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.getPrewalkState()).toBeUndefined();
		cfgPrewalkEnabled.override(created.settings, true);
		const boundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([
			created.primary.id,
			created.primary.id,
			created.primary.id,
			created.target.id,
		]);
	});

	it("/new preserves a deliberate manual model selection after prewalk handoff", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			toolCall("fresh-todo", "todo"),
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		await created.session.prompt("old task");
		const manual = modelOrThrow("claude-opus-4-6");
		await created.session.setModel(manual);
		created.session.setThinkingLevel(Effort.Medium);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(manual.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.Medium);
		const boundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([manual.id, manual.id, created.target.id]);
	});

	it("/new retains handoff ownership after a failed selection and no-op role cycle", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
		]);
		await created.session.prompt("old task");
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValueOnce(false);
		await expect(created.session.setModel(created.target)).rejects.toThrow("No API key");
		expect(await created.session.cycleRoleModels(["smol"])).toBeUndefined();
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(created.primary.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.High);
		expect(created.session.getPrewalkState()?.target.id).toBe(created.target.id);
	});

	it("/new completes and stays on the handoff model when the planning model lost its credentials", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			{ content: ["fresh done"] },
		]);
		await created.session.prompt("old task");
		const oldSessionId = created.session.sessionId;
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockImplementation(model => model.id !== created.primary.id);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.sessionId).not.toBe(oldSessionId);
		expect(created.session.model?.id).toBe(created.target.id);
		const boundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([created.target.id]);
	});

	it("/new preserves a deliberate selection of the same handoff model and effort", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			{ content: ["fresh done"] },
		]);
		await created.session.prompt("old task");
		await created.session.setModel(created.target);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(created.target.id);
		expect(created.session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(created.session.getPrewalkState()).toBeUndefined();
		const boundary = created.requested.length;
		await created.session.prompt("fresh task");
		expect(created.requested.slice(boundary)).toEqual([created.target.id]);
	});

	it("/new preserves a manual effort choice on the handoff model", async () => {
		const created = createLifecycleSession([
			toolCall("old-todo", "todo"),
			toolCall("old-write", "write"),
			{ content: ["old done"] },
			toolCall("fresh-todo", "todo"),
			toolCall("fresh-write", "write"),
			{ content: ["fresh done"] },
		]);
		await created.session.prompt("old task");
		created.session.setThinkingLevel(Effort.High);
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.model?.id).toBe(created.target.id);
		expect(created.session.thinkingLevel).toBe(Effort.High);
		expect(created.session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
		await created.session.prompt("fresh task");
		expect(created.session.thinkingLevel).toBe(Effort.Low);
	});

	it("/new automatically arms only main sessions, including a startup session without prewalk", async () => {
		const created = createLifecycleSession(
			[toolCall("fresh-todo", "todo"), toolCall("fresh-write", "write"), { content: ["fresh done"] }],
			{ armed: false },
		);
		expect(await created.session.newSession()).toBe(true);
		await created.session.prompt("fresh task");
		expect(created.requested).toEqual([created.primary.id, created.primary.id, created.target.id]);
	});

	it("/new does not automatically arm subagent sessions", async () => {
		const created = createLifecycleSession([toolCall("fresh-write", "write"), { content: ["fresh done"] }], {
			armed: false,
			agentKind: "sub",
		});
		expect(await created.session.newSession()).toBe(true);
		expect(created.session.getPrewalkState()).toBeUndefined();
		await created.session.prompt("fresh task");
		expect(created.requested).toEqual([created.primary.id, created.primary.id]);
	});

	it("resuming an existing transcript does not automatically re-arm configured prewalk", async () => {
		const created = createLifecycleSession([toolCall("resumed-write", "write"), { content: ["resumed done"] }], {
			armed: false,
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "resume-active")),
		});
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "resume"));
		manager.appendModelChange(`${created.target.provider}/${created.target.id}`);
		manager.appendThinkingLevelChange(Effort.Low);
		manager.appendMessage({ role: "user", content: "existing task", timestamp: Date.now() });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted resume fixture");
		await manager.close();
		expect(await created.session.switchSession(file)).toBe(true);
		expect(created.session.getPrewalkState()).toBeUndefined();
		await created.session.prompt("resume task");
		expect(created.requested).toEqual([created.target.id, created.target.id]);
	});

	it("prewalks at the first edit/write after the todo gate opens; bash and todo don't trigger", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		// Turn 1: read-only. Turn 2: bash is excluded. Turn 3: todo opens the gate.
		// Turn 4: write is the first post-todo edit/write, so it switches.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "bash"),
				toolCall("t3", "todo"),
				toolCall("t4", "write"),
				{ content: ["done"] },
			],
		});
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, bashTool as AgentTool, writeTool as AgentTool, todoTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, _context, options) => {
				calls.push(`${model.provider}/${model.id}`);
				return mock.stream(model, _context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(calls).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("an edit before any todo call does not switch while a todo tool exists; the next edit after todo does", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		// Turn 1: exploration. Turn 2: write while the gate is closed.
		// Turn 3: todo opens the gate. Turn 4: write switches.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "write"),
				toolCall("t3", "todo"),
				toolCall("t4", "write"),
				{ content: ["done"] },
			],
		});
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool, todoTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, _context, options) => {
				calls.push(`${model.provider}/${model.id}`);
				return mock.stream(model, _context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(calls).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("keeps the todo gate closed after a failed todo call", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		const failingTodoTool: AgentTool<typeof todoToolSchema, undefined> = {
			...todoTool,
			async execute() {
				return {
					content: [{ type: "text", text: "todo update failed" }],
					details: undefined,
					isError: true,
				};
			},
		};
		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "todo"), toolCall("t3", "write"), { content: ["done"] }],
		});
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool, failingTodoTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				calls.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([...toolRegistry, ["todo", failingTodoTool as AgentTool]]),
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(calls).toEqual(Array(5).fill(`${primary.provider}/${primary.id}`));
		expect(session.model?.id).toBe(primary.id);
	});

	it("forces a continuation when the plan nudge gets a text-only reply, instead of silently ending the run", async () => {
		// Regression: the agent loop treats a turn with zero tool calls as a
		// natural stop boundary and ends the session with no further prompting.
		// The plan nudge explicitly asks for a prose reply, making this common
		// right after it — observed killing production runs before any code
		// was written. The safety net must force one more turn.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				{ content: [{ type: "text", text: "Let me think about this for a moment." }], stopReason: "stop" },
				toolCall("t3", "write"),
				{ content: ["done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([
				[recordTool.name, recordTool as AgentTool],
				[writeTool.name, writeTool as AgentTool],
			]),
			prewalk: { target },
		});

		await session.prompt("do the task");

		// All 4 turns must run — the text-only turn 2 must not end the session early.
		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("bounds a completed bash-only task to a single continuation instead of looping", async () => {
		// Regression (#5551): with no edit/write ever run, the continuation net
		// used to re-fire on every text-only reply, looping forever. It must
		// fire at most once — one "continue" nudge — then let the next text-only
		// reply end the run. No mock fallback: a stray extra turn rejects.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		// Turn 1: record (nudge injected after). Turn 2: bash — not an action
		// tool. Turn 3: prose — the single continuation fires. Turn 4: prose
		// again — no more continuation, run ends. A 5th call would exhaust the
		// script and reject.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "bash"),
				{ content: [{ type: "text", text: "Commit complete." }], stopReason: "stop" },
				{ content: [{ type: "text", text: "Nothing left to do." }], stopReason: "stop" },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, bashTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("commit the current changes");

		// Exactly one continuation: 4 turns, all on the primary (no edit/write,
		// so no switch), then a clean stop.
		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
		]);
		expect(session.model?.id).toBe(primary.id);
	});

	it("does not switch on a read-only xd:// device dispatched through write (issue #7312)", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		// A read-only lsp navigation is dispatched as `write xd://lsp`; the write
		// result carries the wrapped tool's read tier. Like a bash step, it must
		// not arm the hand-off — the model keeps reasoning about code shape on the
		// strong model. Mirrors the bounded-continuation flow: one continuation,
		// four turns, all primary, then a clean stop.
		const readDeviceWrite: AgentTool<typeof writeToolSchema, { xdev: { tool: string; mode: string; tier: string } }> =
			{
				name: "write",
				label: "Write",
				description: "Dispatch a read-only device",
				parameters: writeToolSchema,
				async execute() {
					return {
						content: [{ type: "text", text: "references" }],
						details: { xdev: { tool: "lsp", mode: "execute", tier: "read" } },
					};
				},
			};
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "write"),
				{ content: [{ type: "text", text: "Still planning." }], stopReason: "stop" },
				{ content: [{ type: "text", text: "Done planning." }], stopReason: "stop" },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, readDeviceWrite as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([
				[recordTool.name, recordTool as AgentTool],
				[readDeviceWrite.name, readDeviceWrite as AgentTool],
			]),
			prewalk: { target },
		});

		await session.prompt("investigate the code shape");

		expect(requested).toEqual(Array(4).fill(`${primary.provider}/${primary.id}`));
		expect(session.model?.id).toBe(primary.id);
	});

	it("switches on a write-tier xd:// device dispatched through write (issue #7312)", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		// An lsp rename is a write-tier device call — it must arm the hand-off
		// just like a direct edit/write: the write turn stays on the strong model,
		// the next turn runs on the target.
		const writeDeviceWrite: AgentTool<
			typeof writeToolSchema,
			{ xdev: { tool: string; mode: string; tier: string } }
		> = {
			name: "write",
			label: "Write",
			description: "Dispatch a write-tier device",
			parameters: writeToolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "renamed" }],
					details: { xdev: { tool: "lsp", mode: "execute", tier: "write" } },
				};
			},
		};
		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "write"), { content: ["done"] }],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeDeviceWrite as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([
				[recordTool.name, recordTool as AgentTool],
				[writeDeviceWrite.name, writeDeviceWrite as AgentTool],
			]),
			prewalk: { target },
		});

		await session.prompt("rename the symbol");

		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("re-arms continuation after tool progress between prose turns", async () => {
		// Regression: a normal prewalk can split planning across several turns:
		// prose plan, todo init, then prose before implementation. Each tool
		// progress segment must earn one continuation so the second prose turn
		// cannot end the run before edit/write.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		// Turn 1: read-only (nudge injected after). Turn 2: prose plan —
		// bridged. Turn 3: todo — gate opens and re-arms the net. Turn 4:
		// prose — bridged again. Turn 5: write — switch.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				{ content: [{ type: "text", text: "Here is the plan." }], stopReason: "stop" },
				toolCall("t3", "todo"),
				{ content: [{ type: "text", text: "Plan captured, starting now." }], stopReason: "stop" },
				toolCall("t5", "write"),
				{ content: ["done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool, todoTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("skips the todo gate when todo is registered but not active (subagent-style restricted slates)", async () => {
		// Regression: the gate used to key on the tool REGISTRY, so a session
		// whose active-tool slate excluded `todo` (subagents strip it) while the
		// registry still contained it could never open the gate — the model
		// cannot call an inactive tool — and prewalk never fired.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		// Turn 1: read-only (nudge injected after). Turn 2: write — first
		// edit/write must switch immediately; no todo call is possible.
		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "write"), { content: ["done"] }],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				// Active slate excludes todo; the session toolRegistry still has it.
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("armPrewalk (the /prewalk slash command) pre-arms the switch for the very next edit/write", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomMessageEntry(
			"prewalk-plan",
			"legacy plan nudge written by an older OMP version",
			false,
			undefined,
			"agent",
		);

		// No `prewalk` in the session config — this simulates a session that
		// was NOT started with --prewalk, forced on via the slash command.
		const mock = createMockModel({ responses: [toolCall("t1", "write"), { content: ["done"] }] });
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[writeTool.name, writeTool as AgentTool]]),
		});

		// Arming twice back-to-back must stay a single, idempotent arm.
		expect(session.armPrewalk(target)).toBe(true);
		expect(session.armPrewalk(target)).toBe(true);

		await session.prompt("do the task");

		// Pre-armed before the first turn: the very first write call switches
		// immediately — no second primary-model turn needed.
		expect(requested).toEqual([`${primary.provider}/${primary.id}`, `${target.provider}/${target.id}`]);
		expect(session.model?.id).toBe(target.id);
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(message => message.role === "custom" && message.customType === "prewalk-plan"),
		).toBe(false);
		// The seeded legacy entry must remain the only transcript copy; persisting
		// the current arm's transient nudge would make this count two.
		expect(
			sessionManager
				.buildSessionContext({ transcript: true })
				.messages.filter(message => message.role === "custom" && message.customType === "prewalk-plan"),
		).toHaveLength(1);
	});

	it("armPrewalk rejects a same-model same-effort no-op", async () => {
		const model = modelOrThrow("claude-sonnet-4-5");

		const mock = createMockModel({ responses: [{ content: ["status only"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (streamModel, _context, options) => mock.stream(streamModel, _context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.Medium,
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "prewalk") notices.push(event.message);
		});

		expect(session.armPrewalk(model, Effort.Medium)).toBe(false);
		await session.prompt("report current status");

		expect(notices.some(message => message.includes("nothing to switch"))).toBe(true);
	});

	it("/prewalk commands report success only when the requested arm becomes active", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.Medium,
		});
		const showStatus = vi.fn();
		const ctx = {
			session,
			sessionManager,
			settings,
			collabGuest: false,
			showStatus,
			editor: { setText: vi.fn() },
			refreshSlashCommandState: vi.fn(),
		} as unknown as InteractiveModeContext;
		const runtime = { ctx } satisfies TuiSlashCommandRuntime;

		settings.setModelRole("smol", `${primary.provider}/${primary.id}:medium`);
		expect(await executeBuiltinSlashCommand("/prewalk", runtime)).toBe(true);
		expect(showStatus).not.toHaveBeenCalled();

		settings.setModelRole("smol", `${target.provider}/${target.id}:medium`);
		expect(await executeBuiltinSlashCommand("/prewalk", runtime)).toBe(true);
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith(
			`Prewalk on: switching to ${target.provider}/${target.id} at the next edit/write (todo-gated).`,
		);

		// A different request cannot report success while the prior target remains armed.
		settings.setModelRole("smol", `${primary.provider}/${primary.id}:medium`);
		expect(await executeBuiltinSlashCommand("/prewalk", runtime)).toBe(true);
		expect(showStatus).toHaveBeenCalledTimes(1);

		// Restart must not move the active model when an existing arm rejects the requested target.
		settings.setModelRole("default", `${target.provider}/${target.id}:medium`);
		expect(await executeBuiltinSlashCommand("/prewalk restart", runtime)).toBe(true);
		expect(session.model?.id).toBe(primary.id);
		expect(session.getPrewalkState()?.target.id).toBe(target.id);
		expect(showStatus).toHaveBeenCalledTimes(1);

		// A matching arm remains active while restart restores the configured planning model.
		await session.setModelTemporary(target, Effort.Medium, { ephemeral: true });
		settings.setModelRole("default", `${primary.provider}/${primary.id}:medium`);
		settings.setModelRole("smol", `${target.provider}/${target.id}:medium`);
		expect(await executeBuiltinSlashCommand("/prewalk restart", runtime)).toBe(true);
		expect(session.model?.id).toBe(primary.id);
		expect(session.getPrewalkState()?.target.id).toBe(target.id);
		expect(showStatus).toHaveBeenCalledTimes(2);

		// If both roles now coincide, restart resets the model and clears the obsolete matching arm.
		settings.setModelRole("default", `${target.provider}/${target.id}:medium`);
		expect(await executeBuiltinSlashCommand("/prewalk restart", runtime)).toBe(true);
		expect(session.model?.id).toBe(target.id);
		expect(session.getPrewalkState()).toBeUndefined();
		expect(
			agent.state.messages.some(message => message.role === "custom" && message.customType === "prewalk-plan"),
		).toBe(false);
		expect(showStatus).toHaveBeenCalledTimes(3);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Prewalk reset"));
	});

	it("/prewalk restart returns to @default and re-arms @smol", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const mock = createMockModel({
			responses: [
				toolCall("first-todo", "todo"),
				toolCall("first-write", "write"),
				{ content: ["first done"] },
				toolCall("second-todo", "todo"),
				toolCall("second-write", "write"),
				{ content: ["second done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [todoTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `anthropic/missing-model,${primary.provider}/${primary.id}:medium`);
		settings.setModelRole("smol", `${target.provider}/${target.id}:medium`);
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			prewalk: { target, thinkingLevel: Effort.Medium },
			thinkingLevel: Effort.Medium,
		});

		await session.prompt("first task");
		expect(session.model?.id).toBe(target.id);
		const firstRunCallCount = requested.length;

		const showStatus = vi.fn();
		const ctx = {
			session,
			sessionManager,
			settings,
			collabGuest: false,
			showStatus,
			editor: { setText: vi.fn() },
			refreshSlashCommandState: vi.fn(),
		} as unknown as InteractiveModeContext;
		const runtime = { ctx } satisfies TuiSlashCommandRuntime;

		expect(await executeBuiltinSlashCommand("/prewalk restart", runtime)).toBe(true);
		expect(session.model?.id).toBe(primary.id);
		expect(session.getPrewalkState()?.target.id).toBe(target.id);
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Prewalk restarted"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining(`${primary.provider}/${primary.id}`));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining(`${target.provider}/${target.id}`));

		await session.prompt("second task");
		expect(requested.slice(firstRunCallCount)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);

		settings.setModelRole("smol", `${primary.provider}/${primary.id}:medium`);
		expect(await executeBuiltinSlashCommand("/prewalk restart", runtime)).toBe(true);
		expect(session.model?.id).toBe(primary.id);
		expect(session.getPrewalkState()).toBeUndefined();
		expect(showStatus).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Prewalk reset"));
	});

	it("requires a fresh todo before a later explicit prewalk can hand off", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");

		const mock = createMockModel({
			responses: [
				toolCall("first-todo", "todo"),
				toolCall("first-write", "write"),
				{ content: ["first done"] },
				toolCall("second-write-before-todo", "write"),
				toolCall("second-todo", "todo"),
				toolCall("second-write-after-todo", "write"),
				{ content: ["second done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [todoTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("first task");
		const firstRunCallCount = requested.length;
		expect(session.model?.id).toBe(target.id);

		session.armPrewalk(primary);
		await session.prompt("second task");

		expect(requested.slice(firstRunCallCount)).toEqual([
			`${target.provider}/${target.id}`,
			`${target.provider}/${target.id}`,
			`${target.provider}/${target.id}`,
			`${primary.provider}/${primary.id}`,
		]);
		expect(session.model?.id).toBe(primary.id);
	});

	it("effort-only prewalk on the same model downgrades the thinking level instead of silently skipping", async () => {
		// Regression (#6659): the switch guard compared model identity only, so a
		// same-model target at a cheaper thinking level (a legitimate effort
		// downgrade, common with role aliases like `prewalk: "@task"`) was dropped
		// as a no-op. On a reasoning model the effort is the bulk of the cost, so
		// this must still switch.
		const model = modelOrThrow("claude-sonnet-4-5");

		// todo excluded from the active slate → the gate opens; record then write.
		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "write"), { content: ["done"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (streamModel, _context, options) => mock.stream(streamModel, _context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.Medium,
			prewalk: { target: model, thinkingLevel: Effort.Low },
		});

		expect(session.thinkingLevel).toBe(Effort.Medium);

		await session.prompt("do the task");

		// The model id never changes, but the effort drops after the first write.
		expect(session.model?.id).toBe(model.id);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("emits a notice when the prewalk target is a genuine no-op", async () => {
		// Same model and same effective thinking level: no state change.
		const model = modelOrThrow("claude-sonnet-4-5");

		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "write"), { content: ["done"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (streamModel, _context, options) => mock.stream(streamModel, _context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.Medium,
			prewalk: { target: model, thinkingLevel: Effort.Medium },
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "prewalk") notices.push(event.message);
		});

		await session.prompt("do the task");

		expect(session.model?.id).toBe(model.id);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		// The no-op is announced, not silent.
		expect(notices.some(message => message.includes("nothing to switch"))).toBe(true);
	});

	it("treats a target effort the model clamps back to the active effort as a no-op", async () => {
		// A model capped at high resolves an xhigh target back to high.
		// The equal effective settings must be recognized as a no-op.
		const model = modelOrThrow("claude-sonnet-4-6"); // supported efforts cap at high

		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "write"), { content: ["done"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.High,
			},
			convertToLlm,
			streamFn: (streamModel, _context, options) => mock.stream(streamModel, _context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.High,
			prewalk: { target: model, thinkingLevel: Effort.XHigh },
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "prewalk") notices.push(event.message);
		});

		await session.prompt("do the task");

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(notices.some(message => message.includes("nothing to switch"))).toBe(true);
	});

	it("switches when a same-model target clears auto mode even though efforts both resolve to undefined", async () => {
		// Review edge case: session in `auto`, same-model prewalk target `:inherit`.
		// Both selectors resolve to an `undefined` effort, but `:inherit` clears
		// per-turn classification, so this is a real change and must switch — not
		// collapse to a no-op.
		const model = modelOrThrow("claude-sonnet-4-5");

		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "write"), { content: ["done"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (streamModel, _context, options) => mock.stream(streamModel, _context, options),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			thinkingLevel: AUTO_THINKING,
			prewalk: { target: model, thinkingLevel: ThinkingLevel.Inherit },
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "prewalk") notices.push(event.message);
		});

		expect(session.isAutoThinking).toBe(true);

		await session.prompt("do the task");

		// The hand-off clears automatic thinking.
		expect(session.isAutoThinking).toBe(false);
		expect(notices.some(message => message.includes("nothing to switch"))).toBe(false);
	});
});
