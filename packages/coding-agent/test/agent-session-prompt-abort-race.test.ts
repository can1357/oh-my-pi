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

	async function createSession(responses: Array<() => MockResponse | Promise<MockResponse>>, textOnly = false) {
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
		const modelRegistry = new ModelRegistry(authStorage);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
		});
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));
		return { session, dropped, modelRegistry };
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
});
