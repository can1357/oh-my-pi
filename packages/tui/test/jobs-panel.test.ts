import { describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import {
	type JobsPanelDetail,
	type JobsPanelJob,
	JobsSheet,
	type JobsPanelSnapshot,
	type JobsSheetSource,
} from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

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

function setup(
	jobs: JobsPanelSnapshot = JOBS,
	options: {
		details?: Record<string, JobsPanelDetail>;
		inspect?: (id: string) => JobsPanelDetail | undefined;
		rows?: () => number;
	} = {},
) {
	const details = options.details ?? DETAILS;
	const source = {
		load: () => jobs,
		inspect: options.inspect ?? ((id: string) => details[id]),
		cancel: vi.fn(),
		close: vi.fn(),
		rows: options.rows,
	} satisfies JobsSheetSource;
	const sheet = new JobsSheet(source);
	return { sheet, source };
}

describe("JobsSheet", () => {
	it("lists running then recent jobs beside the first job's detail", () => {
		const { sheet } = setup();
		const root = sheet.describe(CX);
		expect(list(root)?.c?.map(row => ("key" in row ? row.key : undefined))).toEqual([
			"group-Running",
			"task-1",
			"bash-1",
			"group-Recent",
			"bash-2",
		]);
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
		const { sheet } = setup({ running: [], recent: [] }, { rows: () => 40 });
		const root = sheet.describe(CX);
		expect(byRole(root, "omp.jobs.split")).toHaveLength(0);
		expect(texts(byRole(root, "omp.jobs.empty")[0]!)).toContain("No background jobs");
		expect(byRole(root, "omp.btn").map(btn => btn.key)).toEqual(["close"]);
		expect(sheet.render(60).join("\n")).toContain("No background jobs");
	});

	it("keeps the terminal fallback: a row per job, then the selected job's facts and tail", () => {
		const { sheet } = setup(JOBS, { rows: () => 40 });
		sheet.handleInput(DOWN);
		const rendered = sheet.render(100);
		const lines = rendered.join("\n");
		expect(lines).toContain("Background jobs");
		expect(lines).toContain("2 running");
		expect(rendered.some(line => line.startsWith(">") && line.includes("cargo test --workspace"))).toBe(true);
		expect(lines).toContain("pid 41");
		expect(lines).toContain("running 12 tests");
	});
});

describe("JobsSheet terminal rows", () => {
	const TALL = 40;
	const SHORT = 10;
	/**
	 * The overlay's centred height budget: the same 90% `maxHeight` the sheet
	 * opens with, floored to at least one row like the compositor's minimum.
	 */
	const budget = (rows: number) => Math.max(1, Math.floor(rows * 0.9));
	const body = (...values: string[]) => `${values.join("\n")}\n`;
	const log = (count: number, prefix: string) =>
		Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1).padStart(2, "0")}`);
	const bash = (id: string, status: JobsPanelJob["status"], label: string, extra: Partial<JobsPanelJob> = {}) =>
		({ id, type: "bash", status, label, startTime: NOW - 4_000, ...extra }) satisfies JobsPanelJob;

	it("shows the selected job's own output and switches it with ↑/↓", () => {
		const jobs: JobsPanelSnapshot = {
			running: [bash("bash-a", "running", "alpha run"), bash("bash-b", "running", "beta run")],
			recent: [],
		};
		const details: Record<string, JobsPanelDetail> = {
			"bash-a": { command: "alpha run", cwd: "/work", pids: [7], output: body("alpha first", "alpha newest") },
			"bash-b": { command: "beta run", cwd: "/work", pids: [8], output: body("beta newest") },
		};
		const { sheet } = setup(jobs, { details, rows: () => TALL });
		const first = sheet.render(80).join("\n");
		expect(first).toContain("alpha newest");
		expect(first).not.toContain("beta newest");

		sheet.handleInput(DOWN);
		const second = sheet.render(80).join("\n");
		expect(second).toContain("beta newest");
		expect(second).not.toContain("alpha newest");

		sheet.handleInput(UP);
		expect(sheet.render(80).join("\n")).toContain("alpha newest");
		// A later frame keeps the selection rather than snapping back to the first job.
		sheet.handleInput(DOWN);
		expect(sheet.render(80).join("\n")).toContain("beta newest");
		expect(sheet.render(80).join("\n")).not.toContain("alpha newest");
	});

	it("follows captured output as it grows, newest last", () => {
		let output = body(...log(20, "step"));
		const jobs: JobsPanelSnapshot = { running: [bash("bash-log", "running", "tail -f build.log")], recent: [] };
		const { sheet } = setup(jobs, {
			inspect: () => ({ command: "tail -f build.log", cwd: "/work", pids: [9], output }),
			rows: () => TALL,
		});
		const before = sheet.render(80);
		expect(before.filter(line => line.includes("step ")).at(-1)).toContain("step 20");

		output += body("step 21");
		const shown = sheet.render(80).filter(line => line.includes("step "));
		expect(shown.join("\n")).toContain("step 20");
		expect(shown.at(-1)).toContain("step 21");
		expect(shown.length).toBeLessThanOrEqual(budget(TALL));
	});

	it("fills a tall terminal past the short tail, keeping the newest log line", () => {
		const jobs: JobsPanelSnapshot = { running: [bash("bash-tall", "running", "bun run build")], recent: [] };
		const output = body(...log(60, "build"));
		const { sheet } = setup(jobs, {
			inspect: () => ({ command: "bun run build", cwd: "/work", pids: [3], output }),
			rows: () => TALL,
		});
		const rendered = sheet.render(80);
		const text = rendered.join("\n");
		expect(rendered.length).toBeLessThanOrEqual(budget(TALL));
		expect(text).toContain("build 60");
		expect(text).not.toContain("build 01");
		const shown = rendered.filter(line => line.includes("build "));
		expect(shown.length).toBeGreaterThan(8);
		expect(shown.at(-1)).toContain("build 60");
	});

	it("bounds a short terminal and degrades without losing the selection or newest output", () => {
		const jobs: JobsPanelSnapshot = {
			running: [bash("bash-short", "running", "bun run build"), bash("bash-other", "running", "bun run watch")],
			recent: [],
		};
		const details: Record<string, JobsPanelDetail> = {
			"bash-short": { command: "bun run build", cwd: "/work", pids: [3], output: body(...log(60, "build")) },
			"bash-other": { command: "bun run watch", cwd: "/work", pids: [4], output: body("watch 01") },
		};
		const { sheet } = setup(jobs, { details, rows: () => SHORT });
		const rendered = sheet.render(80);
		const text = rendered.join("\n");
		expect(rendered.length).toBeLessThanOrEqual(budget(SHORT));
		expect(text).toContain("Background jobs");
		expect(text).toContain("bun run build");
		expect(text).toContain("build 60");
	});

	it("keeps the selected job and its newest output visible among many jobs", () => {
		const running = Array.from({ length: 30 }, (_, index) =>
			bash(`bash-${index + 1}`, "running", `job-${String(index + 1).padStart(2, "0")} cmd`),
		);
		const jobs: JobsPanelSnapshot = { running, recent: [] };
		const details: Record<string, JobsPanelDetail> = {};
		for (const job of running) {
			details[job.id] = { command: job.label, cwd: "/work", pids: [], output: body(...log(5, `out-${job.id}`)) };
		}
		const { sheet } = setup(jobs, { details, rows: () => 20 });
		for (let step = 0; step < 19; step++) sheet.handleInput(DOWN);

		const rendered = sheet.render(60);
		const text = rendered.join("\n");
		expect(rendered.length).toBeLessThanOrEqual(budget(20));
		expect(text).toContain("job-20 cmd");
		expect(text).toContain("out-bash-20 05");
		expect(text).not.toContain("out-bash-21");
		expect(text).not.toContain("out-bash-19");
	});

	it("recomputes the row budget when the terminal resizes", () => {
		const size = { rows: TALL };
		const jobs: JobsPanelSnapshot = { running: [bash("bash-rs", "running", "bun run build")], recent: [] };
		const { sheet } = setup(jobs, {
			inspect: () => ({ command: "bun run build", cwd: "/work", pids: [3], output: body(...log(60, "build")) }),
			rows: () => size.rows,
		});
		const tall = sheet.render(80).length;
		size.rows = 12;
		const short = sheet.render(80).length;
		expect(tall).toBeLessThanOrEqual(budget(TALL));
		expect(short).toBeLessThanOrEqual(budget(12));
		expect(tall).toBeGreaterThan(short);

		size.rows = TALL;
		expect(sheet.render(80).length).toBe(tall);
	});

	it("degrades safely at tiny heights without exceeding the budget", () => {
		const jobs: JobsPanelSnapshot = {
			running: [bash("bash-tiny", "running", "bun run build"), bash("bash-tiny-2", "running", "bun run watch")],
			recent: [],
		};
		const details: Record<string, JobsPanelDetail> = {
			"bash-tiny": { command: "bun run build", cwd: "/work", pids: [3], output: body(...log(60, "build")) },
			"bash-tiny-2": { command: "bun run watch", cwd: "/work", pids: [4], output: body("watch 01") },
		};
		for (const rows of [1, 2, 3, 5, 7]) {
			const { sheet } = setup(jobs, { details, rows: () => rows });
			const rendered = sheet.render(80);
			// The compositor draws at least one row: even a one-row terminal keeps the header.
			expect(rendered.length).toBeGreaterThanOrEqual(1);
			expect(rendered.length).toBeLessThanOrEqual(budget(rows));
			expect(rendered[0]).toContain("Background jobs");
			// Once the budget can hold the output block, the newest line survives the cut.
			if (budget(rows) >= 4) expect(rendered.join("\n")).toContain("build 60");
		}
	});

	it("keeps each row inside a narrow width with tabs and control bytes stripped", () => {
		const jobs: JobsPanelSnapshot = { running: [bash("bash-dirty", "running", "run\tcmd\x1b[0m")], recent: [] };
		const { sheet } = setup(jobs, {
			inspect: () => ({
				command: "run\tcmd\x1b[0m",
				cwd: "/w\tork",
				pids: [12],
				output: body("\x1b[31mred\x1b[0m row\tcol\x07 bell\r carriage", "plain line"),
			}),
			rows: () => TALL,
		});
		const rendered = sheet.render(16);
		for (const line of rendered) {
			expect(line).not.toContain("\n");
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\r");
			expect(line).not.toContain("\x1b");
			expect(line).not.toContain("\x07");
			expect(visibleWidth(line)).toBeLessThanOrEqual(16);
		}
		const text = rendered.join("\n");
		expect(text).toContain("red row");
		expect(text).toContain("plain line");
	});

	it("re-renders when the selected job settles, showing final output and exit code", () => {
		const running = bash("bash-s", "running", "bun build");
		const snapshot: { running: JobsPanelJob[]; recent: JobsPanelJob[] } = { running: [running], recent: [] };
		let detail: JobsPanelDetail = {
			command: "bun build",
			cwd: "/work",
			pids: [5],
			output: body("compiling", "step 2"),
		};
		const { sheet } = setup(snapshot, { inspect: () => detail, rows: () => TALL });
		const live = sheet.render(80).join("\n");
		expect(live).toContain("pid 5");
		expect(live).toContain("step 2");
		expect(live).not.toContain("exit 0");

		snapshot.running.pop();
		snapshot.recent.push({ ...running, status: "completed", endTime: NOW - 100 });
		detail = {
			command: "bun build",
			cwd: "/work",
			pids: [],
			exitCode: 0,
			output: body("compiling", "step 2", "done ok"),
		};
		const settled = sheet.render(80).join("\n");
		expect(settled).toContain("done ok");
		expect(settled).toContain("exit 0");
		expect(settled).not.toContain("pid 5");
	});

	it("keeps showing the final captured output of failed and cancelled jobs", () => {
		const jobs: JobsPanelSnapshot = {
			running: [],
			recent: [
				bash("bash-f", "failed", "bun test", { endTime: NOW - 100 }),
				bash("bash-c", "cancelled", "cargo watch", { endTime: NOW - 200 }),
			],
		};
		const details: Record<string, JobsPanelDetail> = {
			"bash-f": { command: "bun test", cwd: "/work", pids: [], exitCode: 1, output: body("1 fail") },
			"bash-c": { command: "cargo watch", cwd: "/work", pids: [], output: body("stopped") },
		};
		const { sheet } = setup(jobs, { details, rows: () => TALL });
		expect(sheet.render(80).join("\n")).toContain("1 fail");

		sheet.handleInput(DOWN);
		const cancelled = sheet.render(80).join("\n");
		expect(cancelled).toContain("stopped");
		expect(cancelled).not.toContain("1 fail");
	});

	it("shortens a home-directory cwd in the facts line", () => {
		const home = os.homedir();
		const cwd = path.join(home, "proj");
		const jobs: JobsPanelSnapshot = { running: [bash("bash-home", "running", "bun run build")], recent: [] };
		const { sheet } = setup(jobs, {
			inspect: () => ({ command: "bun run build", cwd, pids: [3], output: body("ok") }),
			rows: () => TALL,
		});
		const text = sheet.render(80).join("\n");
		const short = shortenPath(cwd);
		expect(text).toContain(short);
		if (short !== cwd) expect(text).not.toContain(cwd);
	});
});
