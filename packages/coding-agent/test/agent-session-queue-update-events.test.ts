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

	/** Resolves once `target`'s queue snapshot satisfies `done`: at once, or at the queue_update that makes it. */
	function queueSettles(target: AgentSession, done: (snapshot: QueueSnapshot) => boolean): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (done(target.getQueuedMessages())) {
			resolve();
			return promise;
		}
		const off = target.subscribe(event => {
			if (event.type !== "queue_update" || !done(event)) return;
			off();
			resolve();
		});
		return promise;
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

	it("keeps a live-steered message listed until the run restores it", async () => {
		// The other half of the claim lifecycle without an interrupt: the steer
		// stays listed while live, and when the run ends without recording it,
		// listeners hear it stop counting as live.
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

		// This synthetic provider never integrates the steer into its response, so the run
		// ends without recording it and the agent restores it to the steering queue. It never
		// drops out of the snapshot meanwhile, and the restore is announced (liveSteered 0).
		expect(updates.every(update => update.steering.includes("use tabs"))).toBe(true);
		expect(updates.at(-1)).toEqual({ steering: ["use tabs"], followUp: [], liveSteered: 0 });
		expect(target.getQueuedMessages()).toEqual(updates.at(-1)!);
	});

	it("drops a claimed custom steer from queue_update once the transcript records it", async () => {
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

			// The request opened, so the steer leaves the snapshot once the transcript records
			// it. The follow-up queued during preparation stays pending.
			await queueSettles(target, snapshot => snapshot.steering.length === 0);
			expect(target.getQueuedMessages()).toEqual({ steering: [], followUp: ["FOLLOW_CUSTOM"], liveSteered: 0 });
			expect(updates.at(-1)).toEqual(target.getQueuedMessages());

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

	it("keeps a delivered follow-up listed until the transcript records it", async () => {
		// The follow-up leaves the queue when its turn is prepared, but the transcript records
		// it only once that turn's request opens; a pill dropped in between leaves the message
		// shown nowhere for as long as the request takes to set up.
		const target = createSession([{ content: ["turn one"] }, { content: ["turn two"] }], "all");
		const recorded = () =>
			target.agent.state.messages.some(
				message =>
					message.role === "user" &&
					(typeof message.content === "string"
						? message.content
						: message.content.map(part => (part.type === "text" ? part.text : "")).join("")) === "later",
			);
		let listed = false;
		const recordedWhenUnlisted: boolean[] = [];
		target.subscribe(event => {
			if (event.type !== "queue_update") return;
			if (event.followUp.includes("later")) listed = true;
			else if (listed) {
				listed = false;
				recordedWhenUnlisted.push(recorded());
			}
		});
		const requestHeld = Promise.withResolvers<void>();
		const releaseRequest = Promise.withResolvers<void>();
		target.agent.addBeforeModelCallHook(async () => {
			if (target.agent.peekDeliveringMessages("followUp").length === 0) return;
			requestHeld.resolve();
			await releaseRequest.promise;
		});
		let queued = false;
		target.agent.setOnBeforeYield(async () => {
			if (queued) return;
			queued = true;
			await target.followUp("later");
		});

		const running = target.prompt("hello");
		try {
			await requestHeld.promise;
			expect(recorded()).toBe(false);
			expect(target.getQueuedMessages()).toEqual({ steering: [], followUp: ["later"], liveSteered: 0 });

			releaseRequest.resolve();
			await running;

			expect(target.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
			expect(recordedWhenUnlisted).toEqual([true]);
		} finally {
			releaseRequest.resolve();
			await running.catch(() => {});
		}
	});
});
