import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { RunTrace, Shell } from "@oh-my-pi/pi-natives";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import {
	type JobsPanelDetail,
	type JobsPanelJob,
	type JobsPanelSnapshot,
	JobsSheet,
	type JobsSheetSource,
} from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ShellStream } from "@oh-my-pi/pi-tui/tools/shell-steps";
import { isShellTrace, type ShellTrace, type ShellTraceNode } from "@oh-my-pi/pi-wire";
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

	it("opens on the job asked for when it is listed, else on the first, as when opened any other way", () => {
		const source = { load: () => JOBS, inspect: (id: string) => DETAILS[id], close: vi.fn() };
		const onJob = new JobsSheet(source, { selected: "bash-2" });
		expect(prop(list(onJob.describe(CX)), "selected")).toBe("bash-2");
		expect(onJob.render(100).find(line => line.startsWith(">"))).toContain("bun lint");
		// The keys move from there.
		onJob.handleInput(UP);
		expect(prop(list(onJob.describe(CX)), "selected")).toBe("bash-1");

		const gone = new JobsSheet(source, { selected: "bg_9" });
		expect(prop(list(gone.describe(CX)), "selected")).toBe("task-1");
	});

	it("keeps the selected settled job and its output after the session evicts it, until another is selected", () => {
		let jobs: JobsPanelSnapshot = JOBS;
		const details: Record<string, JobsPanelDetail | undefined> = { ...DETAILS };
		const sheet = new JobsSheet({ load: () => jobs, inspect: id => details[id], close: vi.fn() });
		sheet.handleInput(DOWN);
		sheet.handleInput(DOWN);
		expect(prop(list(sheet.describe(CX)), "selected")).toBe("bash-2");

		jobs = { running: JOBS.running, recent: [] };
		details["bash-2"] = undefined;
		const root = sheet.describe(CX);
		expect(prop(list(root), "selected")).toBe("bash-2");
		expect(prop(byRole(root, "omp.jobs.output")[0], "text")).toBe("1 error\n");
		expect(sheet.render(100).join("\n")).toContain("1 error");

		sheet.handleInput(UP);
		sheet.handleInput(DOWN);
		expect(list(sheet.describe(CX))?.c?.map(row => ("key" in row ? row.key : undefined))).toEqual([
			"task-1",
			"bash-1",
		]);
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

	it("shows the selected job's full command in the terminal fallback, bounded above its facts", () => {
		const long = `export A=1; ${"x".repeat(150)}; cargo test --workspace -- --exact tail_marker`;
		const script = Array.from({ length: 40 }, (_, i) => `echo step ${i}`).join("\n");
		for (const [command, expectTail] of [
			[long, true],
			[script, false],
		] as const) {
			const job: JobsPanelJob = {
				id: "bash-x",
				type: "bash",
				status: "running",
				label: command.slice(0, 40),
				startTime: NOW,
			};
			const detail: JobsPanelDetail = { command, cwd: "/work", pids: [7], output: "out\n" };
			const sheet = new JobsSheet({
				load: () => ({ running: [job], recent: [] }),
				inspect: () => detail,
				close: vi.fn(),
			});
			const lines = sheet.render(60).map(line => Bun.stripANSI(line));
			const text = lines.join("\n");
			// Wrapped, not cut at the row label: the end of a long one-liner is reachable.
			if (expectTail) expect(text).toContain("tail_marker");
			else expect(text).toContain("… 28 more command lines");
			// The facts and output tail still follow the command.
			expect(text).toContain("pid 7");
			expect(text).toContain("out");
		}
	});

	it("strips terminal control sequences and the home directory from the full command", () => {
		const home = os.homedir();
		const command = `cat <<EOF > ${home}/notes.txt\n\x1b]0;pwned\x07\x1b[2Jhello\nEOF`;
		const job: JobsPanelJob = { id: "bash-x", type: "bash", status: "running", label: "cat", startTime: NOW };
		const sheet = new JobsSheet({
			load: () => ({ running: [job], recent: [] }),
			inspect: () => ({ command, pids: [] }),
			close: vi.fn(),
		});
		const text = sheet.render(120).join("\n");
		expect(text).toContain("hello");
		expect(text).toContain("~/notes.txt");
		expect(text).not.toContain(home);
		expect(text).not.toContain("\x1b]0;");
		expect(text).not.toContain("\x1b[2J");
	});

	it("renders a job's intent as one clean row and its caption without the home directory in the terminal fallback", async () => {
		await initTheme();
		const job: JobsPanelJob = {
			id: "bash-i",
			type: "bash",
			status: "running",
			label: "sleep 60",
			intent: `Watch\x1b]0;pwned\x07\tthe\nlog in ${os.homedir()}/logs`,
			caption: `Tails ${os.homedir()}/logs/app.log until cancelled`,
			startTime: NOW,
		};
		const sheet = new JobsSheet({
			load: () => ({ running: [job], recent: [] }),
			inspect: () => ({ pids: [] }),
			close: vi.fn(),
		});
		const lines = sheet.render(160);
		const row = lines.find(line => line.includes("Watch"));
		expect(row).toContain("Watch the log in ~/logs");
		expect(row).not.toContain("\x1b]0;");
		expect(row).not.toContain("\t");
		expect(lines.map(line => Bun.stripANSI(line))).toContain("   Tails ~/logs/app.log until cancelled");
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

	it("leads a job with its intent and caption over the command, and drops a widget with nothing beyond its title", async () => {
		await initTheme();
		const label = "Waiting for stock watch";
		const intent = `${label}: Report when the service stops`;
		const command = "ssh pc-worker 'while systemctl --user is-active -q watch; do sleep 60; done'";
		const caption = "Checks pc-worker every 60s until the watch service stops";
		const job: JobsPanelJob = {
			id: "bg_27",
			type: "bash",
			status: "running",
			label: command,
			intent,
			caption,
			startTime: NOW,
		};
		const detail: JobsPanelDetail = {
			command,
			cwd: "/work",
			pids: [41],
			widget: { title: intent, blocks: [], state: "fallback", updatedAt: NOW },
		};
		const sheet = new JobsSheet({
			load: () => ({ running: [job], recent: [] }),
			inspect: () => detail,
			close: vi.fn(),
		});
		const root = sheet.describe(CX);
		expect(texts(list(root)!)).toContain(label);
		expect(texts(list(root)!)).not.toContain("Report when");
		expect(texts(list(root)!)).not.toContain("systemctl");
		expect(prop(byRole(root, "omp.jobs.title")[0], "text")).toBe(label);
		expect(prop(byRole(root, "omp.jobs.title")[0], "title")).toBe(intent);
		expect(texts(byRole(root, "omp.jobs.caption")[0]!)).toContain(caption);
		expect(prop(byRole(root, "omp.jobs.command")[0], "text")).toBe(command);
		expect(byRole(root, "omp.jobs.widget")).toHaveLength(0);

		const lines = sheet.render(160).map(line => Bun.stripANSI(line));
		expect(lines.find(line => line.includes("bg_27") || line.includes("running  bash"))).toContain(label);
		expect(lines.filter(line => line.includes(label))).toHaveLength(1);
		expect(lines.join("\n")).not.toContain("Report when");
		expect(lines.some(line => line.includes(caption))).toBe(true);
	});

	it("shows a caption that lands after its job settled", async () => {
		await initTheme();
		const settled: JobsPanelJob = {
			id: "bg_28",
			type: "bash",
			status: "completed",
			label: "for i in $(seq 40); do sleep 3; done",
			startTime: NOW,
			endTime: NOW + 120_000,
		};
		let job = settled;
		const sheet = new JobsSheet({
			load: () => ({ running: [], recent: [job] }),
			inspect: () => ({ command: settled.label, pids: [], exitCode: 0, output: "done" }),
			close: vi.fn(),
		});
		expect(byRole(sheet.describe(CX), "omp.jobs.caption")).toHaveLength(0);
		job = { ...settled, caption: "Waits about 2 min, printing nothing" };
		expect(texts(byRole(sheet.describe(CX), "omp.jobs.caption")[0]!)).toContain("Waits about 2 min");
	});

	describe("with a command whose steps write pipes and files", () => {
		const job: JobsPanelJob = {
			id: "bg_13",
			type: "bash",
			status: "running",
			label: "for d in a b; do bench > $d/run.log; done; grep -c round a/run.log | head; echo done",
			startTime: NOW,
		};
		const node = (k: ShellTraceNode["k"], p?: number): ShellTraceNode => ({
			k,
			lo: 0,
			hi: 1,
			state: "running",
			...(p === undefined ? {} : { p }),
		});
		// 0 brace ─ 1 for ─ 2 bench (7 its redirect word) · 3 pipeline ─ 4 grep, 5 head · 6 echo
		const trace: ShellTrace = {
			v: 1,
			seq: 4,
			t_ns: 0,
			script: job.label,
			units: [
				{
					line: 1,
					nodes: [
						node("brace"),
						node("for", 0),
						node("simple", 1),
						node("pipeline", 0),
						node("simple", 3),
						node("simple", 3),
						node("simple", 0),
						node("word", 2),
					],
				},
			],
			history: [
				{ seq: 1, t_ns: 1, kind: "Output", text: "1\n", fd: 1, u: 0, n: 5 },
				{ seq: 2, t_ns: 2, kind: "Output", text: "done\n", fd: 1, u: 0, n: 6 },
				{ seq: 3, t_ns: 3, kind: "Output", text: "unattributed\n", fd: 1 },
			],
		};
		const command = (value: string): NativeUiEvent => ({
			type: "action",
			key: "split/bg_13/command",
			act: "shell-viz",
			value,
			mods: [],
		});
		const action = (act: string): NativeUiEvent => ({
			type: "action",
			key: "split/bg_13/out/source/x",
			act,
			mods: [],
		});

		/** A stream whose write time `modified()` overrides while it returns one, read anew every frame. */
		function stream(base: Omit<ShellStream, "tail">, text: string, modified: () => number | undefined): ShellStream {
			return {
				...base,
				get modified() {
					return modified() ?? base.modified;
				},
				tail: vi.fn(() => text),
			};
		}

		function streams(now: number, modified: { a?: number; b?: number; pipe?: number } = {}) {
			const a = stream(
				{
					id: "file:1",
					kind: "file",
					producer: "bench > $d/run.log",
					consumer: `${os.homedir()}/runs/a/run.log`,
					node: "0:0:2",
					bytes: 10,
					open: true,
					modified: now - 10_000,
				},
				"round a/1\n",
				() => modified.a,
			);
			const b = stream(
				{
					id: "file:2",
					kind: "file",
					producer: "bench > $d/run.log",
					consumer: `${os.homedir()}/runs/b/run.log`,
					node: "0:0:2",
					bytes: 20,
					open: true,
					modified: now - 5_000,
				},
				"round b/1\nround b/2\n",
				() => modified.b,
			);
			const pipe = stream(
				{
					id: "pipe:3",
					kind: "pipe",
					producer: "grep -c round a/run.log",
					consumer: "LC_ALL=C /usr/bin/head",
					node: "0:0:4",
					bytes: 2,
					open: true,
					modified: now - 8_000,
				},
				"1\n",
				() => modified.pipe,
			);
			return { a, b, pipe };
		}

		/** A sheet over `job` whose detail reads `state` anew every frame. */
		function setupSteps(state: { output: string; streams: ShellStream[]; outputModified?: number }) {
			return new JobsSheet({
				load: () => ({ running: [job], recent: [] }),
				inspect: () => ({
					command: job.label,
					pids: [7],
					output: state.output,
					outputModified: state.outputModified,
					trace,
					streams: state.streams,
				}),
				close: vi.fn(),
			});
		}

		const shown = (root: NativeNode) => prop(byRole(root, "omp.jobs.output")[0], "text");
		const menu = (root: NativeNode) => byRole(root, "omp.jobs.sources")[0];

		it("shows the newest stream of a clicked step, and lists every stream with labels that tell them apart", async () => {
			await initTheme();
			const { a, b, pipe } = streams(Date.now());
			const sheet = setupSteps({ output: "", streams: [a, b, pipe] });
			sheet.describe(CX);
			// A click lands on the redirect word: its command writes both files, one per pass of the loop.
			sheet.handleNativeEvent(command("select:0:0:7"));
			const root = sheet.describe(CX);

			expect(shown(root)).toBe("round b/1\nround b/2\n");
			expect(prop(menu(root), "text")).toBe("b/run.log");
			expect(prop(menu(root), "items")).toEqual([
				{ id: "source:out", label: "Output", radio: "source", checked: false },
				{
					id: "source:file:1",
					label: "a/run.log",
					detail: "~/runs/a/run.log · 10B",
					radio: "source",
					checked: false,
				},
				{
					id: "source:file:2",
					label: "b/run.log",
					detail: "~/runs/b/run.log · 20B",
					radio: "source",
					checked: true,
				},
				{
					id: "source:pipe:3",
					label: "grep → head",
					detail: "grep -c round a/run.log → LC_ALL=C /usr/bin/head · 2B",
					radio: "source",
					checked: false,
				},
			]);
			expect(texts(byRole(root, "omp.jobs.stream")[0]!)).toBe("~/runs/b/run.log · 20B");
			expect(byRole(root, "omp.jobs.follow")).toHaveLength(0);
			expect(texts(byRole(root, "omp.jobs.source")[0]!)).toContain("Follow live");
			expect(nodes(root).some(node => node.k === "tabs")).toBe(false);

			// A megabyte per stream per frame otherwise: only the shown one is read, and again only once it grew.
			sheet.invalidate();
			sheet.describe(CX);
			expect(b.tail).toHaveBeenCalledTimes(1);
			expect(a.tail).not.toHaveBeenCalled();
			expect(pipe.tail).not.toHaveBeenCalled();

			const lines = sheet.render(100).map(line => Bun.stripANSI(line));
			expect(lines).toContain("   → b/run.log · ~/runs/b/run.log · 20B");
			expect(lines).toContain("   round b/2");
			// The click on a step is not a click on a job row.
			expect(prop(list(root), "selected")).toBe("bg_13");
		});

		it("shows only a clicked step's own slice of the output when it writes no stream", () => {
			const { a, b, pipe } = streams(Date.now());
			const sheet = setupSteps({ output: "1\ndone\nunattributed\n", streams: [a, b, pipe] });
			sheet.describe(CX);
			sheet.handleNativeEvent(command("select:0:0:6"));
			const root = sheet.describe(CX);
			expect(shown(root)).toBe("done\n");
			expect(prop(menu(root), "text")).toBe("Step output");
			expect(texts(byRole(root, "omp.jobs.stream")[0]!)).toBe("Its own output");

			// `head` reads the pipe but writes the output: its slice, not the pipe `grep` feeds.
			sheet.handleNativeEvent(command("select:0:0:5"));
			expect(shown(sheet.describe(CX))).toBe("1\n");
		});

		it("follows the source written most recently, staying on the followed one while it keeps flowing", () => {
			const now = Date.now();
			const modified: { a?: number; b?: number; pipe?: number } = { a: now - 100 };
			const { a, b, pipe } = streams(now, modified);
			const sheet = setupSteps({ output: "", streams: [a, b, pipe] });
			let root = sheet.describe(CX);
			expect(shown(root)).toBe("round a/1\n");
			expect(prop(byRole(root, "omp.jobs.follow")[0], "text")).toBe("Following");
			expect(prop(byRole(root, "omp.jobs.follow")[0], "tone")).toBe("pending");

			// The pipe was written later, but the file still flows: the pane stays put.
			modified.pipe = Date.now() - 10;
			expect(shown(sheet.describe(CX))).toBe("round a/1\n");

			// The file stalls: the pane moves to the one written most recently.
			modified.a = Date.now() - 5_000;
			root = sheet.describe(CX);
			expect(shown(root)).toBe("1\n");
			expect(prop(menu(root), "text")).toBe("grep → head");

			// Everything stalls: the pane stays on the newest write, its dot still.
			modified.pipe = Date.now() - 4_000;
			root = sheet.describe(CX);
			expect(shown(root)).toBe("1\n");
			expect(prop(byRole(root, "omp.jobs.follow")[0], "tone")).toBeUndefined();
		});

		it("keeps a pinned step while another stream flows, and resumes following when it is clicked again", () => {
			const now = Date.now();
			const modified: { a?: number; b?: number; pipe?: number } = {};
			const { a, b, pipe } = streams(now, modified);
			const sheet = setupSteps({ output: "", streams: [a, b, pipe] });
			sheet.describe(CX);
			sheet.handleNativeEvent(command("select:0:0:2"));
			modified.pipe = Date.now();
			expect(shown(sheet.describe(CX))).toBe("round b/1\nround b/2\n");

			sheet.handleNativeEvent(command("select:0:0:2"));
			let root = sheet.describe(CX);
			expect(shown(root)).toBe("1\n");
			expect(byRole(root, "omp.jobs.follow")).toHaveLength(1);

			// A menu entry pins that source; Follow live lets go of it.
			sheet.handleNativeEvent(action("source:file:1"));
			expect(shown(sheet.describe(CX))).toBe("round a/1\n");
			sheet.handleNativeEvent(action("follow"));
			root = sheet.describe(CX);
			expect(shown(root)).toBe("1\n");
			expect(prop(menu(root), "text")).toBe("grep → head");
		});

		it("never draws a binary stream as text", () => {
			const archive: ShellStream = {
				id: "pipe:1",
				kind: "pipe",
				producer: "git archive HEAD",
				consumer: "tar -x -C /tmp/out",
				bytes: 4096,
				open: false,
				modified: Date.now() - 100,
				tail: () => undefined,
			};
			const root = setupSteps({ output: "", streams: [archive] }).describe(CX);
			expect(prop(menu(root), "text")).toBe("git → tar");
			expect(byRole(root, "omp.jobs.output")).toHaveLength(0);
			expect(prop(byRole(root, "omp.jobs.nooutput")[0], "text")).toBe("Binary data");
		});
	});

	it("draws a traced command as its shell visualization where the terminal has one, changed only by its view controls", async () => {
		const command = "printf 'first\\n' >/dev/null; printf done";
		const run = new RunTrace(command);
		await new Shell().run({ command, trace: run });
		const trace: unknown = JSON.parse(run.snapshot());
		if (!isShellTrace(trace)) throw new Error("the engine returned no shell trace");
		const job: JobsPanelJob = {
			id: "bg_5",
			type: "bash",
			status: "completed",
			label: command,
			startTime: NOW - 1_000,
			endTime: NOW,
		};
		const sheet = new JobsSheet({
			load: () => ({ running: [], recent: [job] }),
			inspect: () => ({ command, pids: [], exitCode: 0, output: "done", trace }),
			close: vi.fn(),
		});
		const commandNode = (cx: DescribeContext = CX) => byRole(sheet.describe(cx), "omp.jobs.command")[0];
		const act = (value: string): NativeUiEvent => ({
			type: "action",
			key: "split/bg_5/command",
			act: "shell-viz",
			value,
			mods: [],
		});

		expect(commandNode()?.k).toBe("shell");
		// Its steps pick the output; a settled job shows its own, so no step is focused.
		expect(prop(commandNode(), "steps")).toBe(true);
		expect(prop(commandNode(), "focus")).toEqual([]);
		expect(prop(commandNode(), "presentation")).toMatchObject({ preferences: { view: "pseudo" } });
		sheet.handleNativeEvent(act("view:raw"));
		expect(prop(commandNode(), "presentation")).toMatchObject({ preferences: { view: "raw" } });

		// Replay is the transcript card's: a cursor set here would freeze the command at its first step.
		sheet.handleNativeEvent(act("reset"));
		expect(prop(commandNode(), "presentation")).not.toHaveProperty("preferences.cursor");

		const plain = commandNode({ ...CX, supports: kind => kind !== "shell" });
		expect(plain?.k).toBe("code");
		expect(prop(plain, "text")).toBe(command);
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

		it("keeps an evicted subagent job under its subagent after the session drops both", () => {
			const mainBash = job("main-bash", "Main");
			let snapshot: JobsPanelSnapshot = {
				rootId: "Main",
				agents: [{ id: "Gone", parentId: "Main" }],
				running: [mainBash],
				recent: [job("gone-done", "Gone", { status: "completed", endTime: NOW })],
			};
			const sheet = new JobsSheet({ load: () => snapshot, inspect: () => undefined, close: vi.fn() });
			sheet.handleNativeEvent({ type: "select", key: "jobs", item: "gone-done" });
			sheet.render(120);

			snapshot = { rootId: "Main", agents: [], running: [mainBash], recent: [] };
			const rows = sheet
				.render(120)
				.slice(1, 4)
				.map(line => line.trimEnd());
			expect(rows).toEqual([
				"  Gone",
				expect.stringMatching(/^> └─ completed {2}bash \S+ {2}gone-done$/),
				expect.stringMatching(/^ {2}running {2}bash \S+ {2}main-bash$/),
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
