import { afterEach, describe, expect, it } from "bun:test";
import {
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type Questions,
	type ScoreAnswer,
	tokenUsage,
} from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { initDb, insertUserMessageStats, upsertFrustrationVerdicts } from "@oh-my-pi/omp-stats/db";
import {
	cancelFrustrationRun,
	estimateFrustrationRun,
	getFrustrationDashboardStats,
	getFrustrationJobStatus,
	type StatsJudge,
	setStatsJudgeProvider,
	startFrustrationRun,
} from "@oh-my-pi/omp-stats/frustration";
import type { UserMessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-frustration-");

afterEach(() => {
	setStatsJudgeProvider(undefined);
});

type Signals = Partial<
	Pick<UserMessageStats, "yelling" | "profanity" | "anguish" | "negation" | "repetition" | "blame">
>;

let entrySeq = 0;

function hashOf(prose: string): string {
	return prose ? Bun.hash(prose).toString(16) : "";
}

function userMessage(
	prose: string,
	model: string | null,
	provider: string | null,
	signals: Signals = {},
	timestamp = Date.now(),
): UserMessageStats {
	return {
		sessionFile: "/tmp/frustration.jsonl",
		entryId: `user-${++entrySeq}`,
		folder: "/tmp/project",
		timestamp,
		model,
		provider,
		chars: prose.length,
		words: prose.split(/\s+/).length,
		yelling: 0,
		profanity: 0,
		anguish: 0,
		negation: 0,
		repetition: 0,
		blame: 0,
		...signals,
		prose,
		proseHash: hashOf(prose),
	};
}

function verdict(prose: string, pAnnoyed: number, pAngry: number, target: string): void {
	upsertFrustrationVerdicts([
		{
			proseHash: hashOf(prose),
			pAnnoyed,
			pAngry,
			target,
			judge: "test/judge",
			judgedAt: Date.now(),
		},
	]);
}

function testModel(): Model {
	const bundled = getBundledModel("openai", "gpt-5.4");
	if (!bundled) throw new Error("fixture model missing from catalog");
	return { ...bundled, cost: { ...bundled.cost, input: 1, output: 2 } };
}

/** Judge answering every text "angry at the assistant"; `gate` holds requests until released or aborted. */
class FakeJudge implements StatsJudge {
	readonly label = "fake";
	readonly states: string[] = [];
	readonly #entered = Promise.withResolvers<void>();
	/** Resolves when the first judgment starts. */
	readonly entered = this.#entered.promise;
	gate: Promise<void> | undefined;
	/** Reject calls beyond this many concurrent ones, as a rate-limited judge would. */
	capacity = Number.POSITIVE_INFINITY;
	delayMs = 0;
	inFlight = 0;
	maxInFlight = 0;

	primaryModel(): Model | undefined {
		return testModel();
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: { signal?: AbortSignal } = {},
	): Promise<JudgmentResult<Q>> {
		if (typeof request.state === "string") this.states.push(request.state);
		this.#entered.resolve();
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.inFlight > this.capacity) throw new Error("429 rate limited");
			if (this.delayMs) await Bun.sleep(this.delayMs);
		} finally {
			this.inFlight--;
		}
		if (this.gate) {
			const signal = options.signal;
			await Promise.race([
				this.gate,
				new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
			]);
		}
		const annoyed: ScoreAnswer = {
			type: "score",
			score: 2.5,
			probabilities: { "0": 0.05, "1": 0.05, "2": 0.3, "3": 0.6 },
			confidence: 0.6,
		};
		const target = {
			type: "choice",
			choice: "assistant",
			probabilities: { assistant: 0.9, other: 0.05, none: 0.05 },
			confidence: 0.9,
		};
		return {
			api: "typesafe",
			provider: "fake",
			model: "judge-1",
			answers: { annoyed, target } as JudgmentResult<Q>["answers"],
			usage: tokenUsage(600, 0, 0.001),
		};
	}
}

describe("frustration dashboard", () => {
	it("classifies by cached verdict first and by regex signals otherwise", async () => {
		await initDb();
		insertUserMessageStats([
			// Regex says at-assistant, the verdict says neutral: the verdict wins.
			userMessage("no, stop doing that", "gpt-5.4", "openai", { negation: 1 }),
			// Regex: yelling + blame → annoyed, at assistant, angry.
			userMessage("WHY DID YOU DELETE IT", "gpt-5.4", "openai", { yelling: 1, blame: 1 }),
			// Regex: anguish alone → annoyed, not at the assistant.
			userMessage("ugh this build tool", "gpt-5.4", "openai", { anguish: 1 }),
			// Regex: profanity without negation/repetition/blame is not aimed at the assistant.
			userMessage("damn flaky ci", "gpt-5.4", "openai", { profanity: 1 }),
			// Verdict: annoyed at something else, even though it sounds hostile.
			userMessage("the library is broken", "gpt-5.4", "openai"),
			// Verdict: annoyed at the assistant but not angry.
			userMessage("you missed the file again", "gpt-5.4", "openai"),
			// No prose (markup only): excluded everywhere.
			userMessage("", "gpt-5.4", "openai", { yelling: 1 }),
			// Never answered: overall only.
			userMessage("HELLO??? ANYONE", null, null, { yelling: 1 }),
		]);
		verdict("no, stop doing that", 0.1, 0, "none");
		verdict("the library is broken", 0.9, 0.6, "other");
		verdict("you missed the file again", 0.7, 0.2, "assistant");

		const stats = await getFrustrationDashboardStats("all");

		expect(stats.overall).toEqual({ messages: 7, judged: 3, annoyed: 6, atAssistant: 2, angry: 1 });
		expect(stats.byModel).toHaveLength(1);
		expect(stats.byModel[0]).toMatchObject({
			label: "gpt 5.4",
			messages: 6,
			judged: 3,
			annoyed: 5,
			atAssistant: 2,
			angry: 1,
		});
		expect(stats.judgeAvailable).toBe(false);
	});

	it("merges provider/spelling variants and orders by class, revision, then family", async () => {
		await initDb();
		const t = Date.now() - 60_000;
		insertUserMessageStats([
			userMessage("a", "weird-model", "custom", {}, t),
			userMessage("b", "gpt-5.4", "openai", {}, t + 1),
			userMessage("c", "claude-opus-5-5", "anthropic", {}, t + 2),
			userMessage("d", "claude-opus-5", "anthropic", {}, t + 3),
			userMessage("e", "claude-fable-5", "anthropic", {}, t + 4),
			userMessage("f", "claude-opus-4-8", "anthropic", {}, t + 5),
			userMessage("g", "claude-opus-4-6", "anthropic", {}, t + 6),
			userMessage("h", "claude-opus-4.6", "anthropic", {}, t + 7),
		]);

		const { byModel } = await getFrustrationDashboardStats("all");

		expect(byModel.map(row => row.label)).toEqual([
			"opus 4.6",
			"opus 4.8",
			"fable 5",
			"opus 5",
			"opus 5.5",
			"gpt 5.4",
			"weird-model",
		]);
		expect(byModel[0]).toMatchObject({
			key: "anthropic/opus/4.6.0",
			modelClass: "anthropic",
			family: "opus",
			revision: "4.6.0",
			messages: 2,
			firstSeen: t + 6,
		});
		expect(byModel[0].models.toSorted()).toEqual(["claude-opus-4-6", "claude-opus-4.6"]);
		expect(byModel.at(-1)).toMatchObject({ key: "weird-model", modelClass: "unknown", revision: null });
	});

	it("quotes and runs the judge once per unique unjudged prose, streaming verdicts into the dashboard", async () => {
		await initDb();
		const repeated = "why did you do that again";
		const single = "please rename it";
		const judged = "already judged text";
		insertUserMessageStats([
			userMessage(repeated, "gpt-5.4", "openai"),
			userMessage(repeated, "gpt-5.4", "openai"),
			userMessage(single, "gpt-5.4", "openai"),
			userMessage(judged, "gpt-5.4", "openai"),
		]);
		verdict(judged, 0, 0, "none");
		const judge = new FakeJudge();
		setStatsJudgeProvider(async () => judge);

		const estimate = await estimateFrustrationRun("all");
		const chars = repeated.length + single.length;
		const inputTokens = 2 * 561 + Math.ceil(chars / 5.9);
		expect(estimate).toEqual({
			available: true,
			messages: 2,
			chars,
			inputTokens,
			cost: (inputTokens * 1) / 1e6 + (2 * 8 * 2) / 1e6,
			judge: "openai/gpt-5.4",
		});

		const started = await startFrustrationRun("all");
		if (!started.started) throw new Error(started.error);
		await started.finished;

		expect(judge.states.toSorted()).toEqual([single, repeated].toSorted());
		expect(getFrustrationJobStatus()).toMatchObject({
			state: "done",
			total: 2,
			done: 2,
			failed: 0,
			cost: 0.002,
			judge: "fake/judge-1",
		});
		const stats = await getFrustrationDashboardStats("all");
		expect(stats.overall).toEqual({ messages: 4, judged: 4, annoyed: 3, atAssistant: 3, angry: 3 });
		expect(stats.judgeAvailable).toBe(true);
		expect(await estimateFrustrationRun("all")).toMatchObject({ available: true, messages: 0 });
	});

	it("refuses a second run while one is active and cancels in-flight judgments", async () => {
		await initDb();
		insertUserMessageStats([userMessage("stop it", "gpt-5.4", "openai")]);
		const judge = new FakeJudge();
		const { promise: gate } = Promise.withResolvers<void>();
		judge.gate = gate;
		setStatsJudgeProvider(async () => judge);

		const started = await startFrustrationRun("all");
		if (!started.started) throw new Error(started.error);
		expect(await startFrustrationRun("all")).toMatchObject({ started: false, status: 409 });
		await judge.entered;

		expect(cancelFrustrationRun().state).toBe("cancelled");
		await started.finished;

		expect(judge.states).toHaveLength(1);
		expect(getFrustrationJobStatus()).toMatchObject({ state: "cancelled", done: 0 });
		expect((await getFrustrationDashboardStats("all")).overall.judged).toBe(0);
	});

	it("raises concurrency past its starting point, rides out rate limits, and persists every verdict", async () => {
		await initDb();
		const texts = Array.from({ length: 400 }, (_, i) => `text number ${i}`);
		insertUserMessageStats(texts.map(text => userMessage(text, "gpt-5.4", "openai")));
		const judge = new FakeJudge();
		judge.delayMs = 5;
		judge.capacity = 64;
		setStatsJudgeProvider(async () => judge);

		const started = await startFrustrationRun("all");
		if (!started.started) throw new Error(started.error);
		await started.finished;

		expect(getFrustrationJobStatus()).toMatchObject({ state: "done", total: 400, done: 400, failed: 0 });
		// The run starts at 32 in flight; a latency-bound judge should be driven harder.
		expect(judge.maxInFlight).toBeGreaterThan(32);
		expect((await getFrustrationDashboardStats("all")).overall.judged).toBe(400);
	});

	it("reports why a run is unavailable without a host judge", async () => {
		expect(await estimateFrustrationRun("all")).toMatchObject({ available: false });
		expect(await startFrustrationRun("all")).toMatchObject({ started: false, status: 503 });
	});
});
