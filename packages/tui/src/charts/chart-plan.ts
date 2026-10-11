/**
 * Which chart a table becomes and the data it plots. {@link planChart} is the
 * local best guess over a {@link TableAnalysis}: the chart kind, the label
 * column and the measure columns to draw. A host may substitute its own
 * {@link ChartPlan} (a model's pick for a multi-series table); either way
 * {@link buildChart} turns it into the {@link ChartSpec} that
 * {@link renderChartSvg} draws, and {@link worthCharting} decides whether
 * the picture says more than the table already does.
 *
 * The heuristics were fitted on ~7k tables from real assistant answers: the
 * label is the first text column (index columns like `#`/`Rank` never are),
 * table order is kept (most tables are deliberately unsorted), total rows stay
 * out of the scale, and units never share an axis. Rows whose labels repeat
 * (`Model | Harness | …`) are named by the text columns that tell them apart
 * ({@link ChartPlan.qualifiers}), nested under one of them
 * ({@link ChartPlan.group}) when it already runs in blocks; otherwise names
 * sharing a leading part nest under it (`glm new`, `glm prior`), and names are
 * shortened for display wherever they stay distinct. A row named as the
 * baseline becomes the {@link ChartPlan.reference} the others read against;
 * before/after values spanning decades, or rows of very different sizes
 * beside a baseline column, draw as factors of change.
 *
 * A plan also carries what the table means ({@link guessMeaning} locally, a
 * judge's answers in `smart` mode): which way each measure improves, what
 * competes, the rows it is about, a status column, and the one
 * {@link tableTakeaways | takeaway} stated as its title.
 */
import {
	type Cell,
	cellStatus,
	type Dimension,
	isMonotonic,
	isNumber,
	type NumberCell,
	parseCell,
	plainCell,
	type Status,
	type TableAnalysis,
	type TableColumn,
	writtenSlack,
} from "./table-data";

/**
 * Which way a measure improves: `higher` (pass rate, throughput, speedup) or
 * `lower` (cost, latency, errors). Measures that improve neither way (counts,
 * sizes, shares, ids) have none.
 */
export type Polarity = "higher" | "lower";

/** Which way a table's alternatives run: down its rows or across its plotted columns. */
export type Rivals = "rows" | "columns";

/**
 * Chart kinds, by the table shapes they fit:
 * - `bar`: one measure across categories.
 * - `paired`: one quantity under two conditions per category (before/after, old vs new), or `a → b` cells.
 * - `grouped`: two to four same-unit measures per category that are not one before/after pair.
 * - `stacked`: same-unit parts of one whole per category (`Cached + Uncached input + Output = Total`), one segmented bar each;
 *   outcome counts (`ok | fail`) as each category's mix ({@link ChartPlan.normalize}).
 * - `line`: measures over an ordered axis (dates, runs, sizes).
 * - `heatmap`: a matrix of same-unit values.
 * - `multiples`: measures in different units, each scaled on its own; transposed when each row is its own metric.
 * - `share`: parts of a whole in one bar: percentages summing to 100, or counts splitting one total (items by status).
 * - `diverging`: signed changes around zero.
 * - `scatter`: two continuous measures per item.
 * - `change`: metrics in different units against a baseline column (before/after), as factors.
 * - `progress`: scores out of a total (`12/12`), as filled tracks.
 * - `timeline`: one measure's rows laid end to end on one axis, in table order or at an offset column
 *   (pipeline steps to time scale, parts of a buffer at their offsets).
 * - `waterfall`: one measure's rows building up, step by step in table order, to their total (a total row
 *   or their sum), with any cap row as a rule.
 * - `dots`: two to six same-unit series per category as dots on one shared axis (a Cleveland dot plot),
 *   logarithmic when the values span decades; generalizes the dumbbell beyond two series.
 * - `range`: values written as `a–b` intervals, as floating bars from low to high, with an optional
 *   central estimate and a stated reference (a budget, a price, 1×); series in other units get their own band.
 * - `slope`: each category's value at two to four ordered stages (`Baseline | Best (Iter 3) | Iter 4`),
 *   a line per category from stage to stage, labelled at both ends; moves toned by polarity.
 * - `butterfly`: two opposing amounts per category (`Added | Removed`, `Wins | Losses`) as back-to-back
 *   bars from a shared spine, each row's net beside it.
 * - `bullet`: one measured value per row against that row's own target, budget or limit (a `Target ≤ 200 µs`
 *   column), each as a share of its target on one axis: a bar (a `p50 / p99` span) to a target mark, toned by
 *   whether it stays on the target's side ({@link ChartPlan.target}).
 * - `ladder`: quantiles of one measurement per category (`p50 | p90 | p99 | max` columns, `p50 / p99`
 *   cells), each row a line from its lowest quantile to its highest with a mark at each, on one shared
 *   axis (logarithmic when the tails span decades); one ladder per condition measured (`Startup`, `Wall`).
 * - `histogram`: counts or shares over rows that are ordered bins (`1`, `2–5`, `6–20`, `100+`), as
 *   columns in bin order; two to four distributions side by side, as shares of each one's total when
 *   their totals differ ({@link ChartPlan.normalize}).
 * - `stat`: a small table comparing two conditions (old vs new, on vs off) on one to four metrics, as a tile
 *   per metric: the factor between them in big figures over a short bar per condition ({@link statShape}).
 */
export type ChartKind =
	| "bar"
	| "paired"
	| "grouped"
	| "line"
	| "heatmap"
	| "multiples"
	| "share"
	| "diverging"
	| "scatter"
	| "change"
	| "progress"
	| "stacked"
	| "timeline"
	| "waterfall"
	| "dots"
	| "range"
	| "slope"
	| "butterfly"
	| "bullet"
	| "ladder"
	| "histogram"
	| "stat";

/** What to draw from a table: the kind, the columns naming each category, and the columns plotted. */
export interface ChartPlan {
	readonly kind: ChartKind;
	/** Column naming each category (or holding the x values of a line); rows are numbered without one. */
	readonly label: number | undefined;
	/** Columns joined to the label to tell rows apart (`Sonnet 5.5 · bash`); none by default. */
	readonly qualifiers?: readonly number[];
	/**
	 * Naming column whose values nest the rows: rows regroup by its values in
	 * order of first appearance (table order within each), and a label column
	 * writes each value once beside its block. Lines keep their x order and ignore it.
	 */
	readonly group?: number;
	/**
	 * Plotted columns, in order; a `change` measures the rest against the first (or its `a → b` cells),
	 * a `slope` runs through them as stages, and a `butterfly` draws the first leftward (the losing side).
	 */
	readonly series: readonly number[];
	/**
	 * `change` over metric pairs (`Baseline Turns | Iter1 Turns | Baseline Tokens
	 * In | Iter1 Tokens In`): the baseline column of each series, in order, so
	 * each series is measured against its own before column instead of the first.
	 */
	readonly baselines?: readonly number[];
	/** Each data row is its own series (a metric with its own unit) and the plotted columns are the categories. */
	readonly transpose: boolean;
	/**
	 * Heatmap cells shaded on one scale across every cell (default), each
	 * series on its own, or each row on its own. A `series`-shaded heatmap of
	 * at most {@link MAX_PANELS} series draws as a grid of bars instead, each
	 * column on its own axis: its columns are different quantities.
	 */
	readonly shading?: Shading;
	/**
	 * Rows whose `column` cell reads `value` are the reference the others are
	 * read against (`Harness` = `baseline`), one per group; none by default.
	 */
	readonly reference?: RowReference;
	/**
	 * Rows ranked by a plotted column instead of table order (rankings,
	 * leaderboards); within each group when grouped. Lines and scatters keep
	 * their x order, `change` charts table order. Table order by default: most
	 * tables are deliberately ordered.
	 */
	readonly order?: RowOrder;
	/**
	 * `stacked`: the column the plotted parts make up (`Total`), labelling each
	 * bar with its written figure and drawing any rest it holds beyond the parts
	 * as an unlabelled track. Without it a bar ends at the parts' sum.
	 */
	readonly whole?: number;
	/**
	 * `stacked`: each bar spans 100% of its category's total (its whole, else
	 * its parts' sum), so rows of very different sizes compare by their mix.
	 * Absent: normalized when the parts are outcomes ({@link outcomeTones}:
	 * `ok | fail`, `Pass | Fail | Skip`), whose rates are the point, over
	 * totals {@link MIX_SPREAD}× apart or more.
	 * `histogram`: each distribution as shares of its own total, so populations
	 * of different sizes compare by shape. Absent: normalized when two or more
	 * count columns' totals lie {@link MIX_SPREAD}× apart or more.
	 */
	readonly normalize?: boolean;
	/**
	 * `timeline`: the column holding each segment's start (`Offset`, `Start`),
	 * in the plotted column's dimension; without it segments follow one another
	 * in table order from zero.
	 */
	readonly offsets?: number;
	/**
	 * `waterfall`: the row (by index) of a cap the steps build toward (`Hard
	 * cap`, `Budget`), drawn as a rule across the steps instead of a step.
	 */
	readonly limit?: number;
	/**
	 * `bullet`: the column holding each row's target (`Target` `≤ 200 µs`, `§6
	 * budget`, `Limit`), which the one plotted series is measured against
	 * ({@link findTarget}).
	 */
	readonly target?: number;
	/** Which way each column improves, by column index; neutral columns absent. */
	readonly polarity?: Readonly<Record<number, Polarity>>;
	/** Which way each row's metric improves, by row index, where rows are metrics ({@link rowsAreMetrics}). */
	readonly rowPolarity?: Readonly<Record<number, Polarity>>;
	/**
	 * What competes, so each contest's best value (by {@link polarity}) is
	 * marked: `rows` are alternatives scored by every measure (models,
	 * configs, arms: the best per column); `columns` are alternatives measured
	 * on every row (`Record | Map | string[]` per scenario: the best per row).
	 * Absent for parts of a whole, steps, or items described side by side.
	 */
	readonly rivals?: Rivals;
	/** Rows the table is about (the recommended option, `current`, `ours`, the bolded row), by row index. */
	readonly focus?: readonly number[];
	/** Column whose status cells (`ok`, `FAIL`, `pending`, ✅) badge each row's name. */
	readonly status?: number;
	/** The chart's title: one fact stated over it, the text of one of {@link tableTakeaways}; none by default. */
	readonly title?: string;
}

/** A naming cell marking reference rows: column index and cell text. */
export interface RowReference {
	readonly column: number;
	readonly value: string;
}

/** Rows sorted by `column`'s values, largest first (`descending`) or smallest first. */
export interface RowOrder {
	readonly column: number;
	readonly direction: "descending" | "ascending";
}

/**
 * How a heatmap shades its cells: `shared` compares every cell with every
 * other; `series` compares within each column (different quantities, like
 * input vs. reasoning tokens), so one large column does not wash out the
 * rest; `row` compares within each row (one measure across conditions, rows
 * of very different sizes), so one large row does not wash out the rest.
 */
export type Shading = "shared" | "series" | "row";

/** One plotted value. */
export interface ChartPoint {
	/** Value in base units (seconds, bytes, …). */
	readonly value: number;
	/** The number as the table wrote it (`~$250`, `12.5 ms`), shown as the value label. */
	readonly text: string;
	/** The table bolded the cell. */
	readonly emphasis: boolean;
	/** Upper end of a range cell (`24–72 h`). */
	readonly upper?: number;
	/** The spread a `± e` cell states around the value (`3.67s ± 0.69`), drawn as a whisker either side of it. */
	readonly error?: number;
}

/**
 * Which side of its target a value must stay: at or under it (`max`: `≤ 200
 * µs`, a budget, a limit) or at or over it (`min`: `≥ 0.85`, `≥ 700 MB/s`).
 */
export type Bound = "max" | "min";

/**
 * A row's target in a `bullet` chart, as the table wrote it: a value, or a
 * window it must fall in (`60–100 ms`, its {@link ChartPoint.upper}), and the
 * {@link Bound} the measure must keep; absent when neither the cell, the
 * header nor the measure's polarity says which side.
 */
export interface ChartTarget extends ChartPoint {
	readonly bound?: Bound;
}

export interface ChartSeries {
	readonly name: string;
	readonly dim: Dimension;
	/** Currency symbol or rate unit the axis prints; empty for other dimensions. */
	readonly unit: string;
	/** One per category; `null` where the cell holds no number of this series' dimension. */
	readonly points: readonly (ChartPoint | null)[];
	/** Status words standing in for a value (`TIMEOUT`, `OOM`), one per category. */
	readonly notes: readonly (string | undefined)[];
	/** Which way the series improves; absent when neutral. */
	readonly polarity?: Polarity;
	/** Category of the series' best value, marked when its rows are rivals; absent when tied or neutral. */
	readonly best?: number;
}

/** Consecutive categories sharing a leading name, which a label column writes once beside its members. */
export interface ChartGroup {
	/** The shared name; empty for a run of rows outside every group, written as members only. */
	readonly name: string;
	/** The rest of each member category's name, in order; empty where the group's name alone names the row. */
	readonly members: readonly string[];
}

/** The data a chart draws, independent of how it is drawn. */
export interface ChartSpec {
	readonly kind: ChartKind;
	/**
	 * One name per category: the label cell, joined with the cells that tell
	 * repeated labels apart (`Sonnet 5.5 · bash`); without groups, shortened
	 * for display where names stay distinct (`openai/gpt-5.5:xhi` → `gpt-5.5`).
	 */
	readonly categories: readonly string[];
	/**
	 * `categories` nested under their {@link ChartPlan.group} values
	 * (`Sonnet 5.5` → `baseline`, `bash`, `http`), covering them in order; without
	 * a group, under a leading part their names share (`glm new`, `glm prior` →
	 * `glm` → `new`, `prior`). Absent when neither applies, or when each series is a row.
	 */
	readonly groups?: readonly ChartGroup[];
	readonly series: readonly ChartSeries[];
	/**
	 * Numeric x positions of a line, the x measure of a scatter, or each
	 * `timeline` segment's start ({@link ChartPlan.offsets}), one per category.
	 */
	readonly x?: {
		readonly name: string;
		readonly dim: Dimension;
		readonly unit: string;
		readonly values: readonly number[];
	};
	/** Total/summary rows, printed under the chart instead of skewing its scale. */
	readonly caption?: string;
	/** Name of the category axis: the headers of the columns naming the rows. */
	readonly axis: string;
	/** What a `change` measures against (its baseline column); its points are factors of it. */
	readonly baseline?: string;
	/**
	 * The `change` is measured against a rival column — the one leading most rows — rather than a before
	 * state: its bars are gaps to that rival (`+22%` slower than `tsc-rs, 8`), never improvements or regressions.
	 */
	readonly rival?: boolean;
	/** How a heatmap shades its cells; `shared` when absent. */
	readonly shading?: Shading;
	/**
	 * Indices of the categories the others read against ({@link ChartPlan.reference}),
	 * at most one per group: bars and bar grids mark each with a dashed rule at
	 * its value through its group, and single bars print the others' change from it.
	 */
	readonly reference?: readonly number[];
	/** `stacked`: the whole each category's parts make up ({@link ChartPlan.whole}), one point per category. */
	readonly whole?: ChartSeries;
	/**
	 * `stacked`: each bar is its category's mix, parts as percentages of its total; `histogram`: each
	 * distribution as shares of its own total ({@link ChartPlan.normalize}).
	 */
	readonly normalized?: boolean;
	/**
	 * Outcome of each part of a whole, coloring it `success`/`warning`/`error`/
	 * `muted` instead of a series color: per series of a `stacked` chart
	 * (`ok | fail` headers), per category of a `share` (`✅ Resolved`, `❌ Remaining`);
	 * `undefined` for a part naming none. Absent unless most parts read as
	 * statuses ({@link outcomeTones}) and they are not all alike.
	 */
	readonly tones?: readonly (Status | undefined)[];
	/**
	 * `waterfall`: the bar the steps build to — the table's total row as
	 * written, else the steps' sum written like their figures (`~$8.0M`).
	 */
	readonly total?: { readonly name: string; readonly point: ChartPoint };
	/**
	 * `range`: the central estimate of the first series' intervals, one point per category, from a
	 * plotted column whose values all fall inside them (`≈ $6,700` beside `$6.0k–7.3k`); drawn as a tick.
	 */
	readonly estimate?: ChartSeries;
	/**
	 * `bullet`: each category's target ({@link ChartPlan.target}), against the
	 * first series' point; `null` where the row states none in its unit.
	 */
	readonly targets?: readonly (ChartTarget | null)[];
	/** `bullet`: what the targets are called, lowercased from their header (`target`, `budget`, `limit`). */
	readonly targetName?: string;
	/**
	 * The one fact the chart states over it ({@link ChartPlan.title}: `Every
	 * scenario improved (median 14× less)`); no title line without one.
	 */
	readonly title?: string;
	/**
	 * Muted note beside the title. Absent: the renderer writes how the chart
	 * encodes the data where that is not obvious (`log scale`, `scaled per column`).
	 */
	readonly subtitle?: string;
	/**
	 * The two series of a `paired` chart are one quantity before and after
	 * (`a → b` cells, before/after headers per {@link isTransition}): drawn as a
	 * transition — a hollow muted start, a connector fading into the lead color,
	 * a solid end, and the figures as `a → b`. Otherwise the pair are peers
	 * (`xutf` vs `std`, two conditions without an order) drawn in two series
	 * colors without direction. Only condition pairs ({@link isConditionPair} or
	 * the judge's `pair`) draw as `paired` at all. A `ladder`'s two ladders
	 * (`before fix` | `after fix`) by the same reading: the first muted.
	 */
	readonly transition?: boolean;
	/** Marks laid over the chart by a planner: reference lines, highlighted categories, callouts. */
	readonly annotations?: readonly ChartAnnotation[];
	/**
	 * Each series is a table row (a metric in its own unit) and the categories
	 * are the plotted columns ({@link ChartPlan.transpose}); {@link axis} then
	 * names the series rather than the categories.
	 */
	readonly transposed?: boolean;
	/** Which way each category's metric improves where categories are metrics or items moving by a factor (`change`); neutral absent. */
	readonly categoryPolarity?: readonly (Polarity | undefined)[];
	/**
	 * Per category, the series holding its best value where the plotted
	 * columns are rivals sharing a unit and a polarity; absent where tied.
	 */
	readonly leaders?: readonly (number | undefined)[];
	/** Status of each category (`ok`, `FAIL`, `pending`), badged beside its name. */
	readonly status?: readonly (Status | undefined)[];
	/** Header of the column the {@link status} badges come from, named in their key. */
	readonly statusName?: string;
	/**
	 * Status columns the chart does not plot (`Preserves layout? | Machine-parseable? | Renderable?`),
	 * drawn as a matrix of status dots between the row names and the marks, each column headed by its
	 * name; two to {@link MAX_MATRIX}, in place of the single {@link status} badge.
	 */
	readonly matrix?: readonly StatusColumn[];
	/**
	 * `ladder`: the series of each ladder drawn on every category, lowest quantile first; one ladder per
	 * condition measured (`Startup p50 | Startup p95 | Wall p50 | Wall p95`), named by it (empty when
	 * there is one). Each series is named by its quantile (`p50`, `max`).
	 */
	readonly ladders?: readonly ChartLadder[];
}

/** One measurement's quantiles in a `ladder` chart: its name and its series, lowest quantile first. */
export interface ChartLadder {
	readonly name: string;
	readonly series: readonly number[];
}

/** A status column of a {@link ChartSpec.matrix}: its header and each category's status. */
export interface StatusColumn {
	readonly name: string;
	readonly statuses: readonly (Status | undefined)[];
}

/** A fact a chart could state as its title, from {@link tableTakeaways}. */
export interface Takeaway {
	/** What the fact is about (`top:pass%`, `move:Build units`), unique among one chart's takeaways. */
	readonly key: string;
	readonly text: string;
	/** Striking on its figures alone (a large move, a far outlier, a sweep): worth stating without a judge. */
	readonly striking: boolean;
}

/**
 * A mark a planner lays over a chart; the renderer draws each kind where the
 * chart supports it (bar-like kinds and lines) and skips it elsewhere.
 * - `reference`: a dashed rule across the plot at `value` (base units of the
 *   first series), labelled at its end (`budget 200 ms`, `baseline`).
 * - `highlight`: a soft band behind category `category` (an index into
 *   {@link ChartSpec.categories}) and its label set in full strength.
 * - `callout`: short `text` beside the mark of `category` in `series` (default
 *   0) with a leader line (`60× the rest`, `fastest`).
 */
export type ChartAnnotation =
	| {
			readonly kind: "reference";
			readonly value: number;
			readonly label: string;
			/** Series whose axis the value is on, for charts with an axis per unit (`range` bands); 0 by default. */
			readonly series?: number;
	  }
	| { readonly kind: "highlight"; readonly category: number }
	| { readonly kind: "callout"; readonly category: number; readonly series?: number; readonly text: string };

const BEFORE =
	/\b(?:before|old|baseline|base|main|master|prev|previous|original|orig|cold|was|from|v1|stock|default|unpatched|without)\b/i;
const AFTER = /\b(?:after|new|patched|optimi[sz]ed|fixed|warm|now|to|v2|with|proposed|branch|pr|ours)\b/i;
const DELTA = /(?:Δ|delta|change|diff|improvement|speedup|reduction|savings|saved|gain|regression|% chg)/i;
/** Aggregate columns that restate the others; dropped when enough same-unit series remain. */
const AGGREGATE = /^(?:total|sum|cumulative|cum\.?|running total|avg|average|mean)\b/i;
/** The arrow of an `a → b` header or cell, with the spaces around it. */
const ARROW = /\s*(?:→|->|⇒)\s*/;
/** Row labels that name an ordered step (`Run 3`, `Day 2`, `N=1000`, `Q3`). */
const SEQUENCE_LABEL =
	/^(?:(?:run|day|week|month|iter(?:ation)?|round|step|phase|epoch|v|version|n\s*=|wave|attempt|pass|batch)\s*\d+(?:\.\d+)*|q[1-4]|#\s*\d{1,2})\b/i;
const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
/** Distinct series colors (`c1`…`c6`): the most segments a stacked bar tells apart. */
const SERIES_COLORS = 6;
/** Most panels a small-multiples grid stays legible with. */
const MAX_PANELS = 6;
/** Most lines one line chart keeps apart. */
const MAX_LINES = 6;
/** Fewest rows a line joins: three points draw a bend, not a trend. */
const MIN_LINE_ROWS = 4;
/** Fewest points a scatter needs before their cloud can show a relationship. */
const MIN_SCATTER_ROWS = 5;
/** Most series grouped bars hold; more draw as a heatmap. */
const MAX_GROUPED = 4;
/**
 * Spread of a unitless dumbbell's values (max/min) from which its rows read as different quantities, compared
 * by their factors; and of two same-unit series from which grouped bars of them read better as dots.
 */
const DECADES = 100;
/** Typical ratio between two rows from which grouped bars against a baseline column read as its factors. */
const ROW_SPREAD = 8;
/** Ratio between columns' (or rows') typical sizes from which a heatmap shades each on its own. */
const QUANTITY_SPREAD = 30;
/** Typical spread within a row (max/min) a heatmap needs before each row shades on its own. */
const ROW_CONTRAST = 1.5;
/** Words naming a reference row, strongest first. */
const REFERENCE_WORDS = [
	"baseline",
	"control",
	"reference",
	"before",
	"original",
	"stock",
	"default",
	"main",
	"master",
	"current",
];
/** A row name saying it is the reference: leading the name (`baseline`, `current-api …`) or marked (`#1 (baseline)`). */
const REFERENCE_ROW = new RegExp(
	String.raw`^(?<lead>${REFERENCE_WORDS.join("|")})\b|\((?<marked>${REFERENCE_WORDS.join("|")})\)`,
	"i",
);
/** Most series a `progress` pick draws as tracks per category; more read as bars or a heatmap. */
const MAX_TRACKS = 3;
/** Smallest factor (either way) that makes a `change` chart say more than its table. */
const NOTABLE_FACTOR = 1.5;
/** Joins the parts of a row's name (`Sonnet 5.5 · bash`). */
const NAME_JOIN = " · ";
/** Longest cell a column may hold to help name its row; longer text describes the row rather than naming it. */
const MAX_NAME_PART = 40;
/** Longest row name {@link tidyNames} leaves whole: the renderer's label budget. */
const MAX_LABEL = 28;
/** Shortest leading part {@link nestNames} writes as a group name (`glm`, not `A`). */
const MIN_NEST_HEAD = 3;
/** Share of rows {@link nestNames} must nest for an outline to read better than flat names. */
const NEST_SHARE = 0.6;
/** Text a row's prose columns hold (by their median cells) from which the prose carries the table ({@link proseLed}). */
const PROSE_CELL = 40;
/** Largest whole number a chart may plot beside a table's prose and still restate it ({@link proseLed}). */
const MAX_PROSE_COUNT = 5;
/** Where a row name splits into a group and a member, most telling first (`char index, emoji`, `glm new`, `sofa-arm`). */
const NEST_SEPARATORS = [" — ", " – ", ": ", " · ", ", ", " ", "/", "-", "_"];
/** Where a long row name's description starts (`Payroll (10 people…)`, `@watzon — #19, #53`). */
const DESCRIPTION = / [—–] | - |: | \(/;

/**
 * Measures that improve upward, by header: pass and success rates, retrieval
 * scores, throughput, speedups and savings.
 */
const HIGHER_BETTER =
	/(?:^|[^\w])(?:pass(?:ed|es|ing)?|pass ?%|pass ?rate|success(?:es|ful)?|succeeded|accuracy|acc|recall|precision|prec|f1|em|exact[_ ]?match|scores?|wins?|win ?rate|hit ?rate|throughput|qps|rps|ops\/s|req\/s|tok\/s|tokens\/s|speedup|faster|improvement|savings?|saved|gain|coverage|quality|relevance|correct|solved|ok|renders|completion ?rate|uptime|performance|profits?|roi|pnl|growth|per \$|\/\$)(?![\w])/i;
/** Measures that improve downward, by header: cost, time, failures. */
const LOWER_BETTER =
	/(?:^|[^\w])(?:cost|costs|price|bill|spend|usd|latency|time|duration|wall(?: ?clock)?|elapsed|errors?|err|fail(?:s|ed|ures?)?|timeouts?|miss(?:es)?|crash(?:es)?|regressions?|bugs?|warnings?|retries|turns|p\d{2}|blockers|violations|leaks?|stalls?|load|\$\/\w+)(?![\w])/i;
/** Resources a before/after change aims to shrink: lower is better only beside a baseline. */
const LOWER_IN_CHANGE =
	/(?:^|[^\w])(?:tokens?|tok|rss|memory|mem|heap|allocs?|allocations?|clones|size|bytes|cpu|gc|input|output)(?![\w])/i;
/** Names of shares and counts that describe rather than score: no polarity whatever else they say. */
const NEUTRAL = /(?:^|[^\w])(?:share|shares|% of|portion|fraction|distribution|breakdown)(?![\w])/i;
/** Label headers naming rival options a table compares (models, configs, arms). */
const RIVALS =
	/(?:^|[^\w])(?:models?|config(?:uration)?s?|arms?|variants?|approach(?:es)?|options?|plans?|polic(?:y|ies)|providers?|modes?|strateg(?:y|ies)|candidates?|settings?|shapes?|backends?|engines?|librar(?:y|ies)|implementations?|vendors?|tools?|methods?|algorithms?|setups?|runs?)(?![\w])/i;
/** Label headers naming the ordered steps of one run (`Step`, `CI stage`, `Phase`): their durations lie end to end. */
const STEP_HEADER = /^(?:(?:ci|pipeline|build|job|run)\s+)?(?:steps?|stages?|phases?)(?:\s+name)?$/i;
/** Headers of a column holding where each row starts on a shared axis (`Offset`, `Start`, `Address`). */
const OFFSET_HEADER = /^(?:(?:byte|vertex|index|file|start)\s+)?(?:offset|start|begin|addr(?:ess)?)(?:\s*\(.*\))?$/i;
/** Label headers naming parts one sum is made of (`Bucket`, `Line item`, `Expense`). */
const PART_HEADER =
	/^(?:buckets?|(?:line\s+)?items?|components?|categor(?:y|ies)|expenses?|costs?|allocations?|use of funds|parts?|breakdown)$/i;
/** Amounts per unit (`Price`, `$/1M tok`, `Avg cost`): no sum of them means anything. */
const PER_UNIT = /\/|\bper\b|\bprice\b|\brate\b|\bavg\b|\baverage\b|\bmean\b|\beach\b|\bunit\b|\bmedian\b|\bp\d{2}\b/i;
/** A last row naming the cap a plan's steps build toward (`Hard cap`, `Budget`, `Limit`). */
const LIMIT_ROW = /\b(?:cap|limit|budget|ceiling|allowance|quota)\b/i;
/** Dimensions whose rows add up along one axis. */
const FLOW_DIMS: Partial<Record<Dimension, true>> = { count: true, duration: true, bytes: true, currency: true };
/** Most steps a waterfall or a timeline of consecutive rows keeps legible. */
const MAX_STEPS = 12;
/** Most segments a timeline at explicit offsets lays out (named in groups where names share a part). */
const MAX_SEGMENTS = 40;
/** Share of a run one step may take before the rest shrink to slivers: bars read such a table better. */
const MOST_OF_RUN = 0.9;
/** A row name drawn as a branch of a tree (`└ full clone`, `├─ parse`, `↳ retry`) or indented under another. */
const TREE_NAME = /^(?:\s|&nbsp;|\u00a0)*[└├↳┗┣╰]|^(?:&nbsp;|\u00a0){2,}/;
/** A step named as a total the table's total rows miss (`total_ms`, `Overall`): the rows are no flat run. */
const TOTAL_NAME = /^(?:total|overall|grand|sum)(?:\b|_)/i;
/** A row name saying it is the whole of others (`End-to-end wall`, `All tests`, `Overall`). */
const WHOLE_NAME = /\b(?:total|overall|all|whole|end[- ]to[- ]end|wall(?:[- ]?clock)?|combined|sum)\b/i;
/** Steps per rise a descending list of parts may hold and still read as a ranking. */
const RANKED_RISES = 8;
/** Row names marking one of several variants of the same step (`(before)`, `(new)`). */
const VARIANT_NAME = /\b(?:before|after|old|new|baseline|current|cold|warm)\b/i;
/** Count headers naming a quantity that builds up (`Tokens`, `Lines saved`), not things counted. */
const AMOUNT_HEADER =
	/\b(?:tokens?|lines?|loc|sloc|chars?|characters|words|bytes|calls|requests|cost|spend|budget|amount)\b/i;
/** Share of an offset column's rows that must start where the row before ends for it to lay them out. */
const CONTIGUOUS = 0.75;
/** Row names that point at the row a table is about. */
const FOCUS_NAME =
	/\((?:current|ours|recommended|chosen|selected|winner|best|shipped|proposed|pick)\b[^)]*\)|(?:^|[^\w])(?:ours|recommended)(?![\w])|[✅⭐★]/i;

/** The local best guess at a chart for `table`, or `undefined` when no chart fits. */
export function planChart(table: TableAnalysis): ChartPlan | undefined {
	const guessed = guessShape(table);
	// Two conditions on a few metrics read as a comparison where no chart of the rows would.
	const drawn = guessed && buildChart(table, guessed);
	const shape = (drawn && worthCharting(drawn) ? undefined : statShape(table, guessed)) ?? guessed;
	if (!shape) return undefined;
	const plan = { ...shape, ...guessMeaning(table, shape) };
	// Unprompted, a title states only a fact the figures alone make striking.
	const lead = tableTakeaways(table, plan).find(fact => fact.striking);
	return lead ? { ...plan, title: lead.text } : plan;
}

/**
 * Whether a model should pick `table`'s chart (`tui.autoGraph: smart`):
 * multi-series tables, and tables whose rows may be named by a number the
 * `guess` plots (`Thread | State`, `Finding | Current`), where only meaning
 * tells a name from a measure.
 */
export function shouldJudge(table: TableAnalysis, guess: ChartPlan | undefined): boolean {
	if (!guess || table.rows.length < 3) return false;
	return table.measures.length >= 2 || leadingMeasures(table, guess).length > 0;
}

/** Measure columns before `guess`'s text label column: numbers that may only name their rows. */
export function leadingMeasures(table: TableAnalysis, guess: ChartPlan): TableColumn[] {
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	if (label?.role !== "label") return [];
	return table.measures.filter(column => column.index < label.index);
}

/**
 * Facts about `table` a chart could state as its headline under `plan`'s
 * meaning, strongest first: those of the chart `plan` draws (its moves, its
 * trend), and of measures side by side, under each of `contests` (`plan`'s
 * own {@link ChartPlan.rivals} by default; a judge is offered either reading's).
 * `scope` says which measures stand side by side: `drawn` (the default, what
 * a title may state) only those the chart draws ({@link drawnNames}) — a
 * headline citing a column the chart leaves out (`Total` beside a chart of
 * `vs current`) names a figure the reader cannot find on it; `table` every
 * measure (a row best on measures the chart leaves out), the options a judge
 * weighs while it may still pick a chart drawing them.
 */
export function tableTakeaways(
	table: TableAnalysis,
	plan: ChartPlan,
	contests: readonly (Rivals | undefined)[] = [plan.rivals],
	scope: "drawn" | "table" = "drawn",
): Takeaway[] {
	const measures = table.measures.filter(column => column.index !== plan.label);
	// A slope's stages are one quantity: bars beside the rest (`Tokens In`) would read them as rival measures;
	// a bullet's measure and its targets are no rivals either (`p50 / p99` is not "best" against `Target`),
	// nor a ladder's quantiles or a histogram's distributions over one set of bins.
	const wide = !(
		plan.kind === "change" ||
		plan.kind === "slope" ||
		plan.kind === "bullet" ||
		plan.kind === "ladder" ||
		plan.kind === "histogram" ||
		plan.transpose
	);
	const facts: Fact[] = [];
	for (const rivals of contests) {
		const drawn = buildChart(table, { ...plan, rivals });
		if (drawn) facts.push(...chartFacts(drawn));
		let beside: readonly TableColumn[] = [];
		if (scope === "table") beside = measures.length > plan.series.length ? measures : [];
		else if (drawn && sideBySide(drawn)) {
			const names = drawnNames(drawn);
			beside = measures.filter(column => names.has(column.header));
		}
		// Parts of a whole stand side by side for their extremes (one row holding most of a part), never as rivals.
		const contest = scope === "drawn" && drawn?.kind === "stacked" ? undefined : rivals;
		const side =
			wide &&
			beside.length >= 2 &&
			buildChart(table, { ...plan, rivals: contest, kind: "grouped", series: beside.map(column => column.index) });
		if (side) facts.push(...chartFacts(side));
	}
	return rankFacts(facts);
}

/**
 * Whether ranking a chart's drawn measures side by side adds facts its own leave out: a scatter's
 * axes, a line's series, a stack's parts (their extremes only), a range chart's bands. Bars rank their
 * series already; a before/after pair's story is its move; steps of a run are no rivals.
 */
function sideBySide(spec: ChartSpec): boolean {
	if (spec.kind === "scatter" || spec.kind === "line" || spec.kind === "stacked") return true;
	// Two peers on one dumbbell already say who leads ({@link peerFacts}); intervals of several measures rank apart.
	return spec.kind === "range" && !spec.transition;
}

/**
 * What a chart draws, by name: its series, its x measure (not the row names a line runs along), the
 * whole its parts stack to and the baseline its factors are of — the columns (or, transposed, rows) a
 * headline may cite.
 */
export function drawnNames(spec: ChartSpec): Set<string> {
	const names = new Set(spec.series.map(entry => entry.name));
	for (const name of [spec.x?.name, spec.whole?.name, spec.baseline]) if (name && name !== spec.axis) names.add(name);
	return names;
}

/**
 * The local guess at what `plan`'s rows and measures mean: header keywords
 * for each measure's {@link Polarity} (resources like tokens or memory only
 * beside a baseline), rivals from the label's header, focus from bolded or
 * `(current)` row names, and a status column whose cells vary.
 */
export function guessMeaning(
	table: TableAnalysis,
	plan: ChartPlan,
): Pick<ChartPlan, "polarity" | "rowPolarity" | "rivals" | "focus" | "status"> {
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	// A comparison of two conditions reads resources (tokens, memory) the way a change does.
	const change =
		plan.kind === "change" || plan.kind === "stat" || table.columns.some(column => BEFORE.test(column.header));
	const polarity: Record<number, Polarity> = {};
	for (const column of table.columns) {
		if (column === label) continue;
		// A signed delta's sign convention (saved vs. spent) is not in its unit.
		const delta = DELTA.test(column.header) || column.signedShare >= 0.5;
		const guessed =
			headerPolarity(column.header, change) ??
			(column.role === "measure" && !delta
				? dimPolarity(column.dim, column.unit, change, column.scores)
				: undefined);
		if (guessed) polarity[column.index] = guessed;
	}
	const rowPolarity: Record<number, Polarity> = {};
	if (label && rowsAreMetrics(table, plan))
		for (const row of [...table.rows, ...table.totals]) {
			const first = plan.series.map(index => table.columns[index]!.cells[row]).find(isNumber);
			const guessed =
				headerPolarity(label.cells[row]!.text, true) ??
				(first ? dimPolarity(first.dim, first.unit, true, false) : undefined);
			if (guessed) rowPolarity[row] = guessed;
		}
	return {
		polarity,
		rowPolarity,
		rivals: label !== undefined && RIVALS.test(label.header) ? "rows" : undefined,
		focus: guessFocus(table, label),
		status: guessStatus(table, plan),
	};
}

/** Whether `plan`'s rows may each be a metric of their own: a `change`, a transposed table, or mixed-unit columns. */
export function rowsAreMetrics(table: TableAnalysis, plan: ChartPlan): boolean {
	return plan.kind === "change" || plan.transpose || plan.series.some(index => table.columns[index]?.mixed);
}

/**
 * A measure's {@link Polarity} from its name (`undefined` when it names
 * none); `change` admits resources a change aims to shrink.
 */
function headerPolarity(name: string, change: boolean): Polarity | undefined {
	// `gtTagRelevance`: camelCase words read apart.
	const plain = plainCell(name).text.replace(/([a-z])([A-Z])/g, "$1 $2");
	if (NEUTRAL.test(plain)) return undefined;
	if (HIGHER_BETTER.test(plain)) return "higher";
	if (LOWER_BETTER.test(plain)) return "lower";
	if (change && LOWER_IN_CHANGE.test(plain)) return "lower";
	return undefined;
}

/**
 * A measure's {@link Polarity} from its unit when its name gives none:
 * scores out of a total and rates per second climb, durations shrink, and
 * money and sizes shrink beside a baseline.
 */
function dimPolarity(dim: Dimension | undefined, unit: string, change: boolean, scores: boolean): Polarity | undefined {
	if (scores) return "higher";
	if (dim === "rate" && unit.endsWith("/s")) return "higher";
	if (dim === "duration") return "lower";
	// Money and sizes may be value or budget (`Per 30 days`, `Amount`); beside a baseline they are what a change cuts.
	if ((dim === "currency" || dim === "bytes") && change) return "lower";
	return undefined;
}

/**
 * Rows the table singles out: a minority of rows whose names (or most of
 * whose numbers) are bolded, else rows named `(current)`, `(recommended)`, ✅.
 */
function guessFocus(table: TableAnalysis, label: TableColumn | undefined): number[] {
	const { rows } = table;
	if (!label || rows.length < 2) return [];
	const measures = table.measures;
	const bolded = rows.filter(row => {
		if (label.cells[row]!.emphasis) return true;
		const numbers = measures.map(column => column.cells[row]).filter(isNumber);
		return numbers.length >= 2 && numbers.filter(cell => cell.emphasis).length * 2 > numbers.length;
	});
	if (bolded.length > 0 && bolded.length * 3 <= rows.length + 1) return bolded;
	const named = rows.filter(row => FOCUS_NAME.test(label.cells[row]!.text));
	return named.length > 0 && named.length * 3 <= rows.length + 1 ? named : [];
}

/** A text or measure column (not naming the rows) whose cells lead with statuses that are not all alike. */
function guessStatus(table: TableAnalysis, plan: ChartPlan): number | undefined {
	const naming = new Set([plan.label, ...(plan.qualifiers ?? [])]);
	return table.columns.find(column => {
		if (naming.has(column.index) || !column.statuses) return false;
		const seen = new Set(table.rows.map(row => column.statuses![row]).filter(Boolean));
		return seen.size >= 2;
	})?.index;
}

/** The local guess at a chart's kind, label and series for `table`. */
function guessShape(table: TableAnalysis): ChartPlan | undefined {
	const { rows } = table;
	let label = table.label;
	// A column of targets (`Target ≤ 200 µs`, `§6 budget`) is what each row's measure is read against.
	const held = findTarget(table);
	if (held)
		return {
			kind: "bullet",
			label: label?.index,
			...guessNaming(table, label),
			series: [held.measured.index],
			target: held.target.index,
			transpose: false,
		};
	// Quantiles of one measurement (`p50 | p90 | p99`, `p50 / p99` cells) are its distribution, whatever
	// before/after pairing their headers make; read against per-row targets they are a bullet (above).
	const ladders = tableLadders(table, label?.index);
	if (ladders)
		return {
			kind: "ladder",
			label: label?.index,
			...guessNaming(table, label),
			series: ladderColumns(ladders),
			transpose: false,
		};
	const change = changeColumns(table);
	if (change)
		return {
			kind: "change",
			label: label?.index,
			...guessNaming(table, label),
			series: change.map(column => column.index),
			transpose: false,
		};
	const pairs = metricPairs(table.measures);
	if (pairs.length >= 2)
		return {
			kind: "change",
			label: label?.index,
			...guessNaming(table, label),
			series: pairs.map(([, after]) => after.index),
			baselines: pairs.map(([before]) => before.index),
			transpose: false,
		};
	let measures = dropAggregates(table.measures, rows);
	if (measures.length === 0 || rows.length < 2) return undefined;

	let order = axisOrder(table, label);
	// Without a name column, a monotonic leading measure (`Workers | p50 | p99`) is the
	// x axis of the rest (the name of each row, under four rows); beside one it is just
	// a sorted measure (`% | Self | Function`).
	if (!order && label?.role !== "label" && measures.length >= 2 && measures[0]!.index === 0) {
		const xs = columnValues(measures[0]!, rows);
		if (xs.length === rows.length && isMonotonic(xs)) {
			label = measures[0];
			measures = measures.slice(1);
			if (rows.length >= 4) order = "numeric";
		}
	}
	if (proseLed(table, measures)) return undefined;
	// `Metric | Value`: each row is a quantity of its own (`events`, `total saved`, `median`); one axis
	// would set unlike things side by side. Their `a → b` cells still chart, as factors of change.
	if (
		measures.length === 1 &&
		measures[0]!.arrowShare < 0.6 &&
		label?.role === "label" &&
		METRIC_HEADER.test(label.header.trim())
	)
		return undefined;
	const naming = guessNaming(table, label);
	const reference = guessReference(table, label, naming.qualifiers);
	const plan = (kind: ChartKind, series: readonly TableColumn[], transpose = false): ChartPlan => ({
		kind,
		label: label?.index,
		...naming,
		...(reference && { reference }),
		series: series.map(column => column.index),
		transpose,
	});
	// Counts over ordered bins (`1 | 2–5 | 6–20 | 100+`) are a distribution, whatever axis their bins make.
	const histogram = histogramColumns(table, measures);
	if (histogram)
		return {
			...plan("histogram", histogram.counts),
			label: histogram.bins.index,
			...guessNaming(table, histogram.bins),
		};

	// `a → b` cells: one axis when the rows share a unit, factors of change when each row has its own.
	if (measures.length === 1 && measures[0]!.arrowShare >= 0.6)
		return plan(measures[0]!.mixed ? "change" : "paired", measures);
	// Several `a → b` columns (`mean before → after | p99 before → after`): each moves by its own factor.
	const arrows = measures.filter(column => column.arrowShare >= 0.6);
	if (arrows.length >= 2) return plan("change", arrows);
	const composition = table.composition;
	if (composition && composition.parts.every(index => index !== label?.index))
		return {
			...plan(
				"stacked",
				composition.parts.map(index => table.columns[index]!),
			),
			whole: composition.whole,
		};
	// Outcome counts (`ok | fail`, `Pass | Fail | Skip`) are parts of each row's attempts even without a total column.
	const outcomes = outcomeColumns(measures);
	if (outcomes) return plan("stacked", outcomes);
	// Amounts beside their shares of the whole (`Lines | Share`) split into more parts than one share bar holds
	// build up as the amounts: a waterfall prints each step's share itself.
	const flowing =
		rows.length > MAX_SHARE_PARTS ? measures.map(column => amountBehind(table, column) ?? column) : measures;
	const flow = guessFlow(table, label, flowing);
	if (flow)
		return {
			...plan(flow.kind, [flow.column]),
			...(flow.offsets !== undefined && { offsets: flow.offsets }),
			...(flow.limit !== undefined && { limit: flow.limit }),
		};
	const mixed = measures.filter(column => column.mixed);
	if (mixed.length > 0 && mixed.length * 2 >= measures.length) return plan("multiples", measures, true);
	// Values written as `a–b` float from low to high: a bar from zero would hide where each interval starts.
	// Most measures must be among them; otherwise panels keep the other quantities.
	const ranges = rangeColumns(measures, rows);
	if (ranges && ranges.length * 2 > measures.length) return plan("range", ranges);

	const dims = new Set(measures.map(column => column.dim));
	// One quantity across three or four stages (`Baseline | Iter 1 | Iter 2`): a line per row through them.
	const stages = stageColumns(measures, rows);
	if (stages) return plan("slope", stages);
	// Opposing amounts (`Added | Removed`, `Wins | Losses`): back to back, each row's net beside it.
	const opposed = opposedColumns(measures);
	if (opposed) return plan("butterfly", opposed);
	if (measures.length >= 2 && measures.length <= 4) {
		const before = measures.find(column => BEFORE.test(column.header));
		const after = measures.find(
			column => column !== before && column.dim === before?.dim && AFTER.test(column.header),
		);
		// Rows spanning decades (each a metric of its own: `Benchmark time | Render targets`) read as factors of the
		// before column; a middle condition (`last build`) between the two moves too.
		if (before && after && beforeAfter(table, [before, after]))
			return plan(
				"change",
				measures.filter(
					column =>
						column.dim === before.dim &&
						column.index >= Math.min(before.index, after.index) &&
						column.index <= Math.max(before.index, after.index),
				),
			);
		if (before && after) return plan("paired", [before, after]);
	}
	if (rows.length === 2 && measures.length === 1) return undefined;
	if (order && rows.length >= MIN_LINE_ROWS) {
		const lead = measures[0]!.dim;
		return plan("line", measures.filter(column => column.dim === lead).slice(0, MAX_LINES));
	}
	// Several score columns compare like any same-unit measures (as rates); a lone one fills tracks.
	if (measures.length === 1 && measures[0]!.scores) return plan("progress", measures);
	if (measures.length <= 2) {
		const delta = measures.find(
			column =>
				(column.signedShare >= 0.6 || DELTA.test(column.header)) &&
				columnValues(column, rows).some(value => value < 0),
		);
		if (delta) return plan("diverging", [delta]);
	}
	const share = measures.find(column => column.dim === "percent" && !column.scores);
	if (
		share &&
		rows.length <= MAX_SHARE_SEGMENTS &&
		(measures.length === 1 || (measures.length === 2 && dims.size === 2))
	) {
		const values = columnValues(share, rows);
		const sum = values.reduce((total, value) => total + value, 0);
		if (values.every(value => value >= 0) && sum >= 97 && sum <= 103) return plan("share", [share]);
	}
	if (measures.length === 1 && splitsTotal(table, label, measures[0]!)) return plan("share", measures);
	if (dotsFit(measures, rows)) return plan("dots", measures);
	if (dims.size === 1 && measures.length >= 4 && rows.length >= 3)
		return { ...plan("heatmap", measures), shading: guessShading(measures, rows) };
	if (!label && measures.length === 2 && rows.length >= 6) return plan("scatter", measures);
	// Columns of one unit lying {@link QUANTITY_SPREAD}× apart count different things (`Tests` beside `Tokens`);
	// timings and sizes spanning decades are one measurement, which dots placed on a log axis above.
	if (dims.size >= 2 || (!DOT_DIMS.has(measures[0]!.dim ?? "count") && guessShading(measures, rows) === "series"))
		return plan("multiples", measures.slice(0, MAX_PANELS));
	if (measures.length === 2)
		return plan(isConditionPair(measures[0]!.header, measures[1]!.header) ? "paired" : "grouped", measures);
	if (measures.length >= 3) return plan("grouped", measures);
	return plan("bar", measures);
}

/** Label headers saying each row is a metric of its own (`Metric`, `Stat`, `Measure`). */
const METRIC_HEADER = /^(?:metrics?|measures?|stats?|statistics?|quantit(?:y|ies))$/i;
/** Most parts a count column may split its total into and still draw as one bar. */
const MAX_SHARE_PARTS = 6;
/** Most segments one share bar keeps legible; more parts read as bars (a planner's `share` pick included). */
export const MAX_SHARE_SEGMENTS = 10;

/**
 * The amount column a share column restates (`Lines of Rust` behind `Share`, dropped from the measures in
 * favor of its shares), when it is an amount that builds up; else `undefined`.
 */
function amountBehind(table: TableAnalysis, share: TableColumn): TableColumn | undefined {
	if (share.dim !== "percent" || share.scores) return undefined;
	return table.columns.find(
		column => column.restates === share.index && column.dim !== undefined && FLOW_DIMS[column.dim],
	);
}

/** Relative slack between a total row and its parts' sum where either is written as an estimate (`~3900`). */
const APPROX_SUM = 0.02;
/** Headers that only say a column counts something (`count`, `n`, `#`). */
const COUNT_HEADER = /^(?:count|counts|cnt|n|#|number|num|items|tally|freq|frequency)$/i;
/** Label headers naming a classification of one population, each row one bucket of it (`Severity`, `Verdict`). */
const BUCKET_HEADER =
	/^(?:status|state|verdict|outcome|result|severity|priority|bucket|cohort|category|class|type|kind|tier|level|grade|cause|reason|disposition|resolution)$/i;

/**
 * Whether `column`'s counts split one total among its rows, so their shares of
 * it are the point (`ported 248 | redesigned 125 | … | missing 786`): 3 to
 * {@link MAX_SHARE_PARTS} rows of whole counts, and either a total row the
 * counts add up to (exactly, or within {@link APPROX_SUM} where one is written
 * `~`), or a label header naming buckets ({@link BUCKET_HEADER}, or none)
 * beside a count header ({@link COUNT_HEADER}, or none).
 */
function splitsTotal(table: TableAnalysis, label: TableColumn | undefined, column: TableColumn): boolean {
	const { rows } = table;
	if (label?.role !== "label" || column.dim !== "count" || column.unit || column.scores) return false;
	if (rows.length < 3 || rows.length > MAX_SHARE_PARTS) return false;
	const values = columnValues(column, rows);
	if (values.length !== rows.length || values.some(value => value < 0 || !Number.isInteger(value))) return false;
	if (values.filter(value => value > 0).length < 2) return false;
	const sum = values.reduce((total, value) => total + value, 0);
	const approx = rows.some(row => {
		const cell = column.cells[row];
		return isNumber(cell) && cell.approx;
	});
	const totalled = table.totals.some(row => {
		const cell = column.cells[row];
		return isNumber(cell) && Math.abs(cell.value - sum) <= (approx || cell.approx ? APPROX_SUM * sum : 0.5);
	});
	return (
		totalled ||
		((!label.header || BUCKET_HEADER.test(label.header)) && (!column.header || COUNT_HEADER.test(column.header)))
	);
}

/**
 * Same-unit count or percent measures whose headers each lead with an outcome
 * (`ok | fail`, `Pass | Partial | Fail`) of more than one kind: the parts of
 * each row's attempts, read as its mix.
 */
export function outcomeColumns(measures: readonly TableColumn[]): TableColumn[] | undefined {
	const first = measures.find(column => cellStatus(column.header));
	if (!first || (first.dim !== "count" && first.dim !== "percent") || first.scores) return undefined;
	const parts = measures.filter(
		column =>
			column.dim === first.dim &&
			column.unit === first.unit &&
			!column.scores &&
			column.signedShare === 0 &&
			cellStatus(column.header),
	);
	return parts.length >= 2 && outcomeTones(parts.map(column => column.header)) ? parts : undefined;
}

/** Share of parts that must read as outcomes before the parts take outcome colors. */
const TONED_SHARE = 2 / 3;

/**
 * The outcome each of `names` leads with (`ok`, `FAIL`, ✅, or none) when at
 * least {@link TONED_SHARE} of them lead with one, `good` and something else
 * among them: parts colored by what they say rather than by series
 * (`✅ FIXED | 🟡 PARTIAL | 🎨 VISUAL? | ❌ OPEN`). `undefined` otherwise.
 */
export function outcomeTones(names: readonly string[]): (Status | undefined)[] | undefined {
	const tones = names.map(name => cellStatus(name));
	const said = tones.filter(tone => tone !== undefined);
	if (said.length < 2 || said.length < TONED_SHARE * tones.length) return undefined;
	return said.includes("good") && said.some(tone => tone !== "good") ? tones : undefined;
}

/** Rows read as one run of steps: the kind, the plotted column, and any offset column or cap row. */
interface Flow {
	readonly kind: "timeline" | "waterfall";
	readonly column: TableColumn;
	readonly offsets?: number;
	readonly limit?: number;
}

/**
 * Rows that lie end to end on one axis, read from the values and headers:
 * - parts at an offset column (`Offset` 0, 16, 20 beside `Verts` 16, 4, 8) — a `timeline` at those offsets;
 * - durations of a run's steps (a `Step`/`Stage`/`Phase` label, a total row they sum to, or a running
 *   `Cumulative` column) — a `timeline` in table order;
 * - amounts building to a total row they sum to, toward a cap row (`Hard cap`), beside a running total, or
 *   listed as parts (`Bucket`, `Line item`) — a `waterfall`.
 * Shares (percent) stay `share`; amounts per unit (`Price`) and deltas without a total never add up.
 */
function guessFlow(
	table: TableAnalysis,
	label: TableColumn | undefined,
	measures: readonly TableColumn[],
): Flow | undefined {
	const { rows } = table;
	if (label?.role !== "label" || rows.length < 3) return undefined;
	if (rows.length <= MAX_SEGMENTS)
		for (const offsets of table.columns) {
			if (offsets === label || !OFFSET_HEADER.test(offsets.header)) continue;
			const size = measures.find(column => column !== offsets && laidOut(offsets, column, rows));
			if (size) return { kind: "timeline", column: size, offsets: offsets.index };
		}
	// A running column beside its steps (`Time | Cumulative`) restates them, within the precision written.
	let steps = measures.filter(column => !measures.some(other => other !== column && endsOf(column, other, rows)));
	// Beside counts of things (`Files`), the leading amount that builds up (`Lines`, `$`, bytes) is the run — when
	// no other column builds up beside it and a total row vouches for it below.
	const led = steps.length > 1;
	if (led) {
		const [lead, ...rest] = steps;
		// A few parts beside their shares (`Tokens | Share`) read as one share bar.
		const shared = rows.length <= MAX_SHARE_PARTS && rest.some(other => other.dim === "percent");
		steps = !shared && buildsUp(lead!) && lead!.dim !== "duration" && !rest.some(buildsUp) ? [lead!] : [];
	}
	if (steps.length !== 1) return undefined;
	const column = steps[0]!;
	const running =
		steps.length < measures.length ||
		table.columns.some(other => other.restates === column.index && endsOf(other, column, rows));
	if (!column.dim || !FLOW_DIMS[column.dim] || column.scores || column.mixed || PER_UNIT.test(column.header))
		return undefined;
	const cells = rows.map(row => flowCell(column, row));
	if (cells.some(cell => !cell)) return undefined;
	const values = cells.map(cell => cell!.value);
	const negative = values.some(value => value < 0);
	const totalRow = table.totals.find(row => flowCell(column, row));
	const sums = totalRow !== undefined && addsUp(cells as NumberCell[], flowCell(column, totalRow)!);
	// A total the rows miss is a subset or overlapping parts, not one run.
	if ((totalRow !== undefined || led) && !sums) return undefined;
	const last = rows.at(-1)!;
	// A cap stands above every step it caps (`Hard cap` $9.50 over `Video` $5.10).
	const capped =
		column.dim !== "duration" &&
		!negative &&
		!sums &&
		rows.length >= 4 &&
		LIMIT_ROW.test(label.cells[last]!.text) &&
		values.at(-1)! >= Math.max(...values.slice(0, -1));
	const run = (capped ? cells.slice(0, -1) : cells) as NumberCell[];
	if (run.length > MAX_STEPS) return undefined;
	// No one step may be nearly all of the run; without a total row to vouch for them, steps must be flat
	// parts (no row summing others: `Evaluated` over `Landed` and `Rejected`).
	const sizes = run.map(cell => Math.abs(cell.value));
	const names = rows.map(row => label.cells[row]!.text);
	if (
		Math.max(...sizes) > MOST_OF_RUN * sizes.reduce((a, b) => a + b, 0) ||
		names.some(name => TOTAL_NAME.test(name)) ||
		(!sums && nested(run, names))
	)
		return undefined;
	if (column.dim === "duration") {
		// Before/after variants of one step (`js-release (before)`, `(after)`) are alternatives, and a total per
		// row (`Total wall` after each change) a state, not a run.
		const variants = names.filter(name => VARIANT_NAME.test(name)).length;
		if (negative || variants >= 2 || WHOLE_NAME.test(column.header)) return undefined;
		return STEP_HEADER.test(label.header) || sums || running ? { kind: "timeline", column } : undefined;
	}
	// Amounts that build up: money, sizes, and counts of a quantity (tokens, lines), not of things (issues, PRs).
	if (!buildsUp(column)) return undefined;
	// Listed parts alone (`Bucket | Amount`) in descending order (one rise in eight steps allowed) are a
	// ranking: bars read it.
	const rises = values.filter((value, at) => at > 0 && value > values[at - 1]!).length;
	const parts = !negative && PART_HEADER.test(label.header) && rises * RANKED_RISES > values.length - 1;
	if (!(sums || capped || running || parts)) return undefined;
	return { kind: "waterfall", column, ...(capped && { limit: last }) };
}

/** `column` holds amounts that add up along one axis: money, sizes, times, and counts of a quantity (tokens, lines). */
function buildsUp(column: TableColumn): boolean {
	if (!column.dim || !FLOW_DIMS[column.dim]) return false;
	return column.dim !== "count" || AMOUNT_HEADER.test(column.header);
}

/**
 * Rows over more than one level of parts: names drawn as a tree (`└ full
 * clone`), or a row named as a whole (`End-to-end wall`) summing two or more
 * rows right after (or right before) it within written precision.
 */
function nested(cells: readonly NumberCell[], names: readonly string[]): boolean {
	if (names.some(name => TREE_NAME.test(name))) return true;
	return cells.some(
		(parent, at) =>
			WHOLE_NAME.test(names[at] ?? "") &&
			[1, -1].some(direction => {
				const run: NumberCell[] = [];
				for (let next = at + direction; next >= 0 && next < cells.length; next += direction) {
					run.push(cells[next]!);
					if (run.length >= 2 && addsUp(run, parent)) return true;
				}
				return false;
			}),
	);
}

/** The cell of `column` at `row` as one plain number of the column's dimension (no range or transition). */
function flowCell(column: TableColumn, row: number): NumberCell | undefined {
	const cell = column.cells[row];
	return isNumber(cell) && cell.dim === column.dim && cell.upper === undefined && cell.to === undefined
		? cell
		: undefined;
}

/** `cells` sum to `total` within the precision they were written in. */
function addsUp(cells: readonly NumberCell[], total: NumberCell): boolean {
	const sum = cells.reduce((acc, cell) => acc + cell.value, 0);
	const slack = cells.reduce((acc, cell) => acc + writtenSlack(cell), writtenSlack(total));
	return Math.abs(sum - total.value) <= slack + 1e-9 * Math.abs(total.value);
}

/**
 * `offsets` places each row of `size` on one axis: both plain numbers of one
 * dimension in every row, starts never falling back, and at least
 * {@link CONTIGUOUS} of the rows starting where the one before ends (`Offset`
 * 0, 16, 20 beside `Verts` 16, 4, 8); a gap or a slip between parts may stay.
 */
function laidOut(offsets: TableColumn, size: TableColumn, rows: readonly number[]): boolean {
	if (offsets.dim !== size.dim) return false;
	const starts = rows.map(row => flowCell(offsets, row));
	const sizes = rows.map(row => flowCell(size, row));
	if (starts.some(cell => !cell) || sizes.some(cell => !cell || cell.value < 0)) return false;
	let contiguous = 0;
	for (let at = 1; at < rows.length; at++) {
		const end = starts[at - 1]!.value + sizes[at - 1]!.value;
		const slack = writtenSlack(starts[at]!) + writtenSlack(sizes[at - 1]!) + writtenSlack(starts[at - 1]!);
		if (starts[at]!.value < starts[at - 1]!.value) return false;
		if (Math.abs(starts[at]!.value - end) <= slack) contiguous++;
	}
	return contiguous >= CONTIGUOUS * (rows.length - 1);
}

/** `running` totals `step` row by row, each row's value its end (`Cumulative` 8, 25, 35 beside `Duration` 8, 17, 10). */
function endsOf(running: TableColumn, step: TableColumn, rows: readonly number[]): boolean {
	let sum = 0;
	for (const row of rows) {
		const [total, by] = [flowCell(running, row), flowCell(step, row)];
		if (!total || !by) return false;
		sum += by.value;
		if (Math.abs(total.value - sum) > writtenSlack(total) + 1e-9 * Math.abs(sum)) return false;
	}
	return true;
}

/**
 * A header naming a column of targets (`Target`, `§6 budget`, `Weft target`, `p99 limit`, `SLA (ms)`): the
 * target word, at most one word on either side of it, and an optional parenthesised unit. Longer headers use
 * the word in passing (`VMs at 70% target`, `Frames over the 8.3 ms budget`).
 */
const TARGET_HEADER =
	/^(?:[§\p{L}][\p{L}\p{N}§.-]*\s+)?(?<word>target|budget|limit|cap|ceiling|threshold|sla|slo|goal|quota|allowance|bar)(?:\s+[\p{L}\p{N}]+)?(?:\s*\([^)]*\))?$/iu;
/** Target words naming nothing but a target; the others also name settings (`Post-money cap`, `threshold` 50), so their cells must be written as bounds. */
const TARGET_WORD = /^(?:target|budget|limit|sla|slo|goal)$/i;
/** Target words naming a ceiling: a value must stay at or under it. */
const CEILING_WORD = /^(?:budget|limit|cap|ceiling|quota|allowance)$/i;
/** A bound written before a number (`≤ 200 µs`, `at least 8`, `first screen < 120 ms`), wherever it starts in a cell. */
const BOUND =
	/(?<sign>≤|<=|<|≥|>=|>|\bat most\b|\bat least\b|\bunder\b|\bbelow\b|\bup to\b|\bno more than\b|\bno less than\b)\s*(?=[~≈]?\s*[$€£¥]?\s*\.?\d)/i;
/** Bounds requiring a value at or over their number. */
const FLOOR_SIGN = /^(?:≥|>=|>|at least|no less than)$/i;
/** Share of a target column's written cells that must be bounds where its word also names settings, and under which a measured column's must stay. */
const BOUND_SHARE = 0.5;
/** Share of its target a value may reach (or, for a floor, exceed it by the inverse) and still be close to missing it. */
const CLOSE_SHARE = 0.9;
/** A second target after a slash (`3s / ≤ 6s`, `30 / 200 ms`). */
const SECOND_TARGET = /\d[^/]*\/\s*(?:≤|<=|<|≥|>=|>)?\s*[~≈]?\s*[$€£¥]?\s*\.?\d/;

/** A measured column and the column of targets it is held to ({@link findTarget}). */
export interface TargetColumns {
	readonly measured: TableColumn;
	readonly target: TableColumn;
}

/**
 * The column of targets `table` holds its measure to, read from headers and cells: a header naming targets
 * ({@link TARGET_HEADER}) over cells mostly holding one ({@link targetCell}) and mostly written as bounds (`≤
 * 200 µs`), which a word naming nothing else ({@link TARGET_WORD}: `Target`, `Budget`) does without; never the
 * first column, which keys the rows (a `limit` setting each row tries). The measure held to it is the nearest
 * column to it (left first), not itself mostly bounds, whose cells share a unit and a sign convention with the
 * targets ({@link measuredCell}) in two rows or more, in half the rows or more, and in at least half of the
 * rows writing both. `undefined` when none.
 */
export function findTarget(table: TableAnalysis): TargetColumns | undefined {
	const rows = [...table.rows, ...table.totals];
	const bounded = (column: TableColumn, written: readonly number[]) =>
		written.filter(row => BOUND.test(column.cells[row]!.text)).length >= BOUND_SHARE * written.length;
	for (const target of table.columns) {
		const word = TARGET_HEADER.exec(target.header)?.groups?.word;
		if (!word || target === table.label || target.index === 0) continue;
		const written = rows.filter(row => target.cells[row]!.kind !== "missing");
		const stated = written.filter(row => targetCell(target.cells[row]!.text)).length;
		if (written.length < 2 || stated * 2 < written.length) continue;
		if (!(TARGET_WORD.test(word) || bounded(target, written))) continue;
		const distance = (column: TableColumn) =>
			column.index < target.index ? target.index - column.index : table.columns.length + column.index;
		const candidates = table.columns
			.filter(
				column =>
					column !== target &&
					column !== table.label &&
					// Measurements written with their context (`0.048 ms mean, 2.5 ms worst`) read as text columns.
					(column.role === "measure" || column.role === "label") &&
					!TARGET_HEADER.test(column.header) &&
					!bounded(column, written),
			)
			.sort((a, b) => distance(a) - distance(b));
		for (const measured of candidates) {
			let both = 0;
			let alike = 0;
			for (const row of rows) {
				const value = measuredCell(measured.cells[row]);
				const goal = targetCell(target.cells[row]!.text);
				if (!value || !goal) continue;
				both++;
				if (comparable(value, goal.cell)) alike++;
			}
			if (alike >= 2 && alike * 2 >= rows.length && alike * 2 >= both) return { measured, target };
		}
	}
	return undefined;
}

/**
 * Whether a measured cell compares with its target: one dimension (one currency or rate unit), and a signed
 * change only against a signed target (`−44.6%` against `≥30% ↓` counts the cut as positive; `≤+20%` signs it alike).
 */
function comparable(measured: NumberCell, target: NumberCell): boolean {
	const unit = (measured.dim !== "currency" && measured.dim !== "rate") || measured.unit === target.unit;
	return measured.dim === target.dim && unit && (!measured.signed || target.signed);
}

/**
 * A measured cell's value: its number, a `lo–hi` range, or a rising slash list of one measure
 * ({@link NumberCell.values}: `79 / 124 µs` under `p50 / p99`) as a range from its first value to its last;
 * `undefined` for a falling list, a fraction (`28 / 0`, a score's denominator) or text.
 */
function measuredCell(cell: Cell | undefined): NumberCell | undefined {
	if (!isNumber(cell) || cell.dim === "fraction") return undefined;
	const { values } = cell;
	if (!values) return cell;
	const high = values.at(-1)!;
	return high >= values[0]! ? { ...cell, upper: high, fit: "range" } : undefined;
}

/**
 * A target cell's number and {@link Bound}: a bound wherever it starts (`≤ 200 µs`, `at most 8`, `first screen
 * ≤ 120 ms`), a window (`60–100 ms`), or a bare number; `text` writes a bound as `≤`/`≥`. `undefined` without
 * one, or for two targets in one cell (`30 / 200 ms`, `1 / 4`).
 */
function targetCell(written: string): { cell: NumberCell; bound?: Bound; text: string } | undefined {
	const bound = BOUND.exec(written);
	const rest = bound ? written.slice(bound.index + bound[0].length) : written;
	// `≤ 3s / ≤ 6s`: one target per measure of a pair, none for the row.
	if (SECOND_TARGET.test(rest)) return undefined;
	const cell = parseCell(rest);
	if (!isNumber(cell) || cell.dim === "fraction" || cell.to !== undefined) return undefined;
	if (!bound) return { cell, text: cell.figure };
	const floor = FLOOR_SIGN.test(bound.groups!.sign!);
	return { cell, bound: floor ? "min" : "max", text: `${floor ? "≥" : "≤"} ${cell.figure}` };
}

/**
 * How `point` stands against `target`: `met` when it keeps the target's side (its worst end — the high end
 * under a ceiling, the low end over a floor — at or past the target; inside a window), `close` when met
 * within {@link CLOSE_SHARE}; `share` its worst end over the target (the window's top), `undefined` for a
 * zero target. `undefined` for a target without a bound or window. Exported for the renderer.
 */
export function targetStanding(
	point: ChartPoint,
	target: ChartTarget,
): { readonly met: boolean; readonly close: boolean; readonly share: number | undefined } | undefined {
	const high = point.upper ?? point.value;
	const scale = target.upper ?? target.value;
	if (target.upper !== undefined) {
		const met = point.value >= target.value && high <= target.upper;
		return { met, close: false, share: scale > 0 ? high / scale : undefined };
	}
	if (!target.bound) return undefined;
	const worst = target.bound === "max" ? high : point.value;
	const share = target.value > 0 ? worst / target.value : undefined;
	const met = target.bound === "max" ? worst <= target.value : worst >= target.value;
	const close =
		met && share !== undefined && (target.bound === "max" ? share >= CLOSE_SHARE : share <= 1 / CLOSE_SHARE);
	return { met, close, share };
}

/**
 * The `bullet` chart of `plan`: its one series measured against {@link ChartPlan.target} row by row, in
 * table order (total rows too: a total held to a budget is a row like any other). Each target keeps the
 * bound its cell writes, else the one its header's word implies (a budget is a ceiling), else the one the
 * measure's polarity implies (a latency target is a ceiling, a throughput one a floor); a window has none.
 * A row whose cells share no unit keeps its measured text as a note. `undefined` without a target column
 * or two comparable rows.
 */
function bulletChart(
	table: TableAnalysis,
	plan: ChartPlan,
	namers: readonly TableColumn[],
	group: TableColumn | undefined,
): ChartSpec | undefined {
	const measured = table.columns[plan.series[0] ?? -1];
	const target = plan.target === undefined ? undefined : table.columns[plan.target];
	const word = target && TARGET_HEADER.exec(target.header)?.groups?.word?.toLowerCase();
	if (!measured || !target || !word) return undefined;
	const rows = regroup(
		[...table.rows, ...table.totals].sort((a, b) => a - b),
		group,
	);
	const polarity = plan.polarity?.[measured.index];
	const points: (ChartPoint | null)[] = [];
	const notes: (string | undefined)[] = [];
	const targets: (ChartTarget | null)[] = [];
	let lead: NumberCell | undefined;
	for (const row of rows) {
		const cell = measured.cells[row];
		const value = measuredCell(cell);
		const goal = targetCell(target.cells[row]!.text);
		if (!value || !goal || !comparable(value, goal.cell)) {
			points.push(null);
			targets.push(null);
			notes.push(cell && cell.kind !== "missing" ? cell.text : undefined);
			continue;
		}
		lead ??= value;
		const implied = plan.rowPolarity?.[row] ?? polarity;
		const bound =
			goal.cell.upper !== undefined
				? undefined
				: (goal.bound ??
					(CEILING_WORD.test(word) || implied === "lower" ? "max" : implied === "higher" ? "min" : undefined));
		points.push(point(value));
		// A side the cell leaves unwritten (`0` under `budget`) is written into its figure (`≤ 0`).
		const text = goal.bound || !bound ? goal.text : `${bound === "max" ? "≤" : "≥"} ${goal.text}`;
		targets.push({ ...point(goal.cell), text, bound });
		notes.push(undefined);
	}
	if (!lead || points.filter(Boolean).length < 2) return undefined;
	const naming = nameRows(namers, group, rows, true);
	return withMeaning(
		table,
		plan,
		{
			kind: "bullet",
			categories: naming.names,
			groups: naming.groups,
			series: [
				{
					name: measured.header,
					dim: lead.dim,
					unit: lead.dim === "currency" || lead.dim === "rate" ? lead.unit : "",
					points,
					notes,
					polarity,
				},
			],
			targets,
			targetName: word === "bar" ? "target" : /^sl[ao]$/.test(word) ? word.toUpperCase() : word,
			axis: naming.axis,
		},
		rows,
	);
}

/**
 * Whether the table's prose carries it, so a chart of `columns` would only
 * restate small whole numbers set beside sentences: text columns (other than
 * the label) whose typical cells add up to {@link PROSE_CELL} characters a
 * row, next to plotted values that are all whole numbers up to
 * {@link MAX_PROSE_COUNT} (tiers, ratings, fixes per PR).
 */
export function proseLed(table: TableAnalysis, columns: readonly TableColumn[]): boolean {
	const { rows } = table;
	let prose = 0;
	for (const column of table.columns) {
		if (column.role !== "label" || column === table.label) continue;
		const lengths = rows.map(row => column.cells[row]!.text.length).sort((a, b) => a - b);
		prose += lengths[lengths.length >> 1] ?? 0;
	}
	return (
		prose >= PROSE_CELL &&
		columns.every(column =>
			columnValues(column, rows).every(value => Number.isInteger(value) && Math.abs(value) <= MAX_PROSE_COUNT),
		)
	);
}

/**
 * The data `plan` draws from `table`, or `undefined` when it leaves fewer than
 * two categories or no series with two values. The kind is fitted to the
 * series it ends up with ({@link fitKind}), so any plan — a model's pick
 * included — draws as something the renderer supports.
 */
export function buildChart(table: TableAnalysis, plan: ChartPlan): ChartSpec | undefined {
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	// A line over unordered categories draws a trend that is not there: they compare side by side, or, where
	// the columns are the ordered steps (`Jul | Aug | Sep` beside metric rows), each row is a panel across them.
	// Fewer than {@link MIN_LINE_ROWS} ordered rows draw a bend the table already states.
	const ordered = (plan.kind === "line" || plan.kind === "scatter") && orderedRows(table, label);
	const longEnough = table.rows.length >= MIN_LINE_ROWS;
	if (plan.kind === "line" && !plan.transpose && !(ordered && longEnough)) {
		if (ordered) return undefined;
		const across = plan.series.every(index => {
			const header = table.columns[index]?.header ?? "";
			return parseCell(header).kind === "date" || MONTH.test(header) || SEQUENCE_LABEL.test(header);
		});
		return buildChart(table, across ? { ...plan, kind: "multiples", transpose: true } : { ...plan, kind: "grouped" });
	}
	// Three or four points show no relationship: an ordered axis joins them, else they compare side by side.
	if (plan.kind === "scatter" && table.rows.length < MIN_SCATTER_ROWS)
		return buildChart(table, { ...plan, kind: ordered && longEnough ? "line" : "grouped" });
	const columns = plan.series.map(index => table.columns[index]).filter(column => column !== undefined);
	if (columns.length === 0) return undefined;
	const wanted = new Set([plan.label, ...(plan.qualifiers ?? []), plan.group]);
	const namers = table.columns.filter(column => wanted.has(column.index));
	// A line keeps its x order; a transposed table's rows are its series; grouping by the
	// only naming column would leave every member unnamed.
	const grouper = plan.group === undefined ? undefined : table.columns[plan.group];
	// Steps of a timeline or waterfall keep table order: regrouping would reorder the run.
	const flowing = plan.kind === "timeline" || plan.kind === "waterfall";
	const group =
		plan.kind === "line" || flowing || plan.transpose || !namers.some(column => column !== grouper)
			? undefined
			: grouper;
	// Each row against its own target; without a target column (or two rows reaching it) the measure draws as bars.
	const bullet = plan.kind === "bullet" && !plan.transpose ? bulletChart(table, plan, namers, group) : undefined;
	if (bullet) return bullet;
	if (plan.kind === "change" && !plan.transpose && plan.baselines?.length === columns.length)
		return changeChart(
			table,
			plan,
			namers,
			group,
			columns,
			plan.baselines.map(index => table.columns[index]!),
		);
	if (plan.kind === "change" && !plan.transpose) return changeChart(table, plan, namers, group, columns);
	const ladders = plan.kind === "ladder" && !plan.transpose ? quantileLadders(columns, table.rows) : undefined;
	if (ladders) return ladderChart(table, plan, namers, group, ladders);
	// Several `a → b` columns hold two values per cell; only factors of change draw them side by side.
	const arrows = columns.filter(column => column.arrowShare >= 0.6);
	if (arrows.length >= 2 && !plan.transpose) return changeChart(table, plan, namers, group, arrows);
	// One `a → b` column among bars, panels or cells would plot only where each row began: its move is the
	// table's story (the other columns mostly restate it as `−32%`), drawn as a dumbbell — as factors when
	// its rows are in different units.
	if (arrows.length === 1 && plan.kind !== "paired" && plan.kind !== "range" && !plan.transpose)
		return buildChart(table, { ...plan, kind: arrows[0]!.mixed ? "change" : "paired", series: [arrows[0]!.index] });
	// A dumbbell of two measures beside their ratio (`pi-walker | Go | Speedup`): the ratio restates the gap the
	// dumbbell draws (on a log axis its length), so the pair draws alone.
	const pair = plan.kind === "paired" && !plan.transpose ? ratioPair(table, columns) : undefined;
	if (pair) return buildChart(table, { ...plan, series: pair.map(column => column.index) });
	// Unitless before/after values spanning decades are rows of different quantities, and rows of very different
	// sizes beside a baseline column share no readable axis; their factors do (`3.95M → 190k` is 21× less).
	// Intervals keep their values: a range chart prints the factor between a pair's midpoints beside both.
	const factored =
		plan.transpose || rangeColumns(columns, table.rows)
			? undefined
			: plan.kind === "paired" && columns.length <= 2
				? beforeAfter(table, columns)
				: plan.kind === "paired" || plan.kind === "grouped" || plan.kind === "dots"
					? againstBaseline(table, plan, columns)
					: undefined;
	const factors = factored && changeChart(table, plan, namers, group, factored);
	// Measured against a rival rather than a before state ({@link leadingColumn}): gaps, not moves.
	const [reference, ...others] = factored ?? [];
	const rival = reference !== undefined && !others.every(other => isTransition(reference.header, other.header));
	if (factors) return rival ? { ...factors, rival } : factors;
	// Signed changes rank from the largest gain to the largest loss unless the rows run in an order of their own.
	const signed =
		plan.kind === "diverging" &&
		!plan.order &&
		!plan.transpose &&
		!group &&
		!axisOrder(table, label) &&
		!(label && STEP_HEADER.test(label.header))
			? (columns.find(column => columnValues(column, table.rows).some(value => value < 0)) ?? columns[0])
			: undefined;
	const ranked: RowOrder | undefined =
		plan.order && !plan.transpose && plan.kind !== "scatter" && !flowing
			? plan.order
			: signed && { column: signed.index, direction: "descending" };
	const bins = plan.kind === "histogram" && label ? binRows(label, table.rows) : undefined;
	const listed =
		plan.kind === "line"
			? chronological(table.rows, label)
			: flowing
				? table.rows.filter(row => row !== plan.limit)
				: (bins ?? rank(regroup(table.rows, group), group, ranked, table));
	// A dumbbell row holding something but neither value (`— | 0–6% slower` beside timings) would be a name
	// over an empty line: it leaves the chart and the caption names it. Rows of dashes stay, as gaps.
	const unplotted =
		plan.kind === "paired" && !plan.transpose && columns.length === 2
			? listed.filter(
					row =>
						columns.every(column => {
							const cell = column.cells[row];
							return !isNumber(cell) || cell.dim !== column.dim;
						}) && columns.some(column => column.cells[row]?.kind !== "missing"),
				)
			: [];
	const rows =
		unplotted.length && unplotted.length < listed.length - 1
			? listed.filter(row => !unplotted.includes(row))
			: listed;
	const skipped =
		rows === listed ? undefined : `Not plotted: ${nameRows(namers, undefined, unplotted).names.join(", ")}`;
	// Names nest by their leading part where the chart lists rows down a label column.
	const nest = !plan.transpose && plan.kind !== "line" && plan.kind !== "scatter";
	const naming = nameRows(namers, group, rows, nest);

	let categories: readonly string[];
	let series: ChartSeries[];
	if (plan.transpose) {
		categories = columns.map(column => column.header);
		series = rows.map((row, at) => ({
			...rowSeries(naming.names[at]!, columns, row),
			polarity: plan.rowPolarity?.[row],
		}));
	} else if (plan.kind === "paired" && columns.length === 1) {
		// `a → b` cells: the column splits into its from and to values.
		const column = columns[0]!;
		const [from, to] = arrowNames(column.header);
		const before = { ...columnSeries(column, rows, from), polarity: plan.polarity?.[column.index] };
		const after: ChartSeries = {
			...before,
			name: to,
			points: rows.map(row => {
				const cell = column.cells[row];
				return isNumber(cell) && cell.to !== undefined
					? { value: cell.to, text: cell.toFigure ?? "", emphasis: cell.emphasis }
					: null;
			}),
		};
		categories = naming.names;
		series = [before, after];
	} else {
		categories = naming.names;
		series = columns.map(column => ({
			...columnSeries(column, rows, column.header),
			// Plotted at their start, `a → b` cells rank where each began, not how it ended.
			polarity: column.arrowShare >= 0.6 ? undefined : plan.polarity?.[column.index],
		}));
	}

	let x: ChartSpec["x"];
	if (plan.kind === "scatter" && series.length >= 2) {
		const xs = series[0]!;
		x = { name: xs.name, dim: xs.dim, unit: xs.unit, values: xs.points.map(entry => entry?.value ?? Number.NaN) };
		series = [series[1]!];
	} else if (plan.kind === "line" && label && !plan.transpose) {
		const values = rows.map(row => label.cells[row]).map(cell => (isNumber(cell) ? cell.value : Number.NaN));
		if (values.every(Number.isFinite) && isMonotonic(values)) {
			const first = label.cells[rows[0]!];
			x = {
				name: label.header,
				dim: isNumber(first) ? first.dim : "count",
				unit: label.unit,
				values,
			};
		}
	}

	series = series.filter(entry => entry.points.filter(point => point !== null).length >= 2);
	if (categories.length < 2 || series.length === 0) return undefined;
	// A dot plot is one shared axis: series in another unit than the first leave it while two remain.
	if (plan.kind === "dots" && !plan.transpose) {
		const unit = `${series[0]!.dim}:${series[0]!.unit}`;
		const shared = series.filter(entry => `${entry.dim}:${entry.unit}` === unit);
		if (shared.length >= 2) series = shared;
	}
	// Intervals: a column of values inside the first's (`≈ $6,700` in `$6.0k–7.3k`) is its estimate.
	const intervals = plan.transpose ? undefined : foldEstimate(series);
	const lead = intervals?.series[0];
	let estimate: ChartSeries | undefined;
	let kind = plan.transpose && plan.kind !== "stat" ? "multiples" : fitKind(plan.kind, series, x !== undefined);
	// Values mostly written `a–b` draw as intervals whatever bars, dumbbell or dots were asked for; panels
	// of several quantities stay panels unless a range chart was asked for.
	if (
		intervals &&
		(kind === "range" || kind === "bar" || kind === "grouped" || kind === "paired" || kind === "dots") &&
		intervalShare(intervals.series) >= RANGE_SHARE &&
		intervals.series.length <= MAX_RANGES &&
		!(lead?.dim === "count" && POSITIONS.test(lead.name))
	) {
		kind = "range";
		series = intervals.series;
		estimate = intervals.estimate;
		// The factor a pair of intervals prints at each row's end restates a `speedup` column beside them.
		const [first, second] = series;
		if (first && second && first.dim === second.dim && first.unit === second.unit && series.length > 2)
			series = series.filter(entry => !DELTA.test(entry.name) || entry === first || entry === second);
	} else if (kind === "range") kind = fitKind("grouped", series, x !== undefined);
	// Grouped bars over one quantity spanning decades leave the small ones as slivers (or, on a log axis,
	// lengths from an arbitrary floor): dots on a shared log axis keep every value readable.
	const layout =
		kind === "grouped" || kind === "dots"
			? dotLayout(
					categories.map((_, at) =>
						series.map(entry => {
							const value = entry.points[at]?.value ?? Number.NaN;
							return value > 0 ? value : Number.NaN;
						}),
					),
				)
			: undefined;
	const plotted = layout ? columns.filter(column => series.some(entry => entry.name === column.header)) : [];
	if (
		kind === "grouped" &&
		!plan.transpose &&
		DOT_DIMS.has(series[0]!.dim) &&
		(layout === "apart" || (layout === "clumped" && dotBaseline(plotted))) &&
		spreadOf(
			series.flatMap(entry =>
				entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : [])),
			),
		) >= (series.length >= 3 ? DOT_SPREAD : DECADES)
	)
		kind = "dots";
	// Columns of one unit whose typical sizes lie {@link QUANTITY_SPREAD}× apart count different things (`27` tests
	// beside `16.8k` tokens): one axis would flatten the small ones, so each takes a panel of its own. Timings and
	// sizes are one measurement however far apart: they keep their shared (log) axis.
	else if (
		kind === "grouped" &&
		!plan.transpose &&
		!DOT_DIMS.has(series[0]!.dim) &&
		pairSpread(
			categories.map((_, at) =>
				series.map(entry => ((entry.points[at]?.value ?? 0) > 0 ? entry.points[at]!.value : Number.NaN)),
			),
		) >= QUANTITY_SPREAD
	)
		kind = "multiples";
	// Dots of rows too tight for one axis (`3.56s…4.14s` beside `104ms…115ms`) read as factors of the baseline column.
	const baseline = kind === "dots" && layout === "clumped" ? dotBaseline(plotted) : undefined;
	const base = baseline && series.length >= 3 ? series.find(entry => entry.name === baseline.header) : undefined;
	if (base)
		series = series
			.filter(entry => entry !== base)
			.map(entry => ({
				...entry,
				dim: "ratio" as const,
				unit: "",
				points: entry.points.map((point, at) => {
					const from = base.points[at];
					return point && from && from.value > 0
						? {
								value: point.value / from.value,
								text: `${from.text} → ${point.text}`,
								emphasis: point.emphasis || from.emphasis,
								error: point.error === undefined ? undefined : point.error / from.value,
							}
						: null;
				}),
			}));
	// Columns of different quantities compare within each column: bars on their own axes read that better than shades.
	if (kind === "heatmap" && plan.shading === "series" && series.length <= MAX_PANELS) kind = "multiples";
	// Distributions of different sizes compare by shape: each as shares of its own total.
	const totals = series.map(entry => entry.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0));
	const shares =
		kind === "histogram" &&
		series.every(entry => entry.dim === "count") &&
		(plan.normalize ?? (series.length >= 2 && Math.max(...totals) >= MIX_SPREAD * Math.min(...totals)));
	if (shares) series = asShares(series);
	// A share or a delta reads one series (a delta the first going negative); the rest would overdraw it.
	if (kind === "share") series = series.slice(0, 1);
	if (kind === "diverging")
		series = [series.find(entry => entry.points.some(point => point && point.value < 0)) ?? series[0]!];
	const wholeColumn = plan.whole === undefined ? undefined : table.columns[plan.whole];
	const whole =
		kind === "stacked" && wholeColumn && wholeColumn.dim === series[0]!.dim
			? columnSeries(wholeColumn, rows, wholeColumn.header)
			: undefined;
	// Parts that are outcomes take their status colors; outcome stacks over rows of different sizes read as each row's mix.
	const tones =
		kind === "stacked"
			? outcomeTones(series.map(entry => entry.name))
			: kind === "share"
				? outcomeTones(categories)
				: undefined;
	const normalized =
		kind === "stacked" && (plan.normalize ?? (tones !== undefined && totalSpread(series, whole) >= MIX_SPREAD));
	// Only condition pairs reach `paired` ({@link fitKind}); `a → b` cells or before/after words give them a direction.
	// A range chart's pair is its first two series in one unit, whatever bands follow.
	const transition =
		(kind === "paired"
			? series.length === 2
			: kind === "range" &&
				series.length >= 2 &&
				series[0]!.dim === series[1]!.dim &&
				series[0]!.unit === series[1]!.unit) &&
		((plan.kind === "paired" && columns.length === 1) || isTransition(series[0]!.name, series[1]!.name));
	// A dumbbell of peers (`in-memory` vs `disk`) is no improvement or regression: only a transition is toned.
	if (kind === "paired" && !transition) series = series.map(entry => ({ ...entry, polarity: undefined }));
	// What competes gets its best marked; lines, dumbbells, shares and stacks read a trend, a move or parts,
	// and an interval has no single value to rank. Factors of a baseline column leave it out of the contest:
	// the best of the rest may still trail it.
	const contest =
		kind !== "line" &&
		kind !== "paired" &&
		kind !== "stat" &&
		kind !== "share" &&
		kind !== "stacked" &&
		kind !== "timeline" &&
		kind !== "waterfall" &&
		kind !== "range" &&
		kind !== "slope" &&
		kind !== "butterfly" &&
		kind !== "histogram" &&
		!base;
	const flow = kind === "timeline" || kind === "waterfall" ? flowSpec(table, plan, rows, series[0]!) : undefined;
	let leaders: (number | undefined)[] | undefined;
	if (contest && plan.transpose) {
		// The compared columns are the categories: two suffice, and a delta column competes with none.
		const rivals = columns.map(column => !DELTA.test(column.header) && column.signedShare < 0.5);
		series = series.map(entry => ({ ...entry, best: bestPoint(entry, rivals, 2) }));
	} else if (contest && plan.rivals === "rows") series = series.map(entry => ({ ...entry, best: bestPoint(entry) }));
	else if (contest && plan.rivals === "columns") leaders = columnLeaders(categories, series);
	// Intervals and dots read against what the table states as the bar to clear (`vs $200`, `20k budget`, 1×).
	const stated = kind === "range" || kind === "dots" ? statedReferences(table, series, base?.name) : undefined;
	// A ratio against that stated value (`Leverage vs $200`) restates the rule beside the intervals.
	if (stated?.restating.length && series.length > stated.restating.length)
		series = series.filter(entry => !stated.restating.includes(entry.name));
	return withMeaning(
		table,
		plan,
		{
			kind,
			transition: transition || undefined,
			transposed: plan.transpose || undefined,
			categories,
			groups: plan.transpose ? undefined : naming.groups,
			series,
			x: flow?.x ?? x,
			caption: flow?.total
				? undefined
				: [totalsCaption(table, label, columns, plan.transpose), skipped].filter(Boolean).join(" · ") || undefined,
			axis: naming.axis,
			shading: plan.shading,
			reference:
				kind === "stat"
					? [statBaseline(categories)]
					: plan.transpose
						? undefined
						: referenceRows(table, plan.reference, group, rows),
			whole,
			normalized: normalized || shares || undefined,
			tones,
			total: flow?.total,
			// A flow's cap rule, or the references intervals and dots are read against; never both.
			annotations: flow?.annotations ?? (stated?.marks.length ? stated.marks : undefined),
			leaders,
			estimate,
			baseline: base?.name,
		},
		plan.transpose ? undefined : rows,
	);
}

// ── Distributions: quantile ladders and histograms ───────────────────────────

/** A quantile a header names: `p50`, `p99.9`, `p999`, `median`, `min`, `max`. */
const QUANTILE_WORD = String.raw`p\d{1,4}(?:\.\d+)?|median|med|min|minimum|max|maximum`;
/** A central value a slash list of quantiles may hold beside them (`Mean / p95`), drawn as its middle. */
const CENTRAL_WORD = String.raw`mean|avg|average`;
/** A slash-list item that is a quantile, not a mean: a ladder needs one. */
const QUANTILE_ITEM = new RegExp(String.raw`^(?:${QUANTILE_WORD})$`, "i");
/** A quantile word standing alone in a header (`TTFT p50`, `p95 ms`, `Startup p95`). */
const QUANTILE_HEADER = new RegExp(String.raw`(?:^|[^\w.])(${QUANTILE_WORD})(?![\w.])`, "gi");
/** One item of a header's slash list of quantiles: a quantile or a mean. */
const LISTED_WORD = String.raw`(?:${QUANTILE_WORD}|${CENTRAL_WORD})`;
/** A slash list of two to four quantiles in a header (`p50 / p99`, `p50/p95/max`, `median/max`, `Mean / p95`). */
const QUANTILE_LIST = new RegExp(String.raw`(?:^|[^\w.])(${LISTED_WORD}(?:\s*\/\s*${LISTED_WORD}){1,3})(?![\w.])`, "i");
/** Share of the rows holding two quantiles or more whose quantiles must rise with their rank to read as one ladder. */
const ORDERED_SHARE = 0.8;
/** Most ladders (measurements) one chart draws per category. */
const MAX_LADDERS = 3;

/** One quantile of a {@link Ladder}: a column holding it alone, or one item of a column's slash lists. */
export interface Rung {
	readonly column: TableColumn;
	/** Which listed value of each cell (`p99` of `79 / 124 µs`); absent when the column holds the quantile alone. */
	readonly slot?: number;
	/** How many values each cell of a listing column holds (the quantiles its header lists). */
	readonly slots?: number;
	/** The quantile as the header writes it (`p50`, `max`). */
	readonly name: string;
	/** Where it ranks: 0 the minimum, 50 the median (or a mean beside quantiles), 100 the maximum. */
	readonly rank: number;
	/** The unit the header gives bare numbers (`cpu p50 / p95 (ms)`): their dimension and base factor. */
	readonly scale?: readonly [Dimension, number];
}

/**
 * Quantiles of one measurement per row (`p50 | p90 | p99 | max`, `Startup p50 | Startup p95`,
 * `p50 / p99` cells), lowest rank first, all of one dimension.
 */
export interface Ladder {
	/** The measurement (`Startup`, `zoom 1`); empty when its headers name nothing but quantiles. */
	readonly name: string;
	readonly rungs: readonly Rung[];
	readonly dim: Dimension;
	/** Currency symbol or rate unit the axis prints; empty for other dimensions. */
	readonly unit: string;
}

/**
 * `table`'s quantile ladders ({@link quantileLadders}) beside the `label` column, when their columns
 * are at least half of what the table measures and no column holds per-row targets ({@link findTarget}:
 * quantiles held to targets are a `bullet`): the table is about the distributions. Every column
 * but the label may hold quantiles, measures and text alike — a quantile alike in every row (`p50` 2,
 * 2) is no measure, and a list of three (`1.69 / 2.59 / 3.17`) reads as prose.
 */
export function tableLadders(table: TableAnalysis, label: number | undefined): Ladder[] | undefined {
	if (table.rows.length < 2 || findTarget(table)) return undefined;
	const sources = table.columns.filter(
		column => column.index !== label && (column.role === "measure" || column.role === "label"),
	);
	const ladders = quantileLadders(sources, table.rows);
	if (!ladders) return undefined;
	const held = ladderColumns(ladders);
	const measured = new Set([...table.measures.map(column => column.index), ...held]);
	measured.delete(label ?? -1);
	return held.length * 2 >= measured.size ? ladders : undefined;
}

/** The columns `ladders` read their quantiles from, each once, in ladder order. */
export function ladderColumns(ladders: readonly Ladder[]): number[] {
	return [...new Set(ladders.flatMap(ladder => ladder.rungs.map(rung => rung.column.index)))];
}

/** Where quantile `word` ranks (0–100): `p999` is 99.9; a mean stands in the middle. */
function quantileRank(word: string): number {
	const lower = word.toLowerCase();
	if (lower.startsWith("min")) return 0;
	if (lower.startsWith("max")) return 100;
	if (!/^p\d/.test(lower)) return 50;
	let rank = Number(lower.slice(1));
	while (rank > 100) rank /= 10;
	return rank;
}

/**
 * What a header names besides its quantiles (`Startup p95` → `Startup`, `zoom 1, p50 / p95` → `zoom 1`),
 * and the unit it gives bare numbers (`cpu p50 / p95 (ms)` → milliseconds).
 */
function ladderSubject(rest: string): { name: string; scale?: readonly [Dimension, number] } {
	let scale: readonly [Dimension, number] | undefined;
	const words = rest
		.replace(/[()[\],:;]/g, " ")
		.split(/\s+/)
		.filter(word => {
			if (!word) return false;
			const unit = parseCell(`1 ${word}`);
			if (!isNumber(unit) || !unit.unit || unit.dim === "count") return true;
			scale ??= [unit.dim, unit.value];
			return false;
		});
	return { name: words.join(" "), scale };
}

/**
 * The quantile ladders among `measures`: columns whose headers each name one quantile of one
 * measurement (`p50 | p90 | p99`, `Startup p50 | Startup p95`; a bare `p95` after `TTFT p50` joins
 * it), and columns whose headers name a slash list of quantiles over cells listing that many values
 * (`p50 / p99` over `79 / 124 µs`). A ladder needs two quantiles, one of them neither the minimum nor
 * the maximum, one dimension, and its values rising with rank in {@link ORDERED_SHARE} of the rows
 * holding two (two such rows at least); ladders in
 * another dimension than the first leave, at most {@link MAX_LADDERS} stay. `undefined` when none.
 */
export function quantileLadders(measures: readonly TableColumn[], rows: readonly number[]): Ladder[] | undefined {
	const drafts: { name: string; rungs: Rung[] }[] = [];
	let previous: { name: string; rungs: Rung[] } | undefined;
	for (const column of measures) {
		const list = QUANTILE_LIST.exec(column.header);
		const words = list?.[1]!.split(/\s*\/\s*/) ?? [];
		if (list && words.some(word => QUANTILE_ITEM.test(word))) {
			const subject = ladderSubject(column.header.replace(list[1]!, " "));
			drafts.push({
				name: subject.name,
				rungs: words.map((word, slot) => ({
					column,
					slot,
					slots: words.length,
					name: word,
					rank: quantileRank(word),
					scale: subject.scale,
				})),
			});
			previous = undefined;
			continue;
		}
		const found = [...column.header.matchAll(QUANTILE_HEADER)];
		if (found.length !== 1) {
			previous = undefined;
			continue;
		}
		const word = found[0]![1]!;
		const subject = ladderSubject(column.header.replace(word, " "));
		const rung: Rung = { column, name: word, rank: quantileRank(word), scale: subject.scale };
		// `TTFT p50 | p95`: a header of a quantile alone continues the ladder before it.
		const draft =
			(subject.name === "" && previous) ||
			drafts.find(entry => entry.name === subject.name && entry.rungs.every(other => other.slot === undefined));
		if (draft) draft.rungs.push(rung);
		else drafts.push({ name: subject.name, rungs: [rung] });
		previous = draft ?? drafts.at(-1);
	}
	const ladders: Ladder[] = [];
	for (const draft of drafts) {
		const rungs = draft.rungs.toSorted((a, b) => a.rank - b.rank);
		if (rungs.length < 2 || new Set(rungs.map(rung => rung.rank)).size < rungs.length) continue;
		// `Min | Max` alone bound a setting (`Default | Min | Max` timeouts); a distribution names a middle or a tail.
		if (rungs.every(rung => rung.rank === 0 || rung.rank === 100)) continue;
		const read = rows.map(row => rungs.map(rung => rungValue(rung, row)));
		const dims = new Set(read.flat().flatMap(value => (value ? [`${value.dim}:${value.unit}`] : [])));
		if (dims.size !== 1) continue;
		const held = read.map(values => values.flatMap(value => (value ? [value.point.value] : [])));
		const full = held.filter(values => values.length >= 2);
		const ordered = full.filter(values => values.every((value, at) => at === 0 || value >= values[at - 1]!));
		if (full.length < 2 || ordered.length < ORDERED_SHARE * full.length) continue;
		const first = read.flat().find(value => value !== undefined)!;
		ladders.push({ name: draft.name, rungs, dim: first.dim, unit: first.unit });
	}
	const kept = ladders.filter(ladder => ladder.dim === ladders[0]?.dim && ladder.unit === ladders[0]?.unit);
	return kept.length ? kept.slice(0, MAX_LADDERS) : undefined;
}

/**
 * `rung`'s value at `row` as a plotted point: the column's number, or the cell's listed value at the
 * rung's slot — unitless lists (`0.04 / 0.05`, `9/47/85`, read as fractions or text) item by item from
 * the cell's text, as the header names them quantiles; bare numbers take the header's unit. `undefined`
 * where the cell holds none (a range, a transition, prose, another count of values).
 */
function rungValue(rung: Rung, row: number): { point: ChartPoint; dim: Dimension; unit: string } | undefined {
	const cell = rung.column.cells[row];
	if (!cell) return undefined;
	let read: { value: number; dim: Dimension; unit: string; text: string } | undefined;
	if (rung.slot !== undefined) {
		const items = cell.text.split(/\s*\/\s*/);
		const listed =
			(isNumber(cell) && cell.values) ||
			items.map(item => {
				const own = parseCell(item);
				return isNumber(own) && own.fit === "pure" && own.dim === "count" ? own.value : Number.NaN;
			});
		const value = listed[rung.slot];
		if (listed.length !== rung.slots || value === undefined || !Number.isFinite(value)) return undefined;
		const measured = isNumber(cell) && cell.values !== undefined;
		read = {
			value,
			dim: measured ? cell.dim : "count",
			unit: measured ? cell.unit : "",
			text: items[rung.slot]!.trim(),
		};
	} else if (
		isNumber(cell) &&
		cell.upper === undefined &&
		cell.to === undefined &&
		cell.dim === rung.column.dim &&
		cell.dim !== "fraction"
	)
		read = { value: cell.value, dim: cell.dim, unit: cell.unit, text: cell.figure };
	if (!read) return undefined;
	let { value, dim } = read;
	if (dim === "count" && !read.unit && rung.scale) [dim, value] = [rung.scale[0], value * rung.scale[1]];
	return {
		point: { value, text: read.text, emphasis: cell.emphasis },
		dim,
		unit: dim === "currency" || dim === "rate" ? read.unit : "",
	};
}

/**
 * A `ladder` of `ladders` over the table's rows (ranked by {@link ChartPlan.order} within each group):
 * one series per quantile, named by it, each ladder's series consecutive and lowest quantile first.
 */
function ladderChart(
	table: TableAnalysis,
	plan: ChartPlan,
	namers: readonly TableColumn[],
	group: TableColumn | undefined,
	ladders: readonly Ladder[],
): ChartSpec | undefined {
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	const rows = rank(regroup(table.rows, group), group, plan.order, table);
	const naming = nameRows(namers, group, rows, true);
	const series: ChartSeries[] = [];
	const drawn: ChartLadder[] = [];
	for (const ladder of ladders) {
		const start = series.length;
		for (const rung of ladder.rungs)
			series.push({
				name: rung.name,
				dim: ladder.dim,
				unit: ladder.unit,
				points: rows.map(row => rungValue(rung, row)?.point ?? null),
				notes: rows.map(() => undefined),
				polarity: plan.polarity?.[rung.column.index],
			});
		drawn.push({ name: ladder.name, series: ladder.rungs.map((_, at) => start + at) });
	}
	const present = rows.filter((_, at) => series.some(entry => entry.points[at]));
	if (present.length < 2) return undefined;
	const columns = [...new Set(ladders.flatMap(ladder => ladder.rungs.map(rung => rung.column)))];
	return withMeaning(
		table,
		plan,
		{
			kind: "ladder",
			categories: naming.names,
			groups: naming.groups,
			series,
			axis: naming.axis,
			caption: totalsCaption(table, label, columns, false),
			ladders: drawn,
			// `Baseline p50 / p95 | Final p50 / p95`: the first ladder is where the second moved from.
			transition: (drawn.length === 2 && isTransition(drawn[0]!.name, drawn[1]!.name)) || undefined,
		},
		rows,
	);
}

/** Fewest bins a histogram draws. */
const MIN_BINS = 3;
/** Most bins a histogram keeps legible. */
const MAX_BINS = 24;
/** Most distributions a histogram compares side by side. */
const MAX_DISTRIBUTIONS = 4;
/** Slack (percent points) within which a percent column sums to 100: shares of one whole. */
const SHARE_SLACK = 3;

/** The interval a bin cell covers: `2–5` → [2, 5], `100+` and `≥0.9` up to ∞, `<1 ms` down to −∞, `3` alone. */
function binOf(cell: Cell | undefined): readonly [number, number] | undefined {
	if (!isNumber(cell) || cell.signed || cell.to !== undefined || cell.values || cell.denominator !== undefined)
		return undefined;
	if (cell.fit === "range") return [cell.value, cell.upper!];
	if (cell.fit !== "pure" && cell.fit !== "note") return undefined;
	const text = cell.text.trim();
	if (/^(?:<|≤)/.test(text)) return [Number.NEGATIVE_INFINITY, cell.value];
	if (/^(?:>|≥)|\+$/.test(text)) return [cell.value, Number.POSITIVE_INFINITY];
	return [cell.value, cell.value];
}

/**
 * `rows` as ordered bins of `column`: {@link MIN_BINS} to {@link MAX_BINS} cells each a value, a range
 * or an open end (`1 | 2–5 | 6–20 | 21–100 | 100+`, `<1 ms | 1–10 ms | >10 ms`), not all single values,
 * running one way and meeting end to start — no overlap, a gap of at most one between whole-number bins
 * (or one written digit between decimal ones). The rows in ascending bin order, else `undefined`.
 */
export function binRows(column: TableColumn, rows: readonly number[]): number[] | undefined {
	if (rows.length < MIN_BINS || rows.length > MAX_BINS) return undefined;
	const bins = rows.map(row => binOf(column.cells[row]));
	if (bins.some(bin => !bin) || bins.every(bin => bin![0] === bin![1])) return undefined;
	const ascending = bins[0]![0] < bins.at(-1)![0];
	const order = ascending ? [...rows] : rows.toReversed();
	const sorted = ascending ? bins : bins.toReversed();
	const whole = sorted.every(bin => bin!.every(end => !Number.isFinite(end) || Number.isInteger(end)));
	for (let at = 1; at < sorted.length; at++) {
		const [[low, high], [nextLow]] = [sorted[at - 1]!, sorted[at]!];
		const cell = column.cells[order[at]!];
		const step = whole ? 1 : isNumber(cell) ? 2 * writtenSlack(cell) : 0;
		const gap = nextLow - high;
		if (!(nextLow > low) || !(gap >= 0) || gap > step + 1e-9 * Math.abs(high)) return undefined;
	}
	return order;
}

/**
 * The columns of `measures` (but `bins`) counting how often each bin occurs, when every one of them
 * does: one to {@link MAX_DISTRIBUTIONS} columns of whole non-negative counts (no per-unit statistic like
 * `p50` or `avg`, no delta, no header naming only a unit), or of percents summing to 100 within
 * {@link SHARE_SLACK} (shares of one whole).
 */
function frequencyColumns(
	measures: readonly TableColumn[],
	bins: TableColumn,
	rows: readonly number[],
): TableColumn[] | undefined {
	const counted = measures.filter(column => column !== bins);
	if (counted.length === 0 || counted.length > MAX_DISTRIBUTIONS) return undefined;
	const frequencies = counted.every(column => {
		if (column.scores || column.mixed || PER_UNIT.test(column.header) || DELTA.test(column.header)) return false;
		// Bare numbers under a header that is only a unit (`ms`, `(KB)`) are amounts in it, not tallies.
		const subject = ladderSubject(column.header);
		if (subject.scale && !subject.name) return false;
		const values = columnValues(column, rows);
		if (values.length < rows.length - 1 || values.some(value => value < 0)) return false;
		if (column.dim === "count") return values.every(Number.isInteger);
		const sum = values.reduce((total, value) => total + value, 0);
		return column.dim === "percent" && Math.abs(sum - 100) <= SHARE_SLACK;
	});
	return frequencies && new Set(counted.map(column => column.dim)).size === 1 ? counted : undefined;
}

/**
 * The column whose rows are `table`'s ordered bins ({@link binRows}) — its label, else its first column —
 * with the measures counting each bin ({@link frequencyColumns}); `undefined` unless both hold.
 */
export function histogramColumns(
	table: TableAnalysis,
	measures: readonly TableColumn[] = table.measures,
): { bins: TableColumn; counts: TableColumn[] } | undefined {
	const bins = [table.label, table.columns[0]].find(column => column && binRows(column, table.rows));
	const counts = bins && frequencyColumns(measures, bins, table.rows);
	return bins && counts ? { bins, counts } : undefined;
}

/**
 * `series` of a histogram as shares of each one's total (`percentText`), for distributions of
 * different sizes compared by shape.
 */
function asShares(series: readonly ChartSeries[]): ChartSeries[] {
	return series.map(entry => {
		const total = entry.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0);
		return {
			...entry,
			dim: "percent",
			unit: "",
			points: entry.points.map(point =>
				point && total > 0
					? { ...point, value: (100 * point.value) / total, text: percentText((100 * point.value) / total) }
					: null,
			),
		};
	});
}

/** Share of a column's numbers written `a–b` from which it reads as intervals rather than values. */
const RANGE_SHARE = 0.5;
/** Most series one range chart draws across its bands: more interval rows per category stop reading apart. */
const MAX_RANGES = 4;
/** Spread (max/min) from which three or more same-unit series read better as dots on a log axis than as grouped bars. */
const DOT_SPREAD = 10;
/** Most categories a dot plot keeps a glance tall: one row each. */
const MAX_DOT_ROWS = 20;
/** Share of the axis (in logs) a row's typical spread must span for its dots not to merge into one blot. */
const DOT_CLUMP = 0.2;
/**
 * Measurements dots place by position and ratio (timings, prices, sizes, rates); tallies and shares
 * add up, so bars from zero tell them better.
 */
const DOT_DIMS: ReadonlySet<Dimension> = new Set(["duration", "bytes", "currency", "rate", "ratio"]);
/** A header marking the configuration in use, which the others compare against. */
const IN_USE = /\((?:shipped|current|default|in use|deployed|prod(?:uction)?)\b[^)]*\)/i;
/**
 * Factor within which a stated reference may lie of the values it is read against (`$200` beside
 * `$4.4k–6.1k` is 22× under); farther, the axis reaching it would flatten them.
 */
const REFERENCE_REACH = 50;
/**
 * Headers of spans of positions rather than amounts (`Lines` 110–112, `Line Range`, `Cases` 12–17,
 * `New #` 1–7): their count ranges say where, not how much.
 */
const POSITIONS =
	/(?:^|[^\w])(?:lines?|line ?(?:no|nos|numbers?)|cases?|ids?|rows?|cols?|columns?|offsets?|pages?|pp|ind(?:ex|ices)|positions?|range|span|issues?|#|no\.?)(?![\w])/i;
/**
 * A number a table states as the bar its values are read against: after `vs`,
 * `budget`, `limit` (`Leverage vs $200`, `limit of 512 MB`), or before such a
 * word (`blew the 20k budget`, `128k token limit`).
 */
const STATED_REFERENCE =
	/\b(?<lead>vs\.?|versus|budget|limit|cap|target|quota|threshold)\s+(?:of\s+)?(?<after>[~≈]?\s?[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:[a-z%×µμ]+(?:\/[a-z]+)?)?)|(?<before>[$€£]?\d[\d,]*(?:\.\d+)?\s?[a-z%×]{0,3})\s+(?:[a-z]+\s+)?(?<word>budget|limit|cap|quota|threshold|target)\b/i;

/**
 * The same-unit measures plotted as intervals when values written `a–b` make
 * up most of the numbers of at least one of them ({@link RANGE_SHARE}), with the
 * measures sharing its unit (an estimate column, a pair's other side); other
 * units' interval columns join as bands of their own. At most {@link MAX_RANGES}.
 */
export function rangeColumns(measures: readonly TableColumn[], rows: readonly number[]): TableColumn[] | undefined {
	const key = (column: TableColumn) => `${column.dim}:${column.unit}`;
	const ranged = new Set(
		measures
			.filter(
				column =>
					!(column.dim === "count" && POSITIONS.test(column.header)) &&
					columnRangeShare(column, rows) >= RANGE_SHARE,
			)
			.map(key),
	);
	if (ranged.size === 0) return undefined;
	const columns = measures.filter(column => ranged.has(key(column))).slice(0, MAX_RANGES);
	// Most of what the chart plots must be intervals: one ranged column among plain ones stays bars.
	const cells = columns.flatMap(column =>
		rows.map(row => column.cells[row]).filter(cell => isNumber(cell) && cell.dim === column.dim),
	);
	const spans = cells.filter(cell => isNumber(cell) && cell.upper !== undefined && cell.upper > cell.value).length;
	return spans >= cells.length * RANGE_SHARE ? columns : undefined;
}

/**
 * Whether `columns` over `rows` read best as dots: three to six columns of one measurement
 * ({@link DOT_DIMS}) spanning {@link DOT_SPREAD}× or more, where grouped bars from zero would flatten
 * the small values — one quantity whose rows sit apart on a log axis, or rows too tight for one axis
 * beside a baseline column their factors can be read against ({@link dotLayout}).
 */
export function dotsFit(columns: readonly TableColumn[], rows: readonly number[]): boolean {
	const first = columns[0];
	if (
		!first?.dim ||
		!DOT_DIMS.has(first.dim) ||
		// Durations and sizes share an axis in base units whatever unit each column writes; money and rates do not.
		columns.some(
			column =>
				column.dim !== first.dim ||
				((first.dim === "currency" || first.dim === "rate") && column.unit !== first.unit),
		) ||
		columns.length < 3 ||
		columns.length > SERIES_COLORS ||
		rows.length < 3 ||
		rows.length > MAX_DOT_ROWS ||
		valueSpread(columns, rows) < DOT_SPREAD
	)
		return false;
	const layout = dotLayout(
		rows.map(row =>
			columns.map(column => {
				const cell = column.cells[row];
				return isNumber(cell) && cell.dim === column.dim && cell.value > 0 ? cell.value : Number.NaN;
			}),
		),
	);
	return layout === "apart" || (layout === "clumped" && dotBaseline(columns) !== undefined);
}

/**
 * How dots would sit for `grid` (rows of positive values, `NaN` where absent): `apart` when its columns
 * are one quantity and a row's typical spread spans at least {@link DOT_CLUMP} of the whole axis (in
 * logs); `clumped` when rows of very different sizes are each so tight their dots merge on one axis
 * (factors of a baseline column part them); `undefined` when one column typically runs
 * {@link QUANTITY_SPREAD}× another: different quantities, which share no axis.
 */
function dotLayout(grid: readonly (readonly number[])[]): "apart" | "clumped" | undefined {
	if (pairSpread(grid) >= QUANTITY_SPREAD) return undefined;
	const values = grid.flat().filter(Number.isFinite);
	if (values.length < 2) return undefined;
	const whole = Math.log(Math.max(...values) / Math.min(...values));
	const spans = grid
		.map(row => row.filter(Number.isFinite))
		.filter(row => row.length >= 2)
		.map(row => Math.log(Math.max(...row) / Math.min(...row)))
		.sort((a, b) => a - b);
	const typical = spans[spans.length >> 1] ?? 0;
	return whole > 0 && typical < DOT_CLUMP * whole ? "clumped" : "apart";
}

/**
 * The column the others are read against: one its header marks as what is in use (`GOGC=400
 * (shipped)`, `(current)`), or the baseline every other moves from ({@link isTransition}: `stock`
 * beside `branch | tsc-rs`).
 */
function dotBaseline(columns: readonly TableColumn[]): TableColumn | undefined {
	const baseline =
		columns.find(column => IN_USE.test(column.header)) ??
		columns.find(column => columns.every(other => other === column || isTransition(column.header, other.header)));
	return baseline && soleMark(columns, baseline) ? baseline : undefined;
}

/**
 * Whether no other of `columns` shares a reference word marking `baseline` (its before words:
 * `default`, `stock`, `baseline`): beside `ours, adaptive default`, `tsc-rs, 4 (default)` is one default among several
 * configurations, not what the others are measured against; `before` beside `after (cold)` stays one.
 */
function soleMark(columns: readonly TableColumn[], baseline: TableColumn): boolean {
	const marks = baseline.header.toLowerCase().match(new RegExp(BEFORE.source, "gi")) ?? [];
	return columns.every(
		column =>
			column === baseline || !marks.some(mark => new RegExp(String.raw`\b${mark}\b`, "i").test(column.header)),
	);
}

/**
 * Among rival columns (`plan.rivals` is `columns`) of one polarity, the one best in most rows — the
 * reference alternatives are read against when no column is the baseline: `tsc-rs, 8` fastest on five
 * of six apps. `undefined` when the columns differ in polarity or no column leads alone.
 */
function leadingColumn(
	table: TableAnalysis,
	plan: ChartPlan,
	columns: readonly TableColumn[],
): TableColumn | undefined {
	const polarity = plan.polarity?.[columns[0]!.index];
	if (plan.rivals !== "columns" || !polarity || columns.some(column => plan.polarity?.[column.index] !== polarity))
		return undefined;
	const wins = new Map<TableColumn, number>();
	for (const row of table.rows) {
		let best: { column: TableColumn; value: number } | undefined;
		for (const column of columns) {
			const cell = column.cells[row];
			if (!isNumber(cell)) continue;
			if (!best || (polarity === "lower" ? cell.value < best.value : cell.value > best.value))
				best = { column, value: cell.value };
		}
		if (best) wins.set(best.column, (wins.get(best.column) ?? 0) + 1);
	}
	const ranked = [...wins].sort((a, b) => b[1] - a[1]);
	return ranked[0] && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? ranked[0][0] : undefined;
}

/**
 * Share of `column`'s numbers of its own dimension over `rows` written as an `a–b` range running up
 * (`0.805-0.764 = 0.041` is a difference, not an interval).
 */
function columnRangeShare(column: TableColumn, rows: readonly number[]): number {
	const numbers = rows.map(row => column.cells[row]).filter(cell => isNumber(cell) && cell.dim === column.dim);
	return numbers.length
		? numbers.filter(cell => isNumber(cell) && cell.upper !== undefined && cell.upper > cell.value).length /
				numbers.length
		: 0;
}

/** Share of the plotted values written as `a–b` ranges running up. */
function intervalShare(series: readonly ChartSeries[]): number {
	const points = series.flatMap(entry => entry.points.filter(point => point !== null));
	return points.length
		? points.filter(point => point.upper !== undefined && point.upper > point.value).length / points.length
		: 0;
}

/** Largest over smallest of the values (range ends included) in `columns` over `rows`; 1 when any is zero or negative. */
function valueSpread(columns: readonly TableColumn[], rows: readonly number[]): number {
	return spreadOf(
		columns.flatMap(column =>
			rows.flatMap(row => {
				const cell = column.cells[row];
				return isNumber(cell) && cell.dim === column.dim ? [cell.value, cell.upper ?? cell.value] : [];
			}),
		),
	);
}

/**
 * The middle of a value written `a–b`, which a factor between two intervals compares: the geometric
 * mean (`5.7–9.6 ms` → 7.4 ms), the arithmetic one from zero; a single value is its own.
 */
export function intervalMiddle(point: ChartPoint): number {
	const { value, upper } = point;
	if (upper === undefined) return value;
	return value > 0 ? Math.sqrt(value * upper) : (value + upper) / 2;
}

/** Largest over smallest of `values`; 1 when any is zero or negative (no log axis holds them). */
function spreadOf(values: readonly number[]): number {
	if (values.length < 2 || values.some(value => value <= 0)) return 1;
	return Math.max(...values) / Math.min(...values);
}

/**
 * `series` with the first interval series leading, and a series of the same unit whose values all
 * fall inside its intervals (two at least) taken out as its estimate: `≈ $6,700` beside `$6.0k–7.3k`.
 */
function foldEstimate(series: readonly ChartSeries[]): { series: ChartSeries[]; estimate?: ChartSeries } {
	const ranged = series.find(entry => intervalShare([entry]) >= RANGE_SHARE);
	if (!ranged) return { series: [...series] };
	const inside = (entry: ChartSeries) => {
		if (entry === ranged || entry.dim !== ranged.dim || entry.unit !== ranged.unit) return false;
		let held = 0;
		for (const [at, point] of entry.points.entries()) {
			const span = ranged.points[at];
			if (!point) continue;
			if (point.upper !== undefined || !span?.upper || point.value < span.value || point.value > span.upper)
				return false;
			held++;
		}
		return held >= 2;
	};
	const estimate = series.find(inside);
	return {
		series: [ranged, ...series.filter(entry => entry !== ranged && entry !== estimate)],
		estimate,
	};
}

/**
 * Reference rules a `range` or `dots` chart reads its values against: `1×` across ratios on both sides
 * of it, and numbers the table states as a bar to clear ({@link STATED_REFERENCE}) in a plotted series'
 * unit, within {@link REFERENCE_REACH} of its values. `restating` names ratio series measured against
 * such a number (`Leverage vs $200`): the rule says what they do.
 */
function statedReferences(
	table: TableAnalysis,
	series: readonly ChartSeries[],
	baseline: string | undefined,
): { marks: Extract<ChartAnnotation, { kind: "reference" }>[]; restating: string[] } {
	const marks: Extract<ChartAnnotation, { kind: "reference" }>[] = [];
	const restating: string[] = [];
	const ends = (entry: ChartSeries) =>
		entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : []));
	// One `1×` rule per axis, named after the baseline column when the values are its factors.
	const parity = series.findIndex(entry => {
		const values = ends(entry);
		return entry.dim === "ratio" && Math.min(...values) < 1 && Math.max(...values) > 1;
	});
	if (baseline) marks.push({ kind: "reference", value: 1, label: baseline, series: 0 });
	else if (parity >= 0) marks.push({ kind: "reference", value: 1, label: "1×", series: parity });
	const headers = new Set(table.columns.map(column => column.header));
	const texts = [...headers, ...table.columns.flatMap(column => table.rows.map(row => column.cells[row]?.text ?? ""))];
	for (const source of texts) {
		const match = STATED_REFERENCE.exec(source);
		const figure = (match?.groups?.after ?? match?.groups?.before)?.trim();
		if (!match || !figure) continue;
		// A cell's `110 ms vs 51 ms` compares its own row; only a header's `vs $200` frames the column.
		if (/^(?:vs\.?|versus)$/i.test(match.groups?.lead ?? "") && !headers.has(source)) continue;
		const cell = parseCell(figure);
		if (!isNumber(cell) || cell.fit !== "pure" || cell.value <= 0) continue;
		const at = series.findIndex(
			entry => entry.dim === cell.dim && (entry.dim !== "currency" || entry.unit === cell.unit),
		);
		const values = at < 0 ? [] : ends(series[at]!);
		if (
			!values.length ||
			cell.value * REFERENCE_REACH < Math.min(...values) ||
			cell.value > Math.max(...values) * REFERENCE_REACH ||
			marks.some(mark => mark.series === at && mark.value === cell.value)
		)
			continue;
		const word = match.groups?.word ?? match.groups?.lead ?? "";
		const label = /^(?:vs\.?|versus)$/i.test(word) ? cell.figure : `${cell.figure} ${word.toLowerCase()}`;
		marks.push({ kind: "reference", value: cell.value, label, series: at });
		for (const entry of series) if (entry.dim === "ratio" && entry.name === source) restating.push(entry.name);
	}
	return { marks, restating };
}

/**
 * `spec` with what `plan` says the table means: its title, a highlight on
 * each focus row and the status badges, where its categories are the
 * table's rows `order` (`undefined` when they are not, as in a transposed chart).
 */
function withMeaning(
	table: TableAnalysis,
	plan: ChartPlan,
	spec: ChartSpec | undefined,
	order: readonly number[] | undefined,
): ChartSpec | undefined {
	if (!spec) return undefined;
	const focus = order ? (plan.focus ?? []).flatMap(row => (order.includes(row) ? [order.indexOf(row)] : [])) : [];
	const matrix = order && MATRIX_KINDS.has(spec.kind) ? statusMatrix(table, plan, order) : undefined;
	const column = plan.status === undefined || !order || matrix ? undefined : table.columns[plan.status];
	const statuses = column?.statuses;
	const marks: ChartAnnotation[] = [
		...(spec.annotations ?? []),
		...focus.map(category => ({ kind: "highlight" as const, category })),
		...storyCallouts(spec),
	];
	return {
		...spec,
		title: plan.title,
		annotations: marks.length ? marks : undefined,
		status: statuses && order?.map(row => statuses[row]),
		statusName: statuses && column?.header,
		matrix,
	};
}

/**
 * Callouts stating what a chart's marks leave unwritten: a line's peak
 * inside it (`peak 1,374`), whose figure no end label prints — the table's
 * bolded peak first, else the line rising most to its peak, a striking one
 * ({@link linePeak}). At most one, so the chart stays a glance.
 */
function storyCallouts(spec: ChartSpec): ChartAnnotation[] {
	if (spec.kind !== "line") return [];
	const peaks = spec.series.flatMap((entry, series) => {
		const peak = linePeak(spec, entry);
		return peak?.striking ? [{ ...peak, series }] : [];
	});
	const pick = peaks.find(peak => peak.point.emphasis) ?? peaks.sort((a, b) => b.rise - a.rise)[0];
	return pick ? [{ kind: "callout", category: pick.at, series: pick.series, text: `peak ${pick.point.text}` }] : [];
}

/**
 * How many times the largest category total an outcome stack may hold over
 * the smallest before its bars read as mixes: alike totals (`158 | 1` of 159
 * in each row) read as well in counts, which the axis then shows.
 */
const MIX_SPREAD = 1.5;

/** Largest over smallest positive category total of a stack: its whole where written, else its parts' sum. */
function totalSpread(series: readonly ChartSeries[], whole: ChartSeries | undefined): number {
	const totals = (series[0]?.points ?? []).flatMap((_, at) => {
		const total =
			whole?.points[at]?.value || series.reduce((sum, entry) => sum + Math.max(0, entry.points[at]?.value ?? 0), 0);
		return total > 0 ? [total] : [];
	});
	return totals.length ? Math.max(...totals) / Math.min(...totals) : 1;
}

/** Most status columns a {@link ChartSpec.matrix} draws; a wider ✓/✗ grid is the table's own point, left to it. */
const MAX_MATRIX = 4;
/** Kinds whose rows run down a label column the matrix can stand beside: horizontal bars of every sort. */
const MATRIX_KINDS: ReadonlySet<ChartKind> = new Set(["bar", "grouped", "paired", "progress", "diverging"]);

/**
 * The status columns of `table` that neither name nor plot `plan`'s rows, as
 * a {@link ChartSpec.matrix} over the rows `order`: two to {@link MAX_MATRIX}
 * of them, saying more than one thing between them.
 */
function statusMatrix(table: TableAnalysis, plan: ChartPlan, order: readonly number[]): StatusColumn[] | undefined {
	const taken = new Set([plan.label, ...(plan.qualifiers ?? []), plan.group, ...plan.series]);
	const columns = table.columns.filter(column => column.statuses && !taken.has(column.index));
	if (columns.length < 2 || columns.length > MAX_MATRIX) return undefined;
	const seen = new Set(columns.flatMap(column => order.map(row => column.statuses![row])).filter(Boolean));
	if (seen.size < 2) return undefined;
	return columns.map(column => ({ name: column.header, statuses: order.map(row => column.statuses![row]) }));
}

/**
 * What a `timeline` or `waterfall` of `entry` (drawn over `rows`) adds to its
 * spec: the segments' starts from {@link ChartPlan.offsets}; the total the
 * steps reach (the table's total row, else their sum written like their
 * figures); and the cap row ({@link ChartPlan.limit}) as a reference rule.
 */
function flowSpec(
	table: TableAnalysis,
	plan: ChartPlan,
	rows: readonly number[],
	entry: ChartSeries,
): Pick<ChartSpec, "x" | "total" | "annotations"> {
	const column = table.columns[plan.series[0] ?? -1];
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	const offsets = plan.kind === "timeline" && plan.offsets !== undefined ? table.columns[plan.offsets] : undefined;
	const starts = offsets && rows.map(row => flowCell(offsets, row)?.value ?? Number.NaN);
	const x =
		offsets && starts?.every(Number.isFinite)
			? { name: offsets.header, dim: offsets.dim ?? entry.dim, unit: offsets.unit, values: starts }
			: undefined;
	const row = column && table.totals.find(at => flowCell(column, at));
	const cell = row === undefined || !column ? undefined : flowCell(column, row);
	const values = entry.points.flatMap(point => (point ? [point] : []));
	const total =
		cell && label
			? { name: label.cells[row!]!.text, point: point(cell) }
			: {
					name: "Total",
					point: {
						value: values.reduce((sum, point) => sum + point.value, 0),
						// Durations mix units (`8s`, `4:14`); the renderer says their sum as people do (`6m 36s`).
						text: entry.dim === "duration" ? "" : sumFigure(values),
						emphasis: false,
					},
				};
	const cap =
		plan.kind === "waterfall" && plan.limit !== undefined && column ? flowCell(column, plan.limit) : undefined;
	const capName = label && plan.limit !== undefined ? label.cells[plan.limit]!.text : "";
	return {
		x,
		total,
		annotations: cap
			? [{ kind: "reference", value: cap.value, label: `${capName} ${cap.figure}`.trim() }]
			: undefined,
	};
}

/**
 * The sum of `points` written like their figures (`~$5.0M` + `~$0.9M` →
 * `~$8.0M`, approximate when any part is), when all share a currency, a unit
 * and a scale; else empty, for the renderer to format.
 */
function sumFigure(points: readonly ChartPoint[]): string {
	const figure = /^([~≈≤≥<>]?)\s*([+\-−]?)\s*([$€£¥]?)\s*(\d[\d,]*)(?:\.(\d+))?(\s*)([A-Za-zµ]*)$/;
	const read = points.map(point => figure.exec(point.text.trim()));
	if (read.length === 0 || read.some(match => !match)) return "";
	const matches = read as RegExpExecArray[];
	const [first] = matches;
	const scale = (match: RegExpExecArray, at: number) => {
		const written = Number(`${match[4]!.replaceAll(",", "")}.${match[5] ?? "0"}`);
		return written ? Math.abs(points[at]!.value) / written : Number.NaN;
	};
	const factor = matches.map(scale).find(Number.isFinite) ?? 1;
	if (
		matches.some(
			(match, at) =>
				match[3] !== first![3] ||
				match[7] !== first![7] ||
				(Number.isFinite(scale(match, at)) && Math.abs(scale(match, at) / factor - 1) > 1e-6),
		)
	)
		return "";
	const decimals = Math.max(...matches.map(match => match[5]?.length ?? 0));
	const sum = points.reduce((total, point) => total + point.value, 0) / factor;
	const digits = Math.abs(sum).toLocaleString("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
		useGrouping: matches.some(match => match[4]!.includes(",")) || Math.abs(sum) >= 10_000,
	});
	const approx = matches.some(match => match[1]) ? "~" : "";
	return `${approx}${sum < 0 ? "−" : ""}${first![3]}${digits}${first![6]}${first![7]}`;
}

/**
 * `rows` sorted by `order`'s column within each run of one `group` value (all
 * of them without a group); rows without a number of it keep their place at
 * the end, ties keep table order.
 */
function rank(
	rows: readonly number[],
	group: TableColumn | undefined,
	order: RowOrder | undefined,
	table: TableAnalysis,
): readonly number[] {
	const column = order && table.columns[order.column];
	if (!order || !column) return rows;
	const sign = order.direction === "descending" ? -1 : 1;
	// A cell of another dimension (`12c $128` under `8c`) is no rank of this column.
	const value = (row: number) => {
		const cell = column.cells[row];
		return isNumber(cell) && cell.dim === column.dim ? cell.value : Number.NaN;
	};
	const runs: number[][] = [];
	for (const row of rows) {
		const last = runs.at(-1);
		if (last && (!group || nameCell(group, last[0]!) === nameCell(group, row))) last.push(row);
		else runs.push([row]);
	}
	return runs.flatMap(run =>
		run.toSorted((a, b) => {
			const [x, y] = [value(a), value(b)];
			if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
			return sign * (x - y);
		}),
	);
}

/**
 * Positions in `rows` of the rows `reference` marks, one per run of one `group` value; else `undefined`.
 * A run holding the reference value twice (`bash` for each model within one task) has no single row to
 * compare against, so none is marked rather than measuring one model against another's baseline.
 */
function referenceRows(
	table: TableAnalysis,
	reference: RowReference | undefined,
	group: TableColumn | undefined,
	rows: readonly number[],
): readonly number[] | undefined {
	const column = reference && table.columns[reference.column];
	if (!reference || !column) return undefined;
	const marked: number[] = [];
	const seen = new Set<string>();
	for (const [at, row] of rows.entries()) {
		if (nameCell(column, row) !== reference.value) continue;
		const run = group ? nameCell(group, row) : "";
		if (seen.has(run)) return undefined;
		seen.add(run);
		marked.push(at);
	}
	return marked.length ? marked : undefined;
}

/**
 * Share of a log axis' span (in decades) a dumbbell's largest move must cover to read as a move; smaller
 * moves shrink to dots beside rows decades apart, and their factors read better aligned at 1×.
 */
const VISIBLE_MOVE = 0.25;

/**
 * The baseline and compared column of a dumbbell pick whose values span
 * {@link DECADES}× or more — a direction pair ({@link isTransition}: `Before |
 * After`, `Current | New`), or one column of `a → b` cells — whose factors a
 * `change` chart aligns at 1×, else `undefined`. Rows in no one measured unit
 * ({@link DOT_DIMS}: counts, rows of `px`, `rem` and plain numbers) are
 * different quantities, compared by factor. Timings, sizes and prices in one
 * unit keep their dumbbell on a log axis, where its length is the factor it
 * prints — unless every move is too short to see there ({@link VISIBLE_MOVE}:
 * benchmarks moving a few percent across rows from ns to µs). Peers (`xutf |
 * std`) keep their dumbbell.
 */
function beforeAfter(table: TableAnalysis, columns: readonly TableColumn[]): TableColumn[] | undefined {
	const [a, b] = columns;
	if (!a || columns.length > 2) return undefined;
	const pair = !b
		? a.arrowShare >= 0.6
			? [a]
			: undefined
		: a.dim !== b.dim
			? undefined
			: isTransition(a.header, b.header)
				? [a, b]
				: isTransition(b.header, a.header)
					? [b, a]
					: undefined;
	if (!pair) return undefined;
	const [from, to] = pair;
	const moves = table.rows.flatMap((row): [number, number][] => {
		const start = from!.cells[row];
		if (!to) return isNumber(start) && start.to !== undefined ? [[start.value, start.to]] : [];
		const end = to.cells[row];
		return isNumber(start) && isNumber(end) ? [[start.value, end.value]] : [];
	});
	const positive = moves.flat().filter(value => value > 0);
	const spread = positive.length >= 4 ? Math.max(...positive) / Math.min(...positive) : 1;
	if (spread < DECADES) return undefined;
	const measured = pair.every(
		column => column.dim !== undefined && DOT_DIMS.has(column.dim) && column.unit === from!.unit,
	);
	const reach = Math.max(
		0,
		...moves.flatMap(([start, end]) => (start > 0 && end > 0 ? [Math.abs(Math.log(end / start))] : [])),
	);
	return measured && reach >= VISIBLE_MOVE * Math.log(spread) ? undefined : pair;
}

/**
 * The plotted columns baseline first when one of them is the baseline every
 * other moves from ({@link isTransition}: `baseline` beside `bash | http`, the
 * only header marking a reference: {@link soleMark}) — where several headers
 * mark one, the rival leading most rows ({@link leadingColumn}) — and two rows
 * typically differ {@link ROW_SPREAD}× or more: one shared axis flattens the
 * small rows, while factors of the baseline show each row's pattern at any size.
 */
function againstBaseline(
	table: TableAnalysis,
	plan: ChartPlan,
	columns: readonly TableColumn[],
): TableColumn[] | undefined {
	// More than grouped bars hold (a heatmap's worth) would crowd each row with bars.
	if (columns.length < 2 || columns.length > MAX_GROUPED || new Set(columns.map(column => column.dim)).size > 1)
		return undefined;
	const marked = columns.find(column =>
		columns.every(other => other === column || isTransition(column.header, other.header)),
	);
	const baseline =
		marked && soleMark(columns, marked) ? marked : marked ? leadingColumn(table, plan, columns) : undefined;
	if (!baseline) return undefined;
	const grid = columns.map(column =>
		table.rows.map(row => {
			const cell = column.cells[row];
			return isNumber(cell) && cell.value > 0 ? cell.value : Number.NaN;
		}),
	);
	if (pairSpread(grid) < ROW_SPREAD) return undefined;
	return [baseline, ...columns.filter(column => column !== baseline)];
}

/** Relative slack within which a ratio column restates the ratio of two others (`4.1×` for 75.3 / 18.2). */
const RATIO_SLACK = 0.05;

/**
 * Of three plotted columns, the two same-unit measures when the third is their ratio (`Speedup`
 * `4.1×`, a `ratio` column) matching `a ÷ b` or `b ÷ a` within {@link RATIO_SLACK}
 * in every row holding all three, two rows at least; else `undefined`.
 */
function ratioPair(table: TableAnalysis, columns: readonly TableColumn[]): [TableColumn, TableColumn] | undefined {
	if (columns.length !== 3) return undefined;
	const ratio = columns.find(column => column.dim === "ratio");
	const rest = columns.filter(column => column !== ratio);
	const [a, b] = rest;
	if (!ratio || !a || !b || a.dim !== b.dim || a.unit !== b.unit || a.dim === "ratio") return undefined;
	const near = (value: number, target: number) => Math.abs(value - target) <= RATIO_SLACK * target;
	let matched = 0;
	for (const row of table.rows) {
		const [x, y, r] = [a.cells[row], b.cells[row], ratio.cells[row]];
		if (!isNumber(x) || !isNumber(y) || !isNumber(r) || x.value <= 0 || y.value <= 0) continue;
		if (!near(r.value, x.value / y.value) && !near(r.value, y.value / x.value)) return undefined;
		matched++;
	}
	return matched >= 2 ? [a, b] : undefined;
}

/**
 * Measure columns pairing a before condition with another over the same
 * metric (`Baseline Turns` → `Iter1 Turns`, `Baseline Tokens In` → `Iter1
 * Tokens In`): the before column's words without its condition word, plus one
 * or two words naming the other condition. Same dimension within a pair; a
 * before column several columns could pair with (`stock c4` beside `branch c4`
 * and `tsc-rs c4`) makes no pairs: that table compares more than two conditions.
 */
function metricPairs(measures: readonly TableColumn[]): [TableColumn, TableColumn][] {
	const words = (header: string) =>
		header
			.toLowerCase()
			.split(/[^a-z0-9.]+/)
			.filter(Boolean);
	const pairs: [TableColumn, TableColumn][] = [];
	for (const before of measures) {
		if (!BEFORE.test(before.header)) continue;
		const subject = words(before.header).filter(word => !BEFORE.test(word));
		if (subject.length === 0) continue;
		const partners = measures.filter(column => {
			if (column === before || column.dim !== before.dim || BEFORE.test(column.header)) return false;
			const own = words(column.header);
			const extra = own.filter(word => !subject.includes(word));
			return subject.every(word => own.includes(word)) && extra.length >= 1 && extra.length <= 2;
		});
		if (partners.length > 1) return [];
		const after = partners[0];
		if (after && !pairs.some(([, taken]) => taken === after)) pairs.push([before, after]);
	}
	return pairs;
}

/**
 * Whether two headers name one quantity under two conditions — the one
 * before/after helper every pair decision goes through (the judge's `pair`
 * answer stands in for it where the headers say nothing): a before/after word
 * ({@link isTransition}) or the same words around one that differs (`gpt-5.5
 * window | gpt-5.4 (target) window`, `Q5_K_M | Q4_K_M`). Identical headers (a
 * list wrapped into two halves) and unrelated quantities (`Verts | Faces`,
 * `Tier | New Findings`) are no pair.
 */
export function isConditionPair(first: string, second: string): boolean {
	const words = (header: string) =>
		header
			.toLowerCase()
			.split(/[^a-z0-9.]+/)
			.filter(Boolean);
	const [a, b] = [words(first), words(second)];
	if (a.join(" ") === b.join(" ")) return false;
	if (isTransition(first, second)) return true;
	const shared = a.filter(word => b.includes(word));
	return shared.length > 0 && shared.length < Math.max(a.length, b.length);
}

/**
 * The direction of a condition pair: `first` names the before state and
 * `second` the after one (`Baseline | Iter20`, `old (diff) | new`, `Stock |
 * Patched`), so the pair reads as a move from `first` to `second`. A pair
 * without such words (`xutf | std`, `Q5_K_M | Q4_K_M`) has no direction: peers.
 */
export function isTransition(first: string, second: string): boolean {
	return (BEFORE.test(first) && !BEFORE.test(second)) || (AFTER.test(second) && !AFTER.test(first));
}

/** Most stages a slope chart runs through; more read as a line over the columns. */
const MAX_STAGES = 4;
/** Headers naming a later stage of a run (`Iter 4`, `Best (Iter 3)`, `Round 1`, `Now`, `Final`). */
const STAGE_HEADER =
	/\b(?:(?:iter(?:ation)?|round|run|pass|step|stage|phase|attempt|v)\s*\d+|r\d+|now|after|then|final|latest|current|best|new|fixed|patched|optimi[sz]ed|today)\b/i;
/**
 * Pairs of headers naming opposing amounts, the losing side first: lines
 * removed against added, losses against wins or gains, closed against opened.
 */
const OPPOSED: readonly (readonly [RegExp, RegExp])[] = [
	[/\b(?:removed|removals?|deletions?|deleted|dels)\b/i, /\b(?:added|additions?|insertions?|inserted|adds)\b/i],
	[/\b(?:loss(?:es)?|lost)\b/i, /\b(?:wins?|won|gain(?:s|ed)?)\b/i],
	[/\b(?:closed|deleted)\b/i, /\b(?:opened|created)\b/i],
	[/\b(?:outflows?|debits?|sells?|downvotes?)\b/i, /\b(?:inflows?|credits?|buys?|upvotes?)\b/i],
];
/** Dimensions of amounts that can stand back to back: tallies, sizes, money and time. */
const OPPOSED_DIMS: Partial<Record<Dimension, true>> = { count: true, bytes: true, currency: true, duration: true };

/**
 * Three to {@link MAX_STAGES} adjacent same-unit measures holding one quantity
 * at successive stages of a run: a before column (`Baseline`, `Original`)
 * followed by later stages ({@link STAGE_HEADER}: `Iter 1 | Iter 2`, `Best (Iter
 * 3) | Iter 4`, `Round 1 | Now`), each typically within {@link QUANTITY_SPREAD}×
 * of the first row by row (a `Tokens In (Iter2)` beside turns is another
 * quantity). Deltas and totals end the run. `undefined` when no such run exists.
 */
export function stageColumns(measures: readonly TableColumn[], rows: readonly number[]): TableColumn[] | undefined {
	const near = (first: TableColumn, next: TableColumn) => {
		const ratios = rows
			.flatMap(row => {
				const [a, b] = [first.cells[row], next.cells[row]];
				return isNumber(a) && isNumber(b) && a.value > 0 && b.value > 0
					? [Math.max(a.value, b.value) / Math.min(a.value, b.value)]
					: [];
			})
			.sort((a, b) => a - b);
		return ratios.length > 0 && ratios[ratios.length >> 1]! < QUANTITY_SPREAD;
	};
	for (const [at, first] of measures.entries()) {
		if (!BEFORE.test(first.header) || first.mixed || DELTA.test(first.header) || first.arrowShare >= 0.6) continue;
		const run = [first];
		for (const next of measures.slice(at + 1)) {
			if (run.length === MAX_STAGES || next.index !== run.at(-1)!.index + 1) break;
			if (
				next.dim !== first.dim ||
				next.unit !== first.unit ||
				next.mixed ||
				next.arrowShare >= 0.6 ||
				BEFORE.test(next.header) ||
				DELTA.test(next.header) ||
				AGGREGATE.test(next.header) ||
				!STAGE_HEADER.test(next.header) ||
				!near(first, next)
			)
				break;
			run.push(next);
		}
		if (run.length >= 3) return run;
	}
	return undefined;
}

/**
 * Two same-unit measures of opposing amounts ({@link OPPOSED}: `Removed |
 * Added`, `Losses | Wins`), the losing side first, neither a delta or a total
 * and neither naming both sides; `undefined` when no such pair exists.
 */
export function opposedColumns(measures: readonly TableColumn[]): [TableColumn, TableColumn] | undefined {
	const plain = measures.filter(
		column =>
			column.dim !== undefined &&
			OPPOSED_DIMS[column.dim] &&
			!column.mixed &&
			!column.scores &&
			column.arrowShare < 0.6 &&
			// `Gained` reads as a delta word, yet it is one side of a pair here.
			(!DELTA.test(column.header) || OPPOSED.some(([, gains]) => gains.test(column.header))) &&
			!AGGREGATE.test(column.header),
	);
	for (const [loses, gains] of OPPOSED) {
		const loss = plain.find(column => loses.test(column.header) && !gains.test(column.header));
		const gain = plain.find(column => gains.test(column.header) && !loses.test(column.header));
		if (loss && gain && loss.dim === gain.dim && loss.unit === gain.unit) return [loss, gain];
	}
	return undefined;
}

/** Most categories a best mark singles out of; beyond it the mark is lost among the rows. */
const MAX_RIVALS = 16;

/**
 * Per category, the series with its best value among the rival columns: the
 * most series sharing one unit and one polarity, two at least (`pi-walker`
 * and `Go` beside their `Speedup`); `undefined` where tied or missing.
 */
function columnLeaders(
	categories: readonly string[],
	series: readonly ChartSeries[],
): (number | undefined)[] | undefined {
	const kinds = new Map<string, number[]>();
	series.forEach((entry, index) => {
		if (!entry.polarity) return;
		const kind = `${entry.polarity}:${entry.dim}:${entry.unit}`;
		kinds.set(kind, [...(kinds.get(kind) ?? []), index]);
	});
	const rivals = [...kinds.values()].sort((a, b) => b.length - a.length)[0];
	if (!rivals || rivals.length < 2) return undefined;
	const sign = series[rivals[0]!]!.polarity === "higher" ? 1 : -1;
	return categories.map((_, at) => {
		const ranked = rivals
			.flatMap(index => {
				const point = series[index]!.points[at];
				return point ? [{ index, value: sign * point.value }] : [];
			})
			.sort((a, b) => b.value - a.value);
		return ranked.length >= 2 && ranked[0]!.value !== ranked[1]!.value ? ranked[0]!.index : undefined;
	});
}

/**
 * The category holding `series`' best value by its polarity among the
 * `rivals` categories (all by default): one of at least `least` values, not
 * tied with another.
 */
function bestPoint(series: ChartSeries, rivals?: readonly boolean[], least = 3): number | undefined {
	if (!series.polarity) return undefined;
	const sign = series.polarity === "higher" ? 1 : -1;
	const ranked = series.points
		.flatMap((point, at) => (point && (rivals?.[at] ?? true) ? [{ at, value: sign * point.value }] : []))
		.sort((a, b) => b.value - a.value);
	if (ranked.length < least || ranked.length > MAX_RIVALS) return undefined;
	const [first, second] = [ranked[0]!, ranked[1]!];
	if (first.value === second.value) return undefined;
	return first.at;
}

/** Most takeaways offered for one chart; the strongest first. */
const MAX_TAKEAWAYS = 8;
/** Most series whose extremes are offered as takeaways. */
const TAKEAWAY_SERIES = 4;
/** Factor between the top value and the next from which the top is an outlier worth naming. */
const OUTLIER = 2;
/** Factor from which an outlier or a move is striking enough to state unprompted. */
const STRIKING = 3;
/** Factor from which a before/after move is striking enough to state unprompted. */
const STRIKING_MOVE = 2;
/** Share of a stack's wholes one part must make up to be worth stating. */
const DOMINANT_PART = 0.6;
/** Share of a run's total two steps make up from which they are what the run is (`build` and `check` are 85%). */
const DOMINANT_PAIR = 0.75;
/** Share of a run's total the second of a {@link DOMINANT_PAIR} must make up to be named beside the first. */
const SECOND_PART = 0.15;
/** Factor within which a category barely moved, neither with nor against the rest. */
const STILL_FACTOR = 1.03;
/** Weight lifting a whole-table move above every single move (a log factor stays far below it). */
const CONSENSUS_WEIGHT = 20;
/** Weight lifting a contest's outcome (a sweep, a trade-off, a column best in most rows) above a ×20 outlier. */
const RIVALRY_WEIGHT = 4;

/** A takeaway with the weight ranking it among a chart's others. */
interface Fact extends Takeaway {
	readonly weight: number;
}

/**
 * Facts `spec` could state as its headline, unranked: the largest moves of a
 * change or dumbbell (and every row moving one way), a group or category
 * standing far above the next, one rival best on several measures (or best
 * on one at the highest cost), each series' top value and its best one, ties
 * at the top, the overall move of a line, the largest share. Each is a short
 * sentence over the figures as the table wrote them.
 */
function chartFacts(spec: ChartSpec): Fact[] {
	const facts: Fact[] = [];
	const { categories, series } = spec;
	const name = (at: number) => categories[at]!;
	// Dots against a baseline column plot its factors, like a `change`.
	if (spec.kind === "change" || (spec.kind === "dots" && spec.baseline)) {
		for (const entry of series.slice(0, TAKEAWAY_SERIES)) {
			const moves = entry.points.flatMap((point, at) => (point && point.value > 0 ? [{ at, point }] : []));
			moves.sort((a, b) => Math.abs(Math.log(b.point.value)) - Math.abs(Math.log(a.point.value)));
			const lead = series.length > 1 ? `${entry.name} ` : "";
			for (const { at, point } of moves.slice(0, 2)) {
				const move = factorWords(point.value);
				if (move === "same") continue;
				const weight = Math.abs(Math.log(point.value));
				facts.push({
					key: `move:${entry.name}:${name(at)}`,
					text: `${name(at)}: ${lead}${move}${spec.rival ? ` vs ${spec.baseline}` : ""} (${point.text})`,
					weight,
					striking: weight >= Math.log(STRIKING_MOVE),
				});
			}
			if (spec.rival) {
				const gap = rivalGap(spec, entry);
				if (gap) facts.push(gap);
				continue;
			}
			const consensus = consensusMove(
				spec,
				entry.points.map(point => point?.value),
				entry.points.map((_, at) => spec.categoryPolarity?.[at] ?? entry.polarity),
				`every ${rowNoun(spec)}`,
				series.length > 1 ? ` on ${entry.name}` : "",
			);
			if (consensus) facts.push({ ...consensus, key: `moves:${entry.name}` });
		}
	} else if ((spec.kind === "paired" || spec.kind === "range") && series.length === 2) {
		const [before, after] = series as [ChartSeries, ChartSeries];
		// Two rivals on one axis (`in-memory` vs `disk`) make no move: an `a → b` would misstate them.
		// A range chart's first two series move only as its transition (one unit, before/after words).
		if (spec.kind === "range" ? spec.transition : isTransition(before.name, after.name)) {
			// Intervals move by the factor between their middles, as the range chart prints it.
			const value = (point: ChartPoint) => (spec.kind === "range" ? intervalMiddle(point) : point.value);
			const factors = categories.map((_, at) => {
				const [a, b] = [before.points[at], after.points[at]];
				if (!a || !b) return undefined;
				// Zero staying zero stood still; from zero there is no factor.
				return value(a) > 0 ? value(b) / value(a) : value(b) === 0 ? 1 : undefined;
			});
			factors.forEach((factor, at) => {
				const move = factor === undefined ? "same" : factorWords(factor);
				if (move === "same") return;
				facts.push({
					key: `move:${name(at)}`,
					text: `${name(at)}: ${before.points[at]!.text} → ${after.points[at]!.text} (${move})`,
					weight: Math.abs(Math.log(Math.max(factor!, 1e-9))),
					// One row's move may be noise (`1 → 2`); the whole table moving together is the finding.
					striking: false,
				});
			});
			const polarity = after.polarity ?? before.polarity;
			const polarities = factors.map(() => polarity);
			const consensus =
				consensusMove(
					spec,
					factors,
					polarities,
					`every ${rowNoun(spec)}`,
					` from ${before.name} to ${after.name}`,
				) ?? splitMove(spec, factors, polarities, at => `${before.points[at]!.text} → ${after.points[at]!.text}`);
			if (consensus) facts.push(consensus);
		} else facts.push(...peerFacts(spec, before, after));
	} else if (spec.kind === "line") {
		for (const entry of series.slice(0, TAKEAWAY_SERIES)) {
			const present = entry.points.flatMap((point, at) => (point ? [{ at, point }] : []));
			const [first, last] = [present[0], present.at(-1)];
			if (!first || !last || first === last || first.point.value <= 0) continue;
			const factor = last.point.value / first.point.value;
			facts.push({
				key: `trend:${entry.name}`,
				text: `${entry.name}: ${first.point.text} → ${last.point.text} from ${name(first.at)} to ${name(last.at)} (${factorWords(factor)})`,
				weight: Math.abs(Math.log(factor)),
				striking: false,
			});
		}
		facts.push(...peakFacts(spec));
	} else if (spec.kind === "stacked") {
		// Parts of a whole: facts about the wholes, and a part making up most of them.
		if (spec.whole) facts.push(...extremes(spec, spec.whole));
		const sums = series.map(entry => entry.points.reduce((total, point) => total + (point?.value ?? 0), 0));
		const grand =
			spec.whole?.points.reduce((total, point) => total + (point?.value ?? 0), 0) ??
			sums.reduce((total, sum) => total + sum, 0);
		const lead = sums.indexOf(Math.max(...sums));
		const part = grand > 0 ? sums[lead]! / grand : 0;
		if (part >= DOMINANT_PART)
			facts.push({
				key: `part:${series[lead]!.name}`,
				text: `${series[lead]!.name} is ${Math.round(part * 100)}% of ${spec.whole?.name ?? "the total"}`,
				weight: 1 + part,
				striking: false,
			});
		// A mix: the row where each outcome other than the good ones runs highest, weighed against its rate overall.
		if (spec.normalized && spec.tones)
			series.forEach((entry, index) => {
				if (spec.tones![index] === "good" || !(sums[index]! > 0) || !(grand > 0)) return;
				const rates = categories.map((_, at) => {
					const total =
						spec.whole?.points[at]?.value ||
						series.reduce((sum, other) => sum + (other.points[at]?.value ?? 0), 0);
					return total > 0 ? (entry.points[at]?.value ?? 0) / total : 0;
				});
				const top = rates.indexOf(Math.max(...rates));
				facts.push({
					key: `mix:${entry.name}`,
					text: `${name(top)} has the highest ${entry.name} rate (${percentText(rates[top]! * 100)})`,
					weight: 1 + Math.log(rates[top]! / (sums[index]! / grand)),
					striking: false,
				});
			});
	} else if ((spec.kind === "timeline" || spec.kind === "waterfall") && spec.total) {
		facts.push(...flowFacts(spec, spec.total.point));
	} else if (spec.kind === "bullet" && spec.targets) {
		facts.push(...targetFacts(spec, spec.targets));
	} else if (spec.kind === "stat") {
		facts.push(...statFacts(spec));
	} else if (spec.kind === "slope" && series.length >= 2) {
		facts.push(...slopeFacts(spec));
	} else if (spec.kind === "ladder") {
		facts.push(...ladderFacts(spec));
	} else if (spec.kind === "histogram") {
		facts.push(...histogramFacts(spec));
	} else if (spec.kind === "butterfly" && series.length === 2) {
		facts.push(...butterflyFacts(spec));
	} else if (spec.kind === "share") {
		const top = byValue(series[0]!.points)[0];
		const total = series[0]!.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0);
		// Counts gain the share the table never wrote.
		const share =
			top && series[0]!.dim !== "percent" && total > 0
				? `${top.point.text}, ${percentText((100 * top.point.value) / total)}`
				: top?.point.text;
		const majority = majorityPart(spec, series[0]!);
		if (majority) facts.push(majority);
		else if (top)
			facts.push({
				key: "share:top",
				text: `${name(top.at)} is the largest share (${share})`,
				weight: 1,
				striking: false,
			});
	} else {
		// Earlier columns are what the table leads with: their facts weigh a little more.
		series.slice(0, TAKEAWAY_SERIES).forEach((entry, index) => {
			for (const fact of extremes(spec, entry)) facts.push({ ...fact, weight: fact.weight - 0.2 * index });
		});
		facts.push(...rivalry(spec));
		facts.push(...referenceMoves(spec));
	}
	return facts;
}

/**
 * What a run of steps is mostly made of: the largest step (or group of steps)
 * making up {@link DOMINANT_PART} of `total`; or the two largest together
 * making up {@link DOMINANT_PAIR} of it, the second {@link SECOND_PART} at
 * least, when the first alone falls short or the table bolded both — striking
 * in a run of four or more.
 */
function flowFacts(spec: ChartSpec, total: ChartPoint): Fact[] {
	const entry = spec.series[0]!;
	if (total.value <= 0) return [];
	let at = 0;
	const units = spec.groups
		? spec.groups.flatMap(group => {
				const points = group.members.map(() => entry.points[at++]);
				// Rows outside every group stand on their own.
				return group.name && points.length > 1
					? [{ name: group.name, value: points.reduce((sum, point) => sum + (point?.value ?? 0), 0), bold: false }]
					: points.map((point, index) => ({
							name: spec.categories[at - points.length + index]!,
							value: point?.value ?? 0,
							bold: point?.emphasis ?? false,
						}));
			})
		: spec.categories.map((name, index) => ({
				name,
				value: entry.points[index]?.value ?? 0,
				bold: entry.points[index]?.emphasis ?? false,
			}));
	if (units.some(unit => unit.value < 0)) return [];
	units.sort((a, b) => b.value - a.value);
	const [first, second] = units;
	if (!first || !second) return [];
	const of = total.text ? `of ${total.text}` : "of the total";
	const lead = first.value / total.value;
	const pair = (first.value + second.value) / total.value;
	const striking = units.length >= 4;
	// The largest alone tells most of it, unless the table bolded the second beside it.
	const named = lead < DOMINANT_PART || (first.bold && second.bold);
	if (named && pair >= DOMINANT_PAIR && second.value / total.value >= SECOND_PART)
		return [
			{
				key: `part:${first.name}`,
				text: `${first.name} and ${second.name} are ${Math.round(pair * 100)}% ${of}`,
				weight: 1 + pair,
				striking,
			},
		];
	if (lead < DOMINANT_PART) return [];
	return [
		{
			key: `part:${first.name}`,
			text: `${first.name} is ${Math.round(lead * 100)}% ${of}`,
			weight: 1 + lead,
			striking,
		},
	];
}

/** Most rows missing their targets a takeaway names; past it, it names the worst. */
const MAX_MISSES_NAMED = 2;

/**
 * What a `bullet` chart says of its targets, over the rows whose target has a side ({@link targetStanding}):
 * how many meet theirs and which miss (`3 of 4 within budget; Allocations, steady scroll misses (7,246 vs ≤
 * 0)`; two by name, the worst of more), or — all meeting — the closest (`All 12 within target; closest:
 * History, last 100 at 91%`). Striking: meeting the targets is the table's point.
 */
function targetFacts(spec: ChartSpec, targets: readonly (ChartTarget | null)[]): Fact[] {
	const entry = spec.series[0]!;
	const standings = targets.flatMap((target, at) => {
		const point = entry.points[at];
		const standing = point && target ? targetStanding(point, target) : undefined;
		return point && target && standing ? [{ at, point, target, ...standing }] : [];
	});
	if (standings.length < 2) return [];
	type Standing = (typeof standings)[number];
	const word = spec.targetName ?? "target";
	const said = (standing: Standing) =>
		`${spec.categories[standing.at]!} (${standing.point.text} vs ${standing.target.text})`;
	// How far past (or how near) its target a row is: its share of a ceiling, a floor's share of it.
	const reach = (standing: Standing) =>
		standing.share === undefined
			? Number.POSITIVE_INFINITY
			: standing.target.bound === "min"
				? 1 / Math.max(standing.share, 1e-9)
				: standing.share;
	const missed = standings.filter(standing => !standing.met).sort((a, b) => reach(b) - reach(a));
	const count = standings.length;
	let text: string;
	if (missed.length === 0) {
		const closest = standings
			.filter(standing => standing.share !== undefined && standing.target.upper === undefined)
			.sort((a, b) => reach(b) - reach(a))[0];
		// Under a ceiling the share says it (`at 91%`); over a floor the figures do.
		const near = !closest
			? ""
			: closest.target.bound === "max"
				? `; closest: ${spec.categories[closest.at]!} at ${Math.round(closest.share! * 100)}%`
				: `; closest: ${said(closest)}`;
		// Rows the chart could not hold to their target (`≤ 3s / ≤ 6s`, other units) may still miss it.
		const unchecked = targets.length > count ? " checked" : "";
		text = `All ${count}${unchecked} within ${word}${near}`;
	} else if (missed.length === count) text = `None of ${count} within ${word}; worst: ${said(missed[0]!)}`;
	else if (missed.length === 1) {
		const miss = missed[0]!;
		text = `${count - 1} of ${count} within ${word}; ${spec.categories[miss.at]!} misses (${miss.point.text} vs ${miss.target.text})`;
	} else if (missed.length <= MAX_MISSES_NAMED)
		text = `${count - missed.length} of ${count} within ${word}; ${list(missed.map(standing => spec.categories[standing.at]!))} miss`;
	else text = `${count - missed.length} of ${count} within ${word}; worst: ${said(missed[0]!)}`;
	return [{ key: "target", text, weight: CONSENSUS_WEIGHT, striking: true }];
}

/**
 * Facts between two peers on one axis (`xutf` vs `std`, two windows per
 * provider): one ahead of the other in every category by its polarity
 * (`xutf beats std in every row (4.5–15×)`), striking from a
 * {@link STRIKING_MOVE}× lead everywhere; or both equal in every category but
 * one (`… match on every provider but github-copilot (400,000 vs 272,000)`).
 * Intervals compare by their middles.
 */
function peerFacts(spec: ChartSpec, first: ChartSeries, second: ChartSeries): Fact[] {
	if (first.dim !== second.dim || first.unit !== second.unit) return [];
	const value = (point: ChartPoint) => (spec.kind === "range" ? intervalMiddle(point) : point.value);
	const both = spec.categories.flatMap((_, at) => {
		const [a, b] = [first.points[at], second.points[at]];
		return a && b && value(a) > 0 && value(b) > 0 ? [{ at, a, b }] : [];
	});
	if (both.length < 3 || both.length < spec.categories.length) return [];
	const noun = rowNoun(spec);
	const differ = both.filter(item => item.a.text !== item.b.text && value(item.a) !== value(item.b));
	if (differ.length === 1) {
		const { at, a, b } = differ[0]!;
		// Long series names would crowd out the exception; the legend names them.
		const pair = first.name.length + second.name.length <= MAX_LABEL ? `${first.name} and ${second.name}` : "Both";
		return [
			{
				key: `peers:${spec.categories[at]}`,
				text: `${pair} match on every ${noun} but ${spec.categories[at]} (${a.text} vs ${b.text})`,
				weight: RIVALRY_WEIGHT,
				striking: true,
			},
		];
	}
	const polarity = first.polarity ?? second.polarity;
	if (!polarity || (first.polarity && second.polarity && first.polarity !== second.polarity)) return [];
	// Each category's lead of the first over the second, as a factor above 1 when the first is ahead.
	const leads = both.map(({ a, b }) => (polarity === "higher" ? value(a) / value(b) : value(b) / value(a)));
	const ahead = leads.every(lead => lead > 1);
	if (!ahead && !leads.every(lead => lead < 1)) return [];
	const sorted = leads.map(lead => (ahead ? lead : 1 / lead)).sort((x, y) => x - y);
	const [winner, loser] = ahead ? [first, second] : [second, first];
	const [low, high] = [sorted[0]!, sorted.at(-1)!];
	const margin =
		high < 2
			? `by ${Math.round((low - 1) * 100)}–${Math.round((high - 1) * 100)}%`
			: roundFactor(low) === roundFactor(high)
				? `${roundFactor(high)}×`
				: `${roundFactor(low)}–${roundFactor(high)}×`;
	return [
		{
			key: `peers:${winner.name}`,
			text: `${winner.name} beats ${loser.name} on every ${noun} (${margin})`,
			weight: RIVALRY_WEIGHT + Math.log(low),
			striking: low >= STRIKING_MOVE,
		},
	];
}

/**
 * A slope's stages as takeaways: how each row moved from the first stage to
 * the last, as a dumbbell's moves read ({@link consensusMove},
 * {@link splitMove}: `Every plan improved from Original to Now (−39% to
 * −86%)`); when one row alone turns back at the last stage after moving the
 * other way, by {@link STRIKING_MOVE}× or more, the move closes on it
 * instead of its strongest row (`3 of 4 models improved; kimi regressed from
 * 3 to 6 at Iter 4`): a "none regressed" would hide it. A move already naming
 * a dissenting row keeps it, the turn offered beside it as a plain fact.
 */
function slopeFacts(spec: ChartSpec): Fact[] {
	const { series, categories } = spec;
	const [first, previous, last] = [series[0]!, series.at(-2)!, series.at(-1)!];
	const polarity = last.polarity ?? first.polarity;
	const factors = categories.map((_, at) => {
		const [a, b] = [first.points[at], last.points[at]];
		if (!a || !b) return undefined;
		return a.value > 0 ? b.value / a.value : b.value === 0 ? 1 : undefined;
	});
	const polarities = factors.map(() => polarity);
	const moves =
		consensusMove(spec, factors, polarities, `every ${rowNoun(spec)}`, ` from ${first.name} to ${last.name}`) ??
		splitMove(spec, factors, polarities, at => `${first.points[at]!.text} → ${last.points[at]!.text}`);
	// Rows whose last step undoes the one before it: down then back up (or up then down).
	const turns = categories.flatMap((_, at) => {
		const [a, b, c] = [series.at(-3)?.points[at], previous.points[at], last.points[at]];
		if (!a || !b || !c || a.value <= 0 || b.value <= 0 || c.value <= 0) return [];
		const [before, after] = [b.value / a.value, c.value / b.value];
		const turned = (before < 1 && after > 1) || (before > 1 && after < 1);
		return turned && Math.abs(Math.log(after)) >= Math.log(STRIKING_MOVE) ? [{ at, after }] : [];
	});
	if (turns.length !== 1) return moves ? [moves] : [];
	const { at, after } = turns[0]!;
	const verb = polarity
		? after > 1 === (polarity === "higher")
			? "improved"
			: "regressed"
		: after > 1
			? "rose"
			: "fell";
	const turn = `${categories[at]} ${verb} from ${previous.points[at]!.text} to ${last.points[at]!.text} at ${last.name}`;
	const weight = CONSENSUS_WEIGHT + Math.abs(Math.log(after));
	// A move naming a row against the rest already says the exception; the turn is one more fact, not its title.
	const named = moves && moves.text.includes("; ") && !moves.text.includes(", none ");
	if (!moves || named)
		return [
			...(moves ? [moves] : []),
			{ key: `turn:${categories[at]}`, text: turn, weight: weight - 1, striking: false },
		];
	// The move's head (`3 of 4 models improved`), its "none …" and strongest-row clauses giving way to the turn.
	return [{ key: "moves", text: `${moves.text.split(/, none |; /)[0]}; ${turn}`, weight, striking: true }];
}

/**
 * A quantile ladder's takeaways, its quantiles read as one measurement, never
 * as rivals: the median's extremes ({@link extremes} of the `p50` / `median` /
 * `mean` rung, else the first); the row whose top rung stands farthest above
 * its median (`read has the longest tail: max 86× its p50`), striking when it
 * is {@link OUTLIER}× the next row's; and between a before and an after ladder
 * how the medians moved.
 */
function ladderFacts(spec: ChartSpec): Fact[] {
	const ladder = spec.ladders?.[0];
	if (!ladder || ladder.series.length < 2) return [];
	const rungs = ladder.series.map(index => spec.series[index]!);
	const middle = rungs.find(entry => /^(?:p50|median|mean|avg)\b/i.test(entry.name)) ?? rungs[0]!;
	const top = rungs.at(-1)!;
	const facts: Fact[] = extremes(spec, middle).filter(fact => !fact.key.startsWith("outlier:"));
	if (top !== middle) {
		const tails = spec.categories
			.flatMap((_, at) => {
				const [m, t] = [middle.points[at], top.points[at]];
				return m && t && m.value > 0 ? [{ at, ratio: t.value / m.value }] : [];
			})
			.sort((a, b) => b.ratio - a.ratio);
		const [widest, next] = tails;
		if (widest && widest.ratio >= STRIKING && tails.length >= 2) {
			const apart = next !== undefined && widest.ratio >= OUTLIER * next.ratio;
			facts.push({
				key: `tail:${ladder.name}`,
				text: `${spec.categories[widest.at]} has the longest tail (${top.name} ${roundFactor(widest.ratio)}× its ${middle.name})`,
				weight: Math.log(widest.ratio / (next?.ratio ?? 1)) + 1,
				striking: apart,
			});
		}
	}
	const after = spec.transition ? spec.ladders?.[1] : undefined;
	const moved = after?.series.map(index => spec.series[index]!).find(entry => entry.name === middle.name);
	if (moved) {
		const factors = middle.points.map((point, at) => {
			const end = moved.points[at];
			return point && end && point.value > 0 ? end.value / point.value : undefined;
		});
		const move = consensusMove(
			spec,
			factors,
			factors.map(() => moved.polarity ?? middle.polarity),
			`every ${rowNoun(spec)}'s ${middle.name}`,
			` from ${ladder.name} to ${after!.name}`,
		);
		if (move) facts.push(move);
	}
	return facts;
}

/** Percent points two distributions' shares of one bin must differ by for the shift to be the finding. */
const SHIFT_POINTS = 10;

/**
 * A histogram's takeaways: the bin holding a {@link MAJORITY} of a
 * distribution (`k sessions = 1 holds 80% of project-busy time`), striking at
 * twice the next bin; and between two distributions the bin whose share
 * moved most (`k projects = 1: 73.7% → 55% from all-time to last 30 days`),
 * striking from {@link SHIFT_POINTS} points.
 */
function histogramFacts(spec: ChartSpec): Fact[] {
	const bin = (at: number) => (spec.axis ? `${spec.axis} = ${spec.categories[at]}` : spec.categories[at]!);
	const shares = spec.series.map(entry => {
		const total = entry.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0);
		return entry.points.map(point => (point && total > 0 ? (100 * Math.max(0, point.value)) / total : undefined));
	});
	const facts: Fact[] = [];
	spec.series.slice(0, 1).forEach((entry, index) => {
		const ranked = shares[index]!.flatMap((share, at) => (share === undefined ? [] : [{ at, share }]));
		ranked.sort((a, b) => b.share - a.share);
		const [mode, next] = ranked;
		if (!mode || mode.share < MAJORITY * 100) return;
		// `share of project-busy time` already says it is a share: its whole is what follows `of`.
		const whole = entry.name.replace(/^(?:share|%|percent(?:age)?)\s+of\s+/i, "");
		facts.push({
			key: `mode:${entry.name}`,
			text: `${bin(mode.at)} holds ${percentText(mode.share)} of ${whole}`,
			weight: 1 + mode.share / 100,
			striking: next !== undefined && mode.share >= 2 * next.share,
		});
	});
	if (spec.series.length === 2) {
		const [from, to] = spec.series as [ChartSeries, ChartSeries];
		const shifts = spec.categories
			.flatMap((_, at) => {
				const [a, b] = [shares[0]![at], shares[1]![at]];
				return a !== undefined && b !== undefined ? [{ at, a, b }] : [];
			})
			.sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a));
		const shift = shifts[0];
		if (shift && Math.abs(shift.b - shift.a) >= 1) {
			const written = (entry: ChartSeries, share: number) =>
				entry.dim === "percent" ? entry.points[shift.at]!.text : percentText(share);
			facts.push({
				key: `shift:${spec.categories[shift.at]}`,
				text: `${bin(shift.at)}: ${written(from, shift.a)} → ${written(to, shift.b)} from ${from.name} to ${to.name}`,
				weight: CONSENSUS_WEIGHT + Math.abs(shift.b - shift.a) / 100,
				striking: Math.abs(shift.b - shift.a) >= SHIFT_POINTS,
			});
		}
	}
	return facts;
}

/**
 * A butterfly's takeaway: both sides summed, the larger first, with the row
 * making up most of the larger side (`Added 3,902 vs Removed 296; Non-test Go
 * code is 51% of Added`); striking when one side outweighs the other
 * {@link STRIKING_MOVE}× or more.
 */
function butterflyFacts(spec: ChartSpec): Fact[] {
	const sums = spec.series.map(entry => entry.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0));
	const [low, high] = sums[0]! > sums[1]! ? [1, 0] : [0, 1];
	const [big, small] = [spec.series[high]!, spec.series[low]!];
	if (!(sums[high]! > 0)) return [];
	const figure = (entry: ChartSeries, sum: number) =>
		sumFigure(entry.points.flatMap(point => (point ? [point] : []))) || sum.toLocaleString("en-US");
	const part = majorityPart(spec, big);
	const lead = part ? `; ${part.text.replace(/ of .*$/, ` of ${big.name}`)}` : "";
	const factor = sums[low]! > 0 ? sums[high]! / sums[low]! : Number.POSITIVE_INFINITY;
	return [
		{
			key: "net",
			text: `${big.name} ${figure(big, sums[high]!)} vs ${small.name} ${figure(small, sums[low]!)}${lead}`,
			weight: CONSENSUS_WEIGHT + Math.min(5, Math.log(factor)),
			striking: factor >= STRIKING_MOVE,
		},
	];
}

/** Share of a whole from which its largest part is a majority worth stating as one. */
const MAJORITY = 0.5;
/**
 * The largest of a share's parts when it makes up a {@link MAJORITY} of their
 * sum (`missing is 51% of 1,543`), the sum written like the parts; striking at
 * twice the next part. Percent parts are of `the total`.
 */
function majorityPart(spec: ChartSpec, entry: ChartSeries): Fact | undefined {
	// A part left out (`4.9+ GiB` unread) would shrink the sum it is a share of.
	if (entry.points.some(point => !point || point.value < 0)) return undefined;
	const [top, next] = byValue(entry.points);
	const total = entry.points.reduce((sum, point) => sum + (point?.value ?? 0), 0);
	if (!top || !(total > 0) || top.point.value / total < MAJORITY) return undefined;
	const part = top.point.value / total;
	const sum = entry.dim === "percent" ? "" : sumFigure(entry.points.flatMap(point => (point ? [point] : [])));
	// Parts under a thousand (`786`, `368`) sum past it without the separator a reader expects.
	const whole = /^\d{4,}$/.test(sum) ? Number(sum).toLocaleString("en-US") : sum || "the total";
	return {
		key: "share:top",
		text: `${spec.categories[top.at]} is ${percentText(part * 100)} of ${whole}`,
		weight: 1 + part,
		striking: next !== undefined && top.point.value >= 2 * next.point.value,
	};
}

/** Factor a line's interior peak must stand above both its ends to be named at all. */
const MIN_PEAK_RISE = 1.25;
/** Factor a line's interior peak must stand above both its ends to be a finding of its own. */
const PEAK_RISE = 1.5;
/** Fewest samples a line needs before a peak inside it is a shape, not one step up and one down. */
const MIN_PEAK_SAMPLES = 4;

/**
 * A line chart's interior peaks ({@link linePeak}) as takeaways: two or more
 * lines peaking at one category say it together (`2026-03-30 was the peak of
 * commits (1,374) and +lines (1,529,921)`, `… on all 4 measures`), others
 * alone (`commits peaked at 1,374 in 2026-03-30`). Striking from
 * {@link PEAK_RISE}× over both ends across {@link MIN_PEAK_SAMPLES} samples; a
 * peak the table bolded weighs more.
 */
function peakFacts(spec: ChartSpec): Fact[] {
	const peaks = spec.series.slice(0, TAKEAWAY_SERIES).flatMap(entry => {
		const peak = linePeak(spec, entry);
		return peak ? [{ ...peak, entry, weight: Math.log(peak.rise) + 1 + (peak.point.emphasis ? 0.5 : 0) }] : [];
	});
	const facts: Fact[] = [];
	for (const at of new Set(peaks.map(peak => peak.at))) {
		const shared = peaks.filter(peak => peak.at === at);
		const where = spec.categories[at]!;
		if (shared.length === 1) {
			const { entry, point, weight, striking } = shared[0]!;
			facts.push({
				key: `peak:${entry.name}`,
				text: `${entry.name} peaked at ${point.text} in ${where}`,
				weight,
				striking,
			});
			continue;
		}
		const named =
			shared.length === 2
				? list(shared.map(peak => `${peak.entry.name} (${peak.point.text})`))
				: shared.length === spec.series.length
					? `all ${shared.length} measures`
					: `${shared.length} of ${spec.series.length} measures`;
		facts.push({
			key: `peak:@${where}`,
			text: `${where} was the peak ${shared.length === 2 ? "of" : "on"} ${named}`,
			weight: Math.max(...shared.map(peak => peak.weight)) + 0.5,
			striking: shared.some(peak => peak.striking),
		});
	}
	return facts;
}

/**
 * The highest sample of a line `entry` when it lies inside the line (neither
 * end) and stands {@link MIN_PEAK_RISE}× or more above both ends, with that factor (`rise`)
 * over the higher end — `striking` from {@link PEAK_RISE}× across
 * {@link MIN_PEAK_SAMPLES} samples; samples in x order.
 */
function linePeak(
	spec: ChartSpec,
	entry: ChartSeries,
): { at: number; point: ChartPoint; rise: number; striking: boolean } | undefined {
	const order = spec.categories.map((_, at) => at);
	if (spec.x) order.sort((a, b) => spec.x!.values[a]! - spec.x!.values[b]!);
	const present = order.flatMap(at => {
		const point = entry.points[at];
		return point ? [{ at, point }] : [];
	});
	if (present.length < 3) return undefined;
	const top = present.reduce((best, item) => (item.point.value > best.point.value ? item : best));
	const ends = Math.max(present[0]!.point.value, present.at(-1)!.point.value);
	if (top === present[0] || top === present.at(-1) || ends <= 0) return undefined;
	const rise = top.point.value / ends;
	const striking = rise >= PEAK_RISE && present.length >= MIN_PEAK_SAMPLES;
	return rise >= MIN_PEAK_RISE ? { ...top, rise, striking } : undefined;
}

/** `facts` strongest first, one per key, at most {@link MAX_TAKEAWAYS}. */
function rankFacts(facts: Fact[]): Takeaway[] {
	facts.sort((a, b) => b.weight - a.weight);
	const seen = new Set<string>();
	return facts
		.filter(fact => !seen.has(fact.key) && seen.add(fact.key))
		.slice(0, MAX_TAKEAWAYS)
		.map(({ key, text, striking }) => ({ key, text, striking }));
}

/**
 * Facts across rivals' best values ({@link ChartSeries.best},
 * {@link ChartSpec.leaders}): one row best on two or more measures (a sweep),
 * best on a higher-is-better measure while worst on a lower-is-better one (a
 * trade-off: the top pass rate at the top cost), or one column best in most rows.
 */
function rivalry(spec: ChartSpec): Fact[] {
	const { categories, series } = spec;
	const facts: Fact[] = [];
	const bests = new Map<number, ChartSeries[]>();
	for (const entry of series) {
		if (entry.best === undefined) continue;
		bests.set(entry.best, [...(bests.get(entry.best) ?? []), entry]);
	}
	for (const [at, won] of bests) {
		if (won.length < 2) continue;
		// Past three measures a list of their names outgrows a title line: their count says it.
		const measures =
			won.length <= 3
				? list(won.map(entry => entry.name))
				: won.length === series.length
					? `all ${won.length} measures`
					: `${won.length} of ${series.length} measures`;
		// One measure before and after (`Original`, `Round 1`, `Now`): the row best throughout restates how
		// the rows rank, not a contest won; how they moved is the story.
		const conditions =
			won.every(entry => entry.dim === won[0]!.dim && entry.unit === won[0]!.unit) &&
			isTransition(won[0]!.name, won.at(-1)!.name);
		facts.push({
			key: `sweep:${categories[at]}`,
			text: `${categories[at]} is best on ${measures}`,
			weight: conditions ? 1 : RIVALRY_WEIGHT + 0.3 * won.length,
			striking: !conditions,
		});
	}
	for (const gain of series.filter(entry => entry.polarity === "higher" && entry.best !== undefined)) {
		const top = gain.best!;
		for (const price of series.filter(entry => entry.polarity === "lower")) {
			const costliest = byValue(price.points);
			if (costliest[0]?.at !== top || costliest[1]?.point.value === costliest[0].point.value) continue;
			facts.push({
				key: `tradeoff:${gain.name}:${price.name}`,
				text: `${categories[top]} has the highest ${gain.name} (${gain.points[top]!.text}) but also the highest ${price.name} (${price.points[top]!.text})`,
				// Above a two-measure sweep (often one measure twice: `pass` and `pass%`), below a wider one.
				weight: RIVALRY_WEIGHT + 0.7,
				striking: true,
			});
		}
	}
	const leaders = spec.leaders ?? [];
	const decided = leaders.filter(lead => lead !== undefined);
	if (decided.length >= 3) {
		const wins = new Map<number, number>();
		for (const lead of decided) wins.set(lead, (wins.get(lead) ?? 0) + 1);
		const [index, count] = [...wins].sort((a, b) => b[1] - a[1])[0]!;
		if (count * 3 >= decided.length * 2)
			facts.push({
				key: `leader:${series[index]!.name}`,
				text: `${series[index]!.name} is best in ${count === leaders.length ? "every row" : `${count} of ${leaders.length} rows`}`,
				weight: RIVALRY_WEIGHT + count / leaders.length,
				striking: true,
			});
	}
	return facts;
}

/**
 * One series of a rival-referenced `change` ({@link ChartSpec.rival}) behind (or ahead of) that rival on
 * every category by its polarity: `tsc-rs, 4 (default) trails tsc-rs, 8 on every app (+14% to +47%)`. Not
 * striking: the rival leads most rows by construction, so only a judge titles a chart with it.
 */
function rivalGap(spec: ChartSpec, entry: ChartSeries): Fact | undefined {
	const gaps = entry.points.flatMap((point, at) =>
		point && point.value > 0
			? [{ factor: point.value, polarity: spec.categoryPolarity?.[at] ?? entry.polarity }]
			: [],
	);
	if (gaps.length < 3 || gaps.length < spec.categories.length) return undefined;
	const behind = gaps.map(gap => gap.polarity && gap.factor > 1 !== (gap.polarity === "higher"));
	const ahead = gaps.map(gap => gap.polarity && gap.factor > 1 === (gap.polarity === "higher"));
	const verb = behind.every(Boolean) ? "trails" : ahead.every(Boolean) ? "beats" : undefined;
	if (!verb || gaps.some(gap => Math.abs(Math.log(gap.factor)) < Math.log(STILL_FACTOR))) return undefined;
	const sorted = gaps.map(gap => gap.factor).sort((a, b) => a - b);
	return {
		key: `gap:${entry.name}`,
		text: `${entry.name} ${verb} ${spec.baseline} on every ${rowNoun(spec)} (${factorRange(sorted)})`,
		weight: RIVALRY_WEIGHT + Math.abs(Math.log(sorted[sorted.length >> 1]!)),
		striking: false,
	};
}

/**
 * Every category moving one way by more than {@link STILL_FACTOR} (three at
 * least): `every model fell (median 2.5× less)`, or `improved` / `regressed`
 * where each category's polarity agrees on it. Striking: a whole table
 * moving together is what a before/after is usually written to show.
 */
function consensusMove(
	spec: ChartSpec,
	factors: readonly (number | undefined)[],
	polarities: readonly (Polarity | undefined)[] | undefined,
	subject: string,
	span: string,
): Fact | undefined {
	const moved = factors.flatMap((factor, at) =>
		factor !== undefined && factor > 0 && Math.abs(Math.log(factor)) >= Math.log(STILL_FACTOR)
			? [{ at, factor }]
			: [],
	);
	// Categories without both values (`✓ | ✓`) neither move nor stand still: every measured one counts.
	const measured = factors.filter(factor => factor !== undefined && factor > 0).length;
	if (moved.length < 3 || moved.length < measured) return undefined;
	const down = moved.every(item => item.factor < 1);
	if (!down && !moved.every(item => item.factor > 1)) return undefined;
	const tones = moved.map(item => polarities?.[item.at] && item.factor > 1 === (polarities[item.at] === "higher"));
	const verb = tones.every(tone => tone === true)
		? "improved"
		: tones.every(tone => tone === false)
			? "regressed"
			: down
				? "fell"
				: "rose";
	const sorted = moved.map(item => item.factor).sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	return {
		key: "moves",
		text: `${subject[0]!.toUpperCase()}${subject.slice(1)} ${verb}${span} (${factorRange(sorted)})`,
		// The whole table moving together outranks any one move in it.
		weight: CONSENSUS_WEIGHT + Math.abs(Math.log(median)),
		striking: true,
	};
}

/**
 * Every category but one moving one way and that one the other (`3 of 4
 * models fell; claude-haiku-4.5 rose (7 → 10)`), or most moving one way and
 * none the other while the rest stay within {@link STILL_FACTOR} (`2 of 3
 * models fell, none rose; gpt-oss-120b most (29 → 5)`): the exception is
 * the finding a whole-table move would have been. Only for a transition of
 * one measure: rows that are metrics of their own (a `change`) move for
 * reasons of their own. `improved` / `regressed`
 * where every moving category's polarity says which; `fell` / `rose`
 * otherwise. `moveText` writes a category's move as the table did (`7 → 10`).
 * Striking: a lone regression among improvements is what such a table is
 * usually written to show.
 */
function splitMove(
	spec: ChartSpec,
	factors: readonly (number | undefined)[],
	polarities: readonly (Polarity | undefined)[] | undefined,
	moveText: (at: number) => string,
): Fact | undefined {
	const moved = factors.flatMap((factor, at) =>
		factor !== undefined && factor > 0 && Math.abs(Math.log(factor)) >= Math.log(STILL_FACTOR)
			? [{ at, factor }]
			: [],
	);
	const toned = moved.every(item => polarities?.[item.at]);
	// A move's side: better or worse where every polarity is known, else down or up.
	const side = (item: { at: number; factor: number }) =>
		toned ? item.factor > 1 === (polarities![item.at] === "higher") : item.factor < 1;
	const [verbs, others] = toned ? ["improved", "regressed"] : ["fell", "rose"];
	const ahead = moved.filter(side);
	const behind = moved.filter(item => !side(item));
	const [major, minor, verb, counter] =
		ahead.length >= behind.length ? [ahead, behind, verbs, others] : [behind, ahead, others, verbs];
	const total = factors.filter(factor => factor !== undefined && factor > 0).length;
	// A count over a third of the rows missing (`–`) would speak for rows it never saw.
	if (major.length < 2 || minor.length > 1 || total * 3 < spec.categories.length * 2) return undefined;
	// Without a dissenter, most categories must move for the rest standing still to say anything.
	if (minor.length === 0 && (moved.length === total || major.length * 2 <= total)) return undefined;
	const nouns = plural(rowNoun(spec));
	const name = (at: number) => spec.categories[at]!;
	const strength = (item: { factor: number }) => Math.abs(Math.log(item.factor));
	if (minor.length === 1) {
		const odd = minor[0]!;
		return {
			key: "moves",
			text: `${major.length} of ${total} ${nouns} ${verb}; ${name(odd.at)} ${counter} (${moveText(odd.at)})`,
			weight: CONSENSUS_WEIGHT - 1 + strength(odd),
			striking: true,
		};
	}
	const lead = major.reduce((best, item) => (strength(item) > strength(best) ? item : best));
	return {
		key: "moves",
		text: `${major.length} of ${total} ${nouns} ${verb}, none ${counter}; ${name(lead.at)} most (${moveText(lead.at)})`,
		weight: CONSENSUS_WEIGHT - 1 + strength(lead),
		striking: true,
	};
}

/** Spread (largest over smallest) of a whole-table move from which it reads as `up to` its largest factor. */
const WIDE_MOVES = 12;

/**
 * Factors all on one side of 1, as people say their span: `7.2–11× less`,
 * `−20% to −64%`, `1.3–4× more`, one figure where both round alike, and
 * `up to 1,127× less` where they span {@link WIDE_MOVES}× or more.
 */
function factorRange(sorted: readonly number[]): string {
	const down = sorted.at(-1)! < 1;
	// The weakest and strongest move, as factors of at least 1.
	const [weak, strong] = down ? [1 / sorted.at(-1)!, 1 / sorted[0]!] : [sorted[0]!, sorted.at(-1)!];
	const strongest = down ? sorted[0]! : sorted.at(-1)!;
	if (strong / weak >= WIDE_MOVES) return `up to ${factorWords(strongest)}`;
	const [low, high] = [factorWords(down ? sorted.at(-1)! : sorted[0]!), factorWords(strongest)];
	if (low === high) return high;
	// Drops short of 10× that start under 2× read as the share cut (`−20% to −64%`), as people say them.
	if (down && weak < 2 && strong < 10)
		return `−${Math.round((1 - sorted.at(-1)!) * 100)}% to −${Math.round((1 - sorted[0]!) * 100)}%`;
	if (strong >= 2) return `${roundFactor(weak)}–${roundFactor(strong)}× ${down ? "less" : "more"}`;
	return `${low} to ${high}`;
}

/** The plural of a row noun: `models`, `classes`, `categories`. */
function plural(noun: string): string {
	if (/(?:s|x|ch|sh)$/.test(noun)) return `${noun}es`;
	if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
	return `${noun}s`;
}

/** What a sentence calls one category: the axis name when it is one short word (`model`), else `row`. */
function rowNoun(spec: ChartSpec): string {
	// A one- or two-letter header (`N`, `id`) is a symbol, not a noun.
	if (!/^[a-z]{3,16}$/i.test(spec.axis)) return "row";
	// A plural header (`Blocks`) names one row in the singular.
	return spec.axis.toLowerCase().replace(/([^s])s$/, "$1");
}

/**
 * Each category's value of `entry` as a factor of its group's reference
 * category ({@link ChartSpec.reference}; the whole chart is one group without
 * groups): `undefined` for the reference itself, outside any referenced
 * group, or where either value is missing or not positive.
 */
export function referenceFactors(spec: ChartSpec, entry: ChartSeries): (number | undefined)[] {
	const groupOf: number[] = [];
	(spec.groups ?? [{ name: "", members: spec.categories }]).forEach((group, index) =>
		group.members.forEach(() => groupOf.push(index)),
	);
	return spec.categories.map((_, at) => {
		const index = spec.reference?.find(index => groupOf[index] === groupOf[at]);
		const [base, point] = [entry.points[index ?? -1], entry.points[at]];
		return index === undefined || index === at || !base || !point || base.value <= 0
			? undefined
			: point.value / base.value;
	});
}

/**
 * The whole chart moving one way from its groups' reference rows (`Every arm regressed vs bash on Turns and
 * Total tokens`): per series, every other category beyond {@link STILL_FACTOR} of its group's reference one way
 * ({@link consensusMove}); series that agree are named together, a lone one with its range.
 */
function referenceMoves(spec: ChartSpec): Fact[] {
	const reference = spec.reference?.[0];
	// Only a reference per group (`bash` within each model) makes its comparison the chart's point; a lone
	// reference row already prints each bar's factor of it.
	if (reference === undefined || (spec.reference?.length ?? 0) < 2) return [];
	let start = 0;
	let name = spec.categories[reference]!;
	for (const group of spec.groups ?? []) {
		if (reference < start + group.members.length) {
			name = group.members[reference - start] || name;
			break;
		}
		start += group.members.length;
	}
	const moves = spec.series.slice(0, TAKEAWAY_SERIES).flatMap(entry => {
		const fact = consensusMove(
			spec,
			referenceFactors(spec, entry),
			spec.categories.map(() => entry.polarity),
			// Rows named `Model · Arm` are arms within each model: the innermost part names them.
			`every ${rowNoun({ ...spec, axis: spec.axis.split(NAME_JOIN).at(-1)! })}`,
			` vs ${name} on ${entry.name}`,
		);
		return fact ? [{ entry, fact }] : [];
	});
	if (moves.length < 2) return moves.map(({ entry, fact }) => ({ ...fact, key: `reference:${entry.name}` }));
	// Series moving the same way (`regressed` on Turns and on Total tokens) make one sentence.
	const verb = (fact: Fact) => fact.text.split(" vs ")[0]!;
	const together = moves.filter(move => verb(move.fact) === verb(moves[0]!.fact));
	if (together.length < 2) return moves.map(({ entry, fact }) => ({ ...fact, key: `reference:${entry.name}` }));
	return [
		{
			key: "reference",
			text: `${verb(together[0]!.fact)} vs ${name} on ${list(together.map(move => move.entry.name))}`,
			weight: Math.max(...together.map(move => move.fact.weight)) + 0.1,
			striking: true,
		},
	];
}

/** `a`, `a and b`, `a, b and c`. */
function list(names: readonly string[]): string {
	return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Present points of `points`, largest first. */
function byValue(points: readonly (ChartPoint | null)[]): { at: number; point: ChartPoint }[] {
	return points.flatMap((point, at) => (point ? [{ at, point }] : [])).sort((a, b) => b.point.value - a.point.value);
}

/**
 * A series' extremes as takeaways: a group (or category) standing
 * {@link OUTLIER}× above the next, the top value (or a tie for it), and for a
 * lower-is-better series its lowest; the best value of a series with a
 * polarity weighs more.
 */
function extremes(spec: ChartSpec, entry: ChartSeries): Fact[] {
	const facts: Fact[] = [];
	const name = (at: number) => spec.categories[at]!;
	const ranked = byValue(entry.points);
	if (ranked.length < 3) return facts;
	const [top, second] = [ranked[0]!, ranked[1]!];
	const bottom = ranked.at(-1)!;
	const groups = spec.groups;
	if (groups && groups.length >= 2) {
		// Each group's mean: whole blocks outweighing the rest (one model's every harness).
		let at = 0;
		const means = groups.map(group => {
			const values = group.members.flatMap(() => {
				const point = entry.points[at++];
				return point ? [point.value] : [];
			});
			return {
				name: group.name,
				members: group.members.join("\0"),
				mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN,
			};
		});
		const sorted = means.filter(group => Number.isFinite(group.mean)).sort((a, b) => b.mean - a.mean);
		if (sorted.length >= 2 && sorted[1]!.mean > 0 && sorted[0]!.mean / sorted[1]!.mean >= OUTLIER) {
			const factor = sorted[0]!.mean / sorted[1]!.mean;
			// Blocks of the same members (each model's `baseline`, `bash`, `http`) compare like for like;
			// blocks of different members (`macOS` timed on larger trees than `Linux`) only a judge can weigh.
			const alike = sorted[0]!.members === sorted[1]!.members;
			facts.push({
				key: `outlier:${entry.name}`,
				text: `${sorted[0]!.name} has ${roundFactor(factor)}× the ${entry.name} of ${sorted[1]!.name}`,
				weight: Math.log(factor) + 1,
				// A volume one block dwarfs (tokens per model) is the story; a ranked measure's is a judge's call.
				striking: factor >= STRIKING && alike && !entry.polarity,
			});
		}
	}
	if (second.point.value > 0 && top.point.value / second.point.value >= OUTLIER) {
		const factor = top.point.value / second.point.value;
		facts.push({
			key: `outlier:${entry.name}`,
			text: `${name(top.at)} has ${roundFactor(factor)}× the ${entry.name} of the next (${top.point.text} vs ${second.point.text})`,
			weight: Math.log(factor) + 1,
			// Any column may hold one large count; a rival far ahead on a ranked measure is a finding.
			striking: entry.best === top.at && factor >= STRIKING,
		});
	}
	const tied = ranked.filter(item => item.point.value === top.point.value);
	if (tied.length >= 2 && tied.length < ranked.length) {
		const names = tied.length === 2 ? `${name(tied[0]!.at)} and ${name(tied[1]!.at)}` : `${tied.length} rows`;
		facts.push({
			key: `tie:${entry.name}`,
			text: `${names} tie for the highest ${entry.name} (${top.point.text})`,
			weight: entry.polarity === "higher" ? 0.9 : 0.3,
			striking: false,
		});
	} else if (tied.length === 1) {
		facts.push({
			key: `top:${entry.name}`,
			text: `${name(top.at)} has the highest ${entry.name} (${top.point.text})`,
			weight: entry.polarity === "higher" ? 0.9 : 0.3,
			striking: false,
		});
	}
	if (entry.polarity === "lower" && ranked.filter(item => item.point.value === bottom.point.value).length === 1)
		facts.push({
			key: `low:${entry.name}`,
			text: `${name(bottom.at)} has the lowest ${entry.name} (${bottom.point.text})`,
			weight: 0.9,
			striking: false,
		});
	return facts;
}

/**
 * A share in percent as a chart writes it: whole percents, one decimal within
 * 1 of either end (`0.4%`, `99.6%`) so a sliver never rounds to nothing or
 * everything, and `<0.1%` / `>99.9%` past that. Exported for the renderer.
 */
export function percentText(percent: number): string {
	if (percent <= 0 || percent >= 100) return `${Math.max(0, Math.min(100, percent))}%`;
	if (percent < 0.05) return "<0.1%";
	if (percent >= 99.95) return ">99.9%";
	return percent < 1 || percent > 99 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** A factor as people say it: `48× less`, `2.1× more`, or a percent within 2× (`−12%`, `+27%`). */
function factorWords(factor: number): string {
	if (factor === 0) return "−100%";
	if (factor >= 2) return `${roundFactor(factor)}× more`;
	if (factor <= 0.5) return `${roundFactor(1 / factor)}× less`;
	const percent = Math.round((factor - 1) * 100);
	return percent === 0 ? "same" : `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

/** `48`, `2.1`: whole from 10, one decimal below. */
function roundFactor(factor: number): string {
	return factor >= 10 ? Math.round(factor).toLocaleString("en-US") : Number(factor.toFixed(1)).toString();
}

/**
 * Whether a chart of `spec` reads faster than its table: at least four
 * categories (or small-multiple panels), and either nine plotted values or a
 * 3× spread within a series. On a model-judged sample of assistant tables this
 * gate kept 85% of the tables a chart clearly helped while rejecting most two-
 * and three-row ones. A `change` needs three metrics and one moving by
 * {@link NOTABLE_FACTOR} either way: its factors are what the table lacks.
 * Series holding one value in all their categories but one (`5/5` in eight
 * of nine rows) say nothing bars add to.
 */
export function worthCharting(spec: ChartSpec): boolean {
	const { kind, categories, series } = spec;
	if (kind === "stat") return statStory(series) !== undefined;
	// Factors share no unit with the table's figures: three metrics are enough once one moves noticeably.
	if (kind === "change")
		return (
			categories.length >= 3 &&
			series.some(entry =>
				entry.points.some(point => point && Math.abs(Math.log(point.value)) >= Math.log(NOTABLE_FACTOR)),
			)
		);
	// Counts splitting a total gain the shares the table never wrote: three parts are worth a bar.
	if (kind === "share" && series[0]!.dim !== "percent") return categories.length >= 3;
	// Rows held to targets: three say at a glance which meet theirs and by how much.
	if (kind === "bullet")
		return (spec.targets ?? []).filter((target, at) => target && series[0]!.points[at]).length >= 3;
	// Intervals are hard to compare in a table: four categories suffice, three once a pair (or a band) doubles them.
	if (kind === "range") return categories.length >= 4 || (categories.length === 3 && series.length >= 2);
	// A ladder draws several quantiles a row: three rows compare their spreads, two do once four quantiles show a tail.
	if (kind === "ladder") return categories.length >= 3 || (categories.length === 2 && series.length >= 4);
	// Moves across stages and nets of opposing amounts are what the table leaves to the reader: three rows suffice.
	if (kind === "slope" || kind === "butterfly") return categories.length >= 3;
	// A before/after dumbbell shows moves: rows missing either end move nowhere, and three must move at least.
	const moved = categories.filter((_, at) => series.every(entry => entry.points[at])).length;
	if (kind === "paired" && spec.transition && moved < 3) return false;
	// Across decades it is the log-axis form of a `change`: three rows, once one moves noticeably.
	if (kind === "paired" && spec.transition && categories.length === 3) {
		const values = series.flatMap(entry =>
			entry.points.flatMap(point => (point && point.value > 0 ? [point.value] : [])),
		);
		const moves = categories.some((_, at) => {
			const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
			return (
				a && b && a.value > 0 && b.value > 0 && Math.abs(Math.log(b.value / a.value)) >= Math.log(NOTABLE_FACTOR)
			);
		});
		if (moves && Math.max(...values) >= DECADES * Math.min(...values)) return true;
	}
	// Gains beside losses: the split itself is worth seeing from four moves, else sizes spread 3× (by magnitude);
	// a few whole counts (`+1`, `−2`) read as well in the table.
	if (kind === "diverging") {
		const values = series[0]!.points.flatMap(point => (point && point.value !== 0 ? [point.value] : []));
		const sizes = values.map(Math.abs);
		const split = values.some(value => value > 0) && values.some(value => value < 0);
		const tallies = sizes.every(size => Number.isInteger(size) && size <= MAX_PROSE_COUNT);
		return (
			values.length >= 4 && !tallies && (split || values.length >= 9 || Math.max(...sizes) >= 3 * Math.min(...sizes))
		);
	}
	// Small multiples compare within each panel, so four metrics count like four categories;
	// a waterfall's total is a bar of its own.
	const bars =
		kind === "multiples"
			? Math.max(categories.length, series.length)
			: kind === "waterfall"
				? categories.length + 1
				: categories.length;
	if (bars < 4) return false;
	// One value in every category but one (`5/5` in eight of nine rows): a sentence says it, bars only repeat it.
	// A share is the exception: one part holding nearly all of the whole is its point.
	const uniform =
		kind !== "share" &&
		series.every(entry => {
			const values = entry.points.flatMap(point => (point ? [point.value] : []));
			const tally = new Map<number, number>();
			for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
			return values.length >= 4 && Math.max(0, ...tally.values()) >= values.length - 1;
		});
	if (uniform) return false;
	let points = 0;
	let spread = 1;
	for (const entry of series) {
		const positive: number[] = [];
		for (const point of entry.points) {
			if (!point) continue;
			points++;
			if (point.value > 0) positive.push(point.value);
		}
		if (positive.length >= 2) spread = Math.max(spread, Math.max(...positive) / Math.min(...positive));
	}
	return points >= 9 || spread >= 3;
}

/**
 * The nearest kind `kind` draws as for `series`: a shared axis needs one unit
 * (else small multiples), bars take one series, a dumbbell two, grouped bars
 * up to four (more become a heatmap), and a scatter needs its x measure.
 */
function fitKind(kind: ChartKind, series: readonly ChartSeries[], hasX: boolean): ChartKind {
	// Panels and stat tiles scale each series on its own: any mix of units.
	if (kind === "multiples" || kind === "stat") return kind;
	if (kind === "scatter" && hasX) return kind;
	// Intervals band by unit, each band on its own axis ({@link buildChart} checks they are mostly intervals).
	if (kind === "range") return kind;
	// A share draws one series ({@link buildChart} keeps the first): a `%` column beside its counts restates them.
	// Past {@link MAX_SHARE_SEGMENTS} parts its slivers stop reading; bars rank them instead.
	if (kind === "share") return (series[0]?.points.length ?? 0) <= MAX_SHARE_SEGMENTS ? kind : "bar";
	if (new Set(series.map(entry => `${entry.dim}:${entry.unit}`)).size > 1) return "multiples";
	// A ladder without quantiles to read ({@link buildChart} draws real ones before fitting) compares as dots.
	if (kind === "ladder") return fitKind("dots", series, hasX);
	// Distributions stand side by side in each bin while a bin's columns stay apart.
	if (kind === "histogram") return series.length <= MAX_DISTRIBUTIONS ? kind : "heatmap";
	// Dots share one axis: two to six series, one dot color each.
	if (kind === "dots") return series.length === 1 ? "bar" : series.length <= SERIES_COLORS ? kind : "heatmap";
	// A slope runs one quantity through two to four stages; a butterfly sets two opposing amounts back to back.
	if (kind === "slope" && series.length >= 2 && series.length <= MAX_STAGES) return kind;
	if (kind === "butterfly" && series.length === 2) return kind;
	if (kind === "diverging" || kind === "line" || kind === "heatmap") return kind;
	// A run of steps: one series, every step present; a timeline's segments are lengths, never negative.
	if (
		(kind === "timeline" || kind === "waterfall") &&
		series.length === 1 &&
		series[0]!.points.every(point => point && (kind === "waterfall" || point.value >= 0))
	)
		return kind;
	// Parts of a whole stack while a bar stays legible: up to six segments, none negative.
	if (
		kind === "stacked" &&
		series.length >= 2 &&
		series.length <= SERIES_COLORS &&
		series.every(entry => entry.points.every(point => !point || point.value >= 0))
	)
		return kind;
	if (
		kind === "progress" &&
		series.length <= MAX_TRACKS &&
		series.every(
			entry =>
				entry.dim === "percent" && entry.points.every(point => !point || (point.value >= 0 && point.value <= 100)),
		)
	)
		return kind;
	// Two series pair up as a dumbbell only when asked to: unrelated quantities stand side by side.
	const count = series.length;
	return count === 1
		? "bar"
		: count === 2 && kind === "paired"
			? "paired"
			: count <= MAX_GROUPED
				? "grouped"
				: "heatmap";
}

/** Most metrics a `stat` comparison sets side by side, one tile each. */
const MAX_STATS = 4;
/**
 * Row names marking the before side of a comparison. Narrower than {@link BEFORE}: row names are prose
 * (`full writes to *.sh`), where `to`, `from` or `with` say nothing about a condition.
 */
const ROW_BEFORE =
	/\b(?:before|old|baseline|original|previous|prev|stock|unpatched|default|main|master|current|cold)\b/i;
/** Row names marking the after side of a comparison, narrower than {@link AFTER} for the same reason. */
const ROW_AFTER = /\b(?:after|new|patched|fixed|optimi[sz]ed|proposed|pr|branch|head|ours|warm)\b/i;
/** Row names that are code identifiers (`` `PI_CHUNK_LINES` ``, `MAX_OP_RETURN_LEN`): settings, not metrics. */
const IDENTIFIER = /^`|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** Row names of the two settings of one switch (`on` / `off`, `with` / `without`). */
const SWITCH = /^(?:on|off|enabled|disabled|with|without|yes|no)\b/i;
/** A switch setting a comparison reads the other against: the feature off. */
const SWITCHED_OFF = /^(?:off|disabled|without|no)\b/i;

/**
 * A `stat` plan for a small table comparing two conditions on one to
 * {@link MAX_STATS} metrics, where some metric moves {@link STRIKING_MOVE}×
 * or more between them ({@link statStory}): two rows named as conditions
 * (`Collect (old)` / `Stream (new)` per {@link ROW_BEFORE} and
 * {@link ROW_AFTER}, `on` / `off`, or rival options under a header like
 * `run` or `model`), each metric a column; or two to three metric rows
 * (not code identifiers: those are settings) under a before/after column
 * pair (`Before | After`; not buckets of one population under a header
 * like `Severity`), transposed so the columns are the conditions.
 * Every compared value is a positive plain number of its column's (or row's)
 * dimension, and the rows' names are text, not numbers.
 */
function statShape(table: TableAnalysis, guess: ChartPlan | undefined): ChartPlan | undefined {
	const label = table.columns[guess?.label ?? table.label?.index ?? -1];
	const { rows } = table;
	// A label of numbers names rows only where it leads the table (`1 MiB (Windows default)`), not as a
	// column of figures (`9.0s`, `up to 32.9s`) picked to name them.
	if (label?.role !== "label" || (label.index > 0 && rows.some(row => isNumber(label.cells[row])))) return undefined;
	const plain = (cell: Cell | undefined, dim: Dimension | undefined): cell is NumberCell =>
		isNumber(cell) && cell.dim === dim && cell.value > 0 && cell.upper === undefined && cell.to === undefined;
	const measures = table.measures.filter(column => column !== label && !DELTA.test(column.header));
	if (rows.length === 2) {
		const [first = "", second = ""] = rows.map(row => label.cells[row]!.text.trim());
		const conditions =
			conditionPair(first, second) ||
			conditionPair(second, first) ||
			(SWITCH.test(first) && SWITCH.test(second)) ||
			RIVALS.test(label.header);
		const metrics = measures.filter(column => rows.every(row => plain(column.cells[row], column.dim)));
		if (!conditions || metrics.length === 0 || metrics.length > MAX_STATS || metrics.length < measures.length)
			return undefined;
		const plan: ChartPlan = {
			kind: "stat",
			label: label.index,
			qualifiers: [],
			series: metrics.map(column => column.index),
			transpose: false,
		};
		const spec = buildChart(table, plan);
		return spec && statStory(spec.series) ? plan : undefined;
	}
	if (rows.length < 2 || rows.length > 3 || measures.length !== 2) return undefined;
	const [before, after] = measures;
	if (!before || !after || !isTransition(before.header, after.header)) return undefined;
	// Settings change rather than measure; buckets of one population (`Severity | Open | Fixed`) split it.
	if (BUCKET_HEADER.test(label.header) || rows.some(row => IDENTIFIER.test(label.cells[row]!.text.trim())))
		return undefined;
	const dims = rows.map(row => {
		const cell = before.cells[row];
		return isNumber(cell) ? cell.dim : undefined;
	});
	if (!rows.every((row, at) => dims[at] && plain(before.cells[row], dims[at]) && plain(after.cells[row], dims[at])))
		return undefined;
	const plan: ChartPlan = {
		kind: "stat",
		label: label.index,
		qualifiers: [],
		series: [before.index, after.index],
		transpose: true,
	};
	const spec = buildChart(table, plan);
	return spec && statStory(spec.series) ? plan : undefined;
}

/** Whether two row names read as the before (`Collect (old)`) and after (`Stream (new)`) of one comparison. */
function conditionPair(before: string, after: string): boolean {
	return (ROW_BEFORE.test(before) && !ROW_BEFORE.test(after)) || (ROW_AFTER.test(after) && !ROW_AFTER.test(before));
}

/**
 * Which of a comparison's two conditions the other reads against: the before
 * one ({@link conditionPair}, or {@link isTransition} between headers like
 * `Was | Now`), a switch's `off`, else the first.
 */
function statBaseline(names: readonly string[]): number {
	const [first = "", second = ""] = names;
	const before =
		(conditionPair(second, first) && !conditionPair(first, second)) ||
		(isTransition(second, first) && !isTransition(first, second)) ||
		(SWITCHED_OFF.test(second) && !SWITCHED_OFF.test(first));
	return before ? 1 : 0;
}

/**
 * The strongest move of a `stat` comparison's metrics — each series' second
 * value over its first, both positive — when one reaches {@link STRIKING_MOVE}×
 * either way among one to {@link MAX_STATS} metrics; else `undefined`, and the
 * table says it as well as tiles would.
 */
function statStory(series: readonly ChartSeries[]): number | undefined {
	if (series.length === 0 || series.length > MAX_STATS) return undefined;
	const factors = series.flatMap(entry => {
		const [a, b] = entry.points;
		return entry.points.length === 2 && a && b && a.value > 0 && b.value > 0 ? [b.value / a.value] : [];
	});
	if (factors.length < series.length) return undefined;
	const strongest = factors.reduce((best, factor) =>
		Math.abs(Math.log(factor)) > Math.abs(Math.log(best)) ? factor : best,
	);
	return Math.abs(Math.log(strongest)) >= Math.log(STRIKING_MOVE) ? strongest : undefined;
}

/**
 * Each metric of a `stat` comparison as a takeaway: the compared condition's
 * value against the baseline's (`Peak RSS: ~4.5 GiB → ~105 MiB (43× less)`
 * for a transition, `wall: on 34.7 s vs off 17.1 s (2× more)` between peers),
 * striking from {@link STRIKING_MOVE}×; and over two or more metrics, every
 * move in one line, strongest first (`advisor: Cost 3× more, Precision −46%,
 * Recall unchanged`), above any one of them.
 */
function statFacts(spec: ChartSpec): Fact[] {
	const base = spec.reference?.[0] ?? 0;
	const other = 1 - base;
	const [from, to] = [spec.categories[base]!, spec.categories[other]!];
	const transition = isTransition(from, to);
	const moves = spec.series.flatMap(entry => {
		const [a, b] = [entry.points[base], entry.points[other]];
		return a && b && a.value > 0 ? [{ name: entry.name, factor: b.value / a.value }] : [];
	});
	const strength = (factor: number) => Math.abs(Math.log(factor));
	const strongest = Math.max(0, ...moves.map(move => strength(move.factor)));
	const summary: Fact[] =
		moves.length >= 2 && moves.length === spec.series.length
			? [
					{
						key: "stat:all",
						text: `${to}: ${moves
							.sort((a, b) => strength(b.factor) - strength(a.factor))
							.map(move => `${move.name} ${factorWords(move.factor).replace(/^same$/, "unchanged")}`)
							.join(", ")}`,
						weight: strongest + 1,
						striking: strongest >= Math.log(STRIKING_MOVE),
					},
				]
			: [];
	const singles = spec.series.flatMap(entry => {
		const [a, b] = [entry.points[base], entry.points[other]];
		if (!a || !b || a.value <= 0) return [];
		const factor = b.value / a.value;
		const move = factorWords(factor);
		if (move === "same") return [];
		return [
			{
				key: `stat:${entry.name}`,
				text: transition
					? `${entry.name}: ${a.text} → ${b.text} (${move})`
					: `${entry.name}: ${to} ${b.text} vs ${from} ${a.text} (${move})`,
				weight: strength(factor),
				striking: strength(factor) >= Math.log(STRIKING_MOVE),
			},
		];
	});
	return [...summary, ...singles];
}

/**
 * Baseline and compared columns of a before/after table a shared axis cannot
 * hold: rows in different units, or prose cells (`none seen`) keeping its
 * columns from reading as measures. The baseline is the `before` column; the
 * compared ones are the `after` column and any measure beside it pairing with
 * the baseline in two or more rows. Deltas and columns holding their own
 * `a → b` transitions take no part.
 */
function changeColumns(table: TableAnalysis): TableColumn[] | undefined {
	const { label } = table;
	if (label?.role !== "label") return undefined;
	const values = table.columns.filter(
		column =>
			column !== label &&
			(column.role === "measure" || column.role === "label") &&
			!DELTA.test(column.header) &&
			!ARROW.test(column.header) &&
			column.arrowShare < 0.6,
	);
	const baseline = values.find(column => BEFORE.test(column.header));
	if (!baseline) return undefined;
	const rows = [...table.rows, ...table.totals];
	const compared = values.filter(
		column =>
			column !== baseline &&
			(column.role === "measure" || AFTER.test(column.header)) &&
			rows.filter(row => changePoint(baseline.cells[row], column.cells[row])).length >= 2,
	);
	if (!compared.some(column => AFTER.test(column.header))) return undefined;
	const columns = [baseline, ...compared];
	// One unit throughout: a shared axis holds the values themselves (`paired`, `grouped`).
	if (columns.every(column => column.role === "measure" && !column.mixed)) return undefined;
	return columns;
}

/**
 * A `change` over `columns`: per row, each compared column as a factor of the
 * baseline's value (or of its own column in `baselines`), or the `a → b` cells
 * of each column as factors of their start. Total rows stay (a factor never
 * skews the scale); rows with no pair are named in the caption instead.
 */
function changeChart(
	table: TableAnalysis,
	plan: ChartPlan,
	namers: readonly TableColumn[],
	group: TableColumn | undefined,
	columns: readonly TableColumn[],
	baselines?: readonly TableColumn[],
): ChartSpec | undefined {
	const [baseline, ...picked] = columns;
	if (!baseline) return undefined;
	// A delta is no value to take a factor of: `+21.7pp` over `44.3%` would read as a regression. Changes in
	// the plural name a condition (`six changes`, `with changes`), not a delta.
	const values = picked.filter(column => !DELTA.test(column.header.replace(/changes\b/gi, "")));
	const compared = values.length ? values : picked;
	const [from, to] = arrowNames(baseline.header);
	// Each series improves the way its measure does: the compared column's polarity, else its baseline's.
	const improves = (column: TableColumn, before = baseline) =>
		plan.polarity?.[column.index] ?? plan.polarity?.[before.index];
	let pairs: { name: string; polarity?: Polarity; at: (row: number) => ChartPoint | undefined }[];
	let against: string;
	if (baselines) {
		// Metric pairs: each series against its own before column, the legend naming the before condition.
		pairs = columns.map((column, at) => ({
			name: column.header,
			polarity: improves(column, baselines[at]),
			at: row => changePoint(baselines[at]!.cells[row], column.cells[row]),
		}));
		against = BEFORE.exec(baselines[0]!.header)?.[0] ?? baselines[0]!.header;
	} else if (compared.length > 0 && columns.every(column => column.arrowShare >= 0.6)) {
		// `a → b` columns each move from their own start: one series per column, named by what it measures.
		pairs = columns.map(column => ({
			name: arrowSubject(column.header),
			polarity: improves(column),
			at: row => arrowChange(column.cells[row]),
		}));
		against = BEFORE.exec(from)?.[0] ?? "before";
	} else if (compared.length > 0) {
		pairs = compared.map(column => ({
			name: column.header,
			polarity: improves(column),
			at: row => changePoint(baseline.cells[row], column.cells[row]),
		}));
		against = baseline.header;
	} else {
		pairs = [{ name: to, polarity: improves(baseline), at: row => arrowChange(baseline.cells[row]) }];
		against = from;
	}
	const rows = regroup(
		[...table.rows, ...table.totals].sort((a, b) => a - b),
		group,
	);
	const kept = rows.filter(row => pairs.some(pair => pair.at(row)));
	if (kept.length < 2) return undefined;
	const all = nameRows(namers, undefined, rows).names;
	const skipped = rows.flatMap((row, at) => (kept.includes(row) ? [] : [all[at]!]));
	const naming = nameRows(namers, group, kept, true);
	const spec: ChartSpec = {
		kind: "change",
		categories: naming.names,
		groups: naming.groups,
		series: pairs.map(pair => ({
			name: pair.name,
			dim: "ratio",
			unit: "",
			points: kept.map(row => pair.at(row) ?? null),
			notes: kept.map(() => undefined),
			polarity: pair.polarity,
		})),
		// Commas: a nested row name already holds `·`.
		caption: skipped.length ? `Not plotted: ${skipped.join(", ")}` : undefined,
		axis: naming.axis,
		baseline: against,
		categoryPolarity: kept.map(row => plan.rowPolarity?.[row]),
	};
	return withMeaning(table, plan, spec, kept);
}

/** What an `a → b` header's column measures, its condition words dropped (`mean before → after` → `mean`). */
function arrowSubject(header: string): string {
	const [from] = header.split(ARROW);
	const subject = from?.replace(new RegExp(BEFORE.source, "gi"), "").replace(/\s+/g, " ").trim();
	return subject || header;
}

/** `to` as a factor of `from` (`59.4 s → 1.23 s` is 0.0207), when both are numbers of one dimension. */
function changePoint(from: Cell | undefined, to: Cell | undefined): ChartPoint | undefined {
	if (!isNumber(from) || !isNumber(to) || from.dim !== to.dim || from.value <= 0 || to.value < 0) return undefined;
	return {
		value: to.value / from.value,
		text: `${from.figure} → ${to.figure}`,
		emphasis: from.emphasis || to.emphasis,
	};
}

/** An `a → b` cell as the factor `b ÷ a`. */
function arrowChange(cell: Cell | undefined): ChartPoint | undefined {
	if (!isNumber(cell) || cell.to === undefined || cell.value <= 0 || cell.to < 0) return undefined;
	return { value: cell.to / cell.value, text: `${cell.figure} → ${cell.toFigure ?? ""}`, emphasis: cell.emphasis };
}

/** The from and to names in an `a → b` header (`out tokens r5 → r6`), else `before` and `after`. */
function arrowNames(header: string): [string, string] {
	const [from, to] = header.split(ARROW);
	return from && to ? [from, to] : ["before", "after"];
}

/** What a chart calls each of its rows. */
interface RowNames {
	readonly names: readonly string[];
	/** Headers of the columns the names come from. */
	readonly axis: string;
	readonly groups?: readonly ChartGroup[];
}

/**
 * Names of `rows` from the `namers` cells, in table order (`Sonnet 5.5 ·
 * bash`), `#n` where they are all empty. Runs of one `group` value become
 * {@link ChartGroup}s holding the rest of each name; the caller {@link regroup}s
 * the rows first. Without a group, `nest` lets names sharing a leading part
 * nest under it ({@link nestNames}). Names are tidied for display ({@link tidyNames}):
 * group names across groups, members within their group.
 */
function nameRows(
	namers: readonly TableColumn[],
	group: TableColumn | undefined,
	rows: readonly number[],
	nest = false,
): RowNames {
	const join = (columns: readonly TableColumn[], row: number) =>
		columns
			.map(column => nameCell(column, row))
			.filter(Boolean)
			.join(NAME_JOIN);
	const full = rows.map((row, at) => join(namers, row) || `#${at + 1}`);
	const axis = namers
		.map(column => column.header)
		.filter(Boolean)
		.join(NAME_JOIN);
	const rest = namers.filter(column => column !== group);
	if (!group || rest.length === 0) {
		const nested = nest ? nestNames(full) : undefined;
		return nested ? { names: full, axis, groups: nested } : { names: tidyNames(full), axis };
	}
	const groups: { name: string; members: string[] }[] = [];
	for (const row of rows) {
		const name = nameCell(group, row);
		const last = groups.at(-1);
		if (last?.name === name) last.members.push(join(rest, row));
		else groups.push({ name, members: [join(rest, row)] });
	}
	// Runs of one row already name every row once.
	if (groups.length === rows.length) return { names: tidyNames(full), axis };
	const heads = tidyNames(groups.map(entry => entry.name));
	return {
		names: full,
		axis,
		groups: groups.map((entry, at) => ({ name: heads[at]!, members: tidyNames(entry.members) })),
	};
}

/**
 * Row names nested under a leading part they share, when that reads as an
 * outline: `glm new`, `glm prior`, `claude new` → `glm` › `new`, `prior`;
 * `sofa-base`, `sofa-arm` → `sofa` › `base`, `arm`. Splits every name at the
 * first {@link NEST_SEPARATORS} entry that nests the most rows, each leading
 * part in one consecutive run of two or more. Rows outside every run stay
 * whole, in nameless groups. Needs {@link NEST_SHARE} of the rows nested, and
 * more than one group (a part every row shares is a prefix for {@link tidyNames}).
 */
function nestNames(names: readonly string[]): ChartGroup[] | undefined {
	if (names.length < 3) return undefined;
	let best: { groups: ChartGroup[]; nested: number } | undefined;
	for (const separator of NEST_SEPARATORS) {
		const runs: { head: string | undefined; members: string[]; names: string[] }[] = [];
		const seen = new Set<string>();
		let valid = true;
		for (const name of names) {
			const at = name.indexOf(separator);
			const head = at >= MIN_NEST_HEAD ? name.slice(0, at) : undefined;
			const member = head === undefined ? "" : name.slice(at + separator.length).trim();
			const last = runs.at(-1);
			if (head !== undefined && member && last?.head === head) {
				last.members.push(member);
				last.names.push(name);
				continue;
			}
			if (head !== undefined && member) {
				if (seen.has(head)) {
					valid = false;
					break;
				}
				seen.add(head);
			}
			runs.push({ head: member ? head : undefined, members: [member], names: [name] });
		}
		if (!valid) continue;
		const groups: { name: string; members: string[] }[] = [];
		let nested = 0;
		let named = 0;
		for (const run of runs) {
			if (run.head !== undefined && run.members.length >= 2) {
				groups.push({ name: run.head, members: tidyNames(run.members) });
				nested += run.members.length;
				named++;
				continue;
			}
			const last = groups.at(-1);
			if (last?.name === "") last.members.push(...run.names);
			else groups.push({ name: "", members: [...run.names] });
		}
		if (named === 0 || nested < names.length * NEST_SHARE || (named === 1 && nested === names.length)) continue;
		if (!best || nested > best.nested) best = { groups, nested };
	}
	return best?.groups;
}

/**
 * Shorter names that still tell `names` apart, for labels: a path-like name
 * (`~/.omp/agent/history.db`, `openai/gpt-5.5:xhi`) by its last segment; among
 * such single-token names, a prefix or suffix all share at a separator
 * (`/vs/…`, `…:xhi`) dropped, unless only numbers or dates would remain; and
 * when most names past {@link MAX_LABEL} overflow with a description, every
 * name cut before its own (`Payroll (10 people…)`, `@watzon — #19, #53`). Each step applies only
 * when the names stay distinct; names that clash already stay as written.
 */
function tidyNames(names: readonly string[]): string[] {
	const usable = (list: readonly string[]) =>
		list.every(name => name.length >= 2) &&
		new Set(list).size === list.length &&
		!list.every(name => /^[\d\s.,:/+\-–]+$/.test(name));
	let tidy = [...names];
	if (tidy.length < 2 || !usable(tidy)) return tidy;
	if (tidy.every(name => /[^/\s]\/[^/\s]/.test(name) && !/\s/.test(name))) {
		const tails = tidy.map(name => name.replace(/\/+$/, "").split("/").at(-1)!);
		if (usable(tails)) tidy = tails;
	}
	if (tidy.length >= 3 && tidy.every(name => !/\s/.test(name))) {
		const prefix = sharedEdge(tidy, "start");
		const trimmed = tidy.map(name => name.slice(prefix.length).replace(/^[\s,;:·/_-]+/, ""));
		if (prefix.length >= 3 && usable(trimmed)) tidy = trimmed;
		const suffix = sharedEdge(tidy, "end");
		const cut = tidy.map(name => name.slice(0, name.length - suffix.length).replace(/[\s,;:·/_-]+$/, ""));
		if (suffix.length >= 3 && usable(cut)) tidy = cut;
	}
	// Descriptions go when they are what makes names overflow: most long names carry one.
	const long = tidy.filter(name => name.length > MAX_LABEL);
	if (long.filter(name => name.search(DESCRIPTION) >= 2).length * 2 <= long.length) return tidy;
	const short = tidy.map(name => {
		const at = name.search(DESCRIPTION);
		return at >= 2 ? name.slice(0, at).replace(/[\s,;:·—–-]+$/, "") : name;
	});
	return usable(short) ? short : tidy;
}

/** The longest start (or end) every name shares, ending (or starting) at a separator: `/vs/`, `:xhi`, `_PRODUCTION`. */
function sharedEdge(names: readonly string[], edge: "start" | "end"): string {
	const read = (name: string) => (edge === "start" ? name : [...name].reverse().join(""));
	const first = read(names[0]!);
	let length = first.length;
	for (const name of names) {
		const other = read(name);
		let at = 0;
		while (at < length && at < other.length && other[at] === first[at]) at++;
		length = at;
	}
	// Back off to a boundary: the shared part ends in a separator, so no word is cut.
	while (length > 0 && !/[/:_-]/.test(first[length - 1]!)) length--;
	const shared = first.slice(0, length);
	return edge === "start" ? shared : [...shared].reverse().join("");
}

/** `rows` in time order when `label` holds dates: a line runs left to right whatever order the table lists them. */
function chronological(rows: readonly number[], label: TableColumn | undefined): readonly number[] {
	if (label?.role !== "temporal") return rows;
	const times = new Map(rows.map(row => [row, Date.parse(label.cells[row]!.text)]));
	for (const time of times.values()) if (!Number.isFinite(time)) return rows;
	return rows.toSorted((a, b) => times.get(a)! - times.get(b)!);
}

/** `rows` with each `group` value gathered into one run, runs in order of first appearance, rows within a run in table order. */
function regroup(rows: readonly number[], group: TableColumn | undefined): readonly number[] {
	if (!group) return rows;
	const runs = new Map<string, number>();
	for (const row of rows) {
		const name = nameCell(group, row);
		if (!runs.has(name)) runs.set(name, runs.size);
	}
	return rows.toSorted((a, b) => runs.get(nameCell(group, a))! - runs.get(nameCell(group, b))!);
}

/**
 * Columns that may join `label` in naming rows: short text or date columns
 * whose cells vary (a column of one value tells no rows apart).
 */
export function namingColumns(table: TableAnalysis, label: TableColumn | undefined): TableColumn[] {
	const { rows } = table;
	return table.columns.filter(
		column =>
			column !== label &&
			(column.role === "label" || column.role === "temporal") &&
			rows.every(row => nameCell(column, row).length <= MAX_NAME_PART) &&
			new Set(rows.map(row => nameCell(column, row))).size > 1,
	);
}

/**
 * The local guess at the columns naming rows beside `label`: the fewest of
 * `spare` (by default {@link namingColumns}) that tell repeated labels apart
 * (`Model | Harness`), the one with the fewest distinct values first (a factor
 * like `Harness`, not a notes column); and as the group, the first naming
 * column already running in blocks, so table order stays as written.
 */
export function guessNaming(
	table: TableAnalysis,
	label: TableColumn | undefined,
	spare: readonly TableColumn[] = namingColumns(table, label),
): { qualifiers: readonly number[]; group: number | undefined } {
	const { rows } = table;
	if (!label) return { qualifiers: [], group: undefined };
	const clashes = (columns: readonly TableColumn[]) =>
		rows.length - new Set(rows.map(row => columns.map(column => nameCell(column, row)).join("\0"))).size;
	const namers = [label];
	let clash = clashes(namers);
	while (clash > 0) {
		// Stable sort: equal candidates keep table order.
		const next = spare
			.filter(column => !namers.includes(column))
			.map(column => ({
				column,
				clash: clashes([...namers, column]),
				distinct: new Set(rows.map(row => nameCell(column, row))).size,
			}))
			.filter(candidate => candidate.clash < clash)
			.sort((a, b) => a.clash - b.clash || a.distinct - b.distinct)[0];
		if (!next) break;
		namers.push(next.column);
		clash = next.clash;
	}
	const qualifiers = namers.slice(1).map(column => column.index);
	if (qualifiers.length === 0) return { qualifiers, group: undefined };
	namers.sort((a, b) => a.index - b.index);
	const group = namers.find(column => inRuns(rows.map(row => nameCell(column, row))));
	return { qualifiers, group: group?.index };
}

/**
 * The local guess at the reference rows: a naming cell that says so
 * ({@link REFERENCE_ROW}: `baseline`, `#1 (baseline)`, `current-api`), the
 * qualifiers searched before the label (`Harness` = `baseline` within each
 * model). Its value must mark one row, or one in each value of the label
 * when it marks a qualifier; the strongest word wins (`baseline` over `current`).
 */
function guessReference(
	table: TableAnalysis,
	label: TableColumn | undefined,
	qualifiers: readonly number[],
): RowReference | undefined {
	if (!label) return undefined;
	const columns = [...qualifiers.toReversed().map(index => table.columns[index]!), label];
	for (const column of columns) {
		let best: { value: string; rank: number } | undefined;
		let tied = false;
		for (const value of new Set(table.rows.map(row => nameCell(column, row)))) {
			const word = REFERENCE_ROW.exec(value)?.groups;
			const name = (word?.lead ?? word?.marked)?.toLowerCase();
			if (!name) continue;
			const rank = REFERENCE_WORDS.indexOf(name);
			if (best && rank === best.rank) tied = true;
			if (!best || rank < best.rank) {
				best = { value, rank };
				tied = false;
			}
		}
		if (!best || tied) continue;
		const { value } = best;
		const marked = table.rows.filter(row => nameCell(column, row) === value);
		const owners = new Set(marked.map(row => nameCell(label, row)));
		if (column === label ? marked.length === 1 : owners.size === marked.length && owners.size >= 2)
			return { column: column.index, value };
	}
	return undefined;
}

/**
 * How a heatmap of `columns` over `rows` should shade: each column on its own
 * when two columns typically differ {@link QUANTITY_SPREAD}× within a row
 * (different quantities, like input vs. reasoning tokens), each row on its
 * own when two rows typically do within a column (one measure on a small and
 * a huge item) and a row's cells typically differ {@link ROW_CONTRAST}×,
 * else one scale for every cell. The local default of the
 * judge's shading answer.
 */
export function guessShading(columns: readonly TableColumn[], rows: readonly number[]): Shading {
	const grid = rows.map(row =>
		columns.map(column => {
			const cell = column.cells[row];
			return isNumber(cell) && cell.value > 0 ? cell.value : Number.NaN;
		}),
	);
	if (pairSpread(grid) >= QUANTITY_SPREAD) return "series";
	const transposed = columns.map((_, at) => grid.map(values => values[at]!));
	if (pairSpread(transposed) < QUANTITY_SPREAD) return "shared";
	// Shades from zero tell a row's cells apart only when they differ by a good share (`458 | 163`, not `3.56s | 4.14s`).
	const contrasts = grid
		.map(values => values.filter(Number.isFinite))
		.filter(values => values.length >= 2)
		.map(values => Math.max(...values) / Math.min(...values))
		.sort((a, b) => a - b);
	return (contrasts[contrasts.length >> 1] ?? 1) >= ROW_CONTRAST ? "row" : "shared";
}

/**
 * The widest typical ratio between two columns of `grid` (rows of positive
 * values, `NaN` where absent): per pair, the median of their ratios over the
 * rows holding both.
 */
function pairSpread(grid: readonly (readonly number[])[]): number {
	const width = grid[0]?.length ?? 0;
	let widest = 1;
	for (let a = 0; a < width; a++) {
		for (let b = a + 1; b < width; b++) {
			const ratios = grid
				.map(values => values[a]! / values[b]!)
				.filter(Number.isFinite)
				.sort((x, y) => x - y);
			if (ratios.length < 2) continue;
			const middle = ratios[Math.floor(ratios.length / 2)]!;
			widest = Math.max(widest, middle, 1 / middle);
		}
	}
	return widest;
}

/** A naming cell's text; a blank or a dash names nothing, a word read as missing (`na`, `none`) still names its row. */
function nameCell(column: TableColumn, row: number): string {
	const cell = column.cells[row]!;
	return cell.kind === "missing" && !/[\p{L}\p{N}]/u.test(cell.text) ? "" : cell.text;
}

/** Each distinct value in one consecutive run, one run at least two long: a name a chart can write once per run. */
function inRuns(values: readonly string[]): boolean {
	const seen = new Set<string>();
	let repeats = false;
	for (let at = 0; at < values.length; at++) {
		const value = values[at]!;
		if (at > 0 && value === values[at - 1]) repeats = true;
		else if (seen.has(value)) return false;
		else seen.add(value);
	}
	return repeats;
}

/** Same-unit aggregate columns (`Total`, `avg`) restate the series beside them. */
function dropAggregates(measures: readonly TableColumn[], rows: readonly number[]): readonly TableColumn[] {
	return measures.filter(column => {
		if (!AGGREGATE.test(column.header)) return true;
		const others = measures.filter(other => other !== column && other.dim === column.dim);
		if (others.length < 2) return true;
		// `Total tokens` (16.8k) beside `Tests passed` and `Turns` (27 + 6) counts another thing than they do: an
		// aggregate {@link QUANTITY_SPREAD}× their sum restates nothing.
		const ratios = rows
			.map(row => {
				const sum = others.reduce((acc, other) => acc + (columnValues(other, [row])[0] ?? 0), 0);
				return (columnValues(column, [row])[0] ?? Number.NaN) / sum;
			})
			.filter(Number.isFinite)
			.sort((a, b) => a - b);
		return (ratios[ratios.length >> 1] ?? 0) >= QUANTITY_SPREAD;
	});
}

/** How the label column orders the rows: by time, by step, by a numeric size — or not at all. */
function axisOrder(
	table: TableAnalysis,
	label: TableColumn | undefined,
): "temporal" | "sequence" | "numeric" | undefined {
	if (!label) return undefined;
	if (label.role === "temporal") return "temporal";
	// Repeating steps (`Tier` 1, 1, 2) bucket the rows rather than order an axis.
	if (label.role === "sequence") return isMonotonic(columnValues(label, table.rows)) ? "sequence" : undefined;
	const names = table.rows.map(row => label.cells[row]!.text);
	const mostly = (pattern: RegExp) => names.filter(name => pattern.test(name)).length >= names.length * 0.8;
	if (mostly(SEQUENCE_LABEL)) return "sequence";
	if (mostly(MONTH)) return "temporal";
	const values = columnValues(label, table.rows);
	if (values.length === names.length && values.length >= 3 && isMonotonic(values)) return "numeric";
	return undefined;
}

/** Label headers naming the ordered runs of one process (`Run`, `Iteration`, `Week`), whatever their cells say. */
const ORDER_HEADER =
	/^(?:runs?|steps?|stages?|phases?|rounds?|iter(?:ation)?s?|epochs?|turns?|attempts?|waves?|versions?|releases?|builds?|commits?|frames?|days?|weeks?|months?|years?|quarters?|dates?|time)\b/i;

/**
 * Whether `table`'s rows lie along an ordered axis: dates, steps or a
 * monotonic size naming them, a label header naming the runs of one process
 * (`Run` over run ids), or a count rising down a column before the label
 * (`# added` 1, 2, 5, 12 beside `project`). Over unordered categories
 * (`Variant`, `Model`, metric names) a line draws a trend that is not there.
 */
function orderedRows(table: TableAnalysis, label: TableColumn | undefined): boolean {
	if (axisOrder(table, label) || (label && ORDER_HEADER.test(label.header))) return true;
	return table.columns.some(column => {
		if (!label || column.index >= label.index || (column.role !== "measure" && column.role !== "sequence"))
			return false;
		const values = columnValues(column, table.rows);
		return values.length === table.rows.length && isMonotonic(values) && values[1]! > values[0]!;
	});
}

function columnValues(column: TableColumn, rows: readonly number[]): number[] {
	const values: number[] = [];
	for (const row of rows) {
		const cell = column.cells[row];
		if (isNumber(cell)) values.push(cell.value);
	}
	return values;
}

/** A column as a series: its cells of the column's dimension, other cells as gaps (status words kept as notes). */
function columnSeries(column: TableColumn, rows: readonly number[], name: string): ChartSeries {
	const points: (ChartPoint | null)[] = [];
	const notes: (string | undefined)[] = [];
	for (const row of rows) {
		const cell = column.cells[row]!;
		const fits = isNumber(cell) && cell.dim === column.dim;
		// A lone `5× → 2×` among plain values is where the row stands now: its end, not its start.
		const moved = fits && cell.to !== undefined && column.arrowShare < 0.6;
		points.push(
			moved
				? { value: cell.to!, text: `${cell.figure} → ${cell.toFigure}`, emphasis: cell.emphasis }
				: fits
					? point(cell)
					: null,
		);
		notes.push(!fits && cell.kind !== "missing" && !isNumber(cell) ? cell.text : undefined);
	}
	return { name, dim: column.dim ?? "count", unit: column.unit, points, notes };
}

/** One row of a metric-per-row table as a series over the plotted columns, in the row's dominant dimension. */
function rowSeries(name: string, columns: readonly TableColumn[], row: number): ChartSeries {
	const cells = columns.map(column => column.cells[row]);
	const tally = new Map<Dimension, number>();
	for (const cell of cells) if (isNumber(cell)) tally.set(cell.dim, (tally.get(cell.dim) ?? 0) + 1);
	let dim: Dimension = "count";
	for (const [key, count] of tally) if (count > (tally.get(dim) ?? 0)) dim = key;
	const unitCell = cells.find(cell => isNumber(cell) && cell.dim === dim);
	return {
		name,
		dim,
		unit: isNumber(unitCell) && (dim === "currency" || dim === "rate") ? unitCell.unit : "",
		points: cells.map(cell => (isNumber(cell) && cell.dim === dim ? point(cell) : null)),
		notes: cells.map(cell => (cell && !isNumber(cell) && cell.kind !== "missing" ? cell.text : undefined)),
	};
}

/** A numeric cell as a plotted point labelled with its written figure. */
function point(cell: NumberCell): ChartPoint {
	return { value: cell.value, text: cell.figure, emphasis: cell.emphasis, upper: cell.upper, error: cell.error };
}

/** `Total: 2,964 · 2,310` for each summary row, over the plotted columns. */
function totalsCaption(
	table: TableAnalysis,
	label: TableColumn | undefined,
	columns: readonly TableColumn[],
	transpose: boolean,
): string | undefined {
	if (transpose || !label || table.totals.length === 0) return undefined;
	const lines = table.totals.slice(0, 2).flatMap(row => {
		const values = columns.map(column => column.cells[row]?.text ?? "").filter(Boolean);
		return values.length ? [`${label.cells[row]!.text}: ${values.join(" · ")}`] : [];
	});
	return lines.length ? lines.join("   ") : undefined;
}
