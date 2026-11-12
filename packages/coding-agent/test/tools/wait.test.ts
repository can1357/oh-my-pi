import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
	type Agent,
	type AgentMessage,
	type AgentToolResult,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { buildJobResult } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { USER_AWAIT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-awaits";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";

function session(manager?: AsyncJobManager, agentId = "Main", launch = false): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": launch }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

// Lets every pending continuation run, so the wait reaches its next block before the test acts.
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** Runs one wait that elapses with nothing new, asserting it blocks exactly `windowMs` under fake timers. */
async function elapse(tool: WaitTool, windowMs: number) {
	let settled = false;
	const waiting = tool.execute("idle-wait", {}).finally(() => {
		settled = true;
	});
	await flushMicrotasks();
	vi.advanceTimersByTime(windowMs - 1);
	await flushMicrotasks();
	expect(settled).toBe(false);
	vi.advanceTimersByTime(1);
	return waiting;
}

/** The progress reminder an elapsed wait appends after its own report, if any. */
function notice(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
	return result.content.slice(1).find(block => block.type === "text")?.text;
}

/** An elapsed wait's own report: the snapshot and its timeout line. */
function report(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
	return result.content.find(block => block.type === "text")?.text;
}

/** Whether `promise` is still pending once already-queued work has run. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	const mark = () => {
		settled = true;
	};
	void promise.then(mark, mark);
	const checked = Promise.withResolvers<void>();
	setImmediate(checked.resolve);
	await checked.promise;
	return !settled;
}

describe("wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a settling job is recovered once, suppressing its async duplicate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
	});

	// Fake timers freeze the settle window: a wait that ends without the clock advancing added no delay.
	test("jobs finishing moments apart are reported by one wait", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const a = Promise.withResolvers<string>();
		const b = Promise.withResolvers<string>();
		const first = manager.register("bash", "a", async () => a.promise, { ownerId: "Main" });
		const second = manager.register("bash", "b", async () => b.promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		a.resolve("a done");
		await flushMicrotasks();
		b.resolve("b done");
		const jobs = (await waiting).details?.jobs ?? [];
		expect(jobs.find(job => job.id === first)).toMatchObject({ status: "completed", resultText: "a done" });
		expect(jobs.find(job => job.id === second)).toMatchObject({ status: "completed", resultText: "b done" });
	});

	test("a job still running past the settle window does not hold the settled one back", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const slow = Promise.withResolvers<string>();
		const done = manager.register("bash", "a", async () => "a done", { ownerId: "Main" });
		const running = manager.register("bash", "b", async () => slow.promise, { ownerId: "Main" });
		let settled = false;
		const waiting = new WaitTool(session(manager)).execute("wait-1", {}).finally(() => {
			settled = true;
		});
		await flushMicrotasks();
		vi.advanceTimersByTime(1499);
		await flushMicrotasks();
		expect(settled).toBe(false);
		vi.advanceTimersByTime(1);
		const jobs = (await waiting).details?.jobs ?? [];
		slow.resolve("b done");
		expect(jobs.find(job => job.id === done)).toMatchObject({ status: "completed" });
		expect(jobs.find(job => job.id === running)).toMatchObject({ status: "running" });
	});

	test("a single job adds no settle delay", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const id = manager.register("bash", "a", async () => "a done", { ownerId: "Main" });
		const result = await new WaitTool(session(manager)).execute("wait-1", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed" });
	});

	test("back-to-back idle waits climb the ladder and, from the 10s rung on, send the agent back to work", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const build = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => build.promise, { ownerId: "Main" });
		const tool = new WaitTool(session(manager));
		const first = await elapse(tool, 5_000);
		expect(first.useless).toBe(true);
		expect(first.details?.jobs?.[0]).toMatchObject({ id, status: "running" });
		expect(notice(first)).toBeUndefined();
		expect(report(first)).toContain("within 5.0s");
		expect(report(first)).toContain("up to 10.0s");
		expect(notice(await elapse(tool, 10_000))).toContain("15.0s");
		expect(notice(await elapse(tool, 30_000))).toContain("45.0s");
		await elapse(tool, 60_000);
		await elapse(tool, 300_000);
		const capped = await elapse(tool, 300_000);
		expect(report(capped)).toContain("within 5m");
		expect(report(capped)).toContain("up to 5m");
		expect(notice(capped)).toContain("11m45s");
		build.resolve("done");
	});

	test("news or a minute away from wait restarts the ladder at the floor", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const build = Promise.withResolvers<string>();
		manager.register("bash", "build", async () => build.promise, { ownerId: "Main" });
		const tool = new WaitTool(session(manager));
		await elapse(tool, 5_000);
		vi.advanceTimersByTime(60_000);
		expect(notice(await elapse(tool, 5_000))).toBeUndefined();
		await elapse(tool, 10_000);
		const lint = Promise.withResolvers<string>();
		manager.register("bash", "lint", async () => lint.promise, { ownerId: "Main" });
		const woke = tool.execute("wait-news", {});
		await flushMicrotasks();
		lint.resolve("clean");
		await flushMicrotasks();
		vi.advanceTimersByTime(1_500);
		expect((await woke).useless).toBeUndefined();
		expect(notice(await elapse(tool, 5_000))).toBeUndefined();
		build.resolve("done");
	});

	test("labels a job that finished during the wait as delivered by it", async () => {
		// The job settles mid-wait, so this call is what hands the result over.
		// The old wording ("not auto-delivered; recovered by this snapshot") read
		// as a lost completion push and produced delivery-reliability reports
		// (#16052).
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-during", {});
		resolve("build complete");
		const result = await waiting;
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Delivery: delivered by this wait");
		expect(text).not.toContain("not auto-delivered");
	});

	test("reports a push this snapshot superseded instead of one still on the way", async () => {
		// The owner is mid-turn: the job settled before this call and its push is
		// parked on the yield queue. This wait is the result's consumer, so it
		// supersedes that push — the follow-up cannot arrive, and saying it is
		// "still on the way" would make the model expect a duplicate (#16135
		// review). A sink that never resolves pins the queued push.
		const parked = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		manager.registerDeliverySink("Main", () => parked.promise);
		const id = manager.register("bash", "queued", async () => "queued result", { ownerId: "Main" });
		await manager.getJob(id)?.promise;
		expect(manager.isDeliveryPending(id)).toBe(true);

		const result = await new WaitTool(session(manager)).execute("wait-pending", {});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Delivery: handed over by this snapshot");
		expect(text).toContain("superseded its queued completion push");
		expect(text).not.toContain("still on the way");
		expect(text).not.toContain("not auto-delivered");
		parked.resolve();
	});

	test("reports a watched job's in-flight push as superseded, not missed", async () => {
		// A push already in flight when `watchJobs` ran is still on the way:
		// watching suppresses new enqueue attempts, not a delivery already
		// queued or in flight. Treating it as lost mislabels the result this
		// snapshot hands over (#18635).
		const parked = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		manager.registerDeliverySink("Main", () => parked.promise);
		const id = manager.register("bash", "watched", async () => "watched result", { ownerId: "Main" });
		await manager.getJob(id)?.promise;
		expect(manager.isDeliveryPending(id)).toBe(true);

		manager.watchJobs([id]);
		expect(manager.isDeliveryPending(id)).toBe(true);

		const result = buildJobResult(session(manager), manager, "wait", [manager.getJob(id)!], [], [], {
			startedAtMs: Date.now(),
			settledAtEntry: new Set([id]),
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Delivery: handed over by this snapshot");
		expect(text).toContain("superseded its queued completion push");
		expect(text).not.toContain("not auto-delivered");
		parked.resolve();
	});

	test("keeps the missed-push wording, with the age, for a result that settled before the wait", async () => {
		// A genuinely late result: it settled before this call began with no push
		// on the way. The label must stay honest and say how long it had waited.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const id = manager.register("bash", "earlier", async () => "done earlier", { ownerId: "Main" });
		await manager.getJob(id)?.promise;
		const job = manager.getJob(id)!;
		job.endTime = Date.now() - 5_000;

		const result = await new WaitTool(session(manager)).execute("wait-late", {});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Delivery: not auto-delivered; recovered by this snapshot");
		expect(text).toMatch(/already finished \d+(ms|\.\ds) before this call/);
		expect(text).not.toContain("delivered by this wait");
	});

	test("finds nothing to wait for in a subagent whose only running work is its parent's job on it", async () => {
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true, hasIrcInterrupts: () => false } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		// Subagents share the process job manager with their owner.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		const result = await new WaitTool(session(manager, "Child")).execute("child-wait", {});
		expect(result.useless).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Nothing to wait for") });
		childRun.resolve("done");
	});

	test("an interrupted wait leaves later job completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("Operation aborted");
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("a message interrupt returns a non-error result and leaves the completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted-by-message", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Wait interrupted by message." }]);
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("returns a settled job whose delivery has not reached the transcript yet", async () => {
		const manager = new AsyncJobManager({});
		// The owner's sink parks the result like a yield-queue receipt awaiting injection.
		const injected = Promise.withResolvers<void>();
		const sinkEntered = Promise.withResolvers<string>();
		manager.registerDeliverySink("Main", async (_id, text) => {
			sinkEntered.resolve(text);
			await injected.promise;
		});
		const id = manager.register("task", "EchoPeer", async () => "received=kestrel42", {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		expect(await sinkEntered.promise).toBe("received=kestrel42");

		const result = await new WaitTool(session(manager)).execute("wait-undelivered", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "received=kestrel42" });
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		injected.resolve();
	});

	describe("a caller mid-turn", () => {
		/** `Main` streaming through a real IRC bridge, so what reaches it queues for its next step boundary. */
		function streamingMain(): IrcBridge {
			const bridge = new IrcBridge({
				agent: { steer: () => {} } as unknown as Agent,
				isDisposed: () => false,
				isStreaming: () => true,
				planModeEnabled: () => false,
				emitSessionEvent: async () => {},
				wakeForIrc: () => {},
			} as unknown as IrcBridgeHost);
			const registry = AgentRegistry.global();
			const session = {
				isStreaming: true,
				deliverIrcMessage: (msg: IrcMessage) => bridge.deliver(msg),
				hasIrcInterrupts: () => bridge.hasInterrupts(),
			};
			registry.register({
				id: "Main",
				displayName: "Main",
				kind: "main",
				status: "running",
				session: session as unknown as AgentSession,
			});
			for (const id of ["Peer", "Other"]) {
				registry.register({ id, displayName: id, kind: "sub", parentId: "Main", session: null });
			}
			return bridge;
		}

		const details = (records: AgentMessage[]) => records.map(record => (record as CustomMessage).details);

		test("a broadcast and a progress note leave a wait on its own job blocking, and inject after it", async () => {
			const bridge = streamingMain();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const build = Promise.withResolvers<string>();
			const id = manager.register("bash", "build", async () => build.promise, { ownerId: "Main" });
			const waiting = new WaitTool(session(manager)).execute("wait-chatter", {});
			await IrcBus.global().send({ from: "Peer", to: "Main", body: "editing auth.ts", broadcast: true });
			await IrcBus.global().send({ from: "Other", to: "Main", body: "halfway", progress: true });
			expect(await stillPending(waiting)).toBe(true);
			// Nor may they cut the interruptible wait short from the agent loop.
			expect(bridge.hasInterrupts()).toBe(false);
			build.resolve("built");
			const result = await waiting;
			expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "built" });
			// Both still reach the caller, as asides at its next step boundary.
			expect(details(bridge.drainPending())).toMatchObject([
				{ from: "Peer", message: "editing auth.ts", broadcast: true },
				{ from: "Other", message: "halfway", progress: true },
			]);
		});

		test("a direct message ends the wait and reaches the caller as a user turn after the chatter before it", async () => {
			const bridge = streamingMain();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const id = manager.register("bash", "build", async () => Promise.withResolvers<string>().promise, {
				ownerId: "Main",
			});
			const waiting = new WaitTool(session(manager)).execute("wait-direct", {});
			await IrcBus.global().send({ from: "Peer", to: "Main", body: "editing auth.ts", broadcast: true });
			await IrcBus.global().send({ from: "Other", to: "Main", body: "halfway", progress: true });
			await IrcBus.global().send({ from: "Peer", to: "Main", body: "auth.ts is yours" });
			const result = await waiting;
			expect(result.details).toMatchObject({ op: "wait", interrupted: true });
			expect(JSON.stringify(result.content)).not.toContain("auth.ts is yours");
			expect(details(bridge.drainPending())).toMatchObject([
				{ from: "Peer", message: "editing auth.ts", broadcast: true },
				{ from: "Other", message: "halfway", progress: true },
				{ from: "Peer", message: "auth.ts is yours" },
			]);
			expect(manager.getJob(id)?.status).toBe("running");
			manager.cancel(id);
		});

		test("returns at once for direct messages queued before the wait, leaving them to inject oldest first", async () => {
			const bridge = streamingMain();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const id = manager.register("bash", "build", async () => Promise.withResolvers<string>().promise, {
				ownerId: "Main",
			});
			for (const body of ["one", "two", "three"]) {
				await IrcBus.global().send({ from: body === "two" ? "Other" : "Peer", to: "Main", body });
			}
			const result = await new WaitTool(session(manager)).execute("wait-queued", {});
			expect(result.details).toMatchObject({ op: "wait", interrupted: true });
			expect(details(bridge.drainPending())).toMatchObject([
				{ from: "Peer", message: "one" },
				{ from: "Other", message: "two" },
				{ from: "Peer", message: "three" },
			]);
			manager.cancel(id);
		});

		test("does not return early for chatter alone queued before the wait", async () => {
			const bridge = streamingMain();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const build = Promise.withResolvers<string>();
			manager.register("bash", "build", async () => build.promise, { ownerId: "Main" });
			await IrcBus.global().send({ from: "Peer", to: "Main", body: "editing auth.ts", broadcast: true });
			const waiting = new WaitTool(session(manager)).execute("wait-chatter-queued", {});
			expect(await stillPending(waiting)).toBe(true);
			build.resolve("built");
			expect((await waiting).details?.jobs?.[0]).toMatchObject({ status: "completed" });
			expect(details(bridge.drainPending())).toMatchObject([{ from: "Peer", broadcast: true }]);
		});
	});

	test("a hung daemon broker does not fail the wait; the job result still arrives", async () => {
		const hungBroker = {
			request: async () => {
				throw new Error("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(hungBroker);
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager, "Main", true)).execute("wait-hung-broker", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
	});

	describe("an interrupt that aborts the service refresh", () => {
		beforeEach(() => {
			const broker = {
				request: async (_operation: unknown, signal?: AbortSignal) => {
					if (signal?.aborted) throw new Error("Daemon broker request aborted");
					return { op: "list", daemons: [] };
				},
				onCompletion: () => () => {},
			} as unknown as DaemonBrokerClient;
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
		});

		test("returns a settled job whose notice is still queued", async () => {
			const manager = new AsyncJobManager({});
			const injected = Promise.withResolvers<void>();
			const sinkEntered = Promise.withResolvers<void>();
			manager.registerDeliverySink("Main", async () => {
				sinkEntered.resolve();
				await injected.promise;
			});
			const id = manager.register("bash", "build", async () => "build complete", { ownerId: "Main" });
			await sinkEntered.promise;
			const controller = new AbortController();
			controller.abort(TOOL_INTERRUPT_ABORT_REASON);
			const result = await new WaitTool(session(manager, "Main", true)).execute(
				"interrupted-refresh-settled",
				{},
				controller.signal,
			);
			expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
			injected.resolve();
		});

		test("ends as an interrupted wait, as after the refresh, when only running jobs remain", async () => {
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const id = manager.register("bash", "still running", async () => Promise.withResolvers<string>().promise, {
				ownerId: "Main",
			});
			const controller = new AbortController();
			controller.abort(TOOL_INTERRUPT_ABORT_REASON);
			const result = await new WaitTool(session(manager, "Main", true)).execute(
				"interrupted-refresh-running",
				{},
				controller.signal,
			);
			expect(result.isError).toBeUndefined();
			expect(result.details).toMatchObject({ op: "wait", jobs: [], interrupted: true });
			expect(manager.getJob(id)?.status).toBe("running");
			manager.cancel(id);
		});

		test("reports nothing to wait for, as after the refresh, when the caller has no work", async () => {
			const controller = new AbortController();
			controller.abort(TOOL_INTERRUPT_ABORT_REASON);
			const result = await new WaitTool(session(new AsyncJobManager({}), "Main", true)).execute(
				"interrupted-refresh-idle",
				{},
				controller.signal,
			);
			// The interrupt is news for the model, so the loop guard must not skip this poll.
			expect(result.useless).toBeUndefined();
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Nothing to wait for") });
		});
	});

	describe("a reply wait", () => {
		/** A live session that records IRC deliveries and can end its turn on demand. */
		function liveSession() {
			const listeners = new Set<(state: "running" | "idle") => void>();
			const state = { isStreaming: true, runStartedAt: 0, holdsQuestion: false };
			const delivered: IrcMessage[] = [];
			const session = {
				get isStreaming() {
					return state.isStreaming;
				},
				get runStartedAt() {
					return state.runStartedAt;
				},
				deliverIrcMessage: async (msg: IrcMessage) => {
					delivered.push(msg);
					return "injected";
				},
				hasIrcInterrupts: () => false,
				waitForIrcReplies: async () => {},
				hasQueuedIrcFrom: () => state.holdsQuestion,
				subscribeRunState: (listener: (state: "running" | "idle") => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			return {
				session: session as unknown as AgentSession,
				state,
				delivered,
				endTurn: () => {
					state.isStreaming = false;
					for (const listener of listeners) listener("idle");
				},
			};
		}

		function registerParentAndChild() {
			const registry = AgentRegistry.global();
			const main = liveSession();
			const child = liveSession();
			registry.register({ id: "Main", displayName: "Main", kind: "main", session: main.session, status: "running" });
			registry.register({
				id: "Child",
				displayName: "Child",
				kind: "sub",
				parentId: "Main",
				session: child.session,
				status: "running",
			});
			return { registry, main, child };
		}

		function registerChildJob(manager: AsyncJobManager) {
			const run = Promise.withResolvers<string>();
			manager.register("task", "Child", async () => run.promise, { id: "Child", agentId: "Child", ownerId: "Main" });
			return run;
		}

		const ask = () => IrcBus.global().send({ from: "Child", to: "Main", body: "which codeword?" });
		const childWait = (manager = new AsyncJobManager({})) =>
			new WaitTool(session(manager, "Child")).execute("child-wait", {});
		/** What reached the caller's session once a message ended its wait; the wait's own result carries none. */
		const received = async (
			waiting: Promise<AgentToolResult<CoordinationDetails>>,
			caller: { delivered: IrcMessage[] },
		) => {
			expect((await waiting).details).toMatchObject({ op: "wait", interrupted: true });
			return caller.delivered;
		};
		/** Text of a wait that returned at once instead of blocking; never an error. */
		const idleText = async (
			waiting: Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>,
		) => {
			const result = await waiting;
			expect(result.isError).toBeUndefined();
			const [first] = result.content;
			return first?.type === "text" ? (first.text ?? "") : "";
		};

		test("blocks for the answer to a question the caller asked", async () => {
			const { child } = registerParentAndChild();
			await ask();
			const waiting = childWait();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([{ from: "Main", body: "heliotrope" }]);
			// The answer settled the question: nothing is owed any more.
			expect(await idleText(childWait())).toContain("no agent you messaged this run owes a reply");
		});

		test("blocks for a second question asked in the same millisecond its first was answered", async () => {
			const { child } = registerParentAndChild();
			vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			await ask();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			await IrcBus.global().send({ from: "Child", to: "Main", body: "and the second word?" });
			const waiting = childWait();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "vermilion" });
			expect(await received(waiting, child)).toMatchObject([
				{ from: "Main", body: "heliotrope" },
				{ from: "Main", body: "vermilion" },
			]);
		});

		test("ends once the agent asked starts waiting on the caller's result instead of answering", async () => {
			registerParentAndChild();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const childRun = registerChildJob(manager);
			await ask();
			const waiting = childWait(manager);
			const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
			const result = await waiting;
			expect(result.isError).toBeUndefined();
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("`Main` cannot reply before you finish"),
			});
			childRun.resolve("finished without the codeword");
			expect((await parentWait).details?.jobs?.[0]).toMatchObject({ id: "Child", status: "completed" });
		});

		test("keeps waiting while the agent asked waits on the caller or other work, whichever ends first", async () => {
			const { child } = registerParentAndChild();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const childRun = registerChildJob(manager);
			const build = Promise.withResolvers<string>();
			manager.register("bash", "build", async () => build.promise, { ownerId: "Main" });
			await ask();
			const waiting = childWait(manager);
			const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
			build.resolve("built");
			await parentWait;
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([{ from: "Main", body: "heliotrope" }]);
			childRun.resolve("done");
		});

		test("ends once the agent asked finishes its turn without replying", async () => {
			const { main } = registerParentAndChild();
			await ask();
			const waiting = childWait();
			main.endTurn();
			const result = await waiting;
			expect(result.isError).toBeUndefined();
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("`Main` finished its turn without replying"),
			});
		});

		test("keeps waiting when the agent asked ends its turn still holding the question for a turn of its own", async () => {
			const { main, child } = registerParentAndChild();
			await ask();
			const waiting = childWait();
			let settled = false;
			void waiting.then(() => {
				settled = true;
			});
			main.state.holdsQuestion = true;
			main.endTurn();
			// Let the turn-end re-check run (it waits on queued replies, a resolved promise here).
			const checked = Promise.withResolvers<void>();
			setImmediate(checked.resolve);
			await checked.promise;
			expect(settled).toBe(false);
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([{ from: "Main", body: "heliotrope" }]);
		});

		test("a progress note leaves the question owed, even once the agent asked goes idle", async () => {
			const { main, child } = registerParentAndChild();
			await ask();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "on it", progress: true });
			main.endTurn();
			const waiting = childWait();
			let settled = false;
			void waiting.then(() => {
				settled = true;
			});
			const checked = Promise.withResolvers<void>();
			setImmediate(checked.resolve);
			await checked.promise;
			expect(settled).toBe(false);
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([
				{ from: "Main", body: "on it", progress: true },
				{ from: "Main", body: "heliotrope" },
			]);
			expect(await idleText(childWait())).toContain("no agent you messaged this run owes a reply");
		});

		test("after a progress note, settling the job of the turn that sent it does not answer", async () => {
			registerParentAndChild();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "which codeword?" });
			await IrcBus.global().send({ from: "Child", to: "Main", body: "checking", progress: true });
			IrcBus.recordReply("Child", "Main");
			expect(IrcBus.global().unansweredSends("Main", 0)).toEqual([
				{ to: "Child", sentAt: expect.any(Number), promised: true },
			]);
		});

		test("a progress note asks nothing back", async () => {
			registerParentAndChild();
			await IrcBus.global().send({ from: "Child", to: "Main", body: "halfway", progress: true });
			expect(await idleText(childWait())).toContain("no agent you messaged this run owes a reply");
		});

		test("returns at once when the agent asked runs the caller inline and cannot see the question", async () => {
			const { registry } = registerParentAndChild();
			const release = registry.awaits.hold("Main", ["Child"], { interruptible: false });
			await ask();
			expect(await idleText(childWait())).toContain("`Main` cannot reply before you finish");
			release();
		});

		test("returns at once while the agent asked waits on the caller's eval handle with no timeout", async () => {
			registerParentAndChild();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const childRun = registerChildJob(manager);
			const parentSession = { asyncJobManager: manager, getAgentId: () => "Main" } as unknown as ToolSession;
			const handleWait = runEvalWait({ items: [{ kind: "agent", id: "Child" }] }, { session: parentSession });
			await ask();
			expect(await idleText(childWait(manager))).toContain("`Main` cannot reply before you finish");
			childRun.resolve("done");
			await handleWait;
		});

		test("keeps waiting while the agent asked runs a timed eval handle wait on the caller", async () => {
			const { child } = registerParentAndChild();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const childRun = registerChildJob(manager);
			const parentSession = { asyncJobManager: manager, getAgentId: () => "Main" } as unknown as ToolSession;
			const handleWait = runEvalWait(
				{ items: [{ kind: "agent", id: "Child" }], timeoutMs: 60_000 },
				{ session: parentSession },
			);
			await ask();
			const waiting = childWait(manager);
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([{ from: "Main", body: "heliotrope" }]);
			childRun.resolve("done");
			await handleWait;
		});

		test("a progress note from the agent asked keeps the wait blocking for its answer", async () => {
			const { child } = registerParentAndChild();
			await ask();
			const waiting = childWait();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "on it", progress: true });
			expect(await stillPending(waiting)).toBe(true);
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([
				{ from: "Main", body: "on it", progress: true },
				{ from: "Main", body: "heliotrope" },
			]);
		});

		test("a broadcast from the agent asked answers the wait", async () => {
			const { child } = registerParentAndChild();
			await ask();
			const waiting = childWait();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "codeword is heliotrope", broadcast: true });
			expect(await received(waiting, child)).toMatchObject([{ from: "Main", broadcast: true }]);
			expect(await idleText(childWait())).toContain("no agent you messaged this run owes a reply");
		});

		test("a broadcast from an agent not asked leaves the wait blocking", async () => {
			const { registry, child } = registerParentAndChild();
			registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
			await ask();
			const waiting = childWait();
			await IrcBus.global().send({ from: "Peer", to: "Child", body: "editing auth.ts", broadcast: true });
			expect(await stillPending(waiting)).toBe(true);
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([
				{ from: "Peer", broadcast: true },
				{ from: "Main", body: "heliotrope" },
			]);
		});

		test("a broadcast owes the caller no reply", async () => {
			registerParentAndChild();
			await IrcBus.global().send({ from: "Child", to: "Main", body: "status: halfway", broadcast: true });
			expect(await idleText(childWait())).toContain("Nothing to wait for");
		});

		test("a question from the caller's previous run owes no reply in the next", async () => {
			const { child } = registerParentAndChild();
			await ask();
			child.state.runStartedAt = Date.now() + 1;
			expect(await idleText(childWait())).toContain("no agent you messaged this run owes a reply");
		});

		test("hands the turn back at the ladder floor while the agent asked has not answered", async () => {
			registerParentAndChild();
			await ask();
			vi.useFakeTimers();
			const tool = new WaitTool(session(new AsyncJobManager({}), "Child"));
			expect(await idleText(elapse(tool, 5_000))).toContain("No reply within 5.0s");
			expect(notice(await elapse(tool, 10_000))).toContain("15.0s");
		});

		test("returns at once while the agent asked waits on the user, and blocks again once they answer", async () => {
			const { registry, child } = registerParentAndChild();
			await ask();
			const closeDialog = registry.awaits.hold("Main", [USER_AWAIT_ID], { interruptible: false });
			expect(await idleText(childWait())).toContain("`Main` is waiting on the user");
			closeDialog();
			const waiting = childWait();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			expect(await received(waiting, child)).toMatchObject([{ from: "Main", body: "heliotrope" }]);
		});

		test("ends once the agent asked opens a dialog that waits on the user", async () => {
			const { registry } = registerParentAndChild();
			await ask();
			const waiting = childWait();
			const closeDialog = registry.awaits.hold("Main", [USER_AWAIT_ID], { interruptible: false });
			expect(await idleText(waiting)).toContain("`Main` is waiting on the user");
			closeDialog();
		});
	});
});
