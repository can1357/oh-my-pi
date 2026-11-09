import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import {
	AggregationTemporality,
	type DataPoint,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgComposerPredictionAlternatives, cfgComposerPredictions } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { RpcNextMessagePredictor } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-next-message-prediction";
import type { RpcNextMessagePredictionFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;

function userMessage(content: string): Message {
	return { role: "user", content, timestamp: 1 } as Message;
}

interface PendingTurn {
	options: EphemeralTurnOptions;
	resolve: (result: EphemeralTurnResult) => void;
	reject: (error: unknown) => void;
	promise: Promise<EphemeralTurnResult>;
}

function harness(options: { enabled?: boolean; alternatives?: boolean; meterProvider?: MeterProvider } = {}) {
	const turns: PendingTurn[] = [];
	const frames: RpcNextMessagePredictionFrame[] = [];
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(userMessage("fix the bug"));
	const messages: AgentMessage[] = [userMessage("fix the bug")];
	const session = {
		model: MODEL,
		isStreaming: false,
		isCompacting: false,
		messages,
		sessionManager,
		settings: Settings.isolated({
			"composer.predictions": options.enabled ?? true,
			"composer.predictionAlternatives": options.alternatives ?? true,
		}),
		ephemeralMaxTokensPreservesRequest: () => true,
		runEphemeralTurn(turnOptions: EphemeralTurnOptions): Promise<EphemeralTurnResult> {
			const { promise, resolve, reject } = Promise.withResolvers<EphemeralTurnResult>();
			// As the real side turn: an abort rejects it.
			turnOptions.signal?.addEventListener("abort", () => reject(turnOptions.signal!.reason), { once: true });
			turns.push({ options: turnOptions, resolve, reject, promise });
			return promise;
		},
	} as unknown as AgentSession;
	const predictor = new RpcNextMessagePredictor(session, frame => frames.push(frame), {
		meterProvider: options.meterProvider,
	});
	return {
		predictor,
		settings: session.settings,
		frames,
		turns,
		async reply(index: number, replyText: string) {
			const turn = turns[index]!;
			turn.resolve({
				replyText,
				assistantMessage: {
					api: MODEL.api,
					provider: MODEL.provider,
					model: MODEL.id,
					usage: { input: 10, output: 5 },
					stopReason: "stop",
				} as unknown as EphemeralTurnResult["assistantMessage"],
			});
			await turn.promise;
		},
		async settled(index: number) {
			await turns[index]!.promise.catch(() => {});
		},
		/** A new message lands, as the session reports it. */
		advance(content: string) {
			const message = userMessage(content);
			messages.push(message);
			predictor.observe({ type: "message_end", message } as AgentSessionEvent);
		},
	};
}

describe("RpcNextMessagePredictor", () => {
	it("makes no request unless the host asks and composer.predictions is on", () => {
		const off = harness({ enabled: false });
		expect(off.predictor.request()).toBeNull();
		expect(off.turns).toHaveLength(0);

		const idle = harness();
		idle.advance("another message");
		expect(idle.turns).toHaveLength(0);
		expect(idle.frames).toEqual([]);
	});

	it("offers ordered choices under the request's id, then retires them once the conversation moves on", async () => {
		const { predictor, frames, reply, advance } = harness();
		const id = predictor.request();
		expect(id).toEqual(expect.any(String));

		await reply(0, "run the tests\nship it");
		expect(frames).toEqual([
			{
				type: "next_message_prediction",
				predictionId: id!,
				status: "offered",
				choices: ["run the tests", "ship it"],
			},
		]);

		advance("deploy it");
		expect(frames.at(-1)).toEqual({ type: "next_message_prediction", predictionId: id!, status: "retired" });
		expect(frames).toHaveLength(2);
	});

	it("settles a reply that arrives after the conversation moved on as stale, with no choices", async () => {
		const { predictor, frames, reply, advance } = harness();
		const id = predictor.request();
		advance("deploy it");

		await reply(0, "run the tests");
		expect(frames).toEqual([{ type: "next_message_prediction", predictionId: id!, status: "stale" }]);
	});

	it("cancels only the matching prediction, and a new turn cancels whatever is pending", async () => {
		const { predictor, frames, settled, reply } = harness();
		const first = predictor.request()!;
		expect(predictor.cancel("not-it")).toBe(false);
		expect(predictor.cancel(first)).toBe(true);
		await settled(0);
		expect(frames).toEqual([{ type: "next_message_prediction", predictionId: first, status: "cancelled" }]);

		const second = predictor.request()!;
		await reply(1, "ship it");
		predictor.observe({ type: "agent_start" } as AgentSessionEvent);
		expect(frames.slice(1).map(frame => frame.status)).toEqual(["offered", "retired"]);
		expect(frames.at(-1)!.predictionId).toBe(second);
		expect(predictor.cancel()).toBe(false);
	});

	it("retires an offered prediction and cancels a pending one when a manual compaction starts", async () => {
		const { predictor, frames, reply, settled } = harness();
		const offered = predictor.request()!;
		await reply(0, "ship it");
		predictor.observe({ type: "manual_compaction_start" } as AgentSessionEvent);
		expect(frames.at(-1)).toEqual({ type: "next_message_prediction", predictionId: offered, status: "retired" });

		const pending = predictor.request()!;
		predictor.observe({ type: "manual_compaction_start" } as AgentSessionEvent);
		await settled(1);
		expect(frames.at(-1)).toEqual({ type: "next_message_prediction", predictionId: pending, status: "cancelled" });
	});

	it("cancels when composer.predictions is turned off, even before the reply arrives", async () => {
		const { predictor, frames, reply, settled, settings } = harness();
		const offered = predictor.request()!;
		await reply(0, "ship it");
		const pending = predictor.request()!;
		cfgComposerPredictions.override(settings, false);
		await settled(1);

		expect(frames.map(frame => [frame.predictionId, frame.status])).toEqual([
			[offered, "offered"],
			[offered, "retired"],
			[pending, "cancelled"],
		]);
	});

	it("turning alternatives off ends a multi-choice or pending prediction but keeps a single choice", async () => {
		const multi = harness();
		const multiId = multi.predictor.request()!;
		await multi.reply(0, "run the tests\nship it");
		cfgComposerPredictionAlternatives.override(multi.settings, false);
		await Promise.resolve();
		expect(multi.frames.at(-1)).toEqual({
			type: "next_message_prediction",
			predictionId: multiId,
			status: "retired",
		});

		const pending = harness();
		const pendingId = pending.predictor.request()!;
		cfgComposerPredictionAlternatives.override(pending.settings, false);
		await pending.settled(0);
		expect(pending.frames).toEqual([
			{ type: "next_message_prediction", predictionId: pendingId, status: "cancelled" },
		]);

		const single = harness();
		single.predictor.request();
		await single.reply(0, "ship it");
		cfgComposerPredictionAlternatives.override(single.settings, false);
		await Promise.resolve();
		expect(single.frames.map(frame => frame.status)).toEqual(["offered"]);
	});

	it("supersedes an offered prediction with a new request, retiring it first", async () => {
		const { predictor, frames, reply } = harness();
		const first = predictor.request()!;
		await reply(0, "ship it");
		const second = predictor.request()!;

		expect(second).not.toBe(first);
		expect(frames.map(frame => [frame.predictionId, frame.status])).toEqual([
			[first, "offered"],
			[first, "retired"],
		]);
	});

	it("rejects an accepted rank outside the offered choices and ignores feedback for a retired prediction", async () => {
		const { predictor, reply } = harness();
		const id = predictor.request()!;
		await reply(0, "run the tests\nship it");

		expect(() => predictor.feedback(id, "accepted", 2)).toThrow("out of range");
		expect(() => predictor.feedback(id, "accepted", undefined)).toThrow("rank");
		predictor.cancel(id);
		expect(() => predictor.feedback(id, "accepted", 1)).not.toThrow();
	});

	it("reports host feedback through the prediction metrics", async () => {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
		const meterProvider = new MeterProvider({ readers: [reader] });
		const { predictor, reply } = harness({ meterProvider });

		const accepted = predictor.request()!;
		await reply(0, "run the tests\nship it");
		predictor.feedback(accepted, "shown", undefined);
		predictor.feedback(accepted, "accepted", 1);
		predictor.cancel(accepted);

		const ignored = predictor.request()!;
		await reply(1, "ship it");
		predictor.feedback(ignored, "shown", undefined);
		predictor.cancel();

		await reader.forceFlush();
		const resolved = exporter
			.getMetrics()
			.at(-1)!
			.scopeMetrics.flatMap(scope => scope.metrics)
			.find(metric => metric.descriptor.name === "omp.composer.prediction.resolved")!
			.dataPoints as DataPoint<number>[];
		expect(
			resolved.map(point => ({
				result: point.attributes["omp.composer.prediction.result"],
				rank: point.attributes["omp.composer.prediction.rank"],
				value: point.value,
			})),
		).toEqual(
			expect.arrayContaining([
				{ result: "accepted", rank: 1, value: 1 },
				{ result: "ignored", rank: undefined, value: 1 },
			]),
		);
		await meterProvider.shutdown();
	});
});
