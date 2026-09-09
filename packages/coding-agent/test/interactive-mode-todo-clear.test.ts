import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

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

	async function replaceMode(): Promise<void> {
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
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
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
		session.settings.override("tasks.todoClearDelay", todoClearDelay);
	}

	it("clears closed todos from the panel instantly without mutating session history", () => {
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
		session.setTodoPhases(phases);

		mode.setTodos(session.getTodoPhases());

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

	it("clears closed todos after the configured delay", () => {
		setTodoClearDelay(1);
		vi.useFakeTimers();

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }]);
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(999);
		expect(renderTodos(mode)).toContain("done task");
		expect(renderTodos(mode)).toContain("TODO");

		vi.advanceTimersByTime(1);
		expect(renderTodos(mode)).not.toContain("done task");
	});

	it("marks todos complete when subagent reconciliation reports a finished agent", async () => {
		await replaceMode();
		setTodoClearDelay(-1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		session.setTodoPhases([
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "pending" }] },
		]);
		mode.setTodos(session.getTodoPhases());

		await mode.init();
		// Subagent lifecycle changes coalesce behind a 100ms observer UI sync
		// timer before todo reconciliation runs; flush it deterministically.
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

		expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
	});

	it("reconciles focused worker todos without overwriting the main session", async () => {
		await replaceMode();
		setTodoClearDelay(-1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const mainPhases: TodoPhase[] = [
			{ name: "Main plan", tasks: [{ content: "orchestrate the main work", status: "in_progress" }] },
		];
		session.setTodoPhases(mainPhases);
		mode.setTodos(session.getTodoPhases());
		await mode.init();

		const focusedDir = TempDir.createSync("@pi-focused-reconcile-");
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
		focusedSession.setTodoPhases([
			{
				name: "Worker plan",
				tasks: [
					{ content: "apply nested review fixes", status: "pending" },
					{ content: "verify worker changes", status: "in_progress" },
				],
			},
		]);
		const registry = AgentRegistry.global();
		const agentId = "FocusedTodoParent";
		const ref = registry.register({
			id: agentId,
			displayName: agentId,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: focusedSession,
			status: "running",
		});
		try {
			await mode.focusAgentSession(agentId);
			expect(renderTodos(mode)).toContain("apply nested review fixes");

			vi.useFakeTimers();
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: `${agentId}/NestedFixer`,
				index: 0,
				agent: "task",
				description: "apply nested review fixes",
				status: "completed",
				detached: true,
			});
			vi.advanceTimersByTime(100);

			expect(focusedSession.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
			expect(session.getTodoPhases()).toEqual(mainPhases);
			expect(renderTodos(mode)).toContain("1/2");

			await mode.unfocusSession();
			expect(renderTodos(mode)).toContain("orchestrate the main work");
			expect(renderTodos(mode)).not.toContain("apply nested review fixes");
		} finally {
			vi.useRealTimers();
			if (mode.focusedAgentId) await mode.unfocusSession();
			registry.unregister(agentId, ref);
			await focusedSession.dispose();
			focusedDir.removeSync();
		}
	});

	it("reconciles into the snapshot's owning session even when viewSession has moved on", async () => {
		// Reproduces the focus-attach window deterministically: the HUD snapshot is
		// reloaded from the worker (making it the owner) while viewSession is still
		// the main session. A subagent completing here must land in the worker, not
		// be written over the main session's canonical plan (#9575 review).
		await replaceMode();
		setTodoClearDelay(-1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		const mainPhases: TodoPhase[] = [
			{ name: "Main plan", tasks: [{ content: "orchestrate the main work", status: "in_progress" }] },
		];
		session.setTodoPhases(mainPhases);
		mode.setTodos(session.getTodoPhases());
		await mode.init();

		const workerDir = TempDir.createSync("@pi-owner-reconcile-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const workerSession = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(workerDir.path(), workerDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		workerSession.setTodoPhases([
			{ name: "Worker plan", tasks: [{ content: "run the delegated fix", status: "in_progress" }] },
		]);
		try {
			// Owner := worker, viewSession still := main.
			await mode.reloadTodos(workerSession);
			expect(renderTodos(mode)).toContain("run the delegated fix");

			vi.useFakeTimers();
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: "DelegatedFixer",
				index: 0,
				agent: "task",
				description: "run the delegated fix",
				status: "completed",
				detached: true,
			});
			vi.advanceTimersByTime(100);

			expect(workerSession.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
			expect(session.getTodoPhases()).toEqual(mainPhases);
			expect(renderTodos(mode)).toContain("1/1");
		} finally {
			vi.useRealTimers();
			await workerSession.dispose();
			workerDir.removeSync();
		}
	});

	it("completes a blocked todo when the detached subagent it waits on finishes", async () => {
		await replaceMode();
		setTodoClearDelay(-1);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		// A todo blocked while waiting on a detached subagent. Blocked todos are
		// excluded from the stop reminder, so if reconciliation skipped them this
		// would strand silently after the subagent completes.
		session.setTodoPhases([
			{
				name: "Implementation",
				tasks: [{ content: "Fix review comments", status: "blocked", blocker: "waiting on ReviewFixer" }],
			},
		]);
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

		const task = session.getTodoPhases()[0]?.tasks[0];
		expect(task?.status).toBe("completed");
		// The blocker note is dropped with the blocked status — the wait is over.
		expect(task?.blocker).toBeUndefined();
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
