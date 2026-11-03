import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { handleTodoAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { TODO_BACKEND_NOTICE_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/todo-backend";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createTodoBackendRecorder, flushTodoWrites, type TodoBackendRecorder } from "./helpers/todo-backend";

const BACKEND_ID = "recorder";
const REFUSAL = "tracker is offline";

interface Harness {
	session: AgentSession;
	recorder: TodoBackendRecorder;
	dir: string;
	eventBus: EventBus;
	sessionManager: SessionManager;
}

const cleanups: Array<() => Promise<void> | void> = [];

async function createHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-todo-writers-");
	const dir = tempDir.path();
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.create(dir, dir);
	const eventBus = new EventBus();
	const recorder = createTodoBackendRecorder(BACKEND_ID, { label: "Recorder" });

	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(recorder.extension(), dir, eventBus, runtime, "recorder-extension");
	const extensionRunner = new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in the bundled catalog");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		}),
		sessionManager,
		settings: Settings.isolated({ "todo.backend": BACKEND_ID }),
		modelRegistry,
		agentId: "Main",
		extensionRunner,
	});
	session.initializeTodoBackend();

	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	return { session, recorder, dir, eventBus, sessionManager };
}

function phasesOf(details: unknown): TodoPhase[] | undefined {
	if (typeof details !== "object" || details === null || !("phases" in details)) return undefined;
	return Array.isArray(details.phases) ? details.phases : undefined;
}

/** A `todo` tool bound to the session's write queue, exactly as `sdk.ts` wires it. */
function createTodoTool(session: AgentSession, dir: string): { tool: TodoTool; toolSession: ToolSession } {
	const toolSession: ToolSession = {
		cwd: dir,
		hasUI: false,
		getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		settings: session.settings,
		getTodoPhases: () => session.getTodoPhases(),
		setTodoPhases: phases => session.setTodoPhases(phases),
		runTodoWrite: write => session.runTodoWrite(write),
		commitTodoPhases: (phases, options) => session.commitTodoPhases(phases, options),
		getToolByName: name => (name === "todo" ? (tool as unknown as AgentTool) : undefined),
	};
	const tool = new TodoTool(toolSession);
	return { tool, toolSession };
}

/** Seeds a list through the `todo` tool, then forgets what the backend saw. */
async function seedList(h: Harness, tool: TodoTool): Promise<TodoPhase[]> {
	await tool.execute("seed", { op: "init", list: [{ phase: "Work", items: ["first", "second"] }] });
	h.recorder.calls.length = 0;
	return h.session.getTodoPhases();
}

function userTodoEdits(session: AgentSession): unknown[] {
	return session.sessionManager
		.getBranch()
		.filter(entry => entry.type === "custom" && entry.customType === "user_todo_edit");
}

function controllerContext(session: AgentSession) {
	const ctx = {
		agent: { appendMessage: vi.fn() },
		session,
		sessionManager: session.sessionManager,
		setTodos: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	};
	return { ctx, controller: new TodoCommandController(ctx as unknown as InteractiveModeContext) };
}

function slashRuntime(session: AgentSession, dir: string) {
	const output = vi.fn(async (_text: string) => {});
	const runtime = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		cwd: dir,
		output,
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
	} as SlashCommandRuntime;
	return { runtime, output };
}

function todoCommand(args: string) {
	return { name: "todo", args, text: `/todo ${args}` };
}

function contentsOf(phases: TodoPhase[]): string[] {
	return phases.flatMap(phase => phase.tasks.map(task => task.content));
}

/** Resolves once `count` todo writes (tool writes and commits) were issued on the session from now. */
function writeQueuedAt(session: AgentSession, count: number): Promise<void> {
	const queued = Promise.withResolvers<void>();
	let writes = 0;
	const issued = <T>(write: T): T => {
		if (++writes === count) queued.resolve();
		return write;
	};
	const run = session.runTodoWrite.bind(session);
	const commit = session.commitTodoPhases.bind(session);
	vi.spyOn(session, "runTodoWrite").mockImplementation((...args) => issued(run(...args)));
	vi.spyOn(session, "commitTodoPhases").mockImplementation((...args) => issued(commit(...args)));
	return queued.promise;
}

/**
 * Cursor handlers wired to the session. `refusalSettled()` resolves once the next refusal's
 * mirrored commit landed and the bridge rewrote that call's result. `wiring` replaces the
 * recording `emitEvent`/`reportTodoRefusal` with `sdk.ts`'s session wiring.
 */
function createCursor(h: Harness, wiring: "recorded" | "session" = "recorded") {
	const ends: Array<Extract<AgentEvent, { type: "tool_execution_end" }>> = [];
	const refusals: string[] = [];
	const settled: Array<PromiseWithResolvers<void>> = [];
	const nth = (index: number) => (settled[index] ??= Promise.withResolvers<void>());
	let mirroredCommits = 0;
	let awaited = 0;
	const handlers = new CursorExecHandlers({
		cwd: h.dir,
		tools: new Map(),
		getTodoPhases: () => h.session.getTodoPhases(),
		commitTodoPhases: (update, options) => {
			const run = h.session.commitTodoPhases(update, options);
			if (options?.mirrored) {
				const waiter = nth(mirroredCommits++);
				// Observe after the bridge's own handler, which it attaches once this returns.
				const settle = () => waiter.resolve();
				queueMicrotask(() => run.then(settle, settle));
			}
			return run;
		},
		reportTodoRefusal: message => {
			refusals.push(message);
			if (wiring === "session") h.session.emitNotice("error", message, TODO_BACKEND_NOTICE_SOURCE);
		},
		emitEvent: event => {
			if (event.type === "tool_execution_end") ends.push(event);
			if (wiring === "session") h.session.agent.emitExternalEvent(event);
		},
	});
	return { handlers, ends, refusals, refusalSettled: () => nth(awaited++).promise };
}

describe("todo writers reach the selected backend's replace", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true });
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("/todo sends the full new list to replace and commits it after replace resolves", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		const seeded = await seedList(h, tool);
		const { ctx, controller } = controllerContext(h.session);

		await controller.handleTodoCommand('append "Third item"');

		const replaces = h.recorder.calls.filter(call => call.method === "replace");
		expect(replaces).toHaveLength(1);
		expect(contentsOf(replaces[0]!.phases)).toEqual([...contentsOf(seeded), "Third item"]);
		expect(h.session.getTodoPhases()).toEqual(replaces[0]!.phases);
		expect(userTodoEdits(h.session)).toHaveLength(1);
		expect(ctx.setTodos).toHaveBeenCalledWith(replaces[0]!.phases);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("/todo surfaces the backend's message and changes nothing when replace throws", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		const seeded = await seedList(h, tool);
		h.recorder.replaceError = new Error(REFUSAL);
		const { ctx, controller } = controllerContext(h.session);

		await controller.handleTodoCommand('append "Refused item"');

		expect(ctx.showError).toHaveBeenCalledTimes(1);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
		expect(ctx.setTodos).not.toHaveBeenCalled();
		expect(ctx.agent.appendMessage).not.toHaveBeenCalled();
		expect(h.session.getTodoPhases()).toEqual(seeded);
		expect(userTodoEdits(h.session)).toHaveLength(0);
	});

	it("the slash helper sends the full list to replace, and reports a refusal as a failed command", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		const seeded = await seedList(h, tool);
		const { runtime, output } = slashRuntime(h.session, h.dir);

		const ok = await handleTodoAcp(todoCommand('append "Slash item"'), runtime);
		expect(ok).toEqual({ consumed: true });
		const replaces = h.recorder.calls.filter(call => call.method === "replace");
		expect(replaces).toHaveLength(1);
		expect(contentsOf(replaces[0]!.phases)).toEqual([...contentsOf(seeded), "Slash item"]);

		const committed = h.session.getTodoPhases();
		h.recorder.replaceError = new Error(REFUSAL);
		output.mockClear();
		const refused = await handleTodoAcp(todoCommand("rm"), runtime);

		expect(refused).toEqual({ consumed: true, failed: true });
		expect(output).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
		expect(h.session.getTodoPhases()).toEqual(committed);
	});

	it("Cursor todoSync mirrors through replace; a refusal settles each call once and a reload keeps the committed list in either persist order", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		await seedList(h, tool);
		const cursor = createCursor(h);
		const mirroredList: TodoPhase[] = [{ name: "Tasks", tasks: [{ content: "cursor step", status: "in_progress" }] }];

		const mirrored = cursor.handlers.todoSync(
			{ merged: false, todos: [{ content: "cursor step", status: "in_progress" }] },
			"mirrored",
		);
		expect(phasesOf(mirrored.details)).toEqual(mirroredList);
		await flushTodoWrites(h.session);
		expect(h.recorder.calls.map(call => [call.method, call.phases])).toEqual([["replace", mirroredList]]);
		expect(h.session.getTodoPhases()).toEqual(mirroredList);
		expect(cursor.refusals).toEqual([]);

		h.sessionManager.appendCustomEntry("user_todo_edit", { phases: mirroredList });
		const reload = () => getLatestTodoPhasesFromEntries(h.sessionManager.getBranch());
		h.recorder.replaceError = new Error(REFUSAL);

		// The loop persisted the toolResult before the refusal landed.
		const early = cursor.handlers.todoSync(
			{ merged: false, todos: [{ content: "refused early", status: "pending" }] },
			"early",
		);
		h.sessionManager.appendMessage(early);
		await cursor.refusalSettled();
		expect(h.session.getTodoPhases()).toEqual(mirroredList);
		expect(reload()).toEqual(mirroredList);

		// The refusal landed before the loop persisted the toolResult.
		const late = cursor.handlers.todoSync(
			{ merged: false, todos: [{ content: "refused late", status: "pending" }] },
			"late",
		);
		await cursor.refusalSettled();
		h.sessionManager.appendMessage(late);
		expect(reload()).toEqual(mirroredList);
		expect(late.isError).toBe(true);
		expect(cursor.refusals).toHaveLength(2);
		expect(cursor.refusals[0]).toContain(REFUSAL);
		// One completion per call: a refusal does not send a second one.
		expect(cursor.ends.map(end => end.toolCallId)).toEqual(["mirrored", "early", "late"]);
	});

	it("Cursor refusal with a /todo edit queued behind it rewrites its result with, and reloads, the edited list", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		const seeded = await seedList(h, tool);
		h.sessionManager.appendCustomEntry("user_todo_edit", { phases: seeded });
		const gate = Promise.withResolvers<void>();
		const firstReplaceEntered = Promise.withResolvers<void>();
		let replaces = 0;
		h.recorder.beforeReplace = async () => {
			replaces += 1;
			if (replaces === 1) {
				firstReplaceEntered.resolve();
				await gate.promise;
				h.recorder.replaceError = new Error(REFUSAL);
			} else {
				h.recorder.replaceError = undefined;
			}
		};
		const cursor = createCursor(h);
		const { controller } = controllerContext(h.session);
		const editQueued = writeQueuedAt(h.session, 2);

		const result = cursor.handlers.todoSync(
			{ merged: false, todos: [{ content: "refused step", status: "pending" }] },
			"refused",
		);
		await firstReplaceEntered.promise;
		const edit = controller.handleTodoCommand('append "Queued edit"');
		await editQueued;
		gate.resolve();
		await edit;
		await cursor.refusalSettled();

		const committed = h.session.getTodoPhases();
		expect(contentsOf(committed)).toContain("Queued edit");
		expect(contentsOf(committed)).not.toContain("refused step");
		expect(getLatestTodoPhasesFromEntries(h.sessionManager.getBranch())).toEqual(committed);
		expect(cursor.ends.filter(end => end.toolCallId === "refused")).toHaveLength(1);
		expect(phasesOf(result.details)).toEqual(committed);
		expect(result.isError).toBe(true);
	});

	it("a Cursor sync queued behind an edit that renames a phase keeps the new name", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		const seeded = await seedList(h, tool);
		const gate = Promise.withResolvers<void>();
		const firstReplaceEntered = Promise.withResolvers<void>();
		let replaces = 0;
		h.recorder.beforeReplace = async () => {
			if (++replaces > 1) return;
			firstReplaceEntered.resolve();
			await gate.promise;
		};
		const cursor = createCursor(h);
		const renamed = seeded.map(phase => ({ ...phase, name: "Renamed" }));

		const rename = h.session.commitTodoPhases(renamed);
		await firstReplaceEntered.promise;
		cursor.handlers.todoSync(
			{
				merged: false,
				todos: [
					{ content: "first", status: "completed" },
					{ content: "second", status: "in_progress" },
				],
			},
			"cursor-call",
		);
		gate.resolve();
		await rename;
		await flushTodoWrites(h.session);

		expect(h.session.getTodoPhases()).toEqual([
			{
				name: "Renamed",
				tasks: [
					{ content: "first", status: "completed" },
					{ content: "second", status: "in_progress" },
				],
			},
		]);
	});

	it("resets and transcript reloads never call replace", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		await seedList(h, tool);

		await h.session.newSession();

		const target = SessionManager.create(h.dir, h.dir);
		target.appendMessage({ role: "user", content: "resumed", timestamp: 1 });
		const stored: TodoPhase[] = [{ name: "Stored", tasks: [{ content: "from disk", status: "pending" }] }];
		target.appendCustomEntry("user_todo_edit", { phases: stored });
		// Persistence is lazy until an assistant message exists; force the file so the entry is on disk.
		await target.ensureOnDisk();
		await target.flush();
		const targetFile = target.getSessionFile();
		await target.close();
		if (!targetFile) throw new Error("Expected the target session to be on disk");

		await h.session.switchSession(targetFile);

		expect(h.session.getTodoPhases()).toEqual(stored);
		expect(h.recorder.calls).toEqual([]);
	});

	it("an eval-bridged todo call reaches apply once and never replace, and does not undo a /todo edit queued behind it", async () => {
		const h = await createHarness();
		const { tool, toolSession } = createTodoTool(h.session, h.dir);
		const seeded = await seedList(h, tool);
		h.sessionManager.appendCustomEntry("user_todo_edit", { phases: seeded });
		const gate = Promise.withResolvers<void>();
		const applyEntered = Promise.withResolvers<void>();
		h.recorder.beforeApply = () => {
			applyEntered.resolve();
			return gate.promise;
		};
		const { controller } = controllerContext(h.session);
		const editQueued = writeQueuedAt(h.session, 2);

		const bridged = callSessionTool(
			"todo",
			{ op: "append", phase: "Work", items: ["Bridged item"] },
			{ session: toolSession },
		);
		await applyEntered.promise;
		const edit = controller.handleTodoCommand('append "Queued edit"');
		await editQueued;
		gate.resolve();
		await Promise.all([bridged, edit]);
		await flushTodoWrites(h.session);

		// The only replace is the /todo edit's; the bridge itself went through apply.
		expect(h.recorder.calls.map(call => call.method)).toEqual(["apply", "replace"]);
		expect(h.recorder.calls[0]?.op).toBe("append");
		const cache = h.session.getTodoPhases();
		expect(contentsOf(cache)).toEqual([...contentsOf(seeded), "Bridged item", "Queued edit"]);
		expect(getLatestTodoPhasesFromEntries(h.sessionManager.getBranch())).toEqual(cache);
	});

	it("a /todo verb and the slash helper queued behind a gated tool write keep the tool's item", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		await seedList(h, tool);
		const gate = Promise.withResolvers<void>();
		const applyStarted = Promise.withResolvers<void>();
		h.recorder.beforeApply = () => {
			applyStarted.resolve();
			return gate.promise;
		};
		const { ctx, controller } = controllerContext(h.session);
		const { runtime, output } = slashRuntime(h.session, h.dir);

		const toolCall = tool.execute("gated", { op: "append", phase: "Work", items: ["Tool item"] });
		await applyStarted.promise;
		// "Tool item" is not in the committed list yet: only the queued updater can see it.
		const verb = controller.handleTodoCommand("done Tool item");
		const slash = handleTodoAcp(todoCommand('append "Slash item"'), runtime);

		gate.resolve();
		await Promise.all([toolCall, verb, slash]);

		expect(ctx.showError).not.toHaveBeenCalled();
		expect(output).toHaveBeenLastCalledWith("Appended to Work: Slash item");
		expect(h.session.getTodoPhases().flatMap(phase => phase.tasks)).toEqual([
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "pending" },
			{ content: "Tool item", status: "completed" },
			{ content: "Slash item", status: "pending" },
		]);
	});

	it("skips the post-commit UI when the session changes while a /todo edit is pending", async () => {
		const h = await createHarness();
		const { tool } = createTodoTool(h.session, h.dir);
		await seedList(h, tool);
		const gate = Promise.withResolvers<void>();
		const replaceStarted = Promise.withResolvers<void>();
		h.recorder.beforeReplace = () => {
			replaceStarted.resolve();
			return gate.promise;
		};
		const { ctx, controller } = controllerContext(h.session);

		const edit = controller.handleTodoCommand('append "Late item"');
		await replaceStarted.promise;
		Object.assign(ctx, { session: {} });
		gate.resolve();
		await edit;

		expect(ctx.setTodos).not.toHaveBeenCalled();
		expect(ctx.agent.appendMessage).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});

describe("interactive mode with a backend", () => {
	let mode: InteractiveMode | undefined;

	beforeAll(async () => {
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true });
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	async function startMode(h: Harness): Promise<InteractiveMode> {
		const started = new InteractiveMode(h.session, "test", undefined, undefined, undefined, undefined, h.eventBus);
		mode = started;
		vi.spyOn(started.statusLine, "watchBranch").mockImplementation(() => {});
		const pending: TodoPhase[] = [{ name: "Plan", tasks: [{ content: "Fix review comments", status: "pending" }] }];
		h.session.sessionManager.appendCustomEntry("user_todo_edit", { phases: pending });
		h.session.setTodoPhases(pending);
		started.setTodos(h.session.getTodoPhases());
		await started.init();
		return started;
	}

	function completeSubagent(h: Harness): void {
		h.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "ReviewFixer",
			index: 0,
			agent: "task",
			description: "Fix review comments",
			status: "completed",
			detached: true,
		});
		vi.advanceTimersByTime(100);
	}

	it("sends the completed list to replace, reconciled with a queued tool write, and updates the HUD", async () => {
		const h = await createHarness();
		const started = await startMode(h);
		const { tool } = createTodoTool(h.session, h.dir);
		const gate = Promise.withResolvers<void>();
		const applyStarted = Promise.withResolvers<void>();
		h.recorder.beforeApply = () => {
			applyStarted.resolve();
			return gate.promise;
		};
		vi.useFakeTimers();

		const toolCall = tool.execute("gated", { op: "append", phase: "Plan", items: ["Tool item"] });
		await applyStarted.promise;
		completeSubagent(h);

		gate.resolve();
		await toolCall;
		await flushTodoWrites(h.session);

		const committed = h.session.getTodoPhases();
		expect(committed[0]?.tasks).toEqual([
			{ content: "Fix review comments", status: "completed" },
			{ content: "Tool item", status: "pending" },
		]);
		const replaces = h.recorder.calls.filter(call => call.method === "replace");
		expect(replaces).toHaveLength(1);
		expect(replaces[0]?.phases).toEqual(committed);
		expect(started.todoPhases).toEqual(committed);
	});

	it("keeps the list and the HUD, and warns, when replace throws; a later tick does not repeat the refused commit", async () => {
		const h = await createHarness();
		h.recorder.replaceError = new Error(REFUSAL);
		const started = await startMode(h);
		const warning = vi.spyOn(started, "showWarning").mockImplementation(() => {});
		vi.useFakeTimers();

		completeSubagent(h);
		await flushTodoWrites(h.session);

		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
		expect(h.session.getTodoPhases()[0]?.tasks[0]?.status).toBe("pending");
		expect(started.todoPhases[0]?.tasks[0]?.status).toBe("pending");
		expect(userTodoEdits(h.session)).toHaveLength(1);

		completeSubagent(h);
		await flushTodoWrites(h.session);

		expect(h.recorder.calls.filter(call => call.method === "replace")).toHaveLength(1);
		expect(warning).toHaveBeenCalledTimes(1);
	});

	it("a Cursor mirror the backend refuses leaves the HUD on the committed list", async () => {
		const h = await createHarness();
		const started = await startMode(h);
		const error = vi.spyOn(started, "showError").mockImplementation(() => {});
		const committed = structuredClone(h.session.getTodoPhases());
		h.recorder.replaceError = new Error(REFUSAL);
		const cursor = createCursor(h, "session");

		cursor.handlers.todoSync({ merged: false, todos: [{ content: "refused step", status: "pending" }] }, "refused");
		await cursor.refusalSettled();
		await Bun.sleep(0);

		expect(error).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
		expect(started.todoPhases).toEqual(committed);
	});
});
