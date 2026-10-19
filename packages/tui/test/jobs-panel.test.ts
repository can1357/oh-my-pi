import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import {
	type JobsPanelDetail,
	type JobsPanelJob,
	type JobsPanelSnapshot,
	JobsSheet,
	type JobsSheetSource,
} from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { modelEval } from "./fixtures/job-widget-views";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const CX: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

/** Every described node under `root`, depth first. */
function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if ("k" in child && typeof child.k === "string") out.push(...nodes(child));
	return out;
}

function prop(node: NativeNode | undefined, name: string): unknown {
	return node?.p ? Reflect.get(node.p, name) : undefined;
}

const byRole = (root: NativeNode, role: string) => nodes(root).filter(node => prop(node, "role") === role);
const list = (root: NativeNode) => nodes(root).find(node => node.k === "list");

/** The plain text a subtree shows: `text` props, span runs and item labels. */
function texts(root: NativeNode): string {
	const runs = (value: unknown) =>
		Array.isArray(value) ? value.map(span => (typeof span?.t === "string" ? span.t : "")).join("") : "";
	return nodes(root)
		.map(node => {
			const text = prop(node, "text");
			return typeof text === "string" ? text : runs(prop(node, "spans")) || runs(prop(node, "label"));
		})
		.join("\n");
}

const NOW = Date.now();
const JOBS = {
	running: [
		{
			id: "task-1",
			type: "task",
			status: "running",
			label: "Audit credits",
			agentId: "CreditAudit",
			startTime: NOW - 5_000,
		},
		{ id: "bash-1", type: "bash", status: "running", label: "cargo test --workspace", startTime: NOW - 2_000 },
	],
	recent: [
		{ id: "bash-2", type: "bash", status: "failed", label: "bun lint", startTime: NOW - 9_000, endTime: NOW - 8_000 },
	],
} satisfies { running: JobsPanelJob[]; recent: JobsPanelJob[] };
const DETAILS: Record<string, JobsPanelDetail> = {
	"task-1": { cwd: "/work", pids: [] },
	"bash-1": { command: "cargo test --workspace", cwd: "/work", pids: [41], output: "running 12 tests\n" },
	"bash-2": { command: "bun lint", cwd: "/work", pids: [], exitCode: 1, output: "1 error\n" },
};

function setup(jobs: { running: JobsPanelJob[]; recent: JobsPanelJob[] } = JOBS) {
	const source = { load: () => jobs, inspect: (id: string) => DETAILS[id], cancel: vi.fn(), close: vi.fn() };
	const sheet = new JobsSheet(source satisfies JobsSheetSource);
	return { sheet, source };
}

describe("JobsSheet", () => {
	it("lists running then settled jobs, oldest first, beside the first job's detail", () => {
		const { sheet } = setup();
		const root = sheet.describe(CX);
		expect(list(root)?.c?.map(row => ("key" in row ? row.key : undefined))).toEqual(["task-1", "bash-1", "bash-2"]);
		expect(prop(list(root), "selected")).toBe("task-1");
		const detail = byRole(root, "omp.jobs.detail")[0]!;
		expect(texts(detail)).toContain("Audit credits");
		expect(prop(byRole(root, "omp.jobs.facts")[0], "items")).toContainEqual({
			k: "Agent",
			v: [{ t: "CreditAudit", s: "mono" }],
		});
		expect(texts(detail)).toContain("No output yet");
		expect(prop(byRole(root, "omp.jobs.summary")[0], "text")).toBe("2 running · 1 recent");
	});

	it("moves the selection with ↑/↓ and shows the selected job's command and output", () => {
		const { sheet } = setup();
		sheet.handleInput(DOWN);
		const root = sheet.describe(CX);
		expect(prop(list(root), "selected")).toBe("bash-1");
		expect(prop(byRole(root, "omp.jobs.command")[0], "text")).toBe("cargo test --workspace");
		const output = byRole(root, "omp.jobs.output")[0];
		expect(prop(output, "text")).toBe("running 12 tests\n");
		expect(prop(output, "follow")).toBe(true);
		sheet.handleInput(UP);
		sheet.handleInput(UP);
		expect(prop(list(sheet.describe(CX)), "selected")).toBe("task-1");
	});

	it("offers Cancel job and X only for a running job", () => {
		const { sheet, source } = setup();
		sheet.handleInput(DOWN);
		expect(byRole(sheet.describe(CX), "omp.btn").map(btn => btn.key)).toEqual(["cancel", "close"]);
		sheet.handleInput("x");
		expect(source.cancel).toHaveBeenCalledWith("bash-1");

		sheet.handleInput(DOWN);
		const root = sheet.describe(CX);
		expect(byRole(root, "omp.btn").map(btn => btn.key)).toEqual(["close"]);
		expect(prop(byRole(root, "omp.jobs.facts")[0], "items")).toContainEqual({
			k: "Exit code",
			v: [{ t: "1", s: "error" }],
		});
		sheet.handleInput("x");
		expect(source.cancel).toHaveBeenCalledTimes(1);
	});

	it("routes clicks: a row selects, Cancel job cancels, Close and Esc close", () => {
		const { sheet, source } = setup();
		const events: NativeUiEvent[] = [
			{ type: "select", key: "jobs", item: "bash-1" },
			{ type: "action", key: "cancel", act: "cancel", mods: [] },
			{ type: "action", key: "close", act: "close", mods: [] },
		];
		sheet.handleNativeEvent(events[0]!);
		expect(prop(list(sheet.describe(CX)), "selected")).toBe("bash-1");
		sheet.handleNativeEvent(events[1]!);
		expect(source.cancel).toHaveBeenCalledWith("bash-1");
		sheet.handleNativeEvent(events[2]!);
		sheet.handleInput("\x1b");
		expect(source.close).toHaveBeenCalledTimes(2);
	});

	it("shows the empty state with Close alone when there are no jobs", () => {
		const { sheet } = setup({ running: [], recent: [] });
		const root = sheet.describe(CX);
		expect(byRole(root, "omp.jobs.split")).toHaveLength(0);
		expect(texts(byRole(root, "omp.jobs.empty")[0]!)).toContain("No background jobs");
		expect(byRole(root, "omp.btn").map(btn => btn.key)).toEqual(["close"]);
		expect(sheet.render(60).join("\n")).toContain("No background jobs");
	});

	it("keeps the terminal fallback: a row per job, then the selected job's facts and tail", () => {
		const { sheet } = setup();
		sheet.handleInput(DOWN);
		const lines = sheet.render(100).join("\n");
		expect(lines).toContain("Background jobs · 2 running");
		expect(lines).toContain("> running  bash");
		expect(lines).toContain("pid 41");
		expect(lines).toContain("running 12 tests");
	});

	it("renders read-only when the source cannot cancel: the jobs and detail stay, Cancel job is gone", () => {
		// A focused subagent view only watches that agent's jobs (#14814).
		const source: JobsSheetSource = { load: () => JOBS, inspect: (id: string) => DETAILS[id], close: vi.fn() };
		const sheet = new JobsSheet(source);
		expect(byRole(sheet.describe(CX), "omp.btn").map(btn => btn.key)).toEqual(["close"]);

		sheet.handleInput(DOWN);
		const lines = sheet.render(100).join("\n");
		expect(lines).toContain("cargo test --workspace");
		expect(lines).toContain("pid 41");
	});

	it("shows the selected job's widget above its output, natively and in the terminal fallback", async () => {
		await initTheme();
		const detail: JobsPanelDetail = { ...DETAILS["bash-1"]!, widget: modelEval };
		const source: JobsSheetSource = {
			load: () => JOBS,
			inspect: id => (id === "bash-1" ? detail : DETAILS[id]),
			close: vi.fn(),
		};
		const sheet = new JobsSheet(source);
		sheet.handleInput(DOWN);
		const root = sheet.describe(CX);
		const detailNode = byRole(root, "omp.jobs.detail")[0]!;
		const roles = (detailNode.c ?? []).map(child => ("k" in child ? prop(child, "role") : undefined));
		expect(roles.indexOf("omp.jobs.widget")).toBeLessThan(roles.indexOf("omp.jobs.out"));
		expect(byRole(root, "omp.job.widget.bar")).toHaveLength(3);

		const lines = sheet.render(100).map(line => Bun.stripANSI(line));
		const head = lines.findIndex(line => line.includes("eval · tests passed per model"));
		expect(head).toBeGreaterThan(0);
		expect(lines[head + 2]).toMatch(/^ {5}opus-4\.5 +█+░* +26\/30$/);
		expect(lines.findIndex(line => line.includes("running 12 tests"))).toBeGreaterThan(head);
	});

	describe("as a tree of subagents", () => {
		beforeAll(async () => {
			await initTheme();
		});
		const job = (id: string, ownerId: string, extra: Partial<JobsPanelJob> = {}): JobsPanelJob => ({
			id,
			type: "bash",
			status: "running",
			label: id,
			ownerId,
			startTime: NOW - 1_000,
			...extra,
		});
		// Main runs Audit (which runs Sub) and owns two leaf jobs; Lone's task job is gone.
		const TREE = {
			rootId: "Main",
			agents: [
				{ id: "Audit", parentId: "Main" },
				{ id: "Sub", parentId: "Audit" },
				{ id: "Lone", parentId: "Main" },
			],
			running: [
				job("main-bash", "Main", { startTime: NOW - 9_000 }),
				job("task-audit", "Main", { type: "task", agentId: "Audit" }),
				job("audit-bash", "Audit", { startTime: NOW - 8_000 }),
				job("task-sub", "Audit", { type: "task", agentId: "Sub" }),
				job("sub-bash", "Sub"),
				job("lone-bash", "Lone"),
			],
			recent: [job("main-done", "Main", { status: "completed", endTime: NOW })],
		} satisfies JobsPanelSnapshot;
		const treeSheet = () => {
			const source = { load: () => TREE, inspect: () => undefined, cancel: vi.fn(), close: vi.fn() };
			return { sheet: new JobsSheet(source satisfies JobsSheetSource), source };
		};

		it("nests each subagent's jobs under it, branchiest subtrees first and leaf jobs last", () => {
			const { sheet } = treeSheet();
			expect(list(sheet.describe(CX))?.c?.map(row => ("key" in row ? row.key : undefined))).toEqual([
				"task-audit",
				"task-sub",
				"sub-bash",
				"audit-bash",
				expect.stringMatching(/^agent-/),
				"lone-bash",
				"main-bash",
				"main-done",
			]);
			const rows = sheet
				.render(120)
				.slice(1, 9)
				.map(line => line.trimEnd());
			expect(rows).toEqual([
				expect.stringMatching(/^> running {2}task \S+ {2}Audit: task-audit$/),
				expect.stringMatching(/^ {2}├─ running {2}task \S+ {2}Sub: task-sub$/),
				expect.stringMatching(/^ {2}│ {2}└─ running {2}bash \S+ {2}sub-bash$/),
				expect.stringMatching(/^ {2}└─ running {2}bash \S+ {2}audit-bash$/),
				"  Lone",
				expect.stringMatching(/^ {2}└─ running {2}bash \S+ {2}lone-bash$/),
				expect.stringMatching(/^ {2}running {2}bash \S+ {2}main-bash$/),
				expect.stringMatching(/^ {2}completed {2}bash \S+ {2}main-done$/),
			]);
		});

		it("cancels only jobs the root owns", () => {
			const { sheet, source } = treeSheet();
			sheet.handleInput(DOWN); // task-sub, owned by Audit
			expect(byRole(sheet.describe(CX), "omp.btn").map(btn => btn.key)).toEqual(["close"]);
			sheet.handleInput("x");
			sheet.handleNativeEvent({ type: "action", key: "cancel", act: "cancel", mods: [] });
			expect(source.cancel).not.toHaveBeenCalled();

			sheet.handleInput(UP); // task-audit, owned by Main
			sheet.handleInput("x");
			expect(source.cancel).toHaveBeenCalledWith("task-audit");
		});
	});
});
