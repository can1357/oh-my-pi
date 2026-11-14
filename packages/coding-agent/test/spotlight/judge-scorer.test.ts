import { describe, expect, it } from "bun:test";
import type { JudgmentRequest, JudgmentResult, NoulQuestion, Questions } from "@oh-my-pi/pi-ai";
import { JUDGE_CHUNK_ITEMS, JudgeScorer, lineBatch, lineKey } from "@oh-my-pi/pi-coding-agent/spotlight/judge-scorer";
import type { CallContext } from "@oh-my-pi/pi-coding-agent/spotlight/types";

function context(): CallContext {
	return { task: "Fix the service.", said: "", intent: "", commands: [], source: "read src/a.ts" };
}

/** A judge that answers `answer(request, key)`, records every request, and honours the caller's signal. */
function fakeJudge(answer: (state: Record<string, unknown>, key: string) => number | undefined) {
	const requests: { questions: string[]; items: number; state: Record<string, unknown> }[] = [];
	let inFlight = 0;
	let peak = 0;
	const judge = {
		label: "fake/judge",
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: { signal?: AbortSignal },
		): Promise<JudgmentResult<Q>> {
			inFlight++;
			peak = Math.max(peak, inFlight);
			const state = request.state as Record<string, unknown>;
			requests.push({
				questions: Object.keys(request.questions),
				items: Object.keys((state.lines ?? {}) as Record<string, unknown>).length,
				state,
			});
			// One microtask hop so sibling requests overlap, as they do against a real endpoint; the
			// in-flight count is what the fan-out cap is measured on, not elapsed time.
			await Promise.resolve();
			try {
				const signal = options?.signal;
				if (signal?.aborted) throw new Error("aborted");
				const answers: Record<string, unknown> = {};
				for (const key of Object.keys(request.questions)) {
					const value = answer(state, key);
					answers[key] = value === undefined ? { type: "noul" } : { type: "noul", noul: value };
				}
				return {
					answers,
					usage: { input: 100, output: 1, totalTokens: 101, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					api: "fake",
					provider: "fake",
					model: "fake",
				} as unknown as JudgmentResult<Q>;
			} finally {
				inFlight--;
			}
		},
	};
	return { judge, requests, peak: () => peak };
}

describe("judge scorer", () => {
	it("scores every item in order across chunks of at most 48", async () => {
		const { judge, requests } = fakeJudge((state, key) => {
			const line = (state.lines as Record<string, string>)[key]!;
			return line.includes("needle") ? 1 : 0;
		});
		const items = Array.from({ length: 120 }, (_, i) => (i === 77 ? "const needle = 1;" : `const x${i} = ${i};`));
		const scorer = new JudgeScorer(judge, 5_000);
		const scores = await scorer.score(items, context());

		expect(scores).toHaveLength(120);
		expect(scores![77]).toBe(1);
		expect(scores!.filter(score => score === 1)).toHaveLength(1);
		expect(requests).toHaveLength(3);
		for (const request of requests) expect(request.items).toBeLessThanOrEqual(JUDGE_CHUNK_ITEMS);
		expect(requests[0]!.items).toBe(JUDGE_CHUNK_ITEMS);
		expect(requests[2]!.items).toBe(120 - 2 * JUDGE_CHUNK_ITEMS);
		expect(scorer.usage.calls).toBe(3);
		expect(scorer.usage.failures).toBe(0);
		expect(scorer.usage.tokens).toBe(300);
		expect(scorer.usage.costUsd).toBeCloseTo(0.003);
	});

	it("asks one noul question per line over a state whose keys are sorted", async () => {
		const { judge, requests } = fakeJudge(() => 0.5);
		await new JudgeScorer(judge, 5_000).score(["alpha", "beta"], context());
		const [request] = requests;
		expect(request!.questions).toEqual([lineKey(0), lineKey(1)]);
		expect(Object.keys(request!.state)).toEqual(["commands", "intent", "lines", "said", "source", "task"]);
		expect((request!.state.lines as Record<string, string>)[lineKey(1)]).toBe("beta");
	});

	it("keeps at most 8 judge requests in flight across every stage of one result", async () => {
		const { judge, peak } = fakeJudge(() => 0.5);
		const scorer = new JudgeScorer(judge, 5_000);
		const items = Array.from({ length: JUDGE_CHUNK_ITEMS * 4 }, (_, i) => `line ${i}`);
		// `scoreLines` fans one score() call out per 32 KB chunk: the cap holds across the stages, not within one.
		await Promise.all([scorer.score(items, context()), scorer.score(items, context()), scorer.score(items, context())]);
		expect(peak()).toBe(8);
	});

	it("holds one budget for the whole result, so a later stage does not get a fresh one", async () => {
		const { judge } = fakeJudge(() => 0.5);
		const scorer = new JudgeScorer(judge, 60);
		expect(await scorer.score(["a"], context())).toEqual([0.5]);
		// The first stage spent the result's budget; a second one fails against the same deadline instead of resetting.
		// Real elapsed time is the point: `AbortSignal.timeout` runs on the platform clock and fake timers do not
		// drive it, so this is the one place the suite waits.
		await Bun.sleep(80);
		expect(await scorer.score(["a"], context())).toBeNull();
		expect(scorer.usage.failureCauses).toEqual({ timeout: 1 });
	});

	it("answers null with a cause when the judge has no candidate, fails, or does not answer every line", async () => {
		const none = new JudgeScorer(undefined, 5_000);
		expect(await none.score(["a"], context())).toBeNull();
		expect(none.usage.failureCauses).toEqual({ no_judge: 1 });

		const failing = fakeJudge(() => {
			throw new Error("provider exploded");
		});
		const broken = new JudgeScorer(failing.judge, 5_000);
		expect(await broken.score(["a"], context())).toBeNull();
		expect(broken.usage.failureCauses).toEqual({ provider: 1 });

		const silent = fakeJudge(() => undefined);
		const unanswered = new JudgeScorer(silent.judge, 5_000);
		expect(await unanswered.score(["a"], context())).toBeNull();
		expect(unanswered.usage.failureCauses).toEqual({ bad_reply: 1 });

		const outOfRange = fakeJudge(() => 1.5);
		const ranged = new JudgeScorer(outOfRange.judge, 5_000);
		expect(await ranged.score(["a"], context())).toBeNull();
		expect(ranged.usage.failureCauses).toEqual({ bad_reply: 1 });
	});

	it("gives the whole ranking one budget and reports a timeout", async () => {
		// A judge that never answers but honours cancellation, as a real one does.
		const hanging = {
			label: "fake/hang",
			judge: (_request: unknown, options?: { signal?: AbortSignal }) => {
				const { promise, reject } = Promise.withResolvers<never>();
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				return promise;
			},
		};
		const scorer = new JudgeScorer(hanging, 20);
		const started = performance.now();
		expect(await scorer.score(["a"], context())).toBeNull();
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(scorer.usage.failureCauses).toEqual({ timeout: 1 });
	});

	it("rethrows the caller's own cancellation instead of ranking nothing", async () => {
		const { judge } = fakeJudge(() => 0.5);
		const controller = new AbortController();
		controller.abort();
		await expect(new JudgeScorer(judge, 5_000).score(["a"], context(), controller.signal)).rejects.toThrow();
	});

	it("reports no_judge when the role resolves no candidate, not a provider failure", async () => {
		// A registry is present but its `judge` role names nothing usable: the chain throws, and that is a missing
		// judge, not a broken provider.
		const { judge } = fakeJudge(() => {
			throw new Error("judgment: no judge model available");
		});
		const scorer = new JudgeScorer(judge, 5_000);
		expect(await scorer.score(["a"], context())).toBeNull();
		expect(scorer.usage.failureCauses).toEqual({ no_judge: 1 });
	});

	it("answers nothing when there is nothing to rank", async () => {
		const { judge, requests } = fakeJudge(() => 0.5);
		expect(await new JudgeScorer(judge, 5_000).score([], context())).toEqual([]);
		expect(requests).toHaveLength(0);
	});

	it("builds the batch the judge receives from the call's context", () => {
		const batch = lineBatch({ ...context(), intent: "find the retry", said: "reading" }, ["one", "two"]);
		expect(Object.keys(batch.questions)).toEqual([lineKey(0), lineKey(1)]);
		expect(batch.questions[lineKey(0)]!.type).toBe("noul" satisfies NoulQuestion["type"]);
		expect(batch.state).toMatchObject({ intent: "find the retry", said: "reading", source: "read src/a.ts" });
	});
});
