import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { getCurrentThemeName, initTheme, setTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgTasksTodoClearDelay } from "@oh-my-pi/pi-coding-agent/tools/settings";

function renderTodos(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.todoContainer.render(120).join("\n"));
}

describe("InteractiveMode todo HUD persistence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let modelRegistry: ModelRegistry;

	async function replaceMode(sessionManager?: SessionManager): Promise<void> {
		if (mode) {
			mode.stop();
			await session.dispose();
		}
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-clear-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		await replaceMode();
	});

	afterEach(() => {
		session.setTodoPhases([]);
		mode.setTodos([]);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function setTodoClearDelay(todoClearDelay: number): void {
		cfgTasksTodoClearDelay.override(session.settings, todoClearDelay);
	}

	it("clears closed todos from the panel instantly without mutating session history", async () => {
		vi.useFakeTimers();
		setTodoClearDelay(0);
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{ content: "done task", status: "completed" },
					{ content: "abandoned task", status: "abandoned" },
				],
			},
		];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(session.getTodoPhases());
		vi.advanceTimersByTime(0);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).not.toContain("done task");
		expect(renderTodos(mode)).not.toContain("abandoned task");
		expect(session.getTodoPhases()).toEqual(phases);
	});

	/**
	 * Auto-clear used to fire on any list holding a closed task, so a plan the
	 * agent was mid-way through had its finished tasks deleted from the HUD's
	 * copy: the phase counter reset, the checked row vanished, and the stage
	 * renumbered — the panel reported no progress at all until the next `todo`
	 * call restored the real snapshot. It may only fire on a settled list.
	 */
	const unfinishedPlan = (): TodoPhase[] => [
		{
			name: "Implementation",
			tasks: [
				{ content: "done task", status: "completed" },
				{ content: "abandoned task", status: "abandoned" },
				{ content: "current task", status: "in_progress" },
			],
		},
	];

	it("keeps an unfinished plan's progress when the auto-clear delay elapses", () => {
		setTodoClearDelay(1);
		vi.useFakeTimers();

		mode.setTodos(unfinishedPlan());
		vi.advanceTimersByTime(60_000);

		const rendered = renderTodos(mode);
		// Progress counts every closed task, abandoned included: the walking
		// viewport hides both, so the counter is the only signal they existed.
		expect(rendered).toContain("2/3");
		expect(rendered).toContain("current task");
	});

	it("keeps an unfinished plan's progress when auto-clear is instant", () => {
		setTodoClearDelay(0);

		mode.setTodos(unfinishedPlan());

		const rendered = renderTodos(mode);
		expect(rendered).toContain("2/3");
		expect(rendered).toContain("current task");
	});

	it("leaves closed todos visible when auto-clear is disabled", () => {
		setTodoClearDelay(-1);

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }]);

		expect(renderTodos(mode)).toContain("done task");
	});

	it("reloads the visible HUD from the explicitly attached session", async () => {
		setTodoClearDelay(-1);
		const focusedDir = TempDir.createSync("@pi-focused-todo-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const focusedSession = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(focusedDir.path(), focusedDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		try {
			session.setTodoPhases([{ name: "Main plan", tasks: [{ content: "stale main task", status: "in_progress" }] }]);
			mode.setTodos(session.getTodoPhases());
			focusedSession.setTodoPhases([
				{
					name: "Worker plan",
					tasks: [
						{ content: "finished worker task", status: "completed" },
						{ content: "current worker task", status: "in_progress" },
					],
				},
			]);

			await mode.reloadTodos(focusedSession);

			const rendered = renderTodos(mode);
			expect(rendered).toContain("Worker plan");
			expect(rendered).toContain("1/2");
			expect(rendered).toContain("current worker task");
			expect(rendered).not.toContain("stale main task");
		} finally {
			await focusedSession.dispose();
			focusedDir.removeSync();
		}
	});

	it("clears closed todos after the configured delay", async () => {
		setTodoClearDelay(1);
		vi.useFakeTimers();

		const phases: TodoPhase[] = [{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(session.getTodoPhases());
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(999);
		expect(renderTodos(mode)).toContain("done task");
		expect(renderTodos(mode)).toContain("TODO");

		vi.advanceTimersByTime(1);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).not.toContain("done task");
	});

	it("keeps a matching todo open and the plan visible when its subagent completes", async () => {
		await replaceMode();
		setTodoClearDelay(0);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const phases: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "pending" }] },
		];
		const planEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(session.getTodoPhases());
		await mode.init();
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "ReviewFixer",
			index: 0,
			agent: "task",
			description: "Fix review comments",
			status: "completed",
			detached: true,
		});
		vi.advanceTimersByTime(100);
		vi.advanceTimersByTime(0);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		// A finished subagent is not a `todo done`: the plan stays open, so even
		// instant auto-clear has nothing to dismiss and nothing is persisted.
		expect(session.getTodoPhases()).toEqual(phases);
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom")
				.map(entry => entry.id),
		).toEqual([planEntryId]);
		expect(renderTodos(mode)).toContain("Fix review comments");
	});

	it("does not persist a stale reveal after the owning snapshot changes", async () => {
		await replaceMode();
		vi.useFakeTimers();
		const settle = Promise.withResolvers<void>();
		vi.spyOn(session, "settleInFlightMessagePersistence").mockReturnValue(settle.promise);
		const oldPhases: TodoPhase[] = [{ name: "Old", tasks: [{ content: "old", status: "completed" }] }];
		const newPhases: TodoPhase[] = [{ name: "New", tasks: [{ content: "new", status: "in_progress" }] }];
		mode.setTodos(oldPhases);
		mode.setTodoExpanded(true);
		mode.setTodos(newPhases);
		settle.resolve();
		await Promise.resolve();
		expect(
			session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === "todo_hud_state"),
		).toBe(false);
		expect(renderTodos(mode)).toContain("new");
	});

	it("keeps a newer canonical TODO edit after an older result finishes persisting", async () => {
		await replaceMode();
		const settle = Promise.withResolvers<void>();
		vi.spyOn(session, "settleInFlightMessagePersistence").mockReturnValue(settle.promise);
		const older: TodoPhase[] = [{ name: "Old", tasks: [{ content: "old task", status: "in_progress" }] }];
		const newer: TodoPhase[] = [{ name: "New", tasks: [{ content: "new task", status: "in_progress" }] }];
		session.setTodoPhases(older);
		mode.setTodos(older);
		const pending = mode.eventController.handleEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: "old-todo",
				content: [],
				isError: false,
				timestamp: Date.now(),
				details: { phases: older },
			},
		});
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases: newer });
		session.setTodoPhases(newer);
		mode.setTodos(newer);
		settle.resolve();
		await pending;
		expect(session.getTodoPhases()).toEqual(newer);
		expect(renderTodos(mode)).toContain("new task");
		expect(renderTodos(mode)).not.toContain("old task");
	});

	it("cancels an old dismissal timer when a replacement plan becomes visible", async () => {
		await replaceMode();
		vi.useFakeTimers();
		cfgTasksTodoClearDelay.override(session.settings, 1);
		const completed: TodoPhase[] = [{ name: "Old", tasks: [{ content: "old", status: "completed" }] }];
		const replacement: TodoPhase[] = [{ name: "New", tasks: [{ content: "new", status: "in_progress" }] }];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases: completed });
		mode.setTodos(completed);
		vi.advanceTimersByTime(500);
		mode.setTodos(replacement);
		vi.advanceTimersByTime(1000);
		await Promise.resolve();
		expect(renderTodos(mode)).toContain("new");
		expect(renderTodos(mode)).not.toContain("old");
	});

	it("treats identical canonical todo edits as new snapshots after dismissal", async () => {
		await replaceMode();
		vi.useFakeTimers();
		setTodoClearDelay(1);
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "same task", status: "completed" }] }];
		const oldSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		vi.advanceTimersByTime(1000);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).toBe("");

		const newSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		expect(newSourceEntryId).not.toBe(oldSourceEntryId);
		expect(renderTodos(mode)).toContain("same task");

		vi.advanceTimersByTime(1000);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).toBe("");
		expect(session.getTodoPhases()).toEqual(phases);
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === "user_todo_edit")
				.map(entry => entry.id),
		).toEqual([oldSourceEntryId, newSourceEntryId]);
	});

	it("does not carry a pending dismissal into a new session with identical todos", async () => {
		await replaceMode();
		vi.useFakeTimers();
		setTodoClearDelay(1);
		const settle = Promise.withResolvers<void>();
		vi.spyOn(session, "settleInFlightMessagePersistence").mockReturnValue(settle.promise);
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "same task", status: "completed" }] }];
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		const oldSessionId = session.sessionManager.getSessionId();
		vi.advanceTimersByTime(1000);

		await session.sessionManager.newSession();
		const newSessionId = session.sessionManager.getSessionId();
		const newSourceEntryId = session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		expect(newSessionId).not.toBe(oldSessionId);
		expect(renderTodos(mode)).toContain("same task");

		settle.resolve();
		await Promise.resolve();
		await session.sessionManager.flush();
		await Promise.resolve();
		expect(renderTodos(mode)).toContain("same task");
		expect(session.getTodoPhases()).toEqual(phases);
		expect(
			session.sessionManager.getBranch().map(entry => ({
				id: entry.id,
				customType: entry.type === "custom" ? entry.customType : undefined,
			})),
		).toEqual([{ id: newSourceEntryId, customType: "user_todo_edit" }]);
	});

	it("persists dismissal and explicit reveal across fresh session loads without losing tasks", async () => {
		await replaceMode();
		vi.useFakeTimers();
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "ship", status: "completed" }] }];
		cfgTasksTodoClearDelay.override(session.settings, 0);
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Finished the plan." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases });
		session.setTodoPhases(phases);
		mode.setTodos(phases);
		vi.advanceTimersByTime(0);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(renderTodos(mode)).toBe("");
		expect(session.getTodoPhases()).toEqual(phases);
		const file = session.sessionManager.getSessionFile()!;
		await replaceMode(await SessionManager.open(file));
		await mode.reloadTodos();
		expect(renderTodos(mode)).toBe("");
		expect(session.getTodoPhases()).toEqual(phases);
		mode.todoExpanded = true;
		await mode.handleTodoCommand("expand");
		expect(renderTodos(mode)).toContain("ship");
		await session.sessionManager.flush();
		await replaceMode(await SessionManager.open(file));
		await mode.reloadTodos();
		expect(renderTodos(mode)).toContain("ship");
		expect(session.getTodoPhases()).toEqual(phases);
	});
});

describe("InteractiveMode todo HUD anchor", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(() => {
		mode.setTodos([]);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("renders a Todos tree: stage progression header, active stage expanded, others collapsed", () => {
		mode.setTodos([
			{
				name: "Foundation",
				tasks: [
					{ content: "first task", status: "completed" },
					{ content: "second task", status: "in_progress" },
					{ content: "third task", status: "pending" },
				],
			},
			{
				name: "Verification",
				tasks: [{ content: "run tests", status: "pending" }],
			},
		]);

		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));

		// Lightened: no boxed top/bottom rules.
		expect(lines.some(line => line === "─".repeat(80))).toBe(false);
		// The title remains a compact anchor; overall progress colors the tree
		// spine and tail, not the title text.
		const root = lines.find(line => line.includes("TODO"));
		expect(root?.trim()).toBe("TODO");
		// Active stage: highlighted header with its own task progress, expanded as a
		// connector tree; the just-completed task stays as the lead row so progress
		// is visible while the stage still has open work.
		expect(lines.some(line => line.includes("I. Foundation") && line.includes("1/3"))).toBe(true);
		const secondLine = lines.find(line => line.includes("second task"));
		expect(secondLine).toContain(theme.tree.branch);
		expect(secondLine).toContain(theme.checkbox.unchecked);
		expect(lines.some(line => line.includes("third task"))).toBe(true);
		const firstLine = lines.find(line => line.includes("first task"));
		expect(firstLine).toContain(theme.checkbox.checked);
		// Upcoming stage: header with its own progress, but collapsed (no task rows).
		expect(lines.some(line => line.includes("II. Verification") && line.includes("0/1"))).toBe(true);
		expect(lines.some(line => line.includes("run tests"))).toBe(false);
		// No overflow rows — the header/progress counts imply what is hidden.
		expect(lines.some(line => line.includes("more"))).toBe(false);
	});

	it("renders nothing when there are no todos", () => {
		mode.setTodos([]);
		expect(mode.todoContainer.render(80)).toHaveLength(0);
	});

	it("keeps the summed progress bar but omits the roman numeral for a single-phase list", () => {
		mode.setTodos([
			{
				name: "Tasks",
				tasks: [
					{ content: "alpha", status: "pending" },
					{ content: "beta", status: "pending" },
				],
			},
		]);
		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));
		// One stage still renders the compact title; progress belongs to the
		// tree spine and tail.
		const root = lines.find(line => line.includes("TODO"));
		expect(root?.trim()).toBe("TODO");
		// The stage keeps its task progress; no roman numeral for a lone stage.
		expect(lines.some(line => line.includes("Tasks") && line.includes("0/2"))).toBe(true);
		expect(lines.some(line => line.includes("I. Tasks"))).toBe(false);
		expect(lines.some(line => line.includes("alpha"))).toBe(true);
	});

	it("caps the visible stage list and summarizes the hidden ones in an overflow row", () => {
		const stage = (name: string): TodoPhase => ({ name, tasks: [{ content: `${name} task`, status: "pending" }] });
		mode.setTodos([
			stage("Discovery"),
			stage("Two"),
			stage("Three"),
			stage("Four"),
			stage("Five"),
			stage("Six"),
			stage("Seven"),
		]);
		const lines = mode.todoContainer
			.render(80)
			.flatMap(line => line.split("\n"))
			.map(line => Bun.stripANSI(line));
		// Active stage + four following stages render; the rest collapse into a
		// trailing "… n more stages" row.
		expect(lines.some(line => line.includes("II. Two"))).toBe(true);
		expect(lines.some(line => line.includes("V. Five"))).toBe(true);
		expect(lines.some(line => line.includes("Six"))).toBe(false);
		expect(lines.some(line => line.includes("2 more stages"))).toBe(true);
		// Hidden stages do not change the compact title.
		const root = lines.find(line => line.includes("TODO"));
		expect(root?.trim()).toBe("TODO");
	});

	it("wraps a row wider than the panel beneath its own content instead of the panel edge", () => {
		mode.setTodos([
			{
				name: "A stage whose name is far too long to fit on one sixty column row, stage-end",
				tasks: [
					{ content: "finished", status: "completed" },
					{
						content: "a branch task described at such length that it has to wrap, branch-end",
						status: "in_progress",
					},
					{
						content: "the last task, also described at such length that it wraps, last-end",
						status: "pending",
					},
				],
			},
		]);

		const styled = mode.todoContainer.render(60);
		const rows = styled.map(row => Bun.stripANSI(row).trimEnd());
		const pad = " ".repeat(rows.find(row => row.trim() === "TODO")!.indexOf("TODO"));
		// Rows after the first of the logical row that starts at `head` and ends at `end`.
		const continuations = (head: string, end: string): string[] =>
			rows.slice(rows.findIndex(row => row.includes(head)) + 1, rows.findIndex(row => row.includes(end)) + 1);
		const { branch, last, vertical } = theme.tree;
		const spine = `${pad} ${vertical}  `;

		// A stage name hangs beneath itself, the progress spine running on beside it.
		const stage = continuations("A stage whose", "stage-end");
		expect(stage.length).toBeGreaterThan(0);
		for (const row of stage) expect(row).toMatch(new RegExp(`^${spine}\\S`));
		// The name is bold; the spine beside its continuation is styled like the
		// stage's own connector instead of inheriting that weight.
		const stageRow = rows.findIndex(row => row.includes("A stage whose"));
		expect(styled[stageRow + 1]!.split(vertical)[0]).toBe(styled[stageRow]!.split(branch)[0]!);

		// A task hangs beneath its checkbox: the spine and the task rail both continue.
		expect(rows.find(row => row.includes("a branch task"))).toStartWith(`${spine}${branch} `);
		const branchTask = continuations("a branch task", "branch-end");
		expect(branchTask.length).toBeGreaterThan(0);
		for (const row of branchTask) expect(row).toMatch(new RegExp(`^${spine}${vertical}  \\S`));

		// Nothing follows the last task, so its rail ends while the spine continues.
		expect(rows.find(row => row.includes("the last task"))).toStartWith(`${spine}${last} `);
		const lastTask = continuations("the last task", "last-end");
		expect(lastTask.length).toBeGreaterThan(0);
		for (const row of lastTask) expect(row).toMatch(new RegExp(`^${spine}   \\S`));
	});

	it("keeps a wrapped task hanging when a theme switch re-renders the panel", async () => {
		mode.setTodos([
			{
				name: "Stage",
				tasks: [
					{
						content:
							"a task described at such length that it cannot fit on one row of the panel even at one hundred and twenty columns, so it wraps",
						status: "in_progress",
					},
					{ content: "short", status: "pending" },
				],
			},
		]);
		const before = renderTodos(mode);
		const original = getCurrentThemeName() ?? "dark";
		try {
			await setTheme(original === "light" ? "dark" : "light");
			// A theme switch invalidates components without rebuilding the todo rows.
			mode.todoContainer.invalidate();
			expect(renderTodos(mode)).toBe(before);
		} finally {
			await setTheme(original);
		}
	});

	it("expands and collapses the complete todo HUD through /todo", async () => {
		mode.setTodos([
			{
				name: "Implementation",
				tasks: Array.from({ length: 8 }, (_, index): TodoItem => ({
					content: `Task ${index + 1}`,
					status: index === 0 ? "in_progress" : "pending",
				})),
			},
		]);

		await mode.handleTodoCommand("expand");
		await mode.handleTodoCommand("expand");

		expect(renderTodos(mode)).toContain("Task 8");
		expect(renderTodos(mode)).not.toContain("more todo");

		await mode.handleTodoCommand("collapse");
		await mode.handleTodoCommand("collapse");

		expect(renderTodos(mode)).not.toContain("Task 8");
		expect(renderTodos(mode)).toContain("3 more todos");
	});

	describe("compact todo for small terminal height (< 18 rows)", () => {
		function setTerminalRows(rows: number): void {
			Object.defineProperty(mode.ui.terminal, "rows", {
				get: () => rows,
				configurable: true,
			});
		}

		afterEach(() => {
			setTerminalRows(24);
			mode.loadingAnimation = undefined;
			mode.statusContainer.disposeChildren();
		});

		it("renders todo as a single line item aligned to the right when terminal height < 18", () => {
			setTerminalRows(15);
			mode.setTodos([
				{
					name: "Phase 1",
					tasks: [
						{ content: "Setup database", status: "completed" },
						{ content: "Create API endpoints", status: "in_progress" },
						{ content: "Write tests", status: "pending" },
					],
				},
			]);

			// todoContainer is empty in compact mode
			expect(mode.todoContainer.render(100)).toHaveLength(0);

			// statusContainer renders the compact right-aligned todo above editor
			const rendered = mode.statusContainer.render(100);
			expect(rendered.length).toBeGreaterThan(0);
			const lastLine = Bun.stripANSI(rendered[rendered.length - 1] ?? "");
			expect(lastLine).toContain("TODO 1/3");
			expect(lastLine).toContain("Create API endpoints");
			// Right-aligned: ends with the todo text (with trailing space)
			expect(lastLine.trimEnd().endsWith("Create API endpoints")).toBe(true);
			expect(lastLine.startsWith(" ")).toBe(true);
		});

		it("places compact todo on the right side of the active loader / intent spinner", () => {
			setTerminalRows(14);
			mode.setTodos([
				{
					name: "Tasks",
					tasks: [
						{ content: "Inspect server", status: "in_progress" },
						{ content: "Deploy fix", status: "pending" },
					],
				},
			]);

			mode.ensureLoadingAnimation();
			mode.setWorkingMessage("Reading src/index.ts (esc to interrupt)");

			expect(mode.todoContainer.render(120)).toHaveLength(0);

			const rendered = mode.statusContainer.render(120);
			expect(rendered.length).toBeGreaterThanOrEqual(2);
			const lastLine = Bun.stripANSI(rendered[rendered.length - 1] ?? "");
			// Left side has the intent spinner/message
			expect(lastLine).toContain("Reading src/index.ts");
			// Right side has the compact todo
			expect(lastLine).toContain("TODO 0/2");
			expect(lastLine).toContain("Inspect server");
			// Left message comes before right todo
			expect(lastLine.indexOf("Reading src/index.ts")).toBeLessThan(lastLine.indexOf("TODO 0/2"));
		});

		it("shows completed summary when all tasks are done in compact mode", () => {
			setTerminalRows(16);
			mode.setTodos([
				{
					name: "Tasks",
					tasks: [
						{ content: "Task 1", status: "completed" },
						{ content: "Task 2", status: "completed" },
					],
				},
			]);

			const rendered = mode.statusContainer.render(100);
			const lastLine = Bun.stripANSI(rendered[rendered.length - 1] ?? "");
			expect(lastLine).toContain("TODO 2/2");
			expect(lastLine).toContain("done");
		});

		it("switches dynamically between multi-line HUD and compact single line on resize", () => {
			mode.setTodos([
				{
					name: "Tasks",
					tasks: [{ content: "Refactor router", status: "in_progress" }],
				},
			]);

			// Terminal >= 18 rows: full tree HUD
			setTerminalRows(24);
			expect(mode.todoContainer.render(100).length).toBeGreaterThan(0);
			expect(mode.statusContainer.render(100)).toHaveLength(0);

			// Terminal < 18 rows: compact mode
			setTerminalRows(15);
			expect(mode.todoContainer.render(100)).toHaveLength(0);
			expect(mode.statusContainer.render(100).length).toBeGreaterThan(0);
			const compactLine = Bun.stripANSI(mode.statusContainer.render(100).slice(-1)[0] ?? "");
			expect(compactLine).toContain("TODO 0/1");
			expect(compactLine).toContain("Refactor router");

			// Resize back >= 18 rows
			setTerminalRows(24);
			expect(mode.todoContainer.render(100).length).toBeGreaterThan(0);
			expect(mode.statusContainer.render(100)).toHaveLength(0);
		});
	});
});
