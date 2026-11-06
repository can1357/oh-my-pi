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

test("agent progress events keep scalar fields and cut long text", async () => {
	const manager = new AsyncJobManager({});
	const assignment = `Review the parser\n${"x".repeat(20_000)}`;
	const progress = {
		status: "completed",
		assignment,
		task: assignment,
		toolCount: 26,
		cost: 0.0177,
		advisor: false,
		resolvedModelIdentity: "anthropic/claude-haiku-5-5",
		extractedToolData: { yield: [{ data: "y".repeat(50_000) }] },
		recentTools: [{ tool: "read", args: "z".repeat(5_000) }],
		recentOutput: ["line"],
	};
	const id = manager.register(
		"task",
		"Scout",
		async ({ reportProgress }) => {
			await reportProgress("done", { progress: [progress] });
			return "done";
		},
		{ id: "large-progress", ownerId: "Main", agentId: "Scout" },
	);
	const job = manager.getJob(id);
	if (!job) throw new Error("missing job");
	await job.promise;
	const events: Array<Record<string, unknown>> = [];
	try {
		await runEvalWait(
			{ items: [{ kind: "agent", id }] },
			{
				session: { asyncJobManager: manager, getAgentId: () => "Main" } as unknown as ToolSession,
				emitStatus: event => events.push(event),
			},
		);
		const [event] = events.filter(candidate => candidate.op === "agent");
		expect(event).toMatchObject({
			op: "agent",
			id: "Scout",
			status: "completed",
			toolCount: 26,
			cost: 0.0177,
			advisor: false,
			resolvedModelIdentity: "anthropic/claude-haiku-5-5",
			taskPreview: "Review the parser",
		});
		expect(event).not.toHaveProperty("extractedToolData");
		expect(event).not.toHaveProperty("recentTools");
		expect(event).not.toHaveProperty("recentOutput");
		expect((event!.assignment as string).length).toBeLessThanOrEqual(256);
		expect((event!.task as string).startsWith("Review the parser")).toBe(true);
		expect(JSON.stringify(event).length).toBeLessThan(1_500);
	} finally {
		await manager.dispose();
	}
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
