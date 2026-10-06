/**
 * Model-picked charts for multi-series assistant tables (`tui.autoGraph:
 * smart`). The judge role chooses the chart kind, which measure columns to
 * plot, and whether each row is its own metric; the TUI's local guess supplies
 * the label column and fills in what a judge cannot answer. An on-device
 * judge only picks the kind (keyword answers), keeping the guessed columns.
 */
import type { ChoiceQuestion, NoulQuestion } from "@oh-my-pi/pi-ai";
import type { ChartKind, ChartPlan } from "@oh-my-pi/pi-tui/charts/chart-plan";
import type { TableColumn } from "@oh-my-pi/pi-tui/charts/table-data";
import type { TableChartRequest } from "@oh-my-pi/pi-tui/chat/table-chart";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ChainJudge } from "../judgment";
import columnQuestionTemplate from "../prompts/system/auto-graph-column-question.md" with { type: "text" };
import kindQuestionInstructions from "../prompts/system/auto-graph-kind-question.md" with { type: "text" };
import transposeQuestionInstructions from "../prompts/system/auto-graph-transpose-question.md" with { type: "text" };

type KindChoice = ChartKind | "none";
/** The kind, orientation, and one plot-this-column question per measure (`c<column index>`). */
type PickQuestions = { kind: ChoiceQuestion<KindChoice>; transpose: NoulQuestion } & Record<`c${number}`, NoulQuestion>;

const KIND_CRITERIA: Record<KindChoice, string> = {
	bar: "One numeric measure compared across categories.",
	paired: "Two same-unit values per category: before/after, A vs B, old vs new.",
	grouped: "Three or four same-unit measures per category, side by side.",
	line: "Values over an ordered axis: time, runs, versions, sizes, steps.",
	heatmap: "A matrix of same-unit values where the pattern across rows and columns matters.",
	multiples: "Measures in different units, or rows that are different metrics, each needing its own scale.",
	share: "Parts of one whole: shares summing to 100% or to a total.",
	diverging: "Signed changes or deltas around zero.",
	scatter: "Two continuous measures per item, looking for a relationship.",
	none: "Identifiers, settings, or too few comparable values: a chart adds nothing.",
};

const KIND_QUESTION: ChoiceQuestion<KindChoice> = {
	type: "choice",
	instructions: prompt.render(kindQuestionInstructions),
	criteria: KIND_CRITERIA,
};

const TRANSPOSE_QUESTION: NoulQuestion = { type: "noul", instructions: prompt.render(transposeQuestionInstructions) };

/** Table source the judge reads; longer tables are cut (their header and first rows decide). */
const MAX_TABLE_CHARS = 4000;
/** A pick slower than this gives way to the local guess, so the answer's chart never waits on a stuck judge. */
const PICK_TIMEOUT_MS = 15_000;

/**
 * The judge's chart for `request`, or `null` when it sees none.
 * @throws when no judge candidate answers (the caller falls back to the guess).
 */
export async function pickTableChart(request: TableChartRequest, judge: ChainJudge): Promise<ChartPlan | null> {
	const { table, guess } = request;
	const candidates = table.measures.filter(column => column.index !== guess.label);
	const state = {
		table: request.markdown.slice(0, MAX_TABLE_CHARS),
		columns: table.columns.map(column => ({ name: column.header, type: columnType(column) })),
	};
	const questions: PickQuestions = { kind: KIND_QUESTION, transpose: TRANSPOSE_QUESTION };
	for (const column of candidates) {
		questions[`c${column.index}`] = {
			type: "noul",
			instructions: prompt.render(columnQuestionTemplate, { column: column.header }),
		};
	}
	const options = { signal: AbortSignal.timeout(PICK_TIMEOUT_MS) };
	return judge.withCandidate(async (candidate, kind) => {
		if (kind === "local") {
			const { answers } = await candidate.judge({ state, questions: { kind: KIND_QUESTION } }, options);
			const choice = answers.kind.choice;
			return choice === "none" ? null : { ...guess, kind: choice };
		}
		const { answers } = await candidate.judge({ state, questions }, options);
		const choice = answers.kind.choice;
		if (choice === "none") return null;
		const picked = candidates.filter(column => (answers[`c${column.index}`]?.noul ?? 0) >= 0.5);
		const series = picked.length ? picked.map(column => column.index) : guess.series;
		return {
			kind: choice,
			label: guess.label,
			series: choice === "scatter" ? series.slice(0, 2) : series,
			// Rows that are metrics only need their own scales when units change down a column.
			transpose: answers.transpose.noul >= 0.5 && candidates.some(column => column.mixed),
		};
	}, options);
}

/** A column's inferred type as the judge reads it: `number (duration)`, `text`, `row index`, … */
function columnType(column: TableColumn): string {
	switch (column.role) {
		case "measure":
			return column.mixed ? "number (mixed units)" : `number (${column.dim ?? "count"})`;
		case "sequence":
			return "ordered step";
		case "index":
			return "row index";
		case "temporal":
			return "date/time";
		default:
			return "text";
	}
}
