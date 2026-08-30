/**
 * Contract: the cooperative restart barrier must not dispose the session while a
 * prompt is still in session-level setup.
 *
 * The #restarting latch stops NEW turns from starting, but a prompt that already
 * passed the latch check inside #promptWithMessage can still be awaiting async
 * setup — API-key resolution, @-mention loading, a before_agent_start hook, or
 * pre-prompt compaction — before it reaches the agent. #doRequestRestart's
 * quiescence wait (waitForIdle) watches only the core agent loop and recovery
 * tasks, not #promptInFlightCount, so it resolves immediately in that window and
 * the restart flushes/disposes out from under the preparing prompt; the prompt
 * then continues into promptAgentWithIdleRetry() and appends against a disposed
 * session. The barrier must additionally wait for #promptInFlightCount to drain
 * so a mid-setup prompt blocks dispose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Drain the event loop to quiescence. Every step of the restart barrier — the
 * quiescence waits, sessionManager.flush/ensureOnDisk, dispose — is a promise
 * continuation or a file-I/O callback, never a timer, and a `setImmediate` turn
 * runs only after the callbacks already queued ahead of it have. So a bounded
 * number of turns deterministically settles the barrier as far as it can go: if
 * it is going to (wrongly) dispose under preparing input, it has done so by the
 * time this returns.
 *
 * Counting event-loop turns rather than milliseconds is what makes the negative
 * assertions below load-independent. A wall-clock poll spends its budget on
 * real 1ms sleeps whose true cost balloons on a contended box, so it fails the
 * test for lack of CPU rather than for a barrier regression.
 *
 * The count is measured, not guessed: with the `#promptInFlightCount` half of
 * the barrier deleted, the wrong dispose lands at turn ~87 (the flush and
 * ensureOnDisk file I/O in between costs most of them), so 400 clears it with
 * room to spare while still costing only milliseconds.
 */
async function drainEventLoop(turns = 400): Promise<void> {
	for (let turn = 0; turn < turns; turn++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

describe("AgentSession restart barrier waits for in-flight prompt setup", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mock: MockModel;
	let releaseApiKey: (() => void) | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-restart-inflight-");
	});

	afterEach(async () => {
		releaseApiKey?.();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
		vi.restoreAllMocks();
	});

	/** Build a live, file-backed session with no gating on the restart path. */
	async function buildLiveSession(
		handler?: MockModelOptions["handler"],
		extensionRunner?: ExtensionRunner,
	): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		mock = createMockModel({ handler: handler ?? (() => ({ content: ["ok"] })) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
			onRestartRequested: () => {},
		});
	}

	// A foreground bash result buffered in BashRunner is unpersisted input: it
	// appends through this session's SessionManager, which restart disposal seals,
	// so recycling over it silently drops the result. Restart must refuse busy.
	// A result buffers when it is recorded while the session is streaming
	// (bash-runner.ts:140), which is exactly the restart-vs-turn race.
	it("refuses restart while a foreground bash result is still buffered", async () => {
		// Park the turn open so the session is streaming when the bash result is
		// recorded: that is the condition under which BashRunner buffers it.
		const turnGate = Promise.withResolvers<void>();
		await buildLiveSession(async () => {
			await turnGate.promise;
			return { content: ["done"] };
		});

		const turn = session.prompt("start a turn");
		await drainEventLoop();
		expect(session.isStreaming).toBe(true);

		session.recordBashResult("echo pending", {
			stdout: "pending\n",
			stderr: "",
			exitCode: 0,
			durationMs: 1,
		} as unknown as Parameters<typeof session.recordBashResult>[1]);

		// Unpersisted bash output => restart refuses rather than dropping it.
		await expect(session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });

		turnGate.resolve();
		await turn;
	});

	// One step earlier than the buffered-result cases below: a command that is
	// STILL RUNNING has produced no result to buffer yet, and the agent can be
	// idle while it runs. Disposal neither waits for nor aborts it, so the
	// command outlives the recycle and appends through the sealed manager after
	// the replacement session is open. Restart must refuse rather than lose it.
	it("refuses restart while a foreground bash command is still running", async () => {
		await buildLiveSession();

		// A real command that outlives the restart request: `isRunning` is true
		// with nothing in the pending buffer, which is the state the barrier
		// previously ignored.
		const running = session.executeBash("sleep 5");
		await drainEventLoop();
		expect(session.isBashRunning).toBe(true);

		await expect(session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });

		session.abortBash();
		await running.catch(() => undefined);
	});

	// Same defect class as the bash case above, on the other foreground runner: a
	// Python result buffered in EvalRunner appends through this session's
	// SessionManager, which restart disposal seals, so recycling over it silently
	// drops the result. It buffers when recorded while the session is streaming
	// (eval-runner.ts:125), which is exactly the restart-vs-turn race.
	it("refuses restart while a foreground python result is still buffered", async () => {
		// Park the turn open so the session is streaming when the python result is
		// recorded: that is the condition under which EvalRunner buffers it.
		const turnGate = Promise.withResolvers<void>();
		await buildLiveSession(async () => {
			await turnGate.promise;
			return { content: ["done"] };
		});

		const turn = session.prompt("start a turn");
		await drainEventLoop();
		expect(session.isStreaming).toBe(true);

		session.recordPythonResult("print('pending')", {
			output: "pending\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 8,
			outputLines: 1,
			outputBytes: 8,
			displayOutputs: [],
			stdinRequested: false,
		});
		expect(session.hasPendingPythonMessages).toBe(true);

		// Unpersisted python output => restart refuses rather than dropping it.
		await expect(session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });

		turnGate.resolve();
		await turn;
	});

	it("blocks dispose while a prompt is parked in post-latch API-key setup, then disposes once it finishes", async () => {
		await buildLiveSession();

		// Gate API-key resolution so the prompt parks inside #promptWithMessage's
		// setup — after passing the #restarting latch check and #beginInFlight, but
		// before it reaches the agent. This is the exact post-latch/pre-dispose
		// window the barrier must cover.
		const apiKeyGate = Promise.withResolvers<string | undefined>();
		releaseApiKey = () => apiKeyGate.resolve("test-key");
		vi.spyOn(modelRegistry, "getApiKey").mockReturnValue(apiKeyGate.promise);

		// Observe when dispose begins.
		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// Start a prompt; it advances into setup and parks on the gated key.
		const prompt = session.prompt("do the thing");
		await drainEventLoop();
		// #promptInFlightCount > 0 surfaces as isStreaming even though the agent
		// loop has not started — the prompt is mid-setup.
		expect(session.isStreaming).toBe(true);

		// Fire the restart. Its quiescence wait resolves immediately (agent idle),
		// so only the #promptInFlightCount barrier keeps dispose from proceeding.
		const restart = session.requestRestart();

		// Give the barrier ample opportunity to (wrongly) flush and dispose under
		// the still-preparing prompt.
		await drainEventLoop();
		expect(disposeStarted).toBe(false);

		// Release the setup gate: the prompt completes, the barrier unblocks, and
		// only now does dispose run.
		releaseApiKey?.();
		expect(await prompt).toBe(true);
		expect(await restart).toEqual({ ok: true });
		expect(disposeStarted).toBe(true);
	});

	it("blocks dispose while a steer parked in queued-input image preprocessing has not enqueued, then refuses busy", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait so it latches
		// #restarting and passes its pre-latch #hasUnpersistedInput check BEFORE
		// the steer's preparation begins. Only then does the steer enter the exact
		// race: input in async preparation that has passed the latch but reached
		// neither agent queue nor #promptInFlightCount.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);

		// Gate image normalization so the steer parks inside #queueUserMessage's
		// async preparation before either agent queue is populated.
		const normalizeGate = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			await normalizeGate.promise;
			return images;
		});

		// Observe when dispose begins.
		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// Latch the restart; it parks on the gated quiescence wait.
		const restart = session.requestRestart();

		// A host/extension steer that calls agent.steer directly (never the
		// turn-start latch), landing after the restart latched. It advances into
		// #queueUserMessage and parks on the gated normalization — in preparation,
		// not yet enqueued.
		const steer = session.steer("resume the work", [image]);
		await drainEventLoop();
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the quiescence gate: the barrier resumes. #promptInFlightCount is
		// zero, so only the queued-input preprocessing barrier can keep dispose from
		// running. Give it ample opportunity to (wrongly) flush and dispose out from
		// under the still-preparing steer.
		idleGate.resolve();
		await drainEventLoop();
		expect(disposeStarted).toBe(false);
		// The preparing input was not lost to a dead agent: dispose is blocked and
		// the message still has not reached the queue.
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the normalization gate: the steer enqueues, the prep barrier
		// unblocks, and the barrier now observes queued input — so it refuses the
		// recycle rather than disposing under it.
		normalizeGate.resolve();
		await steer;
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(disposeStarted).toBe(false);
	});

	it("blocks dispose while a custom message parked in queued-input image preprocessing has not enqueued, then refuses busy", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait so it latches
		// #restarting and passes its pre-latch #hasUnpersistedInput check BEFORE
		// the custom prompt's preparation begins. Only then does the custom prompt
		// (SDK/collaboration path) enter the exact race: input in async preparation
		// that has passed the latch but reached neither agent queue nor
		// #promptInFlightCount.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);

		// Gate image normalization so the custom prompt parks inside
		// #queueCustomMessage's async preparation before either agent queue is
		// populated.
		const normalizeGate = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			await normalizeGate.promise;
			return images;
		});

		// Observe when dispose begins.
		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// Latch the restart; it parks on the gated quiescence wait.
		const restart = session.requestRestart();

		// A host/extension custom prompt (SDK/ACP/collaboration) that queues through
		// #queueCustomMessage directly, landing after the restart latched. It
		// advances into #queueCustomMessage and parks on the gated normalization —
		// in preparation, not yet enqueued.
		const custom = session.promptCustomMessage(
			{
				customType: "collab_prompt",
				content: [{ type: "text", text: "resume the work" }, image],
				display: false,
				details: undefined,
				attribution: "agent",
			},
			{ queueOnly: true, streamingBehavior: "steer" },
		);
		await drainEventLoop();
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the quiescence gate: the barrier resumes. #promptInFlightCount is
		// zero, so only the queued-input preprocessing barrier can keep dispose from
		// running. Give it ample opportunity to (wrongly) flush and dispose out from
		// under the still-preparing custom prompt.
		idleGate.resolve();
		await drainEventLoop();
		expect(disposeStarted).toBe(false);
		// The preparing input was not lost to a dead agent: dispose is blocked and
		// the message still has not reached the queue.
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the normalization gate: the custom prompt enqueues, the prep
		// barrier unblocks, and the barrier now observes queued input — so it
		// refuses the recycle rather than disposing under it.
		normalizeGate.resolve();
		await custom;
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(disposeStarted).toBe(false);
	});

	it("blocks dispose while a synthetic follow-up parked in queued-input image preprocessing has not enqueued, then refuses busy", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait so it latches
		// #restarting and passes its pre-latch #hasUnpersistedInput check BEFORE
		// the synthetic follow-up's preparation begins. Only then does the
		// agent-initiated hidden-developer follow-up (plan-approval execution
		// directive) enter the exact race: input in async preparation that has
		// passed the latch but reached neither agent queue nor #promptInFlightCount.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);

		// Gate image normalization so the synthetic follow-up parks inside its
		// async preparation before the follow-up queue is populated.
		const normalizeGate = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			await normalizeGate.promise;
			return images;
		});

		// Observe when dispose begins.
		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// Latch the restart; it parks on the gated quiescence wait.
		const restart = session.requestRestart();

		// An agent-initiated synthetic follow-up (e.g. approved-plan execution
		// queued behind a busy turn), landing after the restart latched. It
		// bypasses #queueUserMessage and awaits normalization directly, so it
		// advances into that preparation window and parks on the gated
		// normalization — in preparation, not yet enqueued.
		const followUp = session.followUp("execute the plan", [image], { synthetic: true });
		await drainEventLoop();
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the quiescence gate: the barrier resumes. #promptInFlightCount is
		// zero, so only the queued-input preprocessing barrier can keep dispose from
		// running. Give it ample opportunity to (wrongly) flush and dispose out from
		// under the still-preparing follow-up.
		idleGate.resolve();
		await drainEventLoop();
		expect(disposeStarted).toBe(false);
		// The preparing input was not lost to a dead agent: dispose is blocked and
		// the message still has not reached the queue.
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the normalization gate: the follow-up enqueues, the prep barrier
		// unblocks, and the barrier now observes queued input — so it refuses the
		// recycle rather than disposing under it.
		normalizeGate.resolve();
		await followUp;
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(disposeStarted).toBe(false);
	});

	it("blocks dispose while sendCustomMessage is parked in image preprocessing, then appends into the live session", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait so it latches
		// #restarting and passes its pre-latch #hasUnpersistedInput check BEFORE
		// the public sendCustomMessage's preparation begins. Only then does that
		// path (host/ACP/collaboration) enter the exact race: input in async
		// normalization that has passed the latch but reached neither agent queue
		// nor #promptInFlightCount.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);

		// Gate image normalization so sendCustomMessage parks inside its async
		// preparation before the message is appended to the live session.
		const normalizeGate = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			await normalizeGate.promise;
			return images;
		});

		// Record whether the append lands while the session is still alive: the
		// barrier must not dispose out from under the preparing message.
		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});
		let appendedWhileDisposed: boolean | undefined;
		const realAppend = session.agent.appendMessage.bind(session.agent);
		vi.spyOn(session.agent, "appendMessage").mockImplementation(message => {
			appendedWhileDisposed = disposeStarted;
			return realAppend(message);
		});

		// Latch the restart; it parks on the gated quiescence wait.
		const restart = session.requestRestart();

		// A public sendCustomMessage (host/ACP/collaboration) that awaits image
		// normalization directly before appending, landing after the restart
		// latched. It advances into that preparation window and parks on the gated
		// normalization — in preparation, not yet appended.
		const custom = session.sendCustomMessage({
			customType: "collab_prompt",
			content: [{ type: "text", text: "resume the work" }, image],
			display: false,
			details: undefined,
			attribution: "agent",
		});
		await drainEventLoop();
		expect(appendedWhileDisposed).toBeUndefined();

		// Release the quiescence gate: the barrier resumes. #promptInFlightCount is
		// zero, so only the queued-input preprocessing barrier can keep dispose from
		// running. Give it ample opportunity to (wrongly) flush and dispose out from
		// under the still-preparing message.
		idleGate.resolve();
		await drainEventLoop();
		expect(disposeStarted).toBe(false);
		// The preparing input was not lost to a dead agent: dispose is blocked and
		// the message still has not been appended.
		expect(appendedWhileDisposed).toBeUndefined();

		// Release the normalization gate: the message appends into the live
		// session, the prep barrier unblocks, and only then does the barrier
		// proceed. The append landed before dispose, so it reached a live agent.
		normalizeGate.resolve();
		await custom;
		expect(appendedWhileDisposed).toBe(false);
		expect(await restart).toEqual({ ok: true });
	});

	// One window EARLIER than the "still running" case above. BashRunner's
	// running state was backed by #abortControllers, which is populated only
	// AFTER the awaited `user_bash` extension hook resolves — so while an async
	// hook is in flight the runner looked idle, the barrier saw no bash work, and
	// restart disposed and sealed the session under it. When the hook then
	// resolved with a result, that result appended through the sealed manager and
	// was lost. Running state must be counted from executeBash() ENTRY.
	it("refuses restart while an async user_bash hook is still in flight", async () => {
		// A hook that never resolves during the test: executeBash parks awaiting
		// it, which is precisely the pre-controller window. No abort controller
		// exists yet, so this is the state a controller-backed isRunning missed.
		const hookGate = Promise.withResolvers<{ result: undefined }>();
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "user_bash",
			emitUserBash: () => hookGate.promise,
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
		} as unknown as ExtensionRunner;
		await buildLiveSession(undefined, extensionRunner);

		const running = session.executeBash("echo hooked");
		await drainEventLoop();
		// The defining condition: the command is tracked as running even though no
		// abort controller has been created yet.
		expect(session.isBashRunning).toBe(true);

		// The hook is still in flight, so its result has nowhere safe to land:
		// restart must refuse rather than seal the manager under it.
		await expect(session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });

		// Let the parked execution unwind so the session disposes cleanly.
		hookGate.resolve({ result: undefined });
		await running.catch(() => undefined);
	});

	// sendCustomMessage({ triggerTurn: true }) released the queued-input-prep
	// counter as soon as normalization resolved, but DISPATCH happens after. In
	// that gap the barrier observed zero pending work and completed the recycle,
	// while #promptAgentInitiatedMessage saw the #restarting latch and returned
	// false without appending OR queueing — the message was silently dropped. The
	// counter must be held through delivery so the barrier refuses instead.
	it("refuses restart rather than dropping a triggerTurn custom message that normalized under the latch", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait so it latches
		// #restarting and passes its pre-latch #hasUnpersistedInput check BEFORE
		// the custom message's preparation begins.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);

		// Gate normalization so the message is mid-preparation when the barrier
		// resumes, then completes into the latched dispatch.
		const normalizeGate = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			await normalizeGate.promise;
			return images;
		});

		// Latch the restart FIRST: it parks on the gated quiescence wait, having
		// already passed its pre-latch #hasUnpersistedInput check while the session
		// was quiet. Only then does the message enter the exact race.
		const restart = session.requestRestart();
		await drainEventLoop();

		// A triggerTurn custom message landing after the restart latched.
		const custom = session.sendCustomMessage(
			{
				customType: "collab_prompt",
				content: [{ type: "text", text: "resume the work" }, image],
				display: false,
				details: undefined,
				attribution: "agent",
			},
			{ triggerTurn: true },
		);
		await drainEventLoop();

		// Release the quiescence gate, then release normalization. The message
		// reaches dispatch while the latch is up, so no turn starts.
		idleGate.resolve();
		await drainEventLoop();
		normalizeGate.resolve();

		// No turn started — the latch refused it.
		expect(await custom).toBe(false);
		// The message was neither appended nor queued, so the recycle would have
		// dropped it outright. The barrier must therefore refuse: holding the prep
		// counter through dispatch is what makes the still-undelivered message
		// visible to #hasUnpersistedInput().
		expect(await restart).toEqual({ ok: false, reason: "busy" });
	});
});
