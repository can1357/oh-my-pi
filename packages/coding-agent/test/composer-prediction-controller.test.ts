import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
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
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

beforeAll(async () => {
	await initTheme(false);
});

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
	reject: (error: unknown) => void;
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
	meterProvider?: MeterProvider;
}

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;

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
			const { promise, resolve, reject } = Promise.withResolvers<EphemeralTurnResult>();
			turns.push({ options: turnOptions, resolve, reject, promise });
			return promise;
		},
	};
	let renders = 0;
	// The composer, wired to the controller the way interactive mode wires it.
	const editor = new CustomEditor(getEditorTheme());
	editor.setText(options.draft ?? "");
	const ctx = {
		settings: Settings.isolated({ "composer.predictions": options.enabled ?? true }),
		viewSession: session,
		focusedAgentId: options.focusedAgentId,
		editor,
		ui: { requestRender: () => renders++ },
	} as unknown as ConstructorParameters<typeof ComposerPredictionController>[0];
	const controller = new ComposerPredictionController(ctx, {
		deadlineMs: options.deadlineMs,
		meterProvider: options.meterProvider,
	});
	editor.prediction = () => controller.text;
	editor.onPredictionAccepted = () => controller.accepted();
	editor.onPredictionShown = () => controller.shown();
	const reply = async (index: number, replyText: string) => {
		const turn = turns[index]!;
		const assistantMessage = {
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: { input: 10, output: 5 },
			stopReason: "stop",
		} as unknown as EphemeralTurnResult["assistantMessage"];
		turn.resolve({ replyText, assistantMessage });
		await turn.promise;
	};
	/** The side turn rejects, as `runEphemeralTurn` does once its signal aborts. */
	const fail = async (index: number, error: unknown) => {
		const turn = turns[index]!;
		turn.reject(error);
		await turn.promise.catch(() => {});
	};
	return {
		controller,
		editor,
		turns,
		messages,
		firstLeafId,
		reply,
		fail,
		/** The user replaces the composer draft. */
		type: (text: string) => editor.setText(text),
		/** Paint one composer frame. */
		paint: () => editor.render(80).join("\n"),
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
				usage: { input: 10, output: 5 },
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

		const shown = harness({ meterProvider });
		shown.controller.request();
		await shown.reply(0, "now run the tests");

		const diverged = harness({ meterProvider });
		diverged.controller.request();
		diverged.type("deploy");
		await diverged.reply(0, "now run the tests");

		// The editor shows only a strict prefix: a draft that is already the whole prediction has no ghost.
		const complete = harness({ meterProvider });
		complete.controller.request();
		complete.type("now run the tests");
		await complete.reply(0, "now run the tests");

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
			shown: 1,
			hidden: 2,
			skipped: 1,
			stale: 1,
			cancelled: 1,
			timeout: 1,
			error: 1,
		});
		const model = "anthropic/claude-sonnet-4-5";
		expect(await metrics.histogram("omp.composer.prediction.duration")).toEqual(
			expect.arrayContaining([
				{ "omp.composer.prediction.outcome": "shown", "omp.composer.prediction.model": model, count: 1 },
				{ "omp.composer.prediction.outcome": "hidden", "omp.composer.prediction.model": model, count: 2 },
				{ "omp.composer.prediction.outcome": "timeout", "omp.composer.prediction.model": model, count: 1 },
			]),
		);
		await metrics.shutdown();
	});

	it("resolves each displayed prediction once, accepted through Tab or Right, else ignored", async () => {
		const metrics = sink();
		const { meterProvider } = metrics;

		const tab = harness({ meterProvider });
		tab.controller.request();
		await tab.reply(0, "now run the tests");
		tab.paint();
		tab.editor.handleInput("\t");
		expect(tab.editor.getText()).toBe("now run the tests");
		// The submitted message ends the turn; the next request retires the accepted prediction.
		tab.controller.request();

		const right = harness({ meterProvider });
		right.controller.request();
		await right.reply(0, "now run the tests");
		right.paint();
		right.editor.handleInput("\x1b[C");
		expect(right.editor.getText()).toBe("now run the tests");
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
		neverShown.paint();
		neverShown.controller.cancel();

		// Hidden at first, painted once the user clears the draft.
		const shownLater = harness({ meterProvider });
		shownLater.controller.request();
		shownLater.type("deploy");
		await shownLater.reply(0, "now run the tests");
		shownLater.type("");
		expect(shownLater.paint()).toContain("now run the tests");
		shownLater.controller.cancel();

		const outdated = harness({ meterProvider });
		outdated.controller.request();
		await outdated.reply(0, "now run the tests");
		outdated.paint();
		outdated.advance("something else");
		// No longer offered, so there is nothing to accept.
		outdated.controller.accepted();
		outdated.controller.cancel();

		expect(await metrics.counts("omp.composer.prediction.resolved", "omp.composer.prediction.result")).toEqual({
			accepted: 2,
			ignored: 3,
		});
		expect(await metrics.histogram("omp.composer.prediction.accept.delay")).toEqual([
			{ "omp.composer.prediction.model": "anthropic/claude-sonnet-4-5", count: 2 },
		]);
		await metrics.shutdown();
	});
});
