import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { handleTodoAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhasesUpdate } from "@oh-my-pi/pi-coding-agent/tools/todo-backend";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	collectNotices,
	contentsOf,
	createTodoBackendRecorder,
	createTodoSession,
	disposeTodoSession,
	flushTodoWrites,
	hold,
	todo,
	type TodoBackendRecorder,
	userTodoEdits,
} from "./helpers/todo-backend";

const BACKEND_ID = "recorder";
const REFUSAL = "tracker is offline";

interface Harness {
	session: AgentSession;
	recorder: TodoBackendRecorder;
	dir: string;
	eventBus: EventBus;
	sessionManager: SessionManager;
}

let mode: InteractiveMode | undefined;
const cleanups: Array<() => Promise<void> | void> = [];

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

async function createHarness(): Promise<Harness> {
	const tempDir = await TempDir.create("@pi-todo-writers-");
	const dir = tempDir.path();
	const eventBus = new EventBus();
	const sessionManager = SessionManager.create(dir, dir);
	const recorder = createTodoBackendRecorder(BACKEND_ID);
	const session = await createTodoSession(dir, {
		backend: BACKEND_ID,
		extensions: [recorder.extension()],
		eventBus,
		sessionManager,
	});
	cleanups.push(async () => {
		await disposeTodoSession(session);
		await tempDir.remove();
	});
	return { session, recorder, dir, eventBus, sessionManager };
}

async function seedList(h: Harness): Promise<TodoPhase[]> {
	await todo(h.session, { op: "init", list: [{ phase: "Work", items: ["first", "second"] }] });
	h.recorder.calls.length = 0;
	return h.session.getTodoPhases();
}

function controllerContext(session: AgentSession) {
	const ctx = {
		agent: { appendMessage: vi.fn() },
		session,
		viewSession: session,
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

function createCursor(h: Harness) {
	return new CursorExecHandlers({
		cwd: h.dir,
		tools: new Map(),
		getTodoPhases: () => h.session.getTodoPhases(),
		commitTodoPhases: update => h.session.commitTodoPhases(update),
	});
}

describe("todo writers reach the selected backend's replace", () => {
	it("/todo and the slash helper send the full new list to replace and commit it once replace resolves", async () => {
		const h = await createHarness();
		const seeded = await seedList(h);
		const { ctx, controller } = controllerContext(h.session);
		const { runtime } = slashRuntime(h.session, h.dir);

		await controller.handleTodoCommand('append "Third item"');
		await handleTodoAcp(todoCommand('append "Slash item"'), runtime);

		const replaces = h.recorder.calls.filter(call => call.method === "replace");
		expect(replaces.map(call => contentsOf(call.phases))).toEqual([
			[...contentsOf(seeded), "Third item"],
			[...contentsOf(seeded), "Third item", "Slash item"],
		]);
		expect(h.session.getTodoPhases()).toEqual(replaces[1]!.phases);
		expect(userTodoEdits(h.session)).toHaveLength(2);
		expect(ctx.setTodos).toHaveBeenCalledWith(replaces[0]!.phases);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("/todo and the slash helper surface the backend's message and change nothing when replace throws", async () => {
		const h = await createHarness();
		const seeded = await seedList(h);
		h.recorder.replaceError = new Error(REFUSAL);
		const { ctx, controller } = controllerContext(h.session);
		const { runtime, output } = slashRuntime(h.session, h.dir);

		await controller.handleTodoCommand('append "Refused item"');
		const refused = await handleTodoAcp(todoCommand("rm"), runtime);

		expect(ctx.showError).toHaveBeenCalledTimes(1);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
		expect(ctx.setTodos).not.toHaveBeenCalled();
		expect(ctx.agent.appendMessage).not.toHaveBeenCalled();
		expect(refused).toEqual({ consumed: true, failed: true });
		expect(output).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
		expect(h.session.getTodoPhases()).toEqual(seeded);
		expect(userTodoEdits(h.session)).toHaveLength(0);
	});

	it("Cursor todoSync mirrors through replace; a backend that throws cannot refuse it, only warns once, and a reload keeps the list", async () => {
		const h = await createHarness();
		await seedList(h);
		const cursor = createCursor(h);
		const notices = collectNotices(h.session);
		const reload = () => getLatestTodoPhasesFromEntries(h.sessionManager.getBranch());
		const mirroredList: TodoPhase[] = [{ name: "Tasks", tasks: [{ content: "cursor step", status: "in_progress" }] }];

		cursor.todoSync({ merged: false, todos: [{ content: "cursor step", status: "in_progress" }] }, "mirrored");
		await flushTodoWrites(h.session);
		expect(h.recorder.calls.map(call => [call.method, call.phases])).toEqual([["replace", mirroredList]]);
		expect(h.session.getTodoPhases()).toEqual(mirroredList);
		expect(notices).toEqual([]);

		h.recorder.replaceError = new Error(REFUSAL);
		const result = cursor.todoSync({ merged: false, todos: [{ content: "kept anyway", status: "pending" }] }, "kept");
		await flushTodoWrites(h.session);

		const kept: TodoPhase[] = [{ name: "Tasks", tasks: [{ content: "kept anyway", status: "pending" }] }];
		expect(result.isError).not.toBe(true);
		expect(h.session.getTodoPhases()).toEqual(kept);
		expect(reload()).toEqual(kept);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(REFUSAL);
	});

	it("a Cursor sync queued behind an edit that renames a phase keeps the new name", async () => {
		const h = await createHarness();
		const seeded = await seedList(h);
		const gate = hold(h.recorder, "replace");
		const cursor = createCursor(h);
		const renamed = seeded.map(phase => ({ ...phase, name: "Renamed" }));

		const rename = h.session.editTodoPhases(() => renamed);
		await gate.started.promise;
		cursor.todoSync(
			{
				merged: false,
				todos: [
					{ content: "first", status: "completed" },
					{ content: "second", status: "in_progress" },
				],
			},
			"cursor-call",
		);
		gate.release.resolve();
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

	it("a session switch sends replace the list the session now holds", async () => {
		const h = await createHarness();
		await seedList(h);

		const target = SessionManager.create(h.dir, h.dir);
		target.appendMessage({ role: "user", content: "resumed", timestamp: 1 });
		const stored: TodoPhase[] = [{ name: "Stored", tasks: [{ content: "from disk", status: "pending" }] }];
		target.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: stored });
		// Persistence is lazy until an assistant message exists; force the file so the entry is on disk.
		await target.ensureOnDisk();
		await target.flush();
		const targetFile = target.getSessionFile();
		await target.close();
		if (!targetFile) throw new Error("Expected the target session to be on disk");

		await h.session.switchSession(targetFile);
		await flushTodoWrites(h.session);

		expect(h.session.getTodoPhases()).toEqual(stored);
		expect(h.recorder.calls).toEqual([{ method: "replace", phases: stored }]);
	});

	it("an eval-bridged todo call reaches apply once and never replace, and does not undo a /todo edit queued behind it", async () => {
		const h = await createHarness();
		const seeded = await seedList(h);
		const toolSession = {
			getToolByName: (name: string) => h.session.getToolByName(name),
			commitTodoPhases: (update: TodoPhasesUpdate) => h.session.commitTodoPhases(update),
		} satisfies Pick<ToolSession, "getToolByName" | "commitTodoPhases">;
		const gate = hold(h.recorder, "apply");
		const { controller } = controllerContext(h.session);

		const bridged = callSessionTool(
			"todo",
			{ op: "append", phase: "Work", items: ["Bridged item"] },
			{ session: toolSession as ToolSession },
		);
		await gate.started.promise;
		const queuedEdit = controller.handleTodoCommand('append "Queued edit"');
		gate.release.resolve();
		await Promise.all([bridged, queuedEdit]);
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
		await seedList(h);
		const gate = hold(h.recorder, "apply");
		const { ctx, controller } = controllerContext(h.session);
		const { runtime, output } = slashRuntime(h.session, h.dir);

		const toolCall = todo(h.session, { op: "append", phase: "Work", items: ["Tool item"] });
		await gate.started.promise;
		// "Tool item" is not in the committed list yet: only the queued updater can see it.
		const verb = controller.handleTodoCommand("done Tool item");
		const slash = handleTodoAcp(todoCommand('append "Slash item"'), runtime);

		gate.release.resolve();
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

	it("keeps the focused agent's HUD but still tells the main agent when focus moves during a /todo edit", async () => {
		const h = await createHarness();
		await seedList(h);
		const gate = hold(h.recorder, "replace");
		const { ctx, controller } = controllerContext(h.session);

		const edit = controller.handleTodoCommand('append "Focus item"');
		await gate.started.promise;
		ctx.viewSession = {} as AgentSession;
		gate.release.resolve();
		await edit;

		expect(ctx.setTodos).not.toHaveBeenCalled();
		expect(contentsOf(h.session.getTodoPhases())).toContain("Focus item");
		expect(ctx.agent.appendMessage).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});

describe("interactive mode with a backend", () => {
	async function startMode(h: Harness): Promise<InteractiveMode> {
		const started = new InteractiveMode(h.session, "test", undefined, undefined, undefined, h.eventBus);
		mode = started;
		vi.spyOn(started.statusLine, "watchBranch").mockImplementation(() => {});
		const pending: TodoPhase[] = [{ name: "Plan", tasks: [{ content: "Fix review comments", status: "pending" }] }];
		h.session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: pending });
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
		const gate = hold(h.recorder, "apply");
		vi.useFakeTimers();

		const toolCall = todo(h.session, { op: "append", phase: "Plan", items: ["Tool item"] });
		await gate.started.promise;
		completeSubagent(h);

		gate.release.resolve();
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

	it("commits the completed list and shows it on the HUD when replace throws, and warns once", async () => {
		const h = await createHarness();
		h.recorder.replaceError = new Error(REFUSAL);
		const started = await startMode(h);
		const warning = vi.spyOn(started, "showWarning").mockImplementation(() => {});
		vi.useFakeTimers();

		completeSubagent(h);
		await flushTodoWrites(h.session);

		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
		expect(h.session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
		expect(started.todoPhases[0]?.tasks[0]?.status).toBe("completed");
		expect(getLatestTodoPhasesFromEntries(h.sessionManager.getBranch())).toEqual(h.session.getTodoPhases());
	});
});
