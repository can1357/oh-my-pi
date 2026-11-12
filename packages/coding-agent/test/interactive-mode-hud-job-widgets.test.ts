import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TspPropNode } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { JobWidgetEntry, JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if ("k" in child) out.push(...nodes(child));
	return out;
}

function prop(node: NativeNode | TspPropNode | NativeChild | undefined, name: string): unknown {
	return node && "p" in node && node.p ? Reflect.get(node.p, name) : undefined;
}

const decode: JobWidgetView = {
	title: "loadtest · decode",
	headline: { text: "186 tok/s", label: "decode", trend: { text: "▲ 15%", tone: "success" } },
	blocks: [
		{
			kind: "spark",
			label: "tok/s",
			values: Array.from({ length: 24 }, (_, i) => 150 + i),
			min: 0,
			max: 220,
			marks: [{ value: 200, label: "target 200 tok/s" }],
			last: "186 tok/s",
		},
		{ kind: "stat", items: [{ label: "p99", text: "212 ms" }] },
	],
	state: "live",
	updatedAt: 2_000,
};
const evalRun: JobWidgetView = {
	title: "eval · per model",
	blocks: [{ kind: "meter", label: "trials", value: 7 / 9, text: "7/9 trials" }],
	state: "live",
	updatedAt: 1_000,
};

describe("InteractiveMode HUD pills", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-hud-job-widgets-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	const jobsSegment = (): NativeNode | undefined =>
		nodes(mode.describeHudPills()).find(node => node.key === "jobs" && prop(node, "role") === "omp.hud.seg");

	it("shows the freshest headline and a mini spark, lists every widget in the title and stacks them in a hover card", () => {
		let entries: JobWidgetEntry[] = [
			{ id: "bg_1", type: "bash", view: evalRun },
			{ id: "bg_2", type: "bash", view: decode },
		];
		spyOn(mode.statusLine, "runningBackgroundJobCount").mockReturnValue(2);
		spyOn(session, "getRunningJobWidgets").mockImplementation(() => entries);

		const segment = jobsSegment()!;
		const glance = nodes(segment).find(node => prop(node, "role") === "omp.hud.glance");
		expect(prop(glance, "spans")).toEqual([
			{ t: "186 tok/s", s: "num strong" },
			{ t: " ▲ 15%", s: "success" },
		]);
		const spark = nodes(segment).find(node => node.k === "chart");
		expect(spark?.p).toMatchObject({ kind: "spark", min: 0, max: 220 });
		expect(prop(spark, "series")).toHaveLength(16);
		expect(prop(segment, "title")).toBe(
			"2 jobs running  /jobs\nbg_1  eval · per model — trials 7/9 trials\nbg_2  loadtest · decode — decode 186 tok/s ▲ 15%",
		);
		const card = prop(segment, "hovercard") as TspPropNode;
		expect(card).toMatchObject({ k: "col", p: { role: "omp.jobs.hovercard" } });
		expect(card.c?.map(child => prop(child, "role"))).toEqual(["omp.job.tiles"]);
		expect(card.c?.[0]?.c?.map(child => prop(child, "role"))).toEqual(["omp.job.tile", "omp.job.tile"]);

		// Unchanged widget data keeps the described node; moved data re-describes it.
		expect(jobsSegment()).toBe(segment);
		entries = [
			entries[0]!,
			{ id: "bg_2", type: "bash", view: { ...decode, updatedAt: 3_000, headline: { text: "191 tok/s" } } },
		];
		const next = jobsSegment()!;
		expect(next).not.toBe(segment);
		expect(JSON.stringify(next)).toContain("191 tok/s");
	});

	// A refresh recomputes the view from the wall clock (rate decay) even when no data moved:
	// updatedAt and state stand still while the view object is swapped for a fresh one.
	it("re-describes the segment when a refresh swaps the view object without moving updatedAt or state", () => {
		let entries: JobWidgetEntry[] = [{ id: "bg_1", type: "bash", view: decode }];
		spyOn(mode.statusLine, "runningBackgroundJobCount").mockReturnValue(1);
		spyOn(session, "getRunningJobWidgets").mockImplementation(() => entries);

		const segment = jobsSegment()!;
		expect(prop(segment, "title")).toContain("bg_1  loadtest · decode — decode 186 tok/s ▲ 15%");

		entries = [{ id: "bg_1", type: "bash", view: { ...decode, headline: { text: "171 tok/s" } } }];

		const next = jobsSegment()!;
		expect(next).not.toBe(segment);
		const glance = nodes(next).find(node => prop(node, "role") === "omp.hud.glance");
		expect(prop(glance, "spans")).toEqual([{ t: "171 tok/s", s: "num strong" }]);
		expect(prop(next, "title")).toBe("1 job running  /jobs\nbg_1  loadtest · decode — 171 tok/s");
	});

	it("keeps the bare count segment while no running job draws a widget", () => {
		spyOn(mode.statusLine, "runningBackgroundJobCount").mockReturnValue(1);
		spyOn(session, "getRunningJobWidgets").mockReturnValue([]);
		const segment = jobsSegment()!;
		expect(prop(segment, "hovercard")).toBeUndefined();
		expect(prop(segment, "title")).toBe("1 job running  /jobs");
	});

	it("keeps a clickable idle agents segment after the last subagent finishes, and drops it once none remain", () => {
		const registry = AgentRegistry.global();
		const id = "hud-finished-sub";
		const agentsSegment = (): NativeNode | undefined => {
			mode.syncRunningSubagentBadge({ requestRender: false });
			return nodes(mode.describeHudPills()).find(
				node => node.key === "agents" && prop(node, "role") === "omp.hud.seg",
			);
		};
		try {
			registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
			expect(prop(agentsSegment(), "title")).toStartWith("1 agent running");

			registry.setStatus(id, "idle");
			const idle = agentsSegment();
			expect(prop(idle, "actions")).toEqual({ click: "agents.open" });
			expect(prop(idle, "title")).toStartWith("No agents running · 1 in this session");

			registry.unregister(id);
			expect(agentsSegment()).toBeUndefined();
		} finally {
			registry.unregister(id);
		}
	});
});

/** An open plan whose two tasks both fuzzy-match a subagent described as `Review auth`. */
const REVIEW_PLAN: TodoPhase[] = [
	{
		name: "Review",
		tasks: [
			{ content: "Review auth", status: "in_progress" },
			{ content: "Review auth deployment", status: "pending" },
		],
	},
];

describe("InteractiveMode todo HUD subagent indication", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	const cx: DescribeContext = {
		cols: 120,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => true,
	};

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-hud-todo-observer-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
		// Unrelated to the todo HUD; keep the branch watcher from leaking an fs.watch into sibling files.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		// Own the observer UI coalesce timer so each lifecycle event gets its own flush.
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/** Task statuses in the native todo HUD checklist, in plan order. */
	const hudStatuses = (): string[] | undefined => {
		for (const child of mode.describeStatusHud([], cx).c ?? []) {
			if ("k" in child && child.k === "checklist") {
				return child.p?.phases.flatMap(phase => phase.items.map(item => item.status));
			}
		}
		return undefined;
	};

	const todoEditIds = (): string[] =>
		session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE)
			.map(entry => entry.id);

	const emitLifecycle = (id: string, description: string, status: SubagentLifecyclePayload["status"]): void => {
		const payload: SubagentLifecyclePayload = {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description,
			status,
			detached: true,
		};
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		vi.advanceTimersByTime(100);
	};

	it("lights up similar open todos while a matching subagent runs and leaves them open when it completes", () => {
		session.commitTodoPhases(REVIEW_PLAN);
		mode.setTodos(session.getTodoPhases());
		const planEdits = todoEditIds();
		expect(hudStatuses()).toEqual(["active", "pending"]);

		emitLifecycle("AuthReviewer", "Review auth", "started");
		expect(hudStatuses()).toEqual(["active", "active"]);

		emitLifecycle("AuthReviewer", "Review auth", "completed");
		// A finished subagent's label is not a `todo done`: neither task closes, in memory or on resume.
		expect(session.getTodoPhases()).toEqual(REVIEW_PLAN);
		expect(todoEditIds()).toEqual(planEdits);
		expect(getLatestTodoPhasesFromEntries(session.sessionManager.getBranch())).toEqual(REVIEW_PLAN);
		expect(hudStatuses()).toEqual(["active", "pending"]);
	});

	it("completes and persists only the task an explicit /todo done names after a matching subagent finished", async () => {
		session.commitTodoPhases(REVIEW_PLAN);
		mode.setTodos(session.getTodoPhases());
		emitLifecycle("AuthReviewer", "Review auth", "started");
		emitLifecycle("AuthReviewer", "Review auth", "completed");

		await mode.handleTodoCommand("done Review auth");

		const expected: TodoPhase[] = [
			{
				name: "Review",
				tasks: [
					{ content: "Review auth", status: "completed" },
					{ content: "Review auth deployment", status: "in_progress" },
				],
			},
		];
		expect(session.getTodoPhases()).toEqual(expected);
		expect(todoEditIds()).toHaveLength(2);
		expect(getLatestTodoPhasesFromEntries(session.sessionManager.getBranch())).toEqual(expected);
		expect(hudStatuses()).toEqual(["done", "active"]);
	});

	it("does not complete a todo added after a subagent with the same description already finished", () => {
		emitLifecycle("AuthReviewer", "Review auth", "started");
		emitLifecycle("AuthReviewer", "Review auth", "completed");
		const plan: TodoPhase[] = [{ name: "Review", tasks: [{ content: "Review auth", status: "in_progress" }] }];
		session.commitTodoPhases(plan);
		mode.setTodos(session.getTodoPhases());
		const planEdits = todoEditIds();

		// A later, unrelated subagent lifecycle change must not replay the stale completion onto the new plan.
		emitLifecycle("Linter", "Lint the workspace", "started");

		expect(session.getTodoPhases()).toEqual(plan);
		expect(todoEditIds()).toEqual(planEdits);
		expect(hudStatuses()).toEqual(["active"]);
	});
});
