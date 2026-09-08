import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { Effort, type Message, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	formatTodoSummary,
	getLatestTodoPhasesFromEntries,
	phasesToMarkdown,
	TodoTool,
	type TodoPhase,
	type ToolSession,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const canonical: TodoPhase[] = [
	{
		name: "Delivery",
		tasks: [
			{ content: "Integrate accepted changes", status: "in_progress" },
			{ content: "Check release package", status: "pending" },
			{ content: "Obtain release approval", status: "blocked", blocker: "waiting for owner sign-off" },
		],
	},
	{
		name: "Earlier work",
		tasks: [
			{ content: "Completed implementation", status: "completed" },
			{ content: "Superseded approach", status: "abandoned" },
		],
	},
];

function textOf(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.flatMap(block =>
					block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : [],
				)
				.join("\n");
}

function restoredTexts(messages: Message[]): string[] {
	return messages
		.filter(message => message.role === "developer")
		.map(textOf)
		.filter(text => text.startsWith("<todo-state>"));
}

function seedTodoHistory(
	manager: SessionManager,
	phases: TodoPhase[] = canonical,
): { keptId: string; result: ToolResultMessage } {
	manager.appendMessage({ role: "user", content: "Carry out the release plan", timestamp: Date.now() });
	const call = createAssistantMessage("");
	call.content = [{ type: "toolCall", id: "todo-snapshot", name: "todo", arguments: { op: "view" } }];
	call.stopReason = "toolUse";
	manager.appendMessage(call);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolName: "todo",
		toolCallId: "todo-snapshot",
		isError: false,
		content: [{ type: "text", text: formatTodoSummary(phases, [], true) }],
		details: { op: "view", phases, storage: "session" },
		timestamp: Date.now(),
	};
	manager.appendMessage(result);
	manager.appendMessage(createAssistantMessage("Older work details. ".repeat(500)));
	const keptId = manager.appendMessage({ role: "user", content: "Continue the same work", timestamp: Date.now() });
	return { keptId, result };
}

describe("canonical todo context restoration", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		dir = TempDir.createSync("@pi-todo-restoration-");
		auth = createInMemoryAuthStorage();
		auth.setRuntimeApiKey("anthropic", "synthetic-key");
		registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		sessions.length = 0;
		auth.close();
		await dir.remove();
		vi.restoreAllMocks();
	});

	function createHarness(
		manager: SessionManager,
		overrides: Record<string, unknown> = {},
		additionalTools: AgentTool[] = [],
	) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled synthetic-test model");
		const requests: Message[][] = [];
		const settings = Settings.isolated({
			"todo.enabled": true,
			"todo.reminders": false,
			"todo.eager": "default",
			"task.eager": "default",
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"title.refreshOnReplan": false,
			...overrides,
		});
		const toolSession: ToolSession = {
			cwd: dir.path(),
			hasUI: false,
			settings,
			getSessionFile: () => manager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
		};
		const todo = new TodoTool(toolSession);
		const tools = [todo as unknown as AgentTool, ...additionalTools];
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: Effort.Medium,
				systemPrompt: ["Synthetic todo restoration"],
				tools,
				messages: manager.buildSessionContext().messages,
			},
			getApiKey: () => "synthetic-key",
			convertToLlm,
			streamFn: (_model, context) => {
				requests.push(context.messages.slice());
				const response = createAssistantMessage("Synthetic turn complete");
				response.provider = _model.provider;
				response.model = _model.id;
				response.api = _model.api;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		const session: AgentSession = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			sideStreamFn: () => {
				throw new Error("Unexpected provider request in synthetic todo fixture");
			},
		});
		sessions.push(session);
		return { session, todo, requests };
	}

	it("exposes the canonical journal state once after shared summary compaction, independently of summary claims", async () => {
		const manager = SessionManager.inMemory(dir.path());
		const { keptId } = seedTodoHistory(manager);
		const { session, requests } = createHarness(manager);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "All tasks are completed; no approval remains.",
			shortSummary: undefined,
			firstKeptEntryId: keptId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		await session.compact();
		await session.prompt("Continue the release work");
		await session.prompt("Continue without replacing the plan");
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			const restored = restoredTexts(request);
			expect(restored).toHaveLength(1);
			expect(restored[0]).toContain("Delivery");
			expect(restored[0]).toContain("[in_progress] Integrate accepted changes");
			expect(restored[0]).toContain("[pending] Check release package");
			expect(restored[0]).toContain("[blocked] Obtain release approval");
			expect(restored[0]).toContain("waiting for owner sign-off");
			expect(restored[0]).toContain("1 completed");
			expect(restored[0]).toContain("1 abandoned");
			expect(restored[0]).not.toContain("Superseded approach");
		}
		expect(session.getTodoPhases()).toEqual(canonical);
		expect(
			manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "todo-state"),
		).toEqual([]);
	});

	it("restores a shaken todo result whose hidden phases survived but visible checklist was elided", async () => {
		const manager = SessionManager.inMemory(dir.path());
		const { result } = seedTodoHistory(manager);
		const { session, requests } = createHarness(manager);
		expect(restoredTexts(await session.convertMessagesToLlm(session.messages))).toEqual([]);
		const outcome = await session.shake("elide", {
			config: { ...compactionModule.AGGRESSIVE_SHAKE_CONFIG, protectTokens: 0 },
		});
		expect(outcome.toolResultsDropped).toBe(1);
		expect(result.prunedAt).toBeDefined();
		expect(textOf(result)).not.toContain("waiting for owner sign-off");
		expect(requests).toEqual([]);
		await session.prompt("Continue after shake");
		const restored = restoredTexts(requests[0]);
		expect(restored).toHaveLength(1);
		expect(restored[0]).toContain("waiting for owner sign-off");
		expect(session.getTodoPhases()).toEqual(canonical);
	});

	it("restores after file resume with provider replacement history that omitted the todo list", async () => {
		const manager = SessionManager.create(dir.path(), dir.path());
		const { keptId } = seedTodoHistory(manager);
		manager.appendCompaction("Lossy provider summary", undefined, keptId, 1000, {
			preserveData: {
				openaiRemoteCompaction: {
					provider: "openai",
					replacementHistory: [
						{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue work" }] },
						{ type: "compaction", encrypted_content: "synthetic-compaction-payload" },
					],
				},
			},
		});
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected temporary journal path");
		const reopened = await SessionManager.open(file, dir.path());
		const { session, requests } = createHarness(reopened);
		await session.prompt("Continue from the reopened session");
		expect(restoredTexts(requests[0])).toHaveLength(1);
		expect(restoredTexts(requests[0])[0]).toContain("waiting for owner sign-off");
		expect(session.getTodoPhases()).toEqual(canonical);
	});

	it("preserves explicit clears across summary restoration and does not revive eager todo creation", async () => {
		const manager = SessionManager.inMemory(dir.path());
		const { keptId } = seedTodoHistory(manager);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		manager.appendMessage({
			role: "toolResult",
			toolName: "todo",
			toolCallId: "failed-old-snapshot",
			isError: true,
			content: [{ type: "text", text: "failed" }],
			details: { phases: canonical },
			timestamp: Date.now(),
		});
		manager.appendCompaction("Continue the old release checklist", undefined, keptId, 1000);
		const { session, requests } = createHarness(manager, { "todo.eager": "always" });
		await session.prompt("Continue without recreating cleared work");
		expect(restoredTexts(requests[0])).toHaveLength(1);
		expect(restoredTexts(requests[0])[0]).toContain("intentionally empty");
		expect(requests[0].map(textOf).join("\n")).not.toContain("[blocked] Obtain release approval");
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "eager-todo-prelude"),
		).toBe(false);
		expect(session.getTodoPhases()).toEqual([]);
		await session.resetSessionContext();
		await session.prompt("A new context without old todos");
		expect(restoredTexts(requests[1])).toEqual([]);
	});

	it("restores the selected tree branch instead of reopening its deliberately cleared sibling", async () => {
		const manager = SessionManager.inMemory(dir.path());
		manager.appendMessage({ role: "user", content: "Release work", timestamp: Date.now() });
		const workBranch = manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: canonical });
		const clearedBranch = manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		const { session, requests } = createHarness(manager);
		await session.navigateTree(workBranch, { summarize: false });
		await session.prompt("Continue this selected work branch");
		expect(restoredTexts(requests[0])[0]).toContain("waiting for owner sign-off");
		expect(session.getTodoPhases()).toEqual(canonical);
		await session.navigateTree(clearedBranch, { summarize: false });
		await session.prompt("Keep the selected cleared branch empty");
		expect(restoredTexts(requests[1])).toHaveLength(1);
		expect(restoredTexts(requests[1])[0]).toContain("intentionally empty");
		expect(session.getTodoPhases()).toEqual([]);
	});

	it("does not duplicate a retained manual-edit reminder that already represents the current snapshot", async () => {
		const manager = SessionManager.inMemory(dir.path());
		seedTodoHistory(manager);
		const { session, requests } = createHarness(manager);
		const ctx = {
			session,
			sessionManager: manager,
			agent: session.agent,
			setTodos: () => {},
			showStatus: () => {},
		} as unknown as InteractiveModeContext;
		await new TodoCommandController(ctx).handleTodoCommand("rm");
		session.freshSession();
		await session.prompt("Continue without restoring the removed list");
		expect(restoredTexts(requests[0])).toEqual([]);
		expect(requests[0].map(textOf).filter(text => text.includes("intentionally cleared the todo list"))).toHaveLength(
			1,
		);
		expect(session.getTodoPhases()).toEqual([]);
	});

	it("recognizes a retained legacy developer checklist paired with the latest journal edit", async () => {
		const manager = SessionManager.inMemory(dir.path());
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: canonical });
		manager.appendMessage({
			role: "developer",
			content: [{ type: "text", text: phasesToMarkdown(canonical) }],
			attribution: "user",
			timestamp: Date.now(),
		});
		const { session, requests } = createHarness(manager);
		session.freshSession();
		await session.prompt("Continue from the retained checklist");
		expect(restoredTexts(requests[0])).toEqual([]);
		expect(requests[0].map(textOf).filter(text => text.includes("waiting for owner sign-off"))).toHaveLength(1);
		expect(session.getTodoPhases()).toEqual(canonical);
	});

	it("delivers missing canonical state to the next provider request after a mid-turn model replacement", async () => {
		const manager = SessionManager.inMemory(dir.path());
		seedTodoHistory(manager);
		const target = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!target) throw new Error("Expected bundled replacement model");
		const replace: AgentTool = {
			name: "replace_provider",
			label: "Replace provider",
			description: "Synthetic model replacement",
			parameters: type({}),
			execute: async () => {
				const phases = session.getTodoPhases();
				phases[0].tasks[2].blocker = "a newly recorded release gate";
				session.setTodoPhases(phases);
				manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
				await session.setModelTemporary(target, undefined, { ephemeral: true });
				return { content: [{ type: "text", text: "Replaced provider" }] };
			},
		};
		const harness = createHarness(manager, { "compaction.enabled": false }, [replace]);
		const session: AgentSession = harness.session;
		const stream = session.agent.streamFn;
		let called = false;
		session.agent.streamFn = (model, context, options) => {
			if (called) return stream(model, context, options);
			called = true;
			harness.requests.push(context.messages.slice());
			const response = createAssistantMessage("");
			response.model = model.id;
			response.api = model.api;
			response.provider = model.provider;
			response.content = [{ type: "toolCall", id: "replace-provider", name: replace.name, arguments: {} }];
			response.stopReason = "toolUse";
			const events = new AssistantMessageEventStream();
			queueMicrotask(() => {
				events.push({ type: "start", partial: response });
				events.push({ type: "done", reason: "toolUse", message: response });
			});
			return events;
		};
		await session.prompt("Replace the provider and continue this tool loop");
		expect(harness.requests).toHaveLength(2);
		expect(restoredTexts(harness.requests[0])).toEqual([]);
		expect(restoredTexts(harness.requests[1])).toHaveLength(1);
		expect(restoredTexts(harness.requests[1])[0]).toContain("a newly recorded release gate");
	});

	it("keeps a single projection across provider reset and retains a complete todo view behind its bounds", async () => {
		const manager = SessionManager.inMemory(dir.path());
		const phases: TodoPhase[] = Array.from({ length: 20 }, (_, index) => ({
			name: `Closed phase ${index}`,
			tasks: [{ content: "Closed label ".repeat(100), status: "completed" }],
		}));
		phases.push({
			name: "Current phase",
			tasks: [
				{ content: "Current task", status: "in_progress" },
				{ content: "Blocked task", status: "blocked", blocker: "Sign-off detail ".repeat(100) },
				...Array.from({ length: 60 }, (_, index) => ({
					content: `Pending ${index} ${"work detail ".repeat(100)}`,
					status: "pending" as const,
				})),
			],
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		const { session, todo, requests } = createHarness(manager);
		session.freshSession();
		session.freshSession();
		await session.prompt("Continue the current phase");
		const restored = restoredTexts(requests[0]);
		expect(restored).toHaveLength(1);
		expect(restored[0].length).toBeLessThan(20_000);
		expect(restored[0]).toContain("[in_progress] Current task");
		expect(restored[0]).toContain("[blocked] Blocked task");
		expect(restored[0]).toContain("Sign-off detail");
		expect(restored[0]).toContain("omitted");
		const full = await todo.execute("complete-view", { op: "view" });
		expect(full.details?.phases).toEqual(phases);
		expect(full.content.some(block => block.type === "text" && block.text.includes("Pending 59"))).toBe(true);
	});

	it("does not mistake an older matching tool result for the current state after intervening edits", async () => {
		const manager = SessionManager.inMemory(dir.path());
		seedTodoHistory(manager);
		const changed = canonical.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ content: task.content, status: "completed" as const })),
		}));
		manager.appendMessage({
			role: "toolResult",
			toolName: "todo",
			toolCallId: "later-completion",
			isError: false,
			content: [{ type: "text", text: formatTodoSummary(changed, []) }],
			details: { phases: changed },
			timestamp: Date.now(),
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: canonical });
		const { session, requests } = createHarness(manager);
		await session.prompt("Continue the most recently restored plan");
		expect(restoredTexts(requests[0])).toHaveLength(1);
		expect(restoredTexts(requests[0])[0]).toContain("[blocked] Obtain release approval");
		expect(session.getTodoPhases()).toEqual(canonical);
	});

	it("journals one normal result per native or device operation and replays the device clear", async () => {
		const manager = SessionManager.inMemory(dir.path());
		const { session, todo } = createHarness(manager);
		const initial = await todo.execute("native-init", {
			op: "init",
			list: [
				{ phase: "Work", items: ["Native task"] },
				{ phase: "Verification", items: ["Check the native task"] },
			],
		});
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: "native-init",
				content: initial.content,
				details: initial.details,
				isError: false,
				timestamp: Date.now(),
			},
		});
		await session.waitForIdle();
		const cleared = await todo.execute("device-clear", { op: "rm" });
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "write",
				toolCallId: "device-clear",
				content: cleared.content,
				details: {
					xdev: { tool: "todo", mode: "execute", args: { op: "rm" }, tier: "read", inner: cleared.details },
				},
				isError: false,
				timestamp: Date.now(),
			},
		});
		await session.waitForIdle();
		// Whole-list rm clears every task while retaining the phase headings.
		expect(getLatestTodoPhasesFromEntries(manager.getBranch()).flatMap(phase => phase.tasks)).toEqual([]);
		expect(
			manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(2);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE),
		).toEqual([]);
		expect(session.getTodoPhases().flatMap(phase => phase.tasks)).toEqual([]);
	});
});
