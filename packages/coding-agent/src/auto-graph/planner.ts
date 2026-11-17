/**
 * Model-picked charts for assistant tables (`tui.autoGraph: smart`), in two
 * rounds with the judge role. {@link readingQuestions} first asks what only
 * meaning can decide about the table itself: which column names the rows,
 * which numbers are results worth plotting and which of them leads, how rows
 * group, order and compare (shading, reference row, ranking), which way each
 * measure is better, what competes and the focus row. {@link candidateCharts}
 * then builds every chart the table's data can draw under that reading — each
 * chart kind over the columns that kind compares, and the local guess — and
 * {@link chartQuestions} has the judge choose among them, each described as
 * exactly what it would draw (`Factors of change: … than "Median"`), along
 * with the computed takeaway that titles it ({@link chosenChart}).
 *
 * The judge so weighs whole charts rather than a kind and its columns apart:
 * a kind and columns that make no sense together read as nonsense in the
 * description of what they draw, and lose to a chart comparing like with
 * like. An on-device judge answers the second round alone, over the charts of
 * the local reading.
 */
import {
	type Answer,
	type JudgmentState,
	judgeQuestions,
	type Question,
	type Questions,
	renderQuestion,
} from "@oh-my-pi/pi-ai";
import {
	buildChart,
	type ChartKind,
	type ChartPlan,
	type ChartSpec,
	dotsFit,
	findTarget,
	guessMeaning,
	guessNaming,
	guessShading,
	histogramColumns,
	isConditionPair,
	isTransition,
	ladderColumns,
	leadingMeasures,
	MAX_LINES,
	MAX_PANELS,
	namingColumns,
	opposedColumns,
	outcomeColumns,
	type Polarity,
	planChart,
	proseLed,
	type Rivals,
	type RowOrder,
	rangeColumns,
	rowsAreMetrics,
	stageColumns,
	type Takeaway,
	tableLadders,
	tableTakeaways,
} from "@oh-my-pi/pi-tui/charts/chart-plan";
import {
	isMonotonic,
	isNumber,
	type TableAnalysis,
	type TableColumn,
	withMeasures,
} from "@oh-my-pi/pi-tui/charts/table-data";
import type { TableChartRequest } from "@oh-my-pi/pi-tui/chat/table-chart";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ChainJudge } from "../judgment";
import questionFile from "../prompts/judge/auto-graph.json" with { type: "json" };

/**
 * The planner's judge questions; their templates are rendered per table. The
 * `chart` question's criteria are templates too, one per chart kind: what a
 * chart of that kind draws, filled from a candidate's {@link ChartSpec}
 * ({@link describeChart}).
 */
const QUESTIONS = judgeQuestions(questionFile);

/** A judge's answers, keyed by question id. */
type Answers = Readonly<Record<string, Answer>>;

/** A pick slower than this gives way to the local guess, so the answer's chart never waits on a stuck judge. */
const PICK_TIMEOUT_MS = 15_000;

/**
 * A chart the table's data can draw, which the judge chooses among
 * ({@link chartQuestions}).
 */
export interface ChartCandidate {
	/** The chart's plan under the judged meaning, without its title. */
	readonly plan: ChartPlan;
	/** What the chart draws, as the judge reads it: the `chart` option's rubric. */
	readonly description: string;
	/**
	 * Facts the chart could state as its title, strongest first; the judge picks one with the chart.
	 * They hold either contest's outcome (the best row of a column, the best column of a row), whatever
	 * the judge answered on what competes — columns only where they are one quantity.
	 */
	readonly takeaways: readonly Takeaway[];
	/** The takeaway titling the chart unprompted: the first striking one under the plan's own contest. */
	readonly headline: Takeaway | undefined;
}

/**
 * The judge's chart for `request`, or `null` when it sees none.
 * @throws when no judge candidate answers (the caller falls back to the guess).
 */
export async function pickTableChart(request: TableChartRequest, judge: ChainJudge): Promise<ChartPlan | null> {
	const options = { signal: AbortSignal.timeout(PICK_TIMEOUT_MS) };
	// Every question reads the table and its column types.
	const state: JudgmentState = {
		table: request.markdown.slice(0, MAX_TABLE_CHARS),
		columns: request.table.columns.map(column => ({ name: column.header, type: columnType(column) })),
	};
	return judge.withCandidate(async (candidate, kind) => {
		const ask = async (questions: Questions): Promise<Answers> =>
			(await candidate.judge({ state, questions }, options)).answers;
		// Keyword answers carry one pick: an on-device judge chooses among the charts of the local reading.
		const reading = kind === "local" ? {} : await ask(readingQuestions(request));
		const charts = candidateCharts(request, reading);
		if (charts.length === 0) return null;
		return chosenChart(charts, await ask(chartQuestions(charts, kind === "local" ? "chart" : "titled")), reading);
	}, options);
}

/** Whether `value` is one of `criteria`'s option labels. */
function isOption<L extends string>(criteria: Record<L, unknown>, value: string): value is L {
	return Object.hasOwn(criteria, value);
}

/** An option of the `chart` question: a chart kind's template, or `none`. */
type ChartOption = keyof typeof QUESTIONS.chart.criteria;

/** Whether a `chart` option is a kind's template. */
function isKind(option: ChartOption): option is ChartKind {
	return option !== NONE;
}

/**
 * Probability a shading pick needs to override the local guess: a hesitant
 * `series` would trade a heatmap of one measure for bars (t055 scores at 0.66).
 */
const SHADING_CONFIDENCE = 0.7;
/** Fewest same-unit columns that can draw as a heatmap, whose shading the judge then picks. */
const MIN_HEAT_COLUMNS = 4;
/** Fewest same-unit results a heatmap candidate grids; fewer compare better as bars. */
const MIN_GRID_COLUMNS = 3;
/** Fewest rows a ranking can reorder usefully. */
const MIN_RANKED_ROWS = 4;
/** Probability a ranking needs to override the table's order: a coin flip keeps the order the author chose. */
const RANK_CONFIDENCE = 0.6;
/** Probability the judge's reference pick (or `none`) needs to override the local guess. */
const REFERENCE_CONFIDENCE = 0.8;
/**
 * Probability that rows are metrics of their own from which charts setting them on one axis are ruled
 * out; from an even chance, each row may take a panel of its own.
 */
const SURE_METRICS = 0.8;
/**
 * Probability that same-unit columns are one quantity under several conditions which setting them
 * against each other pairwise needs (a dumbbell, factors of a baseline column, a slope); an even
 * chance where their headers name a before and its after besides.
 */
const SURE_CONDITIONS = 0.7;
/** Probability of that below which the columns are different quantities, which share no axis at all. */
const UNLIKE_QUANTITIES = 0.3;
/** Lead the judge's likeliest chart needs over the first candidate (the table's own structure) to be drawn instead. */
const PICK_MARGIN = 0.02;
/** Probability a chart helps below which the judge's first round already turns the table down. */
const MIN_WORTH = 0.3;
/** Probability a chart helps from which the first round overrules a second-round `none`: the likeliest chart is drawn. */
const SURE_WORTH = 0.6;
/** Most groups of same-unit measures asked whether they are one quantity under several conditions. */
const MAX_CONDITION_GROUPS = 2;
/** Both readings of what competes: a title may state either's outcome, whatever the judge answers on rivals. */
const CONTESTS: readonly Rivals[] = ["rows", "columns"];
/** The one contest a title may state where the columns are different quantities: no column is best of a row. */
const ROW_CONTEST: readonly Rivals[] = ["rows"];
/** Most rows a transposed small-multiples candidate gives a panel each. */
const MAX_PANEL_ROWS = 12;
/** Most distinct naming values offered as reference rows. */
const MAX_REFERENCE_CHOICES = 8;
/** Longest naming value offered as a reference row; longer cells describe rather than name. */
const MAX_REFERENCE_CHARS = 48;
/** Kinds that keep a row order of their own (an x axis, factors in table order, parts of a whole). */
const OWN_FRAME: Partial<Record<ChartKind, true>> = {
	line: true,
	scatter: true,
	change: true,
	stacked: true,
	timeline: true,
	waterfall: true,
	slope: true,
	bullet: true,
	histogram: true,
};
/** Guessed kinds whose chart draws reference rules: bars, and grids of bars (a series-shaded heatmap becomes one). */
const REFERENCED: Partial<Record<ChartKind, true>> = { bar: true, multiples: true, heatmap: true };
const MAX_TABLE_CHARS = 4000;
/** Most questions the first round asks; earlier groups' questions come first, meaning's fill the rest ({@link MEANING_PRIORITY}). */
const MAX_QUESTIONS = 40;
/** Most charts the judge chooses among; the kinds' order in the `chart` question decides which. */
const MAX_CANDIDATES = 10;
/** Most category and series names a chart's description spells out; the rest are counted. */
const MAX_DESCRIBED = 8;
/** The option meaning no chart, no main result, no focus row, or no title. */
const NONE = "none";
/** Option labels of the candidate charts, in order. */
const CANDIDATE_KEYS = "ABCDEFGHIJ";
/** Most measures asked for their polarity (the guess's series first, then other candidates); later ones keep the unit's guess. */
const MAX_POLARITY_QUESTIONS = 8;
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
 * Order in which meaning's questions fill what {@link MAX_QUESTIONS} leaves:
 * what competes (gates every best mark), the polarity of a before/after move
 * (it tones every row of a dumbbell or slope, whose condition headers —
 * `Baseline | Iter130` — leave the per-column questions without a measure to
 * judge), the measures' polarity (best marks and tones), the focus row, and
 * the metric rows' polarity (factor tones the units mostly decide already).
 */
const MEANING_PRIORITY = ["rivals", "move", "p", "focus", "q"] as const;
/**
 * Kinds comparing each row's values apart, which a table mostly of quantiles draws better as ladders;
 * small multiples (other measures beside them) stand.
 */
const LADDERABLE: Partial<Record<ChartKind, true>> = {
	bar: true,
	paired: true,
	grouped: true,
	dots: true,
	heatmap: true,
	change: true,
	range: true,
	ladder: true,
};
/** Kinds that compare rows one by one, which counts over ordered bins draw better as a histogram. */
const BINNABLE: Partial<Record<ChartKind, true>> = {
	bar: true,
	paired: true,
	grouped: true,
	line: true,
	dots: true,
	histogram: true,
};

/** Whether one axis can hold both columns: one dimension and unit, or rows of mixed units in both (each row its own metric). */
function sameUnit(a: TableColumn, b: TableColumn): boolean {
	return a.mixed || b.mixed ? a.mixed && b.mixed : a.dim === b.dim && a.unit === b.unit;
}

/**
 * The columns holding one quantity before and after (or across stages) whose
 * direction the `move` question asks: the guess's slope stages, its dumbbell
 * pair when the headers give it a direction ({@link isTransition}), its one
 * column of `a → b` cells, or stages among the measures a slope candidate
 * runs through. `undefined` when the table holds no such move.
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

/**
 * `columns` keyed by option name: the header, or `column N` when blank,
 * repeated, or reading as the `none` option.
 */
function optionNames(columns: readonly TableColumn[]): Map<string, TableColumn> {
	const options = new Map<string, TableColumn>();
	for (const column of columns) {
		const plain = column.header && column.header !== NONE && !options.has(column.header);
		options.set(plain ? column.header : `column ${column.index + 1}`, column);
	}
	return options;
}

/**
 * The columns the label question offers ({@link optionNames}): text and date
 * columns, and measures before the guessed label. Empty when there is no
 * choice to make.
 */
function labelOptions(table: TableAnalysis, guess: ChartPlan): Map<string, TableColumn> {
	const columns = [
		...leadingMeasures(table, guess),
		...table.columns.filter(column => column.role === "label" || column.role === "temporal"),
	].sort((a, b) => a.index - b.index);
	return columns.length < 2 ? new Map() : optionNames(columns);
}

/** `names` as criteria whose labels need no rubric. */
function bare(names: Iterable<string>): Record<string, null> {
	const criteria: Record<string, null> = {};
	for (const name of names) criteria[name] = null;
	return criteria;
}

/**
 * The first round's questions for `request`, at most {@link MAX_QUESTIONS},
 * keyed by id and each asked only where its answer can change a chart:
 * whether a chart helps at all, the label, the results to plot (`c<column>`),
 * whether rows are metrics of their own and whether same-unit columns are one
 * quantity under several conditions (`k<first column>` per group,
 * {@link axisGroups}), the naming columns (`n<column>`) and grouping
 * (`g<column>`), shading, ranking and reference row, then what the table
 * means ({@link meaningQuestions}).
 */
export function readingQuestions(request: TableChartRequest): Questions {
	const { table, guess } = request;
	const measures = table.measures.filter(column => column.index !== guess.label);
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	const namers = label ? namingColumns(table, label) : [];
	const questions: Questions = { worth: QUESTIONS.worth };
	const labels = labelOptions(table, guess);
	if (labels.size) questions.label = { ...QUESTIONS.label, criteria: bare(labels.keys()) };
	for (const column of measures)
		questions[`c${column.index}`] = renderQuestion(QUESTIONS.column, { column: column.header });
	questions.metrics = QUESTIONS.metrics;
	for (const group of axisGroups(measures).slice(0, MAX_CONDITION_GROUPS))
		questions[`k${group[0]!.index}`] = renderQuestion(QUESTIONS.conditions, {
			columns: group.map(column => column.header),
		});
	const groupers = label && namers.length ? [label, ...namers] : [];
	for (const column of namers)
		questions[`n${column.index}`] = renderQuestion(QUESTIONS.name, { column: column.header, label: label?.header });
	for (const column of groupers)
		questions[`g${column.index}`] = renderQuestion(QUESTIONS.group, { column: column.header });
	if (heatCapable(table, guess, measures)) questions.shading = QUESTIONS.shading;
	const lead = rankable(table, guess);
	if (lead) questions.order = renderQuestion(QUESTIONS.order, { column: lead.header });
	const reference = referenceCandidates(table, guess);
	if (reference) {
		const { column, values, repeats } = reference;
		const question = renderQuestion(QUESTIONS.reference, { column: column.header, repeats });
		questions.reference = { ...question, criteria: { ...bare(values), ...question.criteria } };
	}
	for (const [id, question] of meaningQuestions(request)) {
		if (Object.keys(questions).length >= MAX_QUESTIONS) break;
		questions[id] = question;
	}
	return questions;
}

/**
 * What the table means, as questions in {@link MEANING_PRIORITY} order, each
 * asked only where its answer can change a chart: what competes and the
 * focus row with {@link MIN_CONTEST_ROWS} rows or more; the direction of a
 * before/after move; the polarity of the measures a chart may plot; the
 * polarity of each row where rows may be metrics of their own.
 */
function meaningQuestions({ table, guess }: TableChartRequest): [string, Question][] {
	const asked: [string, Question][] = [];
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	const measures = table.measures.filter(column => column.index !== guess.label);
	// Rows may each take a panel of their own across the columns one axis can hold (a transposed
	// small-multiples candidate), as metrics with a polarity each.
	const panels =
		table.rows.length <= MAX_PANEL_ROWS &&
		measures.some(first => measures.some(second => second !== first && sameUnit(first, second)));
	for (const kind of MEANING_PRIORITY) {
		if (kind === "move") {
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
			// The columns a chart may plot: the guess's series first, then the other measures.
			const plotted = [
				...guess.series.map(index => table.columns[index]!),
				...measures.filter(column => !guess.series.includes(column.index)),
			].filter(column => column.role === "measure");
			for (const column of plotted.slice(0, MAX_POLARITY_QUESTIONS))
				asked.push([`p${column.index}`, renderQuestion(QUESTIONS.polarity, { column: column.header })]);
		} else if (kind === "focus") {
			const names = rowNames(table, guess);
			if (names.size < MIN_CONTEST_ROWS || names.size > MAX_FOCUS_ROWS) continue;
			asked.push([
				"focus",
				{ ...QUESTIONS.focus, criteria: { ...bare(names.keys()), ...QUESTIONS.focus.criteria } },
			]);
		} else if (label && (rowsAreMetrics(table, guess) || panels)) {
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

/** The judge's probability of yes for the noul question `id`; 0 when unanswered. */
function noul(answers: Answers, id: string): number {
	const answer = answers[id];
	return answer?.type === "noul" ? answer.noul : 0;
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

/** How the first round's answers read the table's columns: what names its rows and what a chart may plot. */
interface Reading {
	readonly label: TableColumn | undefined;
	/** Every column a chart may plot: the table's measures but the label. */
	readonly measures: readonly TableColumn[];
	/** The results worth plotting, in table order: the judge's, else the guess's series. */
	readonly results: readonly TableColumn[];
	/** The result charts lead with: the guess's lead where it is a result, else the first. */
	readonly lead: TableColumn;
	/** The largest group of results one axis can hold ({@link axisGroups}); the lead alone without one. */
	readonly shared: readonly TableColumn[];
	/**
	 * How likely each row is a metric of its own (its own unit or meaning) rather than an item on the
	 * columns' scales: the judge's answer, certain where cells of one column differ in unit;
	 * `undefined` when unasked.
	 */
	readonly metricRows: number | undefined;
	/**
	 * How likely {@link shared}'s columns hold one quantity under several conditions (before and
	 * after, versions, tools, setups) rather than different quantities in one unit; `undefined` when
	 * unasked.
	 */
	readonly conditions: number | undefined;
}

/**
 * The groups of two or more of `columns` one axis can hold ({@link sameUnit}),
 * largest first, each in table order.
 */
function axisGroups(columns: readonly TableColumn[]): TableColumn[][] {
	const groups: TableColumn[][] = [];
	for (const column of columns) {
		const group = groups.find(members => sameUnit(members[0]!, column));
		if (group) group.push(column);
		else groups.push([column]);
	}
	return groups.filter(group => group.length >= 2).sort((a, b) => b.length - a.length);
}

/**
 * The table as `answers` read it; `undefined` when they leave nothing to
 * plot (the one number of the table names its rows).
 */
function readTable({ table, guess }: TableChartRequest, answers: Answers): Reading | undefined {
	const picks = answers.label;
	const named = picks?.type === "choice" ? labelOptions(table, guess).get(picks.choice) : undefined;
	const label = named ?? (guess.label === undefined ? undefined : table.columns[guess.label]);
	// A number picked as the label names its rows and leaves the plot.
	const measures = table.measures.filter(column => column !== label);
	const picked = measures.filter(column => noul(answers, `c${column.index}`) >= 0.5);
	const results = picked.length
		? picked
		: guess.series.map(index => table.columns[index]!).filter(column => column !== label);
	const lead = results.find(column => column.index === guess.series[0]) ?? results[0];
	if (!lead) return undefined;
	const shared = axisGroups(results)[0] ?? [lead];
	const metrics = answers.metrics;
	return {
		label,
		measures,
		results,
		lead,
		shared,
		metricRows: results.some(column => column.mixed) ? 1 : metrics?.type === "noul" ? metrics.noul : undefined,
		conditions: judgedConditions({ table, guess }, answers, shared[0]),
	};
}

/**
 * The judge's answer on whether the same-unit columns around `column` are
 * one quantity under several conditions: that of the group the first round
 * offered the column in ({@link readingQuestions}); `undefined` when unasked.
 */
function judgedConditions(
	{ table, guess }: Pick<TableChartRequest, "table" | "guess">,
	answers: Answers,
	column: TableColumn | undefined,
): number | undefined {
	const asked = axisGroups(table.measures.filter(other => other.index !== guess.label)).find(
		group => column !== undefined && group.includes(column),
	);
	const answer = answers[`k${asked?.[0]?.index}`];
	return answer?.type === "noul" ? answer.noul : undefined;
}

/**
 * Whether `spec`'s chart compares like with like as the judge read the
 * table; an unasked fact rules nothing out.
 * - Rows that are metrics of their own (`metricRows`) share no axis: each takes a panel, a factor of
 *   its own baseline or target, or a row of cells shaded on its own. Rows on one scale take no panel each.
 * - Columns set against each other pairwise — a dumbbell, factors of a baseline column, a slope — must
 *   be one quantity under several conditions (`conditions`; likelier than not where their headers
 *   name a before and its after), unless the table writes the pairs itself (`a → b` cells,
 *   `Baseline X | Iter X` headers); and columns that are different quantities share no axis,
 *   whatever their unit.
 */
function comparesLike(
	table: TableAnalysis,
	plan: ChartPlan,
	spec: ChartSpec,
	metricRows: number | undefined,
	conditions: number | undefined,
): boolean {
	const { kind } = spec;
	const rowShaded = kind === "heatmap" && spec.shading === "row";
	if (metricRows !== undefined) {
		const apart = spec.transposed || kind === "change" || kind === "stat" || kind === "bullet" || rowShaded;
		if (metricRows >= SURE_METRICS && !apart) return false;
		if (metricRows < 0.5 && kind === "multiples" && spec.transposed) return false;
	}
	if (conditions === undefined) return true;
	const written = plan.baselines !== undefined || plan.series.every(index => table.columns[index]!.arrowShare >= 0.6);
	const pairwise = kind === "paired" || kind === "change" || kind === "slope" || spec.baseline !== undefined;
	const moved = spec.transition || (kind === "change" && !spec.rival);
	if (pairwise && !written && conditions < (moved ? 0.5 : SURE_CONDITIONS)) return false;
	const oneAxis =
		spec.series.length >= 2 &&
		(kind === "grouped" || kind === "dots" || kind === "line" || (kind === "heatmap" && spec.shading !== "series"));
	return !(oneAxis && conditions < UNLIKE_QUANTITIES);
}

/**
 * What a chart plots under a {@link Reading}: its kind and columns, the plan
 * fields only that kind carries, and the column naming its rows where the
 * shape decides it (an x axis found among the measures).
 */
type Shape = Pick<ChartPlan, "kind" | "series"> &
	Partial<Pick<ChartPlan, "label" | "transpose" | "shading" | "whole" | "baselines" | "target" | "offsets" | "limit">>;

/**
 * The charts of `kind` the table's data can draw under `reading`, each over
 * the columns that kind compares — none where the data holds no such chart,
 * so the judge is only offered charts that draw. A chart of some results
 * that leaves the others out says less than one of them all, so the general
 * kinds draw every result or nothing:
 * - one column (`bar`, `diverging`): the only result; a `diverging` one holds signed changes.
 * - one axis (`grouped`, `dots`, `heatmap`, `line`, `progress` for scores): the results where one
 *   axis holds them all ({@link Reading.shared}); a heatmap of metric rows shades each row on its own.
 * - `multiples`: every result in its own panel, and each row in its own across the results on one
 *   axis (the rows being metrics of their own).
 *
 * The kinds a table's structure decides draw what that structure names:
 * - one quantity under several conditions (as the judge reads the columns, {@link comparesLike}; else
 *   what the headers say): `paired` for two of them, `change` against their baseline
 *   ({@link baselineOf}), `slope` across stages.
 * - `a → b` cells: `paired` for one column in one unit, `change` for several or for rows in units of their own.
 * - `stacked`: the parts of a composition the values show, or outcome counts.
 * - `range`, `butterfly`, `bullet`, `ladder`, `histogram`: the columns {@link rangeColumns},
 *   {@link opposedColumns}, {@link findTarget}, {@link tableLadders} and {@link histogramColumns} find.
 * - a share of one total, a cloud of points, a run of steps or a comparison of two conditions
 *   (`share`, `scatter`, `timeline`, `waterfall`, `stat`): the guess's, which the values alone decide.
 */
function kindShapes({ table, guess }: TableChartRequest, reading: Reading, kind: ChartKind): Shape[] {
	const { label, measures, results, lead, shared, metricRows = 0, conditions } = reading;
	const over = (columns: readonly TableColumn[] | undefined, fields?: Partial<Shape>): Shape[] =>
		columns?.length ? [{ kind, series: columns.map(column => column.index), ...fields }] : [];
	// One axis holds every result.
	const whole = shared.length === results.length;
	const [first, second] = shared;
	switch (kind) {
		case "bar":
			return results.length === 1 ? over(results) : [];
		case "diverging": {
			// Changes around zero: a negative value, or figures mostly written with a sign.
			const signed =
				lead.signedShare >= 0.6 ||
				table.rows.some(row => {
					const cell = lead.cells[row];
					return isNumber(cell) && cell.value < 0;
				});
			return results.length === 1 && signed ? over(results) : [];
		}
		case "progress":
			return whole && shared.every(column => column.scores) ? over(shared) : [];
		case "paired": {
			const arrows = results.filter(column => column.arrowShare >= 0.6);
			if (arrows.length === 1 && !arrows[0]!.mixed) return over(arrows);
			if (!first || !second) return [];
			// Two columns pair up as the judge reads them, else as their headers do; among more, a before and its after.
			if (shared.length > 2) return over(movedPair(shared));
			return conditions !== undefined || isConditionPair(first.header, second.header) ? over(shared) : [];
		}
		case "grouped":
			return whole && shared.length >= 2 ? over(shared) : [];
		case "dots":
			return whole && dotsFit(shared, table.rows) ? over(shared) : [];
		case "heatmap":
			if (!whole || shared.length < MIN_GRID_COLUMNS) return [];
			return over(shared, metricRows >= 0.5 ? { shading: "row" } : undefined);
		case "line":
			return whole ? over(capped(shared, MAX_LINES, lead)) : [];
		case "stacked": {
			const composition = table.composition;
			if (composition && !composition.parts.includes(label?.index ?? -1))
				return [{ kind, series: composition.parts, whole: composition.whole }];
			return over(outcomeColumns(results));
		}
		case "multiples":
			return [
				...(results.length >= 2 ? over(capped(results, MAX_PANELS, lead)) : []),
				...(shared.length >= 2 && table.rows.length <= MAX_PANEL_ROWS ? over(shared, { transpose: true }) : []),
			];
		case "change": {
			if (guess.baselines) return [{ kind, series: guess.series, baselines: guess.baselines }];
			const arrows = results.filter(column => column.arrowShare >= 0.6);
			if (arrows.length >= 2) return over(arrows);
			// One column of `a → b` cells in one unit is a dumbbell; rows in units of their own move by factors.
			if (arrows.length === 1) return arrows[0]!.mixed ? over(arrows) : [];
			if (shared.length < 2) return [];
			// Factors of a baseline need one quantity: as the judge reads the columns, else a before column among them.
			const baseline = baselineOf(shared);
			if (conditions === undefined && !baseline) return [];
			return over(baseline ? [baseline, ...shared.filter(column => column !== baseline)] : shared);
		}
		case "range": {
			// Intervals are the chart: every interval column, whatever the column answers dropped.
			const spans = rangeColumns(measures, table.rows);
			return spans ? over(measures.filter(column => spans.includes(column) || results.includes(column))) : [];
		}
		case "slope":
			return over(stageColumns(measures, table.rows));
		case "butterfly":
			return over(opposedColumns(measures));
		case "bullet": {
			const held = findTarget(table);
			return held ? [{ kind, series: [held.measured.index], target: held.target.index }] : [];
		}
		case "ladder": {
			const ladders = tableLadders(table, label?.index);
			return ladders ? [{ kind, series: ladderColumns(ladders) }] : [];
		}
		case "histogram":
			return over(histogramColumns(table, measures)?.counts);
		case "share":
		case "scatter":
		case "timeline":
		case "waterfall":
		case "stat":
			return guess.kind === kind ? [planShape(guess)] : [];
	}
}

/** `plan`'s {@link Shape}: what it plots, without how its rows are named, ranked or read. */
function planShape(plan: ChartPlan): Shape {
	const { kind, series, label, transpose, whole, baselines, target, offsets, limit } = plan;
	return { kind, series, label, transpose, whole, baselines, target, offsets, limit };
}

/** At most `max` of `columns`, in order, `lead` among them. */
function capped(columns: readonly TableColumn[], max: number, lead: TableColumn): readonly TableColumn[] {
	if (columns.length <= max) return columns;
	const kept = columns.slice(0, max);
	return kept.includes(lead) || !columns.includes(lead) ? kept : [...kept.slice(0, -1), lead];
}

/** The first two of `columns` whose headers name one quantity before and after ({@link isTransition}). */
function movedPair(columns: readonly TableColumn[]): TableColumn[] | undefined {
	for (const [at, first] of columns.entries()) {
		const second = columns.slice(at + 1).find(column => isTransition(first.header, column.header));
		if (second) return [first, second];
	}
	return undefined;
}

/**
 * The baseline among `columns`: the one whose header names the before state
 * of every other ({@link isTransition}); `undefined` where the headers name
 * none (factors then read against the first, as tables are written).
 */
function baselineOf(columns: readonly TableColumn[]): TableColumn | undefined {
	return columns.find(column => columns.every(other => other === column || isTransition(column.header, other.header)));
}

/**
 * The plan drawing `shape` under the judged reading: the shape's columns
 * named, grouped, shaded, ranked and referenced as `answers` say. A table
 * mostly of quantiles draws its ladders, and counts over ordered bins their
 * histogram, whatever per-row comparison the shape asks for (bars of each
 * quantile apart hide each row's spread). `undefined` when the table's prose
 * carries it ({@link proseLed}).
 */
function shapePlan(
	request: TableChartRequest,
	answers: Answers,
	reading: Reading,
	shape: Shape,
): ChartPlan | undefined {
	const { table, guess } = request;
	const { label, measures } = reading;
	const rowwise = !shape.transpose;
	const ladders = rowwise && LADDERABLE[shape.kind] ? tableLadders(table, label?.index) : undefined;
	const histogram = rowwise && !ladders && BINNABLE[shape.kind] ? histogramColumns(table, measures) : undefined;
	const drawn: Shape = ladders
		? { kind: "ladder", series: ladderColumns(ladders) }
		: histogram
			? { kind: "histogram", series: histogram.counts.map(column => column.index) }
			: shape;
	const columns = drawn.series.map(index => table.columns[index]!);
	if (proseLed(table, columns)) return undefined;
	// A histogram's bins name its columns, and a shape its own label, whatever label the judge picked;
	// another label than the guess's is named locally.
	const bins = histogram?.bins ?? (drawn.label === undefined ? label : table.columns[drawn.label]);
	const naming =
		bins && bins.index !== guess.label
			? guessNaming(table, bins)
			: label && !histogram
				? judgedNaming(request, answers, label)
				: { qualifiers: [], group: undefined };
	return {
		...drawn,
		label: bins?.index,
		qualifiers: naming.qualifiers,
		group: naming.group,
		transpose: drawn.transpose ?? false,
		shading:
			drawn.shading ??
			sureChoice(answers.shading, SHADING_CONFIDENCE, QUESTIONS.shading.criteria) ??
			(guess.kind === "heatmap" ? guess.shading : guessShading(columns, table.rows)),
		reference: judgedReference(request, answers.reference),
		order: judgedOrder(request, answers.order, drawn),
	};
}

/**
 * The columns naming rows beside the guess's `label`, and the one grouping
 * them: the qualifiers the judge accepts, kept only as far as they tell rows
 * apart, and its likeliest group among the naming columns. An on-device
 * judge is not asked: the guess's naming stands.
 */
function judgedNaming(
	{ table, guess }: TableChartRequest,
	answers: Answers,
	label: TableColumn,
): { qualifiers: readonly number[]; group: number | undefined } {
	const namers = namingColumns(table, label);
	if (!namers.some(column => answers[`n${column.index}`]))
		return { qualifiers: guess.qualifiers ?? [], group: guess.group };
	const accepted = namers.filter(column => noul(answers, `n${column.index}`) >= 0.5);
	const { qualifiers } = guessNaming(table, label, accepted);
	let group: number | undefined;
	let odds = 0;
	for (const index of qualifiers.length ? [label.index, ...qualifiers] : []) {
		const yes = noul(answers, `g${index}`);
		if (yes >= 0.5 && yes > odds) {
			group = index;
			odds = yes;
		}
	}
	return { qualifiers, group };
}

/**
 * Every chart the judge chooses among for `request`, at most
 * {@link MAX_CANDIDATES}: first the local guess over the columns `answers`
 * read as results (the kind the table's own structure suggests, drawn from
 * what the judge says is worth plotting), then each other chart kind's
 * ({@link kindShapes}) in the `chart` question's order, then the unrefined
 * guess. Charts drawing the same thing ({@link describeChart}) are offered
 * once, and charts comparing what the judge read as unlike are left out
 * ({@link comparesLike}). Empty when the judge sees no chart helping
 * ({@link MIN_WORTH}) or nothing is left to plot.
 */
export function candidateCharts(request: TableChartRequest, answers: Answers): ChartCandidate[] {
	const { table, guess } = request;
	const worth = answers.worth;
	const reading = readTable(request, answers);
	if (!reading || (worth?.type === "noul" && worth.noul < MIN_WORTH)) return [];
	const local = planChart(withMeasures(table, reading.results, reading.label));
	const shapes: Shape[] = local ? [planShape(local)] : [];
	for (const option in QUESTIONS.chart.criteria) {
		if (isOption(QUESTIONS.chart.criteria, option) && isKind(option))
			shapes.push(...kindShapes(request, reading, option));
	}
	const plans = shapes.flatMap(shape => shapePlan(request, answers, reading, shape) ?? []);
	// The guess plots what it found worth plotting, unless one of those columns turned out to name the rows.
	if (!guess.series.includes(reading.label?.index ?? -1)) plans.push({ ...guess, title: undefined });
	const candidates = new Map<string, ChartCandidate>();
	for (const shaped of plans) {
		const plan = judgedMeaning(request, answers, shaped);
		const spec = buildChart(table, plan);
		const conditions = judgedConditions(request, answers, table.columns[plan.series[0] ?? -1]);
		if (!spec || !comparesLike(table, plan, spec, reading.metricRows, conditions)) continue;
		const description = describeChart(spec);
		if (candidates.has(description)) continue;
		const contests = conditions === undefined || conditions >= SURE_CONDITIONS ? CONTESTS : ROW_CONTEST;
		candidates.set(description, {
			plan,
			description,
			takeaways: tableTakeaways(table, plan, contests),
			headline: tableTakeaways(table, plan).find(fact => fact.striking),
		});
		if (candidates.size === MAX_CANDIDATES) break;
	}
	return [...candidates.values()];
}

/**
 * What `spec`'s chart draws, as the judge reads it: its kind's template in
 * the `chart` question, filled with the names of what it plots.
 */
function describeChart(spec: ChartSpec): string {
	const series = spec.series.map(entry => entry.name);
	return prompt.render(QUESTIONS.chart.criteria[spec.kind] ?? "", {
		axis: spec.axis || "row",
		rows: spec.categories.slice(0, MAX_DESCRIBED),
		moreRows: Math.max(0, spec.categories.length - MAX_DESCRIBED),
		series: series.slice(0, MAX_DESCRIBED),
		moreSeries: Math.max(0, series.length - MAX_DESCRIBED),
		first: series[0],
		second: series[1],
		x: spec.x?.name,
		baseline: spec.baseline,
		reference: spec.reference?.map(at => spec.categories[at]).join(", "),
		whole: spec.whole?.name,
		target: spec.targetName ?? "target",
		normalized: spec.normalized,
		transition: spec.transition,
		transposed: spec.transposed,
		perColumn: spec.shading === "series",
		perRow: spec.shading === "row",
	});
}

/**
 * The second round's questions: `chart`, choosing among `candidates` (keyed
 * `A`, `B`, … in order) or `none`; and, when `titled`, per candidate with
 * takeaways the question `title<key>` picking the one that heads its chart.
 * An on-device judge answers one keyword: `chart` alone.
 */
export function chartQuestions(candidates: readonly ChartCandidate[], scope: "chart" | "titled" = "titled"): Questions {
	const charts: Record<string, string | null> = {};
	const questions: Questions = {};
	for (const [at, candidate] of candidates.entries()) {
		const key = CANDIDATE_KEYS[at]!;
		charts[key] = candidate.description;
		if (scope === "chart" || candidate.takeaways.length === 0) continue;
		const facts: Record<string, string | null> = {};
		for (const fact of candidate.takeaways) facts[fact.key] = fact.text;
		const question = renderQuestion(QUESTIONS.title, { chart: candidate.description });
		questions[`title${key}`] = { ...question, criteria: { ...facts, ...question.criteria } };
	}
	return {
		chart: { ...QUESTIONS.chart, criteria: { ...charts, [NONE]: QUESTIONS.chart.criteria.none } },
		...questions,
	};
}

/**
 * The plan the judge chose among `candidates` in `answers` (the second
 * round's), titled with the takeaway it picked for that chart
 * ({@link judgedTitle}), or `null` for no chart. The first candidate is the
 * chart the table's own structure suggests, so another must lead it by
 * {@link PICK_MARGIN}; and `none` stands only where the first round's
 * `reading` was not already sure a chart helps ({@link SURE_WORTH}).
 */
export function chosenChart(
	candidates: readonly ChartCandidate[],
	answers: Answers,
	reading: Answers = {},
): ChartPlan | null {
	const pick = answers.chart;
	const odds = pick?.type === "choice" ? pick.probabilities : {};
	let likeliest = 0;
	for (const at of candidates.keys())
		if ((odds[CANDIDATE_KEYS[at]!] ?? 0) > (odds[CANDIDATE_KEYS[likeliest]!] ?? 0)) likeliest = at;
	const best = odds[CANDIDATE_KEYS[likeliest]!] ?? 0;
	if ((odds[NONE] ?? 0) > best && noul(reading, "worth") < SURE_WORTH) return null;
	const at = best - (odds[CANDIDATE_KEYS[0]!] ?? 0) > PICK_MARGIN ? likeliest : 0;
	const candidate = candidates[at];
	if (!candidate) return null;
	return { ...candidate.plan, title: judgedTitle(candidate, answers[`title${CANDIDATE_KEYS[at]}`]) };
}

/**
 * The title of a candidate's chart: a takeaway the judge is sure of (a plain
 * one needs more), no title where it is sure of that, else the candidate's
 * {@link ChartCandidate.headline} — or, unsure, the striking fact the judge
 * ranks likeliest.
 */
function judgedTitle({ takeaways: facts, headline }: ChartCandidate, pick: Answer | undefined): string | undefined {
	if (pick?.type !== "choice") return headline?.text;
	const chance = (option: string | undefined) => (option === undefined ? 0 : (pick.probabilities[option] ?? 0));
	const fact = facts.find(fact => fact.key === pick.choice);
	if (fact && chance(fact.key) >= (fact.striking ? SURE_TITLE : SURE_PLAIN_TITLE)) return fact.text;
	if (pick.choice === NONE && chance(NONE) >= SURE_TITLE) return undefined;
	// Unsure, the judge still ranks the striking facts: its likeliest one beats the headline (and no
	// title, where it leans that way more).
	const ranked = facts.filter(fact => fact.striking).sort((a, b) => chance(b.key) - chance(a.key))[0];
	const leads = ranked && chance(ranked.key) > Math.max(chance(headline?.key), chance(NONE));
	return (leads && chance(ranked.key) >= RANKED_TITLE ? ranked : headline)?.text;
}

/**
 * `plan` with what the judge says the table means, each answer only at its
 * confidence gate, else the local guess for `plan` ({@link guessMeaning}):
 * polarity per measure and metric row, what competes, and the focus row.
 */
function judgedMeaning(request: TableChartRequest, answers: Answers, plan: ChartPlan): ChartPlan {
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
	return { ...plan, ...local, polarity, rowPolarity, rivals, focus };
}

/**
 * Whether the table can draw as a heatmap — the guess is one, or it holds
 * {@link MIN_HEAT_COLUMNS} same-unit measures — so the shading answer can
 * change a chart.
 */
function heatCapable(table: TableAnalysis, guess: ChartPlan, measures: readonly TableColumn[]): boolean {
	if (guess.kind === "heatmap") return true;
	const sizes = new Map<string, number>();
	for (const column of measures) {
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
	if (!lead || label?.role !== "label" || OWN_FRAME[guess.kind] || guess.transpose || guess.baselines)
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
	{ kind, series }: Shape,
): RowOrder | undefined {
	const direction = sureChoice(answer, RANK_CONFIDENCE, QUESTIONS.order.criteria);
	if (direction === undefined || direction === "table" || OWN_FRAME[kind]) return undefined;
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
	if (!REFERENCED[guess.kind] || guess.baselines) return undefined;
	const index = guess.reference?.column ?? guess.qualifiers?.at(-1) ?? guess.label;
	const column = index === undefined ? undefined : table.columns[index];
	if (!column || column.role !== "label") return undefined;
	const cells = table.rows.map(row => column.cells[row]!).filter(cell => cell.kind !== "missing");
	const values = [...new Set(cells.map(cell => cell.text))];
	if (values.length < 2 || values.length > MAX_REFERENCE_CHOICES) return undefined;
	if (values.some(value => value.length > MAX_REFERENCE_CHARS || value === NONE)) return undefined;
	return { column, values, repeats: values.length < cells.length };
}

/** The judge's reference row at {@link REFERENCE_CONFIDENCE} or more (`none` clears the guess); else the guess's. */
function judgedReference(request: TableChartRequest, answer: Answer | undefined): ChartPlan["reference"] {
	const { guess } = request;
	if (answer?.type !== "choice" || (answer.probabilities[answer.choice] ?? 0) < REFERENCE_CONFIDENCE)
		return guess.reference;
	if (answer.choice === NONE) return undefined;
	const index = referenceCandidates(request.table, guess)?.column.index;
	return index === undefined ? guess.reference : { column: index, value: answer.choice };
}

/** A column's inferred type as the judge reads it: `number (duration)`, `text`, `row index`, … */
function columnType(column: TableColumn): string {
	switch (column.role) {
		case "measure":
			if (column.arrowShare >= 0.6) return "two numbers per cell (before → after)";
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
