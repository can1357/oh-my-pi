/**
 * Owner-routed async delivery + quiescence (structured concurrency for
 * background jobs): each AgentSession registers a delivery sink for its own
 * agent id, owned job completions inject async-result follow-up turns into
 * THAT session, and `hasPendingAsyncWork()` / `settleAsyncWork()` define the
 * run quiescence the task executor's barrier is built on.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	buildAsyncResultBatchMessage,
	type AsyncResultEntry,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function observeAsyncResultEnqueue(session: AgentSession): Promise<void> {
	const queued = Promise.withResolvers<void>();
	const enqueue = session.yieldQueue.enqueueWithReceipt.bind(session.yieldQueue);
	vi.spyOn(session.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
		const receipt = enqueue(kind, entry);
		if (kind === "async-result") queued.resolve();
		return receipt;
	});
	return queued.promise;
}

describe("AgentSession owner-routed async delivery", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		AsyncJobManager.resetForTests();
	});

	it("injects an owned completion as a follow-up turn and reaches quiescence", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "sub-job", ownerId: "SubAgent" });

		// A running owned job holds the session out of quiescence.
		expect(session.hasPendingAsyncWork()).toBe(true);

		gate.resolve("job finished: ALL GREEN");
		await session.settleAsyncWork();

		// The completion routed to THIS session (not a global default sink) and
		// ran as a follow-up turn whose context carries the job result.
		expect(session.hasPendingAsyncWork()).toBe(false);
		const sawResult = mock.calls.some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("ALL GREEN");
				}
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("ALL GREEN"))
				);
			}),
		);
		expect(sawResult).toBe(true);
	});

	it("carries a schema-valid background task's structured output as a pointer only", () => {
		const job: AsyncJob = {
			id: "SchemaProbe",
			type: "task",
			status: "completed",
			startTime: Date.now(),
			label: "SchemaProbe",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			resultText: "done",
			structured: { source: "caller", mode: "permissive", status: "valid", data: { summary: "ok", count: 7 } },
		};
		const entry: AsyncResultEntry = {
			jobId: "SchemaProbe",
			result: "done",
			job,
			durationMs: 1000,
			epoch: 0,
		};
		const message = buildAsyncResultBatchMessage([entry]);
		expect(message?.details?.jobs[0]?.schema).toEqual({
			source: "caller",
			mode: "permissive",
			status: "valid",
			data: { summary: "ok", count: 7 },
		});
		expect(message?.content).toContain("schema valid");
		expect(message?.content).toContain("agent://SchemaProbe");
		expect(message?.content).not.toContain("```json");
	});

	it("advertises the agent:// URL using the task's agent id, not a disambiguated job id", () => {
		// Regression: AsyncJobManager suffixes a requested job id when it
		// collides with another live job (e.g. a task id reusing a vibe turn's
		// job id), but the task's artifacts are still written under its own
		// unsuffixed agent id. Advertising the suffixed job id points at a
		// handle with no backing `<id>.md`/`.json` on disk (PR #10625 review).
		const job: AsyncJob = {
			id: "Foo-t1-2",
			agentId: "Foo-t1",
			type: "task",
			status: "completed",
			startTime: Date.now(),
			label: "Foo-t1",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			resultText: "done",
			structured: { source: "caller", mode: "permissive", status: "valid", data: { summary: "ok" } },
		};
		const entry: AsyncResultEntry = {
			jobId: "Foo-t1-2",
			result: "done",
			job,
			durationMs: 1000,
			epoch: 0,
		};
		const message = buildAsyncResultBatchMessage([entry]);
		expect(message?.content).toContain("agent://Foo-t1,");
		expect(message?.content).not.toContain("agent://Foo-t1-2");
	});

	it("carries a schema-invalid background task's parsed payload as both a pointer and an inline preview", () => {
		// Regression: an invalid result's data is now also persisted to the
		// `<id>.json` sidecar (PR #10625 review), so the delivery must
		// advertise the same `agent://` recovery pointer as a valid result,
		// not just the size-capped inline preview (which alone would be the
		// only model-visible copy for oversized payloads).
		const job: AsyncJob = {
			id: "SchemaProbe",
			type: "task",
			status: "completed",
			startTime: Date.now(),
			label: "SchemaProbe",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			resultText: "done",
			structured: {
				source: "caller",
				mode: "strict",
				status: "invalid",
				error: "missing required field 'count'",
				data: { summary: "ok" },
			},
		};
		const entry: AsyncResultEntry = {
			jobId: "SchemaProbe",
			result: "done",
			job,
			durationMs: 1000,
			epoch: 0,
		};
		const message = buildAsyncResultBatchMessage([entry]);
		expect(message?.details?.jobs[0]?.schema).toEqual({
			source: "caller",
			mode: "strict",
			status: "invalid",
			error: "missing required field 'count'",
			data: { summary: "ok" },
		});
		expect(message?.content).toMatch(/```json[\s\S]*"summary": "ok"[\s\S]*```/);
		expect(message?.content).toContain("missing required field 'count'");
		expect(message?.content).toContain("full payload at agent://SchemaProbe");
	});

	it("omits the agent:// pointer for an invalid result with no data to recover", () => {
		const job: AsyncJob = {
			id: "SchemaProbe",
			type: "task",
			status: "completed",
			startTime: Date.now(),
			label: "SchemaProbe",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			resultText: "done",
			structured: {
				source: "caller",
				mode: "strict",
				status: "invalid",
				error: "subagent yielded no data",
			},
		};
		const entry: AsyncResultEntry = {
			jobId: "SchemaProbe",
			result: "done",
			job,
			durationMs: 1000,
			epoch: 0,
		};
		const message = buildAsyncResultBatchMessage([entry]);
		expect(message?.content).not.toContain("agent://SchemaProbe");
		expect(message?.content).toContain("subagent yielded no data");
	});

	it("routes an advisor-owned launch completion through the session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const owner = `${sessionManager.getSessionId()}-advisor`;
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const completion = {
			event: "daemon-completed",
			completionId: "advisor-completion",
			owner,
			daemon: {
				name: "advisor-worker",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;

		await session.queueLaunchCompletion(completion);
		await session.waitForIdle();

		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("advisor-worker")
						: message.content.some(content => content.type === "text" && content.text.includes("advisor-worker")),
				),
			),
		).toBe(true);
	});

	it("purges finished owned jobs when starting a new session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const completedJobId = manager.register("task", "prior session", async () => "done", {
			id: "prior-session-job",
			ownerId: "Main",
		});
		const failedJobId = manager.register(
			"task",
			"failed prior session",
			async () => {
				throw new Error("prior session failure");
			},
			{
				id: "failed-prior-session-job",
				ownerId: "Main",
			},
		);
		const otherOwnerJobId = manager.register("task", "other session", async () => "done", {
			id: "other-session-job",
			ownerId: "Other",
		});
		manager.watchJobs([completedJobId, failedJobId, otherOwnerJobId]);
		await manager.waitForAll();

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(failedJobId)?.status).toBe("failed");
		expect(await session.newSession()).toBe(true);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(failedJobId)).toBeUndefined();
		expect(manager.getJob(otherOwnerJobId)?.status).toBe("completed");
	});

	it("does not inject a prior session's pending async result after a new session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		const resultQueued = observeAsyncResultEnqueue(session);

		// Complete a job while no turn is available to inject its queued result.
		// The job body stays retained until either the queue commits it or a hub
		// snapshot recovers it.
		manager.register("task", "prior session", async () => "STALE ASYNC RESULT", {
			id: "prior-session-job",
			ownerId: "Main",
		});
		await manager.waitForOwnerJobs("Main");
		await resultQueued;
		expect(session.hasPendingAsyncWork()).toBe(true);

		expect(await session.newSession()).toBe(true);
		await manager.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Main" } });
		expect(session.hasPendingAsyncWork()).toBe(false);

		// A fresh turn in the replacement session must not carry the prior result.
		const callsBefore = mock.calls.length;
		await session.sendUserMessage("fresh turn");
		const leaked = mock.calls.slice(callsBefore).some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") return message.content.includes("STALE ASYNC RESULT");
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("STALE ASYNC RESULT"))
				);
			}),
		);
		expect(leaked).toBe(false);
	});

	it("drops a prior session's late delivery even after its job id is reused", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		// The delivery generation starts at 0; a new session bumps it to 1.
		expect(await session.newSession()).toBe(true);

		// Simulate a delivery that finished formatting in the prior session (epoch
		// 0) but only reaches the yield queue after the transition — the exact
		// window a reused job id would reopen by clearing the manager's per-id
		// suppression marker. It must not inject into the replacement transcript.
		session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
			jobId: "bg_1",
			result: "STALE ASYNC RESULT",
			job: undefined,
			durationMs: 0,
			epoch: 0,
		});

		const callsBefore = mock.calls.length;
		await session.sendUserMessage("fresh turn");
		await session.settleAsyncWork();
		const leaked = mock.calls.slice(callsBefore).some(call =>
			call.context.messages.some(message => {
				if (typeof message.content === "string") return message.content.includes("STALE ASYNC RESULT");
				return (
					Array.isArray(message.content) &&
					message.content.some(content => content.type === "text" && content.text.includes("STALE ASYNC RESULT"))
				);
			}),
		);
		expect(leaked).toBe(false);
		// The stale entry was consumed by the run's aside/flush path and dropped,
		// not left lingering as pending work.
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("keeps delivery pending until the queued follow-up is injected", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		const resultQueued = observeAsyncResultEnqueue(session);
		const gate = Promise.withResolvers<string>();
		manager.register("bash", "gated job", () => gate.promise, { id: "sub-job", ownerId: "SubAgent" });
		gate.resolve("job finished: QUEUED RESULT");
		await manager.waitForOwnerJobs("SubAgent");

		await resultQueued;
		expect(session.hasPendingAsyncWork()).toBe(true);
		expect(manager.isJobResultConsumed("sub-job")).toBe(false);

		await session.settleAsyncWork();

		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(manager.isJobResultConsumed("sub-job")).toBe(true);
		expect(mock.calls.some(call => JSON.stringify(call.context.messages).includes("QUEUED RESULT"))).toBe(true);
	});

	it("keeps the event loop live until a delayed idle flush runs", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
			asyncJobManager: manager,
		});

		let flushed = false;
		session.yieldQueue.register("keepalive-probe", {
			isStale: () => {
				flushed = true;
				return true;
			},
			build: () => null,
		});
		vi.useFakeTimers();
		const baselineTimers = vi.getTimerCount();
		session.yieldQueue.enqueue("keepalive-probe", {});

		// The 1ms flush timer and a keepalive must both remain armed until the
		// flush runs. Without the keepalive, Bun can park here until unrelated
		// TTY I/O wakes the loop.
		expect(vi.getTimerCount()).toBeGreaterThanOrEqual(baselineTimers + 2);

		vi.advanceTimersByTime(1);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(flushed).toBe(true);
		expect(vi.getTimerCount()).toBe(baselineTimers + 1);
	});
});
