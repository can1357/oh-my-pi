import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../../src/registry/agent-registry";
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

beforeEach(() => AgentRegistry.resetGlobalForTests());

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
});
