import { expect, it } from "bun:test";
import { snapshotJobs } from "../src/async/job-control";
import { AsyncJobManager } from "../src/async/job-manager";
import type { ToolSession } from "../src/tools";
import { Settings } from "../src/config/settings";
import { WaitTool } from "../src/tools/wait";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { type CoordinationDetails, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";

it("snapshots keep live task progress for a running task job and drop malformed entries", async () => {
	const gate = Promise.withResolvers<string>();
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const id = manager.register("task", "worker", async () => gate.promise, { id: "Worker-2", agentId: "Worker" });
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
		cost: 1.25,
		requests: 7,
		contextTokens: 100,
		contextWindow: 1000,
		durationMs: 1,
	};
	job.latestDetails = { progress: [{ id: "Other", requests: 99 }, progress, { id: "broken" }] };
	const session = { asyncJobManager: manager } as unknown as ToolSession;
	try {
		const [snapshot] = snapshotJobs(session, [job]);
		expect(snapshot?.status).toBe("running");
		expect(snapshot?.progress).toEqual([progress as never]);
		expect(snapshot).toMatchObject({
			agentUrlId: "Worker",
			requests: 7,
			cost: 1.25,
			contextTokens: 100,
			contextWindow: 1000,
		});
		job.resultText = "final body";
		const meta = { source: { type: "internal" as const, value: "worker-output" } };
		job.latestDetails.meta = meta;
		expect(snapshotJobs(session, [job], { includeResults: false })[0]?.resultText).toBeUndefined();
		expect(snapshotJobs(session, [job], { includeResults: false })[0]?.meta).toEqual(meta);
		job.status = "completed";
		manager.consumeJobResults([id]);
		expect(snapshotJobs(session, [job])[0]?.resultText).toBeUndefined();
		expect(snapshotJobs(session, [job])[0]?.meta).toBeUndefined();
		expect(snapshotJobs(session, [job], { includeResults: false })[0]?.meta).toEqual(meta);

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

it("real wait updates stream the canonical collision-resolved worker, then consume its final result once", async () => {
	await initTheme();
	const gate = Promise.withResolvers<string>();
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const id = manager.register("task", "worker", async () => gate.promise, {
		id: "Worker-2",
		agentId: "Worker",
		ownerId: "Main",
	});
	const job = manager.getJob(id)!;
	const progress = {
		index: 0,
		id: "Worker",
		agent: "task",
		status: "running" as const,
		task: "canonical task",
		recentTools: [],
		recentOutput: ["canonical output"],
		lastIntent: "canonical intent",
		toolCount: 0,
		tokens: 0,
		cost: 1.25,
		requests: 7,
		contextTokens: 100,
		contextWindow: 1000,
		durationMs: 1,
	};
	job.latestDetails = {
		progress: [{ ...progress, id: "Worker-2", lastIntent: "wrong worker", recentOutput: ["wrong output"] }, progress],
	};
	const session = {
		asyncJobManager: manager,
		getAgentId: () => "Main",
		settings: Settings.isolated({ "launch.enabled": false }),
	} as unknown as ToolSession;
	const tool = new WaitTool(session);
	const update = Promise.withResolvers<CoordinationDetails>();
	const waiting = tool.execute("wait-worker", {}, undefined, result => {
		if (result.details) update.resolve(result.details);
	});
	try {
		const details = await update.promise;
		expect(details.jobs?.[0]).toMatchObject({
			id,
			agentUrlId: "Worker",
			requests: 7,
			cost: 1.25,
			contextTokens: 100,
			contextWindow: 1000,
		});
		const component = waitToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			theme,
		);
		const output = Bun.stripANSI(component.render(140).join("\n"));
		expect(output).toContain("canonical intent");
		expect(output).toContain("canonical output");
		expect(output).not.toContain("wrong worker");
		expect(output).not.toContain("wrong output");
		gate.resolve("final report");
		const result = await waiting;
		expect(result.details?.jobs?.[0]?.resultText).toBe("final report");
		manager.consumeJobResults([id]);
		const second = await tool.execute("wait-again", {});
		expect(second.details?.jobs).toEqual([]);
		expect(JSON.stringify(second)).not.toContain("final report");
	} finally {
		gate.resolve("final report");
		await waiting;
		await manager.dispose({ timeoutMs: 1_000 });
	}
});
