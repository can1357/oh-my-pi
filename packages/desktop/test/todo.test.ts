import { describe, expect, test } from "bun:test";
import type { TodoPhase } from "../src/rpc/protocol";
import {
	activePhaseIndex,
	parsePhases,
	phaseLabel,
	phaseProgress,
	phasesFromToolResult,
	planSummary,
} from "../src/rpc/todo";

const plan: TodoPhase[] = [
	{
		name: "Research",
		tasks: [
			{ content: "Read the source", status: "completed" },
			{ content: "Check versions", status: "abandoned" },
		],
	},
	{
		name: "Phase1-Kenalink",
		tasks: [
			{ content: "Add rmcp", status: "in_progress" },
			{ content: "Verify it builds", status: "pending" },
		],
	},
	{
		name: "Phase9-AiPluginCutover",
		tasks: [{ content: "Delete stdio dirs", status: "blocked", blocker: "Waiting on the Phase 7 hostnames" }],
	},
];

describe("reading the plan", () => {
	/*
	 * The bug this whole module exists to close: the panel read `phase.items`,
	 * which is the shape of the todo tool's *input*, not of its state. Anything
	 * that is not `tasks` must produce a phase with no tasks — loudly empty,
	 * rather than quietly guessed at.
	 */
	test("a phase carrying `items` has no tasks", () => {
		const parsed = parsePhases([{ name: "Research", items: ["Read the source", "Check versions"] }]);
		expect(parsed).toEqual([{ name: "Research", tasks: [] }]);
	});

	test("reads the real shape, blocker included", () => {
		const parsed = parsePhases([
			{ name: "P", tasks: [{ content: "x", status: "blocked", blocker: "waiting on DNS" }] },
		]);
		expect(parsed[0].tasks[0]).toEqual({ content: "x", status: "blocked", blocker: "waiting on DNS" });
	});

	test("an unknown status is treated as pending, not dropped", () => {
		const parsed = parsePhases([{ name: "P", tasks: [{ content: "x", status: "wat" }] }]);
		expect(parsed[0].tasks[0].status).toBe("pending");
	});

	test("junk in the array does not take the plan with it", () => {
		expect(parsePhases([null, 7, { tasks: [] }, { name: "P", tasks: [{ status: "pending" }] }])).toEqual([
			{ name: "P", tasks: [] },
		]);
	});
});

describe("progress", () => {
	/*
	 * Abandoned counts as closed. Counting only completions leaves a phase that
	 * deliberately dropped a task reading as permanently stuck — which is why
	 * omp shares one predicate across its own counters.
	 */
	test("a dropped task is closed, not open", () => {
		expect(phaseProgress(plan[0])).toEqual({ done: 2, total: 2 });
	});

	test("blocked is still open — it is waiting, not finished", () => {
		expect(phaseProgress(plan[2])).toEqual({ done: 0, total: 1 });
	});
});

describe("which phase is active", () => {
	test("the one holding the running task", () => {
		expect(activePhaseIndex(plan)).toBe(1);
	});

	test("with nothing running, the first with open work", () => {
		const idle = plan.map(phase => ({
			...phase,
			tasks: phase.tasks.map(task =>
				task.status === "in_progress" ? { ...task, status: "pending" as const } : task,
			),
		}));
		expect(activePhaseIndex(idle)).toBe(1);
	});

	test("a finished plan focuses its end, not its beginning", () => {
		const done = plan.map(phase => ({
			...phase,
			tasks: phase.tasks.map(task => ({ ...task, status: "completed" as const })),
		}));
		expect(activePhaseIndex(done)).toBe(2);
	});

	test("no plan, no phase", () => {
		expect(activePhaseIndex([])).toBe(-1);
	});
});

describe("the one-line summary", () => {
	test("counts across every phase and names what is running", () => {
		const summary = planSummary(plan);
		expect(summary).toMatchObject({ done: 2, total: 5, open: 3, blocked: 1, activeIndex: 1 });
		expect(summary.activeTask?.content).toBe("Add rmcp");
	});

	test("an empty plan summarises to nothing rather than throwing", () => {
		expect(planSummary([])).toMatchObject({ done: 0, total: 0, activeIndex: -1 });
	});
});

describe("phase labels", () => {
	test("roman numerals, as the terminal names them", () => {
		expect(phaseLabel("Research", 1, true)).toBe("I. Research");
		expect(phaseLabel("Synthesis", 4, true)).toBe("IV. Synthesis");
		expect(phaseLabel("Cutover", 9, true)).toBe("IX. Cutover");
	});

	test("a single-phase plan does not get numbered", () => {
		expect(phaseLabel("Tasks", 1, false)).toBe("Tasks");
	});
});

describe("the live source", () => {
	/*
	 * This is what makes the panel update mid-turn: the tool's own result
	 * carries the whole new plan, so a phase closing halfway through a long run
	 * shows immediately instead of at the next turn boundary.
	 */
	test("a todo result carries the whole new plan", () => {
		const phases = phasesFromToolResult({
			type: "tool_execution_end",
			toolName: "todo",
			isError: false,
			result: {
				content: [],
				details: { op: "done", phases: [{ name: "P", tasks: [{ content: "x", status: "completed" }] }] },
			},
		});
		expect(phases).toEqual([{ name: "P", tasks: [{ content: "x", status: "completed", blocker: undefined }] }]);
	});

	test("another tool's result is not a plan", () => {
		expect(
			phasesFromToolResult({ toolName: "bash", isError: false, result: { details: { phases: [] } } }),
		).toBeNull();
	});

	test("a failed todo call does not rewrite the plan", () => {
		expect(
			phasesFromToolResult({
				toolName: "todo",
				isError: true,
				result: { details: { phases: [{ name: "P", tasks: [] }] } },
			}),
		).toBeNull();
	});
});
