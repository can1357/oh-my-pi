/**
 * TypeSafe skill suggestion (cookbook call 1).
 *
 * One Choice over the installed roster plus three gate Nouls in the same
 * request. Injects a per-turn `<skill_relevance>` line when the inverted-mean
 * of the gates is ≥ {@link GATE_THRESHOLD}. Extra questions barely change
 * System One latency; the cookbook's second request (rerank the top 3 with
 * SKILL.md excerpts) is the follow-up when lookalikes collide or the roster
 * grows past the Choice cap.
 *
 * https://docs.typesafe.ai/cookbooks/skill_suggestion.md
 */
import type { ChoiceQuestion, Judge, NoulQuestion } from "@oh-my-pi/pi-ai/judgment";

/** Cookbook gate: inject only when the inverted-mean of the three nouls is at least this. */
export const GATE_THRESHOLD = 0.3;
/** System One Choice cap. Typical omp rosters are ~40. */
export const MAX_CHOICES = 255;
export const SKILL_RELEVANCE_OPEN = "<skill_relevance>";
export const SKILL_RELEVANCE_CLOSE = "</skill_relevance>";

export const GATE_QUESTIONS = {
	acts_on_user_system:
		"Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
	would_follow_documented_procedure:
		"Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
	prose_suffices:
		"Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
} as const;

const INVERTED_GATES = new Set<keyof typeof GATE_QUESTIONS>(["prose_suffices"]);

export interface SuggestableSkill {
	name: string;
	description: string;
	/** Hidden skills stay out of the Choice roster (same as the `<skills>` listing). */
	hide?: boolean;
}

export interface SkillSuggestion {
	name: string;
	gate: number;
	probability: number;
	model: string;
}

export function systemPromptAlreadyHasSkillRelevance(systemPrompt: readonly string[]): boolean {
	return systemPrompt.some(part => part.includes(SKILL_RELEVANCE_OPEN));
}

export function skillRelevanceBlock(name: string): string {
	return [
		SKILL_RELEVANCE_OPEN,
		`Relevant to the current request: ${name}. Ignore this if it does not fit what the user actually asked for.`,
		SKILL_RELEVANCE_CLOSE,
	].join("\n");
}

export function visibleSkillsForSuggestion(skills: readonly SuggestableSkill[]): SuggestableSkill[] {
	const seen = new Set<string>();
	const out: SuggestableSkill[] = [];
	for (const skill of skills) {
		if (skill.hide) continue;
		const name = skill.name.trim();
		if (!name || name.length > 64 || seen.has(name)) continue;
		seen.add(name);
		out.push({
			name,
			description: skill.description.replace(/\s+/g, " ").slice(0, 120),
		});
		if (out.length >= MAX_CHOICES) break;
	}
	return out;
}

export function gateMean(answers: Record<string, { noul?: number } | undefined>): number {
	const values: number[] = [];
	for (const key of Object.keys(GATE_QUESTIONS) as (keyof typeof GATE_QUESTIONS)[]) {
		const noul = Number(answers[`gate::${key}`]?.noul ?? 0);
		values.push(INVERTED_GATES.has(key) ? 1 - noul : noul);
	}
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function shouldSkipPrompt(prompt: string): boolean {
	const trimmed = prompt.trim();
	return trimmed.length === 0 || trimmed.startsWith("/");
}

export async function suggestSkill(input: {
	prompt: string;
	skills: readonly SuggestableSkill[];
	judge: Judge;
	signal?: AbortSignal;
}): Promise<SkillSuggestion | null> {
	if (shouldSkipPrompt(input.prompt)) return null;
	const roster = visibleSkillsForSuggestion(input.skills);
	if (roster.length < 2) return null;

	const criteria: Record<string, string | null> = {};
	for (const skill of roster) criteria[skill.name] = skill.description || null;

	const which: ChoiceQuestion = {
		type: "choice",
		instructions: "Which of these skills, if any, is the right one to load to help with the user's latest request?",
		criteria,
	};
	const questions: Record<string, ChoiceQuestion | NoulQuestion> = { which };
	for (const [key, text] of Object.entries(GATE_QUESTIONS)) {
		questions[`gate::${key}`] = { type: "noul", instructions: text };
	}

	const result = await input.judge.judge(
		{
			state: { request: input.prompt.slice(0, 4000), recent_context: "" },
			questions,
		},
		{ signal: input.signal },
	);
	const choice = String(result.answers.which?.choice ?? "");
	if (!choice || !criteria[choice]) return null;
	const gate = gateMean(result.answers as Record<string, { noul?: number } | undefined>);
	if (gate < GATE_THRESHOLD) return null;
	const probability = Number(result.answers.which?.probabilities?.[choice] ?? 0);
	return { name: choice, gate, probability, model: result.model };
}
