import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { InteractiveMode } from "@pk-nerdsaver-ai/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import type { TodoPhase } from "@pk-nerdsaver-ai/pi-coding-agent/tools/todo";
import type { NativeScrollbackLiveRegion } from "@pk-nerdsaver-ai/pi-tui";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

function renderTodos(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.todoContainer.render(120).join("\n"));
}

describe("InteractiveMode todo auto-clear", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-clear-");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	async function createMode(todoClearDelay: number): Promise<void> {
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "tasks.todoClearDelay": todoClearDelay },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

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
			settings: Settings.isolated({ "tasks.todoClearDelay": todoClearDelay }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	}

	it("clears closed todos from the panel instantly without mutating session history", async () => {
		await createMode(0);
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

	it("leaves closed todos visible when auto-clear is disabled", async () => {
		await createMode(-1);

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }]);

		expect(renderTodos(mode)).toContain("done task");
	});

	it("clears closed todos after the configured delay", async () => {
		await createMode(1);
		vi.useFakeTimers();

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }]);
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(999);
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(1);
		expect(renderTodos(mode)).not.toContain("done task");
	});
});

describe("InteractiveMode todo HUD anchor", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
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

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
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
		// Root header carries overall stage progression (on stage 1 of 2).
		const root = lines.find(line => line.includes("Todos"));
		expect(root).toContain("1/2");
		// Active stage: highlighted header with its own task progress, expanded as a
		// connector tree; the completed task slid out of the open-task window.
		expect(lines.some(line => line.includes("I. Foundation") && line.includes("1/3"))).toBe(true);
		const secondLine = lines.find(line => line.includes("second task"));
		expect(secondLine).toContain(theme.tree.branch);
		expect(secondLine).toContain(theme.checkbox.unchecked);
		expect(lines.some(line => line.includes("third task"))).toBe(true);
		expect(lines.some(line => line.includes("first task"))).toBe(false);
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

	it("omits the stage count and roman numeral for a single-phase list", () => {
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
		// One stage → no redundant "1/1" stage count on the root.
		const root = lines.find(line => line.includes("Todos"));
		expect(root).not.toContain("/");
		// The stage keeps its task progress; no roman numeral for a lone stage.
		expect(lines.some(line => line.includes("Tasks") && line.includes("0/2"))).toBe(true);
		expect(lines.some(line => line.includes("I. Tasks"))).toBe(false);
		expect(lines.some(line => line.includes("alpha"))).toBe(true);
	});

	it("caps the visible stage list and leaves the hidden ones to the header count", () => {
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
		// Active stage + four following stages render; the rest are dropped.
		expect(lines.some(line => line.includes("II. Two"))).toBe(true);
		expect(lines.some(line => line.includes("V. Five"))).toBe(true);
		expect(lines.some(line => line.includes("Six"))).toBe(false);
		// No overflow row — the header's "1/7" implies the hidden stages.
		expect(lines.some(line => line.includes("more"))).toBe(false);
		const root = lines.find(line => line.includes("Todos"));
		expect(root).toContain("1/7");
	});

	it("anchors the todo HUD as a native-scrollback live region while populated", () => {
		// The loader sits below this HUD, so the HUD must report its own seam or
		// its rows commit to scrollback as stale duplicates on short terminals.
		const seam = () =>
			(mode.todoContainer as Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
		expect(seam()).toBeUndefined();
		mode.setTodos([{ name: "Tasks", tasks: [{ content: "alpha", status: "pending" }] }]);
		expect(seam()).toBe(0);
		mode.setTodos([]);
		expect(seam()).toBeUndefined();
	});
});
