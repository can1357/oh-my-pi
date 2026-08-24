/**
 * Owner-routed async delivery + quiescence (structured concurrency for
 * background jobs): each AgentSession registers a delivery sink for its own
 * agent id, owned job completions inject async-result follow-up turns into
 * THAT session, and `hasPendingAsyncWork()` / `settleAsyncWork()` define the
 * run quiescence the task executor's barrier is built on.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
	type ProgressLine,
	ProgressLines,
	progressStreamProvenanceForText,
} from "@oh-my-pi/pi-coding-agent/async/progress-lines";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient, DaemonCompletionUnregisterOptions } from "@oh-my-pi/pi-coding-agent/launch/client";
import type {
	DaemonCompletionNotification,
	DaemonMonitorNotification,
	DaemonOperation,
	DaemonOutputNotification,
	DaemonOutputSubscription,
	DaemonRpcResult,
	DaemonSnapshot,
	DaemonSpec,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { DAEMON_OUTPUT_MONITOR_CAPABILITY } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	ASYNC_PROGRESS_WAKE_QUEUE_KIND,
	type AsyncProgressEntry,
	buildAsyncResultBatchMessage,
	type AsyncResultEntry,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { LaunchContextBoundary, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { executeLaunch } from "@oh-my-pi/pi-coding-agent/tools/hub/launch";
import { TempDir } from "@oh-my-pi/pi-utils";

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

	it("delivers background text and images to the owning model and reaches quiescence", async () => {
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

		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
		};
		const gate = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"gated job",
			async ({ reportProgress }) => {
				const text = await gate.promise;
				await reportProgress(text, { images: [image] });
				return text;
			},
			{ id: "sub-job", ownerId: "SubAgent" },
		);

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
		const deliveredImages = mock.calls.flatMap(call =>
			call.context.messages.flatMap(message =>
				typeof message.content === "string" ? [] : message.content.filter(part => part.type === "image"),
			),
		);
		expect(deliveredImages).toEqual([image]);
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

	it("settles each wake process event then parks again while its monitor remains active", async () => {
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
		});
		const monitorEpoch = session.captureLaunchProgressEpoch();
		session.setLaunchMonitorActive("monitor-1", "wake", true, monitorEpoch);
		await session.prompt("start monitoring");
		expect(session.hasPendingAsyncWork()).toBe(true);
		let settled = false;
		const settling = session.settleAsyncWork().then(() => {
			settled = true;
		});
		await Bun.sleep(1);
		expect(settled).toBe(false);

		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "monitor-1",
				name: "watched",
				daemonId: "daemon-1",
				seq: 1,
				text: "PUSHED WHILE SETTLING",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"wake",
			Date.now(),
			monitorEpoch,
		);
		await settling;
		expect(session.hasPendingAsyncWork()).toBe(true);
		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("PUSHED WHILE SETTLING")
						: message.content.some(
								content => content.type === "text" && content.text.includes("PUSHED WHILE SETTLING"),
							),
				),
			),
		).toBe(true);

		let settledAgain = false;
		const settlingAgain = session.settleAsyncWork().then(() => {
			settledAgain = true;
		});
		await Bun.sleep(1);
		expect(settledAgain).toBe(false);

		session.setLaunchMonitorActive("monitor-1", "wake", false, monitorEpoch);
		await settlingAgain;
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	it("keeps an ambient process monitor alive until its terminal cleanup", async () => {
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "SubAgent",
		});
		const monitorEpoch = session.captureLaunchProgressEpoch();
		session.setLaunchMonitorActive("monitor-ambient", "ambient", true, monitorEpoch);
		await session.prompt("start ambient monitoring");
		const callsBeforeSettlement = mock.calls.length;
		expect(session.hasPendingAsyncWork()).toBe(true);
		let settled = false;
		const settling = session.settleAsyncWork().then(() => {
			settled = true;
		});
		await Bun.sleep(1);
		expect(settled).toBe(false);
		expect(mock.calls).toHaveLength(callsBeforeSettlement);

		session.setLaunchMonitorActive("monitor-ambient", "ambient", false, monitorEpoch);
		await settling;
		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(mock.calls).toHaveLength(callsBeforeSettlement);
	});

	it("fences old process progress while switching to another session", async () => {
		using tempDir = TempDir.createSync("@omp-launch-progress-switch-");
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
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "old session", timestamp: 1 });
		await sessionManager.flush();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target session", timestamp: 2 });
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const oldMonitorEpoch = session.captureLaunchProgressEpoch();
		session.setLaunchMonitorActive("old-monitor", "wake", true, oldMonitorEpoch);
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "old-ambient-monitor",
				name: "old-ambient-process",
				daemonId: "old-ambient-daemon",
				seq: 1,
				text: "QUEUED OLD AMBIENT EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
			oldMonitorEpoch,
		);
		session.setSessionBeforeSwitchReconciler(async () => {
			session.queueLaunchProgress(
				{
					event: "daemon-output",
					monitorId: "old-monitor",
					name: "old-process",
					daemonId: "old-daemon",
					seq: 1,
					text: "OLD SESSION PROCESS EVENT",
					batchKind: "progress",
					suppressedEvents: 0,
				},
				"wake",
				Date.now(),
				oldMonitorEpoch,
			);
		});

		await expect(session.switchSession(targetFile)).resolves.toBe(true);
		session.setLaunchMonitorActive("old-monitor", "wake", true, oldMonitorEpoch);
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "old-monitor",
				name: "old-process",
				daemonId: "old-daemon",
				seq: 2,
				text: "LATE OLD SESSION PROCESS EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"wake",
			Date.now(),
			oldMonitorEpoch,
		);
		const newMonitorEpoch = session.captureLaunchProgressEpoch();
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "new-monitor",
				name: "new-process",
				daemonId: "new-daemon",
				seq: 1,
				text: "FRESH SESSION PROCESS EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
			newMonitorEpoch,
		);
		await session.sendUserMessage("inspect target");

		expect(session.hasPendingAsyncWork()).toBe(false);
		const observedText = mock.calls
			.flatMap(call =>
				call.context.messages.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
				),
			)
			.join("\n");
		expect(observedText).not.toContain("OLD SESSION PROCESS EVENT");
		expect(observedText).not.toContain("QUEUED OLD AMBIENT EVENT");
		expect(observedText).not.toContain("LATE OLD SESSION PROCESS EVENT");
		expect(observedText).toContain("FRESH SESSION PROCESS EVENT");
	});

	it("keeps process progress deliverable when a session switch rolls back", async () => {
		using sourceDir = TempDir.createSync("@omp-launch-progress-rollback-source-");
		using targetDir = TempDir.createSync("@omp-launch-progress-rollback-target-");
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
		const sessionManager = SessionManager.create(sourceDir.path(), sourceDir.path());
		sessionManager.appendMessage({ role: "user", content: "source session", timestamp: 1 });
		await sessionManager.flush();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target session", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const monitorEpoch = session.captureLaunchProgressEpoch();
		const notification = (seq: number, text: string) => ({
			event: "daemon-output" as const,
			monitorId: "monitor",
			name: "process",
			daemonId: "daemon",
			seq,
			text,
			batchKind: "progress" as const,
			suppressedEvents: 0,
		});
		session.queueLaunchProgress(
			notification(1, "QUEUED BEFORE ROLLED-BACK SWITCH"),
			"ambient",
			Date.now(),
			monitorEpoch,
		);

		// The cwd callback rejects the adoption, so the switch unwinds to the
		// still-live source transcript; its monitors must keep delivering.
		await expect(session.switchSession(targetFile, { onCwdChange: async () => false })).resolves.toBe(false);
		expect(session.captureLaunchProgressEpoch()).toBe(monitorEpoch);
		session.queueLaunchProgress(
			notification(2, "QUEUED AFTER ROLLED-BACK SWITCH"),
			"ambient",
			Date.now(),
			monitorEpoch,
		);
		await session.sendUserMessage("continue");

		const observedText = mock.calls
			.flatMap(call =>
				call.context.messages.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
				),
			)
			.join("\n");
		expect(observedText).toContain("QUEUED BEFORE ROLLED-BACK SWITCH");
		expect(observedText).toContain("QUEUED AFTER ROLLED-BACK SWITCH");
	});

	it("drops artifact-only launch progress batches without queueing or waking", async () => {
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const epoch = session.captureLaunchProgressEpoch();
		const notification = (seq: number, batchKind: "artifact-only" | "progress", text: string) => ({
			event: "daemon-output" as const,
			monitorId: "monitor",
			name: "process",
			daemonId: "daemon",
			seq,
			text,
			batchKind,
			suppressedEvents: 0,
		});

		// Rate-limited broker windows arrive as artifact-only batches: they exist
		// to advance artifact delivery and carry nothing the model should see.
		session.queueLaunchProgress(notification(1, "artifact-only", ""), "ambient", Date.now(), epoch);
		session.queueLaunchProgress(notification(2, "artifact-only", ""), "wake", Date.now(), epoch);
		expect(session.yieldQueue.has("async-progress")).toBe(false);
		expect(session.yieldQueue.has(ASYNC_PROGRESS_WAKE_QUEUE_KIND)).toBe(false);
		await session.yieldQueue.idleFlushSettled();
		expect(mock.calls).toHaveLength(0);

		// The next permitted window still reaches the model.
		session.queueLaunchProgress(notification(3, "progress", "ambient"), "ambient", Date.now(), epoch);
		expect(session.yieldQueue.has("async-progress")).toBe(true);
		session.queueLaunchProgress(notification(4, "progress", "WAKE AFTER ARTIFACT-ONLY"), "wake", Date.now(), epoch);
		await session.yieldQueue.idleFlushSettled();
		await session.waitForIdle();
		expect(mock.calls.length).toBeGreaterThan(0);
		const observedText = mock.calls
			.flatMap(call =>
				call.context.messages.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
				),
			)
			.join("\n");
		expect(observedText).toContain("WAKE AFTER ARTIFACT-ONLY");
	});

	it("fences process progress and completions while resetting the session context", async () => {
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
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const oldMonitorEpoch = session.captureLaunchProgressEpoch();
		session.setLaunchMonitorActive("monitor-reset", "ambient", true, oldMonitorEpoch);
		const owner = sessionManager.getSessionId();
		const completionDaemon = {
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
		} as const;

		const refreshStarted = Promise.withResolvers<void>();
		const releaseRefresh = Promise.withResolvers<void>();
		vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async () => {
			refreshStarted.resolve();
			await releaseRefresh.promise;
		});

		const staleCompletion = session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "old-reset-completion",
			owner,
			daemon: { ...completionDaemon, name: "old-reset-process", id: "old-daemon" },
		});
		const reset = session.resetSessionContext();
		await refreshStarted.promise;
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "monitor-reset",
				name: "old-reset-process",
				daemonId: "old-daemon",
				seq: 1,
				text: "OLD RESET PROCESS EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
			oldMonitorEpoch,
		);
		// The completion was queued immediately before reset. Its old epoch is
		// discovered only when the delayed yield flush crosses the reset boundary.
		releaseRefresh.resolve();
		await expect(reset).resolves.toEqual({ droppedCount: 0 });
		const freshMonitorEpoch = session.captureLaunchProgressEpoch();

		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "monitor-reset",
				name: "fresh-reset-process",
				daemonId: "fresh-daemon",
				seq: 2,
				text: "FRESH RESET PROCESS EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
			freshMonitorEpoch,
		);
		await session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "fresh-reset-completion",
			owner,
			daemon: { ...completionDaemon, name: "fresh-reset-process", id: "fresh-daemon" },
		});
		await staleCompletion;
		await session.waitForIdle();

		const observedText = mock.calls
			.flatMap(call =>
				call.context.messages.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
				),
			)
			.join("\n");
		expect(observedText).not.toContain("OLD RESET PROCESS EVENT");
		expect(observedText).not.toContain("old-reset-process");
		expect(observedText).toContain("FRESH RESET PROCESS EVENT");
		expect(observedText).toContain("fresh-reset-process");
	});

	it("tears down a live Hub monitor and discards its completion at a same-ID context reset", async () => {
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
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const owner = sessionManager.getSessionId();
		const daemon: DaemonSnapshot = {
			name: "web",
			id: "daemon-id",
			state: "running",
			pid: 123,
			createdAt: 1,
			startedAt: 2,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: true,
			detached: false,
		};
		const spec: DaemonSpec = {
			name: daemon.name,
			application: process.execPath,
			args: [],
			env: {},
			cwd: process.cwd(),
			pty: false,
			restart: "no",
			persist: true,
			detached: false,
		};

		// A broker client stub that records what the session does to its
		// subscriptions; the real broker drops the watcher from ps/describe as
		// soon as the output subscription is unregistered (see
		// test/launch/broker-monitor-progress.test.ts).
		const requests: DaemonOperation[] = [];
		const completionUnregisters: DaemonCompletionUnregisterOptions[] = [];
		let completionRegistrations = 0;
		let outputSink: ((notification: DaemonMonitorNotification) => void | Promise<void>) | undefined;
		let subscription: DaemonOutputSubscription | undefined;
		let outputUnregisters = 0;
		const client = {
			projectDir: process.cwd(),
			onCompletion: () => {
				completionRegistrations++;
				return (options?: DaemonCompletionUnregisterOptions) => {
					completionUnregisters.push(options ?? {});
				};
			},
			onOutput: (
				registered: DaemonOutputSubscription,
				sink: (notification: DaemonMonitorNotification) => void | Promise<void>,
			) => {
				subscription = registered;
				outputSink = sink;
				return Object.assign(
					() => {
						outputUnregisters++;
						if (subscription === registered) subscription = undefined;
						if (outputSink === sink) outputSink = undefined;
					},
					{ ready: Promise.resolve(), republish: () => {} },
				);
			},
			request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
				requests.push(operation);
				if (operation.op === "ping") {
					return { op: "ping", projectDir: process.cwd(), capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY] };
				}
				if (operation.op === "describe") return { op: "describe", daemon, spec };
				throw new Error(`Unexpected operation: ${operation.op}`);
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		// The same adapter the SDK installs between the hub tool and the session.
		const live = session;
		const toolSession = {
			cwd: process.cwd(),
			settings: { get: () => undefined },
			allocateOutputArtifact: async () => ({ id: "hub-progress-reset", path: "/dev/null" }),
			getSessionId: () => live.sessionManager.getSessionId(),
			isDisposed: () => live.isDisposed,
			captureLaunchProgressEpoch: () => live.captureLaunchProgressEpoch(),
			queueLaunchProgress: (
				notification: DaemonOutputNotification,
				delivery: "wake" | "ambient",
				startedAt: number,
				epoch: number,
				artifactId?: string,
			) => live.queueLaunchProgress(notification, delivery, startedAt, epoch, artifactId),
			queueLaunchCompletion: (notification: DaemonCompletionNotification) =>
				live.queueLaunchCompletion(notification),
			setLaunchMonitorActive: (monitorId: string, delivery: "wake" | "ambient", active: boolean, epoch: number) =>
				live.setLaunchMonitorActive(monitorId, delivery, active, epoch),
			registerDisposeCallback: () => () => {},
			registerContextBoundaryCallback: (callback: (boundary: LaunchContextBoundary) => void) =>
				live.registerContextBoundaryCallback(callback),
		} as unknown as ToolSession;

		await executeLaunch(toolSession, { op: "monitor", name: daemon.name, progress: "ambient" });
		if (!subscription || !outputSink) throw new Error("Expected a live output subscription");
		const monitorId = subscription.id;
		expect(completionRegistrations).toBe(1);
		expect(session.hasPendingAsyncWork()).toBe(true);
		await outputSink({
			event: "daemon-output",
			monitorId,
			name: daemon.name,
			daemonId: daemon.id,
			seq: 1,
			text: "OUTPUT BEFORE RESET",
			batchKind: "progress",
			suppressedEvents: 0,
		});
		expect(session.yieldQueue.has("async-progress")).toBe(true);

		// /clear keeps the session id, so no session-change hook can fire: the
		// boundary itself must release the broker subscription, the owner's
		// completion sink, and the quiescence bookkeeping.
		await expect(session.resetSessionContext()).resolves.toEqual({ droppedCount: 0 });
		expect(sessionManager.getSessionId()).toBe(owner);
		expect(outputUnregisters).toBe(1);
		expect(subscription).toBeUndefined();
		expect(outputSink).toBeUndefined();
		expect(completionUnregisters).toEqual([{ preservePending: false }]);
		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(requests.some(operation => operation.op === "stop")).toBe(false);

		// Output queued before the boundary never reaches the emptied context.
		await session.sendUserMessage("after reset");
		const observedText = mock.calls
			.flatMap(call =>
				call.context.messages.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
				),
			)
			.join("\n");
		expect(observedText).not.toContain("OUTPUT BEFORE RESET");

		// A fresh monitor after the reset registers cleanly under the same owner.
		await executeLaunch(toolSession, { op: "monitor", name: daemon.name, progress: "ambient" });
		expect(completionRegistrations).toBe(2);
		expect(subscription).toBeDefined();
		expect(session.hasPendingAsyncWork()).toBe(true);
	});

	it("reports the boundary kind to launch cleanups and skips reversible transitions", async () => {
		using tempDir = TempDir.createSync("@omp-launch-boundary-kinds-");
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
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "old session", timestamp: 1 });
		await sessionManager.flush();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const boundaries: LaunchContextBoundary[] = [];
		const cleanup = vi.fn((boundary: LaunchContextBoundary) => {
			boundaries.push(boundary);
		});
		session.registerContextBoundaryCallback(cleanup);

		// A fork that produces nothing keeps the conversation live.
		const originalId = sessionManager.getSessionId();
		const fork = vi.spyOn(sessionManager, "fork").mockResolvedValue(undefined);
		await expect(session.fork()).resolves.toBe(false);
		fork.mockRestore();
		expect(sessionManager.getSessionId()).toBe(originalId);
		expect(cleanup).not.toHaveBeenCalled();

		// Same id, wiped transcript.
		await expect(session.resetSessionContext()).resolves.toEqual({ droppedCount: 0 });
		expect(sessionManager.getSessionId()).toBe(originalId);
		expect(boundaries).toEqual(["reset"]);
		// Fired once and forgotten: the next boundary does not call it again.
		await expect(session.resetSessionContext()).resolves.toEqual({ droppedCount: 0 });
		expect(cleanup).toHaveBeenCalledTimes(1);

		session.registerContextBoundaryCallback(cleanup);
		await expect(session.newSession()).resolves.toBe(true);
		expect(sessionManager.getSessionId()).not.toBe(originalId);
		expect(boundaries).toEqual(["reset", "new"]);

		session.registerContextBoundaryCallback(cleanup);
		await expect(session.fork()).resolves.toBe(true);
		expect(boundaries).toEqual(["reset", "new", "new"]);
	});

	it("keeps launch subscriptions across a switch rollback and releases them on the committed retry", async () => {
		using tempDir = TempDir.createSync("@omp-launch-progress-switch-rollback-");
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
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "old session", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected previous session file");
		const previousOwner = sessionManager.getSessionId();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target session", timestamp: 2 });
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const boundaries: LaunchContextBoundary[] = [];
		session.registerContextBoundaryCallback(boundary => boundaries.push(boundary));
		const previousEpoch = session.captureLaunchProgressEpoch();
		const completionDaemon = {
			state: "exited",
			createdAt: 1,
			startedAt: 1,
			exitedAt: 2,
			exitCode: 0,
			restartCount: 0,
			outputBytes: 0,
			owner: previousOwner,
			persist: false,
			detached: false,
		} as const;
		let rollbackCompletion: Promise<void> | undefined;
		const failure = new Error("synthetic target load failure");
		vi.spyOn(sessionManager, "setSessionFile").mockImplementationOnce(async () => {
			// Events observed while the switch is still reversible stay queued.
			session.queueLaunchProgress(
				{
					event: "daemon-output",
					monitorId: "rollback-monitor",
					name: "rollback-process",
					daemonId: "rollback-daemon",
					seq: 1,
					text: "ROLLBACK PROCESS EVENT",
					batchKind: "progress",
					suppressedEvents: 0,
				},
				"ambient",
				Date.now(),
				previousEpoch,
			);
			rollbackCompletion = session.queueLaunchCompletion({
				event: "daemon-completed",
				completionId: "rollback-completion",
				owner: previousOwner,
				daemon: { ...completionDaemon, name: "rollback-process", id: "rollback-daemon" },
			});
			throw failure;
		});

		await expect(session.switchSession(targetFile)).rejects.toBe(failure);
		expect(session.sessionFile).toBe(previousSessionFile);
		expect(session.captureLaunchProgressEpoch()).toBe(previousEpoch);
		expect(boundaries).toEqual([]);
		if (!rollbackCompletion) throw new Error("Expected rollback completion receipt");
		await rollbackCompletion;
		await session.sendUserMessage("inspect rollback");

		let successfulOldCompletion: Promise<void> | undefined;
		session.setSessionBeforeSwitchReconciler(async () => {
			session.queueLaunchProgress(
				{
					event: "daemon-output",
					monitorId: "successful-old-monitor",
					name: "successful-old-process",
					daemonId: "successful-old-daemon",
					seq: 1,
					text: "SUCCESSFUL SWITCH OLD EVENT",
					batchKind: "progress",
					suppressedEvents: 0,
				},
				"ambient",
				Date.now(),
				previousEpoch,
			);
			successfulOldCompletion = session.queueLaunchCompletion({
				event: "daemon-completed",
				completionId: "successful-old-completion",
				owner: previousOwner,
				daemon: { ...completionDaemon, name: "successful-old-process", id: "successful-old-daemon" },
			});
		});

		await expect(session.switchSession(targetFile)).resolves.toBe(true);
		expect(session.sessionFile).toBe(targetFile);
		expect(boundaries).toEqual(["switch"]);
		expect(session.captureLaunchProgressEpoch()).toBe(previousEpoch + 1);
		if (!successfulOldCompletion) throw new Error("Expected successful-switch completion receipt");
		await successfulOldCompletion;

		const freshEpoch = session.captureLaunchProgressEpoch();
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "fresh-monitor",
				name: "fresh-process",
				daemonId: "fresh-daemon",
				seq: 1,
				text: "FRESH SWITCH EVENT",
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
			freshEpoch,
		);
		await session.sendUserMessage("inspect successful switch");

		const observedText = mock.calls
			.flatMap(call =>
				call.context.messages.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
				),
			)
			.join("\n");
		expect(observedText).toContain("ROLLBACK PROCESS EVENT");
		expect(observedText).toContain("rollback-process");
		expect(observedText).not.toContain("SUCCESSFUL SWITCH OLD EVENT");
		expect(observedText).not.toContain("successful-old-process");
		expect(observedText).toContain("FRESH SWITCH EVENT");
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

	it("holds progress while idle and injects it at the next active turn", async () => {
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "progress job", () => gate.promise, { id: "progress-job", ownerId: "Main" });
		const job = manager.getJob("progress-job");
		if (!job) throw new Error("Expected registered progress job");
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: "LAZY PROGRESS MARKER",
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});

		await Promise.resolve();
		expect(mock.calls).toHaveLength(0);

		await session.sendUserMessage("inspect progress");
		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("LAZY PROGRESS MARKER")
						: message.content.some(
								content => content.type === "text" && content.text.includes("LAZY PROGRESS MARKER"),
							),
				),
			),
		).toBe(true);

		manager.watchJobs([job.id]);
		gate.resolve("done");
		await manager.waitForAll();
	});

	it("acknowledges managed ambient progress without deleting a colliding process source", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressMarker = "ACKNOWLEDGED PROGRESS MUST STAY STALE";
		const processMarker = "COLLIDING PROCESS PROGRESS MUST REMAIN";
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "acknowledged progress job", () => gate.promise, {
			id: "acknowledged-progress-job",
			ownerId: "Main",
			progressDelivery: "ambient",
		});
		const job = manager.getJob("acknowledged-progress-job");
		if (!job) throw new Error("Expected registered acknowledged progress job");
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: progressMarker,
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "colliding-process-monitor",
				name: job.id,
				daemonId: "colliding-process-daemon",
				seq: 1,
				text: processMarker,
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
			session.captureLaunchProgressEpoch(),
		);

		manager.watchJobs([job.id]);
		gate.resolve("done");
		await manager.waitForAll();
		expect(manager.getJob(job.id)?.status).toBe("completed");

		manager.acknowledgeDeliveries([job.id]);
		expect(session.yieldQueue.has("async-progress")).toBe(true);
		manager.unwatchJobs([job.id]);
		expect(manager.evictCompletedJobs({ ownerId: "Main" })).toBe(1);
		expect(manager.getJob(job.id)).toBeUndefined();

		await session.sendUserMessage("later turn after retention eviction");
		expect(
			mock.calls.every(call =>
				call.context.messages.every(message =>
					typeof message.content === "string"
						? !message.content.includes(progressMarker)
						: message.content.every(content => content.type !== "text" || !content.text.includes(progressMarker)),
				),
			),
		).toBe(true);
		expect(
			mock.calls.some(call =>
				call.context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes(processMarker)
						: message.content.some(content => content.type === "text" && content.text.includes(processMarker)),
				),
			),
		).toBe(true);
	});

	it("folds queued ambient progress into the completion-triggered flush before the result", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressMarker = "AMBIENT PROGRESS MARKER";
		const resultMarker = "AMBIENT RESULT MARKER";
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "ambient job", () => gate.promise, {
			id: "ambient-ordered-job",
			ownerId: "Main",
			progressDelivery: "ambient",
		});
		const job = manager.getJob("ambient-ordered-job");
		if (!job) throw new Error("Expected registered ambient job");
		// Ambient progress delivered while the owner idles sits on the
		// skip-idle-flush queue without waking the session.
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: progressMarker,
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});
		await Promise.resolve();
		expect(mock.calls).toHaveLength(0);

		gate.resolve(`finished: ${resultMarker}`);
		await session.settleAsyncWork();

		// The completion-triggered flush must inject the queued ambient
		// progress ahead of the completion result that references it.
		const markerIndex = (messages: (typeof mock.calls)[number]["context"]["messages"], marker: string) =>
			messages.findIndex(message =>
				typeof message.content === "string"
					? message.content.includes(marker)
					: message.content.some(content => content.type === "text" && content.text.includes(marker)),
			);
		const followUp = mock.calls.find(call => markerIndex(call.context.messages, resultMarker) >= 0);
		if (!followUp) throw new Error("Completion follow-up never reached the model");
		const progressIndex = markerIndex(followUp.context.messages, progressMarker);
		const resultIndex = markerIndex(followUp.context.messages, resultMarker);
		expect(progressIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeGreaterThan(progressIndex);
	}, 10_000);

	it("wakes an idle model for supervised process output independently of async job ids", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const marker = "SUPERVISED PROCESS WAKE";
		const wakeObserved = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const sawMarker = context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes(marker)
						: message.content.some(content => content.type === "text" && content.text.includes(marker)),
				);
				if (sawMarker) wakeObserved.resolve();
				return { content: ["Done"] };
			},
		});
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");
		// A foreground wait may suppress an async job with the same textual id.
		// Process-monitor delivery has a distinct source identity and must remain visible.
		manager.acknowledgeDeliveries(["watcher"]);
		const notification: DaemonOutputNotification = {
			event: "daemon-output",
			monitorId: "monitor-1",
			name: "watcher",
			daemonId: "daemon-1",
			seq: 1,
			text: marker,
			batchKind: "progress",
			suppressedEvents: 0,
		};
		session.queueLaunchProgress(notification, "wake", Date.now(), session.captureLaunchProgressEpoch());

		await wakeObserved.promise;
		expect(mock.calls).toHaveLength(2);
	}, 10_000);

	it("keeps a final response nonterminal when wake progress queues at the release boundary", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const marker = "BOUNDARY PROCESS WAKE";
		const wakeObserved = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes(marker)) wakeObserved.resolve();
				return { content: ["Done"] };
			},
		});
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
		let queued = false;
		const extensionRunner = {
			emit: vi.fn((event: { type: string }) => {
				if (event.type !== "agent_end" || queued) return Promise.resolve();
				queued = true;
				session.queueLaunchProgress(
					{
						event: "daemon-output",
						monitorId: "monitor-boundary",
						name: "watcher",
						daemonId: "daemon-boundary",
						seq: 1,
						text: marker,
						batchKind: "progress",
						suppressedEvents: 0,
					},
					"wake",
					Date.now(),
					session.captureLaunchProgressEpoch(),
				);
				return Promise.resolve();
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
			extensionRunner,
		});
		const terminalStates: Array<boolean | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") terminalStates.push(event.isTerminal);
		});

		await session.sendUserMessage("initialize then wait");
		await wakeObserved.promise;
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(terminalStates).toEqual([false, true]);
	}, 10_000);

	it("batches every supervised process event emitted while busy before terminal completion", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const busyStarted = Promise.withResolvers<void>();
		const releaseBusy = Promise.withResolvers<void>();
		const batchObserved = Promise.withResolvers<string>();
		let invocation = 0;
		const mock = createMockModel({
			handler: async context => {
				invocation++;
				if (invocation === 2) {
					busyStarted.resolve();
					await releaseBusy.promise;
				}
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (
					text.includes("PROCESS EVENT TWO") &&
					text.includes("PROCESS EVENT THREE") &&
					text.includes("Supervised process watcher exited")
				) {
					batchObserved.resolve(text);
				}
				return { content: ["Done"] };
			},
		});
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
		const sessionManager = SessionManager.inMemory();

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");
		const progress = (text: string, seq: number): DaemonOutputNotification => ({
			event: "daemon-output",
			monitorId: "monitor-1",
			name: "watcher",
			daemonId: "daemon-1",
			seq,
			text,
			batchKind: "progress",
			suppressedEvents: 0,
		});

		const monitorEpoch = session.captureLaunchProgressEpoch();
		session.setLaunchMonitorActive("monitor-1", "wake", true, monitorEpoch);
		session.queueLaunchProgress(progress("PROCESS EVENT ONE", 1), "wake", Date.now(), monitorEpoch);
		await busyStarted.promise;
		session.queueLaunchProgress(progress("PROCESS EVENT TWO", 2), "wake", Date.now(), monitorEpoch);
		session.queueLaunchProgress(progress("PROCESS EVENT THREE", 3), "wake", Date.now(), monitorEpoch);
		const completion = session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "completion-1",
			owner: sessionManager.getSessionId(),
			daemon: {
				name: "watcher",
				id: "daemon-1",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: sessionManager.getSessionId(),
				persist: true,
				detached: false,
			},
		});
		session.setLaunchMonitorActive("monitor-1", "wake", false, monitorEpoch);
		expect(session.hasPendingAsyncWork()).toBe(true);
		releaseBusy.resolve();

		const batch = await batchObserved.promise;
		await completion;
		expect(batch.lastIndexOf("PROCESS EVENT TWO")).toBeLessThan(batch.lastIndexOf("PROCESS EVENT THREE"));
		expect(batch.lastIndexOf("PROCESS EVENT THREE")).toBeLessThan(
			batch.lastIndexOf("Supervised process watcher exited"),
		);
		expect(mock.calls).toHaveLength(3);
		expect(session.hasPendingAsyncWork()).toBe(false);
	}, 10_000);

	it("promotes queued ambient process output ahead of the launch completion", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressMarker = "AMBIENT PROCESS OUTPUT MARKER";
		const completionMarker = "Supervised process watcher exited";
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

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});

		// Ambient monitor output while the owner idles sits on the
		// skip-idle-flush queue without waking the session.
		session.queueLaunchProgress(
			{
				event: "daemon-output",
				monitorId: "monitor-ambient",
				name: "watcher",
				daemonId: "daemon-ambient",
				seq: 1,
				text: progressMarker,
				batchKind: "progress",
				suppressedEvents: 0,
			},
			"ambient",
			Date.now(),
			session.captureLaunchProgressEpoch(),
		);
		await Promise.resolve();
		expect(mock.calls).toHaveLength(0);

		// The terminal notification's idle flush must carry the queued ambient
		// output with it, ahead of the completion — not strand it for a later
		// out-of-order turn.
		await session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "completion-ambient",
			owner: sessionManager.getSessionId(),
			daemon: {
				name: "watcher",
				id: "daemon-ambient",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: sessionManager.getSessionId(),
				persist: false,
				detached: false,
			},
		});
		await session.waitForIdle();

		const markerIndex = (messages: (typeof mock.calls)[number]["context"]["messages"], marker: string) =>
			messages.findIndex(message =>
				typeof message.content === "string"
					? message.content.includes(marker)
					: message.content.some(content => content.type === "text" && content.text.includes(marker)),
			);
		const followUp = mock.calls.find(call => markerIndex(call.context.messages, completionMarker) >= 0);
		if (!followUp) throw new Error("Launch completion follow-up never reached the model");
		const progressIndex = markerIndex(followUp.context.messages, progressMarker);
		const completionIndex = markerIndex(followUp.context.messages, completionMarker);
		expect(progressIndex).toBeGreaterThanOrEqual(0);
		expect(completionIndex).toBeGreaterThan(progressIndex);
	}, 10_000);

	it("pushes wake progress into an idle session before the job completes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const marker = "WAKE PROGRESS BEFORE COMPLETION";
		const wakeObserved = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const sawMarker = context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes(marker)
						: message.content.some(content => content.type === "text" && content.text.includes(marker)),
				);
				if (sawMarker) wakeObserved.resolve();
				return { content: ["Done"] };
			},
		});
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});

		await session.sendUserMessage("initialize then wait");
		expect(mock.calls).toHaveLength(1);

		const gate = Promise.withResolvers<string>();
		const reporter = Promise.withResolvers<(text: string) => void>();
		const jobId = manager.register(
			"bash",
			"wake progress job",
			async ({ reportAgentProgress }) => {
				reporter.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const report = await reporter.promise;
		report(marker);

		await wakeObserved.promise;
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(mock.calls).toHaveLength(2);

		manager.watchJobs([jobId]);
		gate.resolve("done");
		await manager.waitForAll();
	}, 10_000);

	it("batches every wake event queued while busy even when the job completes before the follow-up", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const busyStarted = Promise.withResolvers<void>();
		const releaseBusy = Promise.withResolvers<void>();
		const batchObserved = Promise.withResolvers<string>();
		let invocation = 0;
		const mock = createMockModel({
			handler: async context => {
				invocation += 1;
				if (invocation === 2) {
					busyStarted.resolve();
					await releaseBusy.promise;
				}
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (
					text.includes("BUSY EVENT TWO") &&
					text.includes("BUSY EVENT THREE") &&
					text.includes("BUSY COMPLETION AFTER EVENTS")
				)
					batchObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "busy batching job", () => gate.promise, {
			id: "busy-batch",
			ownerId: "Main",
			progressDelivery: "wake",
		});
		const job = manager.getJob("busy-batch");
		if (!job) throw new Error("Expected registered busy batching job");
		const progressEntry = (text: string, seq: number): AsyncProgressEntry => ({
			jobId: job.id,
			text,
			job,
			seq,
			elapsedMs: seq,
			epoch: 0,
			delivery: "wake",
		});

		session.yieldQueue.enqueue(ASYNC_PROGRESS_WAKE_QUEUE_KIND, progressEntry("BUSY EVENT ONE", 1));
		await busyStarted.promise;
		session.yieldQueue.enqueue(ASYNC_PROGRESS_WAKE_QUEUE_KIND, progressEntry("BUSY EVENT TWO", 2));
		session.yieldQueue.enqueue(ASYNC_PROGRESS_WAKE_QUEUE_KIND, progressEntry("BUSY EVENT THREE", 3));
		gate.resolve("BUSY COMPLETION AFTER EVENTS");
		await manager.waitForAll();
		releaseBusy.resolve();

		const batch = await batchObserved.promise;
		expect(batch.indexOf("BUSY EVENT TWO")).toBeLessThan(batch.indexOf("BUSY EVENT THREE"));
		expect(batch.indexOf("BUSY EVENT THREE")).toBeLessThan(batch.indexOf("BUSY COMPLETION AFTER EVENTS"));
		expect(mock.calls).toHaveLength(3);
		expect(manager.getJob(job.id)?.status).toBe("completed");
	}, 10_000);

	it("drops late progress from a prior session after its job id is reused", async () => {
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		expect(await session.newSession()).toBe(true);

		const gate = Promise.withResolvers<string>();
		manager.register("bash", "reused progress job", () => gate.promise, { id: "reused-job", ownerId: "Main" });
		const job = manager.getJob("reused-job");
		if (!job) throw new Error("Expected registered reused job");
		session.yieldQueue.enqueue<AsyncProgressEntry>("async-progress", {
			jobId: job.id,
			text: "STALE PROGRESS MARKER",
			job,
			seq: 1,
			elapsedMs: 10,
			epoch: 0,
			delivery: "ambient",
		});

		await session.sendUserMessage("fresh turn");
		expect(
			mock.calls.every(call =>
				call.context.messages.every(message =>
					typeof message.content === "string"
						? !message.content.includes("STALE PROGRESS MARKER")
						: message.content.every(
								content => content.type !== "text" || !content.text.includes("STALE PROGRESS MARKER"),
							),
				),
			),
		).toBe(true);

		manager.watchJobs([job.id]);
		gate.resolve("done");
		await manager.waitForAll();
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

	it("suppresses terminal output when streamed provenance ends with a blank record", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const firstProgressObserved = Promise.withResolvers<void>();
		const completionObserved = Promise.withResolvers<string>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes("FIRST STREAMED LINE")) firstProgressObserved.resolve();
				if (text.includes("Resume your work using the result below")) completionObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const terminalSource = "FIRST STREAMED LINE\nSECOND STREAMED LINE\n\n";
		const terminalText = `${terminalSource}\nWall time: 1.23 seconds`;
		const gate = Promise.withResolvers<{ text: string; terminalTextSource: string }>();
		const reportedProgressLines: ProgressLine[] = [];
		const samplerReady = Promise.withResolvers<ProgressLines>();
		manager.register(
			"bash",
			"multi-batch streamed job",
			async ({ reportAgentProgress }) => {
				const sampler = new ProgressLines(line => {
					reportedProgressLines.push(line);
					reportAgentProgress(line.text, {
						artifactId: "77",
						streamProvenance: line.streamProvenance,
					});
				});
				samplerReady.resolve(sampler);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const sampler = await samplerReady.promise;
		sampler.append("FIRST STREAMED LINE\n");
		await firstProgressObserved.promise;

		// The first sink delivery has completed, so this line belongs to a
		// distinct batch. Its cumulative provenance still includes batch one
		// and the following blank record, which remains absent from display.
		sampler.append("SECOND STREAMED LINE\n\n");
		gate.resolve({ text: terminalText, terminalTextSource: terminalSource });
		await manager.waitForAll();
		expect(reportedProgressLines.map(line => line.text)).toEqual(["FIRST STREAMED LINE", "SECOND STREAMED LINE"]);
		expect(reportedProgressLines.at(-1)?.streamProvenance).toEqual(progressStreamProvenanceForText(terminalSource));

		const completion = await completionObserved.promise;
		expect(completion).toContain("artifact://77");
		expect(completion).toContain("SECOND STREAMED LINE");
		// Each raw line appears once in conversation history, not again in the
		// completion's <result>; completion-only formatting is suppressed with it.
		expect(completion.split("FIRST STREAMED LINE")).toHaveLength(2);
		expect(completion.split("SECOND STREAMED LINE")).toHaveLength(2);
		expect(completion).not.toContain("Wall time: 1.23 seconds");
	}, 10_000);

	it("preserves a successful post-processed terminal result beside its progress artifact", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressObserved = Promise.withResolvers<void>();
		const completionObserved = Promise.withResolvers<string>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes("RAW STREAMED OUTPUT")) progressObserved.resolve();
				if (text.includes("Resume your work using the result below")) completionObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const gate = Promise.withResolvers<string>();
		const samplerReady = Promise.withResolvers<ProgressLines>();
		manager.register(
			"bash",
			"post-processed successful job",
			async ({ reportAgentProgress }) => {
				const sampler = new ProgressLines(line =>
					reportAgentProgress(line.text, {
						artifactId: "78",
						streamProvenance: line.streamProvenance,
					}),
				);
				samplerReady.resolve(sampler);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const sampler = await samplerReady.promise;
		sampler.append("RAW STREAMED OUTPUT\n");
		await progressObserved.promise;

		// This successful terminal text was synthesized after streaming (the
		// Bash minimizer has the same shape) and never traversed progress.
		gate.resolve("MINIMIZED\tSUCCESS OUTPUT");
		await manager.waitForAll();

		const completion = await completionObserved.promise;
		expect(completion).toContain("artifact://78");
		expect(completion).toContain("MINIMIZED\tSUCCESS OUTPUT");
		expect(completion).not.toContain("MINIMIZED   SUCCESS OUTPUT");
	}, 10_000);

	it("folds a failed artifact-backed job's never-progressed error into the completion", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const progressObserved = Promise.withResolvers<void>();
		const completionObserved = Promise.withResolvers<string>();
		const mock = createMockModel({
			handler: context => {
				const text = context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
					)
					.join("\n");
				if (text.includes("DELIVERED PROGRESS LINE")) progressObserved.resolve();
				if (text.includes("Resume your work using the result below")) completionObserved.resolve(text);
				return { content: ["Done"] };
			},
		});
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
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		await session.sendUserMessage("initialize then wait");

		const gate = Promise.withResolvers<never>();
		const reporter = Promise.withResolvers<(text: string, info?: { artifactId?: string }) => void>();
		manager.register(
			"bash",
			"failing summarized job",
			async ({ reportAgentProgress }) => {
				reporter.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);
		const report = await reporter.promise;
		report("DELIVERED PROGRESS LINE", { artifactId: "88" });
		await progressObserved.promise;

		// The failure text never flows through reportAgentProgress — it must
		// still reach the completion instead of being dropped with the
		// already-delivered stream.
		gate.reject(new Error("TERMINAL SPAWN FAILURE NEVER PROGRESSED"));
		await manager.waitForAll();

		const completion = await completionObserved.promise;
		expect(completion).toContain("artifact://88");
		expect(completion).toContain("failed");
		expect(completion).toContain("TERMINAL SPAWN FAILURE NEVER PROGRESSED");
	}, 10_000);
});
