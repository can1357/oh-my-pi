/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import {
	type JobsPanelDetail,
	JobsPanel,
	type JobsPanelSnapshot,
	type JobsPanelSource,
} from "../../../../src/ui/overlays/pickers/jobs-panel";
import type { JobWidgetView } from "../../../../src/tools/details/job-widget";
import { type Driver, pickerSuite } from "./harness";

// The capture's own clock (its cases ran in order: `jobs` moved it 1.5s for the rest).
const NOW = 1_900_000_000_000;

const modelEval: JobWidgetView = {
	title: "eval · tests passed per model",
	headline: { text: "71/90", label: "passed" },
	blocks: [
		{
			kind: "bars",
			label: "tests passed",
			max: 30,
			items: [
				{ label: "opus-4.5", value: 26, text: "26/30", tone: "success" },
				{ label: "gpt-5.1", value: 24, text: "24/30" },
				{ label: "gemini-3-pro", value: 21, text: "21/30", tone: "warning" },
			],
		},
	],
	state: "live",
	updatedAt: 1_700_000_001_000,
};

const JOBS: JobsPanelSnapshot = {
	rootId: "root",
	running: [
		{
			id: "task-1",
			type: "task",
			status: "running",
			label: "Audit credits",
			agentId: "CreditAudit",
			startTime: NOW - 5_000,
			ownerId: "root",
			intent: "Audit the credit ledger for drift",
			caption: "Reads every ledger row and compares totals; ends when all match.",
		},
		{ id: "bash-1", type: "bash", status: "running", label: "cargo test --workspace", startTime: NOW - 2_000 },
		{
			id: "bash-sub",
			type: "bash",
			status: "running",
			label: "ls -la /very/long/path/ünïcödé",
			startTime: NOW - 2_000,
			ownerId: "CreditAudit",
		},
	],
	recent: [
		{ id: "bash-2", type: "bash", status: "failed", label: "bun lint", startTime: NOW - 9_000, endTime: NOW - 8_000 },
		{
			id: "bash-3",
			type: "bash",
			status: "completed",
			label: "echo hi",
			startTime: NOW - 99_000,
			endTime: NOW - 98_000,
		},
	],
	agents: [{ id: "CreditAudit", parentId: "root" }],
};

const LONG_COMMAND = Array.from({ length: 40 }, (_, i) => `echo step ${i} && sleep 1`).join("\n");
const DETAILS: Record<string, JobsPanelDetail> = {
	"task-1": { cwd: "/work", pids: [], widget: modelEval },
	"bash-1": {
		command: LONG_COMMAND,
		cwd: "/work",
		pids: [41, 42],
		output: `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}\n\n`,
	},
	"bash-2": { command: "bun lint", cwd: "/work", pids: [], exitCode: 1, output: "1 error\n", artifactId: "77" },
	"bash-3": { command: "echo hi", pids: [], exitCode: 0, output: "" },
	"bash-sub": { command: "ls\t-la", pids: [], output: "\x1b[31mred\x1b[0m\n" },
};

pickerSuite({
	dir: "overlays/jobs-panel",
	mount(caseName) {
		const clock = signal(caseName === "jobs" ? NOW : NOW + 1_500);
		const refresh = signal(0);
		let evicted = false;
		const load = (): JobsPanelSnapshot =>
			caseName === "empty" ? { running: [], recent: [] } : evicted ? { ...JOBS, recent: [] } : JOBS;
		const source: JobsPanelSource = {
			load,
			inspect: id => DETAILS[id],
			...(caseName === "read-only-selected" ? {} : { cancel() {} }),
			close() {},
		};
		const selected =
			caseName === "read-only-selected" ? "bash-sub" : caseName === "evicted-held" ? "bash-2" : undefined;
		const action =
			(act: string, key = "") =>
			(d: Driver) =>
				void d.emit({ type: "action", key, act, mods: [] });
		return {
			view: () => <JobsPanel source={source} selected={selected} refresh={refresh} now={() => clock()} />,
			focus: d => d.root,
			steps: {
				"select bash-2": d => void d.emit({ type: "select", key: "split/master/jobs", item: "bash-2" }),
				"time +1.5s": () => {
					clock.set(clock() + 1_500);
				},
				follow: action("follow"),
				"source pick": action("source:output"),
				"select bash-1": d => void d.emit({ type: "activate", key: "split/master/jobs", item: "bash-1" }),
				cancel: action("cancel"),
				"command event": action("view:steps"),
				evict: () => {
					evicted = true;
					refresh.set(refresh() + 1);
				},
				down: d => d.press("\x1b[B"),
			},
		};
	},
});
