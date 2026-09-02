/**
 * Contract: `steer(..., { activeTurnOnly: true })` enqueues only when a turn is
 * live, and `clearQueue({ forInterrupt: true })` makes a following abort final.
 *
 * Both exist for hosts that drive the session over a wire (RPC) and cannot undo
 * a mistake:
 *  1. A plain steer that arrives just after the turn ended lands on the idle
 *     queue and auto-drains into a brand new turn. A host that meant "interrupt
 *     the run happening right now" gets an unrequested run instead. Active-only
 *     steering rejects at the final enqueue boundary — after image
 *     normalization, which suspends and lets the turn end underneath the call —
 *     and leaves both queues untouched.
 *  2. `abort()` drains stranded queued messages, so a queued user steer
 *     restarts the very run the host is interrupting (see
 *     "drains steering left after aborting an auto-continued queued turn" in
 *     agent-session-queued-steer-delivery.test.ts, which pins that behavior).
 *     Clearing for interrupt first is what makes the abort stick.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

	it("clearing for interrupt stops abort from restarting the interrupted run", async () => {
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

		// Both queued behind the turn the host is about to interrupt.
		expect(await session.steer("second queued", undefined, { activeTurnOnly: true })).toBe(true);
		queueHiddenAsideSteer(session);
		expect(session.getQueuedMessages().steering).toContain("second queued");

		// Only the user message is restorable; the hidden aside is dropped, not returned.
		expect(session.clearQueue({ forInterrupt: true })).toEqual({
			steering: [{ text: "second queued", images: undefined }],
			followUp: [],
		});
		expect(session.agent.hasQueuedMessages()).toBe(false);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
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
