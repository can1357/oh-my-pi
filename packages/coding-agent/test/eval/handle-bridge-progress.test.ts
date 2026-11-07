import { expect, test } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { runEvalWait } from "../../src/eval/handle-bridge";
import type { ToolSession } from "../../src/tools";

test("settled eval progress is emitted once", async () => {
	const manager = new AsyncJobManager({});
	const progress = { status: "completed", assignment: "investigate", toolCount: 7 };
	const id = manager.register(
		"task",
		"Scout",
		async ({ reportProgress }) => {
			await reportProgress("done", { progress: [progress] });
			return "done";
		},
		{ id: "settled-progress", ownerId: "Main", agentId: "Scout" },
	);
	const job = manager.getJob(id);
	if (!job) throw new Error("missing job");
	await job.promise;
	const events: Array<{ op: string }> = [];
	await runEvalWait(
		{ items: [{ kind: "agent", id }] },
		{
			session: { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession,
			emitStatus: event => events.push(event),
		},
	);
	expect(events.filter(event => event.op === "agent")).toHaveLength(1);
	await manager.dispose();
});

test("each awaited batch job reports its own agent's progress (issue #18393)", async () => {
	const manager = new AsyncJobManager({});
	// A batch `task` call shares one progress array across its jobs.
	const batch = [
		{ id: "Alpha", status: "running", assignment: "alpha work", toolCount: 1 },
		{ id: "Beta", status: "running", assignment: "beta work", toolCount: 9 },
	];
	const ids = ["Alpha", "Beta"].map(agentId =>
		manager.register(
			"task",
			agentId,
			async ({ reportProgress }) => {
				await reportProgress("done", { progress: batch });
				return "done";
			},
			{ id: agentId, ownerId: "Main", agentId },
		),
	);
	await Promise.all(ids.map(id => manager.getJob(id)?.promise));
	const events: Array<{ op: string; id?: string; toolCount?: number; taskPreview?: string }> = [];
	await runEvalWait(
		{ items: ids.map(id => ({ kind: "agent", id })) },
		{
			session: { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession,
			emitStatus: event => events.push(event),
		},
	);
	const rows = events
		.filter(event => event.op === "agent")
		.map(({ id, toolCount, taskPreview }) => ({ id, toolCount, taskPreview }));
	expect(rows).toEqual([
		{ id: "Alpha", toolCount: 1, taskPreview: "alpha work" },
		{ id: "Beta", toolCount: 9, taskPreview: "beta work" },
	]);
	await manager.dispose();
});

test("timeouts past the 32-bit timer limit do not fire instantly (issue #12375)", async () => {
	const manager = new AsyncJobManager({});
	const id = manager.register(
		"task",
		"Scout",
		async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
			return "done";
		},
		{ id: "slow-settle", ownerId: "Main", agentId: "Scout" },
	);
	const job = manager.getJob(id);
	if (!job) throw new Error("missing job");
	const startedAt = Date.now();
	try {
		// Pre-fix the overflowing timer fired in ~1ms and the wait resolved as
		// "timeout" while the job was still running; now the natural settle at
		// ~200ms must win instead.
		const result = await runEvalWait(
			{ items: [{ kind: "agent", id }], timeoutMs: 2_400_000_000 },
			{
				session: { asyncJobManager: manager, getAgentId: () => "Main" } as Partial<ToolSession> as ToolSession,
				emitStatus: () => {},
			},
		);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
		expect(result.items[0]).toMatchObject({ status: "completed" });
	} finally {
		await manager.dispose();
	}
});
