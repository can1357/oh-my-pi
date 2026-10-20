import { expect, it } from "bun:test";
import { snapshotJobs } from "../src/async/job-control";
import { AsyncJobManager } from "../src/async/job-manager";
import type { ToolSession } from "../src/tools";

it("snapshots keep live task progress for a running task job and drop malformed entries", async () => {
	const gate = Promise.withResolvers<string>();
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const id = manager.register("task", "worker", async () => gate.promise, { id: "Worker" });
	const job = manager.getJob(id)!;
	const progress = {
		index: 0,
		id: "Worker",
		agent: "task",
		status: "running",
		task: "inspect",
		recentTools: [],
		recentOutput: ["line one"],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 1,
	};
	job.latestDetails = { progress: [progress, { id: "broken" }] };
	const session = { asyncJobManager: manager } as unknown as ToolSession;
	try {
		const [snapshot] = snapshotJobs(session, [job]);
		expect(snapshot?.status).toBe("running");
		expect(snapshot?.progress).toEqual([progress as never]);

		// Negative control: a non-task job never carries progress.
		const bashId = manager.register("bash", "sleep", async () => gate.promise, { id: "Shell" });
		const bash = manager.getJob(bashId)!;
		bash.latestDetails = { progress: [progress] };
		expect(snapshotJobs(session, [bash])[0]?.progress).toBeUndefined();
	} finally {
		gate.resolve("done");
		await manager.dispose({ timeoutMs: 1_000 });
	}
});
