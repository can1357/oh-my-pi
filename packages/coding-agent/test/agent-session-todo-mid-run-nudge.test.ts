import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Regression coverage for issue #3651 and its redesign: the mid-run todo
 * reconciliation nudge keeps the live HUD honest during long runs, but is a
 * gentle MODEL-ONLY hint — deliberately separate from the user-visible
 * stop-time reminder ladder. The contract this defends:
 *
 *   1. Only SUCCESSFUL MUTATING tool results (bash/eval/edit/write/ast_edit)
 *      tick the counter. Read-only exploration (grep/read/glob/lsp) and
 *      errored results never do.
 *   2. At {@link MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD} mutations without a
 *      `todo` call, the aside provider injects a hidden custom message
 *      (`display: false`) — NO `todo_reminder` event, nothing renders.
 *   3. A `todo` tool result resets the counter.
 *   4. At most {@link MID_RUN_TODO_NUDGE_MAX_PER_CYCLE} nudges fire per
 *      prompt cycle.
 *   5. The counter update lands synchronously with the message_end emit.
 *
 * Drives the aside provider directly: the production agent loop polls it
 * between tool-use turns (mid-work boundary in `agent-loop.ts`), so calling it
 * after a batch of synthesized `message_end` events mirrors that injection
 * point without spinning a real model.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession mid-run todo reconciliation nudge", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let reminderEvents: Array<Extract<AgentSessionEvent, { type: "todo_reminder" }>>;
	let asideProvider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;

	const THRESHOLD = 12; // mirrors MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD
	const MAX_PER_CYCLE = 2; // mirrors MID_RUN_TODO_NUDGE_MAX_PER_CYCLE
	const NUDGE_TYPE = "mid-run-todo-nudge"; // mirrors MID_RUN_TODO_NUDGE_MESSAGE_TYPE

	function toolUseAssistant(toolName: string): AssistantMessage {
		const id = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id, name: toolName, arguments: {} };
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
	function emitToolResult(toolName: string, opts?: { isError?: boolean }): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		session.agent.emitExternalEvent({ type: "message_end", message: toolUseAssistant(toolName) });
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: opts?.isError ?? false,
				timestamp: Date.now(),
			},
		});
	}

	async function drainNudges(): Promise<CustomMessage[]> {
		if (!asideProvider) throw new Error("aside provider was never captured");
		const thunks = await asideProvider();
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

		const settings = Settings.isolated({
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

	it("caps nudges per prompt cycle", async () => {
		let fired = 0;
		for (let cycle = 0; cycle < MAX_PER_CYCLE + 2; cycle++) {
			for (let i = 0; i < THRESHOLD; i++) emitToolResult("edit");
			fired += (await drainNudges()).length;
		}
		expect(fired).toBe(MAX_PER_CYCLE);
		expect(reminderEvents).toEqual([]);
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
		const result = asideProvider();
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
});
