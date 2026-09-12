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
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { RequestRestartResult } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Drain the event loop to quiescence. Every step of the restart barrier — the
 * quiescence waits, sessionManager.flush/ensureOnDisk, dispose — is a promise
 * continuation or a file-I/O callback, never a timer, so a bounded number of
 * turns deterministically settles the barrier as far as it can go: if it is
 * going to (wrongly) dispose under preparing input, it has done so by the time
 * this returns.
 *
 * Counting event-loop turns rather than milliseconds is what makes the negative
 * assertions below load-independent. A wall-clock poll spends its budget on
 * real 1ms sleeps whose true cost balloons on a contended box, so it fails the
 * test for lack of CPU rather than for a barrier regression.
 *
 * Each turn is a `setTimeout(0)` and NOT a `setImmediate`, which is the
 * difference between a gate and a guess. `setImmediate` fires in the check
 * phase, so awaiting a tight run of them never lets the loop reach the POLL
 * phase where the flush/ensureOnDisk completions this is waiting for are
 * delivered; the drain then spins through its whole budget on continuations
 * alone and returns before the barrier's file I/O has been picked up at all.
 * Whether the buggy dispose lands inside the budget becomes a question of how
 * much unrelated I/O is competing for the same phase — measured: with the
 * retire-the-window half of the fix deleted, this file alone reds, and the same
 * file co-running with restart-latch goes GREEN, because the extra I/O pushes
 * the wrong dispose past a 400-turn `setImmediate` drain. A timer turn yields
 * to the poll phase every iteration, so the drain observes the barrier's own
 * callbacks and reds in both orders.
 */
async function drainEventLoop(turns = 400): Promise<void> {
	for (let turn = 0; turn < turns; turn++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
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
	// Set by the case that parks dispose behind a gate, so a failed assertion
	// mid-test cannot leave afterEach's dispose() awaiting a gate nobody opens.
	let releaseDispose: (() => void) | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-restart-inflight-");
	});

	afterEach(async () => {
		releaseApiKey?.();
		releaseDispose?.();
		releaseDispose = undefined;
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			// A test that installs an owned manager makes it the process singleton;
			// leave no cross-file leak behind.
			AsyncJobManager.resetForTests();
		}
		vi.restoreAllMocks();
	});

	/** Build a live, file-backed session with no gating on the restart path. */
	async function buildLiveSession(
		handler?: MockModelOptions["handler"],
		extensionRunner?: ExtensionRunner,
		ownedAsyncJobManager?: AsyncJobManager,
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
			ownedAsyncJobManager,
			// Owner id the background-job cases filter on; #cancelOwnAsyncJobs is a
			// no-op without it, so the busy leg would never see a job.
			agentId: "Main",
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
		// async preparation before either agent queue is populated. `normalizeEntered`
		// reports that the steer has actually REACHED that park, so the assertions
		// below wait on the observable event rather than on a fixed number of event
		// loop turns — a turn budget is a race under parallel load, where the steer
		// can still be short of the await when the budget runs out.
		const normalizeGate = Promise.withResolvers<void>();
		const normalizeEntered = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeEntered.resolve();
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
		await normalizeEntered.promise;
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the quiescence gate: the barrier resumes. #promptInFlightCount is
		// zero, so only the queued-input preprocessing barrier can keep dispose from
		// running. This one stays a bounded drain by nature — it asserts something
		// did NOT happen, and there is no event that fires when dispose stays put.
		// It is not a race: `normalizeEntered` above already proved the steer is
		// parked inside preparation, so #queuedInputPrepCount is non-zero and held
		// there by `normalizeGate` for the whole window regardless of scheduling.
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

	// The window AFTER the barrier's last busy check: requestRestart() passed its
	// final #hasUnpersistedInput() gate and entered the awaited dispose(). A
	// callback-enabled SDK client calling session.executeBash() in that window
	// was still admitted, because BashRunner had no disposal guard. Disposal
	// neither aborts nor awaits this runner, so the command survives until the old
	// SessionManager is sealed and the replacement is open, after which its result
	// appends through the dead manager and is lost. The runner must reject instead.
	it("rejects a bash execution started after restart entered dispose", async () => {
		// Park the restart INSIDE the real disposal, past every busy re-check: the
		// awaited `session_shutdown` emit is the first await in #doDispose, so it
		// runs after beginDispose() has marked the session disposing but long
		// before the manager is sealed. That is exactly the window in which
		// executeBash() was previously still admitted. Only `session_shutdown` is
		// claimed, so bash itself takes its ordinary no-hook path.
		const disposeGate = Promise.withResolvers<void>();
		releaseDispose = disposeGate.resolve;
		// Resolves when disposal actually reaches the parked hook — an event to
		// await, not a turn budget to guess, so the test does not lose a race for
		// lack of CPU under a loaded/serialized CI chunk.
		const shutdownReached = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_shutdown",
			emit: async (event: { type: string }) => {
				if (event.type !== "session_shutdown") return undefined;
				shutdownReached.resolve();
				await disposeGate.promise;
				return undefined;
			},
			emitBeforeAgentStart: async () => undefined,
		} as unknown as ExtensionRunner;
		await buildLiveSession(undefined, extensionRunner);

		const restart = session.requestRestart();
		// Disposal is under way and parked: the point of no return is passed.
		await shutdownReached.promise;

		// The SDK client's late bash call. Nothing can carry its result: the
		// manager it would append through is being torn down and sealed.
		await expect(session.executeBash("echo late")).rejects.toThrow(
			"Bash execution is unavailable while session disposal is in progress",
		);
		// The rejection must not leave the runner looking busy — a leaked
		// active-execution count would make every later busy check read true, and
		// no result may be buffered against the dying manager.
		expect(session.isBashRunning).toBe(false);
		expect(session.hasPendingBashMessages).toBe(false);

		disposeGate.resolve();
		expect(await restart).toEqual({ ok: true });
	});

	// Same class of loss as the foreground runners, one lane over. The barrier
	// only checked the foreground BashRunner/EvalRunner, so with the agent idle
	// and an owned background `task`/bash/eval job still running it reported
	// restart-safe. Disposal then calls #disposeOwnedAsyncJobs() ->
	// #cancelOwnAsyncJobs(), which aborts the job and evicts its row, so the
	// replacement session can never receive the completion. Restart must refuse.
	it("refuses restart while an owned background async job is still running", async () => {
		const jobStarted = Promise.withResolvers<void>();
		const jobRelease = Promise.withResolvers<void>();
		const owned = new AsyncJobManager({ maxRunningJobs: 1 });
		await buildLiveSession(undefined, undefined, owned);

		owned.register(
			"task",
			"background work",
			async () => {
				jobStarted.resolve();
				await jobRelease.promise;
				return "done";
			},
			{ ownerId: "Main", agentId: "Sub" },
		);
		await jobStarted.promise;

		// The defining condition: the foreground is entirely quiet — the old
		// predicate's only inputs — while owned background work is still running.
		expect(session.isStreaming).toBe(false);
		expect(session.isBashRunning).toBe(false);
		expect(session.isEvalRunning).toBe(false);
		expect(owned.getRunningJobs({ ownerId: "Main" }).length).toBe(1);

		await expect(session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });
		// Refused recoverably: the job was NOT cancelled out from under itself.
		expect(owned.getRunningJobs({ ownerId: "Main" }).length).toBe(1);

		jobRelease.resolve();
	});

	// The suppression carve-out must NOT apply here. #hasPendingAsyncWake() skips
	// a job whose delivery is watched by an in-flight `hub` wait, because it will
	// not re-wake the run loop — but #cancelOwnAsyncJobs() cancels every running
	// owned job regardless of suppression, so a suppressed job is exactly the case
	// where a recycle leaves the waiter with no result at all.
	it("refuses restart while an owned background job with a suppressed delivery is running", async () => {
		const jobStarted = Promise.withResolvers<void>();
		const jobRelease = Promise.withResolvers<void>();
		const owned = new AsyncJobManager({ maxRunningJobs: 1 });
		await buildLiveSession(undefined, undefined, owned);

		const jobId = owned.register(
			"task",
			"watched background work",
			async () => {
				jobStarted.resolve();
				await jobRelease.promise;
				return "done";
			},
			{ ownerId: "Main", agentId: "Sub" },
		);
		await jobStarted.promise;
		// A `hub` wait watching the job suppresses its delivery.
		owned.watchJobs([jobId]);
		expect(owned.isDeliverySuppressed(jobId)).toBe(true);
		// The wake-oriented predicate now reports quiescent — the trap this covers.
		expect(session.hasPendingAsyncWork()).toBe(false);

		await expect(session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });
		expect(owned.getRunningJobs({ ownerId: "Main" }).length).toBe(1);

		jobRelease.resolve();
	});

	// A public model mutation is the same loss class as the buffered-result cases
	// above, on a surface the barrier did not observe at all. setModel() awaits
	// modelRegistry.refreshSelectedModelMetadata() — a live provider probe for a
	// lazy-load local backend — BEFORE it reaches sessionManager
	// .appendModelChange(). Nothing in either agent queue reflects the operation,
	// so the foreground reads fully quiescent: a concurrent restart flushed and
	// disposed, the mutation then resumed against the SEALED SessionManager whose
	// #recordEntry() drops the append outright, and the caller still observed
	// { switched: true } while the replacement reopened on the PREVIOUS model.
	// The barrier must treat an in-flight model mutation as unpersisted input.
	it("refuses restart while a public model change is still in flight", async () => {
		await buildLiveSession();

		const target = getBundledModel("anthropic", "claude-opus-4-1");
		if (!target) throw new Error("Expected a second bundled anthropic model");

		// Park setModel() inside its awaited metadata refresh: the exact window
		// between passing its own entry checks and appending the model_change.
		const probeEntered = Promise.withResolvers<void>();
		const probeRelease = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => {
			probeEntered.resolve();
			await probeRelease.promise;
			return model;
		});

		const switching = session.setModel(target);
		await probeEntered.promise;

		// The defining condition: every foreground predicate the barrier already
		// consulted reads quiet while the model change is mid-flight.
		expect(session.isStreaming).toBe(false);
		expect(session.isBashRunning).toBe(false);
		expect(session.isEvalRunning).toBe(false);

		await expect(session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });

		// Refused recoverably: the session is still live, so the switch completes
		// and persists its model_change through an unsealed manager.
		probeRelease.resolve();
		await expect(switching).resolves.toEqual({ switched: true });
		expect(session.model?.id).toBe("claude-opus-4-1");
		expect(session.sessionManager.getEntries().some(entry => entry.type === "model_change")).toBe(true);
	});

	// F3: a local slash handler (#tryExecuteExtensionCommand /
	// #tryExecuteCustomCommand) runs and returns WITHOUT ever reaching
	// #promptWithMessage's #beginInFlight, so once one is awaiting I/O NO counter
	// the restart barrier watches observes it. The latch recheck above the
	// handlers only rejects a restart latched BEFORE invocation; a restart
	// latching DURING the awaited handler saw an idle agent, flushed, and disposed
	// while the handler kept using the torn-down extension/session runtime past
	// the durability barrier.
	//
	// RED (pre-fix): dispose ran while the handler was still parked, so
	// `disposeStarted` was already true at the mid-test assertion.
	it("blocks dispose while a local slash-command handler is still awaiting, then refuses busy", async () => {
		const handlerEntered = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();
		// A registered extension command whose handler parks on I/O — the exact
		// state the finding describes. #tryExecuteExtensionCommand resolves it via
		// getCommand() and invokes it through runScoped(), so both are stubbed.
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			getCommand: (name: string) =>
				name === "slow"
					? {
							name: "slow",
							description: "parks on I/O",
							handler: async () => {
								handlerEntered.resolve();
								await releaseHandler.promise;
							},
						}
					: undefined,
			createCommandContext: () => ({}),
			runScoped: <T>(run: () => T): T => run(),
			emitError: () => {},
		} as unknown as ExtensionRunner;
		await buildLiveSession(undefined, extensionRunner);

		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// Start the slash command; it passes the pre-handler latch recheck and
		// parks inside the handler.
		const prompt = session.prompt("/slow");
		await handlerEntered.promise;

		// Only NOW does the restart latch — the window the pre-handler recheck
		// cannot cover. The agent loop never started, so waitForIdle() resolves at
		// once and the in-flight barrier is the only thing holding dispose.
		const restart = session.requestRestart();

		// Give the barrier ample opportunity to (wrongly) flush and dispose under
		// the still-running handler.
		await drainEventLoop();
		expect(disposeStarted).toBe(false);

		// Release the handler: it completes against a session that is still ALIVE,
		// which is the whole point — it never touches a disposed runtime.
		releaseHandler.resolve();
		// A locally-handled command reports false (no turn was forwarded).
		expect(await prompt).toBe(false);
		expect(session.isDisposed).toBe(false);

		// The restart then settles on its own terms. Either outcome is correct
		// here; what must never happen is disposing DURING the handler, asserted
		// above.
		await restart;
	});

	// The counterpart hazard to the case above. Holding #promptInFlightCount
	// across a locally-handled slash command makes an UNRELATED restart wait for
	// the handler — correct. But when the handler is itself the requester, the
	// wait becomes circular: #doRequestRestart waits for the counter to reach
	// zero, the matching #endInFlight() cannot run until the handler returns, and
	// the handler is awaiting that very restart. The session latches out new
	// turns permanently and the recycle never happens.
	//
	// The restart TOOL avoids this by firing from an untracked continuation; an
	// SDK extension or custom-TS command that `await`s requestRestart() cannot,
	// so requestRestart() drops the requester's OWN window from the wait it owns.
	//
	// RED (pre-fix): the awaited restart never settled and this test timed out.
	it("does not deadlock a restart awaited by the local slash-command handler that requested it", async () => {
		let restartResult: RequestRestartResult | undefined;
		const handlerEntered = Promise.withResolvers<void>();
		// A registered extension command that AWAITS its own restart — the exact
		// self-referential shape an SDK host writes.
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			getCommand: (name: string) =>
				name === "recycle"
					? {
							name: "recycle",
							description: "requests its own restart",
							handler: async () => {
								handlerEntered.resolve();
								restartResult = await session.requestRestart();
							},
						}
					: undefined,
			createCommandContext: () => ({}),
			runScoped: <T>(run: () => T): T => run(),
			emitError: () => {},
		} as unknown as ExtensionRunner;
		await buildLiveSession(undefined, extensionRunner);

		const prompt = session.prompt("/recycle");
		await handlerEntered.promise;

		// The restart must complete rather than latch on its own caller. Event-
		// gated on the prompt itself: the handler cannot return until the restart
		// it awaits resolves, so this await IS the deadlock assertion.
		expect(await prompt).toBe(false);
		expect(restartResult).toEqual({ ok: true });
		expect(session.isDisposed).toBe(true);
	});

	// Releasing the requester's own window must not release anyone else's: an
	// unrelated prompt in setup still has to block the recycle. Without this the
	// self-deadlock fix would be indistinguishable from deleting the barrier.
	it("still blocks the recycle on another in-flight prompt while releasing the requester's own window", async () => {
		const otherEntered = Promise.withResolvers<void>();
		const releaseOther = Promise.withResolvers<void>();
		let restartSettled = false;
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			getCommand: (name: string) => {
				if (name === "other") {
					return {
						name: "other",
						description: "parks on I/O",
						handler: async () => {
							otherEntered.resolve();
							await releaseOther.promise;
						},
					};
				}
				return name === "recycle"
					? {
							name: "recycle",
							description: "requests its own restart",
							handler: async () => {
								await session.requestRestart();
							},
						}
					: undefined;
			},
			createCommandContext: () => ({}),
			runScoped: <T>(run: () => T): T => run(),
			emitError: () => {},
		} as unknown as ExtensionRunner;
		await buildLiveSession(undefined, extensionRunner);

		// An UNRELATED local handler parks first, holding its own window.
		const other = session.prompt("/other");
		await otherEntered.promise;

		// Now the self-restarting handler runs. Its own window is released, but
		// the other one is not, so the barrier must still hold.
		const recycle = session.prompt("/recycle").then(result => {
			restartSettled = true;
			return result;
		});
		await drainEventLoop();
		expect(restartSettled).toBe(false);
		expect(session.isDisposed).toBe(false);

		// Release the unrelated handler and the recycle proceeds.
		releaseOther.resolve();
		expect(await other).toBe(false);
		expect(await recycle).toBe(false);
		expect(session.isDisposed).toBe(true);
	});

	// The residual hazard in the release above: the window is published on an
	// AsyncLocalStorage store, and that store outlives the handler. A detached
	// descendant the handler started — a timer, or a floating promise it never
	// awaited — still resolves the same store after the handler has returned and
	// its `#endInFlight()` has already balanced the counter.
	//
	// So a `requestRestart()` from that descendant found a window whose
	// `released` flag was still false and decremented `#promptInFlightCount` a
	// SECOND time for a window that was already accounted for. One decrement too
	// many is not a bookkeeping curiosity: it drops the counter below the number
	// of genuinely live prompts, so the recycle's quiescence wait resolves and
	// dispose runs underneath an UNRELATED prompt — exactly the hazard the
	// counter exists to prevent, now reachable from a handler that has already
	// finished.
	//
	// Normal cleanup therefore marks the window released before decrementing, so
	// the window is spent exactly once whichever path spends it.
	//
	// RED (pre-fix): dispose began while the unrelated handler was still parked.
	it("does not let a detached descendant of a finished local command release a window twice", async () => {
		const otherEntered = Promise.withResolvers<void>();
		const releaseOther = Promise.withResolvers<void>();
		// Opened inside the finished handler's async context, so the detached
		// continuation below still resolves that handler's command window.
		const detachedGate = Promise.withResolvers<void>();
		let detached: Promise<RequestRestartResult> | undefined;
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			getCommand: (name: string) => {
				if (name === "other") {
					return {
						name: "other",
						description: "parks on I/O",
						handler: async () => {
							otherEntered.resolve();
							await releaseOther.promise;
						},
					};
				}
				return name === "detach"
					? {
							name: "detach",
							description: "leaves a floating promise behind",
							handler: async () => {
								// Started, never awaited: the handler returns while this
								// continuation is still parked, so it resumes with the
								// command window's store and no window of its own.
								detached = (async () => {
									await detachedGate.promise;
									return session.requestRestart();
								})();
							},
						}
					: undefined;
			},
			createCommandContext: () => ({}),
			runScoped: <T>(run: () => T): T => run(),
			emitError: () => {},
		} as unknown as ExtensionRunner;
		await buildLiveSession(undefined, extensionRunner);

		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// An UNRELATED local handler parks first and holds its own window for the
		// whole test: nothing may dispose while it is in there.
		const other = session.prompt("/other");
		await otherEntered.promise;

		// The second command runs to completion, so its window is spent by the
		// ordinary cleanup path.
		expect(await session.prompt("/detach")).toBe(false);
		if (!detached) throw new Error("Expected the handler to leave a detached continuation");

		// Only NOW does the orphaned descendant request the restart, holding the
		// finished handler's store.
		detachedGate.resolve();
		const restart = detached;
		let restartSettled = false;
		void restart.then(() => {
			restartSettled = true;
		});

		// Give the barrier every opportunity to (wrongly) flush and dispose on the
		// strength of a counter the second release drove too low.
		await drainEventLoop();
		expect(disposeStarted).toBe(false);
		expect(restartSettled).toBe(false);
		expect(session.isDisposed).toBe(false);

		// The unrelated handler completes against a session that is still ALIVE,
		// and only then does the recycle proceed.
		releaseOther.resolve();
		expect(await other).toBe(false);
		expect(await restart).toEqual({ ok: true });
		expect(session.isDisposed).toBe(true);
	});

	// The same circular wait as the self-restart case above, reached through the
	// COALESCE branch instead of the committing one.
	//
	// The ordering is forced by `prompt()`'s own latch check: once `#restarting`
	// is set, `prompt()` refuses and no command window is ever opened. So the
	// only way a local handler meets a populated `#restartCall` is for the
	// handler to be parked ALREADY when an external requester latches — an SDK
	// host recycling while a slash command awaits I/O, which is the ordinary
	// shape, not a contrivance.
	//
	// From there the handler awaits `requestRestart()` and is handed the existing
	// promise. But that restart is parked on `#promptInFlightCount`, and this
	// handler's window is what the count is holding — held until the promise it
	// is awaiting resolves. Releasing the window only in the committing path
	// leaves the two waiting on each other permanently.
	//
	// Asserted as a DEADLOCK, not as a call: the handler cannot return until the
	// promise it awaits settles, so awaiting the prompt IS the assertion — on the
	// unfixed code nothing resolves it and the case fails on the runner's own
	// timeout. A test that only verified the release was invoked would pass on
	// code that still hangs here. Deliberately NOT a drain-budget check: whether
	// the wrong path lands inside a fixed number of turns depends on how much
	// unrelated I/O shares the loop, so co-running files would flip the result.
	// The one negative check below is budget-free in the other direction — the
	// external restart cannot settle while the handler holds its window, however
	// many turns pass.
	//
	// RED (pre-fix): the awaited prompt never settles and the case times out.
	it("does not deadlock a local slash-command handler that awaits an already-in-flight restart", async () => {
		const handlerEntered = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();
		let coalescedResult: RequestRestartResult | undefined;
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			getCommand: (name: string) =>
				name === "recycle"
					? {
							name: "recycle",
							description: "awaits a restart another caller already started",
							handler: async () => {
								handlerEntered.resolve();
								// Parked while the external requester latches, so the call
								// below takes the coalesce branch rather than committing.
								await releaseHandler.promise;
								coalescedResult = await session.requestRestart();
							},
						}
					: undefined,
			createCommandContext: () => ({}),
			runScoped: <T>(run: () => T): T => run(),
			emitError: () => {},
		} as unknown as ExtensionRunner;
		await buildLiveSession(undefined, extensionRunner);

		let promptSettled = false;
		const prompt = session.prompt("/recycle").then(result => {
			promptSettled = true;
			return result;
		});
		await handlerEntered.promise;

		// The EXTERNAL restart latches while the handler is parked. It is not
		// running inside the command window's async context, so it releases
		// nothing of the handler's and parks on the counter the handler holds.
		let externalSettled = false;
		const external = session.requestRestart().then(result => {
			externalSettled = true;
			return result;
		});
		await drainEventLoop();
		expect(externalSettled).toBe(false);

		// The handler resumes and requests the restart that is already in flight.
		releaseHandler.resolve();
		// THE assertion: on the unfixed code the handler is still awaiting the
		// coalesced promise while that promise waits for the handler's window, so
		// neither of these ever resolves.
		expect(await prompt).toBe(false);
		expect(promptSettled).toBe(true);
		expect(await external).toEqual({ ok: true });
		// Both requesters observe the same single handoff.
		expect(coalescedResult).toEqual(await external);
		expect(coalescedResult).toEqual({ ok: true });
		expect(session.isDisposed).toBe(true);
	});

	// A manual history rewrite runs with the foreground agent IDLE: an SDK caller
	// drives `shake()`/`dropImages()` directly, and the in-place branch mutation
	// is persisted only by an awaited `SessionManager.rewriteEntries()` — with
	// `"elide"` awaiting an artifact save first. So `waitForIdle()`, every input
	// counter and both maintenance getters see nothing at all, and a restart
	// landing in that window flushes and disposes. `rewriteEntries()` then
	// returns WITHOUT writing, because dispose sealed the manager, while
	// `shake()` still reports the reduction it computed and the replacement
	// reopens the unchanged transcript. That silent successful-looking no-op is
	// the thing to eliminate.
	//
	// Refused `busy`, the same treatment `isCompacting`/`isGeneratingHandoff`
	// already get one line above in the same predicate: the session is left
	// entirely alive and the host retries once the rewrite has landed. Both
	// halves are asserted, because refusing forever would satisfy the first on
	// its own.
	//
	// RED (pre-fix): the restart reported ok and disposed mid-rewrite.
	it("refuses restart while a history rewrite is still persisting, then recycles once it lands", async () => {
		await buildLiveSession();
		// A rewrite only reaches rewriteEntries() when something is eligible; an
		// image is the smallest such seed.
		session.sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});

		const rewriteEntered = Promise.withResolvers<void>();
		const releaseRewrite = Promise.withResolvers<void>();
		let rewroteWhileAlive = false;
		const manager = session.sessionManager;
		const realRewrite = manager.rewriteEntries.bind(manager);
		vi.spyOn(manager, "rewriteEntries").mockImplementation(async () => {
			rewriteEntered.resolve();
			// Stands in for the awaited artifact save / disk rewrite the real path
			// parks on — the window the restart used to step through.
			await releaseRewrite.promise;
			rewroteWhileAlive = !session.isDisposed;
			await realRewrite();
		});

		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		const shaking = session.dropImages();
		await rewriteEntered.promise;

		// Refused, and NOTHING was torn down: the rewrite is still going to
		// persist through this very manager.
		expect(await session.requestRestart()).toEqual({ ok: false, reason: "busy" });
		await drainEventLoop();
		expect(disposeStarted).toBe(false);
		expect(session.isDisposed).toBe(false);

		// The rewrite commits against the live manager, so the count the caller
		// was given is one that actually reached disk.
		releaseRewrite.resolve();
		expect((await shaking).removed).toBe(1);
		expect(rewroteWhileAlive).toBe(true);

		// And the refusal was recoverable, not a permanent latch: the retry the
		// `busy` reason invites now succeeds.
		expect(await session.requestRestart()).toEqual({ ok: true });
		expect(session.isDisposed).toBe(true);
	});

	// The REVERSE ordering, and the reason it cannot be handled by waiting.
	// Once a restart has latched (or disposal has begun) the manager is on its
	// way to sealed, so admitting the rewrite IS the loss: it would park in its
	// artifact save, the resuming `rewriteEntries()` would write nothing, and the
	// caller would still read a successful reduction off the returned counts
	// while the replacement reopened the untouched transcript.
	//
	// So it is rejected up front, synchronously. A throw rather than zero counts:
	// zero would claim nothing was eligible, when the truth is the reduction was
	// dropped — the same silent-success failure wearing a different mask.
	//
	// RED (pre-fix): resolved with a successful-looking ShakeResult.
	it("rejects a history rewrite requested after the restart latched", async () => {
		await buildLiveSession();
		await session.prompt("first turn");

		// Hold the barrier open so the latch is up while the rewrite is attempted.
		const disposeReached = Promise.withResolvers<void>();
		const releaseDisposeGate = Promise.withResolvers<void>();
		releaseDispose = () => releaseDisposeGate.resolve();
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(async options => {
			disposeReached.resolve();
			await releaseDisposeGate.promise;
			return realDispose(options);
		});

		const restart = session.requestRestart();
		await disposeReached.promise;

		// Latched and mid-teardown: both rewrites must refuse rather than report a
		// reduction nothing will persist.
		await expect(session.shake("elide")).rejects.toThrow(/being recycled or disposed/);
		await expect(session.dropImages()).rejects.toThrow(/being recycled or disposed/);

		releaseDisposeGate.resolve();
		releaseDispose = undefined;
		expect(await restart).toEqual({ ok: true });
	});

	// queue-only dispatch (promptCustomMessage({ queueOnly: true })) is the one
	// prompt path that reaches #queueCustomMessage without passing
	// #promptWithMessage's latch re-check. Once the restart's final quiescence
	// check has passed and the SDK dispose wrapper has entered its ASYNCHRONOUS
	// teardown, no guard was left on this path at all: it enqueued into an agent
	// whose queue the teardown clears and whose SessionManager it seals, then
	// answered `true` — "expect an agent_end" — for a turn that can never run.
	// The message was lost AND the caller could wait forever.
	//
	// It must REFUSE, and by throwing rather than returning false: the compaction
	// -queue flush that owns this path discards the boolean (its
	// invokeSkillCommandFromText wrapper reports "handled" either way) but funnels
	// a rejection into restoreQueue, which puts the message back on the pending
	// queue. Throwing is what makes the message survive the recycle.
	//
	// The window is reproduced the way the SDK wrapper opens it: beginDispose()
	// runs synchronously, then teardown awaits. That is a real state a caller can
	// observe, not a contrivance — sdk.ts calls beginDispose() and then awaits the
	// vibe-scope suspend and parkAll() before AgentSession.dispose() ever runs.
	//
	// RED (pre-fix): the call resolved `true` and the message reached the queue
	// that the teardown then cleared.
	it("refuses queue-only dispatch once disposal has begun instead of losing the message", async () => {
		await buildLiveSession();

		// The exact wrapper ordering: guards set synchronously, teardown still
		// ahead of us. No dispose() yet, so the agent and its queue are still
		// there for a bypassing dispatch to (wrongly) land in.
		session.beginDispose();

		await expect(
			session.promptCustomMessage(
				{
					customType: "skill-prompt",
					content: "run the queued skill",
					display: true,
					attribution: "user",
				},
				{ queueOnly: true, streamingBehavior: "steer" },
			),
		).rejects.toThrow(AgentBusyError);
		// Refused, not swallowed: nothing was handed to the agent queue, so there
		// is no message for the teardown to clear out from under the caller.
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	// The negative control for the guard above, and the reason it keys on
	// disposal rather than on the `#restarting` latch. While the session is still
	// ALIVE a latched restart must PRESERVE the message, not refuse it: the
	// dispatch enqueues, and the barrier's own unpersisted-input re-check then
	// sees it and refuses the recycle `busy`, so the message is delivered to the
	// session that is still there. A guard widened to `#restarting` would abort a
	// recoverable restart over input the barrier exists to notice, and would
	// throw at a caller whose message was never in danger.
	it("still queues a queue-only dispatch while a restart is latched but the session is alive", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait: #restarting latched,
		// session fully alive, disposal not begun.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);
		const restart = session.requestRestart();

		const queued = await session.promptCustomMessage(
			{
				customType: "skill-prompt",
				content: "run the queued skill",
				display: true,
				attribution: "user",
			},
			{ queueOnly: true, streamingBehavior: "steer" },
		);

		// Preserved: the message is in the queue of a live session.
		expect(queued).toBe(true);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// And the barrier notices it: the recycle refuses rather than disposing
		// over the queued input, which is what makes preserving safe here.
		idleGate.resolve();
		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(session.isDisposed).toBe(false);
	});

	// Same guard, one step later: once the session is DISPOSED the queue is gone
	// and the manager sealed, so a queue-only dispatch has nowhere to land. It
	// must refuse rather than report a turn the caller can never observe.
	it("refuses queue-only dispatch after disposal instead of promising an agent_end", async () => {
		await buildLiveSession();
		await session.dispose();

		await expect(
			session.promptCustomMessage(
				{
					customType: "skill-prompt",
					content: "run the queued skill",
					display: true,
					attribution: "user",
				},
				{ queueOnly: true, streamingBehavior: "steer" },
			),
		).rejects.toThrow(AgentBusyError);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	// The direct injection path, one step past the queue-only guard above. An SDK
	// caller can reach `steer()` / `followUp()` / `sendUserMessage()` after the
	// restart's final busy check and after `beginDispose()` — while the wrapper is
	// awaiting the vibe-scope suspend and subagent parking, before
	// `AgentSession.dispose()` runs. None of those methods consulted disposal:
	// each bumped the preparation counter the restart no longer observes and
	// queued into an agent whose queue the teardown clears, then resolved
	// normally. The caller's input was lost with no signal at all.
	//
	// The refusal shape is the one this surface already has for input the session
	// cannot take: the text goes back through the drop hook — which a host
	// implements to restore it — and the call is a no-op, because every method
	// here returns void and a throw would be a new failure mode for callers with
	// no recovery path.
	//
	// Every entry point is driven, not just the two named: they share one
	// chokepoint, so a guard that covered only some would be the same bug again
	// one method over.
	//
	// RED (pre-fix): each call resolved with its message in the queue and the
	// drop hook never invoked.
	it("refuses direct steer/follow-up/user-message injection once disposal has begun", async () => {
		await buildLiveSession();
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));

		// The exact wrapper ordering the SDK opens: guards set synchronously,
		// teardown still ahead, so the agent and its queue are still there for a
		// bypassing dispatch to (wrongly) land in.
		session.beginDispose();

		await session.steer("steer after disposal began");
		await session.followUp("follow-up after disposal began");
		await session.sendUserMessage("sent steer after disposal began", { deliverAs: "steer" });
		await session.sendUserMessage("sent follow-up after disposal began", { deliverAs: "followUp" });

		// Nothing reached the queue the teardown is about to clear.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		// And every caller's input came back through the hook rather than
		// vanishing into a session that could not take it.
		expect(dropped).toEqual([
			"steer after disposal began",
			"follow-up after disposal began",
			"sent steer after disposal began",
			"sent follow-up after disposal began",
		]);
	});

	// The negative control, and the reason the guard keys on disposal rather than
	// on the `#restarting` latch. While the session is still ALIVE a latched
	// restart must PRESERVE a steer, not refuse it: it enqueues, and the
	// barrier's own unpersisted-input re-check then refuses the recycle `busy`,
	// so the input is delivered to the session that is still there. A guard
	// widened to `#restarting` would instead abort a recoverable restart over
	// input the barrier exists to notice, and would hand a host back text that
	// was never in danger.
	it("still queues a direct steer while a restart is latched but the session is alive", async () => {
		await buildLiveSession();
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));

		// Park the restart at its post-idle quiescence wait: #restarting latched,
		// session fully alive, disposal not begun.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);
		const restart = session.requestRestart();

		await session.steer("steer while merely latched");

		// Preserved in the queue of a live session, and NOT handed back.
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(dropped).toEqual([]);

		// And the barrier notices it: the recycle refuses rather than disposing
		// over the queued input, which is what makes preserving safe here.
		idleGate.resolve();
		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(session.isDisposed).toBe(false);
	});

	// A streaming `prompt()` reports `true` to mean "expect an agent_end",
	// because it queued the text as a steer. Once disposal has begun that queue
	// is refused, so the boolean has to follow: a `true` here leaves a protocol
	// host awaiting a turn that can never run — the same false promise the
	// queue-only path made before its own guard.
	it("reports no turn from a streaming prompt whose steer is refused after disposal began", async () => {
		const turnGate = Promise.withResolvers<void>();
		await buildLiveSession(async () => {
			await turnGate.promise;
			return { content: ["done"] };
		});
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));

		// A real turn in flight, so prompt() takes its streaming queue branch
		// rather than trying to start a turn.
		const turn = session.prompt("start a turn");
		await drainEventLoop();
		expect(session.isStreaming).toBe(true);

		session.beginDispose();
		expect(await session.prompt("queued behind the turn", { streamingBehavior: "steer" })).toBe(false);
		expect(dropped).toEqual(["queued behind the turn"]);

		turnGate.resolve();
		await turn.catch(() => {});
	});

	// The remaining branches that reach the queue WITHOUT passing
	// `#queueUserMessage`'s guard. `followUp(..., { synthetic: true })` — the
	// plan-approval and guided-goal execution directives — starts directly at the
	// preparation counter, and `sendCustomMessage` / the `promptCustomMessage`
	// streaming branch do the same for host/ACP/collaboration input. Called after
	// `beginDispose()` (while the SDK wrapper is still parking subagents) each one
	// bumped a counter the restart had already finished observing, queued into the
	// OLD agent, and resolved normally; teardown then cleared that queue and the
	// directive was silently gone.
	//
	// The guard now lives on the counter itself, so every path that queues without
	// dispatching a turn has to answer for a disposed session. A synthetic
	// directive carries no operator text, so it is refused silently rather than
	// handed to the drop hook; `sendCustomMessage` already answers `false` for
	// "no turn started", so it reports that.
	//
	// RED (pre-fix): each call resolved with its message sitting in the queue the
	// teardown is about to clear.
	it("refuses synthetic follow-ups and custom-message injection once disposal has begun", async () => {
		// A real turn in flight, so `promptCustomMessage` takes its streaming QUEUE
		// branch (the one that reaches the preparation counter) rather than its
		// non-streaming branch, which dispatches a turn through
		// `#promptWithMessage` and is not a queueing path at all.
		const turnGate = Promise.withResolvers<void>();
		await buildLiveSession(async () => {
			await turnGate.promise;
			return { content: ["done"] };
		});
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));

		const turn = session.prompt("start a turn");
		await drainEventLoop();
		expect(session.isStreaming).toBe(true);

		// The exact wrapper ordering the SDK opens: guards set synchronously,
		// teardown still ahead, so the agent and its queue are still there for a
		// bypassing dispatch to (wrongly) land in.
		session.beginDispose();

		await session.followUp("execute the approved plan", undefined, { synthetic: true });
		expect(
			await session.sendCustomMessage(
				{ customType: "advisor", content: "late advice", display: true, attribution: "agent" },
				{ deliverAs: "steer" },
			),
		).toBe(false);
		expect(
			await session.promptCustomMessage(
				{ customType: "skill-prompt", content: "run the skill", display: true, attribution: "user" },
				{ streamingBehavior: "steer" },
			),
		).toBe(false);

		// Nothing reached the queue the teardown is about to clear.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		// A hidden agent-authored directive has no operator text to restore, so
		// the drop hook stays out of it — the refusal is the whole signal.
		expect(dropped).toEqual([]);

		turnGate.resolve();
		await turn.catch(() => {});
	});

	// The negative control for the guard above: while the session is still ALIVE a
	// latched restart must PRESERVE a synthetic directive, not refuse it. It
	// enqueues, the barrier's own unpersisted-input re-check sees it, and the
	// recycle refuses `busy` — so the directive reaches the session that is still
	// there. A guard widened to `#restarting` would drop it instead.
	it("still queues a synthetic follow-up while a restart is latched but the session is alive", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait: #restarting latched,
		// session fully alive, disposal not begun.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);
		const restart = session.requestRestart();

		await session.followUp("execute the approved plan", undefined, { synthetic: true });

		expect(session.agent.hasQueuedMessages()).toBe(true);

		idleGate.resolve();
		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(session.isDisposed).toBe(false);
	});

	// The same class one await LATER than the entry guard. `sendCustomMessage`
	// refuses when disposal has already begun, but the SDK wrapper sets that flag
	// synchronously and then awaits (vibe-scope suspend, parkAll) — so a send
	// that entered while the session was live and parked in image normalization
	// resumed past a guard that had already answered, and its no-turn branch
	// appended through the agent and the SessionManager teardown is about to
	// seal. The message was lost and the call reported the same `false` a
	// successful append-without-turn reports.
	//
	// Interleaved at the REAL normalization await, so the ordering is the one a
	// host actually produces rather than a contrived call sequence.
	//
	// RED (pre-fix): appendMessage/appendCustomMessageEntry both ran after
	// beginDispose().
	it("discards a custom message whose normalization spanned beginDispose instead of appending into the torn-down session", async () => {
		await buildLiveSession();

		// Gate normalization so the send parks inside its async preparation with
		// the session still fully alive.
		const normalizeGate = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			await normalizeGate.promise;
			return images;
		});

		const appended: string[] = [];
		const realAppend = session.agent.appendMessage.bind(session.agent);
		vi.spyOn(session.agent, "appendMessage").mockImplementation(message => {
			appended.push(message.role === "custom" ? message.customType : message.role);
			return realAppend(message);
		});
		const persisted: (string | undefined)[] = [];
		const realPersist = session.sessionManager.appendCustomMessageEntry.bind(session.sessionManager);
		vi.spyOn(session.sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
			persisted.push(args[0]);
			return realPersist(...args);
		});
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));

		// Idle, no triggerTurn: the plain append-and-persist branch, whose `false`
		// is exactly the answer a discard must be distinguishable from.
		const send = session.sendCustomMessage(
			{
				customType: "collab_prompt",
				content: [{ type: "text", text: "resume the work" }, image],
				display: true,
				attribution: "agent",
			},
			{ queueChipText: "resume the work" },
		);
		await drainEventLoop(20);
		// Parked in preparation: nothing appended yet, so the interleave below
		// lands inside the normalization window rather than after dispatch.
		expect(appended).toEqual([]);

		// The exact wrapper ordering the SDK opens: the flag is set synchronously
		// while the agent and its manager are still there for a resuming
		// preparation to (wrongly) land in.
		session.beginDispose();

		normalizeGate.resolve();
		// Reported as no-turn-started, and nothing reached the session teardown is
		// about to seal.
		expect(await send).toBe(false);
		expect(appended).toEqual([]);
		expect(persisted).toEqual([]);
		// How a host tells this `false` apart from a successful append-without-turn.
		expect(session.isDisposed).toBe(true);
		// Restorable operator text is handed back rather than silently discarded.
		expect(dropped).toEqual(["resume the work"]);
	});
});
