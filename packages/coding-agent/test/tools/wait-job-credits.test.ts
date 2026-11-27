/**
 * A detached task whose result a `wait` snapshot takes over never gets an
 * `async-result` push, so the snapshot must carry the job's credits — once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { buildJobResult } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { CoordinationDetails, JobSnapshot } from "@oh-my-pi/pi-coding-agent/tools/details/wait";
import { TempDir } from "@oh-my-pi/pi-utils";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: { get: () => undefined },
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	return stub as unknown as ToolSession;
}

const usage: Usage = {
	input: 5,
	output: 7,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 15,
	cost: { input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.75 },
	aiu: { nano: 33 },
};

/** A task job that reported its billed child usage and settled. */
async function settledChargedTask(manager: AsyncJobManager, id: string): Promise<string> {
	const jobId = manager.register(
		"task",
		id,
		async ({ jobId, reportProgress }) => {
			await reportProgress("done", { progress: [{ id: jobId, usage, aiuUnreportedTurns: 2 }] });
			return { text: "<task-result>done</task-result>" };
		},
		{ ownerId: SELF_ID, agentId: id },
	);
	await manager.getJob(jobId)!.promise;
	return jobId;
}

function waitResult(manager: AsyncJobManager, jobId: string): AgentToolResult<CoordinationDetails> {
	return buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
}

function row(result: AgentToolResult<CoordinationDetails>): JobSnapshot {
	const job = result.details?.jobs?.[0];
	if (!job) throw new Error("expected a job row");
	return job;
}

function persist(sessionManager: SessionManager, result: AgentToolResult<CoordinationDetails>, callId: string): void {
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName: "wait",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
}

describe("credits of a background task consumed by wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("the snapshot that wins the hand-off carries the credits and a repeat snapshot does not", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = await settledChargedTask(manager, "Charged");

		const first = waitResult(manager, jobId);
		expect(row(first)).toMatchObject({ id: jobId, usage: { aiu: { nano: 33 } }, aiuUnreportedTurns: 2 });

		// The job is consumed now: a second snapshot reports state only.
		const second = waitResult(manager, jobId);
		expect(row(second)?.usage).toBeUndefined();
		expect(row(second)?.aiuUnreportedTurns).toBeUndefined();

		const sessionManager = SessionManager.inMemory();
		persist(sessionManager, first, "wait-1");
		persist(sessionManager, second, "wait-2");
		// Credits are the only roll-up; the job's tokens and dollars never were session totals.
		expect(sessionManager.getUsageStatistics()).toMatchObject({ aiuNano: 33, cost: 0, subagentCost: 0 });
	});

	test("a job whose push already delivered it adds nothing when a later snapshot reports it", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = await settledChargedTask(manager, "Pushed");
		// The delivery sink consumed the result (its async-result message carries the credits).
		manager.consumeJobResults([jobId]);

		const result = waitResult(manager, jobId);
		expect(row(result)?.usage).toBeUndefined();
		const sessionManager = SessionManager.inMemory();
		persist(sessionManager, result, "wait-1");
		expect(sessionManager.getUsageStatistics().aiuNano).toBeUndefined();
	});

	test("a still-running job carries nothing, and the later wait that consumes it carries the credits", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"Slow",
			async ({ jobId, reportProgress }) => {
				await reportProgress("running", { progress: [{ id: jobId, usage, aiuUnreportedTurns: 2 }] });
				await release.promise;
				return { text: "<task-result>done</task-result>" };
			},
			{ ownerId: SELF_ID, agentId: "Slow" },
		);

		const running = waitResult(manager, jobId);
		expect(row(running)?.status).toBe("running");
		expect(row(running)?.usage).toBeUndefined();

		release.resolve();
		await manager.getJob(jobId)!.promise;
		expect(row(waitResult(manager, jobId)).usage?.aiu?.nano).toBe(33);
	});

	test("a fork that resets inherited billing does not inherit the consumed job's credits", async () => {
		using tempDir = TempDir.createSync("@omp-wait-credits-fork-");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = await settledChargedTask(manager, "Inherited");
		const timestamp = new Date(Date.now() - 60_000).toISOString();
		const result = waitResult(manager, jobId);
		const lines = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "wait-source", timestamp, cwd: tempDir.path() },
			{
				type: "message",
				id: "wait-1",
				parentId: null,
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "wait",
					content: result.content,
					details: result.details,
					isError: false,
					timestamp: Date.parse(timestamp),
				},
			},
		];
		const sourceFile = tempDir.join("sessions", "source.jsonl");
		await Bun.write(sourceFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);

		const kept = await SessionManager.forkFrom(sourceFile, tempDir.path(), tempDir.join("kept"), undefined, {
			suppressBreadcrumb: true,
		});
		const reset = await SessionManager.forkFrom(sourceFile, tempDir.path(), tempDir.join("reset"), undefined, {
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});

		expect(kept.getUsageStatistics().aiuNano).toBe(33);
		expect(reset.getUsageStatistics().aiuNano).toBeUndefined();
	});
});
