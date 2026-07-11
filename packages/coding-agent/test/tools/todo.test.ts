import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import {
	resolveTodoMarkdownPath,
	TODO_STRIKE_HOLD_FRAMES,
	type TodoPhase,
	TodoTool,
	todoMatchesAnyDescription,
	todoToolRenderer,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import type { Component } from "@pk-nerdsaver-ai/pi-tui";
import { type } from "arktype";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("resolveTodoMarkdownPath", () => {
	it("defaults to TODO.md under cwd", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath("", cwd)).toBe(path.join(cwd, "TODO.md"));
	});

	it("strips surrounding double quotes before resolving", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath('"my todos.md"', cwd)).toBe(path.join(cwd, "my todos.md"));
	});

	it("rejects internal URL schemes", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(() => resolveTodoMarkdownPath("artifact://todo", cwd)).toThrow("internal scheme");
	});
});

describe("TodoTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("status [in_progress] (Execution)");
		expect(summary.text).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const result = await tool.execute("call-2", { op: "done", task: "status" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Execution", content: "status" }]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("diagnostics [in_progress] (Execution)");
		const completedResult = await tool.execute("call-3", { op: "done", task: "diagnostics" });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (completedSummary?.type !== "text") {
			throw new Error("Expected text summary from todo");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});
});

it("renders completed tasks as checked before revealing strikethrough", async () => {
	const tool = new TodoTool(createSession());
	await tool.execute("call-1", { op: "init", list: [{ phase: "Execution", items: ["finish"] }] });
	const result = await tool.execute("call-2", { op: "done", task: "finish" });
	const options = { expanded: true, isPartial: false, spinnerFrame: 0 };
	const component = todoToolRenderer.renderResult(result, options, theme);

	const firstFrame = component.render(120).join("\n");
	expect(Bun.stripANSI(firstFrame)).toContain("finish");
	expect(firstFrame).not.toContain("\x1b[9m");

	options.spinnerFrame = TODO_STRIKE_HOLD_FRAMES + 1;
	const revealFrame = component.render(120).join("\n");
	expect(Bun.stripANSI(revealFrame)).toContain("finish");
	expect(revealFrame).toContain("\x1b[9m");
});

describe("TodoTool operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
		});

		const result = await tool.execute("call-2", { op: "start", task: "third" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "A", items: ["a1", "a2"] },
				{ phase: "B", items: ["b1"] },
			],
		});

		const result = await tool.execute("call-2", { op: "start", task: "b1" });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Work",
			items: ["Second"],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "Work", items: ["First", "Second"] },
				{ phase: "Later", items: ["Third"] },
			],
		});

		const result = await tool.execute("call-2", { op: "done", phase: "Work" });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "rm" });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "drop", phase: "Work" });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});

	it("view echoes state without mutating it", async () => {
		const session = createSession([
			{
				name: "Work",
				tasks: [
					{ content: "First", status: "pending" },
					{ content: "Second", status: "pending" },
				],
			},
		]);
		const tool = new TodoTool(session);

		const result = await tool.execute("call-1", { op: "view" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		// A read never normalizes or writes session state back.
		expect(session.getTodoPhases?.()?.[0]?.tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("First");
		expect(summary.text).toContain("Second");
	});

	it("view on an empty list reports empty, not cleared", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "view" });
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list is empty.");
		expect(result.isError).toBeUndefined();
	});
});

describe("TodoTool lenient init shapes", () => {
	it("accepts a flattened init with bare items and no phase", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", items: ["First", "Second"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Tasks"]);
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("honors a bare phase on a flattened init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", phase: "Cleanup", items: ["Remove dead code"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Cleanup"]);
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("still errors when init has neither list nor items", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init" });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing list for init operation");
	});
});

describe("TodoTool empty items tolerance", () => {
	// Regression: a stray `items: []` on an op that ignores items (here `view`)
	// must not be a hard schema rejection. The top-level `items` array dropped
	// its `atLeastLength(1)` so callers don't get "items must be tasks to append"
	// for an irrelevant empty array; length is enforced per-op at runtime.
	it("accepts op:view with an empty items array at the schema boundary", () => {
		const schema = new TodoTool(createSession()).parameters;
		expect(schema({ op: "view", items: [] }) instanceof type.errors).toBe(false);
	});

	it("defers empty append items to an op-specific runtime error", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", { op: "append", phase: "Work", items: [] });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing items for append operation");
	});
});

describe("todoMatchesAnyDescription", () => {
	it("matches identical strings", () => {
		expect(todoMatchesAnyDescription("Sonnet #1: AGENTS audit", ["Sonnet #1: AGENTS audit"])).toBe(true);
	});

	it("matches case- and whitespace-insensitively", () => {
		expect(todoMatchesAnyDescription("  Sonnet  #1: AGENTS Audit  ", ["sonnet #1: agents audit"])).toBe(true);
	});

	it("matches when description is a long-enough substring of the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan of diff", ["Sonnet #2"])).toBe(true);
	});

	it("matches when the todo is a long-enough substring of a description", () => {
		expect(todoMatchesAnyDescription("Sonnet #3", ["Sonnet #3: git blame / history check"])).toBe(true);
	});

	it("rejects substring matches below the minimum overlap", () => {
		// "Fix" is 3 chars — too short to qualify on either side.
		expect(todoMatchesAnyDescription("Fix", ["Fix the auth module bug"])).toBe(false);
		expect(todoMatchesAnyDescription("Fix the auth module bug", ["Fix"])).toBe(false);
	});

	it("ignores empty inputs without throwing", () => {
		expect(todoMatchesAnyDescription("", ["Sonnet #1"])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [""])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [])).toBe(false);
	});

	it("returns true on the first match without scanning further descriptions", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["unrelated agent task", "Sonnet #2", "Sonnet #3"]),
		).toBe(true);
	});

	it("returns false when no description overlaps the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["Reviewer1AgentsAdherence", "git blame"])).toBe(
			false,
		);
	});

	it("ignores punctuation differences in identifiers", () => {
		// One side has a method-prefix '#', the other doesn't. Reproduced
		// from a real run where 3 subagents were spawned but only 2 of 3
		// matched todos lit up because the matcher's normalizer collapsed
		// whitespace but left punctuation intact.
		expect(
			todoMatchesAnyDescription("Audit integration site in renderTodoList", [
				"Audit integration site in #renderTodoList",
			]),
		).toBe(true);
		// Dotted abbreviations like AGENTS.md collapse to a space too.
		expect(todoMatchesAnyDescription("Audit AGENTS.md compliance", ["Audit AGENTS md compliance"])).toBe(true);
	});
});
describe("todoToolRenderer.renderResult phase collapsing", () => {
	async function buildThreePhaseAfterDone() {
		const tool = new TodoTool(createSession());
		await tool.execute("init", {
			op: "init",
			list: [
				{ phase: "Alpha", items: ["a1", "a2"] },
				{ phase: "Beta", items: ["b1", "b2"] },
				{ phase: "Gamma", items: ["c1", "c2"] },
			],
		});
		// `done a1` keeps the active task inside Alpha (auto-promotes a2), leaving
		// Beta and Gamma untouched by this update.
		return tool.execute("done", { op: "done", task: "a1" });
	}
	function innerLines(component: Component): string[] {
		const lines = Bun.stripANSI(component.render(100).join("\n")).split("\n");
		return lines.slice(1, -1).map(line => line.replace(/^│/, "").replace(/│\s*$/, "").trim());
	}
	it("collapses untouched phases to a one-line summary while expanding the active phase", async () => {
		const result = await buildThreePhaseAfterDone();
		const component = todoToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme, {
			op: "done",
			task: "a1",
		});
		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		// Active phase renders its full task list.
		expect(rendered).toContain("a1");
		expect(rendered).toContain("a2");
		// Untouched phases collapse: headers + progress counts, no task contents.
		expect(rendered).toContain("II. Beta");
		expect(rendered).toContain("III. Gamma");
		expect(rendered).toContain("0/2");
		expect(rendered).not.toContain("b1");
		expect(rendered).not.toContain("b2");
		expect(rendered).not.toContain("c1");
		expect(rendered).not.toContain("c2");
	});
	it("falls back to in_progress / completed signals when call args are unavailable", async () => {
		const result = await buildThreePhaseAfterDone();
		// Transcript rebuilds may not carry call args; the active (Alpha) phase is
		// still derived from the in_progress task and the completion transition.
		const component = todoToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(rendered).toContain("a2");
		expect(rendered).not.toContain("b1");
		expect(rendered).not.toContain("c1");
	});
	it("shows every phase fully when manually expanded", async () => {
		const result = await buildThreePhaseAfterDone();
		const component = todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme, {
			op: "done",
			task: "a1",
		});
		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(rendered).toContain("b1");
		expect(rendered).toContain("b2");
		expect(rendered).toContain("c1");
		expect(rendered).toContain("c2");
	});
	it("drops blank separator lines between phases", async () => {
		const result = await buildThreePhaseAfterDone();
		const component = todoToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme, {
			op: "done",
			task: "a1",
		});
		// No empty body line survives between phases.
		expect(innerLines(component).every(line => line.length > 0)).toBe(true);
	});
});

describe("todoToolRenderer.renderCall malformed-args regression (#2005)", () => {
	// Reporter saw `TypeError: args?.ops?.map is not a function` against
	// Xiaomi Token Plan's Anthropic protocol because `parseStreamingJson`
	// surfaced `{ ops: "[..." }` shapes mid-stream. The renderer is invoked
	// on every streaming delta, so any non-array `ops` (string, object,
	// number) must NOT crash the TUI render loop and trigger the spam-warn /
	// retry cascade.
	const renderOptions = { expanded: false, isPartial: true } as const;

	it("does not throw when op is a streaming-truncated number", () => {
		// Mid-stream the new flat shape can surface `{ op: 1 }` before the
		// discriminator string lands.
		const args = { op: 1 } as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("does not throw when a flat op's items field is a non-array", () => {
		const args = {
			op: "append",
			phase: "Work",
			items: "Second" as unknown as string[],
		} as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("does not throw on the legacy streaming-truncated `ops` string", () => {
		// Old transcripts/collab-web still carry `{ ops: "[{" }` mid-stream;
		// `normalizeTodoArg` must keep tolerating the legacy batch shape.
		const args = { ops: '[{"op":"init"' } as unknown as Parameters<typeof todoToolRenderer.renderCall>[0];
		expect(() => todoToolRenderer.renderCall(args, renderOptions, theme)).not.toThrow();
	});

	it("renders op summary metadata for a well-formed flat call", () => {
		const args = { op: "init", items: ["a", "b", "c"] };
		const component = todoToolRenderer.renderCall(args, renderOptions, theme);
		// `Text(text, 0, 0)` from `@pk-nerdsaver-ai/pi-tui` exposes the content via .render().
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
	});

	it("still renders legacy multi-op `ops` arrays from old transcripts", () => {
		const args = {
			ops: [
				{ op: "init", items: ["a", "b", "c"] },
				{ op: "done", task: "a" },
				{ op: "append", phase: "Cleanup", items: ["d"] },
			],
		};
		const component = todoToolRenderer.renderCall(args, renderOptions, theme);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("init");
		expect(rendered).toContain("3 items");
		expect(rendered).toContain("done");
		expect(rendered).toContain("append");
		expect(rendered).toContain("Cleanup");
		expect(rendered).toContain("1 item");
	});
});
