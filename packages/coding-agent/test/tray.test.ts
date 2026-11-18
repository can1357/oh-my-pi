import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { buildTrayItems, Tray, type TrayHost, type TrayInput, TrayMemory } from "@oh-my-pi/pi-coding-agent/modes/tray";
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
}

function fixture(): Fixture {
	return { sessions: [], refs: [], jobs: [], agentJobs: new Map(), consumed: new Set(), showAgents: true };
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

		// It settles: `acted` is the moment it did; its job's result still waits, so it keeps its card.
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
			focusAgent: vi.fn(),
			showAgentHub: vi.fn(),
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

	it("routes each event: open, stop, dismiss and the hub and sheet actions", () => {
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
		tray.handleNativeEvent(action("tray.open", "done"));
		expect(host.showAgentHub).toHaveBeenCalledTimes(1);

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

		tray.handleNativeEvent(action("agents.open", ""));
		tray.handleNativeEvent(action("jobs.open", ""));
		expect(host.showAgentHub).toHaveBeenCalledTimes(2);
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

	it("puts the counts in the header past four cards or with a failed one, and the caption only while idle", () => {
		const f = fixture();
		f.jobs.push(job("bg_1"), job("bg_2", { status: "failed", endTime: 2_000, errorText: "boom" }));
		const { tray } = setup(f);
		const header = tray.header(true);
		expect(header.caption?.p).toMatchObject({ role: "omp.tray.caption", text: "1 job in the background" });
		expect(children(header.counts).map(node => node.p)).toEqual([
			{ role: "omp.tray.count", status: "failed", text: "1 failed", tone: "error", wrap: "none" },
			{ role: "omp.tray.count", status: "running", text: "1 running", tone: "muted", wrap: "none" },
		]);
		expect(tray.header(false).caption).toBeUndefined();

		f.jobs.splice(1, 1);
		expect(tray.header(true).counts).toBeUndefined();
		f.jobs.push(job("bg_3"), job("bg_4"), job("bg_5"), job("bg_6"));
		expect(children(tray.header(true).counts).map(node => node.p && Reflect.get(node.p, "text"))).toEqual([
			"5 running",
		]);
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
		expect(tray.header(true)).toEqual({ caption: undefined, counts: undefined });
		expect(tray.focus()).toBe(false);
	});
});
