import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	buildTrayItems,
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
		widget: () => undefined,
		showAgents: f.showAgents,
		canOpen: candidate => !f.unopenable.has(candidate.id),
		now,
	};
}

function cards(f: Fixture, memory = new TrayMemory()): string[] {
	return buildTrayItems(input(f), memory).map(item => `${item.item}:${item.ref}:${item.status}`);
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

		const items = buildTrayItems(input(f), new TrayMemory());
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

	it("sends no cards while nothing is live or failed, and keeps the memory for when work starts again", () => {
		const f = fixture();
		const memory = new TrayMemory();
		f.refs.push(ref("Old", "idle"));
		// Only the done card: nothing to show.
		expect(cards(f, memory)).toEqual([]);
		// Beside a running job it shows.
		f.jobs.push(job("bg_1"));
		expect(cards(f, memory)).toEqual(["done:done:done", "job:bg_1:running"]);

		// A settled agent whose result still waits, beside the running job; dismiss it, and let its clock run.
		f.sessions.push({ ...observed("Scout", "completed"), lastUpdate: 90_000 });
		f.refs.push(ref("Scout", "idle", 5));
		f.agentJobs.set("Scout", job("Scout", { type: "task", agentId: "Scout", status: "completed" }));
		expect(cards(f, memory)).toEqual(["agent:Scout:done", "done:done:done", "job:bg_1:running"]);
		memory.dismissed.add("job:bg_2");

		// The job finishes, its result delivered: only finished work is left, so the tray hides.
		f.jobs[0] = job("bg_1", { status: "completed", endTime: 95_000, resultText: "ok" });
		f.consumed.add("bg_1");
		expect(cards(f, memory)).toEqual([]);
		expect(memory.dismissed.has("job:bg_2")).toBe(true);
		expect(memory.agents.get("Scout")).toMatchObject({ live: false, acted: 90_000 });

		// A failure alone keeps it up.
		f.jobs.push(job("bg_2", { status: "failed", endTime: 96_000, errorText: "boom" }));
		memory.dismissed.delete("job:bg_2");
		expect(cards(f, memory)).toEqual(["agent:Scout:done", "done:done:done", "job:bg_2:failed"]);
	});

	it("titles an agent's card with its id, keeping its type for the closer look and the aria", () => {
		const f = fixture();
		f.sessions.push(
			observed("ScanAuth", "active", { agent: "m2", toolCount: 6, contextTokens: 22_000, contextWindow: 100_000 }),
		);
		// The registry's display name for a task subagent is its agent type.
		f.refs.push({ ...ref("ScanAuth", "running"), displayName: "m2" }, { ...ref("Old", "idle"), displayName: "m2" });
		const [card, done] = buildTrayItems(input(f), new TrayMemory());
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

	it("titles a /tan clone by its job's label, its generated id being no name", () => {
		const f = fixture();
		f.refs.push({ ...ref("Tan-0190a1b2c3d4e5f6", "running"), displayName: "tan" });
		f.agentJobs.set(
			"Tan-0190a1b2c3d4e5f6",
			job("Tan-0190a1b2c3d4e5f6", {
				type: "task",
				agentId: "Tan-0190a1b2c3d4e5f6",
				label: "/tan fix the flaky test",
				request: "fix the flaky test",
			}),
		);
		expect(buildTrayItems(input(f), new TrayMemory())[0]).toMatchObject({
			name: "/tan fix the flaky test",
			type: "tan",
		});
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
			const item = buildTrayItems(input(f, now), memory).find(candidate => candidate.ref === "Scout");
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
			job("bg_2", { status: "completed", endTime: 3_000, resultText: "ok" }),
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
		expect(host.showJobsSheet).toHaveBeenCalledTimes(1);
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

	it("reads working, then waiting while a wait call executes, then working, then idle once the turn ends", () => {
		const main = new TrayMainActivity(false);
		const state = () => main.state(() => false);
		expect(state()).toBe("idle");
		main.handle({ type: "agent_start" }, true);
		expect(state()).toBe("working");
		main.handle(start("call-1", "wait"), true);
		expect(state()).toBe("waiting");
		main.handle(end("call-1"), true);
		expect(state()).toBe("working");
		main.handle({ type: "agent_end" }, false);
		expect(state()).toBe("idle");
	});

	it("stays working while another call runs beside the wait, and idles when the turn yields to background work", () => {
		const main = new TrayMainActivity(true);
		const state = () => main.state(() => false);
		main.handle(start("call-1", "wait"), true);
		main.handle(start("call-2", "bash"), true);
		expect(state()).toBe("working");
		main.handle(end("call-2"), true);
		expect(state()).toBe("waiting");
		// A vibe worker wait blocks the same way.
		main.handle(start("call-3", "vibe_wait"), true);
		expect(state()).toBe("waiting");
		// The run stays open on background jobs, but the model yielded.
		main.handle({ type: "agent_pause", yielded: true }, true);
		expect(state()).toBe("idle");
		// A pause the session continues on its own is still the turn's work.
		main.handle({ type: "agent_start" }, true);
		main.handle({ type: "agent_pause", yielded: false }, true);
		expect(state()).toBe("working");
	});

	it("counts a task call as waiting only while it runs an agent inline", () => {
		const main = new TrayMainActivity(true);
		main.handle(start("call-1", "task"), true);
		const sessions: ObservableSession[] = [];
		const state = () => main.state(id => runsInlineAgent(sessions, id));
		expect(state()).toBe("working");
		// A background spawn of the same call blocks nothing.
		sessions.push({ ...observed("Bg", "active"), parentToolCallId: "call-1", detached: true });
		expect(state()).toBe("working");
		sessions.push({ ...observed("Inline", "active"), parentToolCallId: "call-1", detached: false });
		expect(state()).toBe("waiting");
	});
});
