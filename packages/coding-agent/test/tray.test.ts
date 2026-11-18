import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	buildTrayItems,
	describeTrayCard,
	runsInlineAgent,
	Tray,
	type TrayHost,
	type TrayInput,
	type TrayMain,
	TrayMainActivity,
	TrayMemory,
} from "@oh-my-pi/pi-coding-agent/modes/tray";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";

function progress(id: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: id,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 1_000,
		...overrides,
	};
}

function observed(
	id: string,
	status: ObservableSession["status"],
	overrides: Partial<AgentProgress> = {},
): ObservableSession {
	return {
		id,
		kind: "subagent",
		label: id,
		description: `${id} work`,
		status,
		lastUpdate: 50_000,
		progress: progress(id, overrides),
		progressAt: 40_000,
	};
}

function ref(id: string, status: AgentRecordLike["status"], lastActivity = 0): AgentRecordLike {
	return {
		id,
		displayName: id,
		kind: "sub",
		parentId: "Main",
		status,
		session: null,
		sessionFile: null,
		createdAt: 0,
		lastActivity,
	};
}

function job(id: string, overrides: Partial<AsyncJob> = {}): AsyncJob {
	return {
		id,
		type: "bash",
		status: "running",
		startTime: 1_000,
		label: id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
		...overrides,
	};
}

const WIDGET: JobWidgetView = {
	title: "loadtest",
	headline: { text: "186 tok/s" },
	blocks: [{ kind: "stat", items: [{ label: "p99", text: "212 ms" }] }],
	state: "live",
	updatedAt: 1,
};

interface Fixture {
	sessions: ObservableSession[];
	refs: AgentRecordLike[];
	jobs: AsyncJob[];
	/** Jobs that run agents, by agent id. */
	agentJobs: Map<string, AsyncJob>;
	consumed: Set<string>;
	showAgents: boolean;
	/** Agents focusing cannot open (no session, no transcript). */
	unopenable: Set<string>;
	/** Running jobs that draw a widget. */
	widgets: Set<string>;
	main: TrayMain;
}

function fixture(): Fixture {
	return {
		sessions: [],
		refs: [],
		jobs: [],
		agentJobs: new Map(),
		consumed: new Set(),
		showAgents: true,
		unopenable: new Set(),
		widgets: new Set(),
		main: "working",
	};
}

function input(f: Fixture, now = 60_000): TrayInput {
	return {
		sessions: f.sessions,
		refs: f.refs,
		unread: () => 0,
		agentJob: id => f.agentJobs.get(id),
		jobs: f.jobs,
		consumed: id => f.consumed.has(id),
		widget: candidate => (f.widgets.has(candidate.id) ? WIDGET : undefined),
		showAgents: f.showAgents,
		canOpen: candidate => !f.unopenable.has(candidate.id),
		now,
	};
}

function cards(f: Fixture, memory = new TrayMemory()): string[] {
	return buildTrayItems(input(f), memory).items.map(item => `${item.item}:${item.ref}:${item.status}`);
}

function children(node: NativeNode | undefined): NativeNode[] {
	return (node?.c ?? []).filter((child): child is NativeNode => "k" in child);
}

function role(node: NativeNode | undefined): unknown {
	return node?.p ? Reflect.get(node.p, "role") : undefined;
}

const action = (act: string, value: string): NativeUiEvent => ({ type: "action", key: "", act, value, mods: [] });

describe("tray items", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("gives cards to live agents and to settled ones until their job's result is consumed, and folds the rest into the done card", () => {
		const f = fixture();
		f.sessions.push(
			observed("Queued", "active", { status: "pending" }),
			observed("Running", "active"),
			observed("Unread", "completed"),
			observed("Delivered", "completed"),
			observed("Inline", "failed"),
		);
		f.refs.push(
			ref("Queued", "running"),
			ref("Running", "running"),
			ref("Unread", "idle", 3),
			ref("Delivered", "idle", 2),
			ref("Inline", "idle", 1),
			// A message woke it: running in the registry, unknown to the observer.
			ref("Woken", "running"),
		);
		f.agentJobs.set("Unread", job("Unread", { type: "task", agentId: "Unread", status: "completed" }));
		f.agentJobs.set("Delivered", job("Delivered", { type: "task", agentId: "Delivered", status: "completed" }));
		f.consumed.add("Delivered");

		const items = buildTrayItems(input(f), new TrayMemory()).items;
		expect(items.map(item => `${item.item}:${item.ref}:${item.status}`)).toEqual([
			"agent:Queued:queued",
			"agent:Running:running",
			"agent:Unread:done",
			"agent:Woken:running",
			"done:done:done",
		]);
		// Finished agents without a card, newest first: the delivered one, then the synchronous one.
		expect(items.at(-1)).toMatchObject({ count: 2, names: "Delivered, Inline" });
	});

	it("keeps agents and jobs disjoint: a job that runs an agent is that agent's card, never a job card", () => {
		const f = fixture();
		f.sessions.push(observed("Scout", "active"));
		f.refs.push(ref("Scout", "running"));
		f.jobs.push(
			job("Scout", { type: "task", agentId: "Scout", startTime: 500 }),
			job("bg_2", { startTime: 900 }),
			job("bg_1", { startTime: 100 }),
		);
		expect(cards(f)).toEqual(["agent:Scout:running", "job:bg_1:running", "job:bg_2:running"]);
	});

	it("keeps a settled job's card until its result is consumed, and never shows a cancelled one", () => {
		const f = fixture();
		f.jobs.push(
			job("bg_1", { status: "completed", endTime: 2_000, resultText: "ok" }),
			job("bg_2", { status: "failed", endTime: 2_000, errorText: "boom" }),
			job("bg_3", { status: "cancelled", endTime: 2_000 }),
		);
		expect(cards(f)).toEqual(["job:bg_1:done", "job:bg_2:failed"]);
		f.consumed.add("bg_1");
		expect(cards(f)).toEqual(["job:bg_2:failed"]);
	});

	it("keeps every card while nothing is live, calling the tray quiet unless something runs or failed", () => {
		const f = fixture();
		const memory = new TrayMemory();
		const quiet = (): boolean => buildTrayItems(input(f), memory).quiet;
		f.refs.push(ref("Old", "idle"));
		// Only finished work: quiet, and the finished agent has its own card.
		expect(cards(f, memory)).toEqual(["agent:Old:done"]);
		expect(quiet()).toBe(true);
		// Beside a running job it is not, and the finished agent folds into the done card.
		f.jobs.push(job("bg_1"));
		expect(quiet()).toBe(false);
		expect(cards(f, memory)).toEqual(["done:done:done", "job:bg_1:running"]);

		// A settled agent whose result still waits keeps its card once the job is done and delivered.
		f.sessions.push({ ...observed("Scout", "completed"), lastUpdate: 90_000 });
		f.refs.push(ref("Scout", "idle", 5));
		f.agentJobs.set("Scout", job("Scout", { type: "task", agentId: "Scout", status: "completed" }));
		f.jobs[0] = job("bg_1", { status: "completed", endTime: 95_000, resultText: "ok" });
		f.consumed.add("bg_1");
		expect(cards(f, memory)).toEqual(["agent:Scout:done", "agent:Old:done"]);
		expect(quiet()).toBe(true);

		// A failure alone is worth the room.
		f.jobs.push(job("bg_2", { status: "failed", endTime: 96_000, errorText: "boom" }));
		expect(quiet()).toBe(false);
		expect(cards(f, memory)).toEqual(["agent:Scout:done", "done:done:done", "job:bg_2:failed"]);
		memory.dismissed.add("job:bg_2");
		expect(quiet()).toBe(true);
	});

	it("gives each finished agent its own settled card in a quiet tray, from the observer or from saved history", () => {
		const f = fixture();
		// Finished in this run, its result delivered: the observer knows its run and its last words.
		f.sessions.push({
			...observed("Fresh", "completed", {
				durationMs: 30_000,
				toolCount: 6,
				contextTokens: 22_000,
				contextWindow: 100_000,
				cost: 0.12,
				recentOutput: ["**Checker:** `✓ wrapper passes` (exit 0)"],
			}),
		});
		f.refs.push({ ...ref("Fresh", "idle", 30), sessionFile: "/tmp/Fresh.jsonl" });
		f.agentJobs.set("Fresh", job("Fresh", { type: "task", agentId: "Fresh", status: "completed" }));
		f.consumed.add("Fresh");
		// Failed, its result delivered: red, yet the tray stays quiet.
		f.sessions.push(observed("Broke", "failed"));
		f.refs.push({ ...ref("Broke", "idle", 20), sessionFile: "/tmp/Broke.jsonl" });
		f.agentJobs.set(
			"Broke",
			job("Broke", { type: "task", agentId: "Broke", status: "failed", errorText: "boom\nstack" }),
		);
		f.consumed.add("Broke");
		// Restored from disk: no observer session, only the registry's saved history.
		f.refs.push({
			...ref("Restored", "parked", 10),
			sessionFile: "/tmp/Restored.jsonl",
			activity: "```\n- **`NOTES.md`:** it now records the run\n```",
			history: { agent: "m2", metrics: { tokens: 0, requests: 0, tools: 4, cost: 0, durationMs: 95_000 } },
		});

		const build = buildTrayItems(input(f), new TrayMemory());
		expect(build.quiet).toBe(true);
		expect(build.items.map(item => `${item.item}:${item.ref}:${item.status}`)).toEqual([
			"agent:Fresh:done",
			"agent:Broke:failed",
			"agent:Restored:done",
		]);
		const [fresh, broke, restored] = build.items;
		expect(fresh).toMatchObject({
			acted: 30,
			text: "Checker: ✓ wrapper passes (exit 0)",
			tools: 6,
			duration: 30_000,
			stats: "22% · $0.120",
			openable: true,
			// Its task says more than its outcome line.
			look: true,
		});
		expect(broke).toMatchObject({ text: "boom" });
		// Saved history: duration and tools; no tokens, context or cost known, so none is shown.
		expect(restored).toMatchObject({
			acted: 10,
			type: "m2",
			text: "NOTES.md: it now records the run",
			tools: 4,
			duration: 95_000,
			stats: "",
			aria: "Restored, m2, done, NOTES.md: it now records the run, 4 tools",
			// No task, no calls recorded: a closer look would repeat the card.
			look: false,
		});
		const card = describeTrayCard(restored!, 0);
		expect(children(children(card)[0]).map(role)).toEqual([
			"omp.tray.dot",
			"omp.tray.name",
			"omp.tray.time",
			"omp.tray.tools",
		]);
		expect(children(children(card)[0])[2]!.p).toMatchObject({ age: 95_000, stopped: 95_000 });
	});

	it("shows the first 48 finished agents as cards in a quiet tray, the done card standing for the rest", () => {
		const f = fixture();
		for (let i = 0; i < 60; i++) f.refs.push(ref(`Agent${i}`, "idle", i));
		const { items, quiet } = buildTrayItems(input(f), new TrayMemory());
		expect(quiet).toBe(true);
		expect(items).toHaveLength(49);
		expect(items.slice(0, 2).map(item => item.ref)).toEqual(["Agent59", "Agent58"]);
		const done = items.at(-1)!;
		expect(done).toMatchObject({ item: "done", name: "12 more done", count: 12 });
		expect(done.item === "done" && done.entries.map(entry => entry.id)).toEqual(
			Array.from({ length: 12 }, (_, i) => `Agent${11 - i}`),
		);
	});

	it("takes plain text from an agent's words: inline markup stripped, markup-only lines skipped", () => {
		const f = fixture();
		f.jobs.push(job("bg_1"));
		const said = (activity: string): string => {
			f.refs.splice(0, f.refs.length, { ...ref("Done", "idle"), activity });
			const done = buildTrayItems(input(f), new TrayMemory()).items[0];
			return done?.item === "done" ? done.entries[0]!.line : "";
		};
		expect(said("**Checker:** `✓ wrapper passes` (exit 0)…")).toBe("Checker: ✓ wrapper passes (exit 0)…");
		expect(said("- **`NOTES.md`:** it now records…")).toBe("NOTES.md: it now records…");
		expect(said("```ts\nconst job_manager_api = 1;\n```")).toBe("const job_manager_api = 1;");
		expect(said("---\n> ## [Results](https://x.test) are _in_")).toBe("Results are in");
	});

	it("titles an agent's card with its id, keeping its type for the closer look and the aria", () => {
		const f = fixture();
		f.sessions.push(
			observed("ScanAuth", "active", { agent: "m2", toolCount: 6, contextTokens: 22_000, contextWindow: 100_000 }),
		);
		// The registry's display name for a task subagent is its agent type.
		f.refs.push({ ...ref("ScanAuth", "running"), displayName: "m2" }, { ...ref("Old", "idle"), displayName: "m2" });
		const [card, done] = buildTrayItems(input(f), new TrayMemory()).items;
		expect(card).toMatchObject({
			name: "ScanAuth",
			type: "m2",
			tools: 6,
			stats: "22%",
			aria: "ScanAuth, m2, running, Thinking, 6 tools",
		});
		expect(done).toMatchObject({ names: "Old" });
		expect(done?.item === "done" && done.entries[0]?.name).toBe("Old");
	});

	it("hides agent cards and the done card under display.pinnedAgents off, keeping the jobs", () => {
		const f = fixture();
		f.sessions.push(observed("Running", "active"));
		f.refs.push(ref("Running", "running"), ref("Old", "idle"));
		f.jobs.push(job("bg_1"));
		f.showAgents = false;
		expect(cards(f)).toEqual(["job:bg_1:running"]);
	});

	it("moves `acted` only when a later call starts or the agent settles", () => {
		const f = fixture();
		const memory = new TrayMemory();
		const acted = (now: number): number | undefined => {
			const item = buildTrayItems(input(f, now), memory).items.find(candidate => candidate.ref === "Scout");
			return item?.item === "agent" ? item.acted : undefined;
		};
		f.sessions.push(observed("Scout", "active", { currentTool: "read", currentToolStartMs: 41_000 }));
		f.refs.push(ref("Scout", "running"));
		expect(acted(60_000)).toBe(41_000);

		// Progress that starts no call (more tokens, a newer frame) leaves it.
		f.sessions[0] = {
			...observed("Scout", "active", { currentTool: "read", currentToolStartMs: 41_000, tokens: 9_000 }),
			lastUpdate: 70_000,
			progressAt: 70_000,
		};
		expect(acted(70_000)).toBe(41_000);

		f.sessions[0] = observed("Scout", "active", { currentTool: "grep", currentToolStartMs: 45_000 });
		expect(acted(80_000)).toBe(45_000);

		// It settles: `acted` is the moment it did; its job's result still waits, so it keeps its card
		// (a running job keeps the tray up).
		f.jobs.push(job("bg_1"));
		f.sessions[0] = { ...observed("Scout", "completed"), lastUpdate: 90_000 };
		f.refs[0] = ref("Scout", "idle");
		f.agentJobs.set("Scout", job("Scout", { type: "task", agentId: "Scout", status: "completed" }));
		expect(acted(95_000)).toBe(90_000);
		expect(acted(99_000)).toBe(90_000);
	});
});

describe("Tray", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function setup(f: Fixture) {
		const host = {
			input: () => input(f),
			main: () => f.main,
			focusAgent: vi.fn(),
			showJobsSheet: vi.fn(),
			stopAgent: vi.fn(),
			cancelJob: vi.fn(),
			requestRender: vi.fn(),
		} satisfies TrayHost;
		const tray = new Tray(host);
		tray.setOnHost(true);
		return { host, tray };
	}

	function seeded(): Fixture {
		const f = fixture();
		f.sessions.push(
			observed("Scout", "active", { currentTool: "read", currentToolStartMs: 41_000 }),
			observed("Review", "completed"),
		);
		f.refs.push(ref("Scout", "running"), ref("Review", "idle"), ref("Old", "idle"));
		f.agentJobs.set("Review", job("Review", { type: "task", agentId: "Review", status: "completed" }));
		f.jobs.push(
			job("bg_1", { progressText: "one\ntwo" }),
			job("bg_2", { status: "completed", endTime: 3_000, resultText: "one\ntwo\nok" }),
		);
		return f;
	}

	const refs = (root: NativeNode): unknown[] =>
		children(root)
			.filter(node => role(node) === "omp.tray.card")
			.map(node => node.p && Reflect.get(node.p, "ref"));

	it("routes each event: open, stop, dismiss and the jobs sheet; the done card and `agents.open` open nothing", () => {
		const { host, tray } = setup(seeded());
		tray.describe();

		tray.handleNativeEvent(action("tray.peek", "Scout"));
		expect(tray.describe().p).toMatchObject({ peek: "Scout" });
		tray.handleNativeEvent(action("tray.open", "Scout"));
		expect(host.focusAgent).toHaveBeenCalledWith("Scout");
		// Opening clears the closer look.
		expect(tray.describe().p && Reflect.get(tray.describe().p!, "peek")).toBeUndefined();
		tray.handleNativeEvent(action("tray.open", "bg_1"));
		// The sheet opens on that job.
		expect(host.showJobsSheet).toHaveBeenCalledWith("bg_1");
		tray.handleNativeEvent(action("tray.peek", "done"));
		tray.handleNativeEvent(action("tray.open", "done"));
		// The closer look stays: the done card is opened row by row.
		expect(tray.describe().p).toMatchObject({ peek: "done" });
		tray.handleNativeEvent(action("tray.peek", ""));

		tray.handleNativeEvent(action("tray.stop", "Scout"));
		expect(host.stopAgent).toHaveBeenCalledWith("Scout");
		tray.handleNativeEvent(action("tray.stop", "bg_1"));
		expect(host.cancelJob).toHaveBeenCalledWith("bg_1");
		// A settled item has nothing to stop.
		tray.handleNativeEvent(action("tray.stop", "bg_2"));
		expect(host.cancelJob).toHaveBeenCalledTimes(1);

		// Dismissing a settled agent folds it into the done card; a settled job's card goes.
		expect(refs(tray.describe())).toEqual(["Scout", "Review", "done", "bg_1", "bg_2"]);
		tray.handleNativeEvent(action("tray.dismiss", "Review"));
		tray.handleNativeEvent(action("tray.dismiss", "bg_2"));
		// A live card cannot be dismissed.
		tray.handleNativeEvent(action("tray.dismiss", "bg_1"));
		const after = tray.describe();
		expect(refs(after)).toEqual(["Scout", "done", "bg_1"]);
		expect(JSON.stringify(children(after).find(node => node.p && Reflect.get(node.p, "ref") === "done"))).toContain(
			'"2 done"',
		);

		const calls = (): number[] =>
			[host.focusAgent, host.showJobsSheet, host.stopAgent, host.cancelJob].map(fn => fn.mock.calls.length);
		const before = calls();
		tray.handleNativeEvent(action("agents.open", ""));
		expect(calls()).toEqual(before);
		tray.handleNativeEvent(action("jobs.open", ""));
		expect(host.showJobsSheet).toHaveBeenCalledTimes(2);
	});

	it("drops the closer look when its card goes, and ignores a peek at no card", () => {
		const f = seeded();
		const { tray } = setup(f);
		tray.describe();
		tray.handleNativeEvent(action("tray.peek", "nobody"));
		expect(children(tray.describe()).some(node => role(node) === "omp.tray.peek")).toBe(false);

		tray.handleNativeEvent(action("tray.peek", "bg_2"));
		const look = children(tray.describe()).at(-1);
		expect(look?.p).toMatchObject({ role: "omp.tray.peek", ref: "bg_2" });
		expect(JSON.stringify(look)).toContain('"tray.dismiss=bg_2"');

		f.consumed.add("bg_2");
		tray.refresh();
		const root = tray.describe();
		expect(children(root).some(node => role(node) === "omp.tray.peek")).toBe(false);
		expect(root.p && Reflect.get(root.p, "peek")).toBeUndefined();
	});

	it("captions the idle status row while the tray shows cards, and stays silent without them", () => {
		const f = fixture();
		f.jobs.push(job("bg_1"), job("bg_2", { status: "failed", endTime: 2_000, errorText: "boom" }));
		const { tray } = setup(f);
		expect(tray.caption(true)?.p).toEqual({
			role: "omp.tray.caption",
			text: "1 job in the background",
			wrap: "none",
			truncate: "end",
		});
		expect(tray.caption(false)).toBeUndefined();
		// A failure alone is still worth the row.
		f.jobs.splice(0, 1);
		expect(tray.caption(true)?.p).toMatchObject({ text: "1 job finished" });
		// Only finished work: the tray is quiet, and a caption over it would announce nothing.
		f.jobs[0] = job("bg_2", { status: "completed", endTime: 2_000, resultText: "ok" });
		expect(tray.caption(true)).toBeUndefined();
		expect(tray.describe().p).toMatchObject({ role: "omp.tray", quiet: true, main: "working" });
		f.jobs.splice(0, 1);
		expect(tray.caption(true)).toBeUndefined();
	});

	it("describes nothing in the header off a tray host, and focuses the tray only while it shows cards", () => {
		const f = fixture();
		const { host, tray } = setup(f);
		tray.describe();
		expect(tray.focus()).toBe(false);
		f.jobs.push(job("bg_1"));
		tray.refresh();
		expect(tray.focus()).toBe(true);
		expect(tray.describe().p).toMatchObject({ focus: 1 });
		expect(host.requestRender).toHaveBeenCalled();

		tray.setOnHost(false);
		expect(tray.caption(true)).toBeUndefined();
		expect(tray.focus()).toBe(false);
	});

	it("looks closer at, opens and dismisses a finished agent's own card in a quiet tray", () => {
		const f = fixture();
		// Finished in this run, with calls to list.
		f.sessions.push(
			observed("Openable", "completed", { recentTools: [{ tool: "read", args: "a.ts", endMs: 1_000 }] }),
		);
		f.refs.push(
			{ ...ref("Openable", "idle", 2), sessionFile: "/tmp/Openable.jsonl" },
			{ ...ref("Advisor", "idle", 1), kind: "advisor" },
		);
		f.unopenable.add("Advisor");
		const { host, tray } = setup(f);
		expect(refs(tray.describe())).toEqual(["Openable", "Advisor"]);

		tray.handleNativeEvent(action("tray.peek", "Openable"));
		const look = children(tray.describe()).at(-1)!;
		expect(look.p).toMatchObject({ role: "omp.tray.peek", ref: "Openable" });
		expect(
			children(children(look)[0])
				.filter(node => node.k === "button")
				.map(node => node.p && Reflect.get(node.p, "actions")),
		).toEqual([{ click: "tray.open=Openable" }, { click: "tray.dismiss=Openable" }, { click: "tray.peek=" }]);
		tray.handleNativeEvent(action("tray.open", "Openable"));
		expect(host.focusAgent).toHaveBeenCalledWith("Openable");

		// One nothing can open, with nothing more to show than its card: no closer look, no Open.
		tray.handleNativeEvent(action("tray.peek", "Openable"));
		const advisor = children(tray.describe()).find(node => node.p && Reflect.get(node.p, "ref") === "Advisor")!;
		expect(advisor.p).toMatchObject({ look: false });
		tray.handleNativeEvent(action("tray.peek", "Advisor"));
		// The open closer look stays where it was.
		expect(tray.describe().p).toMatchObject({ peek: "Openable" });
		tray.handleNativeEvent(action("tray.open", "Advisor"));
		expect(host.focusAgent).toHaveBeenCalledTimes(1);

		// Dismissed without a closer look ever opened on it: its card goes, the done card keeps it reachable.
		tray.handleNativeEvent(action("tray.peek", ""));
		tray.handleNativeEvent(action("tray.dismiss", "Advisor"));
		const after = tray.describe();
		expect(refs(after)).toEqual(["Openable", "done"]);
		expect(JSON.stringify(children(after).find(node => node.p && Reflect.get(node.p, "ref") === "done"))).toContain(
			'"1 more done"',
		);
	});

	it("marks the cards whose closer look would add nothing, and ignores a look at them", () => {
		const f = fixture();
		// A running agent with its task and a call to list: a closer look worth having.
		f.sessions.push(observed("Scout", "active", { currentTool: "read", currentToolArgs: "a.ts" }));
		f.refs.push(
			{ ...ref("Scout", "running"), sessionFile: "/tmp/Scout.jsonl" },
			// Woken by a message: running in the registry, nothing recorded to list.
			{ ...ref("Woken", "running"), sessionFile: "/tmp/Woken.jsonl" },
			{ ...ref("Old", "idle"), sessionFile: "/tmp/Old.jsonl" },
		);
		f.jobs.push(
			job("bg_1"),
			job("bg_2", { progressText: "one\ntwo" }),
			job("bg_3", { progressText: "one\ntwo\nthree" }),
		);
		f.widgets.add("bg_1");
		const { host, tray } = setup(f);
		const looks = Object.fromEntries(
			children(tray.describe()).map(card => [
				card.p && Reflect.get(card.p, "ref"),
				card.p && Reflect.get(card.p, "look"),
			]),
		);
		expect(looks).toEqual({
			Scout: undefined,
			Woken: false,
			done: undefined,
			bg_1: undefined,
			bg_2: false,
			bg_3: undefined,
		});
		tray.handleNativeEvent(action("tray.peek", "bg_2"));
		expect(children(tray.describe()).some(node => role(node) === "omp.tray.peek")).toBe(false);
		// Its menu works without a closer look.
		tray.handleNativeEvent(action("tray.stop", "bg_2"));
		expect(host.cancelJob).toHaveBeenCalledWith("bg_2");
		tray.handleNativeEvent(action("tray.stop", "Woken"));
		expect(host.stopAgent).toHaveBeenCalledWith("Woken");
		tray.handleNativeEvent(action("tray.peek", "Scout"));
		expect(tray.describe().p).toMatchObject({ peek: "Scout" });
	});

	it("lists the done card's agents in its closer look, newest first, capped, each opening its transcript", () => {
		const f = fixture();
		// Something live, so the tray shows.
		f.jobs.push(job("bg_1"));
		for (let i = 0; i < 53; i++) f.refs.push(ref(`Old${i}`, "idle", i));
		// Finished in this run: the observer knows how it went and what it last said.
		f.refs.push({ ...ref("Fresh", "idle", 100), sessionFile: "/tmp/fresh.jsonl" });
		f.sessions.push(
			observed("Fresh", "failed", {
				durationMs: 252_000,
				toolCount: 38,
				cost: 0.12,
				recentOutput: ["", "Tests fail in auth"],
			}),
		);
		// Restored from disk: its persisted history and summary.
		f.refs.push({
			...ref("Restored", "aborted", 99),
			sessionFile: "/tmp/restored.jsonl",
			activity: "Fixed the lexer\nand more",
			history: { metrics: { tokens: 0, requests: 0, tools: 4, cost: 0, durationMs: 0 } },
		});
		f.unopenable.add("Old52");
		const { host, tray } = setup(f);
		tray.describe();
		tray.handleNativeEvent(action("tray.peek", "done"));
		const look = children(tray.describe()).at(-1)!;
		expect(look.p).toMatchObject({ role: "omp.tray.peek", ref: "done" });
		// Only the close button: the rows open agents, nothing opens the done card.
		const head = children(look)[0]!;
		expect(
			children(head)
				.filter(node => node.k === "button")
				.map(node => node.p && Reflect.get(node.p, "actions")),
		).toEqual([{ click: "tray.peek=" }]);

		const list = children(look)[1]!;
		expect(list.p).toMatchObject({ role: "omp.tray.done" });
		const rows = children(list);
		expect(rows).toHaveLength(51);
		expect(rows.slice(0, 3).map(row => row.p && Reflect.get(row.p, "ref"))).toEqual(["Fresh", "Restored", "Old52"]);
		expect(rows.at(-1)!.p).toMatchObject({ role: "omp.tray.done.more", text: "+5 earlier" });

		const [fresh, restored, old] = rows;
		expect(fresh!.p).toMatchObject({
			role: "omp.tray.done.item",
			status: "failed",
			actions: { click: "tray.open=Fresh" },
			aria: "Fresh, failed, 4m12s · 38 tools · $0.120, Tests fail in auth",
		});
		expect(
			children(fresh).map(node => [
				role(node),
				node.p && (Reflect.get(node.p, "text") ?? Reflect.get(node.p, "spans")),
			]),
		).toEqual([
			["omp.tray.dot", [{ t: "●", s: "error" }]],
			["omp.tray.name", "Fresh"],
			["omp.tray.meta", [{ t: "4m12s · 38 tools · $0.120", s: "dim" }]],
			["omp.tray.line", "Tests fail in auth"],
		]);
		// Unknown numbers are left out rather than printed as zeros.
		expect(children(restored).map(role)).toEqual(["omp.tray.dot", "omp.tray.name", "omp.tray.meta", "omp.tray.line"]);
		expect(JSON.stringify(children(restored)[2]!.p)).toContain('"4 tools"');
		expect(children(restored)[0]!.p).toMatchObject({ spans: [{ t: "●", s: "muted" }] });
		// A row nothing can open sends no click.
		expect(old!.p && Reflect.get(old!.p, "actions")).toBeUndefined();

		tray.handleNativeEvent(action("tray.open", "Old52"));
		expect(host.focusAgent).not.toHaveBeenCalled();
		tray.handleNativeEvent(action("tray.open", "Restored"));
		expect(host.focusAgent).toHaveBeenCalledWith("Restored");
		expect(tray.describe().p && Reflect.get(tray.describe().p!, "peek")).toBeUndefined();
	});

	it("says what the main agent is doing on the tray node while it has cards, and nothing without", () => {
		const f = fixture();
		const { tray } = setup(f);
		expect(tray.describe().p).toEqual({ role: "omp.tray", hidden: true });
		f.main = "waiting";
		expect(tray.mainChanged()).toBe(false);

		f.jobs.push(job("bg_1"));
		tray.refresh();
		expect(tray.describe().p).toMatchObject({ role: "omp.tray", main: "waiting" });
		f.main = "idle";
		expect(tray.mainChanged()).toBe(true);
		expect(tray.describe().p).toMatchObject({ main: "idle" });
		expect(tray.mainChanged()).toBe(false);
	});
});

describe("TrayMainActivity", () => {
	const start = (toolCallId: string, toolName: string) => ({
		type: "tool_execution_start" as const,
		toolCallId,
		toolName,
	});
	const end = (toolCallId: string) => ({ type: "tool_execution_end" as const, toolCallId });
	const none = (): boolean => false;

	it("stays waiting after a wait returns, while the model thinks and writes, until another call starts or it yields", () => {
		const main = new TrayMainActivity(false);
		const state = () => main.state(none);
		expect(state()).toBe("idle");
		main.handle({ type: "agent_start" }, true, none);
		expect(state()).toBe("working");
		main.handle(start("call-1", "wait"), true, none);
		expect(state()).toBe("waiting");
		// The wait returns; the model thinks and streams text (no call executes).
		main.handle(end("call-1"), true, none);
		expect(state()).toBe("waiting");
		// Another kind of call ends the wait.
		main.handle(start("call-2", "bash"), true, none);
		expect(state()).toBe("working");
		main.handle(end("call-2"), true, none);
		expect(state()).toBe("working");

		main.handle(start("call-3", "wait"), true, none);
		main.handle(end("call-3"), true, none);
		// The turn ends after the wait.
		main.handle({ type: "agent_end" }, false, none);
		expect(state()).toBe("idle");
		// The next turn starts working.
		main.handle({ type: "agent_start" }, true, none);
		expect(state()).toBe("working");
	});

	it("keeps wait, return, wait as one unbroken waiting, with no frame asked of the tray", () => {
		const f = fixture();
		f.jobs.push(job("bg_1"));
		const main = new TrayMainActivity(true);
		const host = {
			input: () => input(f),
			main: () => main.state(none),
			focusAgent: vi.fn(),
			showJobsSheet: vi.fn(),
			stopAgent: vi.fn(),
			cancelJob: vi.fn(),
			requestRender: vi.fn(),
		} satisfies TrayHost;
		const tray = new Tray(host);
		tray.setOnHost(true);
		main.handle(start("call-1", "wait"), true, none);
		expect(tray.describe().p).toMatchObject({ main: "waiting" });
		for (const event of [end("call-1"), start("call-2", "wait"), end("call-2"), start("call-3", "vibe_wait")]) {
			main.handle(event, true, none);
			expect(tray.mainChanged()).toBe(false);
		}
		expect(tray.describe().p).toMatchObject({ main: "waiting" });
	});

	it("stays working when a wait ends beside another call, and idles when the turn yields to background work", () => {
		const main = new TrayMainActivity(true);
		const state = () => main.state(none);
		main.handle(start("call-1", "wait"), true, none);
		main.handle(start("call-2", "bash"), true, none);
		expect(state()).toBe("working");
		// The wait ends first: the bash still runs, and once it ends nothing was waiting.
		main.handle(end("call-1"), true, none);
		main.handle(end("call-2"), true, none);
		expect(state()).toBe("working");

		main.handle(start("call-3", "wait"), true, none);
		main.handle(end("call-3"), true, none);
		expect(state()).toBe("waiting");
		// The run stays open on background jobs, but the model yielded.
		main.handle({ type: "agent_pause", yielded: true }, true, none);
		expect(state()).toBe("idle");
		main.handle({ type: "agent_start" }, true, none);
		expect(state()).toBe("working");
	});

	it("keeps its state through a pause the session continues on its own", () => {
		const main = new TrayMainActivity(true);
		const state = () => main.state(none);
		main.handle(start("call-1", "wait"), true, none);
		main.handle(end("call-1"), true, none);
		main.handle({ type: "agent_pause", yielded: false }, true, none);
		expect(state()).toBe("waiting");
		main.handle({ type: "agent_start" }, true, none);
		expect(state()).toBe("waiting");
	});

	it("counts a task call as waiting only while it runs an agent inline", () => {
		const main = new TrayMainActivity(true);
		const sessions: ObservableSession[] = [];
		const inline = (id: string): boolean => runsInlineAgent(sessions, id);
		main.handle(start("call-1", "task"), true, inline);
		const state = () => main.state(inline);
		expect(state()).toBe("working");
		// A background spawn of the same call blocks nothing.
		sessions.push({ ...observed("Bg", "active"), parentToolCallId: "call-1", detached: true });
		expect(state()).toBe("working");
		sessions.push({ ...observed("Inline", "active"), parentToolCallId: "call-1", detached: false });
		expect(state()).toBe("waiting");
		// It returns while running its agent inline: still waiting until something else starts.
		main.handle(end("call-1"), true, inline);
		expect(state()).toBe("waiting");
	});
});
