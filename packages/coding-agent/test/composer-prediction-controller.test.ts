import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ComposerPredictionController,
	parseComposerPrediction,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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
	/** What `ephemeralMaxTokensPreservesRequest()` reports for the session. */
	capPreservesRequest?: boolean;
	deadlineMs?: number;
}

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;
/** Session usage totals read `cost.total`, so the fixture carries one. */
const USAGE = { input: 10, output: 5, cost: { total: 0.001 } };

function userMessage(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp } as Message;
}

function harness(options: HarnessOptions = {}) {
	const turns: PendingTurn[] = [];
	const sessionManager = SessionManager.inMemory();
	const firstLeafId = sessionManager.appendMessage(userMessage("fix the bug", 1));
	const messages: AgentMessage[] = [userMessage("fix the bug", 1)];
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
	};
	let renders = 0;
	const ctx = {
		settings: Settings.isolated({ "composer.predictions": options.enabled ?? true }),
		viewSession: session,
		focusedAgentId: options.focusedAgentId,
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
		customEntries: (customType: string) =>
			sessionManager
				.getEntries()
				.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType),
		/** The user sends `content`; `held` puts it in the live history before its start event arrives. */
		send: (content: string, held: boolean) => {
			const message = userMessage(content, 3) as AgentMessage;
			if (held) messages.push(message);
			return message;
		},
		/** A new message lands on the journal and in the live history. */
		advance: (content: string) => {
			sessionManager.appendMessage(userMessage(content, 2));
			messages.push(userMessage(content, 2));
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

	it("does not request while disabled, drafted, compacting, or viewing a subagent", () => {
		const blocked = [
			harness({ enabled: false }),
			harness({ draft: "my own message" }),
			harness({ draft: "  " }),
			harness({ compacting: true }),
			harness({ focusedAgentId: "0-Explore" }),
		];
		for (const { controller } of blocked) controller.request();

		expect(blocked.map(h => h.turns.length)).toEqual([0, 0, 0, 0, 0]);
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

	it("journals each reply under its usage entry: the prediction text, or none for a skip", async () => {
		const offered = harness();
		offered.controller.request();
		await offered.reply(0, "now run the tests");
		const skipped = harness();
		skipped.controller.request();
		await skipped.reply(0, "NO_PREDICTION");

		const version = expect.stringMatching(/^[0-9a-f]{12}$/);
		const [offeredUsage] = offered.usageEntries();
		const [offeredEntry] = offered.customEntries("composer_prediction");
		expect(offeredEntry).toMatchObject({
			parentId: offeredUsage!.id,
			data: { promptVersion: version, text: "now run the tests" },
		});
		const [skippedUsage] = skipped.usageEntries();
		const [skippedEntry] = skipped.customEntries("composer_prediction");
		expect(skippedEntry).toEqual(
			expect.objectContaining({ parentId: skippedUsage!.id, data: { promptVersion: version } }),
		);
	});

	it("does not journal a prediction that arrives after the conversation moved on", async () => {
		const { controller, reply, advance, customEntries } = harness();
		controller.request();
		advance("something else");
		await reply(0, "too late");

		expect(customEntries("composer_prediction")).toEqual([]);
	});

	it.each([
		{ name: "accepted", shown: true, accepted: true, sent: "now run the tests", outcome: "accepted" },
		{ name: "edited", shown: true, accepted: true, sent: "now run the unit tests", outcome: "edited" },
		{ name: "ignored", shown: true, accepted: false, sent: "now run the tests", outcome: "ignored" },
		{ name: "unseen", shown: false, accepted: false, sent: "something else", outcome: "unseen" },
	])("records the next message's outcome as $name under the prediction entry", async c => {
		for (const held of [false, true]) {
			const { controller, reply, send, customEntries } = harness();
			controller.request();
			await reply(0, "now run the tests");
			if (c.shown) controller.noteShown("now run the tests");
			if (c.accepted) controller.noteAccepted("now run the tests");

			controller.settle(send(c.sent, held));

			const [prediction] = customEntries("composer_prediction");
			expect(customEntries("composer_prediction_outcome")).toEqual([
				expect.objectContaining({ parentId: prediction!.id, data: { outcome: c.outcome } }),
			]);
		}
	});

	it("records one outcome, and none for a message that follows a different conversation point", async () => {
		const { controller, reply, send, advance, customEntries } = harness();
		controller.request();
		await reply(0, "now run the tests");
		controller.noteShown("some other text");
		advance("interjection");

		controller.settle(send("now run the tests", true));
		expect(customEntries("composer_prediction_outcome")).toEqual([]);

		const fresh = harness();
		fresh.controller.request();
		await fresh.reply(0, "now run the tests");
		const message = fresh.send("now run the tests", true);
		fresh.controller.settle(message);
		fresh.controller.settle(message);
		expect(fresh.customEntries("composer_prediction_outcome")).toHaveLength(1);
	});
});
