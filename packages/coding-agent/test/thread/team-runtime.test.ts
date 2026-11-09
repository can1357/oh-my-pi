import { beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { IrcBus } from "../../src/irc/bus";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { TeamRuntime } from "../../src/task/team-runtime";
import type { TeamDefinition } from "../../src/task/teams";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { teamThreadService } from "../../src/thread/services/team";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import { teamRuntime } from "../../src/task/team-runtime";
import type { TeamProbe, TeamProbeGlobals } from "../fixtures/team-runtime-worker";

const team: TeamDefinition = {
	name: "audit",
	description: "audit",
	members: [],
	body: "",
	source: "project",
	filePath: "audit.md",
	tasks: ["Inspect"],
};
const session = () => ({}) as AgentSessionHandle;

beforeEach(() => {
	teamRuntime.resetForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("team idle notifications", () => {
	it.each(["yield", "handback"])("includes bounded %s arguments in tool-only idle notices", async tool => {
		const registry = AgentRegistry.global();
		const notices: string[] = [];
		const delivered = Promise.withResolvers<void>();
		const lead = {
			deliverIrcMessage: async (message: { body: string }) => {
				notices.push(message.body);
				delivered.resolve();
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		const child = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "terminal",
							name: tool,
							arguments: { data: { summary: `Finished inspection ${"x".repeat(600)}` } },
						},
					],
				},
			],
		} as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "sub", session: lead, status: "idle" });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		started.members.set("worker", { id: "worker", ref });
		registry.setStatus("worker", "idle", ref);
		await delivered.promise;
		expect(notices[0]).toContain("Finished inspection");
		expect(notices[0]!.length).toBeLessThan(550);
		expect(notices[0]).toEndWith("agent://worker");
		await runtime.stop(lead, "audit");
	});

	it.each([undefined, " \n\t "])(
		"omits the empty summary line for an absent or whitespace excerpt (%s)",
		async text => {
			const registry = AgentRegistry.global();
			const notices: string[] = [];
			const delivered = Promise.withResolvers<void>();
			const lead = {
				deliverIrcMessage: async (message: { body: string }) => {
					notices.push(message.body);
					delivered.resolve();
					return "injected";
				},
			} as unknown as AgentSessionHandle;
			registry.register({ id: "lead", displayName: "lead", kind: "sub", session: lead, status: "idle" });
			const child = {
				messages: text === undefined ? [] : [{ role: "assistant", content: [{ type: "text", text }] }],
			} as unknown as AgentSessionHandle;
			const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
			const runtime = new TeamRuntime();
			const started = await runtime.start(lead, team);
			started.members.set("worker", { id: "worker", ref });
			registry.setStatus("worker", "idle", ref);
			await delivered.promise;
			expect(notices[0]).toBe("worker is idle.\nagent://worker");
			await runtime.stop(lead, "audit");
		},
	);

	it("notifies the actual lead once per completed running turn and ignores replaced members", async () => {
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const received: Array<{ from: string; body: string; progress?: boolean }> = [];
		const lead = {
			deliverIrcMessage: async (message: { from: string; body: string; progress?: boolean }) => {
				received.push(message);
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "sub", session: lead, status: "idle" });
		const child = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: `First line\nSecond line\n${"x".repeat(600)}\nFourth line` }],
				},
			],
		} as unknown as AgentSessionHandle;
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		started.members.set("worker", { id: "worker", ref: { ...ref } });
		registry.setStatus("worker", "idle", ref);
		await Bun.sleep(0);
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ from: "worker", progress: true });
		expect(received[0]!.body).toContain("worker");
		expect(received[0]!.body).toContain("First line");
		expect(received[0]!.body).toContain("agent://worker");
		expect(received[0]!.body).not.toContain("Fourth line");
		expect(received[0]!.body.length).toBeLessThan(550);
		registry.setStatus("worker", "idle", ref);
		await Bun.sleep(0);
		expect(received).toHaveLength(1);
		registry.setStatus("worker", "running", ref);
		registry.setStatus("worker", "idle", ref);
		await Bun.sleep(0);
		expect(received).toHaveLength(2);
		const replacement = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		registry.setStatus("worker", "idle", replacement);
		await Bun.sleep(0);
		expect(received).toHaveLength(2);
		await runtime.stop(lead, "audit");
		registry.setStatus("worker", "running", replacement);
		registry.setStatus("worker", "idle", replacement);
		await Bun.sleep(0);
		expect(received).toHaveLength(2);
	});
	it("notifies when a reserved member completes before its ref is recorded", async () => {
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const received: string[] = [];
		const lead = {
			deliverIrcMessage: async (message: { body: string }) => {
				received.push(message.body);
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "sub", session: lead, status: "idle" });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		started.members.set("worker", { id: "worker" });
		const worker = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
		} as unknown as AgentSessionHandle;
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: worker });
		registry.setStatus("worker", "idle", ref);
		await Bun.sleep(0);
		expect(received).toHaveLength(1);
		expect(received[0]).toContain("Done");
		await runtime.stop(lead, "audit");
	});
});

describe("team cooperative stop", () => {
	it("accepts only the targeted member's acknowledgement and tombstones that member once", async () => {
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const lead = { deliverIrcMessage: async () => "injected" } as unknown as AgentSessionHandle;
		const messages: string[] = [];
		let disposed = 0;
		const child = {
			deliverIrcMessage: async (message: { body: string }) => {
				messages.push(message.body);
				return "injected";
			},
			dispose: async () => {
				disposed++;
			},
		} as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "reservation", ref };
		started.members.set("worker", entry);
		await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, 120000);
		expect(
			await runtime.requestStop(
				lead,
				"audit",
				started.generation,
				"worker",
				{ ...entry, ref: { ...ref, id: "other" } },
				true,
				120000,
			),
		).toBe("member changed");
		expect(disposed).toBe(0);
		const requestId = messages[0]!.match(/team:\/\/audit\/stop\/([^\s]+)/)![1]!;
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		await expect(runtime.respondStop(session(), identity, requestId, "ack")).rejects.toThrow();
		await expect(runtime.respondStop(child, identity, requestId, "invalid")).rejects.toThrow();
		await runtime.respondStop(child, identity, requestId, "ack");
		expect(disposed).toBe(1);
		expect(registry.get("worker")?.status).toBe("aborted");
		expect(started.members.has("worker")).toBe(false);
		expect(runtime.listTeams(lead)).toEqual(["audit"]);
		expect(runtime.identity(lead, "audit")?.generation).toBe(started.generation);
		await expect(runtime.respondStop(child, identity, requestId, "ack")).rejects.toThrow();
		await runtime.stop(lead, "audit");
	});

	it.each([false, true])("retains membership when release is refused (force=%s)", async force => {
		const registry = AgentRegistry.global();
		const lead = session();
		const child = { deliverIrcMessage: async () => "injected" } as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "reservation", ref: { ...ref } };
		started.members.set("worker", entry);
		const release = vi.spyOn(AgentLifecycleManager.global(), "release").mockResolvedValue(false);
		vi.useFakeTimers();
		try {
			const result = await runtime.requestStop(lead, "audit", started.generation, "worker", entry, force, 120000);
			if (force) expect(result).toBe("release refused");
			else {
				const requestId = result.match(/requested \(([^)]+)\)/)![1]!;
				await expect(
					runtime.respondStop(
						child,
						{ team: "audit", generation: started.generation, memberId: "worker" },
						requestId,
						"ack",
					),
				).rejects.toThrow("Stop release refused");
			}
			expect(started.members.get("worker")?.ref?.generation).toBe(ref.generation);
			expect(registry.get("worker")?.session).toBe(child);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.mockRestore();
			await runtime.stop(lead, "audit");
			vi.useRealTimers();
		}
	});

	it("notifies the lead on decline and timeout without releasing the member", async () => {
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const notices: Array<{ from: string; body: string; progress?: boolean }> = [];
		const requests: string[] = [];
		const lead = {
			deliverIrcMessage: async (message: { from: string; body: string; progress?: boolean }) => {
				notices.push(message);
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		const child = {
			deliverIrcMessage: async (message: { body: string }) => {
				requests.push(message.body);
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		IrcBus.installGlobal(new IrcBus(registry, undefined, { settings: Settings.isolated() }));
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "reservation", ref };
		started.members.set("worker", entry);
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, 120000);
		const first = requests[0]!.match(/team:\/\/audit\/stop\/([^\s]+)/)![1]!;
		await runtime.respondStop(child, identity, first, "decline: busy");
		expect(notices.find(message => message.body.includes("busy"))).toMatchObject({ from: "worker", progress: true });
		expect(notices[0]!.body).toContain(first);
		vi.useFakeTimers();
		try {
			await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, 1000);
			vi.advanceTimersByTime(1000);
			await Promise.resolve();
			const third = await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, 1000);
			const thirdId = third.match(/requested \(([^)]+)\)/)![1]!;
			vi.advanceTimersByTime(1000);
			await Promise.resolve();
			expect(notices.filter(message => message.body.includes("timed out"))).toHaveLength(2);
			expect(notices.at(-1)!.body).toContain(thirdId);
		} finally {
			vi.useRealTimers();
		}
		expect(notices.filter(message => message.body.includes("timed out"))).toEqual([
			expect.objectContaining({ from: "worker", progress: true }),
			expect.objectContaining({ from: "worker", progress: true }),
		]);
		const second = requests[1]!.match(/team:\/\/audit\/stop\/([^\s]+)/)![1]!;
		expect(notices.find(message => message.body.includes("timed out"))!.body).toContain(second);
		await expect(runtime.respondStop(child, identity, second, "ack")).rejects.toThrow();
		expect(registry.get("worker")?.session).toBe(child);
		expect(started.members.has("worker")).toBe(true);
		await runtime.stop(lead, "audit");
	});

	it.each(["decline", "timeout"])("keeps a later handle-only stop from inheriting a whole-team %s", async outcome => {
		const registry = AgentRegistry.global();
		const lead = { deliverIrcMessage: async () => "injected" } as unknown as AgentSessionHandle;
		const child = {
			deliverIrcMessage: async () => "injected",
			dispose: async () => {},
		} as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "registered", ref };
		started.members.set("worker", entry);
		vi.useFakeTimers();
		try {
			const result = await runtime.requestStop(
				lead,
				"audit",
				started.generation,
				"worker",
				entry,
				false,
				1000,
				true,
			);
			const requestId = result.match(/requested \(([^)]+)\)/)![1]!;
			if (outcome === "decline") {
				await runtime.respondStop(
					child,
					{ team: "audit", generation: started.generation, memberId: "worker" },
					requestId,
					"decline: busy",
				);
			} else {
				vi.advanceTimersByTime(1000);
			}
			expect(await runtime.requestStop(lead, "audit", started.generation, "worker", entry, true, 1000)).toBe(
				"released",
			);
			expect(started.members.size).toBe(0);
			expect(runtime.listTeams(lead)).toEqual(["audit"]);
			expect((await runtime.start(lead, team)).generation).toBe(started.generation);
		} finally {
			await runtime.stop(lead, "audit");
			vi.useRealTimers();
		}
	});

	it("applies pending force only to the matching reservation and generation", async () => {
		const registry = AgentRegistry.global();
		const lead = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "original" };
		started.members.set("worker", entry);
		await runtime.requestStop(lead, "audit", started.generation, "worker", entry, true, 120000);
		let disposed = 0;
		const child = {
			dispose: async () => {
				disposed++;
			},
		} as unknown as AgentSessionHandle;
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		expect(await runtime.resolvePendingStop(lead, "audit", started.generation, "worker", entry, ref)).toBe(true);
		expect(disposed).toBe(1);
		expect(registry.get("worker")?.status).toBe("aborted");
		expect(started.members.has("worker")).toBe(false);
		await runtime.stop(lead, "audit");
		const restarted = await runtime.start(lead, team);
		const replacement = { id: "worker", reservation: "replacement" };
		restarted.members.set("worker", replacement);
		expect(await runtime.resolvePendingStop(lead, "audit", started.generation, "worker", entry, ref)).toBe(false);
		expect(restarted.members.has("worker")).toBe(true);
		await runtime.stop(lead, "audit");
	});

	it("sends a pending cooperative request only after the reserved member registers", async () => {
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const lead = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "original" };
		started.members.set("worker", entry);
		await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, 120000);
		const messages: string[] = [];
		const child = {
			deliverIrcMessage: async (message: { body: string }) => {
				messages.push(message.body);
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		expect(await runtime.resolvePendingStop(lead, "audit", started.generation, "worker", entry, ref)).toBe(true);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("team://audit/stop/");
		expect(registry.get("worker")?.session).toBe(child);
		await runtime.stop(lead, "audit");
	});

	it("rejects registration for a replaced ref and reports a pending registration failure", async () => {
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const notices: string[] = [];
		const lead = {
			deliverIrcMessage: async (message: { body: string }) => {
				notices.push(message.body);
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "original" };
		started.members.set("worker", entry);
		await runtime.requestStop(lead, "audit", started.generation, "worker", entry, true, 120000);
		registry.register({ id: "worker", displayName: "worker", kind: "sub", session: session() });
		const replacement = registry.register({
			id: "worker",
			displayName: "replacement",
			kind: "sub",
			session: session(),
		});
		expect(await runtime.resolvePendingStop(lead, "audit", started.generation, "worker", entry, replacement)).toBe(
			false,
		);
		expect(registry.get("worker")?.status).not.toBe("aborted");
		expect(
			await runtime.resolvePendingStop(
				lead,
				"audit",
				started.generation,
				"worker",
				entry,
				undefined,
				"spawn failed",
			),
		).toBe(true);
		expect(notices.some(message => message.includes("spawn failed"))).toBe(true);
		await runtime.stop(lead, "audit");
	});
	it("does not mark a registered member failed after a late registration rejection", async () => {
		const registry = AgentRegistry.global();
		const lead = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: session() });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "registered", ref };
		started.members.set("worker", entry);
		expect(
			await runtime.resolvePendingStop(
				lead,
				"audit",
				started.generation,
				"worker",
				entry,
				undefined,
				"late failure",
			),
		).toBe(false);
		expect(started.members.get("worker")?.failure).toBeUndefined();
		expect(started.members.get("worker")?.ref).toBe(ref);
		await runtime.stop(lead, "audit");
	});

	it.each([false, true])("does not release twice while release is in flight (aborted=%s)", async aborted => {
		const registry = AgentRegistry.global();
		const lead = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: session() });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "registered", ref };
		started.members.set("worker", entry);
		const completion = Promise.withResolvers<boolean>();
		const release = vi.spyOn(AgentLifecycleManager.global(), "release").mockImplementation(() => completion.promise);
		try {
			const first = runtime.requestStop(lead, "audit", started.generation, "worker", entry, true, 120000);
			if (aborted) registry.setStatus("worker", "aborted", ref);
			expect(await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, 120000)).toBe(
				"stop already pending",
			);
			// Resolve before awaiting a second force, so broken code cannot deadlock the test.
			const second = runtime.requestStop(lead, "audit", started.generation, "worker", entry, true, 120000);
			completion.resolve(true);
			expect(await second).toBe("stop already pending");
			expect(await first).toBe("released");
			expect(release).toHaveBeenCalledTimes(1);
			expect(runtime.listTeams(lead)).toEqual(["audit"]);
		} finally {
			completion.resolve(true);
			release.mockRestore();
			await runtime.stop(lead, "audit");
		}
	});

	it.each([false, true])(
		"releases an already aborted member without a stop request and retires the team (force=%s)",
		async force => {
			const registry = AgentRegistry.global();
			const lead = session();
			registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
			const ref = registry.register({
				id: "worker",
				displayName: "worker",
				kind: "sub",
				session: session(),
				status: "aborted",
			});
			const runtime = new TeamRuntime();
			const started = await runtime.start(lead, team);
			const entry = { id: "worker", reservation: "registered", ref };
			started.members.set("worker", entry);
			const release = vi.spyOn(AgentLifecycleManager.global(), "release").mockResolvedValue(true);
			const send = vi.spyOn(IrcBus.global(), "send");
			try {
				expect(
					await runtime.requestStop(lead, "audit", started.generation, "worker", entry, force, 120000, true),
				).toBe("released");
				expect(release).toHaveBeenCalledTimes(1);
				expect(release).toHaveBeenCalledWith("worker", ref, { tombstone: true });
				expect(send).not.toHaveBeenCalled();
				expect(started.members.has("worker")).toBe(false);
				expect(runtime.listTeams(lead)).toEqual([]);
			} finally {
				send.mockRestore();
				release.mockRestore();
				await runtime.stop(lead, "audit");
			}
		},
	);

	it.each([0, -10, Number.NaN, 1])("clamps a short or invalid stop timeout (%s) to one second", async timeout => {
		const registry = AgentRegistry.global();
		const notices: string[] = [];
		const lead = {
			deliverIrcMessage: async (message: { body: string }) => {
				notices.push(message.body);
				return "injected";
			},
		} as unknown as AgentSessionHandle;
		const child = { deliverIrcMessage: async () => "injected" } as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const entry = { id: "worker", reservation: "registered", ref };
		started.members.set("worker", entry);
		vi.useFakeTimers();
		try {
			await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, timeout);
			vi.advanceTimersByTime(999);
			expect(notices).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("timed out");
		} finally {
			await runtime.stop(lead, "audit");
			vi.useRealTimers();
		}
	});

	it.each(["ack", "decline", "release", "replacement", "restart", "teardown", "registration failure"] as const)(
		"cleans the stop timer on %s and rejects the old response",
		async action => {
			IrcBus.resetGlobalForTests();
			const registry = AgentRegistry.global();
			const notices: string[] = [];
			const requests: string[] = [];
			const lead = {
				deliverIrcMessage: async (message: { body: string }) => {
					notices.push(message.body);
					return "injected";
				},
			} as unknown as AgentSessionHandle;
			let disposed = 0;
			const child = {
				deliverIrcMessage: async (message: { body: string }) => {
					requests.push(message.body);
					return "injected";
				},
				dispose: async () => {
					disposed++;
				},
			} as unknown as AgentSessionHandle;
			registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
			const ref =
				action === "registration failure"
					? undefined
					: registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
			const runtime = new TeamRuntime();
			const started = await runtime.start(lead, team);
			const entry = { id: "worker", reservation: "original", ref: ref ? { ...ref } : undefined };
			started.members.set("worker", entry);
			const identity = { team: "audit", generation: started.generation, memberId: "worker" };
			vi.useFakeTimers();
			try {
				await runtime.requestStop(lead, "audit", started.generation, "worker", entry, false, 120000);
				expect(vi.getTimerCount()).toBe(action === "registration failure" ? 0 : 1);
				const requestId =
					action === "registration failure"
						? "undispatched"
						: requests[0]!.match(/team:\/\/audit\/stop\/([^\s]+)/)![1]!;
				switch (action) {
					case "ack":
					case "decline":
						await runtime.respondStop(child, identity, requestId, action === "ack" ? "ack" : "decline: busy");
						break;
					case "release":
						registry.setStatus("worker", "aborted", ref);
						break;
					case "replacement":
						registry.register({ id: "worker", displayName: "new", kind: "sub", session: child });
						break;
					case "restart":
						await runtime.stop(lead, "audit");
						await runtime.start(lead, team);
						break;
					case "teardown":
						runtime.sessionClosed(lead);
						break;
					case "registration failure":
						await runtime.resolvePendingStop(
							lead,
							"audit",
							started.generation,
							"worker",
							entry,
							undefined,
							"failed",
						);
						break;
				}
				expect(vi.getTimerCount()).toBe(0);
				await expect(runtime.respondStop(child, identity, requestId, "ack")).rejects.toThrow();
				vi.advanceTimersByTime(240000);
				expect(notices.filter(body => body.includes("timed out"))).toHaveLength(0);
				expect(disposed).toBe(action === "ack" ? 1 : 0);
			} finally {
				await runtime.stop(lead, "audit");
				vi.useRealTimers();
			}
		},
	);
});

describe("team plan approval", () => {
	it("rate limits agent-authored plan submissions but still delivers approval notices", async () => {
		const registry = AgentRegistry.global();
		const notices: string[] = [];
		const receive = async (message: { body: string }) => {
			notices.push(message.body);
			return "injected";
		};
		const lead = { deliverIrcMessage: receive } as unknown as AgentSessionHandle;
		const child = { deliverIrcMessage: receive } as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "sub", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		IrcBus.installGlobal(
			new IrcBus(registry, undefined, {
				settings: Settings.isolated({ "irc.rateLimitTokens": 1 }),
			}),
		);
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, { ...team, planApproval: true });
		started.members.set("worker", { id: "worker", ref });
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		await runtime.submitPlan(child, identity, "Inspect");
		expect(
			(
				await IrcBus.global().send({
					from: "lead",
					to: "worker",
					body: "ordinary progress",
					progress: true,
				})
			).outcome,
		).toBe("injected");
		await runtime.approve(lead, "worker");
		expect(notices.at(-1)).toContain("Plan approved");
		await expect(runtime.submitPlan(child, identity, "Inspect again")).rejects.toThrow("rate limited");
		expect(notices).toHaveLength(3);
		expect(await runtime.planPending(child, identity)).toBe(true);
		await runtime.stop(lead, "audit");
	});

	it("closes before registration, delivers non-request plans and rejection, and requires resubmission", async () => {
		const registry = AgentRegistry.global();
		const notices: Array<{ from: string; to: string; body: string; progress?: boolean }> = [];
		const receive = async (message: (typeof notices)[number]) => {
			notices.push(message);
			return "injected";
		};
		const lead = { deliverIrcMessage: receive } as unknown as AgentSessionHandle;
		const child = { deliverIrcMessage: receive } as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, { ...team, planApproval: true });
		started.members.set("worker", { id: "worker" });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		expect(await runtime.planPending(child, identity)).toBe(true);
		await expect(runtime.approve(lead, "worker")).rejects.toThrow("write team://audit/plan");
		expect(await runtime.planPending(child, identity)).toBe(true);
		await runtime.submitPlan(child, identity, "Inspect before editing");
		expect(notices.at(-1)).toMatchObject({ from: "worker", to: "lead", progress: true });
		expect(notices.at(-1)!.body).toContain("Inspect before editing");
		expect(IrcBus.global().unansweredSends("worker", 0)).toEqual([]);
		await runtime.reject(lead, "worker", "Include regression coverage");
		expect(notices.at(-1)).toMatchObject({ from: "lead", to: "worker", progress: true });
		expect(notices.at(-1)!.body).toContain("Include regression coverage");
		expect(IrcBus.global().unansweredSends("lead", 0)).toEqual([]);
		await expect(runtime.approve(lead, "worker")).rejects.toThrow("write team://audit/plan");
		expect(await runtime.planPending(child, identity)).toBe(true);
		await runtime.submitPlan(child, identity, "Inspect, add regression, edit");
		await runtime.approve(lead, "worker");
		expect(await runtime.planPending(child, identity)).toBe(false);
		// Replacing the same ref/session still creates a new approval boundary.
		const replacement = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		await expect(runtime.planPending(child, identity)).rejects.toThrow();
		started.members.set("worker", { id: "worker", ref: replacement });
		expect(await runtime.planPending(child, identity)).toBe(true);
		await expect(runtime.approve(lead, "worker")).rejects.toThrow("write team://audit/plan");
		expect(ref.generation).not.toBe(replacement.generation);
		await runtime.stop(lead, "audit");
	});

	it("rejects nonmembers, wrong leads, stale generations, replaced leads and ambiguous handles", async () => {
		const registry = AgentRegistry.global();
		const lead = session();
		const child = session();
		const other = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		registry.register({ id: "outsider", displayName: "outsider", kind: "sub", session: other });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, { ...team, planApproval: true });
		started.members.set("worker", { id: "worker", ref });
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		await expect(runtime.submitPlan(other, identity, "spoof")).rejects.toThrow();
		await expect(runtime.planPending(other, identity)).rejects.toThrow();
		await expect(runtime.submitPlan(child, { ...identity, memberId: "outsider" }, "spoof")).rejects.toThrow();
		await expect(runtime.submitPlan(child, { ...identity, generation: -1 }, "stale")).rejects.toThrow();
		await expect(runtime.submitPlan(lead, { ...identity, memberId: "lead" }, "lead")).rejects.toThrow();
		await expect(runtime.approve(other, "worker")).rejects.toThrow();
		await expect(runtime.reject(child, "worker", "wrong lead")).rejects.toThrow();
		const second = await runtime.start(lead, { ...team, name: "review", planApproval: true });
		second.members.set("worker", { id: "worker", ref });
		await expect(runtime.approve(lead, "worker")).rejects.toThrow("ambiguous");
		await expect(runtime.reject(lead, "worker", "ambiguous")).rejects.toThrow("ambiguous");
		await runtime.stop(lead, "review");
		registry.register({ id: "lead", displayName: "replacement", kind: "main", session: lead });
		await expect(runtime.approve(lead, "worker")).rejects.toThrow();
		await expect(runtime.submitPlan(child, identity, "stale lead")).rejects.toThrow();
		await runtime.stop(lead, "audit");
	});

	it("honors false overrides and resets approval for a new reservation and team generation", async () => {
		const registry = AgentRegistry.global();
		const lead = { deliverIrcMessage: async () => "injected" } as unknown as AgentSessionHandle;
		const child = { deliverIrcMessage: async () => "injected" } as unknown as AgentSessionHandle;
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const definition = {
			...team,
			planApproval: true,
			members: [{ agent: "worker", handle: "worker", planApproval: false }],
		};
		const started = await runtime.start(lead, definition);
		started.members.set("worker", { id: "worker", ref });
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		expect(await runtime.planPending(child, identity)).toBe(false);
		expect(runtime.memberIdentity(lead, "audit", started.generation, "worker").planApproval).toBe(false);
		expect(() => runtime.memberIdentity(child, "audit", started.generation, "worker")).toThrow();
		await runtime.stop(lead, "audit");
		const next = await runtime.start(lead, { ...definition, members: [] });
		const entry = { id: "worker", ref, reservation: "first" };
		next.members.set("worker", entry);
		const nextIdentity = { ...identity, generation: next.generation };
		expect(await runtime.planPending(child, nextIdentity)).toBe(true);
		expect(runtime.memberIdentity(lead, "audit", next.generation, "worker").planApproval).toBe(true);
		expect(await runtime.planPending(child, { ...nextIdentity, planApproval: false })).toBe(true);
		await runtime.submitPlan(child, nextIdentity, "Plan");
		await runtime.approve(lead, "worker");
		expect(await runtime.planPending(child, nextIdentity)).toBe(false);
		const replacement = { ...entry, reservation: "second" };
		next.members.set("worker", replacement);
		runtime.memberUpdated(lead, "audit", next.generation, "worker", entry, replacement);
		expect(await runtime.planPending(child, nextIdentity)).toBe(true);
		await expect(runtime.planPending(child, identity)).rejects.toThrow();
		await runtime.stop(lead, "audit");
	});

	it("looks up a real worker's pending gate in main and observes main-side rejection and approval", async () => {
		const registry = AgentRegistry.global();
		const lead = { deliverIrcMessage: async () => "injected" } as unknown as AgentSessionHandle;
		const realNow = Date.now.bind(Date);
		let elapsed = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const started = await teamRuntime.start(lead, { ...team, planApproval: true });
		started.members.set("worker", { id: "worker" });
		const ready = Promise.withResolvers<TeamProbe>();
		const probeService: ThreadService = {
			name: "team-probe",
			globals: (): TeamProbeGlobals => ({ ready: ready.resolve }),
		};
		const worker = new SubagentWorker({
			entry: new URL("../fixtures/team-runtime-worker.ts", import.meta.url),
			services: [identityThreadService, agentsThreadService, teamThreadService, probeService],
			initTimeoutMs: 60_000,
		});
		try {
			await worker.ready;
			const probe = await ready.promise;
			const key = await probe.open("worker");
			const identity = { team: "audit", generation: started.generation, memberId: "worker" };
			expect(await probe.planPending(key, identity)).toBe(true);
			await probe.submitPlan(key, identity, "Worker plan");
			await teamRuntime.reject(lead, "worker", "Revise worker plan");
			expect(await probe.planPending(key, identity)).toBe(true);
			elapsed += 500;
			await probe.submitPlan(key, identity, "Worker revised plan");
			await teamRuntime.approve(lead, "worker");
			expect(await probe.planPending(key, identity)).toBe(false);
			let error: unknown;
			try {
				await probe.planPending(key, { ...identity, memberId: "lead" });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			const workerLead = await probe.open("worker-lead");
			const workerMember = await probe.open("worker-member");
			const workerTeam = await probe.start(workerLead, { ...team, planApproval: true });
			expect(await probe.putMember(workerLead, workerTeam.generation, "worker-member")).toBe(true);
			const issued = await probe.memberIdentity(workerLead, "audit", workerTeam.generation, "worker-member");
			expect(issued.planApproval).toBe(true);
			expect(issued.memberId).toBe("worker-member");
			let metadataError: unknown;
			try {
				await probe.memberIdentity(workerMember, "audit", workerTeam.generation, "worker-member");
			} catch (caught) {
				metadataError = caught;
			}
			expect(metadataError).toBeInstanceOf(Error);
			const workerIdentity = { team: "audit", generation: workerTeam.generation, memberId: "worker-member" };
			await probe.submitPlan(workerMember, workerIdentity, "First worker-led plan");
			expect(await probe.command(workerLead, ".", "reject worker-member Add tests")).toContain("rejected");
			expect(await probe.planPending(workerMember, workerIdentity)).toBe(true);
			elapsed += 500;
			await probe.submitPlan(workerMember, workerIdentity, "Revised worker-led plan");
			expect(await probe.command(workerLead, ".", "approve worker-member")).toContain("approved");
			expect(await probe.planPending(workerMember, workerIdentity)).toBe(false);
		} finally {
			clock.mockRestore();
			await teamRuntime.stop(lead, "audit");
			await worker.terminate("test end");
		}
	});
});

describe("team runtime authorization", () => {
	it("rejects spoofed sessions and replaced registry refs without changing tasks", async () => {
		const registry = AgentRegistry.global();
		const lead = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		const child = session();
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		started.members.set("worker", { id: "worker", ref });
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		await expect(runtime.claim(session(), identity, "1")).rejects.toThrow();
		registry.register({ id: "worker", displayName: "replacement", kind: "sub", session: child });
		await expect(runtime.claim(child, identity, "1")).rejects.toThrow();
		expect(
			await runtime.readTasks(lead, { team: "audit", generation: started.generation, memberId: "lead" }),
		).toEqual([{ id: "1", title: "Inspect", owner: null, status: "open", note: "" }]);
	});

	it("authorizes a copied member ref with the same generation", async () => {
		const registry = AgentRegistry.global();
		const lead = session();
		const child = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		started.members.set("worker", { id: "worker", ref: { ...ref } });
		expect(
			(await runtime.claim(child, { team: "audit", generation: started.generation, memberId: "worker" }, "1")).kind,
		).toBe("claimed");
	});

	it("keeps a non-Main lead and its members live across idle TTL until its teams retire", async () => {
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const disposers: Array<() => void> = [];
		const lead = {
			addDisposer: (dispose: () => void) => disposers.push(dispose),
			dispose: async () => {
				for (const dispose of disposers) dispose();
			},
		} as unknown as AgentSessionHandle;
		let memberDisposals = 0;
		const child = {
			dispose: async () => {
				memberDisposals++;
			},
		} as unknown as AgentSessionHandle;
		const leadRef = registry.register({
			id: "lead",
			displayName: "lead",
			kind: "sub",
			session: lead,
			status: "idle",
		});
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = teamRuntime;
		const started = await runtime.start(lead, team);
		const other = await runtime.start(lead, { ...team, name: "review" });
		const entry = { id: "worker", reservation: "worker-reservation", ref: { ...ref } };
		started.members.set("worker", entry);
		vi.useFakeTimers();
		try {
			lifecycle.adopt("lead", { idleTtlMs: 100 }, leadRef);
			vi.advanceTimersByTime(100);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(leadRef.status).toBe("idle");
			expect(leadRef.session).toBe(lead);
			expect(runtime.isCurrentLead(lead, "audit", started.generation)).toBe(true);
			expect(ref.session).toBe(child);
			expect(ref.status).toBe("running");
			expect(memberDisposals).toBe(0);
			await runtime.stop(lead, "review");
			expect(runtime.isCurrentLead(lead, "review", other.generation)).toBe(false);
			vi.advanceTimersByTime(100);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(leadRef.status).toBe("idle");
			expect(await runtime.requestStop(lead, "audit", started.generation, "worker", entry, true, 1000, true)).toBe(
				"released",
			);
			expect(runtime.identity(lead, "audit")).toBeUndefined();
			vi.advanceTimersByTime(100);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(leadRef.status).toBe("parked");
			expect(leadRef.session).toBeNull();
			expect(memberDisposals).toBe(1);
		} finally {
			vi.useRealTimers();
			await runtime.stop(lead, "audit");
			await runtime.stop(lead, "review");
			await lifecycle.release("lead", leadRef);
		}
	});

	it("leaves Main member teardown owned and awaited by the lifecycle", async () => {
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const lead = session();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: lead });
		const disposal = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const child = {
			dispose: async () => {
				entered.resolve();
				await disposal.promise;
			},
		} as unknown as AgentSessionHandle;
		const ref = registry.register({
			id: "worker",
			displayName: "worker",
			kind: "sub",
			session: child,
			status: "idle",
		});
		lifecycle.adopt("worker", { idleTtlMs: 0 }, ref);
		const started = await teamRuntime.start(lead, team);
		started.members.set("worker", { id: "worker", ref });
		teamRuntime.sessionClosed(lead);
		expect(teamRuntime.identity(lead, "audit")).toBeUndefined();
		try {
			expect(ref.session).toBe(child);
			expect(ref.status).toBe("idle");
			let settled = false;
			const teardown = lifecycle.dispose().then(() => {
				settled = true;
			});
			await entered.promise;
			expect(settled).toBe(false);
			disposal.resolve();
			await teardown;
			expect(registry.get("worker")).toBeUndefined();
		} finally {
			disposal.resolve();
			await lifecycle.dispose();
		}
	});

	it("revokes teams when a local lead session is disposed", async () => {
		const disposers: Array<() => void> = [];
		const lead = { addDisposer: (dispose: () => void) => disposers.push(dispose) } as unknown as AgentSessionHandle;
		AgentRegistry.global().register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		for (const dispose of disposers) dispose();
		await expect(
			runtime.readTasks(lead, { team: "audit", generation: started.generation, memberId: "lead" }),
		).rejects.toThrow();
	});

	it("does not publish a generation when the lead closes during initialization", async () => {
		const lead = session();
		AgentRegistry.global().register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const runtime = new TeamRuntime();
		const starting = runtime.start(lead, team);
		runtime.sessionClosed(lead);
		await expect(starting).rejects.toThrow();
		expect(runtime.identity(lead, "audit")).toBeUndefined();
	});

	it("revokes stopped generations and prevents members from adding tasks", async () => {
		const registry = AgentRegistry.global();
		const lead = session();
		const child = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const childRef = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		started.members.set("worker", { id: "worker", ref: childRef });
		const identity = { team: "audit", generation: started.generation, memberId: "worker" };
		await expect(runtime.addTask(child, identity, "unauthorized")).rejects.toThrow();
		await runtime.stop(lead, "audit");
		const restarted = await runtime.start(lead, team);
		await expect(runtime.claim(child, identity, "1")).rejects.toThrow();
		expect(
			await runtime.readTasks(lead, { team: "audit", generation: restarted.generation, memberId: "lead" }),
		).toEqual([{ id: "1", title: "Inspect", owner: null, status: "open", note: "" }]);
	});

	it("rejects a claim queued before its generation is stopped", async () => {
		const registry = AgentRegistry.global();
		const lead = session();
		const child = session();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", session: child });
		const runtime = new TeamRuntime();
		const started = await runtime.start(lead, team);
		started.members.set("worker", { id: "worker", ref });
		const leadIdentity = { team: "audit", generation: started.generation, memberId: "lead" };
		const memberIdentity = { team: "audit", generation: started.generation, memberId: "worker" };
		const reading = runtime.readTasks(lead, leadIdentity);
		const claim = runtime.claim(child, memberIdentity, "1");
		const stopped = runtime.stop(lead, "audit");
		expect((await reading)[0]?.owner).toBeNull();
		await expect(claim).rejects.toThrow("stale");
		await stopped;
	});

	it("serializes main and worker claims across two teams sharing a canonical workspace", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-team-thread-"));
		const workspace = path.join(directory, "workspace");
		const alias = path.join(directory, "alias");
		await fs.mkdir(workspace);
		let sharedPath = path.join(workspace, ".");
		try {
			await fs.symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
			sharedPath = alias;
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw error;
		}
		const lead = session();
		const registry = AgentRegistry.global();
		registry.register({ id: "lead", displayName: "lead", kind: "main", session: lead });
		const ready = Promise.withResolvers<TeamProbe>();
		const probeService: ThreadService = {
			name: "team-probe",
			globals: (): TeamProbeGlobals => ({ ready: ready.resolve }),
		};
		const worker = new SubagentWorker({
			entry: new URL("../fixtures/team-runtime-worker.ts", import.meta.url),
			services: [identityThreadService, agentsThreadService, teamThreadService, probeService],
			initTimeoutMs: 60_000,
		});
		try {
			await worker.ready;
			const probe = await ready.promise;
			const started = await teamRuntime.start(lead, { ...team, workspace });
			const shared = await teamRuntime.start(lead, { ...team, name: "review", workspace: sharedPath });
			const key = await probe.open("worker");
			const ref = registry.get("worker");
			if (!ref) throw new Error("worker did not register");
			shared.members.set("worker", { id: "worker", ref });
			const leadIdentity = { team: "audit", generation: started.generation, memberId: "lead" };
			const memberIdentity = { team: "review", generation: shared.generation, memberId: "worker" };
			const results = await Promise.all([
				teamRuntime.claim(lead, leadIdentity, "1"),
				probe.claim(key, memberIdentity, "1"),
			]);
			const winner = results.find(result => result.kind === "claimed");
			const conflict = results.find(result => result.kind === "conflict");
			if (!winner || !conflict) throw new Error("Expected one winner and one conflict");
			expect(conflict.owner).toBe(winner.owner);
			expect((await teamRuntime.readTasks(lead, leadIdentity))[0]?.owner).toBe(winner.owner);
			expect(await fs.readFile(path.join(workspace, "TASKS.md"), "utf8")).toContain(winner.owner);
			await expect(
				probe.claim(key, { ...memberIdentity, generation: shared.generation + 1 }, "1"),
			).rejects.toThrow();
		} finally {
			await teamRuntime.stop(lead, "audit");
			await teamRuntime.stop(lead, "review");
			await worker.terminate("test end");
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("creates a worker-hosted lead's generation in the main runtime", async () => {
		const ready = Promise.withResolvers<TeamProbe>();
		const probeService: ThreadService = {
			name: "team-probe",
			globals: (): TeamProbeGlobals => ({ ready: ready.resolve }),
		};
		const worker = new SubagentWorker({
			entry: new URL("../fixtures/team-runtime-worker.ts", import.meta.url),
			services: [identityThreadService, agentsThreadService, teamThreadService, probeService],
			initTimeoutMs: 60_000,
		});
		try {
			await worker.ready;
			const probe = await ready.promise;
			const key = await probe.open("worker-lead");
			const started = await probe.start(key, team);
			const lead = AgentRegistry.global().get("worker-lead")?.session;
			if (!lead) throw new Error("worker lead did not register");
			expect(teamRuntime.identity(lead, "audit")).toEqual({
				team: "audit",
				generation: started.generation,
				memberId: "worker-lead",
			});
			expect(
				await teamRuntime.readTasks(lead, {
					team: "audit",
					generation: started.generation,
					memberId: "worker-lead",
				}),
			).toEqual([{ id: "1", title: "Inspect", owner: null, status: "open", note: "" }]);
		} finally {
			await worker.terminate("test end");
		}
	});
	it("handles worker lead member refs through status, claim and stop", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-team-lead-"));
		const teamsDir = path.join(directory, ".omp", "teams");
		await fs.mkdir(teamsDir, { recursive: true });
		await fs.writeFile(
			path.join(teamsDir, "audit.md"),
			[
				"---",
				"name: audit",
				"description: audit",
				"members:",
				"  - agent: scout",
				"    handle: worker-member",
				"---",
				"Audit",
			].join("\n"),
		);
		const ready = Promise.withResolvers<TeamProbe>();
		const probeService: ThreadService = {
			name: "team-probe",
			globals: (): TeamProbeGlobals => ({ ready: ready.resolve }),
		};
		const worker = new SubagentWorker({
			entry: new URL("../fixtures/team-runtime-worker.ts", import.meta.url),
			services: [identityThreadService, agentsThreadService, teamThreadService, probeService],
			initTimeoutMs: 60_000,
		});
		try {
			await worker.ready;
			const probe = await ready.promise;
			expect(await probe.beforeInstall()).toContain("has not been installed");
			const lead = await probe.open("worker-lead");
			const member = await probe.open("worker-member");
			const started = await probe.start(lead, team);
			expect(await probe.putMember(lead, started.generation, "worker-member")).toBe(true);
			expect(await probe.command(lead, directory, "status audit")).toContain("worker-member - running");
			expect(
				(
					await probe.claim(
						member,
						{ team: "audit", generation: started.generation, memberId: "worker-member" },
						"1",
					)
				).kind,
			).toBe("claimed");
			expect(await probe.command(lead, directory, "stop --force audit")).toContain("released");
			const nextMember = await probe.open("worker-member");
			const next = await probe.start(lead, team);
			expect(await probe.putMember(lead, next.generation, "worker-member")).toBe(true);
			const stopped = await probe.command(lead, directory, "stop audit");
			const requestId = stopped.match(/requested \(([^)]+)\)/)?.[1];
			expect(requestId).toBeDefined();
			expect(AgentRegistry.global().get("worker-member")?.status).not.toBe("aborted");
			const identity = { team: "audit", generation: next.generation, memberId: "worker-member" };
			await probe.respondStop(nextMember, identity, requestId!, "ack");
			expect(AgentRegistry.global().get("worker-member")?.status).toBe("aborted");
			// Await RPC rejection before asserting: Bun's rejects matcher blocks nested worker calls.
			let duplicateError: unknown;
			try {
				await probe.respondStop(nextMember, identity, requestId!, "ack");
			} catch (error) {
				duplicateError = error;
			}
			expect(duplicateError).toBeInstanceOf(Error);
			const leadSession = AgentRegistry.global().get("worker-lead")!.session!;
			expect(teamRuntime.listTeams(leadSession)).toEqual([]);
			const restarted = await probe.start(lead, team);
			expect(restarted.generation).toBeGreaterThan(next.generation);
		} finally {
			await worker.terminate("test end");
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
