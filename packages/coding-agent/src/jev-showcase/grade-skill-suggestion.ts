/**
 * Skill-suggestion scorecard — mirrors docs.typesafe.ai cookbooks/skill_suggestion.md Step 5.
 */

export type SkillSuggestionGrade = "correct" | "wrong" | "needless";

export interface SkillSuggestionTask {
	id: string;
	text: string;
	gold?: string | null;
}

export function gradeSkillSuggestion(
	task: SkillSuggestionTask,
	suggested: string | null | undefined,
): SkillSuggestionGrade {
	if (task.gold) {
		return suggested === task.gold ? "correct" : "wrong";
	}
	return suggested ? "needless" : "correct";
}

export interface SkillSuggestionScorecard {
	wrongLoad: number;
	needlessLoad: number;
	positiveTotal: number;
	negativeTotal: number;
	fixed: number;
	broke: number;
}

export function summarizeSkillSuggestion(
	tasks: readonly SkillSuggestionTask[],
	results: ReadonlyMap<string, string | null>,
	baseline?: ReadonlyMap<string, string | null>,
): SkillSuggestionScorecard {
	const positives = tasks.filter(t => t.gold);
	const negatives = tasks.filter(t => !t.gold);

	let wrong = 0;
	let needless = 0;
	let fixed = 0;
	let broke = 0;

	for (const task of positives) {
		const got = results.get(task.id) ?? null;
		if (got !== task.gold) wrong += 1;
		if (baseline) {
			const baseGot = baseline.get(task.id) ?? null;
			const baseOk = baseGot === task.gold;
			const nowOk = got === task.gold;
			if (!baseOk && nowOk) fixed += 1;
			if (baseOk && !nowOk) broke += 1;
		}
	}
	for (const task of negatives) {
		if (results.get(task.id)) needless += 1;
	}

	return {
		wrongLoad: positives.length ? wrong / positives.length : 0,
		needlessLoad: negatives.length ? needless / negatives.length : 0,
		positiveTotal: positives.length,
		negativeTotal: negatives.length,
		fixed,
		broke,
	};
}
