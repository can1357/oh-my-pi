import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import * as servicesModule from "@oh-my-pi/pi-coding-agent/launch/services";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

function session(manager?: AsyncJobManager, agentId = "Main", launch = false): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": launch }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
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

	test("finds nothing to wait for in a subagent whose only running work is its parent's job on it", async () => {
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
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

	test("returns an incoming peer message while the watched job remains live", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise } = Promise.withResolvers<string>();
		const id = manager.register("bash", "unfinished", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-3", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "the file is yours" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the file is yours" });
		expect(manager.getJob(id)?.status).toBe("running");
		manager.cancel(id);
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

		test("returns a peer message that arrived and interrupted during the refresh", async () => {
			// Main's session inbox receives the message while the refresh is in flight.
			const inbox: IrcMessage[] = [];
			AgentRegistry.global().register({
				id: "Main",
				displayName: "Main",
				kind: "main",
				session: { drainPendingIrcInboxMessages: () => inbox.splice(0, 1) } as unknown as AgentSession,
			});
			const controller = new AbortController();
			const broker = {
				request: async () => {
					inbox.push({ id: "m1", ts: 0, from: "Peer", to: "Main", body: "the file is yours" });
					controller.abort(TOOL_INTERRUPT_ABORT_REASON);
					throw new Error("Daemon broker request aborted");
				},
				onCompletion: () => () => {},
			} as unknown as DaemonBrokerClient;
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const id = manager.register("bash", "unfinished", async () => Promise.withResolvers<string>().promise, {
				ownerId: "Main",
			});
			const result = await new WaitTool(session(manager, "Main", true)).execute(
				"interrupted-refresh-message",
				{},
				controller.signal,
			);
			expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the file is yours" });
			manager.cancel(id);
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
		/** A live session that takes IRC deliveries and can end its turn on demand. */
		function liveSession() {
			const listeners = new Set<(event: { type: string }) => void>();
			const state = { isStreaming: true, runStartedAt: 0, holdsQuestion: false };
			const session = {
				get isStreaming() {
					return state.isStreaming;
				},
				get runStartedAt() {
					return state.runStartedAt;
				},
				deliverIrcMessage: async () => "injected",
				waitForIrcReplies: async () => {},
				hasQueuedIrcFrom: () => state.holdsQuestion,
				subscribe: (listener: (event: { type: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			return {
				session: session as unknown as AgentSession,
				state,
				endTurn: () => {
					state.isStreaming = false;
					for (const listener of listeners) listener({ type: "agent_end" });
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
			registerParentAndChild();
			await ask();
			const waiting = childWait();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			const result = await waiting;
			expect(result.isError).toBeUndefined();
			expect(result.details?.waited).toMatchObject({ from: "Main", body: "heliotrope" });
			// The answer settled the question: nothing is owed any more.
			expect(await idleText(childWait())).toContain("no agent you messaged this run owes a reply");
		});

		test("blocks for a second question asked in the same millisecond its first was answered", async () => {
			registerParentAndChild();
			vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			await ask();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "heliotrope" });
			await IrcBus.global().send({ from: "Child", to: "Main", body: "and the second word?" });
			const waiting = childWait();
			await IrcBus.global().send({ from: "Main", to: "Child", body: "vermilion" });
			const result = await waiting;
			expect(result.isError).toBeUndefined();
			expect(result.details?.waited).toMatchObject({ from: "Main", body: "vermilion" });
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
			registerParentAndChild();
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
			expect((await waiting).details?.waited).toMatchObject({ from: "Main", body: "heliotrope" });
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
			const { main } = registerParentAndChild();
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
			expect((await waiting).details?.waited).toMatchObject({ from: "Main", body: "heliotrope" });
		});

		test("a progress note leaves the question owed, even once the agent asked goes idle", async () => {
			const { main } = registerParentAndChild();
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
			expect((await waiting).details?.waited).toMatchObject({ from: "Main", body: "heliotrope" });
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
			registerParentAndChild();
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
			expect((await waiting).details?.waited).toMatchObject({ from: "Main", body: "heliotrope" });
			childRun.resolve("done");
			await handleWait;
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
	});

	describe("with a timeout and nothing owed", () => {
		// Callers waiting for another session's message used to start a dummy
		// `sleep` job to hold `wait` open, because with nothing owed it returned
		// at once. A `timeout` now idles the wait itself.
		function registerMain(): void {
			AgentRegistry.global().register({
				id: "Main",
				displayName: "Main",
				kind: "main",
				session: { isStreaming: true } as never,
				status: "running",
			});
		}

		test("idles until a message arrives and returns it", async () => {
			registerMain();
			const waiting = new WaitTool(session()).execute("idle-message", { timeout: 600 });
			await Promise.resolve();
			await IrcBus.global().send({ from: "Peer", to: "Main", body: "the schema changed" });
			const result = await waiting;
			expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the schema changed" });
		});

		test("ends on a steer or aside interrupt like any wait", async () => {
			registerMain();
			const interrupt = new AbortController();
			const waiting = new WaitTool(session()).execute("idle-interrupt", { timeout: 600 }, interrupt.signal);
			await Promise.resolve();
			interrupt.abort(TOOL_INTERRUPT_ABORT_REASON);
			const result = await waiting;
			expect(result.details).toMatchObject({ interrupted: true });
			expect(result.useless).toBeUndefined();
		});

		test("returns at the deadline as an idle poll when nothing arrives", async () => {
			registerMain();
			vi.useFakeTimers();
			const waiting = new WaitTool(session()).execute("idle-deadline", { timeout: 5 });
			await Promise.resolve();
			vi.advanceTimersByTime(5_000);
			const result = await waiting;
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Deadline reached") });
			expect(result.useless).toBe(true);
		});

		test("still returns at once without a timeout", async () => {
			registerMain();
			const result = await new WaitTool(session()).execute("no-timeout", {});
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Nothing to wait for") });
			expect(result.useless).toBe(true);
		});

		describe("in a subagent", () => {
			// An idle wait ends only on a message. An agent blocked on the caller's
			// result cannot send one, so the caller must finish instead of idling.
			function registerChild(manager: AsyncJobManager) {
				registerMain();
				AgentRegistry.global().register({
					id: "Child",
					displayName: "Child",
					kind: "sub",
					parentId: "Main",
					session: { isStreaming: true } as never,
					status: "running",
				});
				const run = Promise.withResolvers<string>();
				manager.register("task", "Child", async () => run.promise, {
					id: "Child",
					agentId: "Child",
					ownerId: "Main",
				});
				return run;
			}

			test("returns at once while its parent waits on its result", async () => {
				vi.useFakeTimers();
				const manager = new AsyncJobManager({ onJobComplete: () => {} });
				const childRun = registerChild(manager);
				const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
				const childWait = new WaitTool(session(manager, "Child")).execute("child-idle", { timeout: 600 });
				// Past the child's deadline but inside the parent's 30-minute cap:
				// an idling child would end here on "Deadline reached" instead.
				vi.advanceTimersByTime(600_000);
				const result = await childWait;
				childRun.resolve("done");
				await parentWait;
				expect(result.content[0]).toMatchObject({
					text: expect.stringContaining("Nothing to wait for: `Main` is waiting on your result"),
				});
			});

			test("stops idling once its parent starts waiting on its result", async () => {
				vi.useFakeTimers();
				const manager = new AsyncJobManager({ onJobComplete: () => {} });
				const childRun = registerChild(manager);
				const childWait = new WaitTool(session(manager, "Child")).execute("child-idle", { timeout: 600 });
				await Promise.resolve();
				const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
				vi.advanceTimersByTime(600_000);
				const result = await childWait;
				childRun.resolve("done");
				await parentWait;
				expect(result.content[0]).toMatchObject({
					text: expect.stringContaining("Nothing to wait for: `Main` is waiting on your result"),
				});
				// A parent that started blocking is news, not an idle poll.
				expect(result.useless).toBeUndefined();
			});

			test("idles until a message while its parent works on without waiting on it", async () => {
				const manager = new AsyncJobManager({ onJobComplete: () => {} });
				const childRun = registerChild(manager);
				const childWait = new WaitTool(session(manager, "Child")).execute("child-idle", { timeout: 600 });
				await Promise.resolve();
				await IrcBus.global().send({ from: "Main", to: "Child", body: "the schema changed" });
				const result = await childWait;
				childRun.resolve("done");
				expect(result.details?.waited).toMatchObject({ from: "Main", body: "the schema changed" });
			});
		});

		test("caps a job wait at the timeout instead of the 30-minute safety cap", async () => {
			registerMain();
			vi.useFakeTimers();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const job = Promise.withResolvers<string>();
			manager.register("bash", "build", async () => job.promise, { ownerId: "Main" });
			const waiting = new WaitTool(session(manager)).execute("job-timeout", { timeout: 5 });
			await Promise.resolve();
			vi.advanceTimersByTime(5_000);
			const result = await waiting;
			expect(result.details?.jobs?.[0]).toMatchObject({ status: "running" });
			job.resolve("done");
			await manager.dispose({ timeoutMs: 1000 });
		});

		for (const cooperative of [true, false]) {
			test(`bounds the whole call, a slow service refresh included (${cooperative ? "observes" : "ignores"} abort)`, async () => {
				// The deadline is the caller's: a broker that answers slowly must
				// not stretch a 1 s wait to its own request timeout, whether or not
				// the slow step (client creation, connection setup) observes the
				// signal. Real time here: the refresh's deadline is an
				// AbortSignal.timeout, which fake timers do not drive.
				registerMain();
				const release = Promise.withResolvers<never>();
				vi.spyOn(servicesModule, "listServicesTolerant").mockImplementation(async (_session, signal) => {
					if (cooperative) {
						if (signal?.aborted) release.reject(signal.reason);
						else signal?.addEventListener("abort", () => release.reject(signal.reason), { once: true });
					}
					return release.promise;
				});
				const started = Date.now();
				const result = await new WaitTool(session(undefined, "Main", true)).execute("slow-refresh", {
					timeout: 1,
				});
				expect(Date.now() - started).toBeLessThan(10_000);
				expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Deadline reached") });
				release.reject(new Error("broker gave up"));
			});
		}

		test("a refresh the deadline abandoned does not subscribe the session once its broker client arrives", async () => {
			// Client creation does not observe the signal, so the deadline can win
			// while it is pending, and the caller may dispose the session after the
			// call returns. The late refresh must not register a completion sink
			// for it with the process-shared broker client. Real time here: the
			// refresh's deadline is an AbortSignal.timeout, which fake timers do
			// not drive.
			registerMain();
			const client = Promise.withResolvers<DaemonBrokerClient>();
			vi.spyOn(daemonClient, "daemonClientForProject").mockReturnValue(client.promise);
			const listServicesTolerant = servicesModule.listServicesTolerant;
			let abandoned: Promise<unknown> | undefined;
			vi.spyOn(servicesModule, "listServicesTolerant").mockImplementation((refreshed, signal) => {
				const refresh = listServicesTolerant(refreshed, signal);
				abandoned = refresh;
				return refresh;
			});
			const subscribed: string[] = [];
			const broker = {
				request: async (_operation: unknown, signal?: AbortSignal) => {
					if (signal?.aborted) throw new Error("Daemon broker request aborted");
					return { op: "list", daemons: [] };
				},
				onCompletion: (owner: string) => {
					subscribed.push(owner);
					return () => {};
				},
			} as unknown as DaemonBrokerClient;
			const disposeCallbacks: Array<() => void> = [];
			const caller = {
				...session(undefined, "Main", true),
				registerDisposeCallback: (callback: () => void) => disposeCallbacks.push(callback),
			} as unknown as ToolSession;
			const result = await new WaitTool(caller).execute("abandoned-refresh", { timeout: 1 });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Deadline reached") });
			// The caller disposes the session; then client creation completes.
			for (const callback of disposeCallbacks.splice(0)) callback();
			client.resolve(broker);
			await abandoned?.catch(() => undefined);
			expect(subscribed).toEqual([]);
			expect(disposeCallbacks).toEqual([]);
		});
	});
});
