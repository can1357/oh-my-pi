import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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

	test("returns immediately when no job, running peer, or owned service can wake it", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Idle",
			displayName: "Idle",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const result = await new WaitTool(session()).execute("wait-2", {});
		expect(result.details).toMatchObject({ op: "wait", jobs: [] });
		expect(result.useless).toBe(true);
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

	test("blocks on a peer's completion job registered after the wait started", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("wait-peer-yield", {});
		// The peer's yield is accepted mid-turn: its completion job exists before the ref goes idle.
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		finalized.resolve("followup-done");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "followup-done" });
	});

	test("a message-only wait hands the turn back on a growing window while its parent streams", async () => {
		vi.useFakeTimers();
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
		registry.register({
			id: "Sibling",
			displayName: "Sibling",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const tool = new WaitTool(session(undefined, "Child"));
		const waitOut = async (ms: number) => {
			const waiting = tool.execute("message-window", {});
			vi.advanceTimersByTime(ms);
			const result = await waiting;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toStartWith(`No message within ${ms / 1000}.0s`);
			// Nobody is blocked on this agent's result, so no owner is singled out.
			expect(text).not.toContain("agent://Main");
			expect(result.useless).toBe(true);
		};
		await waitOut(5_000);
		await waitOut(10_000);
		await waitOut(30_000);
		// Stepping away from the wait loop restarts the ladder at its floor.
		vi.advanceTimersByTime(60_000);
		await waitOut(5_000);
	});

	test("an owned job that appears mid-wait is not cut off by the message window", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("message-then-job", {});
		vi.advanceTimersByTime(1_000);
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		await Promise.resolve();
		// Past the top message rung: only the job-wait cap may end this wait.
		vi.advanceTimersByTime(300_000);
		finalized.resolve("late result");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "late result" });
	});

	test("points a message-only wait at an owner blocked in wait on its result, not at a delivery watch", async () => {
		vi.useFakeTimers();
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
		const childWaitText = async () => {
			const waiting = new WaitTool(session(manager, "Child")).execute("child-wait", {});
			vi.advanceTimersByTime(5_000);
			const result = await waiting;
			return result.content[0]?.type === "text" ? result.content[0].text : "";
		};
		// A workpool watches each member turn to suppress auto-delivery while its owner keeps working.
		manager.watchJobs(["Child"]);
		expect(await childWaitText()).not.toContain("agent://Main");
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const text = await childWaitText();
		expect(text).toStartWith("No message within 5.0s");
		expect(text).toContain("agent://Main");
		childRun.resolve("migration API ready");
		expect((await parentWait).details?.jobs?.[0]).toMatchObject({ id: "Child", status: "completed" });
	});

	test("returns an incoming peer message without any background jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const waiting = new WaitTool(session()).execute("message-only", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "shared file released" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "shared file released" });
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
});
