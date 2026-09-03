import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
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

	it("/prewalk reports success only when the requested arm remains active", async () => {
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
