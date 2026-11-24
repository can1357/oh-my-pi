import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import {
	AggregationTemporality,
	type DataPoint,
	type Histogram,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ComposerPredictionController,
	parseComposerPrediction,
	parseComposerPredictions,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createRoot, effect } from "@oh-my-pi/pi-tui";
import { Composer } from "../src/ui/composer/composer";

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

describe("parseComposerPredictions", () => {
	it("reads one alternative per line, most likely first, without list markers, quotes, or repeats", () => {
		const reply = '1. run the tests\n- "ship it"\nRun the tests!\n\n* show the diff\n2) revert it\nopen a PR';

		expect(parseComposerPredictions(reply, 4)).toEqual(["run the tests", "ship it", "show the diff", "revert it"]);
		expect(parseComposerPredictions(reply, 2)).toEqual(["run the tests", "ship it"]);
	});

	it("declines on a leading skip and drops unusable lines after a real one", () => {
		expect(parseComposerPredictions("NO_PREDICTION", 4)).toBeUndefined();
		expect(parseComposerPredictions("\nNO_PREDICTION\nship it", 4)).toBeUndefined();
		expect(parseComposerPredictions(`ship it\nNO_PREDICTION\n${"word ".repeat(200)}\n""`, 4)).toEqual(["ship it"]);
		expect(parseComposerPredictions(" \n", 4)).toBeUndefined();
	});

	it("drops a leading preamble line and keeps distinct lines without letters or digits", () => {
		expect(parseComposerPredictions("Here are some options:\nrun the tests\nship it", 4)).toEqual([
			"run the tests",
			"ship it",
		]);
		expect(parseComposerPredictions("fix this:", 4)).toEqual(["fix this:"]);
		expect(parseComposerPredictions("👍\n?\n👍\nok", 4)).toEqual(["👍", "?", "ok"]);
	});
});

interface PendingTurn {
	options: EphemeralTurnOptions;
	resolve: (result: EphemeralTurnResult) => void;
	reject: (error: unknown) => void;
	/** Settles after the controller's own continuation, which awaited it first. */
	promise: Promise<EphemeralTurnResult>;
}

interface HarnessOptions {
	enabled?: boolean;
	alternatives?: boolean;
	draft?: string;
	compacting?: boolean;
	focusedAgentId?: string;
	/** What `ephemeralMaxTokensPreservesRequest()` reports for the session. */
	capPreservesRequest?: boolean;
	deadlineMs?: number;
	meterProvider?: MeterProvider;
}

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;

function userMessage(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp } as Message;
}

function harness(options: HarnessOptions = {}) {
	const turns: PendingTurn[] = [];
	const sentPrompts: string[] = [];
	const sessionManager = SessionManager.inMemory();
	const firstLeafId = sessionManager.appendMessage(userMessage("fix the bug", 1));
	const messages: AgentMessage[] = [userMessage("fix the bug", 1)];
	let stats = { tokens: { total: 0 }, cost: 0 };
	const session = {
		model: MODEL,
		// Provider-facing id, as after `/fresh` or with an SDK `providerSessionId`: not the journal's.
		sessionId: "provider-session",
		isStreaming: false,
		isCompacting: options.compacting ?? false,
		messages,
		sessionManager,
		getSessionStats: () => stats,
		prompt: async (text: string) => {
			sentPrompts.push(text);
		},
		ephemeralMaxTokensPreservesRequest: () => options.capPreservesRequest ?? true,
		runEphemeralTurn(turnOptions: EphemeralTurnOptions): Promise<EphemeralTurnResult> {
			const { promise, resolve, reject } = Promise.withResolvers<EphemeralTurnResult>();
			turns.push({ options: turnOptions, resolve, reject, promise });
			return promise;
		},
	};
	const editor = new Composer({ text: options.draft ?? "" });
	const ctx = {
		settings: Settings.isolated({
			"composer.predictions": options.enabled ?? true,
			"composer.predictionAlternatives": options.alternatives ?? false,
		}),
		viewSession: session,
		focusedAgentId: options.focusedAgentId,
		composer: editor,
	} as unknown as ConstructorParameters<typeof ComposerPredictionController>[0];
	const controller = new ComposerPredictionController(ctx, {
		deadlineMs: options.deadlineMs,
		meterProvider: options.meterProvider,
	});
	// The composer's ghost reads `choices` reactively: count the changes it would repaint on.
	let renders = -1;
	createRoot(() =>
		effect(() => {
			void controller.choices;
			renders++;
		}),
	);
	const reply = async (index: number, replyText: string) => {
		const turn = turns[index]!;
		const assistantMessage = {
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: { input: 10, output: 5 },
			stopReason: "stop",
			content: [{ type: "text", text: replyText }],
		} as unknown as EphemeralTurnResult["assistantMessage"];
		turn.options.onUsage?.(assistantMessage);
		turn.resolve({ replyText, assistantMessage });
		await turn.promise;
	};
	/** A provider can report billed usage before the side turn rejects. */
	const fail = async (index: number, error: unknown, message?: EphemeralTurnResult["assistantMessage"]) => {
		const turn = turns[index]!;
		if (message) turn.options.onUsage?.(message);
		turn.reject(error);
		await turn.promise.catch(() => {});
	};
	return {
		controller,
		editor,
		turns,
		sentPrompts,
		setStats: (tokens: number, dollars: number) => {
			stats = { tokens: { total: tokens }, cost: dollars };
		},
		messages,
		firstLeafId,
		reply,
		fail,
		/** The user replaces the composer draft. */
		type: (text: string) => editor.setText(text),
		/** The composer painted the ghost (its first painted frame counts the prediction as shown). */
		paint: () => controller.shown(),
		/** The user inserted the alternative at `rank` (Tab or Right). */
		accept: (rank: number) => {
			const choice = controller.choices?.[rank];
			if (choice !== undefined) editor.setText(choice);
			controller.accepted(rank);
		},
		renders: () => renders,
		usageEntries: () => sessionManager.getEntries().filter(entry => entry.type === "model_usage"),
		/** A new message lands on the journal and in the live history. */
		advance: (content: string) => {
			sessionManager.appendMessage(userMessage(content, 2));
			messages.push(userMessage(content, 2));
		},
	};
}

describe("ComposerPredictionController", () => {
	it("submits bounded automatic follow-ups and stops when the model declines", async () => {
		const { controller, turns, reply, sentPrompts } = harness();
		controller.startAutomatic({ minutes: 60, tokens: 1_000, dollars: 1, turns: 2 });
		expect(turns).toHaveLength(1);

		await reply(0, "run the tests");
		expect(sentPrompts).toEqual(["run the tests"]);

		controller.request();
		expect(turns).toHaveLength(2);
		await reply(1, "NO_PREDICTION");
		expect(controller.getAutomaticStatus()).toBeUndefined();
		expect(sentPrompts).toEqual(["run the tests"]);
	});

	it("stops before submitting when token or estimated-spend limits are reached", async () => {
		for (const [tokens, dollars] of [
			[1_000, 0],
			[0, 1],
		]) {
			const { controller, turns, reply, sentPrompts, setStats } = harness();
			controller.startAutomatic({ minutes: 60, tokens: 100, dollars: 0.5, turns: 2 });
			setStats(tokens, dollars);
			await reply(0, "run the tests");

			expect(sentPrompts).toEqual([]);
			expect(controller.getAutomaticStatus()).toBeUndefined();
			expect(turns).toHaveLength(1);
		}
	});

	it("stops before submitting when the time limit is reached", async () => {
		const { controller, turns, reply, sentPrompts } = harness();
		const originalNow = Date.now;
		let now = originalNow();
		Date.now = () => now;
		try {
			controller.startAutomatic({ minutes: 1, tokens: 1_000, dollars: 1, turns: 2 });
			now += 60_001;
			await reply(0, "run the tests");

			expect(sentPrompts).toEqual([]);
			expect(controller.getAutomaticStatus()).toBeUndefined();
			expect(turns).toHaveLength(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it("stops at its turn limit and does not repeat the original request", async () => {
		const capped = harness();
		capped.controller.startAutomatic({ minutes: 60, tokens: 1_000, dollars: 1, turns: 1 });
		await capped.reply(0, "run the tests");
		expect(capped.sentPrompts).toEqual(["run the tests"]);
		capped.controller.request();
		expect(capped.controller.getAutomaticStatus()).toBeUndefined();
		expect(capped.turns).toHaveLength(1);

		const repeated = harness();
		repeated.controller.startAutomatic({ minutes: 60, tokens: 1_000, dollars: 1, turns: 2 });
		await repeated.reply(0, "fix the bug");
		expect(repeated.sentPrompts).toEqual([]);
		expect(repeated.controller.getAutomaticStatus()).toBeUndefined();
	});

	it("offers the reply for the conversation it was predicted from", async () => {
		const { controller, reply, renders } = harness();
		controller.request();
		expect(controller.choices).toBeUndefined();

		await reply(0, "now run the tests");

		expect(controller.choices).toEqual(["now run the tests"]);
		expect(renders()).toBe(1);
	});

	it("splits the reply into alternatives only with composer.predictionAlternatives on", async () => {
		const single = harness();
		single.controller.request();
		await single.reply(0, "run the tests\nship it");
		const alternatives = harness({ alternatives: true });
		alternatives.controller.request();
		await alternatives.reply(0, "run the tests\nship it");

		expect(single.controller.choices).toEqual(["run the tests ship it"]);
		expect(alternatives.controller.choices).toEqual(["run the tests", "ship it"]);
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

		expect(controller.choices).toBeUndefined();
		expect(usageEntries()).toEqual([
			expect.objectContaining({
				purpose: "composer-prediction",
				parentId: firstLeafId,
				usage: { input: 10, output: 5 },
				completion: { reply: "too late" },
			}),
		]);
	});

	it("journals provider errors before a prediction rejects", async () => {
		const { controller, fail, usageEntries, firstLeafId } = harness();
		controller.request();
		await fail(0, new Error("529 overloaded_error"), {
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: { input: 0, output: 0 },
			stopReason: "error",
			errorMessage: "529 overloaded_error",
		} as EphemeralTurnResult["assistantMessage"]);

		expect(usageEntries()).toEqual([
			expect.objectContaining({
				purpose: "composer-prediction",
				parentId: firstLeafId,
				stopReason: "error",
				errorMessage: "529 overloaded_error",
			}),
		]);
	});

	it("hides a prediction once the conversation moves past it", async () => {
		const { controller, messages, reply } = harness();
		controller.request();
		await reply(0, "now run the tests");

		messages.push(userMessage("something else", 2));

		expect(controller.choices).toBeUndefined();
	});

	it("keeps the prediction when a silent advisor card lands during or after the request", async () => {
		const advisorCard = (timestamp: number) =>
			({ role: "custom", customType: "advisor", content: "note", display: true, timestamp }) as AgentMessage;
		const { controller, messages, reply } = harness();
		controller.request();
		messages.push(advisorCard(2));
		await reply(0, "now run the tests");
		expect(controller.choices).toEqual(["now run the tests"]);

		messages.push(advisorCard(3));
		expect(controller.choices).toEqual(["now run the tests"]);
	});

	it("keeps the prediction when a row kept out of context lands, but not when a context message does", async () => {
		const extensionRow = (timestamp: number, excludeFromContext: boolean) =>
			({
				role: "custom",
				customType: "plugin-stats",
				content: "row",
				display: true,
				excludeFromContext,
				timestamp,
			}) as AgentMessage;
		const { controller, messages, reply } = harness();
		controller.request();
		messages.push(extensionRow(2, true));
		await reply(0, "now run the tests");
		expect(controller.choices).toEqual(["now run the tests"]);

		messages.push(extensionRow(3, false));
		expect(controller.choices).toBeUndefined();
	});

	it("drops a reply that lands after cancel or a newer request", async () => {
		const { controller, turns, reply } = harness();
		controller.request();
		controller.cancel();
		expect(turns[0]!.options.signal?.aborted).toBe(true);
		await reply(0, "stale prediction");
		expect(controller.choices).toBeUndefined();

		controller.request();
		controller.request();
		await reply(1, "superseded prediction");
		expect(controller.choices).toBeUndefined();
		await reply(2, "latest prediction");
		expect(controller.choices).toEqual(["latest prediction"]);
	});
});

describe("ComposerPredictionController metrics", () => {
	/** A test-local meter provider, so this suite never touches the global one. */
	function sink() {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
		const meterProvider = new MeterProvider({ readers: [reader] });
		const points = async <T>(name: string): Promise<DataPoint<T>[]> => {
			await reader.forceFlush();
			const metric = exporter
				.getMetrics()
				.at(-1)
				?.scopeMetrics.flatMap(scope => scope.metrics)
				.find(metric => metric.descriptor.name === name);
			return (metric?.dataPoints ?? []) as DataPoint<T>[];
		};
		return {
			meterProvider,
			/** `{attribute value: count}` for one counter, keyed by `attribute`. */
			async counts(name: string, attribute: string): Promise<Record<string, number>> {
				const data = await points<number>(name);
				return Object.fromEntries(data.map(point => [String(point.attributes[attribute]), point.value]));
			},
			/** Each counter series as its attributes plus its value. */
			async series(name: string): Promise<Array<Record<string, unknown>>> {
				const data = await points<number>(name);
				return data.map(point => ({ ...point.attributes, value: point.value }));
			},
			/** Each histogram series as its attributes plus how many values it recorded. */
			async histogram(name: string): Promise<Array<Record<string, unknown>>> {
				const data = await points<Histogram>(name);
				return data.map(point => ({ ...point.attributes, count: point.value.count }));
			},
			shutdown: () => meterProvider.shutdown(),
		};
	}

	it("counts each request by how it settled and times it, by serving model", async () => {
		const metrics = sink();
		const { meterProvider } = metrics;

		const offered = harness({ meterProvider });
		offered.controller.request();
		await offered.reply(0, "now run the tests");

		// What the composer can display is not the request's outcome: a diverging draft still gets the offer.
		const diverged = harness({ meterProvider });
		diverged.controller.request();
		diverged.type("deploy");
		await diverged.reply(0, "now run the tests");

		const skipped = harness({ meterProvider });
		skipped.controller.request();
		await skipped.reply(0, "NO_PREDICTION");

		const stale = harness({ meterProvider });
		stale.controller.request();
		stale.advance("something else");
		await stale.reply(0, "too late");

		const superseded = harness({ meterProvider });
		superseded.controller.request();
		superseded.controller.request();
		await superseded.fail(0, new DOMException("aborted", "AbortError"));

		const timedOut = harness({ deadlineMs: 5, meterProvider });
		timedOut.controller.request();
		const signal = timedOut.turns[0]!.options.signal!;
		const { promise: deadline, resolve: reachDeadline } = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => reachDeadline(), { once: true });
		await deadline;
		await timedOut.fail(0, signal.reason);

		const failed = harness({ meterProvider });
		failed.controller.request();
		await failed.fail(0, new Error("overloaded"));

		expect(await metrics.counts("omp.composer.prediction.requests", "omp.composer.prediction.outcome")).toEqual({
			offered: 2,
			skipped: 1,
			stale: 1,
			cancelled: 1,
			timeout: 1,
			error: 1,
		});
		const model = "anthropic/claude-sonnet-4-5";
		expect(await metrics.histogram("omp.composer.prediction.duration")).toEqual(
			expect.arrayContaining([
				{
					"omp.composer.prediction.outcome": "offered",
					"omp.composer.prediction.model": model,
					"omp.composer.prediction.choices": 1,
					count: 2,
				},
				{ "omp.composer.prediction.outcome": "timeout", "omp.composer.prediction.model": model, count: 1 },
			]),
		);
		// Nothing was painted, so nothing was shown.
		expect(await metrics.counts("omp.composer.prediction.shown", "omp.composer.prediction.model")).toEqual({});
		await metrics.shutdown();
	});

	it("counts a prediction as shown on its first painted frame only", async () => {
		const metrics = sink();
		const { meterProvider } = metrics;

		const painted = harness({ meterProvider });
		painted.controller.request();
		await painted.reply(0, "now run the tests");
		painted.paint();
		painted.paint();

		// A frame painted after the conversation moved on shows nothing current.
		const stale = harness({ meterProvider });
		stale.controller.request();
		await stale.reply(0, "now run the tests");
		stale.advance("something else");
		stale.paint();

		expect(await metrics.counts("omp.composer.prediction.shown", "omp.composer.prediction.model")).toEqual({
			"anthropic/claude-sonnet-4-5": 1,
		});
		await metrics.shutdown();
	});

	it("resolves each shown prediction once, accepted through Tab or Right, else ignored", async () => {
		const metrics = sink();
		const { meterProvider } = metrics;

		const tab = harness({ meterProvider });
		tab.controller.request();
		await tab.reply(0, "now run the tests");
		tab.paint();
		tab.accept(0);
		expect(tab.editor.text()).toBe("now run the tests");
		// The submitted message ends the turn; the next request retires the accepted prediction.
		tab.controller.request();

		const right = harness({ meterProvider });
		right.controller.request();
		await right.reply(0, "now run the tests");
		right.paint();
		right.accept(0);
		expect(right.editor.text()).toBe("now run the tests");
		right.controller.request();

		const ignored = harness({ meterProvider });
		ignored.controller.request();
		await ignored.reply(0, "now run the tests");
		ignored.paint();
		ignored.controller.request();

		// Offered behind a diverging draft: never on screen, so neither accepted nor ignored.
		const neverShown = harness({ meterProvider });
		neverShown.controller.request();
		neverShown.type("deploy");
		await neverShown.reply(0, "now run the tests");
		neverShown.controller.cancel();

		// Inserted before any frame painted it: outside the shown population, so not accepted either.
		const unseen = harness({ meterProvider });
		unseen.controller.request();
		await unseen.reply(0, "now run the tests");
		unseen.accept(0);
		expect(unseen.editor.text()).toBe("now run the tests");
		// The draft is the whole prediction now: no ghost to paint.
		unseen.controller.cancel();

		// Hidden at first, painted once the user clears the draft.
		const shownLater = harness({ meterProvider });
		shownLater.controller.request();
		shownLater.type("deploy");
		await shownLater.reply(0, "now run the tests");
		shownLater.type("");
		shownLater.paint();
		shownLater.controller.cancel();

		const outdated = harness({ meterProvider });
		outdated.controller.request();
		await outdated.reply(0, "now run the tests");
		outdated.paint();
		outdated.advance("something else");
		// No longer offered, so there is nothing to accept.
		outdated.controller.accepted(0);
		outdated.controller.cancel();

		const model = "anthropic/claude-sonnet-4-5";
		// Every shown prediction resolves exactly once.
		expect(await metrics.counts("omp.composer.prediction.shown", "omp.composer.prediction.model")).toEqual({
			[model]: 5,
		});
		expect(await metrics.counts("omp.composer.prediction.resolved", "omp.composer.prediction.result")).toEqual({
			accepted: 2,
			ignored: 3,
		});
		expect(await metrics.histogram("omp.composer.prediction.accept.delay")).toEqual([
			{ "omp.composer.prediction.model": model, "omp.composer.prediction.choices": 1, count: 2 },
		]);
		await metrics.shutdown();
	});

	it("resolves an accepted prediction with the rank of the alternative the user kept", async () => {
		const metrics = sink();
		const { meterProvider } = metrics;

		const swapped = harness({ alternatives: true, meterProvider });
		swapped.controller.request();
		await swapped.reply(0, "run the tests\nship it\nshow the diff");
		swapped.paint();
		swapped.accept(1);
		expect(swapped.editor.text()).toBe("ship it");
		swapped.controller.request();

		// The ghost follows the first alternative the draft is a prefix of.
		const typed = harness({ alternatives: true, meterProvider });
		typed.controller.request();
		await typed.reply(0, "run the tests\nship it");
		typed.type("sh");
		typed.paint();
		typed.accept(1);
		expect(typed.editor.text()).toBe("ship it");
		typed.controller.cancel();

		const ignored = harness({ alternatives: true, meterProvider });
		ignored.controller.request();
		await ignored.reply(0, "run the tests\nship it\nshow the diff\nrevert it");
		ignored.paint();
		ignored.controller.cancel();

		expect(await metrics.counts("omp.composer.prediction.shown", "omp.composer.prediction.choices")).toEqual({
			"2": 1,
			"3": 1,
			"4": 1,
		});
		const model = "anthropic/claude-sonnet-4-5";
		const resolved = await metrics.series("omp.composer.prediction.resolved");
		expect(resolved).toHaveLength(3);
		expect(resolved).toEqual(
			expect.arrayContaining([
				{
					"omp.composer.prediction.result": "accepted",
					"omp.composer.prediction.model": model,
					"omp.composer.prediction.choices": 3,
					"omp.composer.prediction.rank": 1,
					value: 1,
				},
				{
					"omp.composer.prediction.result": "accepted",
					"omp.composer.prediction.model": model,
					"omp.composer.prediction.choices": 2,
					"omp.composer.prediction.rank": 1,
					value: 1,
				},
				{
					"omp.composer.prediction.result": "ignored",
					"omp.composer.prediction.model": model,
					"omp.composer.prediction.choices": 4,
					value: 1,
				},
			]),
		);
		await metrics.shutdown();
	});
});
