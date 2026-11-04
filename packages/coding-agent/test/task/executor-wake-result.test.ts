/**
 * What a parent receives from a wake turn it owns (its message woke the agent,
 * or its steer entered a turn a peer started) when the structured agent ends
 * the turn without `yield`: the missing-yield mark and warning on prose,
 * unchanged status, the relay body for failures, and the owner relay when no
 * wake job can carry the outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { createHarness } from "../helpers/subagent-session-harness";

const AGENT_ID = "woken-agent";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("parent-owned wake results", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("relays a parent-owned structured wake's thrown error without its stack", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;
		const thrown = new Error("turn exploded");
		thrown.stack = "Error: turn exploded\n    at secretFrame (/srv/internal/loop.ts:42:7)";

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "report your findings",
					display: false,
					details: { id: "msg-thrown", from: "Parent", message: "report your findings" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			await finish?.(thrown);

			const job = (await waiting).details?.jobs?.[0];
			expect(job?.status).toBe("failed");
			expect(job?.errorText).toContain("Wake turn failed: turn exploded.");
			expect(job?.errorText).toContain(`history://${AGENT_ID}`);
			expect(job?.errorText).not.toContain("secretFrame");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
	it.each([
		["without an output schema", undefined],
		["with an output schema", { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] }],
	] as const)("marks a parent-owned structured wake that replies without yield, %s", async (_label, outputSchema) => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: true, outputSchema });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;
		const warning = "SYSTEM WARNING: Structured subagent replied without calling yield.";

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "report your findings",
					display: false,
					details: { id: "msg-report", from: "Parent", message: "report your findings" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			harness.emitAssistantText("Everything verified; writing the report now.");
			await finish?.(undefined);

			// A follow-up answer warns; it does not fail the wake, schema or not.
			const job = (await waiting).details?.jobs?.[0];
			expect(job?.status).toBe("completed");
			expect(job?.resultText).toContain('status="completed"');
			expect(job?.resultText).toContain('missing-yield="wake"');
			expect(job?.resultText).toContain(`${warning}\n\nEverything verified; writing the report now.`);
			expect(job?.resultText).not.toContain("after 3 reminders");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
	it("relays a marked wake's warning to the owner when no wake job can be registered", async () => {
		const harness = createHarness();
		const registry = AgentRegistry.global();
		registry.register({
			id: "Parent",
			displayName: "Parent",
			kind: "main",
			session: createHarness().session,
			status: "running",
		});
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		const finish = observer([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "report your findings",
				display: false,
				details: { id: "msg-no-jobs", from: "Parent", message: "report your findings" },
				attribution: "agent",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		const reply = IrcBus.global().wait("Parent", { from: AGENT_ID }, 1000);
		harness.emitAssistantText("Everything verified; writing the report now.");
		await finish?.(undefined);

		const relayed = await reply;
		expect(relayed?.body).toContain('missing-yield="wake"');
		expect(relayed?.body).toContain(
			"SYSTEM WARNING: Structured subagent replied without calling yield.\n\nEverything verified; writing the report now.",
		);
	});
	it("relays a marked wake's warning to the owner even after an interim message", async () => {
		const harness = createHarness();
		const registry = AgentRegistry.global();
		registry.register({
			id: "Parent",
			displayName: "Parent",
			kind: "main",
			session: createHarness().session,
			status: "running",
		});
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const bus = IrcBus.global();
		const send = vi.spyOn(bus, "send");

		const finish = observer([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "report your findings",
				display: false,
				details: { id: "msg-interim", from: "Parent", message: "report your findings" },
				attribution: "agent",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		// An interim ping is not the answer; the parent must still get the marked report.
		const interim = bus.wait("Parent", { from: AGENT_ID }, 1000);
		const receipt = await bus.send({ from: AGENT_ID, to: "Parent", body: "On it.", progress: true });
		expect(receipt.outcome).not.toBe("failed");
		expect((await interim)?.body).toBe("On it.");
		harness.emitAssistantText("Everything verified; writing the report now.");
		await finish?.(undefined);

		const relays = send.mock.calls.map(([message]) => message).filter(message => message.wakeRelay);
		expect(relays).toHaveLength(1);
		expect(relays[0]?.to).toBe("Parent");
		expect(relays[0]?.body).toContain('missing-yield="wake"');
		expect(relays[0]?.body).toContain(
			"SYSTEM WARNING: Structured subagent replied without calling yield.\n\nEverything verified; writing the report now.",
		);
	});
	it.each(["", " \n "])("reports an empty structured owner wake as before, unmarked (%p)", async reply => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: true });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "report your findings",
					display: false,
					details: { id: "msg-empty", from: "Parent", message: "report your findings" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			harness.emitAssistantText(reply);
			await finish?.(undefined);

			const job = (await waiting).details?.jobs?.[0];
			expect(job?.status).toBe("completed");
			expect(job?.resultText).toContain("produced no output");
			expect(job?.resultText).toContain(`history://${AGENT_ID}`);
			expect(job?.resultText).not.toContain("missing-yield");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
	it.each([
		["Everything verified; writing the report now.", true],
		["", false],
		[" \n ", false],
	] as const)("marks a structured wake that a parent steer joins mid-turn (%p)", async (reply, marked) => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		const registry = AgentRegistry.global();
		registry.register({
			id: "OtherAgent",
			displayName: "OtherAgent",
			kind: "sub",
			session: createHarness().session,
			status: "running",
		});
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: true });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: registry,
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;

		try {
			// A peer starts the turn; the parent's queued request enters it afterwards.
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "is line 42 fine?",
					display: false,
					details: { id: "msg-peer", from: "OtherAgent", message: "is line 42 fine?" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitParentSteer("report your findings");
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			harness.emitAssistantText(reply);
			await finish?.(undefined);

			const job = (await waiting).details?.jobs?.[0];
			expect(job?.status).toBe("completed");
			if (marked) {
				expect(job?.resultText).toContain('missing-yield="wake"');
				expect(job?.resultText).toContain("SYSTEM WARNING: Structured subagent replied without calling yield.");
				expect(job?.resultText).toContain(reply);
			} else {
				expect(job?.resultText).toContain("produced no output");
				expect(job?.resultText).not.toContain("missing-yield");
			}
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
	it("delivers only a parent-owned structured wake's final report, with its warning", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, structured: true });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "report your findings",
					display: false,
					details: { id: "msg-narration", from: "Parent", message: "report your findings" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			harness.emitAssistantContent([
				{ type: "text", text: "Checking." },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } },
			]);
			harness.emitAssistantText("Answer.");
			harness.emitAgentEnd();
			await finish?.(undefined);

			const job = (await waiting).details?.jobs?.[0];
			expect(job?.status).toBe("completed");
			expect(job?.resultText).toContain('missing-yield="wake"');
			expect(job?.resultText).toContain(
				"SYSTEM WARNING: Structured subagent replied without calling yield.\n\nAnswer.",
			);
			expect(job?.resultText).not.toContain("Checking.");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
