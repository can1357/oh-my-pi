/**
 * Unified `hub` wait: one blocking primitive racing background jobs against
 * incoming peer messages. These contracts are new to the merge — the halves
 * (pure message wait, pure job poll) are covered by the pre-existing
 * messaging/job suites.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails } from "@oh-my-pi/pi-tui/tools/hub";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager | undefined, settings: Record<string, unknown> = {}): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key in settings) return settings[key];
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

/** Register a job that never settles on its own; returns its id + resolver. */
function registerHangingJob(manager: AsyncJobManager, label: string): { id: string; finish: (text: string) => void } {
	const { promise, resolve } = Promise.withResolvers<string>();
	const id = manager.register("bash", label, async () => promise, { ownerId: SELF_ID });
	return { id, finish: resolve };
}

describe("hub unified wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("an already-aborted job wait returns promptly without cancelling the worker", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "still running");
		const session = makeSession(manager);
		session.agentRegistry = undefined; // Exercise the job-only path, without a bus abort wakeup.
		const tool = new HubTool(session);
		const abort = new AbortController();
		abort.abort();
		let settled = false;
		const pending = tool.execute("already-aborted", { op: "wait" }, abort.signal).then(result => {
			settled = true;
			return result;
		});
		try {
			for (let turn = 0; turn < 20; turn++) await Promise.resolve();
			expect(settled).toBe(true);
			expect((await pending).details).toMatchObject({ jobs: [{ id: job.id, status: "running" }] });
			expect(manager.getJob(job.id)?.abortController.signal.aborted).toBe(false);
		} finally {
			manager.cancel(job.id);
			vi.advanceTimersByTime(60_000);
			await pending;
		}
	});

	test("back-to-back job waits climb the adaptive window without cancelling unfinished work", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "unfinished job");
		const tool = new HubTool(makeSession(manager));
		const waitFor = async (windowMs: number) => {
			let settled = false;
			const pending = tool.execute("deadline", { op: "wait" }).then(result => {
				settled = true;
				return result;
			});
			vi.advanceTimersByTime(windowMs - 1);
			for (let turn = 0; turn < 10; turn++) await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			return pending;
		};
		try {
			// First wait sits on the ladder floor; an immediate re-wait climbs a rung.
			const first = await waitFor(5_000);
			expect(first.useless).toBe(true);
			expect(first.details).toMatchObject({ op: "wait", jobs: [{ id: job.id, status: "running" }] });
			const second = await waitFor(10_000);
			expect(second.useless).toBe(true);
			expect(manager.getJob(job.id)?.status).toBe("running");
		} finally {
			manager.cancel(job.id);
		}
	});

	test("configured waits repeat the last interval and reset after a minute away", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "configured wait");
		const tool = new HubTool(makeSession(manager, { "async.waitBackoffMs": [20, 40] }));
		try {
			for (const interval of [20, 40, 40]) {
				let settled = false;
				const pending = tool.execute("configured", { op: "wait" }).then(result => {
					settled = true;
					return result;
				});
				vi.advanceTimersByTime(interval - 1);
				for (let turn = 0; turn < 10; turn++) await Promise.resolve();
				expect(settled).toBe(false);
				vi.advanceTimersByTime(1);
				expect((await pending).details).toMatchObject({ jobs: [{ id: job.id, status: "running" }] });
			}
			vi.advanceTimersByTime(60_000);
			const restarted = tool.execute("reset", { op: "wait" });
			vi.advanceTimersByTime(20);
			expect((await restarted).useless).toBe(true);
		} finally {
			manager.cancel(job.id);
		}
	});

	test.each([[], [0], [0.5], [Infinity], [2_147_483_648], ["20"], "20"].map(backoff => ({ backoff })))(
		"invalid wait backoff %j returns an actionable error",
		async ({ backoff }) => {
			const tool = new HubTool(makeSession(undefined, { "async.waitBackoffMs": backoff }));
			const result = await tool.execute("invalid", { op: "wait" });
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{ type: "text", text: expect.stringContaining("async.waitBackoffMs must be") },
			]);
		},
	);

	test("an incoming message settles the wait while watched jobs keep running", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "sleep forever");
		const tool = new HubTool(makeSession(manager));

		// The bus waiter is parked synchronously before execute()'s first
		// suspension, so the send below cannot race the park.
		const pending = tool.execute("call_1", { op: "wait" });
		await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "shared file is yours" });

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(result.isError).not.toBe(true);
		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("shared file is yours");
		// The job was not consumed by the message win.
		expect(manager.getJob(job.id)?.status).toBe("running");

		manager.cancel(job.id);
	});

	test("a settling job returns the snapshot exactly like the old poll", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "quick job");
		const tool = new HubTool(makeSession(manager));

		const pending = tool.execute("call_2", { op: "wait", ids: [job.id] });
		job.finish("done output");

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(details.op).toBe("wait");
		expect(details.jobs?.map(j => j.status)).toEqual(["completed"]);
		expect(details.jobs?.[0]?.resultText).toBe("done output");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("## Completed (1)");
	});

	test("bare wait with no jobs and no running peers returns immediately", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Sleeper", displayName: "task", kind: "sub", session: null, status: "idle" });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const tool = new HubTool(makeSession(manager));

		// A regression to a blocking message wait fails via the test timeout.
		const result = await tool.execute("call_3", { op: "wait" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No running background jobs to wait for.");
		expect(result.useless).toBe(true);
	});

	test("bare wait ignores a detached ref whose running status is stale", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({
			id: "Zombie",
			displayName: "stale task",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "running",
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		// Opening the message-wait gate would exceed the test deadline.
		const result = await new HubTool(makeSession(manager)).execute("call_4", { op: "wait" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("No running background jobs to wait for.");
		// The stale ref is reported (not silently dropped): it is the only handle
		// the caller has for clearing it with `hub cancel`.
		expect(text).toContain("Zombie");
		expect(text).toContain("no turn in flight");
	});

	test("bare wait returns a message already queued on the bus", async () => {
		const registry = AgentRegistry.global();
		// A recipient whose live hand-off throws is the only way a message
		// reaches the mailbox: `IrcBus.send` buffers solely from that catch.
		registry.register({
			id: SELF_ID,
			displayName: "main",
			kind: "main",
			session: {
				deliverIrcMessage: () => Promise.reject(new Error("session disposed")),
			},
		} as unknown as Parameters<AgentRegistry["register"]>[0]);
		// Idle peer: nothing is running, so the liveness gate would otherwise
		// short-circuit the wait before the mailbox is ever consulted.
		registry.register({ id: "Peer", displayName: "task", kind: "sub", session: null, status: "idle" });

		const firstReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "picked up the lock" });
		const secondReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "starting the edit" });
		expect(firstReceipt.outcome).toBe("failed");
		expect(secondReceipt.outcome).toBe("failed");
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(2);

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_5", { op: "wait" });
		const details = result.details as CoordinationDetails;

		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("picked up the lock");
		// Consumed exactly one message, not merely peeked or drained the backlog.
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(1);
		expect(
			IrcBus.global()
				.inbox(SELF_ID)
				.map(message => message.body),
		).toEqual(["starting the edit"]);
	});
});
