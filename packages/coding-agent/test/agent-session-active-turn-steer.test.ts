/**
 * Contract: `steer(..., { activeTurnOnly: true })` enqueues only when a turn is
 * live, and `abort({ clearQueue: true })` owns queue clearing through its final
 * stranded-message drain.
 *
 * Both exist for hosts that drive the session over a wire (RPC) and cannot undo
 * a mistake:
 *  1. A plain steer that arrives just after the turn ended lands on the idle
 *     queue and auto-drains into a brand new turn. A host that meant "interrupt
 *     the run happening right now" gets an unrequested run instead. Active-only
 *     steering rejects at the final enqueue boundary — after image
 *     normalization, which suspends and lets the turn end underneath the call —
 *     and leaves both queues untouched.
 *  2. `abort()` drains stranded queued messages, so a queued user steer restarts
 *     the very run the host is interrupting. Queue-clearing abort removes work at
 *     startup and again after awaited cleanup so neither preexisting nor
 *     mid-abort enqueues can start a continuation turn. Plain abort retains the
 *     stranded-queue behavior.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionProviderBoundary } from "../src/session/session-provider-boundary";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "../src/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession active-turn steering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-active-turn-steer-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(responses: MockHandler[]): MockModel {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		return mock;
	}

	/** Resolves once the queued user message with this exact text is delivered. */
	function nextUserMessage(target: AgentSession, expected: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = target.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("");
			if (text !== expected) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	it("rejects an active-only steer on an idle session and leaves the queues untouched", async () => {
		createSession([{ content: ["unused"] }]);
		const continueSpy = vi.spyOn(session.agent, "continue");

		expect(session.isStreaming).toBe(false);
		expect(await session.steer("interrupt the run", undefined, { activeTurnOnly: true })).toBe(false);

		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.queuedMessageCount).toBe(0);
		expect(session.getQueuedMessages().steering).toEqual([]);
		// A rejected steer must not schedule the idle drain that would start a turn.
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("keeps the legacy idle-drain behavior when activeTurnOnly is absent", async () => {
		createSession([{ content: ["unused"] }]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		expect(await session.steer("queue me for the next turn")).toBe(true);

		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("accepts an active-only steer while a turn is streaming", async () => {
		const started = Promise.withResolvers<void>();
		createSession([
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
		]);

		const running = session.prompt("do the thing");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		expect(await session.steer("actually do this instead", undefined, { activeTurnOnly: true })).toBe(true);
		expect(session.getQueuedMessages().steering).toEqual(["actually do this instead"]);

		session.clearQueue({ forInterrupt: true });
		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});
	});
	it("rejects an active-only steer after the final queue poll closes", async () => {
		const atFinalPoll = Promise.withResolvers<void>();
		const releaseFinalPoll = Promise.withResolvers<void>();
		const mock = createSession([{ content: ["done"] }]);
		session.agent.setOnBeforeYield(async () => {
			atFinalPoll.resolve();
			await releaseFinalPoll.promise;
		});

		const running = session.prompt("do the thing");
		await atFinalPoll.promise;
		expect(session.agent.state.isStreaming).toBe(true);
		expect(session.agent.acceptsSteering).toBe(false);
		expect(await session.steer("too late", undefined, { activeTurnOnly: true })).toBe(false);

		releaseFinalPoll.resolve();
		await running;
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("rejects an active-only steer as soon as plain abort starts", async () => {
		const started = Promise.withResolvers<void>();
		const mock = createSession([
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
			{ content: ["must not run"] },
		]);

		const running = session.prompt("do the thing");
		await started.promise;
		const aborting = session.abort();
		expect(await session.steer("too late", undefined, { activeTurnOnly: true })).toBe(false);

		await aborting;
		await running.catch(() => {});
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("rejects an active-only steer when the turn ends while the call is suspended", async () => {
		const started = Promise.withResolvers<void>();
		createSession([
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
		]);

		const running = session.prompt("do the thing");
		await started.promise;

		// The call suspends on image normalization between its two run checks.
		// Report the run as live for the first check and finished for the decisive
		// one, which is exactly the race a wire host loses. An own property shadows
		// the state field for the duration (bun's spyOn cannot do accessors).
		const agentState = session.agent.state;
		let reads = 0;
		Object.defineProperty(agentState, "isStreaming", {
			configurable: true,
			get: () => ++reads === 1,
		});

		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		expect(await session.steer("too late", [image], { activeTurnOnly: true })).toBe(false);
		// Proves the decisive check happens after the suspension, not just the
		// cheap pre-check: a single read would mean no post-await boundary.
		expect(reads).toBeGreaterThan(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);

		Object.defineProperty(agentState, "isStreaming", { configurable: true, value: true, writable: true });
		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});
	});

	it("rejects an active-only steer while a finished prompt is still unwinding", async () => {
		createSession([{ content: ["unused"] }]);
		const continueSpy = vi.spyOn(session.agent, "continue");

		// Post-prompt recovery: the agent run has ended but the prompt has not
		// unwound, so `session.isStreaming` (agent run OR #promptInFlightCount > 0)
		// still reports true. Gating on it would admit the steer, and since no run
		// is live the message would auto-drain into a brand new turn.
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		expect(session.isStreaming).toBe(true);
		expect(session.agent.state.isStreaming).toBe(false);

		expect(await session.steer("steer the run that ended", undefined, { activeTurnOnly: true })).toBe(false);

		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.queuedMessageCount).toBe(0);
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(continueSpy).not.toHaveBeenCalled();

		Reflect.deleteProperty(session, "isStreaming");
	});

	/** A hidden agent-authored steer (IRC aside shape). Plain `clearQueue()` keeps
	 *  these for a continuing stream; only `forInterrupt` drops them, and while any
	 *  survive, `abort()`'s stranded-queue drain starts another turn. */
	function queueHiddenAsideSteer(target: AgentSession): void {
		target.agent.steer({
			role: "custom",
			customType: "irc",
			content: "peer pinged you",
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
	}

	it("abort with clearQueue drops work queued before abort starts", async () => {
		const mock = createSession([
			{ content: ["initial response"] },
			{ content: ["queued response"], delayMs: 1_000 },
			{ content: ["must not run"] },
		]);

		await session.prompt("hello");
		expect(mock.calls.length).toBe(1);

		const delivered = nextUserMessage(session, "first queued");
		expect(await session.steer("first queued")).toBe(true);
		await delivered;
		expect(mock.calls.length).toBe(2);

		// Both are queued behind the turn the host is about to interrupt.
		expect(await session.steer("second queued", undefined, { activeTurnOnly: true })).toBe(true);
		queueHiddenAsideSteer(session);
		expect(session.getQueuedMessages().steering).toContain("second queued");
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("preserves advisor cards for queue-clearing aborts without a user reason", async () => {
		const started = Promise.withResolvers<void>();
		const mock = createSession([
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
			{ content: ["must not run"] },
		]);

		const running = session.prompt("hello");
		await started.promise;
		session.agent.steer({
			role: "custom",
			customType: "advisor",
			content: "keep this advice",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		});

		await session.abort({ clearQueue: true });
		await running.catch(() => {});
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.state.messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "advisor", content: "keep this advice" }),
		);
	});

	it("drops every enqueue source while queue-clearing abort is suspended", async () => {
		const started = Promise.withResolvers<void>();
		const abortSuspended = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		const mock = createSession([
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
			{ content: ["must not run"] },
		]);
		const continueSpy = vi.spyOn(session.agent, "continue");
		const waitForIdle = session.agent.waitForIdle.bind(session.agent);
		vi.spyOn(session.agent, "waitForIdle").mockImplementation(async () => {
			await waitForIdle();
			abortSuspended.resolve();
			await releaseAbort.promise;
		});

		const running = session.prompt("hello");
		await started.promise;
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		await abortSuspended.promise;

		// The first clear already ran. These simulate user, hidden extension,
		// non-parent IRC, and triggerable next-turn work arriving while abort is
		expect(await session.steer("late user steer")).toBe(false);
		queueHiddenAsideSteer(session);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		await expect(
			session.deliverIrcMessage({ id: "late-irc", from: "peer", to: "me", body: "ping", ts: Date.now() }),
		).rejects.toThrow("queue-clearing abort");
		await session.sendCustomMessage(
			{ customType: "late-extension", content: "late extension work", display: false, attribution: "agent" },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		// Another delivery starts during abort but finishes normalization after the
		// final clear. Its captured generation must make it a no-op.
		const normalizationStarted = Promise.withResolvers<void>();
		const releaseNormalization = Promise.withResolvers<void>();
		vi.spyOn(SessionProviderBoundary.prototype, "normalizeAgentMessageImages").mockImplementation(async message => {
			normalizationStarted.resolve();
			await releaseNormalization.promise;
			return message;
		});
		const crossingAbort = session.sendCustomMessage(
			{ customType: "late-extension", content: "crossing abort", display: false, attribution: "agent" },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		await normalizationStarted.promise;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		await expect(
			session.deliverIrcMessage({
				id: "late-idle-irc",
				from: "peer",
				to: "me",
				body: "ping after unwind",
				ts: Date.now(),
			}),
		).rejects.toThrow("queue-clearing abort");
		Reflect.deleteProperty(session, "isStreaming");
		const completion = {
			event: "daemon-completed",
			completionId: "late-completion",
			owner: "test-owner",
			daemon: {
				name: "late-worker",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: "test-owner",
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;
		const completionResult = session.queueLaunchCompletion(completion).then(
			() => undefined,
			error => error,
		);
		expect(session.queuedMessageCount).toBeGreaterThan(0);

		releaseAbort.resolve();
		await aborting;
		releaseNormalization.resolve();
		expect(await crossingAbort).toBe(false);
		expect(await completionResult).toBeInstanceOf(Error);
		await running.catch(() => {});
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(session.queuedMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("stops a streaming prompt when its keyword notice crosses queue-clearing abort", async () => {
		const started = Promise.withResolvers<void>();
		const mock = createSession([
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
			{ content: ["must not run"] },
		]);
		const running = session.prompt("hello");
		await started.promise;

		const normalizationStarted = Promise.withResolvers<void>();
		const releaseNormalization = Promise.withResolvers<void>();
		vi.spyOn(SessionProviderBoundary.prototype, "normalizeAgentMessageImages").mockImplementation(async message => {
			normalizationStarted.resolve();
			await releaseNormalization.promise;
			return message;
		});
		const queuedPrompt = session.prompt("ultrathink change course", { streamingBehavior: "steer" });
		await normalizationStarted.promise;

		await session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		releaseNormalization.resolve();
		expect(await queuedPrompt).toBe(false);
		await running.catch(() => {});
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("rejects a prompt started during a queue-clearing abort", async () => {
		const mock = createSession([{ content: ["must not run"] }]);
		const abortSuspended = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		const waitForIdle = session.agent.waitForIdle.bind(session.agent);
		vi.spyOn(session.agent, "waitForIdle").mockImplementation(async () => {
			await waitForIdle();
			abortSuspended.resolve();
			await releaseAbort.promise;
		});

		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		await abortSuspended.promise;
		expect(session.isStreaming).toBe(false);
		const accepted = await session.prompt("too late");

		releaseAbort.resolve();
		await aborting;
		await session.waitForIdle();

		expect(accepted).toBe(false);
		expect(mock.calls).toHaveLength(0);
	});

	it("retains queue-clear ownership while an overlapping plain abort settles", async () => {
		const mock = createSession([{ content: ["must not run"] }]);
		const firstAbortSuspended = Promise.withResolvers<void>();
		const releaseFirstAbort = Promise.withResolvers<void>();
		const waitForIdle = session.agent.waitForIdle.bind(session.agent);
		let waitCalls = 0;
		vi.spyOn(session.agent, "waitForIdle").mockImplementation(async () => {
			await waitForIdle();
			waitCalls++;
			if (waitCalls !== 1) return;
			firstAbortSuspended.resolve();
			await releaseFirstAbort.promise;
		});

		const clearingAbort = session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		await firstAbortSuspended.promise;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const accepted = await session.prompt("must stay stopped");

		releaseFirstAbort.resolve();
		await clearingAbort;
		await session.waitForIdle();

		expect(accepted).toBe(false);
		expect(mock.calls).toHaveLength(0);
	});

	it("rejects an idle prompt whose normalization crosses a queue-clearing abort", async () => {
		const mock = createSession([{ content: ["must not run"] }]);
		const normalizationStarted = Promise.withResolvers<void>();
		const releaseNormalization = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizationStarted.resolve();
			await releaseNormalization.promise;
			return images;
		});

		// RPC acknowledges prompt before this preprocessing finishes. Abort completes
		// while no agent run exists, then the stale prompt resumes normalization.
		const crossingPrompt = session.prompt("crossing prompt", {
			images: [{ type: "image", data: "abc", mimeType: "image/png" }],
		});
		await normalizationStarted.promise;
		expect(session.isStreaming).toBe(false);

		await session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		releaseNormalization.resolve();
		expect(await crossingPrompt).toBe(false);
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(0);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("preserves advisor suppression when a stale prompt resumes after abort", async () => {
		const mock = createSession([{ content: ["must not run"] }]);

		// prompt() yields on manual-compaction cleanup before user-initiated side
		// effects. The abort advances queue-clear generation during that suspension.
		const stalePrompt = session.prompt("stale prompt");
		await session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		expect(await stalePrompt).toBe(false);

		session.agent.steer({
			role: "custom",
			customType: "advisor",
			content: "late blocker",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		});
		await session.abort();
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(0);
	});
	it("rejects a triggered custom turn whose usage preflight crosses abort", async () => {
		const mock = createSession([{ content: ["must not run"] }]);
		session.settings.set("retry.usageAwareFallback", true);
		const preflightStarted = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		vi.spyOn(authStorage, "getModelUsageHealth").mockImplementation(async () => {
			preflightStarted.resolve();
			await releasePreflight.promise;
			return { state: "healthy", accounts: [] };
		});

		const triggered = session.sendCustomMessage(
			{ customType: "extension", content: "start work", display: false, attribution: "agent" },
			{ triggerTurn: true },
		);
		await preflightStarted.promise;
		await session.abort({ reason: USER_INTERRUPT_LABEL, clearQueue: true });
		releasePreflight.resolve();

		expect(await triggered).toBe(false);
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(0);
	});

	it("clearing without forInterrupt leaves hidden steers that abort would resume", async () => {
		const mock = createSession([
			{ content: ["initial response"] },
			{ content: ["queued response"], delayMs: 1_000 },
			{ content: ["resumed by the stranded aside"] },
		]);

		await session.prompt("hello");
		const delivered = nextUserMessage(session, "first queued");
		expect(await session.steer("first queued")).toBe(true);
		await delivered;
		expect(mock.calls.length).toBe(2);

		expect(await session.steer("second queued", undefined, { activeTurnOnly: true })).toBe(true);
		queueHiddenAsideSteer(session);

		session.clearQueue();
		// This is why a host interrupting a turn must pass forInterrupt.
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		expect(mock.calls.length).toBe(3);
	});
});
