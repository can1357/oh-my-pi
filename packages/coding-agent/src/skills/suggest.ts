/**
 * TypeSafe skill suggestion (cookbook calls 1–2).
 *
 * Call 1: one Choice over the installed roster plus three gate Nouls in the same
 * request. Call 2 (optional): rerank the top 3 with SKILL.md excerpts plus per-
 * candidate fits Nouls. Injects a per-turn `<skill_relevance>` line when the
 * inverted-mean of the gates is ≥ {@link GATE_THRESHOLD} and (when reranked)
 * the winner's fits noul is ≥ {@link FITS_THRESHOLD}.
 *
 * https://docs.typesafe.ai/cookbooks/skill_suggestion.md
 */
import type { ChoiceQuestion, Judge, NoulQuestion } from "@oh-my-pi/pi-ai/judgment";

/** Cookbook gate: inject only when the inverted-mean of the three nouls is at least this. */
export const GATE_THRESHOLD = 0.3;
/** Cookbook fits: drop the shortlist when the best per-candidate noul is below this. */
export const FITS_THRESHOLD = 0.3;
/** System One Choice cap. Typical omp rosters are ~40. */
export const MAX_CHOICES = 255;
/** Candidates carried from call 1 into call 2. */
export const SHORTLIST_SIZE = 3;
/** SKILL.md characters each shortlisted candidate brings into call 2. */
export const EXCERPT_CHARS = 700;
/** Run call 2 on small rosters when the top two choice probabilities are this close. */
export const LOOKALIKE_DELTA = 0.1;
/** Auto rerank when the visible roster is at least this large. */
export const ROSTER_RERANK_THRESHOLD = 100;
/** Skip call 2 in auto mode when call 1 is already this confident. */
export const HIGH_CONFIDENCE_GATE = 0.6;
export const HIGH_CONFIDENCE_PROBABILITY = 0.7;

export const SKILL_RELEVANCE_OPEN = "<skill_relevance>";
export const SKILL_RELEVANCE_CLOSE = "</skill_relevance>";
export const NONE_OF_THESE = "none_of_these";

export const GATE_QUESTIONS = {
	acts_on_user_system:
		"Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
	would_follow_documented_procedure:
		"Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
	prose_suffices:
		"Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
} as const;

const INVERTED_GATES = new Set<keyof typeof GATE_QUESTIONS>(["prose_suffices"]);

const CHOICE_INSTRUCTIONS =
	"Which of these skills, if any, is the right one to load to help with the user's latest request?";

const RERANK_INSTRUCTIONS =
	"Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.";

export type SkillSuggestionRerank = "auto" | "always" | "off";

export interface SuggestableSkill {
	name: string;
	description: string;
	/** Hidden skills stay out of the Choice roster (same as the `<skills>` listing). */
	hide?: boolean;
}

export interface SkillDetail {
	description: string;
	body: string;
}

export interface SkillSuggestion {
	name: string;
	gate: number;
	probability: number;
	fits?: number;
	reranked: boolean;
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

export function topChoiceProbabilities(probabilities: Record<string, number> | undefined): number[] {
	if (!probabilities) return [];
	return Object.values(probabilities)
		.map(p => Number(p))
		.filter(Number.isFinite)
		.sort((a, b) => b - a);
}

/** Whether call 2 should run after call 1 passes the gate. */
export function shouldRerank(input: {
	mode: SkillSuggestionRerank;
	rosterSize: number;
	gate: number;
	topProbability: number;
	probabilities: Record<string, number> | undefined;
}): boolean {
	if (input.mode === "off") return false;
	if (input.mode === "always") return true;
	if (input.rosterSize >= ROSTER_RERANK_THRESHOLD) return true;
	if (input.gate >= HIGH_CONFIDENCE_GATE && input.topProbability >= HIGH_CONFIDENCE_PROBABILITY) {
		return false;
	}
	const [first, second] = topChoiceProbabilities(input.probabilities);
	if (first !== undefined && second !== undefined && first - second <= LOOKALIKE_DELTA) return true;
	return false;
}

function shouldSkipPrompt(prompt: string): boolean {
	const trimmed = prompt.trim();
	return trimmed.length === 0 || trimmed.startsWith("/");
}

function rankedShortlist(
	probabilities: Record<string, number> | undefined,
	roster: readonly SuggestableSkill[],
	size: number,
): string[] {
	if (!probabilities) return roster.slice(0, size).map(skill => skill.name);
	const allowed = new Set(roster.map(skill => skill.name));
	return Object.entries(probabilities)
		.filter(([name, p]) => allowed.has(name) && Number.isFinite(Number(p)))
		.sort((a, b) => Number(b[1]) - Number(a[1]))
		.slice(0, size)
		.map(([name]) => name);
}

function rerankCriteria(
	names: readonly string[],
	byName: ReadonlyMap<string, SuggestableSkill>,
	details: ReadonlyMap<string, SkillDetail>,
): Record<string, string | null> {
	const criteria: Record<string, string | null> = {
		[NONE_OF_THESE]: "None of these skills fit the request.",
	};
	for (const name of names) {
		const skill = byName.get(name);
		const detail = details.get(name);
		const description = detail?.description ?? skill?.description ?? name;
		const excerpt = detail?.body?.trim();
		criteria[name] = excerpt ? `${description} — ${excerpt}` : description;
	}
	return criteria;
}

async function rerankSkill(input: {
	prompt: string;
	shortlist: readonly string[];
	byName: ReadonlyMap<string, SuggestableSkill>;
	judge: Judge;
	signal?: AbortSignal;
	loadDetail?: (name: string) => Promise<SkillDetail | null>;
}): Promise<{ name: string; fits: number; probability: number; model: string } | null> {
	if (input.shortlist.length === 0) return null;

	const details = new Map<string, SkillDetail>();
	if (input.loadDetail) {
		await Promise.all(
			input.shortlist.map(async name => {
				const detail = await input.loadDetail!(name);
				if (detail) details.set(name, detail);
			}),
		);
	}

	const criteria = rerankCriteria(input.shortlist, input.byName, details);
	const which: ChoiceQuestion = {
		type: "choice",
		instructions: RERANK_INSTRUCTIONS,
		criteria,
	};
	const questions: Record<string, ChoiceQuestion | NoulQuestion> = { which };
	for (const name of input.shortlist) {
		const skill = input.byName.get(name);
		questions[`fits::${name}`] = {
			type: "noul",
			instructions: `Does the skill '${name}' do the specific thing the user's request asks for? It is described as: ${skill?.description ?? name}`,
		};
	}

	const result = await input.judge.judge(
		{
			state: { request: input.prompt.slice(0, 4000), recent_context: "" },
			questions,
		},
		{ signal: input.signal },
	);

	const choice = String(result.answers.which?.choice ?? "");
	if (!choice || choice === NONE_OF_THESE || !input.byName.has(choice)) return null;

	const fitsValues = Object.entries(result.answers)
		.filter(([key]) => key.startsWith("fits::"))
		.map(([, answer]) => Number(answer?.noul ?? 0));
	const bestFits = fitsValues.length > 0 ? Math.max(...fitsValues) : 0;
	const winnerFits = Number(result.answers[`fits::${choice}`]?.noul ?? bestFits);
	if (bestFits < FITS_THRESHOLD) return null;

	return {
		name: choice,
		fits: winnerFits,
		probability: Number(result.answers.which?.probabilities?.[choice] ?? 0),
		model: result.model,
	};
}

export async function suggestSkill(input: {
	prompt: string;
	skills: readonly SuggestableSkill[];
	judge: Judge;
	signal?: AbortSignal;
	rerank?: SkillSuggestionRerank;
	loadDetail?: (name: string) => Promise<SkillDetail | null>;
}): Promise<SkillSuggestion | null> {
	if (shouldSkipPrompt(input.prompt)) return null;
	const roster = visibleSkillsForSuggestion(input.skills);
	if (roster.length < 2) return null;

	const criteria: Record<string, string | null> = {};
	for (const skill of roster) criteria[skill.name] = skill.description || null;

	const which: ChoiceQuestion = {
		type: "choice",
		instructions: CHOICE_INSTRUCTIONS,
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
	const rerankMode = input.rerank ?? "auto";
	const byName = new Map(roster.map(skill => [skill.name, skill]));
	const [topProbability] = topChoiceProbabilities(result.answers.which?.probabilities);

	if (
		!shouldRerank({
			mode: rerankMode,
			rosterSize: roster.length,
			gate,
			topProbability: topProbability ?? probability,
			probabilities: result.answers.which?.probabilities,
		})
	) {
		return { name: choice, gate, probability, reranked: false, model: result.model };
	}

	const shortlist = rankedShortlist(result.answers.which?.probabilities, roster, SHORTLIST_SIZE);
	const reranked = await rerankSkill({
		prompt: input.prompt,
		shortlist,
		byName,
		judge: input.judge,
		signal: input.signal,
		loadDetail: input.loadDetail,
	});
	if (!reranked) return null;

	return {
		name: reranked.name,
		gate,
		probability: reranked.probability,
		fits: reranked.fits,
		reranked: true,
		model: reranked.model,
	};
}
