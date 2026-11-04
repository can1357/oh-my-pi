/**
 * Contract: `AgentSession` emits a `queue_update` session event — the RPC-facing
 * `{ steering, followUp }` snapshot mirrored by `getQueuedMessages()` — whenever
 * the displayable steering/follow-up queue actually changes, and never repeats
 * an unchanged snapshot. The agent's queue mutators (enqueue, dequeue on
 * delivery, remove, clear/restore) all funnel through one internal signal;
 * these tests prove the externally observable coalescing contract that signal
 * produces, not the internal wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

interface QueueSnapshot {
	steering: readonly string[];
	followUp: readonly string[];
	liveSteered: number;
}

describe("AgentSession queue_update events", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-queue-update-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function createSession(
		responses: MockResponse[],
		followUpMode: "all" | "one-at-a-time" = "one-at-a-time",
		streamFn: StreamFn = createMockModel({ responses }).stream,
		options: { tools?: AgentTool[] } = {},
	) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const tools = options.tools ?? [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools },
			convertToLlm,
			streamFn,
			followUpMode,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		return session;
	}

	function collectQueueUpdates(target: AgentSession): QueueSnapshot[] {
		const updates: QueueSnapshot[] = [];
		target.subscribe(event => {
			if (event.type === "queue_update")
				updates.push({
					steering: [...event.steering],
					followUp: [...event.followUp],
					liveSteered: event.liveSteered,
				});
		});
		return updates;
	}

	const CUSTOM_TYPE = "queue-update-custom";

	/** A user-authored, displayable custom prompt with no `details.__queueChipText`; its content is the chip. */
	function customPayload(text: string) {
		return {
			customType: CUSTOM_TYPE,
			content: text,
			display: true,
			details: { marker: text },
			attribution: "user" as const,
		};
	}

	/** Persisted occurrences of {@link customPayload}, in transcript order. */
	function customOccurrences(target: AgentSession): string[] {
		const occurrences: string[] = [];
		for (const entry of target.sessionManager.getBranch()) {
			if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) continue;
			const content = entry.content;
			occurrences.push(
				typeof content === "string"
					? content
					: content.map(part => (part.type === "text" ? part.text : "[image]")).join(""),
			);
		}
		return occurrences;
	}

	/** First tool round parks in `execute`, keeping the session streaming while the test queues messages. */
	function gatedProbe(): { tool: AgentTool; firstRunStarted: Promise<void>; releaseFirstRun: () => void } {
		const firstRunStarted = Promise.withResolvers<void>();
		const releaseFirstRun = Promise.withResolvers<void>();
		let runs = 0;
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Gates the first tool round for deterministic queue assertions.",
			parameters: type({}),
			execute: async () => {
				const run = ++runs;
				if (run === 1) {
					firstRunStarted.resolve();
					await releaseFirstRun.promise;
				}
				return { content: [{ type: "text" as const, text: `probe ${run}` }] };
			},
		};
		return { tool, firstRunStarted: firstRunStarted.promise, releaseFirstRun: () => releaseFirstRun.resolve() };
	}

	/** Holds the next real preparation for `queue` after its claim is installed and before it commits. */
	function pauseNextPrepare(
		target: AgentSession,
		queue: "steering" | "followUp",
	): { started: Promise<void>; release: () => void } {
		const original = target.agent.prepareQueuedMessages;
		if (!original) throw new Error("Expected the session to install queued-message preparation");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let paused = false;
		target.agent.prepareQueuedMessages = async (messages, signal, preparedQueue) => {
			if (!paused && preparedQueue === queue) {
				paused = true;
				started.resolve();
				await release.promise;
			}
			return original(messages, signal, preparedQueue);
		};
		return { started: started.promise, release: () => release.resolve() };
	}

	it("shows both queued follow-ups, then one after removal, then empty after delivery", async () => {
		const target = createSession([{ content: ["turn one"] }, { content: ["turn two"] }], "all");
		const updates = collectQueueUpdates(target);

		let streamingAtInject: boolean | undefined;
		let removedFirst: boolean | undefined;
		target.agent.setOnBeforeYield(async () => {
			if (streamingAtInject !== undefined) return;
			// The session is still mid-prompt here (the yield boundary of the first
			// turn), so both follow-ups are queued while genuinely streaming.
			streamingAtInject = target.isStreaming;
			await target.followUp("first");
			await target.followUp("second");
			removedFirst = target.removeQueuedMessage("first", "followUp");
		});

		await target.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(removedFirst).toBe(true);
		// Enqueue both, then the removal, then the forced continuation turn
		// dequeuing "second" for delivery — each step is one distinct snapshot.
		expect(updates.map(update => update.followUp)).toEqual([["first"], ["first", "second"], ["second"], []]);
		expect(updates.every(update => update.steering.length === 0)).toBe(true);

		// get_state's RPC-facing snapshot is exactly the last emitted event.
		expect(target.getQueuedMessages()).toEqual(updates.at(-1)!);

		// No duplicate identical consecutive events.
		for (let i = 1; i < updates.length; i++) {
			expect(updates[i]).not.toEqual(updates[i - 1]);
		}
	});

	it("never re-emits when a mutation leaves the displayable queue unchanged", async () => {
		const target = createSession([{ content: ["turn one"] }]);
		const updates = collectQueueUpdates(target);

		await target.steer("kept");
		// Clearing an already-empty follow-up queue does not touch the
		// displayable snapshot (steering still holds "kept"); it must not emit.
		target.agent.clearFollowUpQueue();

		expect(updates).toEqual([{ steering: ["kept"], followUp: [], liveSteered: 0 }]);
	});

	it("satisfies the snapshot-string-removal invariant for every queued chip", async () => {
		const target = createSession([{ content: ["turn one"] }, { content: ["turn two"] }]);

		let snapshot: QueueSnapshot | undefined;
		const removed: boolean[] = [];
		let remaining: QueueSnapshot | undefined;
		target.agent.setOnBeforeYield(async () => {
			if (snapshot) return;
			// Queue while the turn is still running: an idle session delivers a
			// steer immediately, so nothing would stay queued to snapshot.
			await target.steer("steer one");
			await target.followUp("follow one");
			await target.followUp("follow two");
			const current = target.getQueuedMessages();
			snapshot = current;
			for (const text of current.steering) removed.push(target.removeQueuedMessage(text, "steering"));
			for (const text of current.followUp) removed.push(target.removeQueuedMessage(text, "followUp"));
			remaining = target.getQueuedMessages();
		});

		await target.prompt("hello");

		expect(snapshot).toEqual({ steering: ["steer one"], followUp: ["follow one", "follow two"], liveSteered: 0 });
		expect(removed).toEqual([true, true, true]);
		expect(remaining).toEqual({ steering: [], followUp: [], liveSteered: 0 });
	});

	it("keeps the queue snapshot truthful while a steer is claimed live", async () => {
		// The provider stream stays open and claims the steer through live
		// steering, like OpenAI Responses `response.steer` does. Moving the
		// message into the live-steered set changes the snapshot (it still
		// counts as pending input until it lands in the transcript or an
		// interrupt takes it back), so a queue_update must fire at the claim
		// and again when the interrupt path withdraws it — without those,
		// clients show an empty queue while the user's input is in flight,
		// then a stale entry after it is reclaimed.
		const streaming = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		const target = createSession([], "one-at-a-time", async (_model, _context, options) => {
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("live steering was not offered");
			const stream = new AssistantMessageEventStream();
			signal.addEventListener("abort", () => stream.fail(new Error("aborted")), { once: true });
			streaming.resolve();
			await live.wait(signal);
			if (!(await live.claim(signal))) throw new Error("steer was not claimed");
			claimed.resolve();
			return stream;
		});
		const updates = collectQueueUpdates(target);
		const running = target.prompt("start");
		await streaming.promise;
		await target.steer("use tabs");
		await claimed.promise;

		const afterClaim = { steering: ["use tabs"], followUp: [], liveSteered: 1 };
		expect(target.getQueuedMessages()).toEqual(afterClaim);
		expect(updates.at(-1)).toEqual(afterClaim);

		// The interrupt path (Esc) is what takes a live-steered message back.
		expect(target.clearQueue({ forInterrupt: true }).steering.map(message => message.text)).toEqual(["use tabs"]);
		expect(updates.at(-1)).toEqual({ steering: [], followUp: [], liveSteered: 0 });
		await target.abort();
		await running;
	});

	it("emits the queue change when a live-steered message lands in the transcript", async () => {
		// The other half of the claim lifecycle: without an interrupt, the
		// finished turn records the steered message, so it stops counting as
		// pending input and queue listeners must hear that arrival too.
		const streaming = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		const followUpStream = createMockModel({ responses: [{ content: ["answered"] }] }).stream;
		let calls = 0;
		const target = createSession([{ content: ["answered"] }], "all", async (model, context, options) => {
			// Later turns deliver the claimed steer as ordinary input.
			if (calls++ > 0) return followUpStream(model, context, options);
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("live steering was not offered");
			const stream = new AssistantMessageEventStream();
			streaming.resolve();
			await live.wait(signal);
			if (!(await live.claim(signal))) throw new Error("steer was not claimed");
			claimed.resolve();
			const partial = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "ok" }],
				timestamp: Date.now(),
				provider: "mock",
				model: "mock",
				api: "anthropic-messages",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
			};
			stream.push({ type: "start", partial });
			stream.push({ type: "done", reason: "stop", message: partial });
			return stream;
		});
		const updates = collectQueueUpdates(target);
		const running = target.prompt("start");
		await streaming.promise;
		await target.steer("use tabs");
		await claimed.promise;
		expect(target.getQueuedMessages()).toEqual({ steering: ["use tabs"], followUp: [], liveSteered: 1 });

		await running;

		// The transcript-arrival transition must be announced: the recorded
		// steer leaves the live-steered set (liveSteered back to 0) while the
		// visible queue is momentarily empty. This synthetic provider never
		// integrates the steer into its response, so the agent afterwards
		// restores it to the steering queue for a later turn — the arrival
		// notification itself is this test's contract, not that restore.
		expect(updates).toContainEqual({ steering: [], followUp: [], liveSteered: 0 });
		expect(target.getQueuedMessages().liveSteered).toBe(0);
	});

	it("drops a claimed custom steer from queue_update once preparation commits", async () => {
		const probe = gatedProbe();
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "probe", arguments: {} }] },
				{ content: [{ type: "toolCall", name: "probe", arguments: {} }] },
				{ content: ["finished"] },
				{ content: ["answered follow-up"] },
			],
		});
		let callIndex = 0;
		const secondCallStarted = Promise.withResolvers<void>();
		const releaseSecondCall = Promise.withResolvers<void>();
		const streamFn: StreamFn = async (model, context, options) => {
			const index = callIndex++;
			if (index === 1) {
				secondCallStarted.resolve();
				await releaseSecondCall.promise;
			}
			return mock.stream(model, context, options);
		};
		const target = createSession([], "one-at-a-time", streamFn, { tools: [probe.tool] });
		const updates = collectQueueUpdates(target);
		const preparation = pauseNextPrepare(target, "steering");
		const running = target.prompt("start");
		try {
			await probe.firstRunStarted;
			await target.promptCustomMessage(customPayload("STEER_CUSTOM"), { streamingBehavior: "steer" });
			probe.releaseFirstRun();
			await preparation.started;

			// The claim counts as pending display input while preparation runs; the
			// last announced snapshot must include it, never the transient empty queue
			// from the dequeue that happened before the claim existed.
			expect(target.getQueuedMessages()).toEqual({ steering: ["STEER_CUSTOM"], followUp: [], liveSteered: 0 });
			expect(updates.at(-1)).toEqual(target.getQueuedMessages());

			// A different queue arriving mid-preparation must not freeze the claimed
			// steer into the announced snapshot after its delivery commits.
			await target.promptCustomMessage(customPayload("FOLLOW_CUSTOM"), { streamingBehavior: "followUp" });
			expect(updates.at(-1)).toEqual({
				steering: ["STEER_CUSTOM"],
				followUp: ["FOLLOW_CUSTOM"],
				liveSteered: 0,
			});

			preparation.release();
			await secondCallStarted.promise;

			// The steer is now delivered into the transcript, so it is no longer
			// pending input. The follow-up queued during preparation still is.
			expect(target.getQueuedMessages()).toEqual({ steering: [], followUp: ["FOLLOW_CUSTOM"], liveSteered: 0 });
			expect(updates.at(-1)).toEqual(target.getQueuedMessages());
			expect(updates.at(-1)!.steering).toEqual([]);

			releaseSecondCall.resolve();
			await running;

			expect(target.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
			expect(updates.at(-1)).toEqual(target.getQueuedMessages());
			expect(customOccurrences(target)).toEqual(["STEER_CUSTOM", "FOLLOW_CUSTOM"]);
		} finally {
			probe.releaseFirstRun();
			preparation.release();
			releaseSecondCall.resolve();
			await running.catch(() => {});
		}
	});
});
