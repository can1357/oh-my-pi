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
			session: { asyncJobManager: manager, getAgentId: () => "Main" } as ToolSession,
			emitStatus: event => events.push(event),
		},
	);
	expect(events.filter(event => event.op === "agent")).toHaveLength(1);
	await manager.dispose();
});
