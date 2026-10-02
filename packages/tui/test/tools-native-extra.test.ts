import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { TspAgentProps, TspChecklistProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { AgentProgress, TaskToolDetails } from "../src/tools/task";
import { taskToolRenderer } from "../src/tools/task";
import type { TodoToolDetails } from "../src/tools/todo";
import { todoToolRenderer } from "../src/tools/todo";
import type { CoordinationDetails } from "../src/tools/wait";
import { waitToolRenderer } from "../src/tools/wait";

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if ("k" in child) {
			out.push(child, ...nodes(child.c));
		}
	}
	return out;
}

const opts = { expanded: false, isPartial: false };

describe("native todo", () => {
	it("renders one checklist with mapped statuses, plain phase titles and folded completed phases", () => {
		const details: TodoToolDetails = {
			storage: "memory",
			phases: [
				{ name: "Setup", tasks: [{ content: "init", status: "completed" }] },
				{
					name: "Build",
					tasks: [
						{ content: "write parser", status: "completed" },
						{ content: "lex", status: "in_progress" },
						{ content: "old idea", status: "abandoned" },
						{ content: "deploy", status: "blocked", blocker: "no creds" },
						{ content: "ship it", status: "pending" },
					],
				},
			],
		};
		const view = todoToolRenderer.describeResult({ content: [], details }, opts);
		expect(view?.tool).toMatchObject({ title: "Todo", target: "3/6", targetKind: "text" });
		expect(view?.body).toHaveLength(1);
		const checklist = view?.body?.[0] as NativeNode;
		expect(checklist.k).toBe("checklist");
		const p = checklist.p as TspChecklistProps;
		expect(p.mode).toBe("full");
		expect(p.phases.map(phase => [phase.title, phase.collapsed])).toEqual([
			["Setup", true],
			["Build", false],
		]);
		expect(p.phases[1]!.items.map(item => [item.text, item.status, item.note])).toEqual([
			["write parser", "done", undefined],
			["lex", "active", undefined],
			["old idea", "dropped", undefined],
			["deploy", "blocked", "no creds"],
			["ship it", "pending", undefined],
		]);
	});
});

function progress(id: string, extra: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "do things",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 1000,
		...extra,
	};
}

describe("native task", () => {
	it("renders one agent node per subagent, no cards, with the assignment prefix stripped", () => {
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				progress("Alpha", {
					task: "Complete assignment thoroughly:\n\n# Target\nFix the lexer",
					currentTool: "read",
					// `lastIntent` is an earlier call's; the running call carries its own.
					lastIntent: "Searching the lexer",
					currentToolIntent: "Reading lexer",
					currentToolStartMs: 1000,
					contextTokens: 19_000,
					contextWindow: 200_000,
				}),
				progress("Beta", { index: 1, status: "pending" }),
			],
		};
		const view = taskToolRenderer.describeResult(
			{ content: [], details },
			{ ...opts, isPartial: true, renderContext: { nowMs: 4000 } },
			{ context: "Shared\ngoal", tasks: [] },
		);
		expect(view?.tool).toMatchObject({ title: "Task", target: "2 agents" });
		const all = nodes(view?.body);
		expect(all.some(n => n.k === "card")).toBe(false);
		expect(view?.body?.[0]).toMatchObject({ k: "text", p: { role: "omp.tool.context" } });
		const agents = all.filter(n => n.k === "agent");
		expect(agents.map(n => n.key)).toEqual(["Alpha", "Beta"]);
		const alpha = agents[0]!.p as TspAgentProps;
		expect(alpha.task).toBe("# Target Fix the lexer");
		expect(alpha.status).toBe("running");
		expect(alpha.tool).toEqual({ name: "read", intent: "Reading lexer", age: 3000 });
		expect(alpha.stats).toMatchObject({ context: 0.095, contextLabel: "19K / 200K" });
		expect((agents[1]!.p as TspAgentProps).status).toBe("pending");
	});

	it("nests a subagent's in-flight children as agent nodes inside its node", () => {
		const child: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress("Child")],
		};
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progress("Parent", { inflightTaskDetails: child })],
		};
		const view = taskToolRenderer.describeResult({ content: [], details }, { ...opts, isPartial: true });
		const parent = view?.body?.find(n => "k" in n && n.k === "agent" && n.key === "Parent") as NativeNode;
		expect(parent).toBeDefined();
		const nested = nodes(parent.c).find(n => n.k === "agent" && n.key === "Child");
		expect(nested?.p).toMatchObject({ status: "running", depth: 1 });
	});
});

describe("native wait", () => {
	afterEach(() => setNativeRendering(false));

	it("describes running jobs with a terminal-clocked elapsed and schedules no timer", () => {
		setNativeRendering(true);
		const interval = spyOn(globalThis, "setInterval");
		const timeout = spyOn(globalThis, "setTimeout");
		try {
			const details: CoordinationDetails = {
				op: "wait",
				jobs: [
					{ id: "job-1", type: "bash", status: "running", label: "sleep", durationMs: 4200 },
					{ id: "job-2", type: "task", status: "completed", label: "x", durationMs: 900 },
				],
			};
			const view = waitToolRenderer.describeResult({ content: [], details }, { ...opts, isPartial: true });
			const clocks = nodes(view?.body)
				.filter(n => n.k === "elapsed")
				.map(n => n.p);
			expect(clocks).toEqual([
				{ age: 4200, format: "short" },
				{ age: 900, stopped: 900, format: "short" },
			]);
			expect(interval).not.toHaveBeenCalled();
			expect(timeout).not.toHaveBeenCalled();
		} finally {
			interval.mockRestore();
			timeout.mockRestore();
		}
	});
});
