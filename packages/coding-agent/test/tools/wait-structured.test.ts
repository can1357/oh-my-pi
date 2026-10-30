/**
 * `buildJobResult` structured-output rendering for a settled wait.
 * Regression coverage: valid results must not inline a truncated JSON
 * block (breaks async-result.md's contract of pointing to `agent://<id>`
 * instead, and can emit invalid JSON once truncated at 4k), and any result
 * carrying data must advertise the `agent://<id>` handle (PR #10625 review).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AsyncJobRunResult } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { buildJobResult } from "@oh-my-pi/pi-coding-agent/async/job-control";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "launch.enabled") return false;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: snapshot rendering only touches these fields.
	return stub as unknown as ToolSession;
}

/** Register a job that immediately settles with the given text + structured payload. */
function registerSettledJob(
	manager: AsyncJobManager,
	label: string,
	text: string,
	structured: StructuredSubagentOutput,
	agentId?: string,
): string {
	return manager.register("task", label, async () => ({ text, structured }), { ownerId: SELF_ID, agentId });
}

describe("wait structured output rendering", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a schema-valid result advertises the agent:// pointer instead of inlining JSON", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"ValidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true, count: 7 } },
			"ValidJob",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema valid");
		expect(text).toContain("full payload at agent://ValidJob");
		expect(text).toContain("fields via agent://ValidJob/<field>");
		// The truncated inline JSON block must not appear for a valid result.
		expect(text).not.toContain("```json");
	});

	test("a schema-invalid result keeps the truncated JSON preview alongside the pointer", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"InvalidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "invalid", data: { wrong: "shape" }, error: "missing field" },
			"InvalidJob",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema invalid: missing field");
		expect(text).toContain("full payload at agent://InvalidJob");
		expect(text).toContain("```json");
		expect(text).toContain('"wrong": "shape"');
	});

	test("a run that failed before yielding reports the provider error, not a schema verdict", async () => {
		// Production 2026-09-21: the delivery read `Structured output: schema
		// invalid: Anthropic stream envelope error: ...` with the half-streamed
		// prose as a JSON preview. No payload existed to judge.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		const jobId = registerSettledJob(
			manager,
			"DeadStream",
			'<task-result status="failed (exit 1)">partial</task-result>',
			{ source: "agent", mode: "permissive", status: "unavailable", error },
			"DeadStream",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`Structured output: unavailable: ${error}`);
		expect(text).not.toContain("schema invalid");
		expect(text).not.toContain("schema unavailable");
		expect(text).not.toContain("full payload at");
		expect(text).not.toContain("```json");
	});

	test("advertises the disambiguated agentId, not the collision-suffixed job id", async () => {
		// A task job can reuse a vibe turn's job id, forcing the manager to
		// suffix `jobId` (e.g. `Foo` -> `Foo-2`) while the task's artifacts
		// are still written under its own agent id.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise: hangs } = Promise.withResolvers<AsyncJobRunResult>();
		manager.register("task", "collider", async () => hangs, { ownerId: SELF_ID, id: "Foo" });
		const jobId = registerSettledJob(
			manager,
			"Foo",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			"Foo",
		);
		expect(jobId).not.toBe("Foo");
		await manager.getJob(jobId)!.promise;
		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`full payload at agent://Foo,`);
	});

	test("a woken agent's suffixed turn job names the agent's agent:// and history:// handles", async () => {
		// Messaging a finished agent starts a new turn job; while the first
		// turn's job is retained, the manager suffixes the new one (`Quick-2`).
		// `agent://Quick-2` and `history://Quick-2` do not resolve, so the
		// completed block must name the agent's own id.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const first = manager.register("task", "Quick", async () => ({ text: "DONE1" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		await manager.getJob(first)!.promise;
		const jobId = manager.register("task", "Quick", async () => ({ text: "DONE2" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		expect(jobId).toBe("Quick-2");
		await manager.getJob(jobId)!.promise;
		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("### Quick-2 [task]");
		expect(text).toContain("Agent: agent://Quick, history://Quick");
		expect(text).not.toContain("agent://Quick-2");
	});

	test("a failed or cancelled turn job names only the agent's history:// handle", async () => {
		// A follow-up turn that fails without yielding leaves `Quick.md` holding
		// the previous turn's output, and a cancelled /tan clone is unregistered
		// with none, so `agent://` would answer with another turn's output or
		// not at all; only the transcript is this turn's record.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const first = manager.register("task", "Quick", async () => ({ text: "DONE1" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		await manager.getJob(first)!.promise;
		const failedId = manager.register(
			"task",
			"Quick",
			async () => {
				throw new Error("provider error");
			},
			{ ownerId: SELF_ID, id: "Quick", agentId: "Quick" },
		);
		expect(failedId).toBe("Quick-2");
		await manager.getJob(failedId)!.promise;
		const cancelledId = manager.register(
			"task",
			"/tan work",
			({ signal }) => {
				const { promise, reject } = Promise.withResolvers<string>();
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				return promise;
			},
			{ ownerId: SELF_ID, agentId: "Tan-1" },
		);
		expect(manager.cancel(cancelledId)).toBe(true);
		await manager.getJob(cancelledId)!.promise;
		const jobs = [manager.getJob(failedId)!, manager.getJob(cancelledId)!];
		expect(jobs.map(job => job.status)).toEqual(["failed", "cancelled"]);
		const result = buildJobResult(makeSession(manager), manager, "wait", jobs, []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Agent: history://Quick");
		expect(text).toContain("Agent: history://Tan-1");
		expect(text).not.toContain("agent://Quick");
		expect(text).not.toContain("agent://Tan-1");
	});

	test("a completed turn that published no output names only the agent's history:// handle", async () => {
		// A woken agent that neither yields nor reports a message result ends
		// its turn completed, but `finalizeRunResult` writes no new `Quick.md`,
		// so `agent://Quick` still holds the previous turn's output.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const first = manager.register("task", "Quick", async () => ({ text: "DONE1" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		await manager.getJob(first)!.promise;
		const jobId = manager.register(
			"task",
			"Quick",
			async () => ({ text: "chatted, no yield", agentOutputPublished: false }),
			{ ownerId: SELF_ID, id: "Quick", agentId: "Quick" },
		);
		expect(jobId).toBe("Quick-2");
		await manager.getJob(jobId)!.promise;
		expect(manager.getJob(jobId)!.status).toBe("completed");
		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Agent: history://Quick");
		expect(text).not.toContain("agent://Quick");
	});

	test("distinguishes jobs watched by wait from un-watched snapshot recoveries", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const watchedJobId = registerSettledJob(
			manager,
			"WatchedJob",
			"<task-result>watched</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			"WatchedJob",
		);
		manager.watchJobs([watchedJobId]);
		await manager.getJob(watchedJobId)!.promise;

		const watchedResult = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(watchedJobId)!], []);
		manager.unwatchJobs([watchedJobId]);
		const watchedText = watchedResult.content[0]?.type === "text" ? watchedResult.content[0].text : "";
		expect(watchedText).toContain("Delivery: delivered directly to wait.");

		const unwatchedJobId = registerSettledJob(
			manager,
			"UnwatchedJob",
			"<task-result>unwatched</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			"UnwatchedJob",
		);
		await manager.getJob(unwatchedJobId)!.promise;
		const unwatchedResult = buildJobResult(
			makeSession(manager),
			manager,
			"wait",
			[manager.getJob(unwatchedJobId)!],
			[],
		);
		const unwatchedText = unwatchedResult.content[0]?.type === "text" ? unwatchedResult.content[0].text : "";
		expect(unwatchedText).toContain("Delivery: not auto-delivered; recovered by this snapshot.");
	});
});

describe("running task progress in wait and jobs rows", () => {
	const pendingRuns: PromiseWithResolvers<AsyncJobRunResult>[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		for (const pending of pendingRuns.splice(0)) pending.resolve({ text: "done" });
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	/** Register a job that stays running, optionally after reporting one task progress record. */
	async function registerRunningJob(
		manager: AsyncJobManager,
		type: "task" | "bash",
		label: string,
		progressRecord?: Record<string, unknown>,
	): Promise<string> {
		const pending = Promise.withResolvers<AsyncJobRunResult>();
		pendingRuns.push(pending);
		const reported = Promise.withResolvers<void>();
		const jobId = manager.register(
			type,
			label,
			async ({ jobId, reportProgress }) => {
				if (progressRecord) await reportProgress("running", { progress: [{ ...progressRecord, id: jobId }] });
				reported.resolve();
				return pending.promise;
			},
			{ ownerId: SELF_ID },
		);
		await reported.promise;
		return jobId;
	}

	const progress = {
		requests: 90,
		cost: 18.4,
		contextTokens: 160_000,
		contextWindow: 1_000_000,
		stage: "implementing   acp\nsurface",
	};

	function renderText(manager: AsyncJobManager, jobIds: string[]): string {
		const jobs = jobIds.map(id => manager.getJob(id)!);
		const result = buildJobResult(makeSession(manager), manager, "wait", jobs, []);
		return result.content[0]?.type === "text" ? result.content[0].text : "";
	}

	test("#given a running task job with progress #when wait renders #then the Still Running row carries duration, requests, cost, context and stage", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = await registerRunningJob(manager, "task", "AcpSurface", progress);

		const row = renderText(manager, [jobId])
			.split("\n")
			.find(line => line.startsWith(`- \`${jobId}\``));

		expect(row).toMatch(
			new RegExp(
				`^- \`${jobId}\` \\[task\\] — AcpSurface — \\S+ · 90 req · \\$18\\.40 · ctx 160K/1M · stage: implementing acp surface$`,
			),
		);
	});

	test("#given a running bash job and a running task job without a progress record #when wait renders #then both rows are exactly the id, type and label", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const bashId = await registerRunningJob(manager, "bash", "bun test");
		const taskId = await registerRunningJob(manager, "task", "Quiet");

		const rows = renderText(manager, [bashId, taskId])
			.split("\n")
			.filter(line => line.startsWith("- `"));

		expect(rows).toEqual([`- \`${bashId}\` [bash] — bun test`, `- \`${taskId}\` [task] — Quiet`]);
	});

	test("#given a batch job whose job id collided #when wait renders #then its row shows its own agent's progress, not the batch's first record", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		// A running job already holds `Beta`, so the batch's Beta job is registered as `Beta-2`
		// while its agent id (and its progress record's id) stays `Beta`.
		const holder = Promise.withResolvers<AsyncJobRunResult>();
		pendingRuns.push(holder);
		manager.register("task", "holder", async () => holder.promise, { ownerId: SELF_ID, id: "Beta" });
		const pending = Promise.withResolvers<AsyncJobRunResult>();
		pendingRuns.push(pending);
		const reported = Promise.withResolvers<void>();
		const batch = [
			{ id: "Alpha", requests: 7, stage: "alpha stage" },
			{ id: "Beta", requests: 42, stage: "beta stage" },
		];
		const jobId = manager.register(
			"task",
			"Beta",
			async ({ reportProgress }) => {
				await reportProgress("running", { progress: batch });
				reported.resolve();
				return pending.promise;
			},
			{ ownerId: SELF_ID, id: "Beta", agentId: "Beta" },
		);
		await reported.promise;
		expect(jobId).toBe("Beta-2");

		const row = renderText(manager, [jobId])
			.split("\n")
			.find(line => line.startsWith(`- \`${jobId}\``));

		expect(row).toMatch(/ — \S+ · 42 req · stage: beta stage$/);
	});

	test("#given a running task whose cost is below one cent #when wait renders #then the cost reads <$0.01, not $0.00", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = await registerRunningJob(manager, "task", "Cheap", { requests: 2, cost: 0.0031 });

		const row = renderText(manager, [jobId])
			.split("\n")
			.find(line => line.startsWith(`- \`${jobId}\``));

		expect(row).toMatch(/ — \S+ · 2 req · <\$0\.01$/);
	});
});
