import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent, TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";

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

	test("errors for a subagent whose only running work is its parent's job on it", async () => {
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
		const waiting = new WaitTool(session(manager, "Child")).execute("child-wait", {});
		await expect(waiting).rejects.toThrow("Nothing to wait for");
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

	test("the real bus-wait consumer commits identity before its tool result is appended", async () => {
		const registry = AgentRegistry.global();
		const transcript = SessionManager.inMemory();
		registry.register({
			id: "Main", displayName: "Main", kind: "main",
			session: { sessionManager: transcript } as AgentSession,
		});
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "unfinished", async () => gate.promise, { ownerId: "Main" });
		try {
			const waiting = new WaitTool(session(manager)).execute("wait-identity", {});
			await IrcBus.global().send({ from: "Peer", to: "Main", body: "synthetic message" });
			const result = await waiting;
			const waited = result.details?.waited;
			if (!waited) throw new Error("Expected an IRC wait result");
			expect(result.content).toEqual([{ type: "text", text: `[${waited.id}] Peer: synthetic message` }]);
			expect(transcript.cloneCurrentSession({ persist: false }).hasReceivedIrcMessage(waited.from, waited.id)).toBe(true);
			expect(transcript.buildSessionContext().messages).toEqual([]);
			expect(manager.getJob(id)?.status).toBe("running");
		} finally {
			manager.cancel(id);
			gate.resolve("released");
		}
	});

	for (const transition of ["switch", "branch", "clear", "replacement"] as const) {
		test(`a wait refreshing services cannot consume the ${transition} inbox`, async () => {
			const registry = AgentRegistry.global();
			let transcript = SessionManager.inMemory();
			const root = transcript.appendMessage({ role: "user", content: "synthetic root", timestamp: 1 });
			const host: IrcBridgeHost = {
				agent: new Agent(),
				sessionManager: transcript,
				isDisposed: () => false,
				isStreaming: () => true,
				planModeEnabled: () => false,
				emitSessionEvent: async () => {},
				wakeForIrc: () => { throw new Error("Unexpected idle wake"); },
			};
			const bridge = new IrcBridge(host);
			const facade = {
				sessionManager: transcript,
				deliverIrcMessage: (message: IrcMessage) => bridge.deliver(message),
				drainPendingIrcInboxMessages: (agentId: string, opts?: { from?: string; limit?: number }) =>
					bridge.drainInboxMessages(agentId, opts),
			};
			registry.register({ id: "Main", displayName: "Main", kind: "main", session: facade as AgentSession });
			const refreshStarted = Promise.withResolvers<void>();
			const releaseRefresh = Promise.withResolvers<void>();
			const blocked = Promise.withResolvers<void>();
			const broker = {
				request: async () => {
					refreshStarted.resolve();
					await releaseRefresh.promise;
					return { op: "list", daemons: [] };
				},
				onCompletion: () => () => {},
			} as unknown as DaemonBrokerClient;
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const work = Promise.withResolvers<string>();
			const id = manager.register("bash", "unfinished", async () => work.promise, { ownerId: "Main" });
			const waiting = new WaitTool(session(manager, "Main", true)).execute(
				"old-wait", {}, undefined, () => blocked.resolve(),
			);
			try {
				await refreshStarted.promise;
				if (transition === "switch") await transcript.newSession();
				else if (transition === "branch") transcript.branch(root);
				else if (transition === "clear") transcript.appendResetBoundary();
				else {
					transcript = transcript.cloneCurrentSession({ persist: false });
					host.sessionManager = transcript;
					facade.sessionManager = transcript;
				}
				const incoming: IrcMessage = {
					id: "new-inbox", from: "Peer", to: "Main", body: "synthetic new inbox", ts: 42,
				};
				await bridge.deliver(incoming);
				releaseRefresh.resolve();
				const stillWaiting = await Promise.race([
					blocked.promise.then(() => true),
					waiting.then(() => false),
				]);
				expect(stillWaiting).toBe(true);
				await IrcBus.global().send({ from: "Peer", to: "Main", body: "synthetic later inbox" });
				work.resolve("synthetic old work completed");
				const result = await waiting;
				expect(result.details?.waited).toBeUndefined();
				expect(result.details?.jobs?.[0]).toMatchObject({ id, resultText: "synthetic old work completed" });
				expect(transcript.hasReceivedIrcMessage(incoming.from, incoming.id)).toBe(false);
				expect(bridge.drainInboxMessages("Main").map(message => message.body)).toEqual([
					"synthetic new inbox", "synthetic later inbox",
				]);
			} finally {
				releaseRefresh.resolve();
				work.resolve("released");
				manager.cancel(id);
				await waiting;
			}
		});
	}

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
});
