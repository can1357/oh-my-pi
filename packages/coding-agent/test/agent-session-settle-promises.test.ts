import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type AgentEvent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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
	 *  dispatch is under way. */
	async function sendAsideFromSessionSwitchHook(body: string): Promise<MockModel> {
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
				pi.on("session_switch", async () => {
					hookEntered.resolve();
					await session?.sendCustomMessage(
						{ customType: "ext-aside", content: body, display: false, attribution: "agent" },
						{ deliverAs: "aside" },
					);
					sendFinished = true;
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
		const compactionSpy = spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockImplementation(async () => {
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
	async function startPooledRunWithStrandedAside(): Promise<{
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
					await session?.sendCustomMessage(
						{ customType: "ext-aside", content: "STRANDED_TRIGGER_ASIDE", display: false, attribution: "agent" },
						{ deliverAs: "aside", triggerTurn: true },
					);
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"stranded-aside-sender",
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
		const settles: Array<boolean | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") settles.push(event.isTerminal);
		});
		await session.setWorkPoolYieldItems([{ id: "item-a", index: 0 }]);

		await session.prompt("go");
		await session.waitForIdle();

		// The run promised a continuation for the aside it could not deliver.
		expect(settles.at(-1)).toBe(false);
		expect(JSON.stringify(session.agent.state.messages)).not.toContain("STRANDED_TRIGGER_ASIDE");
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
});
