import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { Agent, type AgentEvent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type OAuthAccountPools, SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { cfgExtensionAssistantTextRenderers } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RpcPromptResults } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { TurnRecovery } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { emitSubagentFrame, EventBus, extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

describe("AgentSession settles what it promised", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-settle-promises-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	/** Drives the one send a running session transition takes over: the transition's own
	 *  `session_switch` hook is what sends the aside, so the send cannot park on the transition
	 *  it runs inside, and the record lives only in #deliverAfterSessionTransition's closure
	 *  until that transition settles. Returns once the transition is done and the deferred
	 *  dispatch is under way.
	 *
	 *  `beforeSwitch` installs a `session_before_switch` handler, so a test can hold or cancel a
	 *  *second* transition; `secondCompaction` gates the idle compaction a re-dispatch waits on,
	 *  which is where the record changes carriers. */
	async function sendAsideFromSessionSwitchHook(
		body: string,
		beforeSwitch?: () => Promise<{ cancel: true } | undefined>,
		secondCompaction?: () => Promise<void>,
	): Promise<MockModel> {
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [{ content: ["ack"] }, { content: ["ack again"] }],
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const hookEntered = Promise.withResolvers<void>();
		const sendSettled = Promise.withResolvers<void>();
		let sendFinished = false;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				if (beforeSwitch) pi.on("session_before_switch", beforeSwitch);
				pi.on("session_switch", async () => {
					if (sendFinished) return;
					hookEntered.resolve();
					await session?.sendCustomMessage(
						{ customType: "ext-aside", content: body, display: false, attribution: "agent" },
						{ deliverAs: "aside" },
					);
					sendFinished = true;
					if (secondCompaction) void session?.runIdleCompaction();
					sendSettled.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"aside-from-transition-hook",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
		});

		const compactionStarted = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
		let compactionRuns = 0;
		const compactionSpy = spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async () => {
			if (++compactionRuns > 1 && secondCompaction) {
				await secondCompaction();
				return { continuationScheduled: false };
			}
			compactionStarted.resolve();
			await releaseCompaction.promise;
			return { continuationScheduled: false };
		});
		try {
			const idleCompaction = session.runIdleCompaction();
			await compactionStarted.promise;

			const transition = session.newSession();
			await hookEntered.promise;
			// The send must be parked on the idle compaction before it is released: otherwise this
			// harness would never reach the transition wait it exists to exercise.
			await setImmediate();
			await setImmediate();
			expect(sendFinished).toBe(false);
			releaseCompaction.resolve();

			// A deadlocked transition is only observable as "still running": the watchdog is the
			// assertion, since the extension handler timeout would otherwise free it 30 seconds later.
			await withTimeout(transition, 5_000, "session transition never finished");
			await idleCompaction;
			await sendSettled.promise;
		} finally {
			releaseCompaction.resolve();
			compactionSpy.mockRestore();
		}
		return mock;
	}

	/** Replaces image normalization — the one await between a dispatch's last bail check and its
	 *  delivery — with a gate on the record carrying `body`. Every other message passes through. */
	function gateNormalizationOf(body: string, gate: () => Promise<void>) {
		const original = SessionProviderBoundary.prototype.normalizeAgentMessageImages;
		return spyOn(SessionProviderBoundary.prototype, "normalizeAgentMessageImages").mockImplementation(async function <
			T extends AgentMessage,
		>(this: SessionProviderBoundary, message: T): Promise<T> {
			if (JSON.stringify(message).includes(body)) await gate();
			return original.call<SessionProviderBoundary, [T], Promise<T>>(this, message);
		});
	}

	it("completes a session transition whose own hook sends an aside while an idle compaction is in flight", async () => {
		await sendAsideFromSessionSwitchHook("HOOK_ASIDE_BODY");
		await session?.waitForIdle();
		expect(JSON.stringify(session?.agent.state.messages)).toContain("HOOK_ASIDE_BODY");
	}, 45_000);

	it("drops a deferred delivery whose normalization outlasted disposal instead of starting a turn", async () => {
		const normalizing = Promise.withResolvers<void>();
		const releaseNormalization = Promise.withResolvers<void>();
		const normalizeSpy = gateNormalizationOf("DISPOSE_RACE_ASIDE", async () => {
			normalizing.resolve();
			await releaseNormalization.promise;
		});
		try {
			const mock = await sendAsideFromSessionSwitchHook("DISPOSE_RACE_ASIDE");
			await withTimeout(normalizing.promise, 5_000, "deferred delivery never reached normalization");
			// What a host latches synchronously before its async teardown. The deferred callback's
			// own disposal check is already behind it, suspended in the normalization above.
			session?.beginDispose();
			releaseNormalization.resolve();
			await setImmediate();
			await setImmediate();
			await setImmediate();

			expect(mock.calls.length).toBe(0);
			expect(JSON.stringify(session?.agent.state.messages)).not.toContain("DISPOSE_RACE_ASIDE");
		} finally {
			releaseNormalization.resolve();
			normalizeSpy.mockRestore();
		}
	}, 45_000);

	it("keeps a message whose deferred delivery failed, which its sender was already told was accepted", async () => {
		const failed = Promise.withResolvers<void>();
		let thrown = false;
		const normalizeSpy = gateNormalizationOf("DEFERRED_FAILURE_ASIDE", async () => {
			if (thrown) return;
			thrown = true;
			failed.resolve();
			throw new Error("normalization failed");
		});
		try {
			await sendAsideFromSessionSwitchHook("DEFERRED_FAILURE_ASIDE");
			await withTimeout(failed.promise, 5_000, "deferred delivery never failed");
			await setImmediate();
			await setImmediate();

			// The send already answered `false` (accepted, no turn), so the rejection has no caller
			// left to reach: the record must stay queued rather than vanish with the warning.
			expect(session?.ircWakesPending).toBe(true);
		} finally {
			normalizeSpy.mockRestore();
		}

		// And it is still delivered: the next prompt folds it into the transcript.
		await session?.prompt("next");
		await session?.waitForIdle();
		expect(JSON.stringify(session?.agent.state.messages)).toContain("DEFERRED_FAILURE_ASIDE");
	}, 45_000);

	/** A pooled yield contract parks a stranded aside instead of waking a turn for it
	 *  (#resumeStrandedIrcAsides), so the record is still queued — and still holding its
	 *  run's `agent_end` open — when the next prompt reaches IrcBridge.flushPending(). */
	async function startPooledRunWithStrandedAside(
		bodies = ["STRANDED_TRIGGER_ASIDE"],
		/** Observes `message_end` extension notifications; holding one holds a session event handler
		 *  in flight (`#drainInFlightEventHandlers`) during disposal. */
		onMessageEnd?: (event: { message: AgentMessage }) => Promise<void>,
		/** Observes `before_agent_start`, which runs inside the agent's queued-message dequeue hook:
		 *  holding one holds a queued-message preparation. */
		onBeforeAgentStart?: (event: { prompt: string }) => Promise<void>,
		/** Registers anything else on the same extension, e.g. two handlers for one event. */
		register?: ExtensionFactory,
		/** Installed so a test can watch when disposal lifts its credential restrictions. */
		accountPoolScope?: SessionAccountPoolScope,
	): Promise<{
		settles: Array<boolean | undefined>;
		modelRegistry: ModelRegistry;
		mock: MockModel;
	}> {
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [{ content: ["First."] }, { content: ["Second."] }],
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		let asideSent = false;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				// session_stop runs after the loop's last aside poll, so the record it sends
				// strands in IrcBridge instead of riding the turn that is settling.
				pi.on("session_stop", async () => {
					if (asideSent) return;
					asideSent = true;
					for (const body of bodies) {
						await session?.sendCustomMessage(
							{ customType: "ext-aside", content: body, display: false, attribution: "agent" },
							{ deliverAs: "aside", triggerTurn: true },
						);
					}
				});
				if (onMessageEnd) pi.on("message_end", onMessageEnd);
				if (onBeforeAgentStart) pi.on("before_agent_start", onBeforeAgentStart);
				register?.(pi);
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"stranded-aside-sender",
		);
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		// Settings reach the runner too: emitters gated on a setting (link activation) are inert
		// without them.
		const extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			settings,
		);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
			accountPoolScope,
		});
		const settles: Array<boolean | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") settles.push(event.isTerminal);
		});
		await session.setWorkPoolYieldItems([{ id: "item-a", index: 0 }]);

		await session.prompt("go");
		await session.waitForIdle();

		// The run promised a continuation for the aside it could not deliver.
		expect(settles.at(-1)).toBe(false);
		for (const body of bodies) expect(JSON.stringify(session.agent.state.messages)).not.toContain(body);
		return { settles, modelRegistry, mock };
	}

	/** Clearing the contract releases whatever is still queued: the aside the bailing prompt
	 *  must not have consumed runs its turn, which settles the end its run left open. */
	async function expectStrandedAsideStillRuns(settles: Array<boolean | undefined>, mock: MockModel): Promise<void> {
		await session?.setWorkPoolYieldItems([]);
		await session?.waitForIdle();

		expect(JSON.stringify(session?.agent.state.messages)).toContain("STRANDED_TRIGGER_ASIDE");
		expect(mock.calls.length).toBe(2);
		expect(settles.at(-1)).toBe(true);
	}

	it("keeps a stranded aside for its turn when the next prompt bails with no model", async () => {
		const { settles, mock } = await startPooledRunWithStrandedAside();
		// A session may hold no model (initialState.model is optional); the prompt bails on it.
		session?.agent.setModel(undefined as unknown as Model);

		await session?.prompt("second").catch(() => {});
		await session?.waitForIdle();

		session?.agent.setModel(mock.model);
		await expectStrandedAsideStillRuns(settles, mock);
	}, 20_000);

	it("keeps a stranded aside for its turn when the next prompt bails with no API key", async () => {
		const { settles, modelRegistry, mock } = await startPooledRunWithStrandedAside();
		const keySpy = spyOn(modelRegistry, "getApiKey").mockResolvedValue(undefined);
		try {
			await session?.prompt("second").catch(() => {});
			await session?.waitForIdle();
		} finally {
			keySpy.mockRestore();
		}

		await expectStrandedAsideStillRuns(settles, mock);
	}, 20_000);

	it("keeps a stranded aside for its turn when the next prompt is superseded in setup", async () => {
		const { settles, modelRegistry, mock } = await startPooledRunWithStrandedAside();
		let aborted: Promise<void> | undefined;
		const keySpy = spyOn(modelRegistry, "getApiKey").mockImplementation(async () => {
			// An abort lands mid-setup, between the prompt's bail points.
			aborted ??= session?.abort({ reason: "internal" });
			await setImmediate();
			return "test-key";
		});
		try {
			await session?.prompt("second").catch(() => {});
			await aborted;
			await session?.waitForIdle();
		} finally {
			keySpy.mockRestore();
		}

		await expectStrandedAsideStillRuns(settles, mock);
	}, 20_000);

	it("closes the run its stranded aside held open when a user interrupt folds it instead of waking", async () => {
		const { settles, modelRegistry, mock } = await startPooledRunWithStrandedAside();
		let aborted: Promise<void> | undefined;
		const keySpy = spyOn(modelRegistry, "getApiKey").mockImplementation(async () => {
			// A real Esc, not an internal abort: it latches auto-resume suppression, which is the
			// branch #resumeStrandedIrcAsides folds an extension aside through without a turn.
			aborted ??= session?.abort({ reason: USER_INTERRUPT_LABEL });
			await setImmediate();
			return "test-key";
		});
		try {
			await session?.prompt("second").catch(() => {});
			await aborted;
			await session?.waitForIdle();
		} finally {
			keySpy.mockRestore();
		}

		await session?.setWorkPoolYieldItems([]);
		await session?.waitForIdle();

		// Folded into context, so no second turn runs — and the `agent_end` that was published
		// non-terminal for this very record must still be closed, or the host shows the run as
		// working forever with no turn left to finish it.
		expect(JSON.stringify(session?.agent.state.messages)).toContain("STRANDED_TRIGGER_ASIDE");
		expect(mock.calls.length).toBe(1);
		expect(settles.at(-1)).toBe(true);
	}, 20_000);

	it("does not dispatch a prompt that a subscriber cancelled from inside its own IRC fold", async () => {
		const { settles, mock } = await startPooledRunWithStrandedAside();
		const target = session;
		// IrcBridge.flushPending() emits this synchronously from prompt setup, so a subscriber
		// (an extension message_end handler, the interactive Esc path) cancels the prompt with no
		// await between the fold and the dispatch.
		const unsubscribe = target?.agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "message_end" && JSON.stringify(event.message).includes("STRANDED_TRIGGER_ASIDE")) {
				void target?.abort({ reason: USER_INTERRUPT_LABEL });
			}
		});
		try {
			await target?.prompt("second").catch(() => {});
			await target?.waitForIdle();
		} finally {
			unsubscribe?.();
		}

		// The cancelled prompt must not reach the model, and the run whose end was downgraded for
		// the folded aside is closed now that nothing is left to continue it.
		expect(mock.calls.length).toBe(1);
		expect(settles.at(-1)).toBe(true);
	}, 20_000);

	it("retains an accepted deferred message when the turn rejects before appending it", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const normalizeSpy = gateNormalizationOf("NO_MODEL_RECORD", async () => {
			reached.resolve();
			await release.promise;
		});
		try {
			const mock = await sendAsideFromSessionSwitchHook("NO_MODEL_RECORD");
			await withTimeout(reached.promise, 5_000, "deferred delivery never reached normalization");
			// `agent.prompt` rejects with no model before it ever appends the record, which is the
			// failure the carrier has to survive: the last bail check is long past by then.
			session?.agent.setModel(undefined as unknown as Model);
			release.resolve();
			for (let i = 0; i < 5; i++) await setImmediate();
			expect(session?.ircWakesPending).toBe(true);

			session?.agent.setModel(mock.model);
			await session?.prompt("next");
			await session?.waitForIdle();
			expect(session?.messages.filter(m => m.role === "custom" && m.content === "NO_MODEL_RECORD")).toHaveLength(1);
		} finally {
			release.resolve();
			normalizeSpy.mockRestore();
		}
	}, 45_000);

	it("does not recover a failed delivery into the transcript that replaced its own", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let first = true;
		const normalizeSpy = gateNormalizationOf("OLD_TRANSCRIPT_RECORD", async () => {
			if (!first) return;
			first = false;
			reached.resolve();
			await release.promise;
			throw new Error("normalization failed after transcript replacement");
		});
		try {
			await sendAsideFromSessionSwitchHook("OLD_TRANSCRIPT_RECORD");
			await withTimeout(reached.promise, 5_000, "deferred delivery never reached normalization");
			const previousSessionId = session?.sessionId;
			await session?.newSession();
			expect(session?.sessionId).not.toBe(previousSessionId);
			release.resolve();
			for (let i = 0; i < 5; i++) await setImmediate();

			await session?.prompt("new transcript");
			await session?.waitForIdle();
			// Recovery makes the same transcript decision delivery makes: the outgoing session's
			// record must not surface in the replacement and ride its next prompt to the model.
			expect(
				session?.messages.filter(m => m.role === "custom" && m.content === "OLD_TRANSCRIPT_RECORD"),
			).toHaveLength(0);
		} finally {
			release.resolve();
			normalizeSpy.mockRestore();
		}
	}, 45_000);

	it("hands a re-deferred delivery to its new carrier instead of delivering it twice", async () => {
		const dispatchWaiting = Promise.withResolvers<void>();
		const releaseDispatch = Promise.withResolvers<void>();
		const beforeSwitchEntered = Promise.withResolvers<void>();
		const releaseBeforeSwitch = Promise.withResolvers<void>();
		let secondTransition = false;
		try {
			const mock = await sendAsideFromSessionSwitchHook(
				"DOUBLE_CARRIER_RECORD",
				async () => {
					if (!secondTransition) return undefined;
					beforeSwitchEntered.resolve();
					await releaseBeforeSwitch.promise;
					return { cancel: true };
				},
				async () => {
					dispatchWaiting.resolve();
					await releaseDispatch.promise;
				},
			);
			await withTimeout(dispatchWaiting.promise, 5_000, "second compaction barrier not reached");
			// The re-dispatch wakes inside a second transition, so it defers again — to a second
			// carrier. Only one of the two may deliver, and neither may requeue what the other took.
			secondTransition = true;
			const transition = session?.newSession();
			await beforeSwitchEntered.promise;
			releaseDispatch.resolve();
			for (let i = 0; i < 5; i++) await setImmediate();
			releaseBeforeSwitch.resolve();
			expect(await transition).toBe(false);
			for (let i = 0; i < 5; i++) await setImmediate();
			await session?.waitForIdle();

			expect(
				session?.messages.filter(m => m.role === "custom" && m.content === "DOUBLE_CARRIER_RECORD"),
			).toHaveLength(1);
			expect(mock.calls.length).toBe(1);
		} finally {
			releaseDispatch.resolve();
			releaseBeforeSwitch.resolve();
		}
	}, 45_000);

	it("does not close a run while the closure carrying its continuation waits out a compaction", async () => {
		const { settles, mock } = await startPooledRunWithStrandedAside();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const compactionSpy = spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return { continuationScheduled: false };
		});
		try {
			const compaction = session?.runIdleCompaction();
			await started.promise;
			// Clearing the contract moves the stranded aside out of the IRC queue and into
			// #wakeForIrc's compaction-wait closure: no physical queue holds it any more, but the
			// continuation it was promised has not started.
			await session?.setWorkPoolYieldItems([]);
			await session?.abort({ reason: "internal" });
			expect([...settles]).toEqual([false]);
			expect(session?.ircWakesPending).toBe(true);

			release.resolve();
			await compaction;
			for (let i = 0; i < 5; i++) await setImmediate();
			await session?.waitForIdle();
			expect(mock.calls.length).toBe(2);
			expect(settles).toEqual([false, true]);
		} finally {
			release.resolve();
			compactionSpy.mockRestore();
		}
	}, 20_000);

	it("closes the run it promised a continuation for when disposal folds the last record", async () => {
		const { settles } = await startPooledRunWithStrandedAside();
		// beginDispose()'s own flush is the last consumer of that record, and it tears the
		// subscribers down straight after: nothing later can publish the end it promised.
		await session?.dispose();
		expect(settles.at(-1)).toBe(true);
	}, 20_000);

	it("does not dispatch a prompt whose own fold disposed the session", async () => {
		const { mock } = await startPooledRunWithStrandedAside();
		const target = session;
		// Disposal is the other synchronous cancellation a fold subscriber can cause, and unlike an
		// abort it leaves the prompt generation untouched.
		const unsubscribe = target?.agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "message_start" && JSON.stringify(event.message).includes("STRANDED_TRIGGER_ASIDE")) {
				target?.beginDispose();
			}
		});
		try {
			await target?.prompt("CANCELLED_BY_DISPOSAL").catch(() => {});
			await target?.waitForIdle();
		} finally {
			unsubscribe?.();
		}
		expect(mock.calls.length).toBe(1);
	}, 20_000);

	/** Suspends the usage-aware preflight — the last await before an agent-initiated dispatch —
	 *  on its `nth` entry, so a test can act in the window between the dispatch's own checks and
	 *  `agent.prompt`. */
	function gateUsagePreflight(nth: number, entered: PromiseWithResolvers<void>, release: Promise<void>) {
		const original = TurnRecovery.prototype.maybeApplyUsageAwareFallback;
		let entries = 0;
		return spyOn(TurnRecovery.prototype, "maybeApplyUsageAwareFallback").mockImplementation(async function (
			this: TurnRecovery,
			...args: Parameters<typeof original>
		) {
			if (++entries === nth) {
				entered.resolve();
				await release;
			}
			return original.apply(this, args);
		});
	}

	it("does not take a competing run's streaming state as acceptance of its own record", async () => {
		const preflightEntered = Promise.withResolvers<void>();
		const preflightRelease = Promise.withResolvers<void>();
		const providerEntered = Promise.withResolvers<void>();
		const providerRelease = Promise.withResolvers<void>();
		const preflightSpy = gateUsagePreflight(1, preflightEntered, preflightRelease.promise);
		try {
			const mock = await sendAsideFromSessionSwitchHook("BUSY_REJECTED_RECORD");
			await withTimeout(preflightEntered.promise, 5_000, "deferred delivery never reached its preflight");

			// A scheduled continuation takes the agent while the deferred delivery is parked in its
			// preflight, so `agent.prompt` will reject with AgentBusyError while `isStreaming` is
			// true — for that other run. Acceptance must be this call's own claim.
			const target = session;
			if (target) {
				target.agent.streamFn = async (...args) => {
					providerEntered.resolve();
					await providerRelease.promise;
					return mock.stream(...args);
				};
			}
			await session?.sendCustomMessage({ customType: "other", content: "COMPETING_CONTINUATION", display: false });
			session?.resumeAfterAskReanswer();
			await withTimeout(providerEntered.promise, 5_000, "competing continuation did not start");
			expect(session?.agent.state.isStreaming).toBe(true);

			preflightRelease.resolve();
			for (let i = 0; i < 5; i++) await setImmediate();
			providerRelease.resolve();
			for (let i = 0; i < 5; i++) await setImmediate();
			await session?.waitForIdle();

			expect(
				session?.messages.filter(m => m.role === "custom" && m.content === "BUSY_REJECTED_RECORD"),
			).toHaveLength(1);
			expect(session?.ircWakesPending).toBe(false);
		} finally {
			preflightRelease.resolve();
			providerRelease.resolve();
			preflightSpy.mockRestore();
		}
	}, 45_000);

	it("does not start an accepted deferred delivery when disposal lands in its usage preflight", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const preflightSpy = gateUsagePreflight(1, entered, release.promise);
		try {
			const mock = await sendAsideFromSessionSwitchHook("DISPOSE_IN_CUSTOM_PREFLIGHT");
			await withTimeout(entered.promise, 5_000, "deferred delivery never reached its preflight");
			// The preflight suspends after the dispatch's own post-normalization disposal check, so
			// it is the boundary that has to re-ask.
			session?.beginDispose();
			release.resolve();
			for (let i = 0; i < 5; i++) await setImmediate();

			expect(mock.calls.length).toBe(0);
			expect(
				session?.messages.filter(m => m.role === "custom" && m.content === "DISPOSE_IN_CUSTOM_PREFLIGHT"),
			).toHaveLength(0);
		} finally {
			release.resolve();
			preflightSpy.mockRestore();
		}
	}, 45_000);

	it("closes the promised run once the compaction carrier that blocked the attempt lets go", async () => {
		const { settles, mock } = await startPooledRunWithStrandedAside();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const compactionSpy = spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return { continuationScheduled: false };
		});
		try {
			const compaction = session?.runIdleCompaction();
			await started.promise;
			await session?.setWorkPoolYieldItems([]);
			// The record is now in #wakeForIrc's compaction-wait closure. The user stop makes the
			// closure fold it instead of waking, and that fold's settlement attempt is refused
			// because the closure still holds it — nothing but the closure's own release retries.
			session?.suppressAutoResumeUntilPrompt();
			await session?.abort({ reason: USER_INTERRUPT_LABEL });
			release.resolve();
			await compaction;
			for (let i = 0; i < 5; i++) await setImmediate();
			await session?.waitForIdle();

			expect(session?.ircWakesPending).toBe(false);
			expect(mock.calls.length).toBe(1);
			expect(settles).toEqual([false, true]);
		} finally {
			release.resolve();
			compactionSpy.mockRestore();
		}
	}, 20_000);

	it("closes the promised run when disposal drops a compaction-held carrier", async () => {
		const { settles } = await startPooledRunWithStrandedAside();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const compactionSpy = spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return { continuationScheduled: false };
		});
		try {
			const compaction = session?.runIdleCompaction();
			await started.promise;
			await session?.setWorkPoolYieldItems([]);
			// beginDispose's flush finds nothing — the record is in the carrier — so its settlement
			// attempt is refused, and the carrier then drops the record on the disposed session.
			const disposing = session?.dispose();
			release.resolve();
			await compaction;
			for (let i = 0; i < 5; i++) await setImmediate();
			await disposing;

			expect(settles).toEqual([false, true]);
		} finally {
			release.resolve();
			compactionSpy.mockRestore();
		}
	}, 20_000);

	it("does not let an empty IRC wake hold keep a promised run open", async () => {
		const { settles } = await startPooledRunWithStrandedAside();
		const release = session?.holdIrcWakes();
		// A hold restricts when wakes may run; it is not evidence that a record is waiting. The
		// fold below leaves nothing queued, so the run must close even while the hold stands.
		session?.suppressAutoResumeUntilPrompt();
		await session?.setWorkPoolYieldItems([]);
		release?.();
		await session?.waitForIdle();

		expect(settles).toEqual([false, true]);
	}, 20_000);

	// Whether a prompt may reach the model once beginDispose() has run, whether it arrives
	// after disposal began or was admitted into a maintenance wait that disposal then
	// overtook, is decided in pull request #17457. That pull request changes the admission
	// contract for prompt, sendUserMessage, promptCustomMessage and
	// sendCustomMessage({ triggerTurn: true }) together, and its coverage lives there.

	it("keeps its published promise when disposal outruns the carrier holding the record", async () => {
		const { settles } = await startPooledRunWithStrandedAside();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const compactionSpy = spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return { continuationScheduled: false };
		});
		try {
			const compaction = session?.runIdleCompaction();
			await started.promise;
			await session?.setWorkPoolYieldItems([]);
			// Disposal finishes first, so the carrier's own retry would publish into a detached
			// listener list. A promise can only be kept while its subscribers are still there.
			await session?.dispose();
			expect(settles).toEqual([false, true]);

			release.resolve();
			await compaction;
			for (let i = 0; i < 5; i++) await setImmediate();
			// The late carrier release must not publish a second end.
			expect(settles).toEqual([false, true]);
		} finally {
			release.resolve();
			compactionSpy.mockRestore();
		}
	}, 20_000);

	it("folds a whole drained batch into the transcript before closing the run", async () => {
		// Two records strand together, so the fold below emits a batch rather than one message.
		const { settles } = await startPooledRunWithStrandedAside(["BATCH_FIRST_ASIDE", "BATCH_SECOND_ASIDE"]);
		const releaseHold = session?.holdIrcWakes();
		session?.suppressAutoResumeUntilPrompt();

		const snapshotsAtTerminal: string[][] = [];
		const unsubscribe = session?.subscribe(event => {
			if (event.type === "agent_end" && event.isTerminal !== false) {
				snapshotsAtTerminal.push(
					(session?.messages ?? []).flatMap(m =>
						m.role === "custom" && typeof m.content === "string" ? [m.content] : [],
					),
				);
			}
		});
		const releaseFromFold = session?.agent.subscribe(async (event: AgentEvent) => {
			// Reentry from inside the batch: the first record's own subscriber releases the hold,
			// which reaches settlement while the second record is still outside the transcript.
			if (event.type === "message_end" && JSON.stringify(event.message).includes("BATCH_FIRST_ASIDE")) {
				releaseHold?.();
			}
		});
		try {
			await session?.setWorkPoolYieldItems([]);
			await session?.waitForIdle();
		} finally {
			releaseFromFold?.();
			unsubscribe?.();
			releaseHold?.();
		}

		expect(settles).toEqual([false, true]);
		// The terminal subscriber's transcript must already contain every record of the batch.
		expect(snapshotsAtTerminal).toHaveLength(1);
		expect(snapshotsAtTerminal[0]).toContain("BATCH_FIRST_ASIDE");
		expect(snapshotsAtTerminal[0]).toContain("BATCH_SECOND_ASIDE");
	}, 20_000);

	it("never starts a carried IRC wake once disposal has completed", async () => {
		const { mock } = await startPooledRunWithStrandedAside();
		const rebuildEntered = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		let armed = false;
		const original = AgentSession.prototype.refreshBaseSystemPrompt;
		const rebuildSpy = spyOn(AgentSession.prototype, "refreshBaseSystemPrompt").mockImplementation(async function (
			this: AgentSession,
			commitIf?: () => boolean,
		) {
			if (armed) {
				rebuildEntered.resolve();
				await releaseRebuild.promise;
			}
			return original.call(this, commitIf);
		});
		const starts: string[] = [];
		const offAgent = session?.agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "agent_start") starts.push("agent_start");
		});
		let transition: Promise<void> | undefined;
		try {
			armed = true;
			// The wake joins this yield transition and parks there. The rebuild callback is
			// host-supplied, so the transition can outlast the whole session.
			transition = session?.setWorkPoolYieldItems([]);
			await withTimeout(rebuildEntered.promise, 5_000, "yield rebuild never entered");
			await session?.deliverIrcMessage({
				id: "late-pool-carrier",
				from: "peer",
				to: "recipient",
				body: "LATE_POOL_CARRIER",
				ts: Date.now(),
			});
			await withTimeout(session?.dispose({ drainTimeoutMs: 100 }) ?? Promise.resolve(), 5_000, "dispose hung");
			const callsAtDispose = mock.calls.length;

			releaseRebuild.resolve();
			await transition;
			for (let i = 0; i < 5; i++) await setImmediate();

			// A disposed session starts no turn, however long its transition took.
			expect(mock.calls.length).toBe(callsAtDispose);
			expect(starts).toHaveLength(0);
		} finally {
			releaseRebuild.resolve();
			await transition?.catch(() => {});
			offAgent?.();
			rebuildSpy.mockRestore();
		}
	}, 20_000);

	it("waits for the promised continuation to unwind before closing the run at disposal", async () => {
		const { settles } = await startPooledRunWithStrandedAside();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let atTerminal: { agentStreaming: boolean; sessionStreaming: boolean } | undefined;
		const unhook = session?.agent.addBeforeModelCallHook(async () => {
			entered.resolve();
			await release.promise;
		});
		const unsubscribe = session?.subscribe(event => {
			if (event.type === "agent_end" && event.isTerminal !== false && !atTerminal) {
				atTerminal = {
					agentStreaming: session?.agent.state.isStreaming === true,
					sessionStreaming: session?.isStreaming === true,
				};
			}
		});
		let disposal: Promise<void> | undefined;
		try {
			await session?.setWorkPoolYieldItems([]);
			await withTimeout(entered.promise, 5_000, "promised continuation never started");

			disposal = session?.dispose();
			for (let i = 0; i < 5; i++) await setImmediate();
			// The continuation IS the promised turn: closing the run while it executes publishes an
			// end that the work still unwinding behind it contradicts.
			expect(atTerminal).toBeUndefined();

			release.resolve();
			await disposal;
			expect(atTerminal).toEqual({ agentStreaming: false, sessionStreaming: false });
			expect(settles).toEqual([false, true]);
		} finally {
			release.resolve();
			unhook?.();
			await disposal;
			unsubscribe?.();
		}
	}, 20_000);

	it("keeps the wake half of a split batch counted while its fold emits", async () => {
		const { settles } = await startPooledRunWithStrandedAside(["BATCH_FOLD"]);
		await session?.deliverIrcMessage({
			id: "mixed-wake",
			from: "peer",
			to: "recipient",
			body: "MIXED_WAKE_RECORD",
			ts: Date.now(),
		});
		await session?.waitForIdle();

		const releaseHold = session?.holdIrcWakes();
		const trace: string[] = [];
		const wakePresentAtTerminal: boolean[] = [];
		const unsubscribe = session?.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "custom") {
				if (event.message.content === "BATCH_FOLD") {
					trace.push("fold");
					// Reentry from inside the fold, while the wake half sits in a local array.
					releaseHold?.();
				} else if (JSON.stringify(event.message).includes("MIXED_WAKE_RECORD")) {
					trace.push("wake-record");
				}
			}
			if (event.type === "agent_end" && event.isTerminal !== false) {
				trace.push("terminal");
				wakePresentAtTerminal.push(JSON.stringify(session?.messages).includes("MIXED_WAKE_RECORD"));
			}
		});
		try {
			session?.suppressAutoResumeUntilPrompt();
			await session?.setWorkPoolYieldItems([]);
			await session?.waitForIdle();
		} finally {
			releaseHold?.();
			unsubscribe?.();
		}

		// The wake record is drained from the queue by the same split that produced the fold, so
		// the run cannot close before it reaches the transcript.
		expect(trace.indexOf("terminal")).toBeGreaterThan(trace.indexOf("wake-record"));
		expect(wakePresentAtTerminal).toEqual([true]);
		expect(settles).toEqual([false, true]);
	}, 20_000);

	it("still cleans up a continuation that outlived the dispose deadline", async () => {
		await startPooledRunWithStrandedAside();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const unhook = session?.agent.addBeforeModelCallHook(async () => {
			entered.resolve();
			await release.promise;
		});
		try {
			await session?.setWorkPoolYieldItems([]);
			await withTimeout(entered.promise, 5_000, "promised continuation never started");

			// The deadline bounds the caller's wait. It must not declare the run settled: the loop
			// is still inside its hook and will repopulate everything disposal just released.
			await session?.dispose({ drainTimeoutMs: 50 });

			release.resolve();
			await withTimeout(session?.agent.waitForIdle() ?? Promise.resolve(), 5_000, "continuation never ended");
			for (let i = 0; i < 10; i++) await setImmediate();

			// The deferred finalizer re-runs the in-memory reset once the run genuinely ends.
			expect(session?.messages).toHaveLength(0);
		} finally {
			release.resolve();
			unhook?.();
		}
	}, 20_000);

	it("charges disposal one drain window, not one per wait", async () => {
		const handlerEntered = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();
		// Only the marker record is gated: holding every notification would also hold the
		// session_shutdown emit that disposal runs before it reaches these waits.
		await startPooledRunWithStrandedAside(undefined, async event => {
			if (event.message.role === "custom" && event.message.customType === "slow-handler") {
				handlerEntered.resolve();
				await releaseHandler.promise;
			}
		});
		const entered = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const unhook = session?.agent.addBeforeModelCallHook(async () => {
			entered.resolve();
			await releaseHook.promise;
		});
		let disposal: Promise<void> | undefined;
		try {
			await session?.setWorkPoolYieldItems([]);
			await withTimeout(entered.promise, 5_000, "promised continuation never started");
			session?.agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "custom",
					customType: "slow-handler",
					content: "HELD_HANDLER",
					display: false,
					timestamp: Date.now(),
				},
			});
			await withTimeout(handlerEntered.promise, 5_000, "event handler never entered");

			// Both the loop and an in-flight event handler are held, so both waits time out. They
			// are one unwind and share one window.
			const startedAt = Date.now();
			disposal = session?.dispose({ drainTimeoutMs: 500 });
			await disposal;
			expect(Date.now() - startedAt).toBeLessThan(900);
		} finally {
			releaseHook.resolve();
			releaseHandler.resolve();
			unhook?.();
			await disposal;
			await session?.agent.waitForIdle();
		}
	}, 20_000);

	it("does not let its own reset stand in for the queued preparation it is waiting on", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		// `before_agent_start` runs inside the agent's queued-message dequeue hook, so the
		// preparation is live while this is held.
		await startPooledRunWithStrandedAside(undefined, undefined, async event => {
			if (event.prompt !== "QUEUED_PREPARATION") return;
			entered.resolve();
			await release.promise;
		});
		// `Agent.reset()` resolves the running prompt while a queue claim is held, so disposal's own
		// reset makes `waitForIdle()` answer "idle". Counting resets shows whether the deferred
		// finalizer believed it.
		const resetSpy = spyOn(Agent.prototype, "reset");
		try {
			await session?.followUp("QUEUED_PREPARATION");
			await withTimeout(entered.promise, 5_000, "queued preparation never started");

			await withTimeout(session?.dispose({ drainTimeoutMs: 60 }) ?? Promise.resolve(), 10_000, "dispose hung");
			// The finalizer must still be waiting: one reset, from disposal itself.
			expect(resetSpy.mock.calls).toHaveLength(1);

			release.resolve();
			for (let i = 0; i < 20; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			release.resolve();
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("does not mistake an extension wait timeout for the handler having finished", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await startPooledRunWithStrandedAside(undefined, async event => {
			if (event.message.role !== "custom" || event.message.customType !== "slow-handler") return;
			entered.resolve();
			await release.promise;
		});
		const resetSpy = spyOn(Agent.prototype, "reset");
		// The runner RACES each handler against this timeout, so the dispatch returns while the
		// callback runs on. Set well below the dispose drain below, so the race has certainly
		// settled by the time dispose returns and no guessed wait is needed to get past it.
		testSetExtensionHandlerTimeoutMs(10);
		try {
			session?.agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "custom",
					customType: "slow-handler",
					content: "EXTENSION_TIMEOUT",
					display: false,
					timestamp: Date.now(),
				},
			});
			await withTimeout(entered.promise, 5_000, "extension handler never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 200 }) ?? Promise.resolve(), 10_000, "dispose hung");
			// The dispatch has given up on the handler; the callback itself is still running.
			expect(resetSpy.mock.calls).toHaveLength(1);

			release.resolve();
			for (let i = 0; i < 20; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
			release.resolve();
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("reports an interrupted prompt as aborted, not as the previous turn's success", async () => {
		await startPooledRunWithStrandedAside();
		const frames: unknown[] = [];
		const results = new RpcPromptResults(session!, frame => frames.push(frame));
		const ticket = results.begin("interrupted-prompt");
		const off = session?.subscribe(event => results.observe(event));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const unhook = session?.agent.addBeforeModelCallHook(async () => {
			entered.resolve();
			await release.promise;
		});
		let command: Promise<boolean> | undefined;
		try {
			command = session?.prompt("CURRENT_USER_PROMPT");
			await withTimeout(entered.promise, 5_000, "prompt never reached the model call");

			await withTimeout(session?.dispose({ drainTimeoutMs: 60 }) ?? Promise.resolve(), 10_000, "dispose hung");
			release.resolve();
			await command;
			results.settle(ticket);
			for (let i = 0; i < 5; i++) await setImmediate();

			// The held `agent_end` describes the PREVIOUS turn, which succeeded. Publishing it to
			// close the obligation must not report that success as this prompt's outcome.
			expect(frames).toContainEqual(expect.objectContaining({ status: "aborted" }));
			expect(frames).not.toContainEqual(expect.objectContaining({ status: "completed" }));
		} finally {
			release.resolve();
			await command;
			unhook?.();
			off?.();
		}
	}, 20_000);

	it("does not finish disposal in the gap between two handlers of one broadcast", async () => {
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let secondSeen = false;
		let finalizedBeforeSecond: boolean | undefined;
		let armed = false;
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			// Two handlers for one event: the broadcast runs them one after another, so between
			// them nothing is executing while work that was registered all along has not started.
			pi.on("agent_start", async () => {
				if (!armed) return;
				firstEntered.resolve();
				await releaseFirst.promise;
			});
			pi.on("agent_start", () => {
				if (!armed) return;
				secondSeen = true;
				finalizedBeforeSecond = resetSpy.mock.calls.length > 1;
			});
		});
		const resetSpy: ReturnType<typeof spyOn> = spyOn(Agent.prototype, "reset");
		let broadcast: Promise<unknown> | undefined;
		try {
			armed = true;
			broadcast = session?.extensionRunner?.emit({ type: "agent_start" });
			await withTimeout(firstEntered.promise, 5_000, "first handler never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			releaseFirst.resolve();
			await broadcast;
			for (let i = 0; i < 40; i++) await setImmediate();
			// A dispatch under way when its session ends runs to its end — the handlers after the one
			// that was running still run — and disposal's finalizer waits for all of it, so it does not
			// finish in the gap between them.
			expect({ secondSeen, finalizedBeforeSecond }).toEqual({ secondSeen: true, finalizedBeforeSecond: false });
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			releaseFirst.resolve();
			await broadcast;
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("re-asks for live work after the reset its own disposal performs", async () => {
		const release = Promise.withResolvers<void>();
		let entered = false;
		let armed = false;
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			pi.on("agent_start", async () => {
				if (!armed) return;
				entered = true;
				await release.promise;
			});
		});
		const resetSpy = spyOn(Agent.prototype, "reset");
		// `Agent.reset()` notifies queue-change observers synchronously, and disposal performs that
		// reset after it has sampled whether anything is live. A host observer that dispatches from
		// there starts extension work the sample cannot have seen.
		let dispatched: Promise<unknown> | undefined;
		let sent = false;
		const offQueueChange = session?.agent.onQueueChange(() => {
			if (sent || session?.isDisposed !== true) return;
			sent = true;
			armed = true;
			dispatched = session?.extensionRunner?.emit({ type: "agent_start" });
		});
		try {
			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			await dispatched;
			for (let i = 0; i < 40; i++) await setImmediate();
			// The dispatch its own reset produced is inert: a retired session starts no callback.
			expect(sent).toBe(true);
			expect(entered).toBe(false);
		} finally {
			release.resolve();
			await dispatched;
			offQueueChange?.();
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("owns every emit entry point, not only the generic broadcast", () => {
		// The enumeration that matters is structural, not a list in a comment: every public entry
		// point that can run handlers is named `emit*`, and each one must be wrapped with dispatch
		// ownership when the runner is constructed. A new emitter cannot opt out by forgetting.
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner(
			[],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(tempDir.path()),
			new ModelRegistry(authStorage),
		);
		const emitters = Object.getOwnPropertyNames(ExtensionRunner.prototype).filter(
			name =>
				name.startsWith("emit") &&
				typeof Object.getOwnPropertyDescriptor(ExtensionRunner.prototype, name)?.value === "function",
		);
		expect(emitters.length).toBeGreaterThan(10);
		const unowned = emitters.filter(name => !Object.hasOwn(runner, name));
		expect(unowned).toEqual([]);
	});

	it("retires callbacks per session, not per runtime, when a host reuses one runner", async () => {
		// A host may build one runner and runtime and hand it to several sessions in turn
		// (agent-session-concurrent.test.ts does). Retirement therefore belongs to the session's
		// claim, not to the runtime's own lifetime.
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		let seen = 0;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_start", () => {
					seen++;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"r14-per-session-owner",
		);
		const runner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["ack"] }] });
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const makeSession = (): AgentSession =>
			new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
					convertToLlm,
					streamFn: mock.stream,
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry,
				toolRegistry: new Map(),
				extensionRunner: runner,
			});

		const first = makeSession();
		await runner.emit({ type: "agent_start" });
		expect(seen).toBe(1);

		// Direction one: what the disposed session accepted is inert while no session holds it.
		await first.dispose();
		expect(runtime.isRetired).toBe(true);
		await runner.emit({ type: "agent_start" });
		expect(seen).toBe(1);

		// Direction two: the next session's claim revives the same handlers.
		session = makeSession();
		expect(runtime.isRetired).toBe(false);
		await runner.emit({ type: "agent_start" });
		expect(seen).toBe(2);
	}, 20_000);

	it("keeps a sibling's callbacks live through a reentrant disposal", async () => {
		// `dispose()` publishes its promise before the teardown runs, so a disposer that disposes
		// the session again gets that promise instead of a second teardown. A second teardown
		// would release this session's claim twice and retire a live sibling's surface.
		const modelRegistry = new ModelRegistry(authStorage);
		let seen = 0;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_start", () => {
					seen++;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"r15-reentrant-dispose",
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(tempDir.path()),
			modelRegistry,
		);
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["ack"] }] });
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const makeSession = (): AgentSession =>
			new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
					convertToLlm,
					streamFn: mock.stream,
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry,
				toolRegistry: new Map(),
				extensionRunner: runner,
			});

		const closing = makeSession();
		session = makeSession();
		let reentered: Promise<void> | undefined;
		closing.addDisposer(() => {
			reentered = closing.dispose();
		});
		const outer = closing.dispose();
		await outer;
		await reentered;
		// The disposer reentered before the teardown's first await; it must have received the
		// call already in flight rather than starting a second one.
		expect(reentered).toBe(outer);

		// The sibling never disposed, so the surface is still held and its handlers still run.
		expect(runtime.isRetired).toBe(false);
		await runner.emit({ type: "agent_start" });
		expect(seen).toBe(1);
	}, 20_000);

	it("pairs the extension-callback claim with the only release there is", () => {
		// The release is a handle from the claim, not a second method: nothing can release a hold
		// it never took, and releasing one twice releases once.
		const runtime = new ExtensionRuntime();
		const first = runtime.beginSession();
		const second = runtime.beginSession();
		expect(runtime.isRetired).toBe(false);

		first();
		first();
		first();
		// Three calls, one hold given back: the sibling's is untouched.
		expect(runtime.isRetired).toBe(false);

		second();
		expect(runtime.isRetired).toBe(true);

		// A claim after retirement revives the surface, and the spent handles cannot retire it
		// again: each releases the lease it claimed.
		const third = runtime.beginSession();
		expect(runtime.isRetired).toBe(false);
		first();
		second();
		expect(runtime.isRetired).toBe(false);
		third();
		expect(runtime.isRetired).toBe(true);
	});

	it("finishes teardown when a host's release handle throws", async () => {
		// The release is reported and swallowed: the session writer, the account pools and the
		// memory consolidation must not be skipped because an extension surface threw on the way
		// out. A partial runner is a supported host shape, so this one implements just the claim.
		let released = 0;
		const runner = {
			claimExtensionCallbacks: () => () => {
				released++;
				throw new Error("release failed");
			},
		} as unknown as ExtensionRunner;
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["ack"] }] });
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const failing = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(),
			extensionRunner: runner,
		});
		let closed = false;
		const closeSpy = spyOn(failing.sessionManager, "close").mockImplementation(async () => {
			closed = true;
		});
		try {
			await withTimeout(failing.dispose(), 10_000, "dispose hung");
			expect(released).toBe(1);
			expect(closed).toBe(true);
		} finally {
			closeSpy.mockRestore();
		}
	}, 20_000);

	it("keeps ownership between the handlers of a specialised emitter", async () => {
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let secondSeen = false;
		let finalizedBeforeSecond: boolean | undefined;
		let armed = false;
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			// `user_bash` runs its own sequential handler loop, outside the generic broadcast.
			pi.on("user_bash", async () => {
				if (!armed) return;
				firstEntered.resolve();
				await releaseFirst.promise;
			});
			pi.on("user_bash", () => {
				if (!armed) return;
				secondSeen = true;
				finalizedBeforeSecond = resetSpy.mock.calls.length > 1;
			});
		});
		const resetSpy: ReturnType<typeof spyOn> = spyOn(Agent.prototype, "reset");
		let bash: Promise<unknown> | undefined;
		try {
			armed = true;
			bash = session?.executeBash("true");
			await withTimeout(firstEntered.promise, 5_000, "first user_bash handler never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			releaseFirst.resolve();
			await bash?.catch(() => undefined);
			for (let i = 0; i < 40; i++) await setImmediate();
			// A specialised emitter's loop is a dispatch too: it runs to its end, and disposal's
			// finalizer waits for all of it.
			expect({ secondSeen, finalizedBeforeSecond }).toEqual({ secondSeen: true, finalizedBeforeSecond: false });
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			releaseFirst.resolve();
			await bash?.catch(() => undefined);
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("holds credential restrictions until running work ends, and admits no new work meanwhile", async () => {
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let secondSeen = false;
		let armed = false;
		let handled = 0;
		const poolScope = new SessionAccountPoolScope(authStorage, {} as unknown as OAuthAccountPools, "r9-pool-probe");
		await startPooledRunWithStrandedAside(
			undefined,
			undefined,
			undefined,
			pi => {
				pi.on("agent_start", async () => {
					if (!armed) return;
					if (++handled === 1) {
						firstEntered.resolve();
						await releaseFirst.promise;
						return;
					}
					secondSeen = true;
				});
			},
			poolScope,
		);
		const resetSpy = spyOn(Agent.prototype, "reset");
		const releaseSpy = spyOn(poolScope, "release");
		const broadcasts: Promise<unknown>[] = [];
		// The deferred pass's own reset notifies queue observers synchronously. This one dispatches
		// only from that second reset, so the staleness is squarely in the deferred path: it asked
		// once before resetting, and used to release without asking again.
		const offQueueChange = session?.agent.onQueueChange(() => {
			if (session?.isDisposed !== true || resetSpy.mock.calls.length !== 2) return;
			const dispatch = session?.extensionRunner?.emit({ type: "agent_start" });
			if (dispatch) broadcasts.push(dispatch);
		});
		try {
			// Held extension work before disposal, so the main drain defers to the deferred pass.
			armed = true;
			const first = session?.extensionRunner?.emit({ type: "agent_start" });
			if (first) broadcasts.push(first);
			await withTimeout(firstEntered.promise, 5_000, "first handler never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(releaseSpy.mock.calls).toHaveLength(0);

			releaseFirst.resolve();
			await Promise.all(broadcasts);
			for (let i = 0; i < 40; i++) await setImmediate();
			offQueueChange?.();
			// The restriction is lifted once the callback that WAS running ends; the dispatch the
			// reset produced is inert, so there is no second entry to wait for.
			expect(handled).toBe(1);
			expect(secondSeen).toBe(false);
			expect(releaseSpy.mock.calls).toHaveLength(1);
		} finally {
			offQueueChange?.();
			releaseFirst.resolve();
			await Promise.all(broadcasts);
			releaseSpy.mockRestore();
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("owns an admitted extension command that outlives disposal", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			pi.registerCommand("r9-held", {
				description: "held command",
				handler: async () => {
					entered.resolve();
					await release.promise;
				},
			});
		});
		const resetSpy = spyOn(Agent.prototype, "reset");
		let command: Promise<unknown> | undefined;
		try {
			// An extension command runs through `runScoped`, not the tracked handler path; the
			// session owns it only as an admitted submission.
			command = session?.prompt("/r9-held");
			await withTimeout(entered.promise, 5_000, "extension command never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			release.resolve();
			await command?.catch(() => undefined);
			for (let i = 0; i < 40; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			release.resolve();
			await command?.catch(() => undefined);
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("owns a callback a controller invokes directly, not only one a broadcast dispatches", async () => {
		await startPooledRunWithStrandedAside();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const resetSpy = spyOn(Agent.prototype, "reset");
		let callback: unknown;
		try {
			// Exactly how the input controller runs a keyboard shortcut and how the file
			// write/delete fallbacks run their handlers: straight through `runScoped`, with no
			// broadcast and no admitted submission to infer a lifetime from.
			callback = session?.extensionRunner?.runScoped(async () => {
				entered.resolve();
				await release.promise;
			});
			await withTimeout(entered.promise, 5_000, "scoped callback never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			release.resolve();
			await callback;
			for (let i = 0; i < 40; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			release.resolve();
			await callback;
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("waits for a parked callback instead of polling for it", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			pi.registerLinkScheme("r10poll");
			pi.on("link_activate", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		cfgExtensionAssistantTextRenderers.set(session!.settings, true);
		const waitSpy = spyOn(ExtensionRunner.prototype, "waitForPendingHandlerWork");
		// The dispatch is outstanding while its one callback is parked. A finalizer that samples
		// for the next callback instead of waiting for it burns an iteration per turn of the event
		// loop; one that waits makes a single call and stays there.
		const dispatch = session?.extensionRunner?.emitLinkActivate("r10poll:held");
		try {
			await withTimeout(entered.promise, 5_000, "link handler never entered");
			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");

			const waitsAfterDispose = waitSpy.mock.calls.length;
			for (let i = 0; i < 40; i++) await setImmediate();
			expect(waitSpy.mock.calls.length - waitsAfterDispose).toBeLessThan(5);
		} finally {
			release.resolve();
			await dispatch;
			waitSpy.mockRestore();
		}
	}, 20_000);

	it("leaves no in-memory transcript behind work its deferred reset started", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let armed = false;
		let handled = 0;
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			pi.on("agent_start", async () => {
				if (!armed) return;
				if (++handled === 1) {
					entered.resolve();
					await release.promise;
					return;
				}
				// Reset-produced work that writes to the in-memory transcript after disposal has
				// already cleared it once.
				session?.agent.appendMessage({
					role: "custom",
					customType: "r10-residue",
					content: "R10_RESIDUE",
					display: false,
					timestamp: Date.now(),
				});
			});
		});
		const resetSpy = spyOn(Agent.prototype, "reset");
		const broadcasts: Promise<unknown>[] = [];
		const offQueueChange = session?.agent.onQueueChange(() => {
			if (session?.isDisposed !== true || resetSpy.mock.calls.length !== 2) return;
			const dispatch = session?.extensionRunner?.emit({ type: "agent_start" });
			if (dispatch) broadcasts.push(dispatch);
		});
		try {
			armed = true;
			const first = session?.extensionRunner?.emit({ type: "agent_start" });
			if (first) broadcasts.push(first);
			await withTimeout(entered.promise, 5_000, "first handler never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			release.resolve();
			// The deferred pass's own reset is what dispatches the second broadcast, so the observer
			// has to stay attached past the first dispatch completing.
			for (let i = 0; i < 40; i++) await setImmediate();
			offQueueChange?.();
			await Promise.all(broadcasts);
			for (let i = 0; i < 40; i++) await setImmediate();

			// Under retirement the reset-produced dispatch never enters, so nothing writes — the
			// earlier contract (enter, then clear what it wrote) is the weaker of the two.
			expect(handled).toBe(1);
			expect(session?.messages).toHaveLength(0);
		} finally {
			offQueueChange?.();
			release.resolve();
			await Promise.all(broadcasts);
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("owns a callback a timer invokes, not only one the runner invokes", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let armed = false;
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			pi.on("agent_start", (_event, ctx) => {
				if (!armed) return;
				// ManagedTimers invokes this, not the runner: clearing the handle on teardown stops
				// future firings and says nothing about a callback already running.
				ctx.setTimeout(() => {
					entered.resolve();
					return release.promise;
				}, 0);
			});
		});
		const resetSpy = spyOn(Agent.prototype, "reset");
		let broadcast: Promise<unknown> | undefined;
		try {
			armed = true;
			broadcast = session?.extensionRunner?.emit({ type: "agent_start" });
			await withTimeout(entered.promise, 5_000, "timer callback never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			release.resolve();
			for (let i = 0; i < 40; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			release.resolve();
			await broadcast;
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("owns a callback the event bus invokes", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let emit: ((channel: string, data: unknown) => void) | undefined;
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			// `pi.events` subscriptions never reach the runner: the bus calls them.
			pi.events.on("r11-channel", async () => {
				entered.resolve();
				await release.promise;
			});
			emit = (channel, data) => pi.events.emit(channel, data);
		});
		const resetSpy = spyOn(Agent.prototype, "reset");
		try {
			emit?.("r11-channel", {});
			await withTimeout(entered.promise, 5_000, "event bus handler never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			release.resolve();
			for (let i = 0; i < 40; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			release.resolve();
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("owns a bus subscription made from a captured pi, off every scope and under the wrong one", async () => {
		// `pi.events` is a view bound to the session that handed it out, so a subscription made
		// from a captured reference belongs to that session however it is reached: from no scope
		// at all, and from inside another session's scope.
		const bus = new EventBus();
		const first = new ExtensionRuntime();
		const second = new ExtensionRuntime();
		const releaseFirst = first.beginSession();
		second.beginSession();
		let firstApi!: ExtensionAPI;
		await loadExtensionFromFactory(
			pi => {
				firstApi = pi;
			},
			tempDir.path(),
			bus,
			first,
			"r15-captured-owner",
		);

		// Registered while the SECOND session is the one accepting on the stack. The reference
		// came from the first, and that is whose callback it is.
		const release = Promise.withResolvers<void>();
		let calls = 0;
		extensionCallbackScope.run(second, () => {
			firstApi.events.on("r15-captured", async () => {
				calls++;
				await release.promise;
			});
		});
		bus.emit("r15-captured", {});
		for (let i = 0; i < 5; i++) await setImmediate();
		expect(calls).toBe(1);
		expect(first.hasPendingCallbacks()).toBe(true);
		expect(second.hasPendingCallbacks()).toBe(false);
		release.resolve();
		await first.waitForPendingCallbacks();

		// Captured and used after the owning session is gone, with nothing on the stack: inert.
		releaseFirst();
		firstApi.events.on("r15-captured-late", () => {
			calls++;
		});
		bus.emit("r15-captured", {});
		bus.emit("r15-captured-late", {});
		for (let i = 0; i < 5; i++) await setImmediate();
		expect(calls).toBe(1);
	}, 20_000);

	it("owns a subscription made through a view of a view, and deduplicates aliased transports", async () => {
		// A host may hand one session's `pi.events` to the next session as its bus — the SDK takes
		// an `EventBus` and a view is one. The inner view must not take the subscription back from
		// the session that is registering it.
		const bus = new EventBus();
		const parent = new ExtensionRuntime();
		const child = new ExtensionRuntime();
		const releaseParent = parent.beginSession();
		const releaseChild = child.beginSession();
		let parentApi!: ExtensionAPI;
		let childApi!: ExtensionAPI;
		await loadExtensionFromFactory(
			pi => {
				parentApi = pi;
			},
			tempDir.path(),
			bus,
			parent,
			"r16-parent",
		);
		await loadExtensionFromFactory(
			pi => {
				childApi = pi;
			},
			tempDir.path(),
			parentApi.events,
			child,
			"r16-child",
		);

		const release = Promise.withResolvers<void>();
		let calls = 0;
		childApi.events.on("r16-nested", async () => {
			calls++;
			await release.promise;
		});
		bus.emit("r16-nested", {});
		for (let i = 0; i < 5; i++) await setImmediate();
		expect(calls).toBe(1);
		// The child's work is the child's: the parent must not be holding it open, and must not
		// be able to end it either.
		expect(child.hasPendingCallbacks()).toBe(true);
		expect(parent.hasPendingCallbacks()).toBe(false);
		release.resolve();
		await child.waitForPendingCallbacks();

		releaseParent();
		bus.emit("r16-nested", {});
		for (let i = 0; i < 5; i++) await setImmediate();
		expect(calls).toBe(2);
		releaseChild();
		bus.emit("r16-nested", {});
		for (let i = 0; i < 5; i++) await setImmediate();
		expect(calls).toBe(2);

		// A raw bus and a view onto it are two handles on one transport, so a frame published to
		// both must reach a subscriber once.
		let frames = 0;
		bus.on("r16-frame", () => {
			frames++;
		});
		emitSubagentFrame(bus, parentApi.events, "r16-frame", {});
		for (let i = 0; i < 5; i++) await setImmediate();
		expect(frames).toBe(1);
	}, 20_000);

	it("owns a promise from another realm, which fails the Promise brand check", async () => {
		await startPooledRunWithStrandedAside();
		const realm = createContext({});
		// Foreign-realm source, so the executor form is the only form available here — and that is
		// the point: a pending Promise whose constructor is not this realm's.
		const foreign = runInContext(
			"new Promise(resolve => { globalThis.__release = resolve; })",
			realm,
		) as PromiseLike<void>;
		expect(foreign instanceof Promise).toBe(false);
		const resetSpy = spyOn(Agent.prototype, "reset");
		try {
			session?.extensionRunner?.runScoped(() => foreign);
			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			runInContext("globalThis.__release()", realm);
			await foreign;
			for (let i = 0; i < 40; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			runInContext("globalThis.__release?.()", realm);
			resetSpy.mockRestore();
		}
	}, 20_000);

	it("binds no deferred extension once the session is disposed", async () => {
		await startPooledRunWithStrandedAside();
		let factoryRan = false;
		session?.setDeferredExtensionLoader(async () => {
			factoryRan = true;
		});
		await session?.dispose();

		// Loading runs the factory, which is extension code with this session's context: a refusal
		// at the command, or in a host loader that checks disposal after loading, is too late.
		await session?.prompt("/r11-never-bound");
		for (let i = 0; i < 20; i++) await setImmediate();
		expect(factoryRan).toBe(false);
	}, 20_000);

	it("leaves no transcript behind a public bash command that outlived disposal", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			pi.on("user_bash", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		let command: Promise<unknown> | undefined;
		try {
			command = session?.executeBash("printf R11_PUBLIC_BASH");
			await withTimeout(entered.promise, 5_000, "user_bash handler never entered");
			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");

			release.resolve();
			await command;
			for (let i = 0; i < 40; i++) await setImmediate();
			// The child process finishing is not the end of the work: recording its result appends.
			expect(session?.messages).toHaveLength(0);
		} finally {
			release.resolve();
			await command;
		}
	}, 20_000);

	it("refuses a bus subscription a facility still holds after disposal", async () => {
		let bus: EventBus | undefined;
		let entered = 0;
		await startPooledRunWithStrandedAside(undefined, undefined, undefined, pi => {
			bus = pi.events;
			pi.events.on("r12-after-dispose", () => {
				entered++;
			});
		});
		await session?.dispose();

		// The bus still holds the subscription — a host can share it, and nothing unsubscribes it.
		// Reporting the call would come too late: disposal has released what the callback reads.
		bus?.emit("r12-after-dispose", {});
		for (let i = 0; i < 20; i++) await setImmediate();
		expect(entered).toBe(0);
	}, 20_000);

	it("attributes a shared bus subscription to the session that registered it", async () => {
		const bus = new EventBus();
		const firstRuntime = new ExtensionRuntime();
		const secondRuntime = new ExtensionRuntime();
		const release = Promise.withResolvers<void>();
		const releaseFirstClaim = firstRuntime.beginSession();
		await loadExtensionFromFactory(
			pi => {
				pi.events.on("r12-shared", () => undefined);
			},
			tempDir.path(),
			bus,
			firstRuntime,
			"first",
		);
		await loadExtensionFromFactory(
			pi => {
				pi.events.on("r12-shared", async () => await release.promise);
			},
			tempDir.path(),
			bus,
			secondRuntime,
			"second",
		);
		try {
			// The first session is gone; its retirement must not silence the second's handler, and
			// the second's work must not be attributed to the first.
			releaseFirstClaim();
			bus.emit("r12-shared", {});
			for (let i = 0; i < 5; i++) await setImmediate();

			expect(firstRuntime.hasPendingCallbacks()).toBe(false);
			expect(secondRuntime.hasPendingCallbacks()).toBe(true);
		} finally {
			release.resolve();
			await secondRuntime.waitForPendingCallbacks();
		}
	}, 20_000);

	it("owns a deferred load the host started before disposal", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await startPooledRunWithStrandedAside();
		session?.setDeferredExtensionLoader(async () => {
			entered.resolve();
			await release.promise;
		});
		const resetSpy = spyOn(Agent.prototype, "reset");
		let load: Promise<void> | undefined;
		try {
			// Started BEFORE disposal, so the load-time refusal has nothing to say about it.
			load = session?.loadDeferredExtensions();
			await withTimeout(entered.promise, 5_000, "deferred factory never entered");

			await withTimeout(session?.dispose({ drainTimeoutMs: 40 }) ?? Promise.resolve(), 10_000, "dispose hung");
			expect(resetSpy.mock.calls).toHaveLength(1);

			release.resolve();
			await load;
			for (let i = 0; i < 40; i++) await setImmediate();
			expect(resetSpy.mock.calls).toHaveLength(2);
		} finally {
			release.resolve();
			await load;
			resetSpy.mockRestore();
		}
	}, 20_000);
});
