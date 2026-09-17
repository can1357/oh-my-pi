import { describe, expect, it } from "bun:test";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai/judgment";
import { shouldRunSkillSuggestion } from "../src/skills/policy";
import {
	FITS_THRESHOLD,
	GATE_THRESHOLD,
	gateMean,
	shouldRerank,
	skillRelevanceBlock,
	suggestSkill,
	systemPromptAlreadyHasSkillRelevance,
	visibleSkillsForSuggestion,
} from "../src/skills/suggest";

function fakeJudge(
	answersByStage: Record<string, Record<string, unknown>> | Record<string, unknown>,
	opts: { throw?: Error; model?: string } = {},
): Judge {
	let calls = 0;
	return {
		label: "fake/jev-test",
		async judge<Q extends Questions>(_request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
			if (opts.throw) throw opts.throw;
			calls += 1;
			const answers =
				"which" in answersByStage
					? (answersByStage as Record<string, unknown>)
					: ((answersByStage as Record<string, Record<string, unknown>>)[calls === 1 ? "wide" : "rerank"] ?? {});
			return {
				api: "typesafe",
				provider: "typesafe",
				model: opts.model ?? "jev-test",
				answers: answers as JudgmentResult<Q>["answers"],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	};
}

const roster = [
	{ name: "systematic-debugging", description: "Debug a failure with evidence" },
	{ name: "agent-reach", description: "Search GitHub and the web" },
	{ name: "typesafe-jev", description: "Native TypeSafe Jev skill routing" },
];

function gatedAnswers(choice: string, gates: { act: number; proc: number; prose: number }) {
	const probabilities: Record<string, number> = {
		"systematic-debugging": 0.1,
		"agent-reach": 0.1,
		"typesafe-jev": 0.1,
	};
	probabilities[choice] = 0.8;
	return {
		which: {
			type: "choice",
			choice,
			probabilities,
			confidence: 0.7,
		},
		"gate::acts_on_user_system": { type: "noul", noul: gates.act },
		"gate::would_follow_documented_procedure": { type: "noul", noul: gates.proc },
		"gate::prose_suffices": { type: "noul", noul: gates.prose },
	};
}

describe("suggestSkill", () => {
	it("injects the named skill when the cookbook gate mean is at least 0.30", async () => {
		const suggestion = await suggestSkill({
			prompt: "debug why hermes CLI prints HERMES_HOME fallback on every launch",
			skills: roster,
			judge: fakeJudge(gatedAnswers("systematic-debugging", { act: 0.9, proc: 0.8, prose: 0.1 })),
		});
		expect(suggestion?.name).toBe("systematic-debugging");
		expect(suggestion?.gate).toBeGreaterThanOrEqual(GATE_THRESHOLD);
		expect(skillRelevanceBlock(suggestion!.name)).toContain("systematic-debugging");
		expect(skillRelevanceBlock(suggestion!.name)).toContain("<skill_relevance>");
	});

	it("stays quiet when the gate mean is below 0.30", async () => {
		const suggestion = await suggestSkill({
			prompt: "hey",
			skills: roster,
			judge: fakeJudge(gatedAnswers("agent-reach", { act: 0.05, proc: 0.05, prose: 0.95 })),
		});
		expect(suggestion).toBeNull();
	});

	it("inverts prose_suffices so a yes on that noul lowers the gate", () => {
		expect(
			gateMean({
				"gate::acts_on_user_system": { noul: 1 },
				"gate::would_follow_documented_procedure": { noul: 1 },
				"gate::prose_suffices": { noul: 1 },
			}),
		).toBeCloseTo(2 / 3, 5);
		expect(
			gateMean({
				"gate::acts_on_user_system": { noul: 1 },
				"gate::would_follow_documented_procedure": { noul: 1 },
				"gate::prose_suffices": { noul: 0 },
			}),
		).toBeCloseTo(1, 5);
	});

	it("skips empty prompts, slash commands, and tiny rosters", async () => {
		const judge = fakeJudge(gatedAnswers("agent-reach", { act: 1, proc: 1, prose: 0 }));
		expect(await suggestSkill({ prompt: "   ", skills: roster, judge })).toBeNull();
		expect(await suggestSkill({ prompt: "/jev", skills: roster, judge })).toBeNull();
		expect(await suggestSkill({ prompt: "do the thing", skills: roster.slice(0, 1), judge })).toBeNull();
	});

	it("drops hidden skills from the Choice roster", () => {
		const visible = visibleSkillsForSuggestion([
			{ name: "keep", description: "keep me" },
			{ name: "secret", description: "hide me", hide: true },
			{ name: "also", description: "keep me too" },
		]);
		expect(visible.map(s => s.name)).toEqual(["keep", "also"]);
	});

	it("ignores a choice that is not on the roster", async () => {
		const suggestion = await suggestSkill({
			prompt: "do the thing",
			skills: roster,
			judge: fakeJudge(gatedAnswers("not-installed", { act: 1, proc: 1, prose: 0 })),
		});
		expect(suggestion).toBeNull();
	});

	it("propagates judge failures to the caller", async () => {
		await expect(
			suggestSkill({
				prompt: "do the thing",
				skills: roster,
				judge: fakeJudge({}, { throw: new Error("boom") }),
			}),
		).rejects.toThrow("boom");
	});

	it("reranks lookalikes in auto mode and returns the stage-2 winner", async () => {
		const suggestion = await suggestSkill({
			prompt: "build a pitch deck as a pptx",
			skills: roster,
			rerank: "auto",
			judge: fakeJudge({
				wide: {
					which: {
						type: "choice",
						choice: "systematic-debugging",
						probabilities: {
							"systematic-debugging": 0.42,
							"typesafe-jev": 0.38,
							"agent-reach": 0.2,
						},
						confidence: 0.4,
					},
					"gate::acts_on_user_system": { type: "noul", noul: 0.9 },
					"gate::would_follow_documented_procedure": { type: "noul", noul: 0.8 },
					"gate::prose_suffices": { type: "noul", noul: 0.1 },
				},
				rerank: {
					which: {
						type: "choice",
						choice: "typesafe-jev",
						probabilities: { "typesafe-jev": 0.7, "systematic-debugging": 0.2, "agent-reach": 0.1 },
						confidence: 0.6,
					},
					"fits::typesafe-jev": { type: "noul", noul: 0.55 },
					"fits::systematic-debugging": { type: "noul", noul: 0.45 },
					"fits::agent-reach": { type: "noul", noul: 0.05 },
				},
			}),
		});
		expect(suggestion?.name).toBe("typesafe-jev");
		expect(suggestion?.reranked).toBe(true);
		expect(suggestion?.fits).toBeGreaterThanOrEqual(FITS_THRESHOLD);
	});

	it("stays quiet when rerank fits fall below the threshold", async () => {
		const suggestion = await suggestSkill({
			prompt: "build a pitch deck as a pptx",
			skills: roster,
			rerank: "always",
			judge: fakeJudge({
				wide: gatedAnswers("agent-reach", { act: 0.9, proc: 0.8, prose: 0.1 }),
				rerank: {
					which: {
						type: "choice",
						choice: "agent-reach",
						probabilities: { "agent-reach": 0.7 },
						confidence: 0.6,
					},
					"fits::agent-reach": { type: "noul", noul: 0.1 },
				},
			}),
		});
		expect(suggestion).toBeNull();
	});
});

describe("shouldRerank", () => {
	it("auto skips rerank when call 1 is already high confidence", () => {
		expect(
			shouldRerank({
				mode: "auto",
				rosterSize: 40,
				gate: 0.8,
				topProbability: 0.85,
				probabilities: { a: 0.85, b: 0.1 },
			}),
		).toBe(false);
	});

	it("auto reranks when the top two probabilities are close", () => {
		expect(
			shouldRerank({
				mode: "auto",
				rosterSize: 40,
				gate: 0.5,
				topProbability: 0.42,
				probabilities: { a: 0.42, b: 0.38, c: 0.2 },
			}),
		).toBe(true);
	});
});

describe("shouldRunSkillSuggestion", () => {
	function registry(hasTypesafe: boolean) {
		return { authStorage: { hasAuth: (provider: string) => hasTypesafe && provider === "typesafe" } };
	}

	function settings(map: Record<string, unknown>) {
		return { get: (key: string) => map[key] };
	}

	it("auto runs only when TypeSafe is the judgment backend", () => {
		expect(shouldRunSkillSuggestion(settings({ "skills.suggestion": "auto" }), registry(true))).toBe(true);
		expect(shouldRunSkillSuggestion(settings({ "skills.suggestion": "auto" }), registry(false))).toBe(false);
		expect(
			shouldRunSkillSuggestion(
				settings({ "skills.suggestion": "auto", "providers.judgmentProvider": "llm" }),
				registry(true),
			),
		).toBe(false);
	});

	it("typesafe forces System One when a key exists, even if judgmentProvider is llm", () => {
		expect(
			shouldRunSkillSuggestion(
				settings({ "skills.suggestion": "typesafe", "providers.judgmentProvider": "llm" }),
				registry(true),
			),
		).toBe(true);
		expect(
			shouldRunSkillSuggestion(
				settings({ "skills.suggestion": "typesafe", "providers.judgmentProvider": "llm" }),
				registry(false),
			),
		).toBe(false);
	});

	it("off and skills.enabled=false skip the call", () => {
		expect(shouldRunSkillSuggestion(settings({ "skills.suggestion": "off" }), registry(true))).toBe(false);
		expect(
			shouldRunSkillSuggestion(settings({ "skills.suggestion": "auto", "skills.enabled": false }), registry(true)),
		).toBe(false);
	});

	it("skips a second inject when an extension already wrote skill_relevance", () => {
		expect(systemPromptAlreadyHasSkillRelevance(["base", "<skill_relevance>\nRelevant: x\n</skill_relevance>"])).toBe(
			true,
		);
		expect(systemPromptAlreadyHasSkillRelevance(["base"])).toBe(false);
	});
});
