/**
 * Judge questions authored as JSON files: `instructions` plus optional
 * `criteria`, keyed by question id. A JSON import widens every string, so a
 * question's kind follows from the shape of its `criteria` rather than a
 * `type` field — the same rule at compile time ({@link QuestionFor}) and at
 * load ({@link judgeQuestions}):
 * - a list of levels, lowest first → {@link ScoreQuestion}
 * - absent, or only `true`/`false` rubrics → {@link NoulQuestion}
 * - any other labels → {@link ChoiceQuestion} over them; `{}` when the caller
 *   supplies every label (table rows, labels shared with another question)
 *
 * Instructions may be Handlebars templates; {@link renderQuestion} fills them.
 *
 * @example
 * ```ts ignore
 * import graph from "./auto-graph.json" with { type: "json" };
 * const QUESTIONS = judgeQuestions(graph);
 * QUESTIONS.shading; // ChoiceQuestion<"shared" | "series" | "row">
 * renderQuestion(QUESTIONS.order, { column: "latency" });
 * ```
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { ChoiceQuestion, NoulQuestion, Question, Questions, ScoreQuestion } from "./types";

/** One question as a JSON question file writes it; {@link QuestionFor} gives its kind. */
export interface QuestionSpec {
	instructions: string;
	criteria?: string[] | { readonly [label: string]: string | null };
}

/** A JSON question file: {@link QuestionSpec}s keyed by question id. */
export interface QuestionFile {
	readonly [id: string]: QuestionSpec;
}

/** The question a {@link QuestionSpec} declares, with choice labels taken from its criteria keys. */
export type QuestionFor<S extends QuestionSpec> = S extends { criteria: string[] }
	? ScoreQuestion
	: S extends { criteria: infer C extends object }
		? [keyof C] extends [never]
			? ChoiceQuestion
			: [keyof C] extends ["true" | "false"]
				? NoulQuestion
				: ChoiceQuestion<Extract<keyof C, string>>
		: NoulQuestion;

/** Every question a {@link QuestionFile} declares, keyed as in the file. */
export type QuestionsFor<F extends QuestionFile> = { [K in keyof F]: QuestionFor<F[K]> };

/**
 * The typed questions of a JSON question file; answers to them come back typed
 * through {@link JudgmentResult}.
 * @throws when a score question lists fewer than two levels.
 */
export function judgeQuestions<F extends QuestionFile>(file: F): QuestionsFor<F>;
export function judgeQuestions(file: QuestionFile): Questions {
	const questions: Questions = {};
	for (const id in file) questions[id] = toQuestion(id, file[id]);
	return questions;
}

/** `question` with its instructions rendered as a Handlebars template over `context`. */
export function renderQuestion<Q extends Question>(question: Q, context: prompt.TemplateContext): Q {
	return { ...question, instructions: prompt.render(question.instructions, context) };
}

function toQuestion(id: string, { instructions, criteria }: QuestionSpec): Question {
	if (criteria === undefined) return { type: "noul", instructions };
	if (Array.isArray(criteria)) {
		const [lowest, second, ...rest] = criteria;
		if (lowest === undefined || second === undefined) {
			throw new Error(`score question "${id}" needs at least two levels`);
		}
		return { type: "score", instructions, criteria: [lowest, second, ...rest] };
	}
	const rubric = noulRubric(criteria);
	return rubric ? { type: "noul", instructions, criteria: rubric } : { type: "choice", instructions, criteria };
}

/** `criteria` as a yes/no rubric when its only labels are `true` and `false`; else `undefined`. */
function noulRubric(criteria: { readonly [label: string]: string | null }): NoulQuestion["criteria"] {
	let rubric: { true?: string; false?: string } | undefined;
	for (const label in criteria) {
		if (label !== "true" && label !== "false") return undefined;
		rubric ??= {};
		const text = criteria[label];
		if (text !== null) rubric[label] = text;
	}
	return rubric;
}
