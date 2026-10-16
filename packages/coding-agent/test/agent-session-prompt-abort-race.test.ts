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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));
		return { session, dropped };
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

	it("joinActiveTurn answers not-admitted during a prompt's pre-dispatch window instead of queueing behind it", async () => {
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
		// `#beginInFlight` not yet reached): the session is not streaming and
		// there is no pending action to ask about yet. The steer classifies
		// as not-admitted so the host queues its own prompt behind the
		// dispatching one — never an invisible mid-dispatch injection.
		const dispatching = session.prompt("start", { images: [IMAGE] });
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		expect(await session.joinActiveTurn("steer during dispatch")).toBe(false);

		normalization.release();
		await withTimeout(turnStarted.promise, 2_000, "Held turn never started");
		releaseTurn.resolve();
		await dispatching;
		await session.waitForIdle();
		expect(calls).toBe(1);
	});
});
