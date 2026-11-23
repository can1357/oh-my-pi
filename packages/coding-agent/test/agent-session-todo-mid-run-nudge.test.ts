import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool, type AsideBoundary, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { ASYNC_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { Type } from "@sinclair/typebox";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgTodoMidRunNudges } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Regression coverage for issue #3651 and its redesign: the mid-run todo
 * reconciliation nudge keeps the live HUD honest during long runs, but is a
 * gentle MODEL-ONLY hint — deliberately separate from the user-visible
 * stop-time reminder ladder. The contract this defends:
 *
 *   1. Successful mutating built-ins (bash/eval/edit/write/ast_edit, excluding
 *      background launches), completed delegated work (`task`, `wait`, and
 *      `async-result` custom messages), and non-read-only extension/MCP tools
 *      tick the counter. Read-only exploration, read-only extension/MCP tools,
 *      background launches, and errored results never do.
 *   2. At {@link MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD} mutations without a
 *      `todo` call, the aside provider injects a hidden custom message
 *      (`display: false`) — NO `todo_reminder` event, nothing renders.
 *   3. A state-writing `todo` tool result (or direct `setTodoPhases`) resets
 *      the counter; read-only `todo` views and errored `todo` calls do not.
 *   4. `todo.midRunNudges` shapes the budget between state-writing `todo`
 *      results (`view` reads and errored attempts do not re-arm it; a new
 *      prompt cycle re-arms it unconditionally):
 *        - `off` never nudges;
 *        - `capped` (default) stops after two unanswered nudges;
 *        - `backoff` doubles the runway after each unanswered nudge (12, 24,
 *          48, 96, then every 192) instead of falling silent.
 *   5. The counter update lands synchronously with the message_end emit.
 *
 * Drives the aside provider directly: the production agent loop polls it
 * between tool-use turns (mid-work boundary in `agent-loop.ts`), so calling it
 * after a batch of synthesized `message_end` events mirrors that injection
 * point without spinning a real model.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession mid-run todo reconciliation nudge", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settings: Settings;
	let reminderEvents: Array<Extract<AgentSessionEvent, { type: "todo_reminder" }>>;
	let asideProvider: ((boundary: AsideBoundary) => AsideMessage[] | Promise<AsideMessage[]>) | undefined;

	const THRESHOLD = 12; // mirrors MID_RUN_NUDGE_MUTATION_THRESHOLD
	const MAX_PER_CYCLE = 2; // mirrors MID_RUN_NUDGE_MAX_PER_CYCLE
	const BACKOFF_DOUBLINGS = 4; // mirrors MID_RUN_NUDGE_BACKOFF_DOUBLINGS
	const NUDGE_TYPE = "mid-run-todo-nudge"; // mirrors MID_RUN_TODO_NUDGE_MESSAGE_TYPE

	function toolUseAssistant(toolName: string, id: string, args: Record<string, unknown> = {}): AssistantMessage {
		const toolCall: ToolCall = { type: "toolCall", id, name: toolName, arguments: args };
		return {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function textOnlyAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "paused for instruction" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}
	function emitTextOnlyStop(): void {
		const msg = textOnlyAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/** Production-shaped tool round trip: assistant toolCall turn + toolResult. */
	function emitToolResult(
		toolName: string,
		opts?: { isError?: boolean; details?: unknown; args?: Record<string, unknown> },
	): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const assistantMessage = toolUseAssistant(toolName, toolCallId, opts?.args);
		if (opts?.args !== undefined) {
			session.agent.appendMessage(assistantMessage);
		}
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				details: opts?.details,
				isError: opts?.isError ?? false,
				timestamp: Date.now(),
			},
		});
	}

	function emitAsyncResult(jobs: Array<{ jobId: string; status: string }>): void {
		const message: CustomMessage = {
			role: "custom",
			customType: ASYNC_RESULT_MESSAGE_TYPE,
			content: "Async jobs settled",
			display: true,
			details: { jobs },
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message });
	}

	async function drainNudges(boundary: AsideBoundary = "work"): Promise<CustomMessage[]> {
		if (!asideProvider) throw new Error("aside provider was never captured");
		const thunks = await asideProvider(boundary);
		const out: CustomMessage[] = [];
		for (const entry of thunks) {
			const message = typeof entry === "function" ? entry() : entry;
			if (!message) continue;
			if (message.role !== "custom") continue;
			if ((message as CustomMessage).customType !== NUDGE_TYPE) continue;
			out.push(message as CustomMessage);
		}
		return out;
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-mid-run-nudge-");
		sessionManager = SessionManager.inMemory(tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.remindersMax": 3,
		});
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};
		const todoTool = new TodoTool(toolSession);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todoTool as unknown as AgentTool],
				messages: [],
			},
		});

		// Capture the aside provider AgentSession installs in its constructor.
		// Wrap the instance method (not the prototype) so concurrent test files
		// constructing their own Agents are never observed through this seam.
		asideProvider = undefined;
		const originalSet = agent.setAsideMessageProvider.bind(agent);
		agent.setAsideMessageProvider = (fn): void => {
			if (fn !== undefined && asideProvider === undefined) asideProvider = fn;
			originalSet(fn);
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
		});

		reminderEvents = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderEvents.push(event);
		});

		session.setTodoPhases([
			{
				name: "Refactor pass",
				tasks: [
					{ content: "Sweep call sites", status: "in_progress" },
					{ content: "Update tests", status: "pending" },
					{ content: "Polish docs", status: "pending" },
				],
			},
		]);
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("read-only exploration never ticks the counter, no matter how long", async () => {
		for (let i = 0; i < THRESHOLD * 3; i++) emitToolResult(i % 2 === 0 ? "grep" : "read");

		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("stays silent below the mutation threshold", async () => {
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");

		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("injects a hidden custom nudge at the threshold — no event, no render", async () => {
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");

		const nudges = await drainNudges();
		expect(nudges.length).toBe(1);
		const nudge = nudges[0];
		// Hidden from the TUI/transcript, visible to the model only.
		expect(nudge?.display).toBe(false);
		const text = typeof nudge?.content === "string" ? nudge.content : "";
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("3 todo items");
		// Gentle hint, not the stop-time escalation ladder: no per-task
		// enumeration, no attempt counter.
		expect(text).not.toContain("Sweep call sites");
		expect(text).not.toMatch(/reminder \d\/\d/i);

		// SEPARATE concept from the stop-time reminder: no todo_reminder event,
		// so nothing renders a TodoReminderComponent or reaches extensions.
		expect(reminderEvents).toEqual([]);

		// Counter reset: another full runway is required before the next nudge,
		// so an immediate poll right after firing must NOT re-inject.
		expect(await drainNudges()).toEqual([]);
	});

	it("errored mutating results do not tick the counter", async () => {
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("bash", { isError: true });

		expect(await drainNudges()).toEqual([]);
	});

	it("does not nudge when a `todo` call has reset the counter mid-window", async () => {
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("write");
		emitToolResult("todo");
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("write");

		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	/** Fires one ignored nudge per runway; returns how many fired. */
	async function ignoreNudges(runways: number[]): Promise<number> {
		let fired = 0;
		for (const runway of runways) {
			for (let i = 0; i < runway; i++) emitToolResult("edit");
			fired += (await drainNudges()).length;
		}
		return fired;
	}

	/** Neither a read-only view nor a failed attempt nor a details-less Cursor read snapshot wrote state. */
	async function expectReadOnlyTodoResultsDoNotReArm(): Promise<void> {
		emitToolResult("todo", { details: { op: "view", phases: [] } });
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
		expect(await drainNudges()).toEqual([]);

		emitToolResult("todo", { isError: true, details: { op: "done", phases: [] } });
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
		expect(await drainNudges()).toEqual([]);

		emitToolResult("todo");
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	}

	describe("todo.midRunNudges: capped (default)", () => {
		it("is the default mode", () => {
			expect(cfgTodoMidRunNudges.get(settings)).toBe("capped");
		});

		it("caps nudges per prompt cycle", async () => {
			expect(await ignoreNudges(Array(MAX_PER_CYCLE + 2).fill(THRESHOLD))).toBe(MAX_PER_CYCLE);
			// A long tail of further work stays silent until a reset.
			for (let i = 0; i < THRESHOLD * 2 ** BACKOFF_DOUBLINGS; i++) emitToolResult("edit");
			expect(await drainNudges()).toEqual([]);
			expect(reminderEvents).toEqual([]);
		});

		it("re-arms the nudge budget after a todo state write", async () => {
			expect(await ignoreNudges(Array(MAX_PER_CYCLE).fill(THRESHOLD))).toBe(MAX_PER_CYCLE);
			for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
			expect(await drainNudges()).toEqual([]);

			// The agent acted on a nudge and wrote todo state — the same path the
			// native tool, a Cursor sync, and a bridged call all take.
			session.setTodoPhases([
				{ name: "Refactor pass", tasks: [{ content: "Sweep call sites", status: "pending" }] },
			]);
			for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");

			expect((await drainNudges()).length).toBe(1);
			expect(reminderEvents).toEqual([]);
		});

		it("read-only todo results do not re-arm the nudge budget", async () => {
			expect(await ignoreNudges(Array(MAX_PER_CYCLE).fill(THRESHOLD))).toBe(MAX_PER_CYCLE);
			await expectReadOnlyTodoResultsDoNotReArm();
		});
	});

	describe("todo.midRunNudges: backoff", () => {
		beforeEach(() => {
			cfgTodoMidRunNudges.set(settings, "backoff");
		});

		it("backs off instead of falling silent when nudges are ignored", async () => {
			const runways = [THRESHOLD, THRESHOLD * 2, THRESHOLD * 4, THRESHOLD * 8, THRESHOLD * 2 ** BACKOFF_DOUBLINGS];
			for (const runway of runways) {
				// One short of the runway stays silent; the runway itself fires once.
				for (let i = 0; i < runway - 1; i++) emitToolResult("edit");
				expect(await drainNudges()).toEqual([]);
				emitToolResult("edit");
				const nudges = await drainNudges();
				expect(nudges.length).toBe(1);
				expect(nudges[0]?.display).toBe(false);
				expect(await drainNudges()).toEqual([]);
				expect(reminderEvents).toEqual([]);
			}

			// At the ceiling it settles into a steady reminder rate instead of
			// going silent for the rest of the turn.
			for (let cycle = 0; cycle < 2; cycle++) {
				for (let i = 0; i < THRESHOLD * 2 ** BACKOFF_DOUBLINGS; i++) emitToolResult("edit");
				expect((await drainNudges()).length).toBe(1);
			}
			expect(reminderEvents).toEqual([]);
		});

		it("resets the backoff after a todo state write", async () => {
			expect(await ignoreNudges([THRESHOLD, THRESHOLD * 2])).toBe(2);
			expect(await drainNudges()).toEqual([]);

			session.setTodoPhases([
				{ name: "Refactor pass", tasks: [{ content: "Sweep call sites", status: "pending" }] },
			]);
			for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");

			expect((await drainNudges()).length).toBe(1);
			expect(reminderEvents).toEqual([]);
		});

		it("read-only todo results do not reset the backoff", async () => {
			expect(await ignoreNudges([THRESHOLD, THRESHOLD * 2])).toBe(2);
			// The next runway is 48; each check above stays below it.
			await expectReadOnlyTodoResultsDoNotReArm();
		});
	});

	describe("todo.midRunNudges: off", () => {
		beforeEach(() => {
			cfgTodoMidRunNudges.set(settings, "off");
		});

		it("never nudges, however long the turn", async () => {
			expect(await ignoreNudges(Array(4).fill(THRESHOLD * 2 ** BACKOFF_DOUBLINGS))).toBe(0);
			expect(reminderEvents).toEqual([]);
		});

		it("applies a mode change on the next nudge decision", async () => {
			for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
			expect(await drainNudges()).toEqual([]);

			cfgTodoMidRunNudges.set(settings, "capped");
			expect((await drainNudges()).length).toBe(1);
		});
	});

	it("counter update lands synchronously with the message_end emit (no microtask drain required)", () => {
		// Regression for the review on PR #3652: pre-fix the counter update sat
		// after `await messageEndPersistence.persist(...)`, so the live counter
		// only caught up once microtasks drained. A poll between the emit burst
		// and the persistence chain settling would observe stale state. With the
		// hoisted (synchronous) update, the production-shaped contract holds even
		// when the aside poll runs in the same JS task as the emit.
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");

		if (!asideProvider) throw new Error("aside provider was never captured");
		const result = asideProvider("work");
		if (result instanceof Promise) throw new Error("aside provider unexpectedly returned a Promise");
		const nudges = result
			.map(entry => (typeof entry === "function" ? entry() : entry))
			.filter((m): m is NonNullable<typeof m> => Boolean(m))
			.filter(m => m.role === "custom" && (m as CustomMessage).customType === NUDGE_TYPE);
		expect(nudges.length).toBe(1);
	});

	it("stays silent when `todo` is not in the active-tool list, even if `todo.enabled` is still on", async () => {
		// An explicit active-tool list (or discovery-mode filtering) can drop
		// `todo` from the slate while the setting flag stays true. Asking the
		// model to call a tool that is not in its schema would produce
		// fabricated/unknown tool calls. Mirror {@link #createEagerTodoPrelude}.
		await session.setActiveToolsByName([]);
		expect(session.getActiveToolNames()).not.toContain("todo");

		for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("does not spend the pre-stop mutation count immediately after a stop-time reminder", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");

		emitTextOnlyStop();
		await session.waitForIdle();
		// The stop-time path is the user-visible ladder: it emits the event.
		expect(reminderEvents.length).toBe(1);
		expect(reminderEvents[0]?.attempt).toBe(1);

		// The stop-time reminder reset the mutation counter, so one more landed
		// mutation (crossing the stale pre-reminder threshold) must stay silent.
		emitToolResult("edit");
		expect(await drainNudges()).toEqual([]);
		expect(reminderEvents.length).toBe(1);
	});

	describe("delegated jobs, extension/MCP tools, read-only todo views, and boundaries", () => {
		function makeStubTool(name: string, extra?: Partial<AgentTool> & { mcpReadOnlyHint?: boolean }): AgentTool {
			return {
				name,
				label: name,
				description: `stub ${name}`,
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				...extra,
			} as AgentTool;
		}

		async function registerTools(tools: AgentTool[]): Promise<void> {
			const registry = new Map<string, AgentTool>(session.agent.state.tools.map(t => [t.name, t]));
			await session.dispose();
			for (const tool of tools) {
				registry.set(tool.name, tool);
			}
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [...registry.values()],
					messages: [],
				},
			});
			asideProvider = undefined;
			const originalSet = agent.setAsideMessageProvider.bind(agent);
			agent.setAsideMessageProvider = (fn): void => {
				if (fn !== undefined && asideProvider === undefined) asideProvider = fn;
				originalSet(fn);
			};
			session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry: sharedModelRegistry,
				toolRegistry: registry,
			});
			reminderEvents = [];
			session.subscribe((event: AgentSessionEvent) => {
				if (event.type === "todo_reminder") reminderEvents.push(event);
			});
			session.setTodoPhases([
				{
					name: "Refactor pass",
					tasks: [
						{ content: "Sweep call sites", status: "in_progress" },
						{ content: "Update tests", status: "pending" },
						{ content: "Polish docs", status: "pending" },
					],
				},
			]);
		}

		it("counts completed jobs delivered via `wait`, ignoring failed/cancelled/running jobs", async () => {
			// Timeout / empty wait never ticks.
			for (let i = 0; i < THRESHOLD; i++) {
				emitToolResult("wait", { details: { op: "wait", jobs: [] } });
			}
			expect(await drainNudges()).toEqual([]);

			// Only status === "completed" counts (+1 per batch here).
			for (let i = 0; i < THRESHOLD - 1; i++) {
				emitToolResult("wait", {
					details: {
						op: "wait",
						jobs: [
							{ id: `ok-${i}`, status: "completed" },
							{ id: `fail-${i}`, status: "failed" },
							{ id: `cancel-${i}`, status: "cancelled" },
							{ id: `run-${i}`, status: "running" },
						],
					},
				});
			}
			expect(await drainNudges()).toEqual([]);

			emitToolResult("wait", {
				details: { op: "wait", jobs: [{ id: "final", status: "completed" }] },
			});
			expect((await drainNudges()).length).toBe(1);
		});

		it("does not double-count background `task`, `bash`, or `eval` launches; counts completions on `wait` or `async-result`", async () => {
			for (let i = 0; i < THRESHOLD; i++) {
				emitToolResult("task", {
					details: { results: [], async: { state: "running", jobId: `t-${i}`, type: "task" } },
				});
				emitToolResult("bash", {
					details: { async: { state: "running", jobId: `b-${i}`, type: "bash" } },
				});
				emitToolResult("eval", {
					details: { async: { state: "running", jobId: `e-${i}`, type: "eval" } },
				});
			}
			expect(await drainNudges()).toEqual([]);

			// Failed/cancelled async-result batches never tick.
			emitAsyncResult([
				{ jobId: "fail-1", status: "failed" },
				{ jobId: "cancel-1", status: "cancelled" },
			]);
			expect(await drainNudges()).toEqual([]);

			// Completed jobs in async-result tick per completed job.
			emitAsyncResult(Array.from({ length: THRESHOLD - 1 }, (_, i) => ({ jobId: `j-${i}`, status: "completed" })));
			expect(await drainNudges()).toEqual([]);

			emitAsyncResult([{ jobId: "j-last", status: "completed" }]);
			expect((await drainNudges()).length).toBe(1);
		});

		it("counts completed synchronous `task` results (including partially failed batches and mixed sync+async) and skips failed/aborted ones", async () => {
			// Details-less errored task never ticks.
			emitToolResult("task", { isError: true });

			// Partially failed synchronous batch (`isError: true` with 1 succeeded sibling) counts +1.
			emitToolResult("task", {
				isError: true,
				details: {
					results: [{ exitCode: 0 }, { exitCode: 1, error: "sibling threw" }],
				},
			});

			// Mixed sync result alongside a still-running async handle counts the completed sync result (+1).
			emitToolResult("task", {
				details: {
					results: [{ exitCode: 0 }],
					async: { state: "running", jobId: "bg-1", type: "task" },
				},
			});

			for (let i = 0; i < THRESHOLD - 3; i++) {
				emitToolResult("task", {
					details: {
						results: [
							{ exitCode: 0 },
							{ exitCode: 1 },
							{ exitCode: 0, error: "failed" },
							{ exitCode: 0, aborted: true },
						],
					},
				});
			}
			expect(await drainNudges()).toEqual([]);

			// Details-less synchronous task completion counts as +1 and crosses threshold.
			emitToolResult("task");
			expect((await drainNudges()).length).toBe(1);
		});

		it("counts non-read-only extension and MCP tools while skipping read-only extension/MCP and built-in read tools", async () => {
			await registerTools([
				makeStubTool("ctx_execute"), // omitted approval defaults to exec tier
				makeStubTool("ctx_search_ro", { approval: "read" }),
				makeStubTool("mcp__docs__lookup", { approval: "write", mcpReadOnlyHint: true }),
				makeStubTool("mcp__db__write_row", { approval: "write", mcpReadOnlyHint: false }),
				makeStubTool(createMCPToolName("my-db", "write-row"), { approval: "write", mcpReadOnlyHint: false }),
				makeStubTool(createMCPToolName("my-docs", "search-ref"), { approval: "write", mcpReadOnlyHint: true }),
				makeStubTool("custom_exec_alias", { customWireName: "aliased_exec_tool" }),
				makeStubTool("lsp", {
					approval: (args: unknown) =>
						typeof args === "object" && args !== null && (args as { action?: string }).action === "rename"
							? "write"
							: "read",
				}),
				makeStubTool("security_scan", { approval: "exec" }),
			]);

			// Read-only extension, MCP readOnlyHint, read-mode dynamic tool, and READ_ONLY_TOOLS built-ins never tick.
			for (let i = 0; i < THRESHOLD; i++) {
				emitToolResult("ctx_search_ro");
				emitToolResult("mcp__docs__lookup");
				emitToolResult("mcp__my-docs__search-ref");
				emitToolResult("lsp", { args: { action: "hover" } });
				emitToolResult("security_scan");
			}
			expect(await drainNudges()).toEqual([]);

			// Mix of non-read-only extension, aliased wire name, mutating MCP (direct + alias), and write-mode dynamic tool hits threshold.
			for (let i = 0; i < THRESHOLD - 4; i++) emitToolResult("ctx_execute");
			emitToolResult("aliased_exec_tool");
			emitToolResult("mcp__db__write_row");
			emitToolResult("mcp__my-db__write-row");
			expect(await drainNudges()).toEqual([]);

			emitToolResult("lsp", { args: { action: "rename" } });
			expect((await drainNudges()).length).toBe(1);
		});

		it("keeps read-only `todo` views and errored `todo` calls from wiping the mutation counter", async () => {
			for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");

			// View via details.op
			emitToolResult("todo", { details: { op: "view", phases: [] } });
			// View via assistant toolCall arguments when a plugin strips details
			emitToolResult("todo", { args: { op: "view" }, details: {} });
			// Errored todo write attempt
			emitToolResult("todo", { isError: true, details: { op: "done" } });

			// One more edit crosses the threshold because none of the above wiped the counter.
			emitToolResult("edit");
			expect((await drainNudges()).length).toBe(1);
		});

		it("recognizes wire-aliased `todo` tools for both read-only views and state writes", async () => {
			await registerTools([makeStubTool("todo", { customWireName: "todo_write", approval: "read" })]);

			for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");
			emitToolResult("todo_write", { args: { op: "view" }, details: {} });
			emitToolResult("edit");
			expect((await drainNudges()).length).toBe(1);

			// A state-writing call via the wire alias resets the counter.
			for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");
			emitToolResult("todo_write", { details: { op: "done" } });
			for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");
			expect(await drainNudges()).toEqual([]);
		});

		it("resets the mutation counter on direct `setTodoPhases` updates", async () => {
			for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");
			session.setTodoPhases([
				{
					name: "Refactor pass",
					tasks: [
						{ content: "Sweep call sites", status: "completed" },
						{ content: "Update tests", status: "in_progress" },
					],
				},
			]);

			for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("edit");
			expect(await drainNudges()).toEqual([]);

			emitToolResult("edit");
			expect((await drainNudges()).length).toBe(1);
		});

		it("gates mid-run nudges to the `work` boundary and never injects on `stop`", async () => {
			emitAsyncResult(Array.from({ length: THRESHOLD }, (_, i) => ({ jobId: `done-${i}`, status: "completed" })));

			// Stop-time replies (e.g. asking the user a question) must go through checkCompletion(), not mid-run nudge.
			expect(await drainNudges("stop")).toEqual([]);
			// The pending nudge still fires on the mid-work boundary.
			expect((await drainNudges("work")).length).toBe(1);
		});
	});
});
