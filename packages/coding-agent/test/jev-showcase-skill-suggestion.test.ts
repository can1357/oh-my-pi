/**
 * TypeSafe skill_suggestion cookbook battery (subset).
 * Mirrors Step 5 scorecard: wrong_load + needless_load on suggestSkill().
 */
import { describe, expect, it } from "bun:test";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai/judgment";
import { suggestSkill, type SuggestableSkill } from "../src/skills/suggest";
import {
	gradeSkillSuggestion,
	summarizeSkillSuggestion,
	type SkillSuggestionTask,
} from "../src/jev-showcase/grade-skill-suggestion";
import tasks from "../evals/jev-showcase/skill-suggestion/tasks.json";
import rosterJson from "../evals/jev-showcase/skill-suggestion/roster.json";

const roster = rosterJson as SuggestableSkill[];

function oracleJudge(task: SkillSuggestionTask): Judge {
	return {
		label: "oracle/jev-showcase",
		async judge<Q extends Questions>(_req: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
			const act = task.gold ? 0.85 : 0.05;
			const proc = task.gold ? 0.8 : 0.05;
			const prose = task.gold ? 0.1 : 0.95;
			const choice = task.gold ?? roster[0]!.name;
			const probabilities = Object.fromEntries(roster.map(s => [s.name, s.name === choice ? 0.75 : 0.02]));
			return {
				api: "typesafe",
				provider: "typesafe",
				model: "jev-showcase-oracle",
				answers: {
					which: { type: "choice", choice, probabilities, confidence: 0.75 },
					"gate::acts_on_user_system": { type: "noul", noul: act },
					"gate::would_follow_documented_procedure": { type: "noul", noul: proc },
					"gate::prose_suffices": { type: "noul", noul: prose },
				} as JudgmentResult<Q>["answers"],
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

describe("jev showcase skill suggestion battery", () => {
	const battery = tasks as SkillSuggestionTask[];

	it("grades each task with the cookbook oracle mock", async () => {
		const results = new Map<string, string | null>();
		for (const task of battery) {
			const suggestion = await suggestSkill({
				prompt: task.text,
				skills: roster,
				judge: oracleJudge(task),
				rerank: "off",
			});
			expect(gradeSkillSuggestion(task, suggestion?.name ?? null)).toBe("correct");
			results.set(task.id, suggestion?.name ?? null);
		}
		const score = summarizeSkillSuggestion(battery, results);
		expect(score.wrongLoad).toBe(0);
		expect(score.needlessLoad).toBe(0);
	});

	it("reports cookbook-shaped scorecard columns", async () => {
		const baseline = new Map<string, string | null>();
		const typesafe = new Map<string, string | null>();
		for (const task of battery) {
			baseline.set(task.id, task.gold ? "wrong-guess" : null);
			const suggestion = await suggestSkill({
				prompt: task.text,
				skills: roster,
				judge: oracleJudge(task),
				rerank: "off",
			});
			typesafe.set(task.id, suggestion?.name ?? null);
		}
		const baseScore = summarizeSkillSuggestion(battery, baseline);
		const tsScore = summarizeSkillSuggestion(battery, typesafe, baseline);
		expect(baseScore.wrongLoad).toBeGreaterThan(tsScore.wrongLoad);
		expect(tsScore.fixed).toBeGreaterThan(0);
	});
});
