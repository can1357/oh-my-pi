import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { JudgmentParseError } from "@oh-my-pi/pi-ai";
import type { JudgeQuestionPayload } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import { LocalJudge } from "@oh-my-pi/pi-coding-agent/judgment/local-judge";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { isTinyJudgeLocalModelKey } from "@oh-my-pi/pi-coding-agent/tiny/models";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LocalJudge", () => {
	it("maps argmax logits to the winning choice label (wrong winner surfaced to callers)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ q: [0, 3, 1] });
		const judge = new LocalJudge("julia-1");

		const result = await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "choice",
					instructions: "pick a bucket",
					criteria: { low: "minor issue", mid: "moderate issue", high: "critical issue" },
				},
			},
		});

		const answer = result.answers.q;
		expect(answer.choice).toBe("mid");
		const probabilities = Object.values(answer.probabilities);
		expect(probabilities.reduce((sum, probability) => sum + probability, 0)).toBeCloseTo(1, 10);
		expect(answer.confidence).toBe(Math.max(...probabilities));
	});

	it("reports noul as softmax(logits)[1] (inverted yes/no)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ q: [0.5, 1.5] });
		const judge = new LocalJudge("julia-1");

		const result = await judge.judge({
			state: "refactor the scheduler",
			questions: { q: { type: "noul", instructions: "does it hold?" } },
		});

		// softmax([0.5, 1.5])[1] = 1 / (1 + e^-1) ≈ 0.731.
		expect(result.answers.q.noul).toBeCloseTo(0.731, 3);
		expect(result.answers.q.noul).toBeGreaterThan(0.5);
	});

	it("scores the probability-weighted level index with string keys (wrong expected index)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ q: [0, 0, 10, 0] });
		const judge = new LocalJudge("julia-1");

		const result = await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "score",
					instructions: "rate severity",
					criteria: ["none", "low", "high", "critical"],
				},
			},
		});

		const answer = result.answers.q;
		expect(answer.score).toBeCloseTo(2, 3);
		expect(Object.keys(answer.probabilities).sort()).toEqual(["0", "1", "2", "3"]);
	});

	it("sends rubric-suffixed choice options and [false, true] noul order (model scores wrong option strings)", async () => {
		const seen: Array<Record<string, JudgeQuestionPayload>> = [];
		spyOn(tinyModelClient, "judge").mockImplementation(async (_model, _state, questions) => {
			seen.push(questions);
			return { q: [5, 0] };
		});
		const judge = new LocalJudge("julia-1");

		await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "choice",
					instructions: "pick a bucket",
					criteria: { fast: "finishes in ms", slow: null },
				},
			},
		});
		await judge.judge({
			state: "refactor the scheduler",
			questions: {
				q: {
					type: "noul",
					instructions: "does it hold?",
					criteria: { true: "means yes", false: "means no" },
				},
			},
		});

		expect(seen[0].q).toEqual({
			type: "choice",
			instructions: "pick a bucket",
			options: ["fast: finishes in ms", "slow"],
		});
		expect(seen[1].q).toEqual({
			type: "noul",
			instructions: "does it hold?",
			options: ["means no", "means yes"],
		});
	});

	it("throws JudgmentParseError on logit-count mismatch (silent mis-mapping)", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue({ q: [1, 2, 3] });
		const judge = new LocalJudge("julia-1");

		let error: unknown;
		try {
			await judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria: { low: null, high: null },
					},
				},
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(JudgmentParseError);
	});

	it("propagates the abort reason instead of masking it as no-output", async () => {
		spyOn(tinyModelClient, "judge").mockResolvedValue(null);
		const judge = new LocalJudge("julia-1");
		const controller = new AbortController();
		controller.abort();

		let error: unknown;
		try {
			await judge.judge(
				{
					state: "refactor the scheduler",
					questions: {
						q: {
							type: "choice",
							instructions: "pick a tier",
							criteria: { low: null, high: null },
						},
					},
				},
				{ signal: controller.signal },
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("AbortError");
		expect(String((error as Error)?.message ?? error)).not.toMatch(/returned no output/);
	});

	it("rejects a 21-label choice pre-dispatch without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge").mockResolvedValue({ q: [] });
		const judge = new LocalJudge("julia-1");
		const criteria: Record<string, null> = {};
		for (let index = 0; index < 21; index++) criteria[`opt${index}`] = null;

		let error: unknown;
		try {
			await judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria,
					},
				},
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(JudgmentParseError);
		expect(mock.mock.calls.length).toBe(0);
	});

	it("rejects a 1-label choice pre-dispatch without calling the worker", async () => {
		const mock = spyOn(tinyModelClient, "judge").mockResolvedValue({ q: [1] });
		const judge = new LocalJudge("julia-1");

		let error: unknown;
		try {
			await judge.judge({
				state: "refactor the scheduler",
				questions: {
					q: {
						type: "choice",
						instructions: "pick a tier",
						criteria: { only: null },
					},
				},
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(JudgmentParseError);
		expect(mock.mock.calls.length).toBe(0);
	});

	it("routes julia-1 to the judge path and title keys away from it", () => {
		expect(isTinyJudgeLocalModelKey("julia-1")).toBe(true);
		expect(isTinyJudgeLocalModelKey("lfm2.5-230m")).toBe(false);
	});
});
