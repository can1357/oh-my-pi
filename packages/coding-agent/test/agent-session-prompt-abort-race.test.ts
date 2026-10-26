/**
 * abort() can land while prompt() is still normalizing images or building the
 * vision-model description for a text-only model — both run before
 * PromptOptions.onPromptAdmitted fires. The prompt must be dropped (handed to
 * setPromptDropped) instead of starting a turn or entering a queue afterward,
 * and abort() must cancel an in-flight vision description rather than wait on it.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageVisionFallback from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { withTimeout } from "@oh-my-pi/pi-utils";

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

describe("AgentSession prompt admission racing abort", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	const restores: Array<() => void> = [];

	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		await session?.dispose();
		authStorage?.close();
	});

	async function createSession(
		responses: Array<() => MockResponse | Promise<MockResponse>>,
		textOnly = false,
		options: {
			modelRegistry?: Pick<ModelRegistry, "getApiKey">;
			clientBridge?: unknown;
			extensionRunner?: unknown;
		} = {},
	) {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model: Model = textOnly ? { ...bundled, input: ["text"] } : bundled;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const fallbackRegistry = new ModelRegistry(authStorage);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: (options.modelRegistry ?? fallbackRegistry) as never,
			...(options.extensionRunner ? { extensionRunner: options.extensionRunner as never } : {}),
		});
		if (options.clientBridge) {
			session.setClientBridge(options.clientBridge as never);
		}
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));
		return { session, dropped, modelRegistry: options.modelRegistry ?? fallbackRegistry };
	}

	/** Holds image normalization for image-bearing calls until released. */
	function holdImageNormalization() {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const spy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			started.resolve();
			await release.promise;
			return images;
		});
		restores.push(() => spy.mockRestore());
		return { started: started.promise, release: () => release.resolve() };
	}

	it("drops an idle prompt instead of dispatching it when abort lands mid-normalization", async () => {
		const streamCalls: string[] = [];
		const { session, dropped } = await createSession([
			() => {
				streamCalls.push("started");
				return { content: ["should not run"] };
			},
		]);
		const normalization = holdImageNormalization();

		let admitted = false;
		const promptPromise = session.prompt("go while normalizing", {
			images: [IMAGE],
			onPromptAdmitted: () => {
				admitted = true;
			},
		});

		await withTimeout(normalization.started, 2_000, "Normalization never started");
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		normalization.release();

		expect(await promptPromise).toBe(true);
		expect(admitted).toBe(false);
		expect(dropped).toEqual(["go while normalizing"]);
		expect(streamCalls).toEqual([]);
	});

	it("drops a streaming prompt instead of queueing it when abort lands mid-normalization", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		let calls = 0;
		const { session, dropped } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
			() => {
				calls++;
				return { content: ["should not run"] };
			},
		]);
		const normalization = holdImageNormalization();

		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");

		let admitted = false;
		const queuedPromise = session.prompt("queue while normalizing", {
			images: [IMAGE],
			streamingBehavior: "followUp",
			onPromptAdmitted: () => {
				admitted = true;
			},
		});
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		releaseTurn.resolve();
		await aborting;
		normalization.release();

		expect(await queuedPromise).toBe(true);
		await running;
		await session.waitForIdle();
		expect(admitted).toBe(false);
		expect(dropped).toEqual(["queue while normalizing"]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
		expect(calls).toBe(1);
	});

	it("keeps the next prompt busy when an interrupted setup unwinds late", async () => {
		const { session, modelRegistry } = await createSession([() => ({ content: ["done"] })]);
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		let calls = 0;
		const spy = spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
			const index = calls++;
			if (index < 2) {
				entered[index].resolve();
				await release[index].promise;
			}
			return getApiKey(model, sessionId, options);
		});
		restores.push(() => spy.mockRestore());

		const first = session.prompt("first");
		await withTimeout(entered[0].promise, 2_000, "First prompt did not reach setup");
		await session.abort();

		const second = session.prompt("second");
		await withTimeout(entered[1].promise, 2_000, "Second prompt did not reach setup");
		expect(session.isStreaming).toBe(true);

		release[0].resolve();
		await first;
		expect(session.isStreaming).toBe(true);

		release[1].resolve();
		await second;
		expect(session.isStreaming).toBe(false);
	});

	it("settles a turn begun while abort() was finishing, running a steer queued as it ends", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		const { session } = await createSession([
			async () => {
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["done"] };
			},
			() => ({ content: ["steered"] }),
		]);
		// Hold abort() at its last await, after the turn it interrupts is idle but before it resets the bracket.
		const atAbortEnd = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		restores.push(() => {
			releaseAbort.resolve();
			releaseTurn.resolve();
		});
		const onTaskAborted = session.goalRuntime.onTaskAborted.bind(session.goalRuntime);
		session.goalRuntime.onTaskAborted = async (...args) => {
			await onTaskAborted(...args);
			atAbortEnd.resolve();
			await releaseAbort.promise;
		};
		// A steer that lands as the turn ends, after the agent loop's last look at its queue.
		const steered = Promise.withResolvers<void>();
		let agentEnds = 0;
		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			if (++agentEnds === 1) {
				session.agent.steer({ role: "user", content: "tail steer", attribution: "user", timestamp: Date.now() });
			} else {
				steered.resolve();
			}
		});

		const aborting = session.abort();
		await withTimeout(atAbortEnd.promise, 2_000, "abort() never reached its last await");
		const running = session.prompt("go");
		await withTimeout(turnStarted.promise, 2_000, "The prompt's turn never started");
		releaseAbort.resolve();
		await aborting;
		releaseTurn.resolve();
		await running;

		await withTimeout(steered.promise, 2_000, "The steer queued as the turn ended never ran");
		expect({ agentEnds, queued: session.agent.hasQueuedMessages() }).toEqual({ agentEnds: 2, queued: false });
	});

	it("cancels an in-flight vision description on abort and drops the prompt", async () => {
		const streamCalls: string[] = [];
		const { session, dropped } = await createSession(
			[
				() => {
					streamCalls.push("started");
					return { content: ["should not run"] };
				},
			],
			true,
		);
		const describeStarted = Promise.withResolvers<AbortSignal | undefined>();
		const spy = spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementation(
			async (_images, _deps, signal) => {
				describeStarted.resolve(signal);
				// Stands in for a provider that never answers: only the signal ends it.
				const { promise, resolve } = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => resolve(), { once: true });
				await promise;
				return [];
			},
		);
		restores.push(() => spy.mockRestore());

		const promptPromise = session.prompt("describe this", { images: [IMAGE] });
		const signal = await withTimeout(describeStarted.promise, 2_000, "Vision description never started");
		expect(signal?.aborted).toBe(false);
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		expect(signal?.aborted).toBe(true);
		expect(await withTimeout(promptPromise, 2_000, "Abort did not release the vision description")).toBe(true);
		expect(dropped).toEqual(["describe this"]);
		expect(streamCalls).toEqual([]);
	});

	it("joinActiveTurn refuses a steer that races abort instead of stranding it behind the cancel", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		let calls = 0;
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
		]);

		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");

		// Live run: the steer joins it and stays queued for the boundary poll.
		expect(await session.joinActiveTurn("steer the live run")).toBe(true);

		// A steer racing the abort window must classify as not-admitted:
		// `#abortInProgress` is set synchronously at abort() entry, and a
		// message admitted behind it would ride the post-abort stranded
		// drain — a continuation the cancelled turn no longer owns or
		// forwards. The caller keeps its content instead.
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		expect(await session.joinActiveTurn("steer during abort")).toBe(false);
		releaseTurn.resolve();
		await aborting;
		await running;
		await session.waitForIdle();

		// The refused steer never reached any queue, so nothing from this
		// admission can ride the post-abort drain: the user interrupt
		// withdraws the earlier queued steer (documented interrupt
		// semantics), and no second model call happens.
		const queued = session.getQueuedMessages();
		expect(queued.steering).toEqual([]);
		expect(queued.followUp).toEqual([]);
		expect(calls).toBe(1);
	});

	it("joinActiveTurn refuses an image steer whose normalization outlives the start of abort", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		let calls = 0;
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
		]);

		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");

		// The steer is admitted (turn live) but its image normalization is
		// held; abort() starts while it is still being preprocessed. The
		// post-await admission recheck must refuse via `#abortInProgress` —
		// `isStreaming` alone would still read true until cleanup drains —
		// so the message never reaches the queue the abort will drain.
		const normalization = holdImageNormalization();
		const admitting = session.joinActiveTurn("steer with an image", [IMAGE]);
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		normalization.release();
		expect(await admitting).toBe(false);

		releaseTurn.resolve();
		await aborting;
		await running;
		await session.waitForIdle();
		const queued = session.getQueuedMessages();
		expect(queued.steering).toEqual([]);
		expect(queued.followUp).toEqual([]);
		expect(calls).toBe(1);
	});

	it("joinActiveTurn parks during a prompt's pre-dispatch window and injects into that turn", async () => {
		const normalization = holdImageNormalization();
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		let calls = 0;
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
		]);

		// A prompt is admitted but still dispatching (normalization held,
		// `#beginInFlight` not yet reached): the client claim is already
		// reserved, so the steer parks until the owning run goes live — the
		// host never needs to resubmit (whose session/prompt would implicitly
		// cancel the still-dispatching prompt), and the admission injects
		// into the run the steer targeted.
		const dispatching = session.prompt("start", { images: [IMAGE] });
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		const steer = session.joinActiveTurn("steer during dispatch");
		const early = await Promise.race([steer.then(() => "settled"), Bun.sleep(50).then(() => "parked")]);
		expect(early).toBe("parked");

		normalization.release();
		await withTimeout(turnStarted.promise, 2_000, "Held turn never started");
		releaseTurn.resolve();
		expect(await steer).toBe(true);
		await dispatching;
		await session.waitForIdle();
		expect(calls).toBe(1);
		// The admission really enqueued onto the live run: the steer text
		// sits on the steering queue (the turn's single response ended it
		// before the next boundary could deliver).
		// The admission really injected into the owning run: the steer text
		// lands in the run's message history after its first response.
		const messages = session.agent.state.messages;
		const firstResponseIndex = messages.findIndex(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("first turn"),
		);
		const steerIndex = messages.findIndex(
			message => message.role === "user" && JSON.stringify(message.content).includes("steer during dispatch"),
		);
		expect(steerIndex).toBeGreaterThan(firstResponseIndex);
	});

	it("refuses a steer whose owning turn settled while the steer's preprocessing ran", async () => {
		const normalization = holdImageNormalization();
		let calls = 0;
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		const wakeStarted = Promise.withResolvers<void>();
		const releaseWake = Promise.withResolvers<void>();
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["turn a"] };
			},
			async () => {
				calls++;
				wakeStarted.resolve();
				await releaseWake.promise;
				return { content: ["wake turn"] };
			},
		]);

		// Client turn A goes live.
		const turnA = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "Turn A never started");

		// An image-bearing steer begins admission while A is live; its image
		// normalization is held, so the post-preprocessing admission check
		// runs only after the release below.
		const steer = session.joinActiveTurn("steer with an image", [IMAGE]);
		await withTimeout(normalization.started, 2_000, "Steer normalization never started");

		// Turn A settles while the steer is mid-preprocessing, and an
		// agent-initiated turn takes the agent: streaming, but not
		// client-owned.
		releaseTurn.resolve();
		await turnA;
		const wake = session.sendCustomMessage("wake up", { deliverAs: "nextTurn", triggerTurn: true });
		await withTimeout(wakeStarted.promise, 2_000, "Wake turn never started");

		// The admission must recheck client ownership after preprocessing:
		// general `isStreaming` is true (the wake) but no client prompt owns
		// it, so the steer is refused and its content stays with the caller
		// instead of injecting into a run with no client forwarder.
		normalization.release();
		expect(await steer).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);

		releaseWake.resolve();
		await wake;
		await session.waitForIdle();
		expect(calls).toBe(2);
	});

	it("refuses a steer whose owning prompt fails in setup, under an ACP client", async () => {
		let calls = 0;
		let apiKeyCalls = 0;
		const apiKeyGate = Promise.withResolvers<void>();
		const secondKeyRequested = Promise.withResolvers<void>();
		// First call validates turn one; the second gates turn two's fallible
		// setup and then fails it — the exact window a steer can arrive in
		// (#promptInFlightCount > 0 with no agent loop owning it yet).
		const modelRegistry = {
			getApiKey: async () => {
				apiKeyCalls++;
				if (apiKeyCalls === 1) return "test-key";
				secondKeyRequested.resolve();
				await apiKeyGate.promise;
				return undefined;
			},
		};
		const { session } = await createSession(
			[
				() => {
					calls++;
					return { content: ["first turn"] };
				},
				() => {
					calls++;
					return { content: ["should not stream"] };
				},
			],
			false,
			// deferAgentInitiatedTurns marks the session as ACP-owned: no
			// continuation may run without a client-owned prompt.
			{ modelRegistry, clientBridge: { capabilities: {}, deferAgentInitiatedTurns: true } },
		);

		await session.prompt("turn one");
		expect(calls).toBe(1);

		const failing = session.prompt("turn two");
		void failing.catch(() => undefined);
		await withTimeout(secondKeyRequested.promise, 2_000, "Second prompt never reached key validation");

		// The steer parks on the dispatching prompt; the setup failure wakes
		// it with the run never gone live, so admission is refused and the
		// caller keeps its content (the ACP bridge answers `promptRequired`
		// and the host resubmits through session/prompt).
		const admitted = session.joinActiveTurn("steer the failing turn");
		apiKeyGate.resolve();
		await expect(failing).rejects.toThrow("No API key found");
		expect(await admitted).toBe(false);
		await session.waitForIdle();

		// Nothing ran as an ownerless continuation and nothing was stranded
		// in the queue either: the refusal kept the content with its caller.
		expect(calls).toBe(1);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("refuses the same setup-window steer without an ACP client too", async () => {
		let calls = 0;
		let apiKeyCalls = 0;
		const apiKeyGate = Promise.withResolvers<void>();
		const secondKeyRequested = Promise.withResolvers<void>();
		const modelRegistry = {
			getApiKey: async () => {
				apiKeyCalls++;
				if (apiKeyCalls === 1) return "test-key";
				secondKeyRequested.resolve();
				await apiKeyGate.promise;
				return undefined;
			},
		};
		const { session } = await createSession(
			[
				() => {
					calls++;
					return { content: ["first turn"] };
				},
				() => {
					calls++;
					return { content: ["drained steer turn"] };
				},
			],
			false,
			{ modelRegistry },
		);

		await session.prompt("turn one");
		const failing = session.prompt("turn two");
		void failing.catch(() => undefined);
		await withTimeout(secondKeyRequested.promise, 2_000, "Second prompt never reached key validation");

		// The park-until-live contract is client-independent: without a
		// bridge the setup-failing window refuses the steer exactly the
		// same way (the TUI keeps the typed content for the next turn).
		const admitted = session.joinActiveTurn("steer the failing turn");
		apiKeyGate.resolve();
		await expect(failing).rejects.toThrow("No API key found");
		expect(await admitted).toBe(false);
		await session.waitForIdle();

		// Nothing ran and nothing drained: the refusal kept the content.
		expect(calls).toBe(1);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("joinActiveTurn hands idle slash commands back instead of failing, and still refuses them mid-run", async () => {
		let calls = 0;
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		const { session } = await createSession(
			[
				async () => {
					calls++;
					turnStarted.resolve();
					await releaseTurn.promise;
					return { content: ["first turn"] };
				},
			],
			false,
			{
				extensionRunner: {
					getCommand: (name: string) => (name === "queued-cmd" ? { name: "queued-cmd" } : undefined),
					emitBeforeAgentStart: async () => undefined,
				},
			},
		);

		// Idle: the command must come back unconsumed (`promptRequired` at
		// the bridge) so the host can resubmit through session/prompt — the
		// only path that can execute it — instead of a `failed` outcome.
		expect(await session.joinActiveTurn("/queued-cmd now")).toBe(false);

		// Mid-run the same command genuinely cannot be queued: refuse it.
		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");
		await expect(session.joinActiveTurn("/queued-cmd now")).rejects.toThrow("cannot be queued");
		releaseTurn.resolve();
		await running;
		await session.waitForIdle();
		expect(calls).toBe(1);
	});
});
