import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, Model, StopReason } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ComposerPredictionController,
	composerPredictionDeadlineMs,
	parseComposerPrediction,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("parseComposerPrediction", () => {
	it("normalizes a reply to the single line the composer shows", () => {
		expect(parseComposerPrediction("  run the\n  tests\t now ")).toBe("run the tests now");
		expect(parseComposerPrediction('"ship it"')).toBe("ship it");
		expect(parseComposerPrediction("“ship it”")).toBe("ship it");
		expect(parseComposerPrediction('use "bun test" here')).toBe('use "bun test" here');
	});

	it("rejects skips, empty replies, and rambling", () => {
		expect(parseComposerPrediction("NO_PREDICTION")).toBeUndefined();
		expect(parseComposerPrediction("NO_PREDICTION.")).toBeUndefined();
		expect(parseComposerPrediction(' "" ')).toBeUndefined();
		expect(parseComposerPrediction("word ".repeat(200))).toBeUndefined();
	});
});

interface PendingTurn {
	options: EphemeralTurnOptions;
	resolve: (result: EphemeralTurnResult) => void;
	/** Settles after the controller's own continuation, which awaited it first. */
	promise: Promise<EphemeralTurnResult>;
}

interface HarnessOptions {
	enabled?: boolean;
	draft?: string;
	compacting?: boolean;
	focusedAgentId?: string;
	readOnlyGuest?: boolean;
	/** What `ephemeralMaxTokensPreservesRequest()` reports for the session. */
	capPreservesRequest?: boolean;
	deadlineMs?: number;
	predictionsOnResume?: boolean;
	/** How the conversation's last assistant turn ended; omitted, the history ends on the user's message. */
	lastTurn?: StopReason;
}

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;
/** A complete usage record, so the journal indexes the prediction's entry as it does in a live session. */
const USAGE = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp } as Message;
}

function assistantMessage(stopReason: StopReason, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Fixed it." }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 10, output: 5 },
		stopReason,
		timestamp,
	} as unknown as AgentMessage;
}

function harness(options: HarnessOptions = {}) {
	const turns: PendingTurn[] = [];
	const listeners = new Set<(event: { type: string }) => void>();
	const sessionManager = SessionManager.inMemory();
	const firstLeafId = sessionManager.appendMessage(userMessage("fix the bug", 1));
	const messages: AgentMessage[] = [userMessage("fix the bug", 1)];
	if (options.lastTurn) messages.push(assistantMessage(options.lastTurn, 2));
	const session = {
		model: MODEL,
		// Provider-facing id, as after `/fresh` or with an SDK `providerSessionId`: not the journal's.
		sessionId: "provider-session",
		isStreaming: false,
		isCompacting: options.compacting ?? false,
		messages,
		sessionManager,
		ephemeralMaxTokensPreservesRequest: () => options.capPreservesRequest ?? true,
		runEphemeralTurn(turnOptions: EphemeralTurnOptions): Promise<EphemeralTurnResult> {
			const { promise, resolve } = Promise.withResolvers<EphemeralTurnResult>();
			turns.push({ options: turnOptions, resolve, promise });
			return promise;
		},
		subscribe(listener: (event: { type: string }) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	let renders = 0;
	const ctx = {
		settings: Settings.isolated({
			"composer.predictions": options.enabled ?? true,
			"composer.predictionsOnResume": options.predictionsOnResume ?? true,
		}),
		viewSession: session,
		focusedAgentId: options.focusedAgentId,
		collabGuest: options.readOnlyGuest === undefined ? undefined : { readOnly: options.readOnlyGuest },
		editor: { getText: () => options.draft ?? "" },
		ui: { requestRender: () => renders++ },
	} as unknown as ConstructorParameters<typeof ComposerPredictionController>[0];
	const reply = async (index: number, replyText: string) => {
		const turn = turns[index]!;
		const assistantMessage = {
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: USAGE,
			stopReason: "stop",
		} as unknown as EphemeralTurnResult["assistantMessage"];
		turn.resolve({ replyText, assistantMessage });
		await turn.promise;
	};
	return {
		controller: new ComposerPredictionController(ctx, { deadlineMs: options.deadlineMs }),
		turns,
		messages,
		firstLeafId,
		reply,
		renders: () => renders,
		usageEntries: () => sessionManager.getEntries().filter(entry => entry.type === "model_usage"),
		sessionManager,
		/** A new message lands on the journal and in the live history. */
		advance: (content: string) => {
			sessionManager.appendMessage(userMessage(content, 2));
			messages.push(userMessage(content, 2));
		},
		/** Show a focused subagent's conversation (as the focus controller does), or the main one again. */
		viewSubagent: (focused: boolean) => {
			const mutable = ctx as unknown as { viewSession: unknown; focusedAgentId: string | undefined };
			mutable.viewSession = focused ? { messages: [] } : session;
			mutable.focusedAgentId = focused ? "0-Explore" : undefined;
		},
		/** An event on the main session itself, delivered whichever conversation is on screen. */
		emit: (type: string) => {
			for (const listener of listeners) listener({ type });
		},
	};
}

describe("ComposerPredictionController", () => {
	it("offers the reply for the conversation it was predicted from", async () => {
		const { controller, reply, renders } = harness();
		controller.request();
		expect(controller.text).toBeUndefined();

		await reply(0, "now run the tests");

		expect(controller.text).toBe("now run the tests");
		expect(renders()).toBe(1);
	});

	it("does not request while disabled, drafted, compacting, viewing a subagent, or on a read-only collab link", () => {
		const blocked = [
			harness({ enabled: false }),
			harness({ draft: "my own message" }),
			harness({ draft: "  " }),
			harness({ compacting: true }),
			harness({ focusedAgentId: "0-Explore" }),
			harness({ readOnlyGuest: true }),
		];
		const writableGuest = harness({ readOnlyGuest: false });
		for (const { controller } of [...blocked, writableGuest]) controller.request();

		expect(blocked.map(h => h.turns.length)).toEqual([0, 0, 0, 0, 0, 0]);
		expect(writableGuest.turns).toHaveLength(1);
	});

	it("sends the output cap only when it leaves the side request otherwise unchanged", () => {
		const capped = harness({ capPreservesRequest: true });
		capped.controller.request();
		const uncapped = harness({ capPreservesRequest: false });
		uncapped.controller.request();

		expect(capped.turns[0]!.options.maxTokens).toBe(1024);
		expect(uncapped.turns).toHaveLength(1);
		expect(uncapped.turns[0]!.options.maxTokens).toBeUndefined();
	});

	it("aborts a stalled prediction at the deadline", async () => {
		const { controller, turns } = harness({ deadlineMs: 20 });
		controller.request();
		const signal = turns[0]!.options.signal!;
		expect(signal.aborted).toBe(false);

		const { promise, resolve } = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => resolve(), { once: true });
		await promise;

		expect(signal.reason).toBeInstanceOf(DOMException);
		expect((signal.reason as DOMException).name).toBe("TimeoutError");
	});

	it("journals the request's usage on the branch it was made from, even when the reply is discarded", async () => {
		const { controller, reply, usageEntries, firstLeafId, advance } = harness();
		controller.request();
		advance("something else");

		await reply(0, "too late");

		expect(controller.text).toBeUndefined();
		expect(usageEntries()).toEqual([
			expect.objectContaining({
				purpose: "composer-prediction",
				parentId: firstLeafId,
				usage: USAGE,
			}),
		]);
	});

	it("hides a prediction once the conversation moves past it", async () => {
		const { controller, messages, reply } = harness();
		controller.request();
		await reply(0, "now run the tests");

		messages.push(userMessage("something else", 2));

		expect(controller.text).toBeUndefined();
	});

	it("drops a reply that lands after cancel or a newer request", async () => {
		const { controller, turns, reply } = harness();
		controller.request();
		controller.cancel();
		expect(turns[0]!.options.signal?.aborted).toBe(true);
		await reply(0, "stale prediction");
		expect(controller.text).toBeUndefined();

		controller.request();
		controller.request();
		await reply(1, "superseded prediction");
		expect(controller.text).toBeUndefined();
		await reply(2, "latest prediction");
		expect(controller.text).toBe("latest prediction");
	});

	it("catches up only on an opened conversation whose last turn the user can follow up on", () => {
		const finished = harness({ lastTurn: "stop" });
		const blocked = [
			harness(),
			harness({ lastTurn: "aborted" }),
			harness({ lastTurn: "stop", predictionsOnResume: false }),
		];
		for (const { controller } of [finished, ...blocked]) controller.catchUp();

		expect(finished.turns).toHaveLength(1);
		expect(blocked.map(h => h.turns.length)).toEqual([0, 0, 0]);
	});

	it("does not pay again on catch-up for a conversation point already predicted or in flight", async () => {
		const { controller, turns, reply } = harness({ lastTurn: "stop" });
		controller.request();
		controller.catchUp();
		expect(turns).toHaveLength(1);
		expect(turns[0]!.options.signal?.aborted).toBe(false);
		await reply(0, "now run the tests");

		// Viewing a subagent hides the prediction; returning to the conversation shows it again.
		controller.cancel();
		expect(controller.text).toBeUndefined();
		controller.catchUp();

		expect(controller.text).toBe("now run the tests");
		expect(turns).toHaveLength(1);
	});

	it("keeps the prediction when the open session is reloaded from its journal", async () => {
		const { controller, turns, messages, reply } = harness({ lastTurn: "stop" });
		controller.request();
		await reply(0, "now run the tests");

		// `/resume` of the session already open rebuilds every message object from disk.
		controller.cancel();
		messages.splice(0, messages.length, ...messages.map(message => structuredClone(message)));
		controller.catchUp();

		expect(controller.text).toBe("now run the tests");
		expect(turns).toHaveLength(1);
	});

	it("reuses a hidden prediction past journal bookkeeping but predicts again after a compaction", async () => {
		const { controller, turns, reply, sessionManager, firstLeafId, advance } = harness({ lastTurn: "stop" });
		controller.request();
		await reply(0, "now run the tests");

		// A label leaves the conversation as it was.
		controller.cancel();
		sessionManager.appendLabelChange(firstLeafId, "checkpoint");
		controller.catchUp();
		expect(controller.text).toBe("now run the tests");
		expect(turns).toHaveLength(1);

		// Compaction rewrites the history while the tail message object survives: the shown
		// prediction is invalidated immediately, and catch-up requests a fresh one.
		sessionManager.appendCompaction("summary", undefined, firstLeafId, 1000);
		expect(controller.text).toBeUndefined();
		controller.catchUp();

		expect(turns).toHaveLength(2);
		expect(controller.text).toBeUndefined();

		// Switching to a history that cannot follow up still aborts the in-flight request.
		advance("new topic");
		controller.catchUp();
		expect(turns[1]!.options.signal!.aborted).toBe(true);
	});

	it("does not re-request on catch-up after the model declined to predict", async () => {
		const { controller, turns, reply } = harness({ lastTurn: "stop" });
		controller.request();
		await reply(0, "NO_PREDICTION");
		controller.cancel();
		controller.catchUp();

		expect(controller.text).toBeUndefined();
		expect(turns).toHaveLength(1);
	});

	it("keeps the main session's prediction across a subagent visit, whether it finishes during or after it", async () => {
		for (const finishWhileAway of [true, false]) {
			const { controller, turns, reply, viewSubagent } = harness({ lastTurn: "stop" });
			controller.request();
			const signal = turns[0]!.options.signal!;

			// Focusing the subagent hides the view; its own turn start cancels on the subagent's behalf.
			controller.hide();
			viewSubagent(true);
			controller.cancel();
			if (finishWhileAway) await reply(0, "now run the tests");
			expect(controller.text).toBeUndefined();

			viewSubagent(false);
			controller.hide();
			controller.catchUp();
			if (!finishWhileAway) await reply(0, "now run the tests");

			expect(signal.aborted).toBe(false);
			expect(turns).toHaveLength(1);
			expect(controller.text).toBe("now run the tests");
		}
	});

	it("stops a prediction kept across a subagent visit once its own session starts a turn or compaction", () => {
		for (const type of ["agent_start", "auto_compaction_start"]) {
			const { controller, turns, viewSubagent, emit } = harness({ lastTurn: "stop" });
			controller.request();
			controller.hide();
			viewSubagent(true);
			emit("message_update");
			expect(turns[0]!.options.signal!.aborted).toBe(false);

			emit(type);
			expect(turns[0]!.options.signal!.aborted).toBe(true);
		}
	});

	it("dispose stops a prediction kept for the main session while a subagent is on screen", () => {
		const { controller, turns, viewSubagent } = harness({ lastTurn: "stop" });
		controller.request();
		viewSubagent(true);
		controller.cancel();
		expect(turns[0]!.options.signal!.aborted).toBe(false);

		controller.dispose();
		expect(turns[0]!.options.signal!.aborted).toBe(true);
	});
});

describe("composerPredictionDeadlineMs", () => {
	it("bounds the configured timeout so a bad value neither aborts every request nor waits forever", () => {
		expect(composerPredictionDeadlineMs(30)).toBe(30_000);
		expect(composerPredictionDeadlineMs(0)).toBe(5_000);
		expect(composerPredictionDeadlineMs(Number.NaN)).toBe(5_000);
		expect(composerPredictionDeadlineMs(3600)).toBe(120_000);
	});
});
