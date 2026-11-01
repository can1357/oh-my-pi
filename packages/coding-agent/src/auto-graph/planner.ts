/**
 * Model-picked charts for multi-series assistant tables (`tui.autoGraph:
 * smart`). {@link judgeRequest} asks the judge role what only meaning can
 * decide — the chart kind, which columns to plot and which name the rows, how
 * rows group, order and compare (shading, reference row, ranking), which way
 * each measure is better, what competes, the focus row, and which computed
 * takeaway titles the chart — and {@link planFromAnswers} turns the answers
 * into a {@link ChartPlan}, each answer only above its confidence gate and the
 * TUI's local guess everywhere else. An on-device judge only picks the kind
 * (keyword answers), keeping the rest of the guess.
 */
import {
	type Answer,
	type ChoiceQuestion,
	type JudgmentState,
	judgeQuestions,
	type Questions,
	renderQuestion,
} from "@oh-my-pi/pi-ai";
import {
	buildChart,
	type ChartKind,
	type ChartPlan,
	dotsFit,
	drawnNames,
	findTarget,
	guessMeaning,
	guessNaming,
	guessShading,
	histogramColumns,
	isConditionPair,
	isTransition,
	ladderColumns,
	leadingMeasures,
	MAX_SHARE_SEGMENTS,
	namingColumns,
	opposedColumns,
	outcomeColumns,
	type Polarity,
	proseLed,
	type Rivals,
	type RowOrder,
	rangeColumns,
	rowsAreMetrics,
	stageColumns,
	tableLadders,
	tableTakeaways,
} from "@oh-my-pi/pi-tui/charts/chart-plan";
import { isMonotonic, isNumber, type TableAnalysis, type TableColumn } from "@oh-my-pi/pi-tui/charts/table-data";
import type { TableChartRequest } from "@oh-my-pi/pi-tui/chat/table-chart";
import type { ChainJudge } from "../judgment";
import questionFile from "../prompts/judge/auto-graph.json" with { type: "json" };

/** The planner's judge questions; {@link judgeRequest} renders their templates per table. */
const QUESTIONS = judgeQuestions(questionFile);

/** A pick slower than this gives way to the local guess, so the answer's chart never waits on a stuck judge. */
const PICK_TIMEOUT_MS = 15_000;

/**
 * The judge's chart for `request`, or `null` when it sees none.
 * @throws when no judge candidate answers (the caller falls back to the guess).
 */
export async function pickTableChart(request: TableChartRequest, judge: ChainJudge): Promise<ChartPlan | null> {
	const options = { signal: AbortSignal.timeout(PICK_TIMEOUT_MS) };
	return judge.withCandidate(async (candidate, kind) => {
		const { state, questions } = judgeRequest(request);
		if (kind === "local") {
			// Keyword answers only carry the kind; the rest of the guess stands.
			const { answers } = await candidate.judge({ state, questions: { kind: kindQuestion(request) } }, options);
			const choice = answers.kind.choice;
			if (!isOption(QUESTIONS.kind.criteria, choice)) return request.guess;
			return choice === "none" ? null : { ...request.guess, kind: choice };
		}
		const { answers } = await candidate.judge({ state, questions }, options);
		return planFromAnswers(request, answers);
	}, options);
}

/** The kind question for `request`: every kind its data can draw ({@link kindCriteria}), and `none`. */
function kindQuestion({ table, guess }: TableChartRequest): ChoiceQuestion {
	const candidates = table.measures.filter(column => column.index !== guess.label);
	return { ...QUESTIONS.kind, criteria: kindCriteria(table, guess, candidates) };
}

/** Whether `value` is one of `criteria`'s option labels. */
function isOption<L extends string>(criteria: Record<L, unknown>, value: string): value is L {
	return Object.hasOwn(criteria, value);
}

type KindChoice = ChartKind | "none";
/**
 * Probability a shading pick needs to override the local guess: a hesitant
 * `series` would trade a heatmap of one measure for bars (t055 scores at 0.66).
 */
const SHADING_CONFIDENCE = 0.7;
/** Fewest same-unit columns that can draw as a heatmap, whose shading the judge then picks. */
const MIN_HEAT_COLUMNS = 4;
/** Fewest rows a ranking can reorder usefully. */
const MIN_RANKED_ROWS = 4;
/** Probability a ranking needs to override the table's order: a coin flip keeps the order the author chose. */
const RANK_CONFIDENCE = 0.6;
/** Probability the judge's reference pick (or `none`) needs to override the local guess. */
const REFERENCE_CONFIDENCE = 0.8;
/** Most distinct naming values offered as reference rows. */
const MAX_REFERENCE_CHOICES = 8;
/** Longest naming value offered as a reference row; longer cells describe rather than name. */
const MAX_REFERENCE_CHARS = 48;
/** Kinds that keep a row order of their own (an x axis, factors in table order, parts of a whole). */
const OWN_FRAME: ReadonlySet<KindChoice> = new Set([
	"line",
	"scatter",
	"change",
	"stacked",
	"timeline",
	"waterfall",
	"slope",
	"bullet",
	"histogram",
]);
/**
 * Kinds that lay rows out as one run of steps, from one column: offered to the
 * judge only where the local guess found one ({@link KIND_GATES}).
 */
const FLOWS: ReadonlySet<KindChoice> = new Set(["timeline", "waterfall"]);
/** Guessed kinds whose chart draws reference rules: bars, and grids of bars (a series-shaded heatmap becomes one). */
const REFERENCED: ReadonlySet<ChartKind> = new Set(["bar", "multiples", "heatmap"]);
const MAX_TABLE_CHARS = 4000;
/** Most questions one table is asked; earlier groups' questions come first, semantics' fill the rest ({@link SEMANTIC_PRIORITY}). */
const MAX_QUESTIONS = 25;
/** The choice meaning no row is the focus, or no takeaway titles the chart. */
const NONE = "none";
/** Both readings of what competes: the title candidates include either's outcome, whatever the judge answers on rivals. */
const CONTESTS: readonly Rivals[] = ["rows", "columns"];
/** Most measures asked for their polarity (the guess's series first, then other candidates); later ones keep the unit's guess. */
const MAX_POLARITY_QUESTIONS = 6;
/** Most rows offered as the table's focus. */
const MAX_FOCUS_ROWS = 12;
/** Fewest rows for which a focus or a contest changes the chart. */
const MIN_CONTEST_ROWS = 3;
/** Judge confidence at which its polarity for a measure overrides the unit's guess ({@link guessMeaning}). */
const SURE_POLARITY = 0.7;
/** Judge confidence at which its reading of what competes overrides the label-header guess. */
const SURE_RIVALS = 0.7;
/** Judge confidence at which its focus row stands on its own; below it the table must also single the row out. */
const SURE_FOCUS = 0.75;
/** Judge confidence at which its focus row counts when the table singles it out too (bold, `(current)`). */
const AGREED_FOCUS = 0.4;
/** Judge confidence at which its title pick (a striking fact, or none) overrides the local guess's. */
const SURE_TITLE = 0.4;
/**
 * Probability an unsure judge must still give a striking fact for it to title the chart over the local
 * order's first striking fact (t039: `Every plan improved` at 0.38 over a sweep at 0.07).
 */
const RANKED_TITLE = 0.2;
/** Judge confidence a plain fact (a top value, a share) needs to title a chart: it mostly restates the marks. */
const SURE_PLAIN_TITLE = 0.75;
/**
 * Order in which semantics' questions fill what {@link MAX_QUESTIONS} leaves:
 * the title (most visible), what competes (gates every best mark), the
 * plotted measures' polarity (best marks and tones), the focus row, and the
 * metric rows' polarity (factor tones the units mostly decide already). The
 * polarity of a before/after move (`move`) follows the title: it tones every
 * row of a dumbbell or slope, whose condition headers (`Baseline | Iter130`)
 * leave the per-column polarity questions without a measure to judge.
 */
const SEMANTIC_PRIORITY = ["title", "move", "rivals", "p", "focus", "q"] as const;
/**
 * Kinds comparing each row's values apart, which a table mostly of quantiles draws better as ladders;
 * small multiples (other measures beside them) and `none` stand.
 */
const LADDERABLE: ReadonlySet<KindChoice> = new Set([
	"bar",
	"paired",
	"grouped",
	"dots",
	"heatmap",
	"change",
	"range",
	"ladder",
]);
/** Kinds that compare rows one by one, which counts over ordered bins draw better as a histogram. */
const BINNABLE: ReadonlySet<KindChoice> = new Set(["bar", "paired", "grouped", "line", "dots", "histogram"]);
/** Kinds a table of parts summing to a whole draws better as stacked bars. */
const STACKABLE: ReadonlySet<KindChoice> = new Set([
	"bar",
	"grouped",
	"paired",
	"heatmap",
	"multiples",
	"share",
	"stacked",
]);
/** Dimensions whose columns may be parts of one whole: amounts, not rates, ratios or scores. */
const ADDITIVE: ReadonlySet<string> = new Set(["count", "percent", "duration", "bytes", "currency"]);
/** A column naming a whole or an average rather than a part (`Prose total`, `Mean`). */
const WHOLE_HEADER = /\b(?:total|all|sum|overall|avg|average|mean)\b/i;

/**
 * The picked columns a judge's `stacked` pick may stack without a composition
 * the values show: non-negative amounts in the first such column's unit,
 * totals and averages left out.
 */
function stackable(table: TableAnalysis, series: readonly number[]): TableColumn[] {
	const amounts = series
		.map(index => table.columns[index]!)
		.filter(
			column =>
				column.dim !== undefined &&
				ADDITIVE.has(column.dim) &&
				!column.scores &&
				!WHOLE_HEADER.test(column.header) &&
				table.rows.every(row => {
					const cell = column.cells[row];
					return cell?.kind !== "number" || cell.value >= 0;
				}),
		);
	const first = amounts[0];
	return first ? amounts.filter(column => column.dim === first.dim && column.unit === first.unit) : [];
}

/**
 * Kinds the judge is offered only where the table's data can draw one: an option the data cannot draw
 * only sways the pick among the rest, and leaving it out keeps every other table's kind question
 * byte-identical (and cached).
 * - `timeline`, `waterfall`: the local guess found that run of steps ({@link FLOWS}).
 * - `range`: candidates hold mostly `a–b` intervals ({@link rangeColumns}).
 * - `dots`: three or more same-unit candidates fit a dot plot ({@link dotsFit}).
 * - `slope`: candidates hold one quantity at three or four stages ({@link stageColumns}).
 * - `butterfly`: candidates hold a pair of opposing amounts ({@link opposedColumns}).
 * - `bullet`: a column of targets beside the measure held to them ({@link findTarget}).
 * - `ladder`: most of the table is quantiles of one measurement, rising by rank ({@link tableLadders}).
 * - `histogram`: the rows are ordered bins and every candidate counts them ({@link histogramColumns}).
 * - `stat`: the local guess found two conditions compared on a few metrics; a pick draws the guess's.
 */
const KIND_GATES: Partial<
	Record<KindChoice, (table: TableAnalysis, guess: ChartPlan, candidates: readonly TableColumn[]) => boolean>
> = {
	timeline: (_, guess) => guess.kind === "timeline",
	waterfall: (_, guess) => guess.kind === "waterfall",
	range: (table, _, candidates) => rangeColumns(candidates, table.rows) !== undefined,
	dots: (table, _, candidates) =>
		[
			...Map.groupBy(candidates, column =>
				column.dim === "currency" || column.dim === "rate" ? `${column.dim}:${column.unit}` : `${column.dim}`,
			).values(),
		].some(columns => dotsFit(columns, table.rows)),
	slope: (table, _, candidates) => stageColumns(candidates, table.rows) !== undefined,
	butterfly: (_, __, candidates) => opposedColumns(candidates) !== undefined,
	bullet: table => findTarget(table) !== undefined,
	ladder: (table, guess) => tableLadders(table, guess.label) !== undefined,
	histogram: (table, _, candidates) => histogramColumns(table, candidates) !== undefined,
	stat: (_, guess) => guess.kind === "stat",
};

/**
 * The columns holding one quantity before and after (or across stages) whose
 * direction the `move` question asks: the guess's slope stages, its dumbbell
 * pair when the headers give it a direction ({@link isTransition}), its one
 * column of `a → b` cells, or stages among the candidates a judge may plot as
 * a slope. `undefined` when the table holds no such move.
 */
function moveColumns(table: TableAnalysis, guess: ChartPlan): TableColumn[] | undefined {
	const plotted = guess.series.map(index => table.columns[index]!);
	const [first, second] = plotted;
	if (guess.kind === "slope") return plotted;
	if (
		guess.kind === "paired" &&
		first &&
		(second ? isTransition(first.header, second.header) : first.arrowShare >= 0.6)
	)
		return plotted.slice(0, 2);
	return stageColumns(
		table.measures.filter(column => column.index !== guess.label),
		table.rows,
	);
}

/** The kind options for a table: every kind {@link KIND_GATES} lets through, in the kind question's order. */
function kindCriteria(
	table: TableAnalysis,
	guess: ChartPlan,
	candidates: readonly TableColumn[],
): Record<string, string | null> {
	const all = QUESTIONS.kind.criteria;
	const offered: Record<string, string | null> = {};
	for (const kind in all) {
		if (isOption(all, kind) && (KIND_GATES[kind]?.(table, guess, candidates) ?? true)) offered[kind] = all[kind];
	}
	return offered;
}

/**
 * The first two same-unit candidates, which a dumbbell would pair, when only the
 * judge can tell whether they are one quantity under two conditions: none when
 * the values show a composition, the headers already name a pair, or metric
 * pairs (`Baseline Turns | Iter1 Turns | …`) decide the chart.
 */
function pairCandidates(
	table: TableAnalysis,
	guess: ChartPlan,
	candidates: readonly TableColumn[],
): [TableColumn, TableColumn] | undefined {
	if (table.composition?.exact || guess.baselines) return undefined;
	for (const [at, first] of candidates.entries()) {
		const second = candidates.slice(at + 1).find(column => column.dim === first.dim && column.unit === first.unit);
		if (!second || first.arrowShare >= 0.6 || second.arrowShare >= 0.6) continue;
		return isConditionPair(first.header, second.header) ? undefined : [first, second];
	}
	return undefined;
}

/**
 * The columns the label question offers, keyed by option name (the header, or
 * `column N` when blank or repeated): text and date columns, and measures
 * before the guessed label. Empty when there is no choice to make.
 */
function labelOptions(table: TableAnalysis, guess: ChartPlan): Map<string, TableColumn> {
	const columns = [
		...leadingMeasures(table, guess),
		...table.columns.filter(column => column.role === "label" || column.role === "temporal"),
	].sort((a, b) => a.index - b.index);
	const options = new Map<string, TableColumn>();
	if (columns.length < 2) return options;
	for (const column of columns) {
		const name = column.header && !options.has(column.header) ? column.header : `column ${column.index + 1}`;
		options.set(name, column);
	}
	return options;
}

/**
 * The judge request for `request`: the table and its column types as state,
 * and at most {@link MAX_QUESTIONS} questions keyed by id — each asked only
 * where its answer can change the chart.
 */
export function judgeRequest(request: TableChartRequest): { state: JudgmentState; questions: Questions } {
	const { table, guess } = request;
	const candidates = table.measures.filter(column => column.index !== guess.label);
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	const namers = label ? namingColumns(table, label) : [];
	const questions: Questions = { kind: kindQuestion(request), transpose: QUESTIONS.transpose };
	if (heatCapable(table, guess, candidates)) questions.shading = QUESTIONS.shading;
	const lead = rankable(table, guess);
	if (lead) questions.order = renderQuestion(QUESTIONS.order, { column: lead.header });
	const reference = referenceCandidates(table, guess);
	if (reference) {
		const { column, values, repeats } = reference;
		const question = renderQuestion(QUESTIONS.reference, { column: column.header, repeats });
		const rows = Object.fromEntries(values.map(value => [value, null]));
		questions.reference = { ...question, criteria: { ...rows, ...question.criteria } };
	}
	const options = labelOptions(table, guess);
	if (options.size)
		questions.label = {
			...QUESTIONS.label,
			criteria: Object.fromEntries([...options.keys()].map(name => [name, null])),
		};
	const pair = pairCandidates(table, guess, candidates);
	if (pair) questions.pair = renderQuestion(QUESTIONS.pair, { first: pair[0].header, second: pair[1].header });
	for (const column of candidates)
		questions[`c${column.index}`] = renderQuestion(QUESTIONS.column, { column: column.header });
	const groupers = label && namers.length ? [label, ...namers] : [];
	for (const column of namers)
		questions[`n${column.index}`] = renderQuestion(QUESTIONS.name, { column: column.header, label: label?.header });
	for (const column of groupers)
		questions[`g${column.index}`] = renderQuestion(QUESTIONS.group, { column: column.header });
	for (const [id, question] of semanticQuestions(request)) {
		if (Object.keys(questions).length >= MAX_QUESTIONS) break;
		questions[id] = question;
	}
	const state = {
		table: request.markdown.slice(0, MAX_TABLE_CHARS),
		columns: table.columns.map(column => ({ name: column.header, type: columnType(column) })),
	};
	return { state, questions };
}

/**
 * What the table means, as questions in {@link SEMANTIC_PRIORITY} order, each
 * asked only where its answer can change the chart: the title among the
 * table's {@link tableTakeaways}; what competes and the focus row with
 * {@link MIN_CONTEST_ROWS} rows or more; the polarity of the plotted
 * measures; the polarity of each metric row ({@link rowsAreMetrics}).
 */
function semanticQuestions({ table, guess }: TableChartRequest): [string, Questions[string]][] {
	const asked: [string, Questions[string]][] = [];
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	for (const kind of SEMANTIC_PRIORITY) {
		if (kind === "title") {
			const facts = tableTakeaways(table, guess, CONTESTS, "table");
			if (facts.length === 0) continue;
			const criteria: Record<string, string | null> = {};
			for (const fact of facts) criteria[fact.key] = fact.text;
			asked.push(["title", { ...QUESTIONS.title, criteria: { ...criteria, ...QUESTIONS.title.criteria } }]);
		} else if (kind === "move") {
			const columns = moveColumns(table, guess);
			if (columns)
				asked.push([
					"move",
					renderQuestion(QUESTIONS.move, {
						columns: columns.map(column => column.header),
						arrow: columns.length === 1,
					}),
				]);
		} else if (kind === "rivals") {
			if (table.rows.length < MIN_CONTEST_ROWS) continue;
			asked.push(["rivals", QUESTIONS.rivals]);
		} else if (kind === "p") {
			// The columns the chart may plot: the guess's series first, then the other candidates the judge may pick.
			const plotted = [
				...guess.series.map(index => table.columns[index]!),
				...table.measures.filter(column => column.index !== guess.label && !guess.series.includes(column.index)),
			].filter(column => column.role === "measure");
			for (const column of plotted.slice(0, MAX_POLARITY_QUESTIONS))
				asked.push([`p${column.index}`, renderQuestion(QUESTIONS.polarity, { column: column.header })]);
		} else if (kind === "focus") {
			const names = rowNames(table, guess);
			if (names.size < MIN_CONTEST_ROWS || names.size > MAX_FOCUS_ROWS) continue;
			const criteria: Record<string, string | null> = {};
			for (const name of names.keys()) criteria[name] = null;
			asked.push(["focus", { ...QUESTIONS.focus, criteria: { ...criteria, ...QUESTIONS.focus.criteria } }]);
		} else if (label && rowsAreMetrics(table, guess)) {
			// Metric rows share the measures' polarity labels; rows past the question budget keep the unit's guess.
			for (const row of table.rows) {
				const question = renderQuestion(QUESTIONS.rowPolarity, { row: label.cells[row]!.text });
				asked.push([`q${row}`, { ...question, criteria: QUESTIONS.polarity.criteria }]);
			}
		}
	}
	return asked;
}

/** Each data row's name as the chart writes it (label and qualifiers), made unique; none without a label. */
function rowNames(table: TableAnalysis, plan: ChartPlan): Map<string, number> {
	const names = new Map<string, number>();
	if (plan.label === undefined) return names;
	const namers = [plan.label, ...(plan.qualifiers ?? [])].map(index => table.columns[index]!);
	for (const row of table.rows) {
		const base =
			namers
				.map(column => column.cells[row]!.text)
				.filter(Boolean)
				.join(" · ") || `row ${row + 1}`;
		let name = base;
		for (let n = 2; names.has(name) || name === NONE; n++) name = `${base} (${n})`;
		names.set(name, row);
	}
	return names;
}

/**
 * `plan` with what the judge says the table means, each answer only at its
 * confidence gate, else the local guess for `plan` ({@link guessMeaning}):
 * polarity per measure and metric row, what competes, the focus row, and the
 * title — the judge's pick among the takeaways it was offered, reworded under
 * the judged polarities, or the local striking fact.
 */
function judgedMeaning(
	request: TableChartRequest,
	answers: Readonly<Record<string, Answer>>,
	plan: ChartPlan,
): ChartPlan {
	const { table, guess } = request;
	const local = guessMeaning(table, plan);
	const polarity: Record<number, Polarity> = { ...local.polarity };
	for (const index of plan.series) {
		const answer = sureChoice(answers[`p${index}`], SURE_POLARITY, QUESTIONS.polarity.criteria);
		if (answer === "neutral") delete polarity[index];
		else if (answer) polarity[index] = answer;
	}
	// The move's direction tones each stage it was asked about that the plan still plots.
	const move = sureChoice(answers.move, SURE_POLARITY, QUESTIONS.move.criteria);
	for (const column of move ? (moveColumns(table, guess) ?? []) : []) {
		if (!plan.series.includes(column.index)) continue;
		if (move === "neutral") delete polarity[column.index];
		else if (move) polarity[column.index] = move;
	}
	const rowPolarity: Record<number, Polarity> = { ...local.rowPolarity };
	for (const row of table.rows) {
		const answer = sureChoice(answers[`q${row}`], SURE_POLARITY, QUESTIONS.polarity.criteria);
		if (answer === "neutral") delete rowPolarity[row];
		else if (answer) rowPolarity[row] = answer;
	}
	// Best marks claim a contest: only one the judge is sure of overrides the label-header guess.
	const contest = sureChoice(answers.rivals, SURE_RIVALS, QUESTIONS.rivals.criteria);
	const rivals = contest === undefined ? local.rivals : contest === "neither" ? undefined : contest;
	// A focus row the judge is sure of, or one the table singles out too.
	const said = answers.focus;
	let focus = local.focus;
	if (said?.type === "choice") {
		const row = said.choice === NONE ? undefined : rowNames(table, guess).get(said.choice);
		const odds = said.probabilities[said.choice] ?? 0;
		const agreed = row !== undefined && (local.focus ?? []).includes(row);
		focus = row !== undefined && (odds >= SURE_FOCUS || (agreed && odds >= AGREED_FOCUS)) ? [row] : [];
	}
	const meant: ChartPlan = { ...plan, ...local, polarity, rowPolarity, rivals, focus };
	// The title: a takeaway the judge is sure of (a plain one needs more), else the local striking fact.
	const facts = tableTakeaways(table, meant);
	let key = facts.find(fact => fact.striking)?.key;
	const pick = answers.title;
	// What the judged plan's chart can state: its own facts, and the guess's chart's where the judged chart
	// draws every column the guess's does. The judge was offered more (measures side by side, {@link
	// tableTakeaways}' `table` scope); a pick about a column the final chart leaves out titles nothing.
	const drawable = tableTakeaways(table, meant, CONTESTS);
	const shown = (chosen: ChartPlan) => {
		const spec = buildChart(table, chosen);
		return spec ? drawnNames(spec) : new Set<string>();
	};
	const meantNames = shown(meant);
	const borrowed =
		pick?.type === "choice" && [...shown(guess)].every(name => meantNames.has(name))
			? tableTakeaways(table, guess, CONTESTS)
			: [];
	const statable = [...drawable, ...borrowed];
	const offered =
		pick?.type === "choice"
			? tableTakeaways(table, guess, CONTESTS, "table").filter(fact =>
					statable.some(other => other.key === fact.key),
				)
			: [];
	if (pick?.type === "choice") {
		const fact = offered.find(fact => fact.key === pick.choice);
		const odds = pick.probabilities[pick.choice] ?? 0;
		// Unsure, the judge still ranks the striking facts: its likeliest one beats the local order's first
		// (and no title, where it leans that way more).
		const chance = (option: string | undefined) => (option === undefined ? 0 : (pick.probabilities[option] ?? 0));
		const ranked = offered.filter(fact => fact.striking).sort((a, b) => chance(b.key) - chance(a.key))[0];
		if (fact && odds >= (fact.striking ? SURE_TITLE : SURE_PLAIN_TITLE)) key = fact.key;
		else if (pick.choice === NONE && odds >= SURE_TITLE) key = undefined;
		else if (ranked && chance(ranked.key) >= RANKED_TITLE && chance(ranked.key) > Math.max(chance(key), chance(NONE)))
			key = ranked.key;
	}
	// Worded with the judged polarities (`improved`, not `fell`) where the fact still holds under them, and over
	// the drawn measures only (`best on recall and prec`, not the offered `… and cost`).
	const restated = (fact: { key: string }) => fact.key === key;
	const title = key === undefined ? undefined : (facts.find(restated) ?? statable.find(restated))?.text;
	return { ...meant, title };
}

/** `answer`'s choice when it is one of `criteria`'s options and the judge gave it `gate` or more; else `undefined`. */
function sureChoice<L extends string>(
	answer: Answer | undefined,
	gate: number,
	criteria: Record<L, unknown>,
): L | undefined {
	if (answer?.type !== "choice" || (answer.probabilities[answer.choice] ?? 0) < gate) return undefined;
	return isOption(criteria, answer.choice) ? answer.choice : undefined;
}

/**
 * The plan the judge's `answers` make for `request`, or `null` for no chart.
 * A missing or unsure answer keeps the local guess's part of the plan.
 */
export function planFromAnswers(
	request: TableChartRequest,
	answers: Readonly<Record<string, Answer>>,
): ChartPlan | null {
	const { table, guess } = request;
	const noul = (id: string) => {
		const answer = answers[id];
		return answer?.type === "noul" ? answer.noul : 0;
	};
	const kind = answers.kind;
	let choice: KindChoice =
		kind?.type === "choice" && isOption(QUESTIONS.kind.criteria, kind.choice) ? kind.choice : guess.kind;
	if (choice === "none") return null;
	// A share bar holds few parts: past them the local guess draws the parts (a waterfall to their total, or bars).
	if (choice === "share" && table.rows.length > MAX_SHARE_SEGMENTS) choice = guess.kind;
	const picks = answers.label;
	const named = picks?.type === "choice" ? labelOptions(table, guess).get(picks.choice) : undefined;
	const label = named ?? (guess.label === undefined ? undefined : table.columns[guess.label]);
	// A number picked as the label names its rows and leaves the plot.
	const candidates = table.measures.filter(column => column !== label);
	const picked = candidates.filter(column => noul(`c${column.index}`) >= 0.5);
	let series: readonly number[] = picked.length
		? picked.map(column => column.index)
		: guess.series.filter(index => index !== label?.index);
	// A scatter of `a–b` cells would plot only each interval's low end: they draw as intervals.
	if (
		choice === "scatter" &&
		rangeColumns(
			series.map(index => table.columns[index]!),
			table.rows,
		)
	)
		choice = "range";
	// Intervals are the chart: a `range` pick plots every interval column, whatever the column answers dropped.
	const spans = choice === "range" ? rangeColumns(candidates, table.rows) : undefined;
	if (spans) series = [...new Set([...spans.map(column => column.index), ...series])].sort((a, b) => a - b);
	// A slope runs through the stages, a butterfly sets its opposing pair back to back: whatever the column answers kept.
	const drawn =
		choice === "slope"
			? stageColumns(candidates, table.rows)
			: choice === "butterfly"
				? opposedColumns(candidates)
				: undefined;
	if (drawn) series = drawn.map(column => column.index);
	// Quantiles are the chart: a table mostly of them draws its ladders whatever per-row comparison the
	// judge picks (a dumbbell or bars of each quantile apart hide each row's spread), every quantile column.
	const ladders = LADDERABLE.has(choice) ? tableLadders(table, label?.index) : undefined;
	if (ladders) {
		choice = "ladder";
		series = ladderColumns(ladders);
	}
	// Counts over ordered bins are a distribution whatever per-row comparison the judge picks (a dumbbell
	// of two shares per bin hides each one's shape); a `histogram` plots every count, in bin order.
	const histogram = BINNABLE.has(choice) ? histogramColumns(table, candidates) : undefined;
	if (histogram) {
		choice = "histogram";
		series = histogram.counts.map(column => column.index);
	}
	if (
		series.length === 0 ||
		proseLed(
			table,
			series.map(index => table.columns[index]!),
		)
	)
		return null;
	let whole: number | undefined;
	// Parts of a whole: an exact sum the values show stacks whatever per-row kind the judge picks;
	// parts within a total, or columns only the judge reads as parts, stack when it picks `stacked`.
	const composition = table.composition;
	if (
		composition &&
		STACKABLE.has(choice) &&
		(composition.exact || choice === "stacked") &&
		!composition.parts.includes(label?.index ?? -1)
	) {
		choice = "stacked";
		series = composition.parts;
		whole = composition.whole;
	} else if (choice === "stacked") {
		const stack = stackable(table, series);
		if (stack.length >= 2) series = stack.map(column => column.index);
		else choice = guess.kind;
	}
	// Outcome counts (`ok | fail`) are each row's mix, whatever per-row comparison the judge picks.
	const outcomes = STACKABLE.has(choice) ? outcomeColumns(series.map(index => table.columns[index]!)) : undefined;
	if (outcomes) {
		choice = "stacked";
		series = outcomes.map(column => column.index);
	}
	// Metric pairs (`Baseline Turns | Iter1 Turns | Baseline Tokens In | …`): the headers decide;
	// any per-row comparison the judge picks draws as each pair's factor.
	let baselines: readonly number[] | undefined;
	if (guess.baselines && (STACKABLE.has(choice) || choice === "change")) {
		choice = "change";
		series = guess.series;
		baselines = guess.baselines;
	}
	// A dumbbell only for one quantity under two conditions (the headers say so, or the judge
	// confirms); otherwise two series stand side by side.
	const [first, second] = series.map(index => table.columns[index]!);
	const asked = pairCandidates(table, guess, candidates);
	const pairs =
		first !== undefined &&
		second !== undefined &&
		(isConditionPair(first.header, second.header) ||
			(asked?.[0] === first && asked[1] === second && noul("pair") >= 0.5));
	if (choice === "paired" && series.length === 2 && !pairs) choice = "grouped";
	// Factors of change need a baseline column (or `a → b` cells); two unrelated metrics stay values.
	const arrows = series.filter(index => table.columns[index]!.arrowShare >= 0.6).length;
	if (choice === "change" && !baselines && series.length >= 2 && arrows < 2 && !pairs)
		choice = guess.kind === "change" ? "grouped" : guess.kind;
	// Rows held to targets (offered only where a target column is found) draw its measure against them.
	const held = choice === "bullet" ? findTarget(table) : undefined;
	if (held) series = [held.measured.index];
	else if (choice === "bullet") choice = guess.kind;
	// A run of steps (offered only where the guess is one) draws the guess's column, offsets and cap.
	let offsets: number | undefined;
	let limit: number | undefined;
	if (FLOWS.has(choice)) {
		if (choice === guess.kind) {
			series = guess.series;
			({ offsets, limit } = guess);
		} else choice = guess.kind;
	}
	// A comparison (offered only where the guess is one) draws the guess's conditions and metrics.
	if (choice === "stat") series = guess.series;
	// Qualifiers the judge accepts, kept only as far as they tell rows apart; the group
	// is one of the naming columns. Another label than the guess's is named locally.
	let naming: { qualifiers: readonly number[]; group: number | undefined } = { qualifiers: [], group: undefined };
	// A histogram's bins name its columns, whatever label the judge picked.
	const bins = histogram?.bins ?? label;
	if (bins && bins.index !== guess.label) naming = guessNaming(table, bins);
	else if (label && !histogram) {
		const accepted = namingColumns(table, label).filter(column => noul(`n${column.index}`) >= 0.5);
		const { qualifiers } = guessNaming(table, label, accepted);
		let group: number | undefined;
		let odds = 0;
		for (const index of qualifiers.length ? [label.index, ...qualifiers] : []) {
			const yes = noul(`g${index}`);
			if (yes >= 0.5 && yes > odds) {
				group = index;
				odds = yes;
			}
		}
		naming = { qualifiers, group };
	}
	return judgedMeaning(request, answers, {
		kind: choice,
		label: bins?.index,
		qualifiers: naming.qualifiers,
		group: naming.group,
		series: choice === "scatter" ? series.slice(0, 2) : series,
		transpose:
			choice === "stat"
				? guess.transpose
				: choice !== "change" &&
					choice !== "stacked" &&
					choice !== "bullet" &&
					!FLOWS.has(choice) &&
					noul("transpose") >= 0.5 &&
					candidates.some(column => column.mixed),
		shading:
			sureChoice(answers.shading, SHADING_CONFIDENCE, QUESTIONS.shading.criteria) ??
			(guess.kind === "heatmap"
				? guess.shading
				: guessShading(
						series.map(index => table.columns[index]!),
						table.rows,
					)),
		reference: judgedReference(request, answers.reference),
		order: judgedOrder(request, answers.order, choice, series),
		whole,
		baselines,
		offsets,
		limit,
		target: held?.target.index,
	});
}

/**
 * Whether the table can draw as a heatmap — the guess is one, or it holds
 * {@link MIN_HEAT_COLUMNS} same-unit candidates — so the shading answer can
 * change the chart; an exact composition always stacks instead.
 */
function heatCapable(table: TableAnalysis, guess: ChartPlan, candidates: readonly TableColumn[]): boolean {
	if (table.composition?.exact) return false;
	if (guess.kind === "heatmap") return true;
	const sizes = new Map<string, number>();
	for (const column of candidates) {
		const key = `${column.dim}:${column.unit}`;
		sizes.set(key, (sizes.get(key) ?? 0) + 1);
	}
	return Math.max(0, ...sizes.values()) >= MIN_HEAT_COLUMNS;
}

/**
 * The column the order question ranks by — the guess's lead series — when a
 * ranking can change the chart: rows named by text, at least
 * {@link MIN_RANKED_ROWS} of them, a kind that lists rows down a label column,
 * and values not already sorted (an already ranked table keeps its order).
 */
function rankable(table: TableAnalysis, guess: ChartPlan): TableColumn | undefined {
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	const lead = table.columns[guess.series[0] ?? -1];
	if (!lead || label?.role !== "label" || OWN_FRAME.has(guess.kind) || guess.transpose || guess.baselines)
		return undefined;
	if (table.rows.length < MIN_RANKED_ROWS) return undefined;
	const values = table.rows.flatMap(row => {
		const cell = lead.cells[row];
		return isNumber(cell) ? [cell.value] : [];
	});
	return isMonotonic(values) ? undefined : lead;
}

/** The judge's ranking at {@link RANK_CONFIDENCE} or more, by the column it named while that is plotted; else none. */
function judgedOrder(
	request: TableChartRequest,
	answer: Answer | undefined,
	choice: KindChoice,
	series: readonly number[],
): RowOrder | undefined {
	const direction = sureChoice(answer, RANK_CONFIDENCE, QUESTIONS.order.criteria);
	if (direction === undefined || direction === "table" || OWN_FRAME.has(choice)) return undefined;
	const lead = request.guess.series[0];
	const column = lead !== undefined && series.includes(lead) ? lead : series[0];
	return column === undefined ? undefined : { column, direction };
}

/**
 * The naming column whose values the reference question offers: the one the
 * local guess found a reference in, else the innermost qualifier, else the
 * label; `undefined` when the chart could draw no reference rule or the
 * column holds too many or too long distinct values.
 */
function referenceCandidates(
	table: TableAnalysis,
	guess: ChartPlan,
): { column: TableColumn; values: string[]; repeats: boolean } | undefined {
	if (!REFERENCED.has(guess.kind) || guess.baselines || table.composition?.exact) return undefined;
	const index = guess.reference?.column ?? guess.qualifiers?.at(-1) ?? guess.label;
	const column = index === undefined ? undefined : table.columns[index];
	if (!column || column.role !== "label") return undefined;
	const cells = table.rows.map(row => column.cells[row]!).filter(cell => cell.kind !== "missing");
	const values = [...new Set(cells.map(cell => cell.text))];
	if (values.length < 2 || values.length > MAX_REFERENCE_CHOICES) return undefined;
	if (values.some(value => value.length > MAX_REFERENCE_CHARS || value === "none")) return undefined;
	return { column, values, repeats: values.length < cells.length };
}

/** The judge's reference row at {@link REFERENCE_CONFIDENCE} or more (`none` clears the guess); else the guess's. */
function judgedReference(request: TableChartRequest, answer: Answer | undefined): ChartPlan["reference"] {
	const { guess } = request;
	if (answer?.type !== "choice" || (answer.probabilities[answer.choice] ?? 0) < REFERENCE_CONFIDENCE)
		return guess.reference;
	if (answer.choice === "none") return undefined;
	const index = referenceCandidates(request.table, guess)?.column.index;
	return index === undefined ? guess.reference : { column: index, value: answer.choice };
}

/** A column's inferred type as the judge reads it: `number (duration)`, `text`, `row index`, … */
function columnType(column: TableColumn): string {
	switch (column.role) {
		case "measure":
			if (column.mixed) return "number (mixed units)";
			return column.scores ? "number (score out of a total)" : `number (${column.dim ?? "count"})`;
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
