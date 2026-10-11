/**
 * Draws a {@link ChartSpec} as a standalone SVG document colored only with
 * figure tokens — `var(--fg)`, `var(--muted)`, `var(--border)`,
 * `var(--accent)`, `var(--surface)`, `var(--c1)`…`var(--c6)` — on a
 * transparent background — the token vocabulary of assistant ```svg figures —
 * so the host resolves them against the live theme (`prepareSvg`) for both
 * the rasterized terminal image and the native TSP blob.
 *
 * Styled after Apple's charts and Tern's UI: a UI sans (Geist where Tern
 * provides it), muted labels, hairline gridlines that recede behind the
 * marks, bars and cells with rounded corners, smooth lines (over a soft area
 * fill where the axis starts at zero), dot legends, one hue across small
 * multiples' columns with gray for context. 13-unit labels land near the terminal's own glyph size
 * at 16 user units per row; bolded table cells draw at full strength while
 * their neighbours recede. Grouped categories ({@link ChartSpec.groups}) name
 * each group once beside its members, the groups parted by a gap; a name too
 * long for its column wraps to two lines ({@link categoryLabels}). A few
 * outliers far above the rest break a bar axis instead of flattening it
 * ({@link outlierTier}); reference rows ({@link ChartSpec.reference}) draw a
 * dashed rule through their group.
 *
 * Every chart opens with a header ({@link drawHeader}): the semibold title a
 * planner set ({@link ChartSpec.title}, the one fact worth stating; its key
 * figure in the accent), a muted
 * note on how the data is encoded, and the series key right-aligned on the
 * title's line when it fits. Marks size to
 * the row count ({@link barMetrics}); strong heat cells and share segments
 * print their figures in a theme-adaptive dark {@link ink}. Reusable
 * annotation primitives — {@link band}, {@link referenceRule},
 * {@link callout} — draw the {@link ChartSpec.annotations} a planner lays on.
 *
 * Axes tick on round steps in one unit (`0, 2, 4` for counts, `50s, 100s`,
 * `25 GiB` where the table wrote binary sizes, thousands separated). Meaning
 * layers on top: each contest's best value carries a quiet `best` tag (an
 * outline in a heatmap), estimates (`~15`) among measured figures draw as
 * dashed, faint bars ({@link barRect}), moves of a measure with a polarity read in `success`
 * or `error` (transitions, factors, signed deltas), and status cells badge
 * their row's name with a colored dot keyed under the chart.
 */
import {
	type ChartAnnotation,
	type ChartGroup,
	type ChartPoint,
	type ChartSeries,
	type ChartSpec,
	type ChartTarget,
	intervalMiddle,
	isConditionPair,
	type Polarity,
	percentText,
	referenceFactors,
	targetStanding,
} from "./chart-plan";
import { cellStatus, type Dimension, type Status } from "./table-data";

const WIDTH = 720;
const PAD = 12;
const LABEL_SIZE = 13;
const TICK_SIZE = 11;
/** Mean advance per em of the UI sans, for character budgets; {@link measure} estimates real widths. */
const ADVANCE = 0.55;
/**
 * The UI sans, best first. `Helvetica Neue` comes after Arial: the SVG rasterizer sets any text node holding
 * a glyph it lacks (`→`) in a regular-weight fallback, so semibold titles with arrows lost their weight on macOS.
 */
const FONT =
	"Geist, -apple-system, system-ui, 'SF Pro Text', Inter, 'Segoe UI', Roboto, 'Noto Sans', 'DejaVu Sans', Arial, 'Helvetica Neue', sans-serif";
/** Series colors in draw order. */
const SERIES = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;
/** Corner radius of bars, tracks and cells. */
const RADIUS = 3;
/** Opacity of gridlines over the border color: hairlines behind the marks. */
const GRID_OPACITY = 0.5;
/** Ratio between line series' peaks from which they stop sharing an axis. */
const SPLIT_SPREAD = 8;
/** Most categories whose every sample draws as a dot on its line. */
const MAX_DOTS = 16;
/** Spread (max/min of positive values) from which an axis turns logarithmic. */
const LOG_SPREAD = 100;
/** Spread from which dots and intervals take a log axis: they mark positions, not lengths from zero, so a decade warrants one. */
const SPAN_LOG = 10;
/** Most decades a positional log axis ticks at 1, 2 and 5 times each power of ten. */
const FINE_DECADES = 2.5;
/** Typical ratio between two interval series of one unit from which they are different quantities, banded apart. */
const BAND_SPREAD = 30;
/** Log-axis ticks for durations from a second up, in seconds: clock steps (`30s`, `5m`, `2h`), not powers of ten. */
const CLOCK_TICKS = [
	1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 18_000, 43_200, 86_400, 172_800, 604_800, 1_209_600,
	2_592_000,
];
/**
 * Smallest jump from the rest to an outlier tier that breaks the axis (one
 * model at 60× the others); below it a linear axis still leaves the rest a
 * readable eighth of its length, and keeps the outlier's size visible.
 */
const TIER_GAP = 8;
/** Fewest values below an outlier tier that make breaking the axis worth it. */
const MIN_BELOW_TIER = 3;
/** Most of the values an outlier tier may hold; more is a second cluster, not outliers. */
const MAX_TIER_SHARE = 1 / 3;
/** Share of a broken axis' length the values below the break get. */
const CUT_AT = 0.7;
/** Width of the gap parting a broken axis' segments, in user units. */
const CUT_GAP = 10;
/** Share of its largest value a dumbbell's smallest must reach for its axis to leave zero out. */
const ZOOM_SHARE = 0.6;
/** How far past the rest a clipped diverging axis reaches, as a multiple of their largest magnitude. */
const CLIP_REACH = 1.25;
/** Length of a clipped bar between its break and its end. */
const CLIP_INSET = 16;
const MAX_LABEL_CHARS = 28;
/** Widest each line of a category name wrapped to two sets ({@link labelLines}). */
const LABEL_WIDTH = 200;
/** Size of a name wrapped over two lines, a step under {@link LABEL_SIZE} so the pair fits one row. */
const WRAP_SIZE = 12;
/** Baseline distance between a wrapped name's two lines. */
const WRAP_LINE = 13;
/** Least row height that holds a wrapped name. */
const WRAP_ROW = 30;
/**
 * Most categories whose names wrap; a longer column keeps one line per row,
 * up to {@link WIDE_LABEL_WIDTH}, so it stays a glance tall.
 */
const MAX_WRAP_ROWS = 12;
/** Widest a category name sets on one line; a longer one wraps, or clips where names do not wrap. */
const WIDE_LABEL_WIDTH = 260;
/** Longest group name in a label column; its members beside it keep {@link MAX_LABEL_CHARS}. */
const MAX_GROUP_CHARS = 20;
/** Vertical space parting consecutive groups of category rows. */
const GROUP_GAP = 8;
/** Semibold text sets this much wider than {@link measure} estimates for regular text. */
const SEMIBOLD_WIDTH = 1.06;
/** Opacity of marks beside an emphasized one. */
const RECEDE = 0.4;
/** Categories beyond which grouped bars pack tighter ({@link barMetrics}). */
const DENSE_ROWS = 12;
/** Share of a stacked bar's whole its parts may miss by rounding before the rest draws as a track. */
const MIN_REST = 0.01;
/** Least length of a drawn bar: a zero (or near-zero) value still shows as a stub at the baseline. */
const MIN_BAR = 2.5;
/** Fill opacity of an estimated bar (`~15`) inside its outline, relative to a measured one. */
const ESTIMATE_OPACITY = 0.4;
/** Opacity of a range bar's span past its low end, relative to the bar. */
const RANGE_OPACITY = 0.35;
/** Most panels across one band of small multiples drawn as panels. */
const PANELS_ACROSS = 3;
/** Factors a change axis rounds its ends out to; past the last, whole powers of ten. */
const FACTOR_STOPS = [1.25, 1.5, 2, 3, 5, 10];
/** Height of the title line. */
const TITLE_LINE = 18;
/** Space between the header and the plot under it. */
const HEADER_GAP = 10;
/** Height of one wrapped legend line. */
const LEGEND_LINE = 18;
/** Heat level (0–1) from which a cell is strong enough to print its figure in {@link ink}. */
const INK_LEVEL = 0.58;
/** Fill opacity of the faintest heat cell; the strongest is opaque. */
const HEAT_FLOOR = 0.09;
/** Mask id behind {@link ink}; its definition is the same in every chart, so charts inlined in one page agree on it. */
const INK_MASK = "chart-ink";
/** Longest callout text. */
const MAX_CALLOUT_CHARS = 28;
/** Longest legend name. */
const MAX_LEGEND_CHARS = 32;
/** Longest name a line carries at its end instead of a legend. */
const MAX_DIRECT_LABEL = 130;
/** Width the status badge before a category name takes. */
const STATUS_WIDTH = 14;
/** Badge color of each status. */
const STATUS_COLORS: Record<Status, string> = { good: "success", bad: "error", warn: "warning", pending: "muted" };
/** Room a {@link bestTag} takes after its value. */
const BEST_WIDTH = 34;
/** Most of the width right of the label column a figures column (`a → b  move`) grows to, so a long figure
 * shows whole rather than clipped while the plot keeps the rest. */
const FIGURE_SHARE = 0.48;
/** Least share of a small-multiples column its bars keep; a `best` tag that would squeeze them further goes. */
const MIN_BAR_SHARE = 0.4;
/** Share of a dense grouped chart's cells at zero from which their figures drop: the stub at the baseline says it. */
const ZERO_QUIET = 0.2;
/** Factor within which a move reads as no change, toned neither way. */
const STILL = 1.03;

/**
 * A drawn layer: its SVG elements and the height they span from `top`, with
 * the key and encoding notes the header shows for it.
 */
interface Layer {
	readonly height: number;
	readonly body: string;
	/** Series keys the header draws beside the title (or under it when they do not fit). */
	readonly legend?: readonly LegendItem[];
	/** A heat scale key the header draws instead of a legend. */
	readonly ramp?: RampKey;
	/** How the chart encodes its data where that is not obvious (`log scale`); the derived subtitle. */
	readonly notes?: readonly string[];
}

/** A legend entry: a name beside a filled dot of `color`, or a hollow ring for a transition's start. */
interface LegendItem {
	readonly name: string;
	readonly color: string;
	readonly ring?: boolean;
	/** Further dot colors drawn beside the first, for marks colored by meaning (a toned end: `success`, `error`). */
	readonly tones?: readonly string[];
	/** The dot's opacity, matching a fainter mark (a second part in one outcome color); opaque by default. */
	readonly opacity?: number;
}

/** A heat scale key: the faintest and strongest cells' figures either side of a strip of swatches. */
interface RampKey {
	readonly color: string;
	readonly low: string;
	readonly high: string;
}

/** Map a value to a coordinate, with tick values for the axis. */
interface Scale {
	at(value: number): number;
	readonly ticks: readonly number[];
	readonly log: boolean;
	/** A broken axis: values above `below` jump the gap from `start` to `end` onto a second, zoomed segment. */
	readonly cut?: Cut;
}

/** Where a broken axis parts its segments: the first ends at `start` (value `below`), the second begins at `end`. */
interface Cut {
	readonly below: number;
	readonly start: number;
	readonly end: number;
}

/** A few values standing far above the rest: the rest's largest and the tier's smallest and largest. */
interface Tier {
	readonly rest: number;
	readonly low: number;
	readonly high: number;
}

/** A drawn chart: the SVG document and its size in user units. */
export interface ChartSvg {
	readonly svg: string;
	readonly width: number;
	readonly height: number;
}

/** The SVG document for `spec`. */
export function renderChartSvg(spec: ChartSpec): ChartSvg {
	const layer = drawChart(spec);
	const header = drawHeader(spec, layer);
	const head = matrixHead(spec);
	const top = PAD + header.height + head.height;
	let height = top + layer.height;
	// The badges' key: one dot per status shown, then the column they come from.
	let key = "";
	if (spec.statusName && spec.status?.some(Boolean)) {
		const shown = (["good", "warn", "bad", "pending"] as const).filter(state => spec.status!.includes(state));
		const y = height + 14;
		key = shown.map((state, at) => dot(PAD + 4 + at * 12, y, 4, STATUS_COLORS[state])).join("");
		key += text(PAD + shown.length * 12 + 4, y, clip(spec.statusName, 60), { size: TICK_SIZE, fill: "muted" });
		height += 20;
	}
	let caption = "";
	if (spec.caption) {
		caption = text(PAD, height + 14, clip(spec.caption, Math.floor((WIDTH - 2 * PAD) / (TICK_SIZE * ADVANCE))), {
			size: TICK_SIZE,
			fill: "muted",
		});
		height += 20;
	}
	height = Math.ceil(height + PAD);
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}" font-size="${LABEL_SIZE}">`,
		layer.body.includes(`url(#${INK_MASK})`) ? INK_DEFS : "",
		`<g transform="translate(0 ${PAD})">${header.body}</g>`,
		head.body && `<g transform="translate(0 ${num(PAD + header.height)})">${head.body}</g>`,
		`<g transform="translate(0 ${num(top)})">${layer.body}</g>`,
		key,
		caption,
		"</svg>",
	].join("");
	return { svg, width: WIDTH, height };
}

/** One-line description of the chart, for screen readers and terminals that show the alt text. */
export function chartAlt(spec: ChartSpec): string {
	const joint =
		spec.kind === "stacked" ? " + " : spec.kind === "slope" ? " → " : spec.kind === "butterfly" ? " vs " : ", ";
	const names = spec.series.map(entry => entry.name).join(joint);
	const kind =
		spec.kind === "multiples"
			? "small multiples"
			: spec.normalized
				? "100% stacked"
				: spec.kind === "dots"
					? "dot"
					: spec.kind === "ladder"
						? "quantile"
						: spec.kind === "stat"
							? "comparison"
							: spec.kind;
	const goals = new Set(spec.targets?.flatMap(target => (target ? [target.text] : [])));
	const versus = spec.baseline
		? ` vs ${spec.baseline}`
		: spec.kind === "bullet"
			? goals.size === 1
				? ` vs ${[...goals][0]} ${spec.targetName ?? "target"}`
				: ` vs each row's ${spec.targetName ?? "target"}`
			: spec.whole
				? ` = ${spec.whole.name}`
				: spec.kind === "waterfall" && spec.total
					? ` to ${spec.total.name}`
					: "";
	const lead = spec.title ? `${spec.title}. ` : "";
	return `${lead}${kind} chart of ${names}${versus}${spec.axis ? ` by ${spec.axis}` : ""}`;
}

/**
 * The header over a chart: the title when the plan states one — its key
 * figure in the accent color ({@link titleFigure}), wrapped to a second line
 * rather than clipped — its muted encoding note after it (or on a line of its
 * own when the title leaves no room), and the layer's key right-aligned on
 * the first line, or wrapped under the rest when the line has no room.
 * Nothing at all for a chart with neither title, note nor key.
 */
function drawHeader(spec: ChartSpec, layer: Layer): Layer {
	const span = WIDTH - 2 * PAD;
	const items = layer.legend ?? [];
	const keyWidth = layer.ramp ? rampWidth(layer.ramp) : items.length ? legendWidth(items) : 0;
	const subtitle = spec.subtitle ?? (layer.notes ?? []).join(" · ");
	const fullTitle = spec.title ?? "";
	if (!fullTitle && !subtitle && keyWidth === 0) return { height: 0, body: "" };
	const titleSize = LABEL_SIZE * SEMIBOLD_WIDTH;
	const inline = keyWidth === 0 || !fullTitle || measure(fullTitle, titleSize) + 24 + keyWidth <= span;
	const room = inline && keyWidth ? span - keyWidth - 24 : span;
	const lines = fullTitle ? titleLines(fullTitle, room) : [];
	const figure = titleFigure(fullTitle);
	const parts = lines.map(({ content, start, kept }, at) => {
		// The figure's stretch within this line, where the line holds any of it.
		const [from, to] = figure ? [Math.max(0, figure[0] - start), Math.min(kept, figure[1] - start)] : [0, 0];
		const runs =
			to > from
				? [
						{ content: content.slice(0, from) },
						{ content: content.slice(from, to), fill: "accent" },
						{ content: content.slice(to) },
					]
				: [{ content }];
		return text(PAD, 8 + at * TITLE_LINE, runs, { fill: "fg", weight: 600 });
	});
	let height = Math.max(1, lines.length) * TITLE_LINE;
	// The note follows the title's last line where it fits; else it takes a line of its own (and leads one without a title).
	if (subtitle) {
		const last = lines.at(-1);
		const after = last ? measure(last.content, titleSize) + 12 : 0;
		const lineRoom = lines.length > 1 ? span : room;
		const beside = !last || after + measure(subtitle, TICK_SIZE) <= lineRoom;
		const y = beside ? 8 + Math.max(0, lines.length - 1) * TITLE_LINE : 8 + lines.length * TITLE_LINE;
		parts.push(
			text(PAD + (beside ? after : 0), y, fitText(subtitle, beside ? lineRoom - after : span, TICK_SIZE), {
				size: TICK_SIZE,
				fill: "muted",
			}),
		);
		if (!beside) height += TITLE_LINE - 2;
	}
	if (layer.ramp) {
		const y = inline ? 8 : height + 8;
		parts.push(drawRamp(layer.ramp, inline ? WIDTH - PAD - keyWidth : PAD, y));
		if (!inline) height += LEGEND_LINE;
	} else if (items.length) {
		if (inline) {
			parts.push(drawLegend(items, WIDTH - PAD - keyWidth, WIDTH - PAD, 8).body);
		} else {
			const legend = drawLegend(items, PAD, WIDTH - PAD, height + 8);
			parts.push(legend.body);
			height = legend.height;
		}
	}
	return { height: height + HEADER_GAP, body: parts.join("") };
}

/**
 * A title in at most two lines of `width`: whole when it fits, else broken
 * at the last space that fits the first line, the second clipped if still
 * too long. Each line keeps its `start` in the title and the count of its
 * characters `kept` from it (a clipped line ends in `…`).
 */
function titleLines(title: string, width: number): { content: string; start: number; kept: number }[] {
	const size = LABEL_SIZE * SEMIBOLD_WIDTH;
	if (measure(title, size) <= width) return [{ content: title, start: 0, kept: title.length }];
	let at = title.lastIndexOf(" ");
	while (at > 0 && measure(title.slice(0, at), size) > width) at = title.lastIndexOf(" ", at - 1);
	if (at <= 0) {
		const content = fitText(title, width, size);
		return [{ content, start: 0, kept: content.endsWith("…") ? content.length - 1 : content.length }];
	}
	const rest = title.slice(at + 1);
	const second = fitText(rest, width, size);
	return [
		{ content: title.slice(0, at), start: 0, kept: at },
		{ content: second, start: at + 1, kept: second === rest ? rest.length : second.length - 1 },
	];
}

/**
 * The stretch of `title` holding its key figure, as `[start, end)`: the first
 * factor (`6.3× more`), else the first signed percent (`−45%`), else the
 * first figure in parentheses (`(31.7s)`), else the first with a unit; a
 * number inside a name (`gpt-5.5`, `Iter127`, `opt-level 0`) never counts.
 */
function titleFigure(title: string): [number, number] | undefined {
	const figure =
		/(?<![\w.\-−])[+−-]?[$€£]?\d[\d,]*(?:\.\d+)?(?:\s?[–/-]\s?\d[\d,]*(?:\.\d+)?)?(?:×(?:\s(?:more|less))?|%|\s?(?:[nµm]?s|min|h|[KMGT]i?B|B|k|M|tok\/s)(?!\w))?/g;
	const found = [...title.matchAll(figure)].map(match => ({
		start: match.index,
		end: match.index + match[0].length,
		content: match[0],
	}));
	const pick =
		found.find(match => match.content.includes("×")) ??
		found.find(match => /^[+−-].*%$/.test(match.content)) ??
		found.find(match => title[match.start - 1] === "(") ??
		found.find(match => /[^\d,.\s–-]$/.test(match.content) || /^[$€£]/.test(match.content));
	return pick && [pick.start, pick.end];
}

function drawChart(spec: ChartSpec): Layer {
	switch (spec.kind) {
		case "line":
			return drawLine(spec);
		case "heatmap":
			return drawGrid(spec, "heat");
		case "multiples":
			// Many panels of a few colorable categories wrap into bands; otherwise one column per panel.
			return spec.series.length > PANELS_ACROSS && spec.categories.length <= SERIES.length
				? drawPanels(spec)
				: drawGrid(spec, "bars");
		case "change":
			return drawChange(spec);
		case "share":
			return drawShare(spec);
		case "scatter":
			return drawScatter(spec);
		case "stacked":
			return drawStacked(spec);
		case "waterfall":
			return drawWaterfall(spec);
		case "timeline":
			return drawTimeline(spec);
		case "dots":
			return drawDots(spec);
		case "range":
			return drawRange(spec);
		case "slope":
			return drawSlope(spec);
		case "butterfly":
			return drawButterfly(spec);
		case "bullet":
			return drawBullet(spec);
		case "ladder":
			return drawLadder(spec);
		case "histogram":
			return drawHistogram(spec);
		case "stat":
			return drawStat(spec);
		default:
			return drawBars(spec);
	}
}

// ── Horizontal bars: bar, grouped, paired, diverging, progress ───────────────

/**
 * Row and bar heights for `count` categories: few rows get thick, airy bars,
 * many get thin ones so the chart stays a glance. Grouped bars stack one thin
 * bar per series in each row.
 */
function barMetrics(count: number, grouped: number): { row: number; bar: number; step: number } {
	if (grouped > 1) {
		// Past {@link DENSE_ROWS} categories grouped bars pack tighter, so a long table stays a glance tall.
		if (count > DENSE_ROWS) return { row: grouped * 9 + 9, bar: 7, step: 9 };
		const bar = count <= 6 ? 10 : 8;
		return { row: grouped * (bar + 2) + 10, bar, step: bar + 2 };
	}
	const bar = count <= 5 ? 18 : count <= 10 ? 16 : count <= 20 ? 14 : 11;
	return { row: bar + (count <= 10 ? 10 : 8), bar, step: 0 };
}

function drawBars(spec: ChartSpec): Layer {
	const { kind, categories, series } = spec;
	// Progress fills a 0–100% track per bar; grouped and multi-track progress stack thin bars per category.
	const tracks = kind === "progress";
	const grouped = kind === "grouped" || (tracks && series.length > 1);
	const paired = kind === "paired";
	const single = series.length === 1;
	const diverging = kind === "diverging" && single;
	const values = tracks
		? [0, 100]
		: series.flatMap(entry =>
				entry.points.flatMap(point =>
					!point
						? []
						: point.upper !== undefined
							? [point.value, point.upper]
							: point.error
								? [point.value - point.error, point.value + point.error]
								: [point.value],
				),
			);
	const labelWidth = labelColumnWidth(spec);
	// Single bars beside a reference row print their change from it (`49.5k · −52%`).
	const referenced = kind === "bar" && spec.reference ? spec.reference : [];
	const versus = (at: number) => {
		const factor = referenced.length ? referenceFactors(spec, series[0]!)[at] : undefined;
		return factor === undefined ? "" : factorText({ ...series[0]!.points[at]!, value: factor });
	};
	// A transition prints each row's move after its figures (`8 → 2  −6`), one style for every row.
	const moves = paired && spec.transition ? pairMoves(series[0]!, series[1]!) : undefined;
	// Peers on a log axis (`pi-walker` vs `Go` from 2 to 462) part by their ratio: each row prints it (`4.1×`).
	const ratios =
		paired && !spec.transition && logSpread(values)
			? categories.map((_, at) => {
					const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
					if (!a || !b || !(a.value > 0) || !(b.value > 0)) return "";
					const ratio = Math.max(a.value, b.value) / Math.min(a.value, b.value);
					// `235×`, `4.1×`: as the table's own ratio columns write them.
					return `${ratio >= 10 ? Math.round(ratio).toLocaleString("en-US") : Number(ratio.toFixed(1))}×`;
				})
			: undefined;
	const valueText = (at: number) =>
		paired
			? [pointText(series[0]!, at), pointText(series[1]!, at)]
					.filter(Boolean)
					.join(spec.transition ? " → " : " · ") +
				(moves?.[at] ? `${MOVE_GAP}${moves[at]}` : "") +
				(ratios?.[at] ? `${MOVE_GAP}${ratios[at]}` : "")
			: single
				? [pointText(series[0]!, at), versus(at)].filter(Boolean).join(" · ")
				: "";
	const widest = (labels: readonly string[], size: number) =>
		Math.max(0, ...labels.map(label => measure(label, size)));
	const callouts = calloutTexts(spec);
	const calloutWidth = callouts.size ? widest([...callouts.values()], TICK_SIZE) * SEMIBOLD_WIDTH + 24 : 0;
	// A diverging bar's figure sits past its end, away from zero: negative figures need room left of the plot.
	const signed = (negative: boolean) =>
		widest(
			categories.map((_, at) => {
				const point = series[0]!.points[at];
				return point && point.value < 0 === negative ? valueText(at) : "";
			}),
			TICK_SIZE,
		);
	const leftRoom = diverging && values.some(value => value < 0) ? signed(true) + 8 : 0;
	// A best tag follows its figure: room for it where a series (or the row leaders) holds one.
	const tagged =
		series.some(entry => entry.best !== undefined) || spec.leaders?.some(lead => lead !== undefined) ? BEST_WIDTH : 0;
	const valueWidth =
		(diverging
			? signed(false) + 8
			: grouped
				? widest(
						series.flatMap(entry => entry.points.map(point => clip(point?.text ?? "", 12))),
						10,
					) + 6
				: Math.min(
						// A transition's move closes its figures (`243–424 ms → 3154–3648 ms  13× more`); long ones
						// take up to {@link FIGURE_SHARE} of the room right of the labels before the start figure clips.
						moves ? Math.max(MAX_MOVE_COLUMN, (WIDTH - 2 * PAD - labelWidth - 10) * FIGURE_SHARE) : 180,
						widest(
							categories.map((_, at) => valueText(at)),
							TICK_SIZE,
						) + 8,
					)) + (paired ? 0 : tagged);
	const left = PAD + labelWidth + 10 + leftRoom;
	const right = WIDTH - PAD - valueWidth - calloutWidth;
	// Signed changes beside one far larger (`−$158k` beside ±$7k): the axis ends past the rest, the outlier's
	// bar runs to that end through a break and keeps its figure.
	const tier = diverging ? outlierTier(values.map(Math.abs), Number.POSITIVE_INFINITY) : undefined;
	const limit = tier ? tier.rest * CLIP_REACH : Number.POSITIVE_INFINITY;
	const clamp = (value: number) => Math.max(-limit, Math.min(limit, value));
	// A dumbbell's connector or a track cannot cross a gap; bars can. Dots mark positions, not lengths: a
	// dumbbell's axis leaves zero out where every value lies far from it (5382 → 5467 ms), so close values part.
	const clustered = paired && Math.min(...values) >= ZOOM_SHARE * Math.max(...values);
	const axis = valueScale(tier ? values.map(clamp) : values, left, right, {
		zero: !clustered,
		breakable: kind === "bar" || kind === "grouped",
		unit: tickUnit(series[0]!, values),
	});
	const scale: Scale = tier ? { ...axis, at: value => axis.at(clamp(value)) } : axis;
	const { row, bar: barHeight, step } = barMetrics(categories.length, grouped ? series.length : 1);
	const rowHeight = labelRow(spec, row);

	const parts: string[] = [];
	const references = referenceMarks(spec);
	const top = references.length ? 16 : 0;
	const tops = rowTops(spec, top, rowHeight);
	const gridTop = top;
	const gridBottom = tops.at(-1)!;
	const strong = strongCategories(spec);
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, series[0]!, gridTop, gridBottom));
	parts.push(categoryLabels(spec, tops, rowHeight, strong));
	// Reference rules run under the marks and their figures; their labels sit above the plot.
	parts.push(referenceLines(references, scale, left, right, gridTop, gridBottom));

	const zero = scale.log ? left : scale.at(0);
	const reference = referenced.length ? referenceRules(spec, series[0]!, tops, rowHeight, scale.at) : undefined;
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	const estimates = series.map(estimatedPoints);
	// In a dense grouped chart where zeros are common ({@link ZERO_QUIET}), a zero is its stub alone: twenty `0`
	// figures are noise.
	const plotted = series.flatMap(entry => entry.points.filter(point => point !== null));
	const quietZeros =
		grouped &&
		categories.length > DENSE_ROWS &&
		plotted.filter(point => point.value === 0).length >= ZERO_QUIET * plotted.length;
	// A toned transition's end dots take their move's color, a move that went nowhere a neutral one; the key's
	// end dot is neutral and the note says which way is better.
	const polarity = paired && spec.transition ? (series[1]!.polarity ?? series[0]!.polarity) : undefined;
	const toned =
		polarity !== undefined &&
		categories.some((_, at) => {
			const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
			return a && b && pairTone(series[0]!, series[1]!, a, b);
		});
	categories.forEach((_, at) => {
		const rowTop = tops[at]!;
		const middle = rowTop + rowHeight / 2;
		if (paired) {
			const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
			const radius = barHeight >= 14 ? 5 : 4;
			// A range (`5.7–9.6 ms`) draws as a capsule over its span; the connector joins the spans' middles.
			const center = (point: ChartPoint) => (scale.at(point.value) + scale.at(point.upper ?? point.value)) / 2;
			// A transition its measure's polarity calls better or worse takes that color at its end.
			const tone = spec.transition && a && b ? pairTone(series[0]!, series[1]!, a, b) : undefined;
			const end = tone ?? (toned ? "muted" : SERIES[0]);
			if (a && b) {
				const [from, to] = [center(a), center(b)];
				// A transition's connector is solid in its end's color, so its length reads as the move.
				parts.push(
					!spec.transition
						? line(from, middle, to, middle, "border", 2.5)
						: rect(
								Math.min(from, to),
								middle - 1.5,
								Math.max(0.5, Math.abs(to - from)),
								3,
								end,
								MOVE_OPACITY,
								1.5,
							),
				);
			}
			// A transition that went nowhere rings its end dot, so the start still shows.
			const still = a && b && Math.abs(center(a) - center(b)) < radius;
			if (a && !(spec.transition && still))
				parts.push(
					spec.transition
						? mark(scale, a, middle, radius, "muted", 1, true)
						: mark(scale, a, middle, radius, SERIES[0], 1),
				);
			if (b) parts.push(mark(scale, b, middle, radius, spec.transition ? end : SERIES[1], 1));
			if (a && spec.transition && still) parts.push(ring(center(a), middle, radius + 2.5, "muted"));
			const strongPair = a?.emphasis || b?.emphasis;
			const from = pointText(series[0]!, at);
			const to = pointText(series[1]!, at);
			if (spec.transition && from && to) {
				// The end figure and the move always show; a start too long for what they leave gives way first.
				const move = moves?.[at];
				const kept = measure(`${to}${move ? `${MOVE_GAP}${move}` : ""}`, TICK_SIZE) * SEMIBOLD_WIDTH;
				const room = valueWidth - 8 - kept - measure(" → ", TICK_SIZE);
				const fits = measure(valueText(at), TICK_SIZE) + 8 <= valueWidth;
				const head = `${fits ? from : fitText(from, room, TICK_SIZE)} → `;
				const tail = right + 8 + measure(head, TICK_SIZE);
				parts.push(text(right + 8, middle, head, { size: TICK_SIZE, fill: "muted" }));
				parts.push(text(tail, middle, to, { size: TICK_SIZE, fill: "fg", weight: strongPair ? 600 : undefined }));
				if (move)
					parts.push(
						text(tail + measure(`${to}${MOVE_GAP}`, TICK_SIZE), middle, move, {
							size: TICK_SIZE,
							fill: tone ?? "muted",
							weight: tone ? 600 : undefined,
						}),
					);
			} else {
				// Each figure in its dot's color ties it to its series without a trip to the legend.
				// A transition missing its end prints its start muted, as its ring is drawn.
				const runs: TextRun[] = from ? [{ content: from, fill: spec.transition ? "muted" : SERIES[0] }] : [];
				if (to) runs.push(...(from ? [{ content: " · " }] : []), { content: to, fill: SERIES[1] });
				// An en space: runs share one text element, where plain spaces collapse.
				if (ratios?.[at]) runs.push({ content: `\u2002${ratios[at]}`, fill: "fg" });
				parts.push(
					text(right + 8, middle, runs, {
						size: TICK_SIZE,
						fill: "muted",
						weight: strongPair ? 600 : undefined,
					}),
				);
			}
			return;
		}
		series.forEach((entry, index) => {
			const point = entry.points[at];
			const y = grouped ? rowTop + 5 + index * step : middle - barHeight / 2;
			const context = emphasized && !point?.emphasis;
			// One series' context bars go gray so the bolded ones carry the color alone; several keep their hues.
			// Signed changes of a measure with a polarity read as gains or losses.
			const gain = diverging && point ? moveTone(entry.polarity, point.value < 0 ? 0.5 : 2) : undefined;
			const fill =
				single && context
					? "muted"
					: (gain ?? (diverging && point && point.value < 0 ? SERIES[1] : SERIES[index % SERIES.length]!));
			const opacity = context ? (single ? 0.55 : RECEDE) : 1;
			if (tracks) parts.push(rect(left, y, scale.at(100) - left, barHeight, "border", 0.35));
			if (!point) {
				const note = entry.notes[at];
				if (note) parts.push(noteText(left + 4, y + barHeight / 2, clip(note, 24)));
				return;
			}
			const end = scale.at(point.value);
			if (scale.log) {
				parts.push(line(left, y + barHeight / 2, end, y + barHeight / 2, fill, 2, 0.4 * opacity));
				parts.push(mark(scale, point, y + barHeight / 2, Math.min(6, barHeight / 2.6), fill, opacity));
			} else if (scale.cut && point.value > scale.cut.below) {
				parts.push(cutBar(scale.cut, zero, end, y, barHeight, fill, opacity));
			} else if (Math.abs(point.value) > limit) {
				// Clipped: the bar breaks just short of its end, which sits on the axis' limit.
				const toward = Math.sign(zero - end);
				const cut = end + toward * CLIP_INSET;
				parts.push(
					rect(Math.min(end, cut - toward * (CUT_GAP / 2)), y, CLIP_INSET - CUT_GAP / 2, barHeight, fill, opacity),
				);
				parts.push(
					rect(
						Math.min(zero, cut + toward * (CUT_GAP / 2)),
						y,
						Math.abs(zero - cut) - CUT_GAP / 2,
						barHeight,
						fill,
						opacity,
					),
				);
				parts.push(breakMark(cut, y + barHeight / 2, barHeight / 2 + 1, "muted"));
			} else {
				parts.push(
					barRect(Math.min(zero, end), y, Math.max(MIN_BAR, Math.abs(end - zero)), barHeight, fill, opacity, {
						estimate: estimates[index]!.has(at),
					}),
				);
				// A range's span past its low end, faint: at least the bar, possibly up to its end.
				if (point.upper !== undefined && point.upper > point.value)
					parts.push(rect(end, y, scale.at(point.upper) - end, barHeight, fill, RANGE_OPACITY * opacity));
			}
			if (point.error) parts.push(whisker(scale, point, y + barHeight / 2, Math.max(3, barHeight / 2 - 1)));
			if (grouped) {
				const labelX = tracks
					? scale.at(100) + 4
					: Math.max(end, scale.at(point.upper ?? point.value + (point.error ?? 0))) + 4;
				const best = entry.best === at || spec.leaders?.[at] === index;
				const label = quietZeros && point.value === 0 && !best ? "" : clip(point.text, 12);
				const size = step < 10 ? 9 : 10;
				parts.push(
					text(labelX, y + barHeight / 2, label, {
						size,
						fill: point.emphasis || best ? "fg" : "muted",
						weight: point.emphasis || best ? 600 : undefined,
					}),
				);
				if (best) parts.push(bestTag(labelX + measure(label, size) * SEMIBOLD_WIDTH + 4, y + barHeight / 2, size));
			}
		});
		if (single) {
			const point = series[0]!.points[at];
			if (!point) return;
			const end = Math.max(
				scale.at(point.value),
				point.upper === undefined ? 0 : scale.at(point.upper),
				point.error ? scale.at(point.value + point.error) : 0,
			);
			const label = valueText(at);
			const best = series[0]!.best === at;
			const style = {
				size: TICK_SIZE,
				fill: point.emphasis || best ? "fg" : "muted",
				weight: point.emphasis || best ? 600 : undefined,
			} as const;
			if (diverging && point.value < 0)
				parts.push(text(scale.at(point.value) - 6, middle, label, { ...style, anchor: "end" }));
			else {
				// Clear the dot a log axis draws instead of a bar, and the group's reference rule.
				const x = tracks ? right + 8 : Math.max(end, zero, reference?.at[at] ?? zero) + (scale.log ? 10 : 6);
				parts.push(text(x, middle, label, style));
				if (best) parts.push(bestTag(x + measure(label, TICK_SIZE) * SEMIBOLD_WIDTH + 6, middle, TICK_SIZE));
			}
		}
	});
	if (diverging && !scale.log) parts.push(line(zero, gridTop - 4, zero, gridBottom + 4, "fg", 1.25, 0.6));
	if (reference) parts.push(reference.body);
	for (const [at, note] of callouts) {
		const middle = tops[at]! + rowHeight / 2;
		const point = series[0]!.points[at];
		const reach = paired
			? right + 8 + measure(valueText(at), TICK_SIZE)
			: point && single && !tracks
				? Math.max(scale.at(point.value), zero, reference?.at[at] ?? zero) +
					(scale.log ? 10 : 6) +
					measure(valueText(at), TICK_SIZE)
				: right + 8 + (single ? measure(valueText(at), TICK_SIZE) : 0);
		parts.push(callout(reach + 6, middle, WIDTH - PAD - calloutWidth + 18, note));
	}
	// A toned end is keyed by the colors its dots take (better, worse, unmoved), not one the chart never draws.
	const endTones = toned
		? (["success", "error", "muted"] as const).filter(color =>
				categories.some((_, at) => {
					const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
					return (
						b &&
						(a ? pairTone(series[0]!, series[1]!, a, b) : undefined) === (color === "muted" ? undefined : color)
					);
				}),
			)
		: [];
	const legend: LegendItem[] =
		single && !paired
			? []
			: paired && spec.transition
				? [
						{ name: series[0]!.name, color: "muted", ring: true },
						toned
							? { name: series[1]!.name, color: endTones[0] ?? "fg", tones: endTones.slice(1) }
							: { name: series[1]!.name, color: SERIES[0] },
					]
				: series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! }));
	return {
		height: gridBottom + 20,
		body: parts.join(""),
		legend,
		notes: [
			...(toned ? [`${polarity} is better`] : []),
			...(scale.log && !tracks ? ["log scale"] : scale.cut || tier ? ["broken axis"] : []),
		],
	};
}

/**
 * A value as a dot, or a range (`upper` set) as a capsule spanning it, at
 * `radius` thickness on `scale`; `hollow` outlines it instead (a transition's start).
 */
function mark(
	scale: Scale,
	point: ChartPoint,
	y: number,
	radius: number,
	fill: string,
	opacity: number,
	hollow = false,
): string {
	const from = scale.at(point.value);
	const to = point.upper === undefined ? from : scale.at(point.upper);
	if (Math.abs(to - from) < 1)
		return hollow ? ring(from, y, radius - 0.75, fill) : dot(from, y, radius, fill, opacity);
	const x = Math.min(from, to) - radius;
	const width = Math.abs(to - from) + 2 * radius;
	if (!hollow) return rect(x, y - radius, width, 2 * radius, fill, opacity, radius);
	const inset = 0.875;
	return `<rect x="${num(x + inset)}" y="${num(y - radius + inset)}" width="${num(width - 2 * inset)}" height="${num(2 * radius - 2 * inset)}" rx="${num(radius - inset)}" fill="none" stroke="${token(fill)}" stroke-width="1.75"/>`;
}

/**
 * The spread a `± e` point states ({@link ChartPoint.error}): a hairline from `value − e` to
 * `value + e` on `scale` at `y`, capped by ticks `half` tall either side, in `stroke` (`fg` by default,
 * so it reads over a bar of any color).
 */
function whisker(scale: Scale, point: ChartPoint, y: number, half: number, stroke = "fg"): string {
	const error = point.error ?? 0;
	const [from, to] = [scale.at(point.value - error), scale.at(point.value + error)];
	if (to - from < 2) return "";
	return [
		line(from, y, to, y, stroke, 1.25, 0.8),
		line(from, y - half, from, y + half, stroke, 1.25, 0.8),
		line(to, y - half, to, y + half, stroke, 1.25, 0.8),
	].join("");
}

// ── Dots and intervals on a positional axis ──────────────────────────────────

/**
 * A Cleveland dot plot: one row per category, one dot per series in its color
 * on a shared axis (logarithmic once values span {@link SPAN_LOG}×), a faint
 * line from the row's smallest value to its largest, ranges as capsules. Each
 * dot's figure sits above it (else below) where it clears its neighbours; the
 * best value of a contest wears a `success` ring.
 */
function drawDots(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const references = referenceMarks(spec);
	const values = series.flatMap(entry =>
		entry.points.flatMap(point => {
			if (!point) return [];
			const spread = point.error ? [point.value - point.error, point.value + point.error] : [];
			return [point.value, point.upper ?? point.value, ...spread];
		}),
	);
	const left = PAD + labelColumnWidth(spec) + 10;
	// Against a baseline column the dots are its factors, figured as moves (`+4%`, `1.3× less`).
	const figureOf = (point: ChartPoint) => (spec.baseline ? factorText(point) : clip(point.text, 12));
	// Figures centre on their dots: half the widest past the plot's last tick.
	const figures = series.flatMap(entry => entry.points.map(point => (point ? figureOf(point) : "")));
	const right = WIDTH - PAD - Math.max(8, ...figures.map(figure => measure(figure, 10) / 2));
	const scale = spanScale(
		values,
		left,
		right,
		references.map(mark => mark.value),
		series[0]!.dim,
		tickUnit(series[0]!, values),
	);
	const rowHeight = labelRow(spec, categories.length <= 10 ? 36 : categories.length <= 16 ? 28 : 20);
	// Below 28 units a row has no room for figures over its dots: the axis reads them.
	const labelled = rowHeight >= 28;
	const top = references.length ? 16 : 0;
	const tops = rowTops(spec, top, rowHeight);
	const bottom = tops.at(-1)!;
	const parts: string[] = [];
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, series[0]!, top, bottom));
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	parts.push(referenceLines(references, scale, left, right, top, bottom));
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	const radius = rowHeight >= 28 ? 5 : 4;
	categories.forEach((_, at) => {
		// Dots sit low in a labelled row: their figures take the space above first.
		const y = tops[at]! + rowHeight / 2 + (labelled ? 2 : 0);
		const present = series.flatMap((entry, index) => {
			const point = entry.points[at];
			return point ? [{ entry, index, point }] : [];
		});
		if (present.length === 0) {
			const note = series.map(entry => entry.notes[at]).find(Boolean);
			if (note) parts.push(noteText(left + 4, y, clip(note, 24)));
			return;
		}
		const xs = present.flatMap(({ point }) => [scale.at(point.value), scale.at(point.upper ?? point.value)]);
		const [low, high] = [Math.min(...xs), Math.max(...xs)];
		if (high - low >= 1) parts.push(line(low, y, high, y, "muted", 2, 0.35));
		const best = (index: number, entry: ChartSeries) => entry.best === at || spec.leaders?.[at] === index;
		// Ranges in a row stack as thinner capsules, each on its own line, so one never hides another lying over it.
		const ranged = present.length > 1 && present.some(({ point }) => point.upper !== undefined);
		const thin = ranged ? Math.min(radius, 3.5) : radius;
		const stagger = ranged ? 2 * thin + 1.5 : 0;
		const spread = (stagger * (present.length - 1)) / 2;
		present.forEach(({ entry, index, point }, slot) => {
			const context = emphasized && !point.emphasis;
			const dotY = y - spread + slot * stagger;
			const size = point.upper === undefined ? radius : thin;
			if (point.error) parts.push(whisker(scale, point, dotY, radius + 1, SERIES[index % SERIES.length]!));
			parts.push(mark(scale, point, dotY, size, SERIES[index % SERIES.length]!, context ? RECEDE : 1));
			if (best(index, entry)) {
				const [from, to] = [scale.at(point.value), scale.at(point.upper ?? point.value)];
				parts.push(
					from === to
						? ring(from, dotY, radius + 3, "success")
						: mark(scale, point, dotY, size + 2.5, "success", 1, true),
				);
			}
		});
		if (!labelled) return;
		// Figures: the best and bolded first, then the row's extremes, then the rest, each above its dot or below it.
		const rank = ({ entry, index, point }: (typeof present)[number]) =>
			best(index, entry) || point.emphasis ? 0 : point.value === highest || point.value === lowest ? 1 : 2;
		const highest = Math.max(...present.map(({ point }) => point.value));
		const lowest = Math.min(...present.map(({ point }) => point.value));
		const taken: { from: number; to: number; level: number }[] = [];
		for (const item of present.toSorted((a, b) => rank(a) - rank(b))) {
			const label = figureOf(item.point);
			const x = (scale.at(item.point.value) + scale.at(item.point.upper ?? item.point.value)) / 2;
			const half = measure(label, 10) / 2 + 2;
			const from = Math.max(left - 6, Math.min(x - half, WIDTH - PAD - 2 * half));
			const level = [-1, 1].find(level =>
				taken.every(box => box.level !== level || box.to <= from || box.from >= from + 2 * half),
			);
			if (level === undefined) continue;
			taken.push({ from, to: from + 2 * half, level });
			const strong = rank(item) === 0;
			const tone = spec.baseline
				? moveTone(item.entry.polarity ?? spec.categoryPolarity?.[at], item.point.value)
				: undefined;
			parts.push(
				text(from + half, y + level * ((ranged ? thin + 6 : radius + 7) + spread), label, {
					size: 10,
					fill: tone ?? (strong ? "fg" : "muted"),
					weight: strong ? 600 : undefined,
					anchor: "middle",
				}),
			);
		}
	});
	// The success ring is keyed where any dot wears one.
	const ringed = categories.some((_, at) =>
		series.some((entry, index) => entry.points[at] && (entry.best === at || spec.leaders?.[at] === index)),
	);
	return {
		height: bottom + 20,
		body: parts.join(""),
		legend: [
			...series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! })),
			...(ringed ? [{ name: "best", color: "success", ring: true }] : []),
		],
		notes: [...(spec.baseline ? ["factor"] : []), ...(scale.log ? ["log scale"] : [])],
	};
}

/**
 * Floating intervals from each value's low end to its high end (`5.7–9.6 ms`),
 * not from zero; single values draw as dots on the same row. Series of one
 * unit share a band (one thin interval each per category, a pair's midpoint
 * factor at the row's end); each other unit gets a band and axis of its own
 * (`reason tokens`, `cost`). The first series' {@link ChartSpec.estimate}
 * draws as a tick inside its interval; reference annotations as dashed rules
 * on their series' band. Axes are logarithmic once values span {@link SPAN_LOG}×.
 */
function drawRange(spec: ChartSpec): Layer {
	const { categories, series, estimate } = spec;
	const references = referenceMarks(spec);
	// Bands by unit, in order of first appearance; a series typically {@link BAND_SPREAD}× another of its
	// unit (`prefix` tokens beside `turns`) is another quantity, on a band of its own.
	const typical = (a: ChartSeries, b: ChartSeries) => {
		const ratios = categories
			.map((_, at) => {
				const [x, y] = [a.points[at], b.points[at]];
				return x && y && intervalMiddle(x) > 0 ? intervalMiddle(y) / intervalMiddle(x) : Number.NaN;
			})
			.filter(Number.isFinite)
			.sort((p, q) => p - q);
		return ratios[ratios.length >> 1] ?? 1;
	};
	const bands: number[][] = [];
	series.forEach((entry, index) => {
		const band = bands.find(members => {
			const lead = series[members[0]!]!;
			const ratio = typical(lead, entry);
			return lead.dim === entry.dim && lead.unit === entry.unit && ratio < BAND_SPREAD && ratio > 1 / BAND_SPREAD;
		});
		if (band) band.push(index);
		else bands.push([index]);
	});
	const titled = bands.length > 1;
	// The pair of a two-series band: its factor between midpoints closes each row.
	const transition = spec.transition === true;
	// A transition's start (the first series) recedes in muted; the lead color passes to its end.
	const color = (index: number) =>
		transition ? (index === 0 ? "muted" : SERIES[(index - 1) % SERIES.length]!) : SERIES[index % SERIES.length]!;
	const figure = (index: number, at: number) => {
		const own = pointText(series[index]!, at);
		const central = index === 0 && estimate?.points[at] ? estimate.points[at]!.text : "";
		return [central, own].filter(Boolean).join(" · ");
	};
	const figureWidth = Math.max(
		0,
		...series.flatMap((_, index) => categories.map((_, at) => measure(figure(index, at), TICK_SIZE))),
	);
	// A two-series band compares by a factor when it is a transition, or one quantity under two
	// conditions (`Typical | Max Size`, one-word rivals like `xutf | std`); `~Rate | Est. cost` share a
	// unit, not a quantity.
	const paired = (members: readonly number[]) => {
		if (members.length !== 2) return false;
		const [first, second] = members.map(index => series[index]!.name.trim()) as [string, string];
		return (
			(transition && members[0] === 0) || isConditionPair(first, second) || (!/\s/.test(first) && !/\s/.test(second))
		);
	};
	// A lone series beside reference rows (`Current: 2000px PNG`) reads as factors of them, as single bars do.
	const referenced = (spec.reference?.length ?? 0) > 0 && bands.some(members => members.length === 1);
	const factorWidth = bands.some(paired) || referenced ? 84 : 0;
	const left = PAD + labelColumnWidth(spec) + 10;
	const right = WIDTH - PAD - figureWidth - 8 - factorWidth;
	const strong = strongCategories(spec);
	// A bolded estimate (`**≈ $6,700**`) singles its row out as a bolded interval would.
	const bold = (index: number, at: number) =>
		Boolean(series[index]!.points[at]?.emphasis || (index === 0 && estimate?.points[at]?.emphasis));
	const emphasized = series.some((_, index) => categories.some((_, at) => bold(index, at)));
	const parts: string[] = [];
	const notes: string[] = [];
	let y = 0;
	for (const members of bands) {
		const entries = members.map(index => series[index]!);
		const marks = references.filter(mark => members.includes(mark.series ?? 0));
		const values = [
			...entries.flatMap(entry =>
				entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : [])),
			),
			...(members.includes(0) && estimate ? estimate.points.flatMap(point => (point ? [point.value] : [])) : []),
		];
		const scale = spanScale(
			values,
			left,
			right,
			marks.map(mark => mark.value),
			entries[0]!.dim,
			tickUnit(entries[0]!, values),
		);
		if (scale.log && !notes.includes("log scale")) notes.push("log scale");
		if (titled) {
			parts.push(
				text(PAD, y + 8, clip(entries.map(entry => entry.name).join(" · "), 60), { fill: "fg", weight: 600 }),
			);
			y += TITLE_LINE + 4;
		}
		if (marks.length) y += 16;
		const { row, bar, step } = barMetrics(categories.length, members.length);
		const rowHeight = labelRow(spec, row);
		const tops = rowTops(spec, y, rowHeight);
		const bottom = tops.at(-1)!;
		for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
		parts.push(drawValueAxis(scale, entries[0]!, y, bottom));
		parts.push(categoryLabels(spec, tops, rowHeight, strong));
		parts.push(referenceLines(marks, scale, left, right, y, bottom));
		// A pair's factor, first to second by midpoints (peers read it as a ratio, a transition as a move);
		// a lone series' factor of its group's reference row.
		const lone = members.length === 1 ? series[members[0]!]! : undefined;
		const base = (at: number) =>
			lone && spec.reference?.find(index => groupSpan(spec, index).join() === groupSpan(spec, at).join());
		const pair = paired(members);
		const factors = categories.map((_, at) => {
			const ref = base(at);
			const [a, b] = pair
				? members.map(index => series[index]!.points[at])
				: [ref === undefined || ref === at ? undefined : lone?.points[ref], lone?.points[at]];
			if (!a || !b || intervalMiddle(a) <= 0 || intervalMiddle(b) <= 0) return undefined;
			return intervalMiddle(b) / intervalMiddle(a);
		});
		const moves = (transition && members[0] === 0) || lone !== undefined;
		const known = factors.filter((factor): factor is number => factor !== undefined);
		const oneWay = known.length > 0 && (known.every(factor => factor >= 1) || known.every(factor => factor < 1));
		if (pair && !moves && oneWay) {
			const [a, b] = members.map(index => series[index]!.name);
			notes.push(known[0]! >= 1 ? `${b} ÷ ${a}` : `${a} ÷ ${b}`);
		}
		// The reference row's middle as a dashed rule through its group.
		for (const index of lone ? (spec.reference ?? []) : []) {
			const point = lone?.points[index];
			if (!point) continue;
			const [first, last] = groupSpan(spec, index);
			const x = scale.at(intervalMiddle(point));
			parts.push(referenceRule(x, tops[first]! + 2, x, tops[last]! + rowHeight - 2));
		}
		categories.forEach((_, at) => {
			const rowTop = tops[at]!;
			const middle = rowTop + rowHeight / 2;
			members.forEach((index, slot) => {
				const entry = series[index]!;
				const point = entry.points[at];
				const centre = members.length > 1 ? rowTop + 5 + slot * step + bar / 2 : middle;
				if (!point) {
					const note = entry.notes[at];
					if (note) parts.push(noteText(left + 4, centre, clip(note, 24)));
					return;
				}
				const context = emphasized && !bold(index, at);
				const fill = color(index);
				const opacity = context ? RECEDE : transition && index === 0 ? 0.6 : 1;
				const [from, to] = [scale.at(point.value), scale.at(point.upper ?? point.value)];
				// A single value (or an interval thinner than a dot) is a point on the row.
				if (to - from < bar) parts.push(dot((from + to) / 2, centre, Math.min(bar / 2, 6), fill, opacity));
				else parts.push(rect(from, centre - bar / 2, to - from, bar, fill, opacity));
				const central = index === 0 ? estimate?.points[at] : undefined;
				if (central) {
					const x = scale.at(central.value);
					parts.push(line(x, centre - bar / 2 - 3, x, centre + bar / 2 + 3, "fg", 2));
				}
				const end = Math.max(to, from + bar / 2) + 6;
				const own = pointText(entry, at);
				const head = central ? `${central.text} · ` : "";
				const size = members.length > 1 && step < 12 ? 10 : TICK_SIZE;
				if (head) parts.push(text(end, centre, head, { size, fill: "fg", weight: 600 }));
				parts.push(
					text(end + (head ? measure(head, size) * SEMIBOLD_WIDTH : 0), centre, own, {
						size,
						fill: point.emphasis ? "fg" : "muted",
						weight: point.emphasis ? 600 : undefined,
					}),
				);
			});
			const factor = factors[at];
			if (factor === undefined) return;
			const polarity = series[members[1] ?? members[0]!]!.polarity ?? series[members[0]!]!.polarity;
			const tone = moves ? moveTone(polarity, factor) : undefined;
			const said = moves
				? factorText({ value: factor, text: "", emphasis: false })
				: `${compactFactor(factor >= 1 ? factor : 1 / factor)}×`;
			// Peers leading by turns: a dot in the larger one's color before its factor.
			if (!moves && !oneWay)
				parts.push(
					dot(
						WIDTH - PAD - measure(said, TICK_SIZE) * SEMIBOLD_WIDTH - 8,
						middle,
						3.5,
						color(members[factor >= 1 ? 1 : 0]!),
					),
				);
			parts.push(
				text(WIDTH - PAD, middle, clip(said, 14), {
					size: TICK_SIZE,
					fill: tone ?? "fg",
					weight: 600,
					anchor: "end",
				}),
			);
		});
		y = bottom + 20 + (titled ? 12 : 0);
	}
	// Colors need a key once several series share a band, or an estimate tick stands beside the intervals.
	const legend: LegendItem[] =
		(series.length < 2 && !estimate) || (titled && bands.every(members => members.length === 1))
			? []
			: series.map((entry, index) => ({ name: entry.name, color: color(index) }));
	if (estimate) legend.unshift({ name: estimate.name, color: "fg" });
	return { height: y - (titled ? 12 : 0), body: parts.join(""), legend, notes };
}

/** The reference annotations of `spec` (a stated budget, price or 1×). */
function referenceMarks(spec: ChartSpec): Extract<ChartAnnotation, { kind: "reference" }>[] {
	return (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "reference" }> => mark.kind === "reference",
	);
}

/** Dashed {@link referenceRule}s at `marks` across `top`…`bottom`, each labelled above the plot. */
function referenceLines(
	marks: readonly Extract<ChartAnnotation, { kind: "reference" }>[],
	scale: Scale,
	left: number,
	right: number,
	top: number,
	bottom: number,
): string {
	const parts: string[] = [];
	for (const mark of marks) {
		const x = scale.at(mark.value);
		if (x < left - 0.5 || x > right + 0.5) continue;
		parts.push(referenceRule(x, top - 2, x, bottom));
		const label = clip(mark.label, MAX_CALLOUT_CHARS);
		const half = measure(label, 10) / 2;
		parts.push(
			text(Math.min(Math.max(x, left + half), right - half), top - 9, label, {
				size: 10,
				fill: "fg",
				anchor: "middle",
			}),
		);
	}
	return parts.join("");
}

// ── Distributions: quantile ladders and histograms ───────────────────────────

/** Height of a ladder row: room for the marks and, over the row they label, the quantile names. */
const LADDER_ROW = 34;
/** Fill opacity of a ladder's body, from its middle quantile to the next one up. */
const LADDER_BODY = 0.4;

/**
 * Quantiles of one measurement per category ({@link ChartSpec.ladders}) on one shared axis
 * (logarithmic once values span {@link SPAN_LOG}×): per ladder a hairline from its lowest quantile to
 * its highest, a body from its middle quantile (the median, else the lowest) to the next one up, a dot
 * at the middle and a tick at every other quantile. The quantile names label the marks once, over the
 * row whose marks stand furthest apart; several ladders a row (`Startup`, `Wall`) stack in their
 * colors with a legend. Each row closes with its figures (`0.65 / 0.80 / 0.87 / 3.7ms`).
 */
function drawLadder(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const ladders = spec.ladders ?? [{ name: "", series: series.map((_, index) => index) }];
	const values = series.flatMap(entry => entry.points.flatMap(point => (point ? [point.value] : [])));
	// Figures share their unit: written once, after the last (`0.65 / 0.87 / 3.7ms`).
	const figures = (members: readonly number[], at: number) => {
		const texts = members.flatMap(index => (series[index]!.points[at] ? [pointText(series[index]!, at)] : []));
		const unit = /[^\d\s.,]+$/.exec(texts.at(-1) ?? "")?.[0] ?? "";
		const bare = (figure: string) => figure.slice(0, -unit.length).trim();
		const shared = unit !== "" && texts.every(figure => figure.endsWith(unit) && /\d$/.test(bare(figure)));
		const written = texts.map((figure, at) => (shared && at < texts.length - 1 ? bare(figure) : figure));
		return clip(written.join(" / "), 32);
	};
	const figureWidth = Math.max(
		0,
		...ladders.flatMap(ladder => categories.map((_, at) => measure(figures(ladder.series, at), 10))),
	);
	const left = PAD + labelColumnWidth(spec) + 10;
	const right = WIDTH - PAD - figureWidth - 12;
	const scale = spanScale(values, left, right, [], series[0]!.dim, tickUnit(series[0]!, values));
	const stacked = ladders.length > 1;
	const metrics = barMetrics(categories.length, ladders.length);
	const rowHeight = labelRow(
		spec,
		stacked ? metrics.row + 6 : Math.max(metrics.row, categories.length <= 12 ? LADDER_ROW : 24),
	);
	const step = stacked ? metrics.step + 3 : 0;
	const thick = stacked ? metrics.bar : Math.min(12, metrics.bar);
	// The first row whose marks stand far enough apart for every name carries the quantile names (the first
	// ladder's), else the row whose marks stand furthest apart.
	const lead = ladders[0]!.series;
	const spacing = categories.map((_, at) => {
		const xs = lead.flatMap(index => {
			const point = series[index]!.points[at];
			return point ? [scale.at(point.value)] : [];
		});
		if (xs.length < lead.length) return -1;
		return Math.min(...xs.slice(1).map((x, slot) => x - xs[slot]!));
	});
	const room = Math.max(...lead.map(index => measure(clip(series[index]!.name, 8), 10))) + 4;
	const roomy = spacing.findIndex(gap => gap >= room);
	const named = roomy >= 0 ? roomy : spacing.indexOf(Math.max(...spacing));
	const top = 14;
	const tops = rowTops(spec, top, rowHeight);
	const bottom = tops.at(-1)!;
	const parts: string[] = [];
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, series[0]!, top, bottom));
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	const strong = strongCategories(spec);
	// Before and after (`Baseline` | `Final`): the start recedes in muted, the lead color passes to the end.
	const colorOf = (slot: number) =>
		spec.transition ? (slot === 0 ? "muted" : SERIES[(slot - 1) % SERIES.length]!) : SERIES[slot % SERIES.length]!;
	categories.forEach((_, at) => {
		const rowTop = tops[at]!;
		ladders.forEach((ladder, slot) => {
			const color = colorOf(slot);
			const y = stacked ? rowTop + 6 + slot * step + thick / 2 : rowTop + rowHeight / 2 + 4;
			const marks = ladder.series.flatMap(index => {
				const point = series[index]!.points[at];
				return point ? [{ index, point, x: scale.at(point.value) }] : [];
			});
			if (marks.length === 0) return;
			// The middle quantile: the median (or a mean beside quantiles), else the lowest one shown.
			const middle = Math.max(
				0,
				marks.findIndex(({ index }) => /^(?:p50|median|med|mean|avg|average)$/i.test(series[index]!.name)),
			);
			const [low, high] = [marks[0]!.x, marks.at(-1)!.x];
			if (high - low >= 1) parts.push(line(low, y, high, y, color, 1.5, 0.55));
			const centre = marks[middle]!;
			const body = marks[middle + 1];
			if (body && body.x - centre.x >= 1)
				parts.push(rect(centre.x, y - thick / 2, body.x - centre.x, thick, color, LADDER_BODY, 2));
			marks.forEach(({ x }, order) => {
				if (order === middle) return;
				parts.push(line(x, y - thick / 2 - 1, x, y + thick / 2 + 1, color, 2));
			});
			const radius = num(Math.min(5.5, thick / 2 + 1));
			parts.push(
				`<circle cx="${num(centre.x)}" cy="${num(y)}" r="${radius}" fill="${token(color)}" stroke="${token("surface")}" stroke-width="1.5"/>`,
			);
			const said = figures(ladder.series, at);
			const emphasis = strong.has(at) || marks.some(({ point }) => point.emphasis);
			parts.push(
				text(Math.max(high, centre.x + 6) + 8, y, said, {
					size: 10,
					fill: emphasis ? "fg" : "muted",
					weight: emphasis ? 600 : undefined,
				}),
			);
			if (at !== named || slot !== 0) return;
			// Quantile names over this row's marks, each where it clears the one before.
			let clear = Number.NEGATIVE_INFINITY;
			for (const { index, x } of marks) {
				const name = clip(series[index]!.name, 8);
				const half = measure(name, 10) / 2;
				if (x - half < clear) continue;
				parts.push(text(x, y - thick / 2 - 8, name, { size: 10, fill: "muted", anchor: "middle" }));
				clear = x + half + 4;
			}
		});
	});
	return {
		height: bottom + 20,
		body: parts.join(""),
		legend: stacked
			? ladders.map((ladder, slot) => ({ name: ladder.name || `#${slot + 1}`, color: colorOf(slot) }))
			: [],
		notes: scale.log ? ["log scale"] : [],
	};
}

/** Height of a histogram's plot. */
const HISTOGRAM_HEIGHT = 170;
/** Share of a bin's width its columns leave empty when several distributions share it. */
const BIN_GAP = 0.28;

/**
 * Counts (or shares) over ordered bins as columns rising from zero in bin order, the bins named under
 * them and the bins' axis named under those. One distribution's columns nearly touch, as a histogram's
 * do; two to four stand side by side in each bin in their series colors, keyed by a legend. Each column
 * carries its figure; the focus bin gets a band.
 */
function drawHistogram(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const values = [0, ...series.flatMap(entry => entry.points.flatMap(point => (point ? [point.value] : [])))];
	const unit = tickUnit(series[0]!, values);
	const probe = valueScale(values, 0, 1, { zero: true, unit });
	const format = tickFormat(probe, series[0]!);
	const tickWidth = Math.max(...probe.ticks.map(tick => measure(format(tick), TICK_SIZE)));
	const left = PAD + tickWidth + 8;
	const right = WIDTH - PAD;
	const plotTop = 18;
	const plotBottom = plotTop + HISTOGRAM_HEIGHT;
	const scale = valueScale(values, plotBottom, plotTop, { zero: true, unit });
	const binWidth = (right - left) / categories.length;
	const single = series.length === 1;
	const inner = single ? binWidth - 3 : binWidth * (1 - BIN_GAP);
	const columnWidth = inner / series.length;
	const parts: string[] = [];
	for (const at of highlighted(spec))
		parts.push(band(left + at * binWidth, plotTop - 16, binWidth, plotBottom - plotTop + 36));
	scale.ticks.forEach(tick => {
		const y = scale.at(tick);
		parts.push(tick === 0 ? line(left, y, right, y, "border", 1) : rule(left, y, right, y));
		parts.push(text(left - 8, y, format(tick), { size: TICK_SIZE, fill: "muted", anchor: "end" }));
	});
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	const strong = strongCategories(spec);
	const labelSize = columnWidth >= 34 ? TICK_SIZE : 10;
	categories.forEach((name, at) => {
		const start = left + at * binWidth + (binWidth - inner) / 2;
		series.forEach((entry, index) => {
			const point = entry.points[at];
			if (!point) return;
			const x = start + index * columnWidth;
			// A zero or near-zero bin stays visible as a stub.
			const y = Math.min(scale.at(Math.max(0, point.value)), plotBottom - MIN_BAR);
			const context = emphasized && !point.emphasis;
			const width = Math.max(1, columnWidth - (single ? 0 : 2));
			const color = SERIES[index % SERIES.length]!;
			parts.push(barRect(x, y, width, plotBottom - y, color, context ? RECEDE + 0.15 : 1));
			const figure = pointText(entry, at);
			if (measure(figure, labelSize) <= columnWidth + (single ? 0 : 4))
				parts.push(
					text(x + width / 2, y - 8, figure, {
						size: labelSize,
						fill: point.emphasis ? "fg" : "muted",
						weight: point.emphasis ? 600 : undefined,
						anchor: "middle",
					}),
				);
		});
		parts.push(
			text(left + (at + 0.5) * binWidth, plotBottom + 13, fitText(name, binWidth - 4, TICK_SIZE), {
				size: TICK_SIZE,
				fill: strong.has(at) ? "fg" : "muted",
				weight: strong.has(at) ? 600 : undefined,
				anchor: "middle",
			}),
		);
	});
	let height = plotBottom + 22;
	if (spec.axis) {
		const name = clip(spec.axis, 60);
		parts.push(text((left + right) / 2, height + 8, name, { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
		height += 18;
	}
	return {
		height,
		body: parts.join(""),
		legend: single ? [] : series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! })),
		notes: [...(single ? [series[0]!.name] : []), ...(spec.normalized ? ["each as shares of its total"] : [])],
	};
}

// ── Stacked parts of a whole ─────────────────────────────────────────────────

/**
 * Each category's parts as touching segments of one bar, in series order and
 * colors, its whole (else the parts' sum) written past its end. A whole the
 * parts fall short of draws the rest as a faint track. Groups whose bars
 * differ {@link SPLIT_SPREAD}× or more in size split into bands, each on its
 * own axis, so one model sixty times the others does not flatten them to
 * slivers; ungrouped rows share one axis. A {@link ChartSpec.normalized} chart
 * draws each bar as its category's mix on one 0–100% axis, segments wide
 * enough printing their percent (their figure, on a sum's thick bars); outcome parts take their status colors
 * ({@link ChartSpec.tones}).
 */
function drawStacked(spec: ChartSpec): Layer {
	const { categories, series, whole, normalized } = spec;
	const colors = series.map((_, at) => partColor(spec, at));
	const shades = series.map((_, at) => partOpacity(spec, at));
	const sums = categories.map((_, at) => series.reduce((sum, entry) => sum + (entry.points[at]?.value ?? 0), 0));
	// A whole the parts reach within rounding (`48.2k` of `48.3k`) leaves no rest worth a track.
	const ends = sums.map((sum, at) => {
		const total = whole?.points[at]?.value ?? 0;
		return total > sum * (1 + MIN_REST) ? total : sum;
	});
	const totals = sums.map(
		(sum, at) =>
			(whole && pointText(whole, at)) ||
			formatValue(sum, series[0]!.dim, binaryBytes(series[0]!) ? "iB" : series[0]!.unit),
	);
	const rested = ends.some((end, at) => end > sums[at]!);
	const left = PAD + labelColumnWidth(spec) + 10;
	const right = WIDTH - PAD - Math.min(120, Math.max(...totals.map(label => measure(label, TICK_SIZE)))) - 8;
	const { row, bar: barHeight } = barMetrics(categories.length, 1);
	const rowHeight = labelRow(spec, row);
	const strong = strongCategories(spec);
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	const bands = stackBands(spec, normalized ? ends.map(end => (end > 0 ? 100 : 0)) : ends);
	const parts: string[] = [];
	let top = 0;
	for (const stack of bands) {
		const [first, last] = stack.rows;
		const view: ChartSpec = {
			...spec,
			categories: categories.slice(first, last),
			groups: spec.groups?.slice(stack.groups[0], stack.groups[1]),
		};
		const tops = rowTops(view, top, rowHeight);
		const bottom = tops.at(-1)!;
		const extent = normalized ? [0, 100] : [0, ...ends.slice(first, last)];
		const scale = valueScale(extent, left, right, {
			zero: true,
			unit: normalized ? 1 : tickUnit(series[0]!, extent),
		});
		// Category indices into this band's rows.
		const local = (set: Iterable<number>) =>
			new Set([...set].flatMap(at => (at >= first && at < last ? [at - first] : [])));
		for (const at of local(highlighted(spec))) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
		parts.push(
			drawValueAxis(scale, normalized ? { ...series[0]!, dim: "percent", unit: "" } : series[0]!, top, bottom),
		);
		parts.push(categoryLabels(view, tops, rowHeight, local(strong)));
		for (let at = first; at < last; at++) {
			const y = tops[at - first]! + (rowHeight - barHeight) / 2;
			const end = ends[at]!;
			// A mix places each part at its percent of the row's total.
			const place = (value: number) => scale.at(normalized ? (100 * value) / end : value);
			// A row holding none of the parts (cells in another unit, status words) draws nothing but its note.
			if (end === 0) {
				const note = series.map(entry => entry.notes[at]).find(Boolean);
				if (note) parts.push(noteText(left + 4, y + barHeight / 2, clip(note, 24)));
				continue;
			}
			let sum = 0;
			series.forEach((entry, index) => {
				const point = entry.points[at];
				if (!point || point.value <= 0) return;
				const from = place(sum);
				sum += point.value;
				// Segments part with a sliver of the surface behind them.
				const width = Math.max(1, place(sum) - from - 1.5);
				const opacity = (emphasized && !point.emphasis ? RECEDE : 1) * shades[index]!;
				parts.push(rect(from, y, width, barHeight, colors[index]!, opacity));
				// A mix prints each part's percent inside it, a sum each part's figure (on bars thick enough to
				// hold one), in ink to read on the solid color (plain text on a faint one); a part filling the
				// whole bar says so by its length alone.
				const label = normalized ? percentText((100 * point.value) / end) : barHeight >= 14 ? point.text : "";
				const style = { size: TICK_SIZE, fill: "fg", anchor: "middle", weight: 600 } as const;
				if (label && point.value < end && measure(label, TICK_SIZE) * SEMIBOLD_WIDTH + 10 <= width)
					parts.push((opacity >= INK_LEVEL ? ink : text)(from + width / 2, y + barHeight / 2, label, style));
			});
			if (end > sums[at]!) parts.push(rect(place(sum), y, place(end) - place(sum), barHeight, "border", 0.5));
			const bold = whole?.points[at]?.emphasis;
			parts.push(
				text(place(end) + 6, y + barHeight / 2, totals[at]!, {
					size: TICK_SIZE,
					fill: bold ? "fg" : "muted",
					weight: bold ? 600 : undefined,
				}),
			);
		}
		top = bottom + 26;
	}
	const legend: LegendItem[] = series.map((entry, at) => ({
		name: entry.name,
		color: colors[at]!,
		opacity: shades[at],
	}));
	if (rested && whole) legend.push({ name: `rest of ${whole.name}`, color: "border" });
	return {
		height: top - 6,
		body: parts.join(""),
		legend,
		notes: normalized ? ["% of row total"] : bands.length > 1 ? ["scaled per group"] : [],
	};
}

/**
 * Fill of part `at` of a whole: its outcome's status color where the parts
 * are toned ({@link ChartSpec.tones}), `muted` for a part among them naming
 * no outcome (series hues follow the theme accent, so any could pass for a
 * status), else its series color.
 */
function partColor(spec: ChartSpec, at: number): string {
	const { tones } = spec;
	if (!tones) return SERIES[at % SERIES.length]!;
	const tone = tones[at];
	return tone ? STATUS_COLORS[tone] : "muted";
}

/** Opacity step of each further part sharing one outcome color (`fail`, then `error`), so they stay apart. */
const TONE_STEP = 0.4;

/** Opacity of part `at` of a toned whole: full for the first of its color, a {@link TONE_STEP} fainter for each later one. */
function partOpacity(spec: ChartSpec, at: number): number {
	const { tones } = spec;
	if (!tones) return 1;
	const repeats = tones.slice(0, at).filter(tone => tone === tones[at]).length;
	return Math.max(1 - TONE_STEP * repeats, 0.35);
}

/** A run of categories on one axis: its rows and the groups covering them, each as a `[from, to)` index range. */
interface StackBand {
	readonly rows: readonly [number, number];
	readonly groups: readonly [number, number];
}

/**
 * Consecutive groups gathered while their bar ends stay within
 * {@link SPLIT_SPREAD}× of each other; more than three bands (sizes
 * alternating group by group) fall back to one shared axis, as do ungrouped
 * rows, whose bands would part rows the reader expects side by side.
 */
function stackBands(spec: ChartSpec, ends: readonly number[]): StackBand[] {
	const runs = spec.groups?.map(group => group.members.length) ?? [ends.length];
	const bands: { rows: [number, number]; groups: [number, number]; low: number; high: number }[] = [];
	let row = 0;
	runs.forEach((size, index) => {
		const peak = Math.max(...ends.slice(row, row + size));
		const last = bands.at(-1);
		const low = Math.min(last?.low ?? peak, peak);
		const high = Math.max(last?.high ?? peak, peak);
		// A group holding no parts (only notes) rides along with the band before it.
		if (last && (peak === 0 || high <= low * SPLIT_SPREAD)) {
			last.rows[1] = row + size;
			last.groups[1] = index + 1;
			if (peak > 0) {
				last.low = low;
				last.high = high;
			}
		} else {
			bands.push({ rows: [row, row + size], groups: [index, index + 1], low: peak, high: peak });
		}
		row += size;
	});
	if (bands.length > 3) return [{ rows: [0, ends.length], groups: [0, runs.length] }];
	return bands;
}

// ── Moves: how far and which way a value went ────────────────────────────────

/** Space between a transition's figures and its move (`8 → 2  −6`). */
const MOVE_GAP = "  ";
/** Opacity of a transition's connector under its end dot. */
const MOVE_OPACITY = 0.55;
/** Widest figures column of a transition (`from → to  move`). */
const MAX_MOVE_COLUMN = 250;
/** Factor from which a chart writes its moves as factors (`155× less`) rather than percents. */
const FACTOR_MOVE = 10;
/** Whole counts below this move by differences (`8 → 2` is −6) rather than percents. */
const MAX_COUNTED = 100;

/**
 * How a chart writes its moves, one way for every row: `difference` for
 * percentages and small whole counts (`+21.7 pp`, `−6`), else `percent`
 * (`−31%`), or `factor` once any move reaches {@link FACTOR_MOVE}× either way
 * (`155× less`, then `1.2× more` beside it rather than `+20%`).
 */
type MoveStyle = "difference" | "percent" | "factor";

/** The {@link MoveStyle} for `entry`'s moves from each pair's first point to its second. */
function moveStyle(entry: ChartSeries, pairs: readonly (readonly [ChartPoint, ChartPoint])[]): MoveStyle {
	const values = pairs.flatMap(([a, b]) => [a.value, b.value]);
	if (entry.dim === "percent") return "difference";
	if (entry.dim === "count" && !entry.unit && values.every(value => Number.isInteger(value) && value < MAX_COUNTED))
		return "difference";
	const far = pairs.some(
		([a, b]) => a.value > 0 && (b.value === 0 || Math.abs(Math.log10(b.value / a.value)) >= Math.log10(FACTOR_MOVE)),
	);
	return far ? "factor" : "percent";
}

/**
 * The move from `a` to `b` of `entry`'s measure in `style` ({@link factorMove}
 * past a difference): `same` where nothing moved, empty for a factor from zero.
 */
function moveText(a: ChartPoint, b: ChartPoint, entry: ChartSeries, style: MoveStyle): string {
	if (style === "difference") {
		const difference = b.value - a.value;
		const size = Math.abs(difference);
		if (Number(size.toPrecision(6)) === 0) return "same";
		const sign = difference > 0 ? "+" : "−";
		return entry.dim === "percent" ? `${sign}${trim(size)} pp` : `${sign}${formatValue(size, entry.dim, entry.unit)}`;
	}
	return a.value > 0 && b.value >= 0 ? factorMove(b.value / a.value, style) : "";
}

/**
 * A factor as a move: `155× less`, `1.2× more` in the `factor` style, `−31%` in
 * `percent`; `same` within half a percent, or within {@link STILL} beside
 * factors (`1.01× more` is noise next to `155× less`). A drop to zero is
 * `−100%`, or `to zero` among factors, which no factor states.
 */
function factorMove(factor: number, style: "percent" | "factor"): string {
	if (factor === 0) return style === "factor" ? "to zero" : "−100%";
	const percent = Math.round((factor - 1) * 100);
	if (percent === 0 || (style === "factor" && Math.abs(Math.log(factor)) < Math.log(STILL))) return "same";
	if (style === "factor") return factor > 1 ? `${compactFactor(factor)}× more` : `${compactFactor(1 / factor)}× less`;
	return `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

/** Each category's move from `before` to `after` ({@link moveText}), all in the style their values call for. */
function pairMoves(before: ChartSeries, after: ChartSeries): string[] {
	const pairs = before.points.flatMap((a, at): [ChartPoint, ChartPoint][] => {
		const b = after.points[at];
		return a && b ? [[a, b]] : [];
	});
	const style = moveStyle(after, pairs);
	return before.points.map((a, at) => {
		const b = after.points[at];
		return a && b ? moveText(a, b, after, style) : "";
	});
}

/** The tone of a transition from `a` to `b` ({@link moveTone}) by its measure's polarity, the end's before the start's. */
function pairTone(before: ChartSeries, after: ChartSeries, a: ChartPoint, b: ChartPoint): string | undefined {
	return a.value > 0 ? moveTone(after.polarity ?? before.polarity, b.value / a.value) : undefined;
}

/** Categories a planner highlighted ({@link ChartSpec.annotations}), in range. */
function highlighted(spec: ChartSpec): number[] {
	return (spec.annotations ?? []).flatMap(mark =>
		mark.kind === "highlight" && mark.category >= 0 && mark.category < spec.categories.length ? [mark.category] : [],
	);
}

/**
 * Categories whose labels set semibold: highlighted ones, and rows the table
 * bolded a figure in — unless it bolded every row, which singles none out.
 */
function strongCategories(spec: ChartSpec): Set<number> {
	const bold = spec.categories.flatMap((_, at) => (spec.series.some(entry => entry.points[at]?.emphasis) ? [at] : []));
	return new Set([...highlighted(spec), ...(bold.length * 2 <= spec.categories.length ? bold : [])]);
}

/** Callout text per category from {@link ChartSpec.annotations} (the first per category wins). */
function calloutTexts(spec: ChartSpec): Map<number, string> {
	const texts = new Map<number, string>();
	for (const mark of spec.annotations ?? [])
		if (
			mark.kind === "callout" &&
			mark.category >= 0 &&
			mark.category < spec.categories.length &&
			!texts.has(mark.category)
		)
			texts.set(mark.category, clip(mark.text, MAX_CALLOUT_CHARS));
	return texts;
}

// ── Values against their targets ─────────────────────────────────────────────

/** Furthest past its target a bullet axis reaches (2 = twice it); a value beyond runs off the axis' end, the break marked. */
const TARGET_REACH = 2;
/** Least reach of a bullet axis (in targets) where a value runs off it, so the overrun shows past the target. */
const OVERRUN_ROOM = 1.25;
/** Opacity of a bullet row's track from zero to its target, over the border color. */
const TRACK_OPACITY = 0.3;

/**
 * Each category's measured value against its own target ({@link ChartSpec.targets}): a bar from zero (a
 * `p50 / p99` spread faint past its low end) over a faint track up to the target, the target a dashed rule
 * labelled with what it is (`budget`); a window target (`60–100 ms`) a faint band. The bar is `success`
 * where it keeps the target's side ({@link targetStanding}), `warning` where only just, `error` where it
 * misses, the lead color where the target has no side. Rows held to different targets share one axis as
 * shares of them (each target at 100%), each row's share leading its figures; rows held to one target share
 * an axis in their unit, the rule at it. A value past {@link TARGET_REACH} times its target (or over a zero
 * target) runs off the axis' end, the break marked.
 */
function drawBullet(spec: ChartSpec): Layer {
	const { categories } = spec;
	const entry = spec.series[0]!;
	const targets = spec.targets ?? [];
	const word = spec.targetName ?? "target";
	const known = targets.filter((target): target is ChartTarget => target !== null);
	const first = known[0];
	const shared =
		first !== undefined &&
		known.every(target => target.value === first.value && target.upper === first.upper && target.text === first.text);
	const goal = shared ? (first.upper ?? first.value) : 100;
	const reach = goal * TARGET_REACH;
	// Positions: in the unit when every row shares one target, else as a percent of each row's own.
	const position = (at: number, value: number) => {
		const target = targets[at];
		if (!target || shared) return value;
		const scale = target.upper ?? target.value;
		return scale > 0 ? (100 * value) / scale : value > 0 ? Number.POSITIVE_INFINITY : 0;
	};
	const standings = categories.map((_, at) => {
		const point = entry.points[at];
		const target = targets[at];
		return point && target ? targetStanding(point, target) : undefined;
	});
	const tone = (at: number) => {
		const standing = standings[at];
		return !standing ? SERIES[0] : !standing.met ? "error" : standing.close ? "warning" : "success";
	};
	// Each row's share of its target; over a zero target only whether it met it.
	const shareText = (at: number) => {
		const standing = standings[at];
		if (shared || !standing) return "";
		const { share } = standing;
		if (share === undefined) return standing.met ? "met" : "over";
		if (share >= TARGET_REACH) return `${compactFactor(share)}×`;
		return share < 0.01 ? percentText(share * 100) : `${Math.round(share * 100)}%`;
	};
	const figure = (at: number) => {
		const own = pointText(entry, at);
		const target = targets[at];
		return shared || !target ? own : `${own}  ${target.text}`;
	};
	const shareWidth = Math.max(0, ...categories.map((_, at) => measure(shareText(at), TICK_SIZE) * SEMIBOLD_WIDTH));
	const figureWidth = Math.min(220, Math.max(0, ...categories.map((_, at) => measure(figure(at), TICK_SIZE))));
	const left = PAD + labelColumnWidth(spec) + 10;
	const right = WIDTH - PAD - figureWidth - 10 - (shareWidth ? shareWidth + 8 : 0);
	const ends = categories.flatMap((_, at) => {
		const point = entry.points[at];
		if (!point || !targets[at]) return [];
		return [point.value, point.upper ?? point.value].map(value => position(at, value));
	});
	// Values off the axis need only a stretch past the target to run off; the axis spans the rest.
	const within = ends.filter(value => value <= reach);
	const room = ends.length > within.length ? [goal * OVERRUN_ROOM] : [];
	const extent = [0, goal, ...within, ...room];
	const scale = valueScale(extent, left, right, { zero: true, unit: shared ? tickUnit(entry, extent) : 1 });
	const last = Math.min(reach, scale.ticks.at(-1) ?? reach);
	const end = scale.at(last);
	const x = (at: number, value: number) => scale.at(Math.min(position(at, value), last));
	const metrics = barMetrics(categories.length, 1);
	const rowHeight = labelRow(spec, metrics.row);
	const { bar } = metrics;
	const estimates = estimatedPoints(entry);
	const top = 16;
	const tops = rowTops(spec, top, rowHeight);
	const bottom = tops.at(-1)!;
	const strong = strongCategories(spec);
	const parts: string[] = [];
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, shared ? entry : { ...entry, dim: "percent", unit: "" }, top, bottom));
	parts.push(categoryLabels(spec, tops, rowHeight, strong));
	const rule = shared ? `${first.text} ${word}` : word;
	parts.push(referenceLines([{ kind: "reference", value: goal, label: rule }], scale, left, right, top, bottom));
	const emphasized = entry.points.some(point => point?.emphasis);
	categories.forEach((_, at) => {
		const middle = tops[at]! + rowHeight / 2;
		const y = middle - bar / 2;
		const point = entry.points[at];
		const target = targets[at];
		if (!point || !target) {
			const note = entry.notes[at];
			if (note) parts.push(noteText(left + 4, middle, clip(note, 40)));
			return;
		}
		const zero = scale.at(0);
		const scaleOf = target.upper ?? target.value;
		parts.push(rect(zero, y, x(at, scaleOf) - zero, bar, "border", TRACK_OPACITY));
		if (target.upper !== undefined)
			parts.push(
				rect(x(at, target.value), y - 2, x(at, target.upper) - x(at, target.value), bar + 4, "success", 0.18),
			);
		const fill = tone(at);
		const opacity = emphasized && !point.emphasis ? RECEDE : 1;
		const low = x(at, point.value);
		const high = x(at, point.upper ?? point.value);
		parts.push(barRect(zero, y, Math.max(MIN_BAR, low - zero), bar, fill, opacity, { estimate: estimates.has(at) }));
		if (high > low) parts.push(rect(low, y, high - low, bar, fill, RANGE_OPACITY * opacity));
		// Past the axis' end: the bar runs off it, the break marked where it leaves.
		if (position(at, point.upper ?? point.value) > last) parts.push(breakMark(end - 6, middle, bar / 2 + 2, "fg"));
		const own = pointText(entry, at);
		// One target: the figure follows its bar as on any bar chart, clear of the target's rule.
		const ruleX = scale.at(goal);
		const after = Math.max(high, low) + (position(at, point.upper ?? point.value) > last ? 10 : 6);
		let textX = !shared
			? right + 10
			: after <= ruleX + 2 && after + measure(own, TICK_SIZE) >= ruleX - 2
				? ruleX + 6
				: after;
		const share = shareText(at);
		if (shareWidth) {
			parts.push(
				text(textX + shareWidth, middle, share, {
					size: TICK_SIZE,
					fill: fill === SERIES[0] ? "fg" : fill,
					weight: 600,
					anchor: "end",
				}),
			);
			textX += shareWidth + 8;
		}
		// The figure, then (each row held to its own) its target, muted: one line of runs.
		const runs: TextRun[] = [
			{
				content: own,
				fill: point.emphasis || !standings[at]?.met ? "fg" : undefined,
				weight: point.emphasis ? 600 : undefined,
			},
		];
		if (!shared) runs.push({ content: `\u2002${clip(target.text, 18)}` });
		parts.push(text(textX, middle, runs, { size: TICK_SIZE, fill: "muted" }));
	});
	const shown = new Set<string>(categories.map((_, at) => tone(at)));
	const legend: LegendItem[] = [
		{ name: `within ${word}`, color: "success" },
		{ name: "within 10%", color: "warning" },
		{ name: `misses ${word}`, color: "error" },
	].filter(item => shown.has(item.color));
	// A spread's two ends (`p50 / p99`), named under the figures they explain.
	const spread = entry.name.split(/\s*\/\s*/);
	if (spread.length === 2 && entry.points.some(point => point?.upper !== undefined))
		parts.push(
			text(WIDTH - PAD, bottom + 12, clip(`bar to ${spread[0]}, faint to ${spread[1]}`, 40), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "end",
			}),
		);
	return { height: bottom + 20, body: parts.join(""), legend: legend.length > 1 ? legend : [] };
}

// ── Runs of steps: waterfall and timeline ────────────────────────────────────

/**
 * Each step a floating bar from the running sum before it to the one after
 * it, a hairline carrying each end down to the next step, and the total the
 * steps reach ({@link ChartSpec.total}) as a full bar under them. A cap (a
 * `reference` annotation) draws as a dashed rule, the total's row showing
 * what it leaves to spare as a faint `success` span up to the rule (or the
 * overrun past it in `error`), named beside the total's figure, or past the
 * rule where the span cannot hold it. Steps take the lead color; a
 * falling step takes the tone a drop has for its measure (else the second
 * series color). A run of rising steps prints each one's share of the total.
 */
function drawWaterfall(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const { categories } = spec;
	const steps = categories.map((_, at) => entry.points[at]?.value ?? 0);
	let run = 0;
	const ends = steps.map(value => (run += value));
	const starts = ends.map((end, at) => end - steps[at]!);
	const total = spec.total ?? {
		name: "Total",
		point: { value: ends.at(-1) ?? 0, text: "", emphasis: false },
	};
	const references = (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "reference" }> => mark.kind === "reference",
	);
	const cap = references[0];
	const format = (value: number) => formatValue(value, entry.dim, entry.unit);
	const totalText = total.point.text || format(total.point.value);
	const spare = cap ? cap.value - total.point.value : 0;
	const spareText = cap ? `${format(Math.abs(spare))} ${spare >= 0 ? "to spare" : "over"}` : "";
	// Shares of a sum only read when every step adds to it.
	const rising = steps.every(value => value >= 0) && total.point.value > 0;
	const share = (at: number) => {
		if (!rising) return "";
		const percent = (100 * steps[at]!) / total.point.value;
		return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
	};
	const view: ChartSpec = {
		...spec,
		categories: [...categories, total.name],
		groups: spec.groups && [...spec.groups, { name: "", members: [total.name] }],
		status: spec.status && [...spec.status, undefined],
	};
	const figureWidth = (at: number) => {
		const shared = share(at);
		return measure(pointText(entry, at), TICK_SIZE) + (shared ? measure(` · ${shared}`, TICK_SIZE) : 0);
	};
	const valueWidth = Math.min(
		200,
		Math.max(
			...categories.map((_, at) => figureWidth(at)),
			measure(totalText, TICK_SIZE) * SEMIBOLD_WIDTH + (spareText ? measure(` · ${spareText}`, TICK_SIZE) : 0),
		) + 8,
	);
	const left = PAD + labelColumnWidth(view) + 10;
	const right = WIDTH - PAD - valueWidth;
	const scale = valueScale(
		[0, ...starts, ...ends, total.point.value, ...references.map(mark => mark.value)],
		left,
		right,
		{ zero: true },
	);
	const count = categories.length + 1;
	const { row, bar: barHeight } = barMetrics(count, 1);
	const rowHeight = labelRow(view, row);
	const top = references.length ? 16 : 0;
	const tops = rowTops(view, top, rowHeight);
	const bottom = tops.at(-1)!;
	const barTop = (at: number) => tops[at]! + (rowHeight - barHeight) / 2;
	const strong = strongCategories(spec);
	strong.add(categories.length);
	const parts: string[] = [];
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(drawValueAxis(scale, entry, top, bottom));
	parts.push(categoryLabels(view, tops, rowHeight, strong));
	for (const mark of references) {
		const x = scale.at(mark.value);
		parts.push(referenceRule(x, top - 2, x, bottom));
		const label = clip(mark.label, MAX_CALLOUT_CHARS);
		const half = measure(label, 10) / 2;
		parts.push(
			text(Math.min(Math.max(x, left + half), WIDTH - PAD - half), top - 9, label, {
				size: 10,
				fill: "fg",
				anchor: "middle",
			}),
		);
	}
	const emphasized = entry.points.some(point => point?.emphasis);
	const fall = moveTone(entry.polarity, 0.5) ?? SERIES[1];
	categories.forEach((_, at) => {
		const point = entry.points[at];
		const y = barTop(at);
		const [from, to] = [scale.at(Math.min(starts[at]!, ends[at]!)), scale.at(Math.max(starts[at]!, ends[at]!))];
		const context = emphasized && !point?.emphasis;
		parts.push(
			rect(
				from,
				y,
				Math.max(1, to - from),
				barHeight,
				context ? "muted" : steps[at]! < 0 ? fall : SERIES[0],
				context ? 0.55 : 1,
			),
		);
		// The running sum carries down to where the next step (or the total) starts.
		const x = scale.at(ends[at]!);
		parts.push(connector(x, y + barHeight, barTop(at + 1)));
		const figure = pointText(entry, at);
		const style = {
			size: TICK_SIZE,
			fill: point?.emphasis ? "fg" : "muted",
			weight: point?.emphasis ? 600 : undefined,
		};
		parts.push(text(to + 6, y + barHeight / 2, figure, style));
		const shared = share(at);
		if (shared)
			parts.push(
				text(
					to + 6 + measure(figure, TICK_SIZE) * (point?.emphasis ? SEMIBOLD_WIDTH : 1) + 4,
					y + barHeight / 2,
					`· ${shared}`,
					{ size: TICK_SIZE, fill: "muted" },
				),
			);
	});
	const y = barTop(categories.length);
	const zero = scale.at(0);
	const end = scale.at(total.point.value);
	parts.push(rect(Math.min(zero, end), y, Math.max(1, Math.abs(end - zero)), barHeight, "muted", 1));
	// The headroom left under the cap, or the overrun past it, as a span of the total's row.
	const capX = cap ? scale.at(cap.value) : end;
	if (cap && spare > 0) parts.push(rect(end, y, capX - end, barHeight, "success", 0.18));
	if (cap && spare < 0) parts.push(rect(capX, y, end - capX, barHeight, "error", 0.85));
	const figureX = Math.max(zero, end) + 6;
	parts.push(text(figureX, y + barHeight / 2, totalText, { size: TICK_SIZE, fill: "fg", weight: 600 }));
	if (spareText) {
		const after = figureX + measure(totalText, TICK_SIZE) * SEMIBOLD_WIDTH + 6;
		// Inside the headroom span when it holds the words; else clear of the cap's rule.
		const inside = spare > 0 && after + measure(spareText, TICK_SIZE) <= capX - 4;
		parts.push(
			text(inside || spare < 0 ? after : capX + 6, y + barHeight / 2, spareText, {
				size: TICK_SIZE,
				fill: spare >= 0 ? "success" : "error",
				weight: 600,
			}),
		);
	}
	return { height: bottom + 20, body: parts.join("") };
}

/** A dotted hairline down from a waterfall step's end at `x`, from `y1` to `y2`. */
function connector(x: number, y1: number, y2: number): string {
	if (y2 <= y1) return "";
	return `<line x1="${num(x)}" y1="${num(y1)}" x2="${num(x)}" y2="${num(y2)}" stroke="${token("muted")}" stroke-width="1" stroke-dasharray="2 2" stroke-opacity="0.8"/>`;
}

/** Height of a timeline's strip. */
const STRIP = 30;
/** Most label lanes under a timeline's strip. */
const MAX_LANES = 4;
/** Height of one label lane under a timeline's strip. */
const LANE = 16;
/** Share of a timeline's run from which a segment (or group) leads in the accent color, unless the table bolded some. */
const LEADING_SEGMENT = 0.15;
/** Most segments (or groups) a timeline leads with. */
const MAX_LEADING = 3;
/** Share of a timeline's run from which a stretch's label claims a lane before the smaller ones. */
const LABEL_FIRST = 0.05;

/** A labelled stretch of a timeline: one row, or a group of consecutive rows sharing a name. */
interface Stretch {
	readonly first: number;
	readonly last: number;
	readonly name: string;
	readonly value: number;
	readonly figure: string;
	readonly group: boolean;
}

/**
 * Rows laid end to end on one axis — each at its start ({@link ChartSpec.x})
 * or after the one before — as touching segments of one strip, to scale, with
 * the run's end figure after it and the axis over it. The few stretches
 * (rows, or groups of rows sharing a name) making up most of the run, or
 * those the table bolded, lead in the accent color with their share; the rest
 * recede in alternating grays. A stretch is named inside its segment where
 * the name fits, else in a lane under the strip on a leader (groups on a
 * bracket spanning their rows); members of a group are named inside their
 * segments where they fit.
 */
function drawTimeline(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const { categories } = spec;
	const sizes = categories.map((_, at) => Math.max(0, entry.points[at]?.value ?? 0));
	let run = 0;
	const starts =
		spec.x?.values ??
		sizes.map(size => {
			run += size;
			return run - size;
		});
	const ends = starts.map((start, at) => start + sizes[at]!);
	const from = Math.min(0, ...starts);
	const to = Math.max(...ends);
	const span = to - from || 1;
	const duration = entry.dim === "duration";
	const format = (value: number) => (duration ? clockText(value) : formatValue(value, entry.dim, entry.unit));
	// Parts at their offsets end where the last one does; a run of steps at its total.
	const endText = spec.x ? format(to) : spec.total?.point.text || format(spec.total?.point.value ?? to);
	const left = PAD;
	const right = WIDTH - PAD - measure(endText, TICK_SIZE) * SEMIBOLD_WIDTH - 8;
	const at = (value: number) => left + ((value - from) / span) * (right - left);

	// Stretches: named groups as one, loose rows on their own.
	const stretches: Stretch[] = [];
	let row = 0;
	for (const group of spec.groups ?? [{ name: "", members: categories }]) {
		const first = row;
		row += group.members.length;
		if (group.name && group.members.length > 1) {
			const value = sizes.slice(first, row).reduce((sum, size) => sum + size, 0);
			stretches.push({ first, last: row - 1, name: group.name, value, figure: format(value), group: true });
		} else
			for (let index = first; index < row; index++)
				stretches.push({
					first: index,
					last: index,
					name: categories[index]!,
					value: sizes[index]!,
					figure: pointText(entry, index),
					group: false,
				});
	}
	const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
	const share = (stretch: Stretch) => {
		const percent = (100 * stretch.value) / total;
		return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
	};
	const strong = strongCategories(spec);
	const marked = stretches.filter(stretch =>
		[...strong].some(index => index >= stretch.first && index <= stretch.last),
	);
	const leading = new Set(
		marked.length
			? marked
			: [...stretches]
					.sort((a, b) => b.value - a.value)
					.slice(0, MAX_LEADING)
					.filter(stretch => stretch.value / total >= LEADING_SEGMENT),
	);

	const parts: string[] = [];
	const stripTop = 18;
	const stripBottom = stripTop + STRIP;
	const middle = stripTop + STRIP / 2;
	// Axis over the strip: tick labels and short ticks, the strip itself the baseline.
	const unit = duration ? (to >= 7200 ? 3600 : to >= 120 ? 60 : 1) : 1;
	const step = niceStep(span / unit / 5) * unit;
	for (let tick = Math.ceil(from / step) * step; tick <= to + 1e-9; tick += step) {
		const x = at(tick);
		const label = formatValue(Number(tick.toPrecision(12)), entry.dim, entry.unit, to);
		parts.push(rule(x, 12, x, stripTop - 2));
		// The first tick sits at the margin: its label starts there rather than hanging off the canvas.
		const edge = x - measure(label, TICK_SIZE) / 2 < 2;
		parts.push(
			text(edge ? x - 1 : x, 5, label, { size: TICK_SIZE, fill: "muted", anchor: edge ? "start" : "middle" }),
		);
	}
	// Segments: leading stretches in the lead color, the rest alternating grays — or, where none leads (an
	// even run), every stretch in alternating strengths of the lead color; a sliver parts neighbours.
	const even = leading.size === 0;
	const fill = (stretch: Stretch): [color: string, opacity: number] => {
		const odd = stretches.indexOf(stretch) % 2 === 1;
		if (leading.has(stretch)) return [SERIES[0], 1];
		return even ? [SERIES[0], odd ? 0.7 : 1] : ["muted", odd ? 0.3 : 0.5];
	};
	for (const stretch of stretches) {
		for (let member = stretch.first; member <= stretch.last; member++) {
			const x0 = at(starts[member]!);
			const width = Math.max(1, at(ends[member]!) - x0 - (sizes[member]! > 0 ? 1 : 0));
			parts.push(rect(x0, stripTop, width, STRIP, ...fill(stretch), 2));
		}
	}
	parts.push(text(at(to) + 8, middle, endText, { size: TICK_SIZE, fill: "fg", weight: 600 }));

	// Names inside their segments where they fit (with the figure and share, or less); the rest go to lanes.
	const fit = (x0: number, x1: number, options: readonly string[], lead: boolean, size: number) =>
		options.find(option => measure(option, size) * (lead ? SEMIBOLD_WIDTH : 1) <= x1 - x0 - 10);
	const inside = (x0: number, content: string, lead: boolean, size: number) => {
		const style = { size, fill: "fg", weight: lead ? 600 : undefined } as const;
		parts.push(lead || even ? ink(x0 + 5, middle, content, style) : text(x0 + 5, middle, content, style));
	};
	const pending: Stretch[] = [];
	for (const stretch of stretches) {
		const lead = leading.has(stretch);
		const [x0, x1] = [at(starts[stretch.first]!), at(ends[stretch.last]!)];
		const named = `${stretch.name} ${stretch.figure}`;
		const options = lead ? [`${named} · ${share(stretch)}`, named, stretch.name] : [named, stretch.name];
		const size = lead ? TICK_SIZE + 1 : TICK_SIZE;
		if (stretch.group) {
			const members: [number, string][] = [];
			for (let member = stretch.first; member <= stretch.last; member++) {
				const name = fit(at(starts[member]!), at(ends[member]!), [memberName(spec, member)], lead, 10);
				if (name) members.push([member, name]);
			}
			// A group naming at most one member inside is better named itself, where its name fits.
			const own = members.length <= 1 ? fit(x0, x1, options, lead, size) : undefined;
			if (own) {
				// The slivers between its members close behind the group's name.
				for (let member = stretch.first; member < stretch.last; member++)
					parts.push(rect(at(ends[member]!) - 1, middle - 8, 1, 16, ...fill(stretch), 0));
				inside(x0, own, lead, size);
			} else {
				for (const [member, name] of members) inside(at(starts[member]!), name, lead, 10);
				pending.push(stretch);
			}
			continue;
		}
		const own = fit(x0, x1, options, lead, size);
		if (own) inside(x0, own, lead, size);
		else pending.push(stretch);
	}

	// Groups span a bracket under their rows, whether or not their name finds a lane.
	for (const stretch of stretches.filter(stretch => stretch.group)) {
		const [x0, x1] = [at(starts[stretch.first]!), at(ends[stretch.last]!)];
		parts.push(
			line(x0 + 1, stripBottom + 4, x1 - 1, stripBottom + 4, leading.has(stretch) ? SERIES[0] : "muted", 1.5),
		);
	}
	const labels = placeLanes(
		pending.map(stretch => {
			const lead = leading.has(stretch);
			const [x0, x1] = [at(starts[stretch.first]!), at(ends[stretch.last]!)];
			return {
				leader: stretch.group ? (x0 + x1) / 2 : Math.max(x0 + 1, Math.min((x0 + x1) / 2, x0 + 6)),
				lead,
				value: stretch.value,
				group: stretch.group,
				variants: [
					[stretch.name, lead ? `${stretch.figure} · ${share(stretch)}` : stretch.figure],
					[stretch.name, ""],
					[clip(stretch.name, 12), ""],
				],
			};
		}),
		total,
	);
	let lanes = 0;
	for (const { item, lane, x0, name, figure } of labels) {
		lanes = Math.max(lanes, lane + 1);
		const y = stripBottom + LANE * (lane + 1);
		parts.push(line(item.leader, stripBottom + (item.group ? 5 : 1), item.leader, y - 6, "muted", 1, 0.7));
		parts.push(text(x0, y, name, { size: TICK_SIZE, fill: "fg", weight: item.lead ? 600 : undefined }));
		if (figure)
			parts.push(
				text(x0 + measure(name, TICK_SIZE) * (item.lead ? SEMIBOLD_WIDTH : 1) + 6, y, figure, {
					size: TICK_SIZE,
					fill: "muted",
				}),
			);
	}
	const notes = spec.x ? [`at ${spec.x.name}`] : ["end to end, in table order"];
	return { height: stripBottom + LANE * lanes + (lanes ? 8 : 4), body: parts.join(""), notes };
}

/** A label waiting for a lane under a timeline: where its leader drops, and its texts from fullest to shortest. */
interface LaneItem {
	readonly leader: number;
	readonly lead: boolean;
	readonly value: number;
	readonly group: boolean;
	readonly variants: readonly (readonly [name: string, figure: string])[];
}

/** A {@link LaneItem} placed: its lane, its box, and the text variant that fit. */
interface LaneLabel {
	readonly item: LaneItem;
	readonly lane: number;
	readonly x0: number;
	readonly x1: number;
	readonly name: string;
	readonly figure: string;
}

/**
 * Lanes for `items` of a run of `total`: each, in turn, in the shallowest of {@link MAX_LANES}
 * lanes where its box (reaching right of its leader, else left) overlaps no
 * label and its leader crosses no label above, nor its box a leader below —
 * with its fullest text that fits. Placement is greedy, so several orders are
 * tried (right to left, which stacks a dense run like stairs; leading and
 * {@link LABEL_FIRST}-sized ones first; left to right; largest first) and the
 * one naming the most items, then the most of the run, wins.
 */
function placeLanes(items: readonly LaneItem[], total: number): LaneLabel[] {
	const first = new Set(items.filter(item => item.lead || item.value / total >= LABEL_FIRST));
	const orders = [
		[...items].sort((a, b) => b.leader - a.leader),
		[...items].sort((a, b) => Number(first.has(b)) - Number(first.has(a)) || b.leader - a.leader),
		[...items].sort((a, b) => a.leader - b.leader),
		[...items].sort((a, b) => b.value - a.value),
	];
	let best: LaneLabel[] = [];
	let bestScore = [-1, -1, -1];
	// Each order with full labels or the small items named without their figure, and with labels on the
	// right half reaching right of their leader first or left of it first.
	const attempts = orders.flatMap(order =>
		[false, true].flatMap(terse => [false, true].map(inward => ({ order, terse, inward }))),
	);
	for (const { order, terse, inward } of attempts) {
		const placed: LaneLabel[] = [];
		for (const item of order) {
			const variants = terse && !first.has(item) ? item.variants.filter(([, figure]) => !figure) : item.variants;
			for (const [name, figure] of variants) {
				const width =
					measure(name, TICK_SIZE) * (item.lead ? SEMIBOLD_WIDTH : 1) +
					(figure ? 6 + measure(figure, TICK_SIZE) : 0);
				// Right of the leader (from the margin at the left edge), else left of it.
				const anchors = [Math.max(PAD, item.leader - 2), item.leader + 2 - width].filter(
					start => start >= PAD && start + width <= WIDTH - PAD,
				);
				if (inward && item.leader > WIDTH / 2) anchors.reverse();
				let label: LaneLabel | undefined;
				for (let lane = 0; lane < MAX_LANES && !label; lane++) {
					const x0 = anchors.find(start =>
						placed.every(other =>
							other.lane === lane
								? start + width + 8 < other.x0 || start - 8 > other.x1
								: other.lane < lane
									? item.leader < other.x0 - 3 || item.leader > other.x1 + 3
									: other.item.leader < start - 3 || other.item.leader > start + width + 3,
						),
					);
					if (x0 !== undefined) label = { item, lane, x0, x1: x0 + width, name, figure };
				}
				if (label) {
					placed.push(label);
					break;
				}
			}
		}
		const score = [
			placed.length,
			placed.reduce((sum, label) => sum + label.item.value, 0),
			placed.filter(label => label.figure).length,
		];
		const at = score.findIndex((value, index) => value !== bestScore[index]);
		if (at >= 0 && score[at]! > bestScore[at]!) {
			best = placed;
			bestScore = score;
		}
	}
	return best;
}

/** A grouped category's own name: its member name, or the group's where the group alone names it. */
function memberName(spec: ChartSpec, at: number): string {
	let first = 0;
	for (const group of spec.groups ?? []) {
		if (at < first + group.members.length) return group.members[at - first] || group.name;
		first += group.members.length;
	}
	return spec.categories[at] ?? "";
}

/** A duration as people say it: `48s`, `6m 36s`, `2h 5m`. */
function clockText(seconds: number): string {
	if (seconds < 120) return formatValue(seconds, "duration", "");
	const whole = Math.round(seconds);
	const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
	if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

// ── Grids: heatmap and small multiples ──────────────────────────────────────

/**
 * A matrix of rows by series. `heat`: tinted cells on one sequential ramp of
 * the lead color (each column on its own ramp, in its own color, when shaded
 * per series), faint for the least and opaque for the most; strong cells
 * print their figure in {@link ink}, zeros recede to muted. `bars`: one
 * column of bars per series, each scaled on its own.
 */
function drawGrid(spec: ChartSpec, style: "heat" | "bars"): Layer {
	const { series } = spec;
	const heat = style === "heat";
	const labelWidth = labelColumnWidth(spec);
	const left = PAD + labelWidth + 10;
	const cellWidth = (WIDTH - PAD - left) / series.length;
	const count = spec.categories.length;
	const rowHeight = labelRow(spec, heat ? (count <= 8 ? 26 : count <= 16 ? 22 : 20) : count <= 8 ? 24 : 20);
	const headerChars = Math.max(4, Math.floor((cellWidth - 6) / (TICK_SIZE * ADVANCE)));
	const perSeries = spec.shading === "series";
	const parts: string[] = [];
	const headers = series.map(entry => wrapHeader(entry.name, cellWidth - 6, TICK_SIZE * SEMIBOLD_WIDTH));
	const headerLines = Math.max(...headers.map(lines => lines.length));
	series.forEach((entry, index) => {
		const x = left + index * cellWidth;
		headers[index]!.forEach((content, line) => {
			// A one-line header sits on the line nearest the cells.
			const y = 6 + (headerLines - headers[index]!.length + line) * 13;
			parts.push(
				heat
					? text(x + cellWidth / 2, y, content, {
							size: TICK_SIZE,
							fill: perSeries ? "fg" : "muted",
							anchor: "middle",
							weight: perSeries ? 600 : undefined,
						})
					: text(x + 2, y, content, { size: TICK_SIZE, fill: "fg", weight: 600 }),
			);
		});
	});
	const top = 18 + (headerLines - 1) * 13;
	const tops = rowTops(spec, top, rowHeight);
	const bottom = tops.at(-1)!;
	// Heatmaps share one scale unless shaded per series or per row; small multiples scale each series on its own.
	const all = series.flatMap(entry => entry.points.flatMap(point => (point ? [point.value] : [])));
	const shared = shade(all);
	const perRow = heat && spec.shading === "row";
	const byRow = spec.categories.map((_, row) =>
		shade(series.flatMap(entry => (entry.points[row] ? [entry.points[row]!.value] : []))),
	);
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	// Whether any column printed factors of a reference row, which the header then names.
	let factorNoted = false;
	series.forEach((entry, index) => {
		const x = left + index * cellWidth;
		const values = entry.points.flatMap(point => (point ? [point.value] : []));
		const own = shade(values);
		// Bars reach their stated spread (`32 ± 7`) too.
		const reach = entry.points.flatMap(point => (point ? [point.value + (point.error ?? 0)] : []));
		// Bars beside reference rows print their factor of their group's reference (`36.3k  2.2×`), toned by the
		// measure's polarity: the comparison a table of arms against a baseline is about ({@link referenceText}).
		const allFactors = heat ? [] : referenceFactors(spec, entry);
		const ratios = allFactors.some(factor => factor !== undefined && (factor >= 2 || factor <= 0.5));
		// Room past each bar for its row's own figure, factor and `best` tag (the widest row, not the widest of
		// each), and a clear gap before the next column's rule. What would squeeze the bars under
		// {@link MIN_BAR_SHARE} of the column goes: first the tag (its figure stays semibold), then the factors.
		const need = (best: boolean, factored: boolean) =>
			Math.max(
				0,
				...entry.points.map((point, row) => {
					const factor = allFactors[row];
					return (
						measure(point?.text ?? "", TICK_SIZE) * SEMIBOLD_WIDTH +
						(factored && factor !== undefined ? measure(referenceText(factor, ratios), TICK_SIZE - 1) + 6 : 0) +
						(best && (entry.best === row || spec.leaders?.[row] === index) ? BEST_WIDTH : 0)
					);
				}),
			) + 18;
		const fits = (best: boolean, factored: boolean) => cellWidth - need(best, factored) >= MIN_BAR_SHARE * cellWidth;
		const factored = fits(false, true);
		const tagged = fits(true, factored);
		const factors = factored ? allFactors : [];
		const factorTexts = factors.map(factor => (factor === undefined ? "" : referenceText(factor, ratios)));
		if (factorTexts.some(Boolean)) factorNoted = true;
		const barSpace = Math.max(MIN_BAR_SHARE * cellWidth, cellWidth - need(tagged, factored));
		const bars = panelScale(heat ? values : reach, x + 2, x + 2 + barSpace);
		const reference = heat ? undefined : referenceRules(spec, entry, tops, rowHeight, bars.at);
		const emphasized = entry.points.some(point => point?.emphasis);
		// Columns are told apart by their headings: one hue for all, so color stays free for emphasis.
		const color = SERIES[0];
		const estimated = estimatedPoints(entry);
		entry.points.forEach((point, row) => {
			const y = tops[row]!;
			const middle = y + rowHeight / 2;
			if (!point) {
				const note = entry.notes[row];
				if (note) parts.push(noteText(heat ? x + cellWidth / 2 : x + 4, middle, clip(note, headerChars), heat));
				return;
			}
			const best = entry.best === row || spec.leaders?.[row] === index;
			if (heat) {
				const level = perSeries ? own(point.value) : perRow ? byRow[row]!(point.value) : shared(point.value);
				parts.push(
					rect(x + 1.5, y + 1.5, cellWidth - 3, rowHeight - 3, color, HEAT_FLOOR + (1 - HEAT_FLOOR) * level, 4),
				);
				// The best cell of a column is outlined in the success color.
				if (best) parts.push(outline(x + 1.5, y + 1.5, cellWidth - 3, rowHeight - 3, "success"));
				const style = {
					size: TICK_SIZE,
					fill: point.value === 0 ? "muted" : "fg",
					anchor: "middle",
					weight: point.emphasis || best || level >= INK_LEVEL ? 600 : undefined,
				} as const;
				const label = clip(point.text, headerChars);
				parts.push(
					level >= INK_LEVEL
						? ink(x + cellWidth / 2, middle, label, style)
						: text(x + cellWidth / 2, middle, label, style),
				);
				return;
			}
			const end = Math.max(x + 2 + MIN_BAR, bars.at(point.value));
			const thick = Math.min(14, rowHeight - 10);
			// Rows beside the bolded ones recede to gray, as a lone series' context bars do.
			const context = emphasized && !point.emphasis;
			parts.push(
				bars.cut && point.value > bars.cut.below
					? cutBar(bars.cut, x + 2, end, middle - thick / 2, thick, context ? "muted" : color, context ? 0.55 : 1)
					: barRect(x + 2, middle - thick / 2, end - x - 2, thick, context ? "muted" : color, context ? 0.55 : 1, {
							estimate: estimated.has(row),
						}),
			);
			const spread = point.error && !bars.cut ? whisker(bars, point, middle, thick / 2 - 1) : "";
			parts.push(spread);
			// A figure clears its group's reference rule and the spread's whisker.
			const figureX =
				Math.max(end, reference?.at[row] ?? end, spread ? bars.at(point.value + point.error!) : end) + 4;
			parts.push(
				text(figureX, middle, point.text, {
					size: TICK_SIZE,
					fill: point.emphasis || best ? "fg" : "muted",
					weight: point.emphasis || best ? 600 : undefined,
				}),
			);
			let after = figureX + measure(point.text, TICK_SIZE) * (point.emphasis || best ? SEMIBOLD_WIDTH : 1) + 5;
			if (factorTexts[row]) {
				const tone = moveTone(entry.polarity, factors[row]!) ?? "muted";
				parts.push(text(after, middle, factorTexts[row]!, { size: TICK_SIZE - 1, fill: tone }));
				after += measure(factorTexts[row]!, TICK_SIZE - 1) + 6;
			}
			if (best && tagged) parts.push(bestTag(after, middle, TICK_SIZE));
		});
		if (reference) parts.push(reference.body);
	});
	if (!heat) {
		for (let index = 1; index < series.length; index++) {
			const x = left + index * cellWidth - 3;
			parts.push(rule(x, top, x, bottom));
		}
		// Factors name what they are factors of, where every group compares with a row of one name (`vs bash`).
		const bases = new Set((spec.reference ?? []).map(at => clip(memberName(spec, at), 24)));
		const versus = factorNoted && bases.size === 1 ? [`vs ${[...bases][0]}`] : [];
		return { height: bottom + 4, body: parts.join(""), notes: ["scaled per column", ...versus] };
	}
	const logShade = logShaded(all);
	const outlined =
		series.some(entry => entry.best !== undefined) || (spec.leaders ?? []).some(lead => lead !== undefined);
	const notes = [
		...(perSeries ? ["shaded per column"] : perRow ? ["shaded per row"] : logShade ? ["log shading"] : []),
		// The outline is the only mark of a column's best: the note keys it.
		...(outlined ? ["best outlined"] : []),
	];
	// The faintest swatch stands for where the shading starts: zero, the least positive value on a log ramp, or the least.
	const least = Math.min(...all);
	const ramp =
		perSeries || perRow || all.length === 0
			? undefined
			: {
					color: SERIES[0],
					low: formatValue(
						logShade ? Math.min(...all.filter(value => value > 0)) : Math.min(least, heatFloor(all)),
						series[0]!.dim,
						series[0]!.unit,
					),
					high: formatValue(Math.max(...all), series[0]!.dim, series[0]!.unit),
				};
	return { height: bottom + 4, body: parts.join(""), notes, ramp };
}

/**
 * A column heading in one line of `width` at `size` (an em scale; pass the
 * semibold width for bold text), or two split where they balance
 * ({@link wrapLabel}: `Strict Recall` → `Strict`, `Recall`;
 * `gtTagRelevance` → `gtTag`, `Relevance`) when one would clip it.
 */
function wrapHeader(name: string, width: number, size: number): string[] {
	return measure(name, size) <= width ? [name] : wrapLabel(name, width, size);
}

/**
 * Small multiples as bands of panels, one per series, each scaling its own
 * bars; the few categories are told apart by color through a legend. Fits a
 * table whose rows are metrics: each metric gets a panel comparing the columns.
 */
function drawPanels(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const parts: string[] = [];
	const bands = Math.ceil(series.length / PANELS_ACROSS);
	const across = Math.ceil(series.length / bands);
	const gap = 18;
	const panelWidth = (WIDTH - 2 * PAD - gap * (across - 1)) / across;
	const panelHeight = 20 + categories.length * 14 + 14;
	const top = 0;
	const titleChars = Math.floor(panelWidth / (TICK_SIZE * ADVANCE));
	series.forEach((entry, index) => {
		const x = PAD + (index % across) * (panelWidth + gap);
		const y = top + Math.floor(index / across) * panelHeight;
		parts.push(text(x, y + 6, clip(entry.name, titleChars), { size: TICK_SIZE, fill: "fg", weight: 600 }));
		const textWidth = Math.max(0, ...entry.points.map((_, at) => measure(pointText(entry, at), 10)));
		const barSpace = Math.max(0, panelWidth - textWidth - 6 - (entry.best === undefined ? 0 : BEST_WIDTH));
		const scale = panelScale(
			entry.points.flatMap(point => (point ? [point.value + (point.error ?? 0)] : [])),
			x,
			x + barSpace,
		);
		// Categories are colors here, never nested: a reference rule runs through the whole panel.
		const rows = categories.map((_, at) => y + 20 + at * 14);
		const reference = referenceRules({ ...spec, groups: undefined }, entry, rows, 14, scale.at);
		const emphasized = entry.points.some(point => point?.emphasis);
		entry.points.forEach((point, at) => {
			const middle = y + 27 + at * 14;
			if (!point) {
				const note = entry.notes[at];
				if (note) parts.push(noteText(x, middle, clip(note, titleChars)));
				return;
			}
			const end = Math.max(x + MIN_BAR, scale.at(point.value));
			const color = SERIES[at % SERIES.length]!;
			const opacity = emphasized && !point.emphasis ? RECEDE : 1;
			parts.push(
				scale.cut && point.value > scale.cut.below
					? cutBar(scale.cut, x, end, middle - 5, 10, color, opacity)
					: rect(x, middle - 5, end - x, 10, color, opacity),
			);
			const spread = point.error && !scale.cut ? whisker(scale, point, middle, 4) : "";
			parts.push(spread);
			const best = entry.best === at;
			const figureX =
				Math.max(end, reference.at[at] ?? end, spread ? scale.at(point.value + point.error!) : end) + 4;
			parts.push(
				text(figureX, middle, pointText(entry, at), {
					size: 10,
					fill: point.emphasis || best ? "fg" : "muted",
					weight: point.emphasis || best ? 600 : undefined,
				}),
			);
			if (best) parts.push(bestTag(figureX + measure(pointText(entry, at), 10) * SEMIBOLD_WIDTH + 4, middle, 10));
		});
		parts.push(reference.body);
	});
	return {
		height: top + bands * panelHeight - 10,
		body: parts.join(""),
		legend: categories.map((name, at) => ({ name, color: SERIES[at % SERIES.length]! })),
		notes: ["scaled per panel"],
	};
}

// ── Change against a baseline ───────────────────────────────────────────────

/** Factor within which every move of a `change` reads as a percent on a linear axis (−67% … +200%). */
const PERCENT_REACH = 3;
/** Least room between two factor tick labels (`3× less`, `1×`). */
const FACTOR_TICK_GAP = 56;
/** Least reach of a percent axis (in percent) toward each side its moves take, so a few percent never fill it. */
const MIN_PERCENT_REACH = 10;

/**
 * Each metric's move from the baseline as a bar from no change, every row
 * written one way ({@link factorMove}): moves all within {@link PERCENT_REACH}×
 * as percents on a linear axis through 0% (`−4%`, `−56%`); farther ones as
 * factors on a log axis through 1×, where halving and doubling draw equally
 * long whatever the metric's unit (`155× less`, `1.1× more`). One series prints
 * the move and both figures beside its bar; bars take the move's tone where
 * the metric has a polarity, the rest one neutral color.
 */
function drawChange(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const single = series.length === 1;
	const points = series.flatMap(entry => entry.points.filter(point => point !== null));
	const style = points.every(
		point => point.value <= PERCENT_REACH && (point.value === 0 || point.value >= 1 / PERCENT_REACH),
	)
		? "percent"
		: "factor";
	const logs = points.flatMap(point => (point.value > 0 ? [Math.log10(point.value)] : []));
	let low = -roundFactor(-Math.min(0, ...logs));
	let high = roundFactor(Math.max(0, ...logs));
	// A drop to zero has no factor: on the log axis its bar runs off the axis' end through a break, its move
	// written `to zero`; on the percent axis it runs to −100%.
	if (points.some(point => point.value === 0)) low = Math.min(low, -Math.log10(2));
	if (low === high) high = Math.log10(FACTOR_STOPS[0]!);

	const parts: string[] = [];
	const top = 0;
	const factors = categories.map((_, at) => {
		const point = series[0]!.points[at];
		return single && point ? factorMove(point.value, style) : "";
	});
	const factorWidth = Math.max(0, ...factors.map(label => measure(label, TICK_SIZE)));
	const figures = categories.map((_, at) => (single ? (series[0]!.points[at]?.text ?? "") : ""));
	const figureWidth = Math.max(0, ...figures.map(label => measure(label, TICK_SIZE)));
	const labelWidth = labelColumnWidth(spec);
	// Long figures (`0.138 / 0.537 → 0.057 / 0.154`) take up to {@link FIGURE_SHARE} of the room right of the labels.
	const valueWidth = single
		? Math.min(Math.max(280, (WIDTH - 2 * PAD - labelWidth - 10) * FIGURE_SHARE), factorWidth + 10 + figureWidth) + 8
		: Math.max(0, ...points.map(point => measure(factorMove(point.value, style), 10))) + 8;
	const left = PAD + labelWidth + 10;
	const right = WIDTH - PAD - valueWidth;
	const metrics = barMetrics(categories.length, series.length);
	const rowHeight = labelRow(spec, metrics.row);
	const barHeight = metrics.bar;
	const tops = rowTops(spec, top, rowHeight);
	const gridBottom = tops.at(-1)!;

	// Where a factor lands, and the ticks: percents on nice linear steps through 0%; on the log axis 1× always,
	// the ends and whole decades between wherever their labels stay clear of the rest.
	let x: (factor: number) => number;
	const ticks = new Map<number, string>();
	if (style === "percent") {
		// Moves as written (whole percents): a `same` never stretches the axis to a side of its own.
		const percents = points.map(point => Math.round((point.value - 1) * 100));
		const reach = [
			...(percents.some(percent => percent < 0) ? [-MIN_PERCENT_REACH] : []),
			...(percents.some(percent => percent > 0) ? [MIN_PERCENT_REACH] : []),
		];
		const scale = valueScale([...percents, ...reach], left, right, { zero: true });
		x = factor => scale.at((factor - 1) * 100);
		for (const tick of scale.ticks)
			ticks.set(tick / 100 + 1, tick === 0 ? "0%" : `${tick > 0 ? "+" : "−"}${compact(Math.abs(tick))}%`);
	} else {
		const at = (log: number) => left + ((log - low) / (high - low)) * (right - left);
		x = factor => at(factor > 0 ? Math.log10(factor) : low);
		const decade = (right - left) / (high - low);
		const logs = [0];
		for (const end of [low, high]) if (Math.abs(end) * decade >= FACTOR_TICK_GAP) logs.push(end);
		for (let power = Math.ceil(low); power <= Math.floor(high); power++) {
			if (logs.every(tick => Math.abs(power - tick) * decade >= FACTOR_TICK_GAP)) logs.push(power);
		}
		for (const log of logs)
			ticks.set(10 ** log, log === 0 ? "1×" : `${compactFactor(10 ** Math.abs(log))}× ${log < 0 ? "less" : "more"}`);
	}
	for (const [tick, label] of ticks) {
		parts.push(rule(x(tick), top, x(tick), gridBottom));
		parts.push(text(x(tick), gridBottom + 12, label, { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
	}
	// Neutral bars share one color; beside toned ones they step back.
	const toned = categories.some((_, row) =>
		series.some(entry => {
			const point = entry.points[row];
			return point && moveTone(spec.categoryPolarity?.[row] ?? entry.polarity, point.value);
		}),
	);

	const emphasized = points.some(point => point.emphasis);
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	categories.forEach((_, row) => {
		const rowTop = tops[row]!;
		const middle = rowTop + rowHeight / 2;
		series.forEach((entry, index) => {
			const point = entry.points[row];
			if (!point) return;
			const y = single ? middle - barHeight / 2 : rowTop + 5 + index * metrics.step;
			const end = x(point.value);
			// A metric with a polarity reads its move as an improvement or a regression.
			const tone = moveTone(spec.categoryPolarity?.[row] ?? entry.polarity, point.value);
			// One series takes the move's tone (neutral otherwise); several keep their own colors.
			const color = single ? (tone ?? (toned ? "muted" : SERIES[0])) : SERIES[index % SERIES.length]!;
			const opacity = emphasized && !point.emphasis ? RECEDE : 1;
			if (style === "factor" && point.value === 0) {
				const cut = end + CLIP_INSET;
				parts.push(rect(end, y, CLIP_INSET - CUT_GAP / 2, barHeight, color, opacity));
				parts.push(rect(cut + CUT_GAP / 2, y, x(1) - cut - CUT_GAP / 2, barHeight, color, opacity));
				parts.push(breakMark(cut, y + barHeight / 2, barHeight / 2 + 1, "muted"));
			} else parts.push(rect(Math.min(x(1), end), y, Math.max(1, Math.abs(end - x(1))), barHeight, color, opacity));
			if (!single)
				parts.push(
					text(right + 8, y + barHeight / 2, factorMove(point.value, style), { size: 10, fill: tone ?? "muted" }),
				);
		});
		if (single) {
			const point = series[0]!.points[row];
			const strong = point?.emphasis ? 600 : undefined;
			const tone = point ? moveTone(spec.categoryPolarity?.[row] ?? series[0]!.polarity, point.value) : undefined;
			parts.push(text(right + 8, middle, factors[row]!, { size: TICK_SIZE, fill: tone ?? "fg", weight: strong }));
			parts.push(
				text(right + 18 + factorWidth, middle, fitText(figures[row]!, valueWidth - 17 - factorWidth, TICK_SIZE), {
					size: TICK_SIZE,
					fill: "muted",
				}),
			);
		}
	});
	parts.push(line(x(1), top - 2, x(1), gridBottom + 2, "muted", 1.5));
	const versus = `change vs ${spec.baseline ?? "baseline"}`;
	return {
		height: gridBottom + 20,
		body: parts.join(""),
		legend: single ? [] : series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! })),
		notes: style === "percent" ? [versus] : [versus, "log scale"],
	};
}

/** `log10` of the first {@link FACTOR_STOPS} entry (else power of ten) at or past `10^log`; 0 stays 0. */
function roundFactor(log: number): number {
	if (log <= 0) return 0;
	const stop = FACTOR_STOPS.find(factor => Math.log10(factor) >= log - 1e-9);
	return stop === undefined ? Math.ceil(log - 1e-9) : Math.log10(stop);
}

/** A factor as people say it: `48× less`, `2.1× more`, or a percent within 2× (`−12%`, `+27%`). */
function factorText(point: ChartPoint | null | undefined): string {
	if (!point) return "";
	return factorMove(point.value, point.value >= 2 || (point.value > 0 && point.value <= 0.5) ? "factor" : "percent");
}

/**
 * A value's factor of its reference row, one way for a whole column: a percent
 * (`−7%`, `+57%`) where every factor stays within 2× either way, else the
 * factor itself (`2.2×`, `1.6×`, `0.45×`: one decimal from 1×, two under it,
 * whole from 10×) once any reaches past — shorter than `2.2× more`, so the
 * figures leave the bars their width; `same` within {@link STILL}.
 */
function referenceText(factor: number, ratio: boolean): string {
	if (!ratio) return factorMove(factor, "percent");
	if (factor > 0 && Math.abs(Math.log(factor)) < Math.log(STILL)) return "same";
	return `${factor >= 10 ? compact(Math.round(factor)) : Number(factor.toFixed(factor >= 1 ? 1 : 2))}×`;
}

/** `48`, `2.1`, `1.25`, `35k`: whole above 10, one decimal above 2, two below. */
function compactFactor(factor: number): string {
	if (factor >= 10) return compact(Math.round(factor));
	return Number(factor.toFixed(factor >= 2 ? 1 : 2)).toString();
}

// ── Slope: values across ordered stages ──────────────────────────────────────

/** Plot height a slope chart gives each category, and the least and most it takes in all. */
const SLOPE_ROW = 26;
const MIN_SLOPE_HEIGHT = 150;
const MAX_SLOPE_HEIGHT = 300;
/** Widest end label column of a slope chart, either side. */
const MAX_SLOPE_LABEL = 230;

/** Categories ending on one figure at a stage, labelled once (`haiku, gemini, glm  2`). */
interface StageLabel {
	y: number;
	readonly text: string;
	readonly names: readonly number[];
}

/**
 * Each category as a line through the stages (the series, in order), the
 * stages as columns headed by their names. The first stage's values are hollow
 * rings, later ones dots; each step takes the tone its move has for the
 * measure ({@link pairTone}), else the category's color (or a neutral one past
 * the series colors). Both ends carry labels: names and first values on the
 * left, last values, names and the net move ({@link moveText}) on the right;
 * categories sharing a figure share a label. Middle stages print their values
 * small beside the dots.
 */
function drawSlope(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const first = series[0]!;
	const last = series.at(-1)!;
	const strong = strongCategories(spec);
	const steps = categories.map((_, at) =>
		series.slice(1).map((entry, index) => {
			const [a, b] = [series[index]!.points[at], entry.points[at]];
			return a && b ? pairTone(series[index]!, entry, a, b) : undefined;
		}),
	);
	const toned = steps.some(tones => tones.some(Boolean));
	const own = (at: number) =>
		toned ? "muted" : categories.length <= SERIES.length ? SERIES[at]! : strong.has(at) ? SERIES[0] : "muted";
	const ends = categories.map((_, at): [ChartPoint, ChartPoint] | undefined => {
		const [a, b] = [first.points[at], last.points[at]];
		return a && b ? [a, b] : undefined;
	});
	const style = moveStyle(
		last,
		ends.filter(pair => pair !== undefined),
	);
	const nets = ends.map(pair => (pair ? moveText(pair[0], pair[1], last, style) : ""));
	const netTone = ends.map(pair => (pair ? pairTone(first, last, pair[0], pair[1]) : undefined));
	// Categories sharing a figure at a stage share one label.
	const labelsAt = (entry: ChartSeries): StageLabel[] => {
		const byText = new Map<string, number[]>();
		entry.points.forEach((point, at) => {
			if (point) byText.set(point.text, [...(byText.get(point.text) ?? []), at]);
		});
		return [...byText].map(([figure, names]) => ({ y: 0, text: figure, names }));
	};
	const nameList = (names: readonly number[]) => names.map(at => categories[at]!).join(", ");
	const netOf = (names: readonly number[]) =>
		names.every(at => nets[at] === nets[names[0]!]) ? nets[names[0]!]! : "";
	const lefts = labelsAt(first);
	const rights = labelsAt(last);
	// A little slack past the estimate keeps a name that just fits from clipping.
	const leftWidth = Math.min(
		MAX_SLOPE_LABEL,
		Math.max(...lefts.map(label => measure(nameList(label.names), TICK_SIZE) + 6 + measure(label.text, TICK_SIZE))) +
			6,
	);
	const rightWidth = Math.min(
		MAX_SLOPE_LABEL,
		Math.max(
			...rights.map(
				label =>
					measure(label.text, TICK_SIZE) * SEMIBOLD_WIDTH +
					6 +
					measure(nameList(label.names), TICK_SIZE) +
					(netOf(label.names) ? 8 + measure(netOf(label.names), TICK_SIZE) * SEMIBOLD_WIDTH : 0),
			),
		),
	);
	const x0 = PAD + leftWidth + 12;
	const x1 = WIDTH - PAD - rightWidth - 12;
	const xs = series.map((_, index) => x0 + (index / (series.length - 1)) * (x1 - x0));
	const plotTop = 30;
	const plotHeight = Math.min(MAX_SLOPE_HEIGHT, Math.max(MIN_SLOPE_HEIGHT, categories.length * SLOPE_ROW));
	const plotBottom = plotTop + plotHeight;
	const values = series.flatMap(entry => entry.points.flatMap(point => (point ? [point.value] : [])));
	const scale = valueScale(values, plotBottom, plotTop, { zero: false });

	const parts: string[] = [];
	series.forEach((entry, index) => {
		parts.push(rule(xs[index]!, plotTop - 10, xs[index]!, plotBottom + 6));
		parts.push(text(xs[index]!, 8, clip(entry.name, 24), { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
	});
	// Lines first, emphasized ones last so they cross over the rest; dots over every line.
	const order = categories.map((_, at) => at).sort((a, b) => Number(strong.has(a)) - Number(strong.has(b)));
	const dots: string[] = [];
	for (const at of order) {
		const width = strong.has(at) ? 3 : 2.25;
		series.forEach((entry, index) => {
			const point = entry.points[at];
			if (!point) return;
			const [x, y] = [xs[index]!, scale.at(point.value)];
			const before = index > 0 ? series[index - 1]!.points[at] : null;
			const color = steps[at]![index - 1] ?? own(at);
			if (before) parts.push(line(xs[index - 1]!, scale.at(before.value), x, y, color, width, 0.85));
			dots.push(index === 0 ? ring(x, y, 3.5, toned ? "muted" : own(at)) : dot(x, y, 3.5, color));
		});
	}
	parts.push(...dots);
	// Middle stages print their figures small, above their dots.
	for (const [index, entry] of series.entries()) {
		if (index === 0 || index === series.length - 1) continue;
		// Figures whose dots nearly meet join one label over the topmost, top to bottom (`17.10 ms · 16.02 ms`):
		// pushed apart, the lower would sit on the lines.
		const labels: StageLabel[] = [];
		const natural = labelsAt(entry)
			.map(label => ({ ...label, y: scale.at(entry.points[label.names[0]!]!.value) - 9 }))
			.sort((a, b) => a.y - b.y);
		for (const label of natural) {
			const above = labels.at(-1);
			if (above && label.y - above.y < 11)
				labels[labels.length - 1] = {
					...above,
					text: `${above.text} · ${label.text}`,
					names: [...above.names, ...label.names],
				};
			else labels.push(label);
		}
		for (const label of spreadApart(labels, plotTop - 8, plotBottom, 11))
			parts.push(text(xs[index]!, label.y, label.text, { size: 10, fill: "muted", anchor: "middle" }));
	}
	const place = (labels: StageLabel[], entry: ChartSeries) => {
		for (const label of labels) label.y = scale.at(entry.points[label.names[0]!]!.value);
		return spreadApart(labels, plotTop - 6, plotBottom + 6, TICK_SIZE + 3);
	};
	const nameColor = (names: readonly number[]) => (toned || names.length > 1 ? "fg" : own(names[0]!));
	for (const label of place(lefts, first)) {
		const figureWidth = measure(label.text, TICK_SIZE);
		parts.push(text(x0 - 12, label.y, label.text, { size: TICK_SIZE, fill: "muted", anchor: "end" }));
		parts.push(
			text(x0 - 18 - figureWidth, label.y, fitText(nameList(label.names), x0 - 18 - figureWidth - PAD, TICK_SIZE), {
				size: TICK_SIZE,
				fill: nameColor(label.names),
				anchor: "end",
				weight: label.names.some(at => strong.has(at)) ? 600 : undefined,
			}),
		);
	}
	for (const label of place(rights, last)) {
		const net = netOf(label.names);
		const tone = label.names.every(at => netTone[at] === netTone[label.names[0]!])
			? netTone[label.names[0]!]
			: undefined;
		let x = x1 + 12;
		parts.push(text(x, label.y, label.text, { size: TICK_SIZE, fill: "fg", weight: 600 }));
		x += measure(label.text, TICK_SIZE) * SEMIBOLD_WIDTH + 6;
		const netWidth = net ? 8 + measure(net, TICK_SIZE) * SEMIBOLD_WIDTH : 0;
		const names = fitText(nameList(label.names), WIDTH - PAD - x - netWidth, TICK_SIZE);
		parts.push(
			text(x, label.y, names, {
				size: TICK_SIZE,
				fill: nameColor(label.names),
				weight: label.names.some(at => strong.has(at)) ? 600 : undefined,
			}),
		);
		if (net)
			parts.push(
				text(x + measure(names, TICK_SIZE) + 8, label.y, net, {
					size: TICK_SIZE,
					fill: tone ?? "muted",
					weight: tone ? 600 : undefined,
				}),
			);
	}
	const polarity = last.polarity ?? first.polarity;
	return {
		height: plotBottom + 10,
		body: parts.join(""),
		notes: [...(toned ? [`${polarity} is better`] : []), ...(scale.log ? ["log scale"] : [])],
	};
}

// ── Butterfly: opposing amounts back to back ─────────────────────────────────

/**
 * Two opposing amounts per category as bars from one spine: the first series
 * (the losing side: removed, losses) leftward in the error tone, the second
 * (added, wins) rightward in the success tone, on one scale either way, each
 * figure at its bar's end and the series named over its half. Each row's net
 * closes the line in the tone of the side that outweighs.
 */
function drawButterfly(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const loss = series[0]!;
	const gain = series[1]!;
	const sides = [loss, gain];
	const size = (point: ChartPoint | null | undefined) => Math.abs(point?.value ?? 0);
	const nets = categories.map((_, at) => size(gain.points[at]) - size(loss.points[at]));
	const whole = sides.every(entry => entry.points.every(point => !point || Number.isInteger(point.value)));
	const netText = (net: number) =>
		net === 0
			? "±0"
			: `${net > 0 ? "+" : "−"}${whole ? Math.abs(net).toLocaleString("en-US") : formatValue(Math.abs(net), gain.dim, gain.unit)}`;
	const figures = sides.map(entry => categories.map((_, at) => pointText(entry, at)));
	const widest = (labels: readonly string[]) => Math.max(0, ...labels.map(label => measure(label, TICK_SIZE)));
	const netWidth = Math.max(measure("net", TICK_SIZE), widest(nets.map(netText)) * SEMIBOLD_WIDTH) + 12;
	const left = PAD + labelColumnWidth(spec) + 10 + widest(figures[0]!) + 8;
	const right = WIDTH - PAD - netWidth - widest(figures[1]!) - 8;
	const spine = (left + right) / 2;
	const reach = Math.max(...sides.flatMap(entry => entry.points.map(size)), 1);
	const span = (value: number) => (Math.abs(value) / reach) * (right - spine);
	const { row, bar: barHeight } = barMetrics(categories.length, 1);
	const rowHeight = labelRow(spec, row);
	const top = 18;
	const tops = rowTops(spec, top, rowHeight);
	const bottom = tops.at(-1)!;
	const estimates = sides.map(estimatedPoints);

	const parts: string[] = [];
	for (const at of highlighted(spec)) parts.push(band(PAD - 4, tops[at]!, WIDTH - 2 * PAD + 8, rowHeight));
	parts.push(categoryLabels(spec, tops, rowHeight, strongCategories(spec)));
	parts.push(text(spine - 8, 6, clip(loss.name, 24), { size: TICK_SIZE, fill: "muted", anchor: "end" }));
	parts.push(text(spine + 8, 6, clip(gain.name, 24), { size: TICK_SIZE, fill: "muted" }));
	parts.push(text(WIDTH - PAD, 6, "net", { size: TICK_SIZE, fill: "muted", anchor: "end" }));
	const emphasized = sides.some(entry => entry.points.some(point => point?.emphasis));
	categories.forEach((_, at) => {
		const middle = tops[at]! + rowHeight / 2;
		const y = middle - barHeight / 2;
		sides.forEach((entry, index) => {
			const point = entry.points[at];
			if (!point) return;
			const length = Math.max(MIN_BAR, span(point.value));
			const opacity = emphasized && !point.emphasis ? RECEDE : 1;
			const strong = point.emphasis ? 600 : undefined;
			const estimate = estimates[index]!.has(at);
			if (index === 0) {
				parts.push(barRect(spine - length, y, length, barHeight, "error", opacity, { estimate }));
				parts.push(
					text(spine - length - 6, middle, figures[0]![at]!, {
						size: TICK_SIZE,
						fill: "muted",
						anchor: "end",
						weight: strong,
					}),
				);
			} else {
				parts.push(barRect(spine, y, length, barHeight, "success", opacity, { estimate }));
				parts.push(
					text(spine + length + 6, middle, figures[1]![at]!, { size: TICK_SIZE, fill: "muted", weight: strong }),
				);
			}
		});
		const net = nets[at]!;
		parts.push(
			text(WIDTH - PAD, middle, netText(net), {
				size: TICK_SIZE,
				fill: net > 0 ? "success" : net < 0 ? "error" : "muted",
				anchor: "end",
				weight: 600,
			}),
		);
	});
	parts.push(line(spine, top - 4, spine, bottom + 4, "fg", 1.25, 0.6));
	return { height: bottom + 8, body: parts.join("") };
}

// ── Two conditions, metric by metric ────────────────────────────────────────

/** Widest a stat tile grows, so one or two metrics stay a compact card rather than a banner. */
const MAX_TILE = 300;
/** Space between stat tiles, a hairline divider in its middle. */
const TILE_GAP = 24;
/** Size of a stat tile's factor. */
const FACTOR_SIZE = 24;

/**
 * Two conditions compared metric by metric (`stat`): a tile per series, each
 * naming its metric over the factor from the baseline condition
 * ({@link ChartSpec.reference}) to the other in large figures — toned when the
 * metric improves or regresses — over one short bar per condition on the
 * tile's own scale, the baseline muted and the other in the lead color, each
 * with its written figure. The header keys the two conditions.
 */
function drawStat(spec: ChartSpec): Layer {
	const { series, categories } = spec;
	const base = spec.reference?.[0] ?? 0;
	const other = 1 - base;
	const tile = Math.min(MAX_TILE, (WIDTH - 2 * PAD - TILE_GAP * (series.length - 1)) / series.length);
	const parts: string[] = [];
	const barTop = 50;
	const barHeight = 10;
	const barStep = 18;
	const height = barTop + barStep + barHeight;
	series.forEach((entry, index) => {
		const left = PAD + index * (tile + TILE_GAP);
		if (index > 0) parts.push(rule(left - TILE_GAP / 2, 0, left - TILE_GAP / 2, height));
		parts.push(text(left, 7, fitText(entry.name, tile, TICK_SIZE), { size: TICK_SIZE, fill: "muted" }));
		const [from, to] = [entry.points[base], entry.points[other]];
		if (!from || !to) return;
		const move = from.value > 0 ? { value: to.value / from.value, text: "", emphasis: false } : undefined;
		const words = factorText(move);
		const size = Math.min(
			FACTOR_SIZE,
			(FACTOR_SIZE * tile) / Math.max(1, measure(words, FACTOR_SIZE) * SEMIBOLD_WIDTH),
		);
		const tone = move ? moveTone(entry.polarity, move.value) : undefined;
		parts.push(text(left, 30, words, { size, fill: tone ?? "fg", weight: 600 }));
		// Figures show whole (`2,426 / 2,368 ms`) up to half the tile; the bars keep the rest.
		const figures = [base, other].map(at => fitText(pointText(entry, at), tile / 2, TICK_SIZE * SEMIBOLD_WIDTH));
		const figureWidth = Math.max(...figures.map(figure => measure(figure, TICK_SIZE) * SEMIBOLD_WIDTH)) + 8;
		const span = Math.max(24, tile - figureWidth);
		const peak = Math.max(from.value, to.value) || 1;
		const estimated = estimatedPoints(entry);
		[from, to].forEach((point, at) => {
			const y = barTop + at * barStep;
			const length = Math.max(MIN_BAR, (Math.max(0, point.value) / peak) * span);
			parts.push(
				barRect(left, y, length, barHeight, at === 0 ? "muted" : SERIES[0], at === 0 ? 0.55 : 1, {
					estimate: estimated.has(at === 0 ? base : other),
				}),
			);
			parts.push(
				text(left + length + 6, y + barHeight / 2, figures[at]!, {
					size: TICK_SIZE,
					fill: at === 0 ? "muted" : "fg",
					weight: at === 0 ? undefined : 600,
				}),
			);
		});
	});
	return {
		height,
		body: parts.join(""),
		legend: [
			{ name: categories[base] ?? "", color: "muted", opacity: 0.55 },
			{ name: categories[other] ?? "", color: SERIES[0] },
		],
	};
}

// ── Share of a whole ─────────────────────────────────────────────────────────

/**
 * One bar split into the categories' shares, in table order, keyed below with
 * each name and figure. Percentages draw as written; counts splitting a total
 * draw as their percent of it, keyed `248 · 16%`, with the whole they make
 * named in the header (`100% = 1,543`). Outcome categories take their status
 * colors ({@link ChartSpec.tones}).
 */
function drawShare(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const total = entry.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0) || 1;
	const counts = entry.dim !== "percent";
	const shares = entry.points.map(point =>
		point && counts ? percentText((100 * Math.max(0, point.value)) / total) : (point?.text ?? ""),
	);
	const parts: string[] = [];
	const barWidth = WIDTH - 2 * PAD;
	let x = PAD;
	entry.points.forEach((point, at) => {
		if (!point || point.value <= 0) return;
		const width = (point.value / total) * barWidth;
		// Segments part with a sliver of the canvas behind them.
		const opacity = partOpacity(spec, at);
		parts.push(rect(x, 0, Math.max(1, width - 2), 24, partColor(spec, at), opacity, 4));
		// A segment wide enough carries its figure inside, in ink to read on the solid color (plain text on a faint one).
		const figure = shares[at]!;
		const style = { size: TICK_SIZE, fill: "fg", anchor: "middle", weight: 600 } as const;
		if (figure && measure(figure, TICK_SIZE) * SEMIBOLD_WIDTH + 12 <= width - 2)
			parts.push((opacity >= INK_LEVEL ? ink : text)(x + (width - 2) / 2, 12, figure, style));
		x += width;
	});
	const columns = spec.categories.length > 5 ? 2 : 1;
	const columnWidth = barWidth / columns;
	const perColumn = Math.ceil(spec.categories.length / columns);
	const names = clipNames(spec.categories, Math.floor((columnWidth - 90) / (LABEL_SIZE * ADVANCE)));
	names.forEach((name, at) => {
		const column = Math.floor(at / perColumn);
		const lx = PAD + column * columnWidth;
		const ly = 42 + (at % perColumn) * 20;
		const point = entry.points[at];
		parts.push(dot(lx + 5, ly, 4.5, partColor(spec, at), partOpacity(spec, at)));
		parts.push(text(lx + 16, ly, name, { fill: "fg" }));
		parts.push(
			text(lx + columnWidth - 12, ly, point && counts ? `${point.text} · ${shares[at]}` : (point?.text ?? ""), {
				size: TICK_SIZE,
				fill: point?.emphasis ? "fg" : "muted",
				anchor: "end",
				weight: point?.emphasis ? 600 : undefined,
			}),
		);
	});
	// The whole the counts split, unless the caption already prints the table's total row.
	const notes = counts && !spec.caption ? [`100% = ${total.toLocaleString("en-US")}`] : [];
	return { height: 42 + perColumn * 20 - 6, body: parts.join(""), notes };
}

// ── Line over an ordered axis ────────────────────────────────────────────────

/** A line's value label at its end, nudged clear of its neighbours by {@link spreadLabels}. */
interface EndLabel {
	readonly x: number;
	y: number;
	readonly text: string;
	readonly color: string;
	/** The line's name, set before its value when lines are labelled directly instead of through a legend. */
	readonly name?: string;
}

/**
 * Lines across the categories (or the numeric x), smoothed without
 * overshooting a sample. Series whose peaks differ {@link SPLIT_SPREAD}× or
 * more stack in panels on their own axes, so one large series never flattens
 * the rest; the panels share the x labels under the last. A lone line on an
 * axis from zero draws over a soft area fill, and every line ends in its value — and its name,
 * when there are several and their names are short, instead of a legend.
 */
function drawLine(spec: ChartSpec): Layer {
	const { categories, series, x } = spec;
	const panels = magnitudePanels(series);
	const values = panels.map(panel =>
		panel.flatMap(index => series[index]!.points.flatMap(point => (point ? [point.value] : []))),
	);
	const tickWidth = Math.max(
		...values.flatMap(panelValues => {
			const scale = valueScale(panelValues, 0, 1, { zero: false });
			const format = tickFormat(scale, series[0]!);
			return scale.ticks.map(tick => measure(format(tick), TICK_SIZE));
		}),
	);
	const position = (at: number) => (x ? x.values[at]! : at);
	const order = categories.map((_, at) => at).sort((a, b) => position(a) - position(b));
	// The rightmost sample of each line carries its value label.
	const lasts = series.map(entry => order.findLast(at => entry.points[at]) ?? -1);
	const direct =
		series.length > 1 && series.every(entry => measure(entry.name, TICK_SIZE) * SEMIBOLD_WIDTH <= MAX_DIRECT_LABEL);
	const endWidth = Math.max(
		0,
		...lasts.map((last, index) => {
			const name = direct ? measure(series[index]!.name, TICK_SIZE) * SEMIBOLD_WIDTH + 6 : 0;
			return name + measure(series[index]!.points[last]?.text ?? "", TICK_SIZE);
		}),
	);
	const left = PAD + tickWidth + 8;
	const right = WIDTH - PAD - Math.min(direct ? 230 : 120, endWidth + 10);
	const xScale = x
		? valueScale(x.values, left, right, { zero: false })
		: {
				at: (index: number) =>
					left + (categories.length === 1 ? 0 : (index / (categories.length - 1)) * (right - left)),
			};
	const xAt = (at: number) => xScale.at(position(at));
	const plotHeight = panels.length === 1 ? 180 : Math.max(72, Math.round(200 / panels.length));
	const dotted = categories.length <= MAX_DOTS;

	const parts: string[] = [];
	const references = (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "reference" }> => mark.kind === "reference",
	);
	const callouts = (spec.annotations ?? []).filter(
		(mark): mark is Extract<ChartAnnotation, { kind: "callout" }> => mark.kind === "callout",
	);
	let top = 0;
	let plotBottom = 0;
	panels.forEach((panel, panelIndex) => {
		// Lines without direct labels need a legend in each of several panels (one panel's goes in the header).
		if (series.length > 1 && !direct && panels.length > 1) {
			const legend = drawLegend(
				panel.map(index => ({ name: series[index]!.name, color: SERIES[index % SERIES.length]! })),
				PAD,
				WIDTH - PAD,
				6,
			);
			parts.push(`<g transform="translate(0 ${num(top)})">${legend.body}</g>`);
			top += legend.height + 4;
		}
		// A callout over a line of this panel sets its text above the plot, clear of the panel's legend.
		const room = callouts.some(mark => panel.includes(mark.series ?? 0)) ? 24 : 0;
		const plotTop = top + 6 + room;
		plotBottom = plotTop + plotHeight;
		const scale = valueScale(values[panelIndex]!, plotBottom, plotTop, { zero: false });
		const format = tickFormat(scale, series[0]!);
		// Short panels label every other gridline.
		const labelEvery = plotHeight / Math.max(1, scale.ticks.length - 1) < 20 ? 2 : 1;
		scale.ticks.forEach((tick, at) => {
			const y = scale.at(tick);
			parts.push(rule(left, y, right, y));
			if (at % labelEvery === 0)
				parts.push(text(left - 8, y, format(tick), { size: TICK_SIZE, fill: "muted", anchor: "end" }));
		});
		const ends: EndLabel[] = [];
		for (const index of panel) {
			const entry = series[index]!;
			const color = SERIES[index % SERIES.length]!;
			// Runs of consecutive samples; a gap in the table breaks the line.
			const runs: [number, number][][] = [[]];
			for (const at of order) {
				const point = entry.points[at];
				if (point) runs.at(-1)!.push([xAt(at), scale.at(point.value)]);
				else if (runs.at(-1)!.length > 0) runs.push([]);
			}
			// The area reads as an amount, so it shades only down to a zero baseline, never to a cut-off axis.
			if (panel.length === 1 && scale.ticks[0] === 0) {
				// The fade's id names its color, so two charts inlined in one page agree on it.
				parts.push(
					`<defs><linearGradient id="fade-${color}" x1="0" y1="0" x2="0" y2="1">`,
					`<stop offset="0" stop-color="${token(color)}" stop-opacity="0.26"/>`,
					`<stop offset="1" stop-color="${token(color)}" stop-opacity="0"/>`,
					"</linearGradient></defs>",
				);
				for (const run of runs) {
					if (run.length < 2) continue;
					const floor = `L${num(run.at(-1)![0])} ${num(plotBottom)}L${num(run[0]![0])} ${num(plotBottom)}Z`;
					parts.push(`<path d="${smoothPath(run)}${floor}" fill="url(#fade-${color})"/>`);
				}
			}
			for (const run of runs) {
				if (run.length < 2) continue;
				parts.push(
					`<path d="${smoothPath(run)}" fill="none" stroke="${token(color)}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>`,
				);
			}
			const last = lasts[index]!;
			entry.points.forEach((point, at) => {
				if (!point || !(dotted || point.emphasis || at === last)) return;
				parts.push(dot(xAt(at), scale.at(point.value), point.emphasis ? 4.5 : at === last ? 3.5 : 2.5, color));
			});
			const end = entry.points[last];
			if (end)
				ends.push({
					x: xAt(last) + 8,
					y: scale.at(end.value),
					text: end.text,
					color,
					name: direct ? entry.name : undefined,
				});
			for (const mark of callouts) {
				const point = (mark.series ?? 0) === index ? entry.points[mark.category] : undefined;
				if (!point) continue;
				const label = clip(mark.text, MAX_CALLOUT_CHARS);
				const half = (measure(label, TICK_SIZE) * SEMIBOLD_WIDTH) / 2;
				const px = xAt(mark.category);
				const py = scale.at(point.value);
				parts.push(line(px, py - 6, px, py - 16, "muted", 1));
				parts.push(
					text(Math.min(Math.max(px, left + half), right - half), py - 23, label, {
						size: TICK_SIZE,
						fill: "fg",
						anchor: "middle",
						weight: 600,
					}),
				);
			}
		}
		for (const mark of panelIndex === 0 ? references : []) {
			const y = scale.at(mark.value);
			if (y < plotTop - 0.5 || y > plotBottom + 0.5) continue;
			parts.push(referenceRule(left, y, right, y));
			parts.push(text(right, y - 7, clip(mark.label, MAX_CALLOUT_CHARS), { size: 10, fill: "fg", anchor: "end" }));
		}
		parts.push(spreadLabels(ends, plotTop - 4, plotBottom + 4));
		top = plotBottom + 22;
	});

	// Category labels left to right, skipping any that would touch the last one drawn.
	// A label too long for its slot wraps to a second line before it clips.
	const slot = (right - left) / Math.max(1, categories.length - 1);
	const labels = categories.map(name => wrapHeader(name, Math.max(slot, 60) - 6, TICK_SIZE));
	let drawnEnd = Number.NEGATIVE_INFINITY;
	let wrapped = false;
	for (const at of order) {
		const lines = labels[at]!;
		const width = Math.max(...lines.map(label => measure(label, TICK_SIZE)));
		const center = Math.min(Math.max(xAt(at), left + width / 2), WIDTH - PAD - width / 2);
		if (center - width / 2 < drawnEnd + 8) continue;
		lines.forEach((label, line) =>
			parts.push(
				text(center, plotBottom + 14 + line * 12, label, { size: TICK_SIZE, fill: "muted", anchor: "middle" }),
			),
		);
		wrapped ||= lines.length > 1;
		drawnEnd = center + width / 2;
	}
	return {
		height: plotBottom + (wrapped ? 36 : 24),
		body: parts.join(""),
		legend:
			series.length > 1 && !direct && panels.length === 1
				? series.map((entry, at) => ({ name: entry.name, color: SERIES[at % SERIES.length]! }))
				: [],
		notes: panels.length > 1 ? ["own axis per panel"] : [],
	};
}

/**
 * Series indices grouped into panels whose peaks stay within
 * {@link SPLIT_SPREAD}× of the panel's largest, panels and their series in
 * table order. An all-zero series joins the smallest panel.
 */
function magnitudePanels(series: readonly ChartSeries[]): number[][] {
	const peaks = series.map(entry => Math.max(0, ...entry.points.map(point => (point ? Math.abs(point.value) : 0))));
	const panels: number[][] = [];
	let panelPeak = 0;
	for (const index of series.map((_, at) => at).sort((a, b) => peaks[b]! - peaks[a]!)) {
		const peak = peaks[index]!;
		if (panels.length > 0 && (peak === 0 || panelPeak < peak * SPLIT_SPREAD)) {
			panels.at(-1)!.push(index);
		} else {
			panels.push([index]);
			panelPeak = peak;
		}
	}
	for (const panel of panels) panel.sort((a, b) => a - b);
	return panels.sort((a, b) => a[0]! - b[0]!);
}

/**
 * A path through `points` (x ascending) as a monotone cubic (Steffen's
 * method): smooth, yet never overshooting a sample the way a Catmull-Rom
 * curve would between a peak and a flat stretch.
 */
function smoothPath(points: readonly (readonly [number, number])[]): string {
	const n = points.length;
	let path = `M${num(points[0]![0])} ${num(points[0]![1])}`;
	if (n < 3) return n === 2 ? `${path}L${num(points[1]![0])} ${num(points[1]![1])}` : path;
	const secants: number[] = [];
	for (let at = 0; at < n - 1; at++) {
		const h = points[at + 1]![0] - points[at]![0];
		secants.push(h === 0 ? 0 : (points[at + 1]![1] - points[at]![1]) / h);
	}
	const tangents: number[] = [0];
	for (let at = 1; at < n - 1; at++) {
		const h0 = points[at]![0] - points[at - 1]![0];
		const h1 = points[at + 1]![0] - points[at]![0];
		const [s0, s1] = [secants[at - 1]!, secants[at]!];
		const weighted = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
		tangents.push((Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(weighted)));
	}
	tangents[0] = (3 * secants[0]! - tangents[1]!) / 2;
	tangents.push((3 * secants[n - 2]! - tangents[n - 2]!) / 2);
	for (let at = 0; at < n - 1; at++) {
		const [x0, y0] = points[at]!;
		const [x1, y1] = points[at + 1]!;
		const third = (x1 - x0) / 3;
		path += `C${num(x0 + third)} ${num(y0 + third * tangents[at]!)} ${num(x1 - third)} ${num(y1 - third * tangents[at + 1]!)} ${num(x1)} ${num(y1)}`;
	}
	return path;
}

/** `items` sorted by `y` and nudged at least `gap` apart, kept between `top` and `bottom` where they fit. */
function spreadApart<T extends { y: number }>(items: T[], top: number, bottom: number, gap: number): T[] {
	items.sort((a, b) => a.y - b.y);
	for (let at = 1; at < items.length; at++) items[at]!.y = Math.max(items[at]!.y, items[at - 1]!.y + gap);
	for (let at = items.length - 1; at >= 0; at--) {
		const limit = at === items.length - 1 ? bottom : items[at + 1]!.y - gap;
		items[at]!.y = Math.max(top, Math.min(items[at]!.y, limit));
	}
	return items;
}

/** End labels in their lines' colors, nudged apart so none overlap, kept between `top` and `bottom` where they fit. */
function spreadLabels(labels: EndLabel[], top: number, bottom: number): string {
	return spreadApart(labels, top, bottom, TICK_SIZE + 2)
		.map(label => {
			if (!label.name)
				return text(label.x, label.y, label.text, { size: TICK_SIZE, fill: label.color, weight: 600 });
			const name = text(label.x, label.y, label.name, { size: TICK_SIZE, fill: label.color, weight: 600 });
			const offset = measure(label.name, TICK_SIZE) * SEMIBOLD_WIDTH + 6;
			return name + text(label.x + offset, label.y, label.text, { size: TICK_SIZE, fill: "muted" });
		})
		.join("");
}

// ── Scatter ──────────────────────────────────────────────────────────────────

function drawScatter(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const xs = spec.x!;
	const ys = entry.points.map(point => point?.value ?? Number.NaN);
	const finite = (values: readonly number[]) => values.filter(Number.isFinite);
	const yAxis = valueScale(finite(ys), 0, 1, { zero: false });
	const yFormat = tickFormat(yAxis, entry);
	const left = PAD + Math.max(...yAxis.ticks.map(tick => measure(yFormat(tick), TICK_SIZE))) + 8;
	const right = WIDTH - PAD - 24;
	const top = 18;
	const bottom = top + 200;
	// Ends inset from the plot's edges, so a dot on an outer tick stays clear of the axis labels.
	const xScale = valueScale(finite(xs.values), left + 8, right - 8, { zero: false });
	const yScale = valueScale(finite(ys), bottom - 6, top + 6, { zero: false });
	// Axis titles in the text color: they name what the plot means, unlike the muted tick figures.
	const parts: string[] = [text(left, 6, entry.name, { size: TICK_SIZE, fill: "fg" })];
	for (const tick of yScale.ticks) {
		parts.push(rule(left, yScale.at(tick), right, yScale.at(tick)));
		parts.push(
			text(left - 8, yScale.at(tick), yFormat(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "end",
			}),
		);
	}
	const xFormat = tickFormat(xScale, xs);
	for (const tick of xScale.ticks) {
		parts.push(
			text(xScale.at(tick), bottom + 14, xFormat(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		);
	}
	parts.push(text(right, bottom + 30, xs.name, { size: TICK_SIZE, fill: "fg", anchor: "end" }));
	const marks = entry.points.flatMap((point, at) => {
		const xv = xs.values[at]!;
		return point && Number.isFinite(xv) ? [{ at, point, x: xScale.at(xv), y: yScale.at(point.value) }] : [];
	});
	const emphasized = marks.some(mark => mark.point.emphasis);
	// A highlighted item (the row the table is about) is ringed in the accent and named in full strength.
	const focus = new Set(highlighted(spec));
	for (const mark of marks) {
		const strong = !emphasized || mark.point.emphasis || focus.has(mark.at);
		if (focus.has(mark.at)) parts.push(ring(mark.x, mark.y, 8.5, "accent"));
		parts.push(dot(mark.x, mark.y, mark.point.emphasis ? 5.5 : 4, SERIES[0], strong ? 0.9 : RECEDE));
	}
	// Each name takes the first spot around its dot clear of every dot and name placed so far; crowded ones go unnamed.
	const taken: Box[] = marks.map(mark => ({ x0: mark.x - 5, y0: mark.y - 5, x1: mark.x + 5, y1: mark.y + 5 }));
	const lead = (mark: (typeof marks)[number]) => Number(focus.has(mark.at)) * 2 + Number(mark.point.emphasis);
	const order = marks.toSorted((a, b) => lead(b) - lead(a));
	const names = clipNames(spec.categories, 26);
	for (const mark of order.length <= 40 ? order : []) {
		const label = names[mark.at]!;
		const strong = mark.point.emphasis || focus.has(mark.at);
		const width = measure(label, TICK_SIZE) * (strong ? SEMIBOLD_WIDTH : 1);
		// A name clears its dot, and the accent ring around a highlighted one.
		const gap = focus.has(mark.at) ? 13 : 8;
		const spots: [number, number, "start" | "end" | "middle"][] = [
			[mark.x + gap, mark.y, "start"],
			[mark.x - gap, mark.y, "end"],
			[mark.x, mark.y - gap - 5, "middle"],
			[mark.x, mark.y + gap + 5, "middle"],
		];
		for (const [x, y, anchor] of spots) {
			const x0 = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
			const box = { x0: x0 - 1, y0: y - 6, x1: x0 + width + 1, y1: y + 6 };
			if (box.x0 < PAD || box.x1 > WIDTH - PAD || box.y0 < 0 || box.y1 > bottom + 4) continue;
			if (taken.some(other => box.x0 < other.x1 && other.x0 < box.x1 && box.y0 < other.y1 && other.y0 < box.y1))
				continue;
			taken.push(box);
			// Names read in the text color unless bolded points single some out; then the rest recede with their dots.
			parts.push(
				text(x, y, label, {
					size: TICK_SIZE,
					fill: focus.has(mark.at) ? "accent" : strong || !emphasized ? "fg" : "muted",
					anchor,
					weight: strong ? 600 : undefined,
				}),
			);
			break;
		}
	}
	return { height: bottom + 36, body: parts.join("") };
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/**
 * A value axis over `values` from `from` to `to`: logarithmic when every
 * value is positive and they span {@link LOG_SPREAD}× or more, else linear on
 * nice ticks, including zero when `zero` asks for a baseline.
 */
function valueScale(
	values: readonly number[],
	from: number,
	to: number,
	options: {
		zero: boolean;
		breakable?: boolean;
		/** One tick unit in base units ({@link tickUnit}): a linear axis ticks on nice multiples of it. */
		unit?: number;
	},
): Scale {
	let min = Math.min(...values);
	let max = Math.max(...values);
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		min = 0;
		max = 1;
	}
	const tier = options.breakable ? outlierTier(values) : undefined;
	if (tier) return brokenScale(tier, from, to, true);
	if (logSpread(values)) {
		const low = Math.floor(Math.log10(min));
		const high = Math.ceil(Math.log10(max));
		const ticks: number[] = [];
		const stride = Math.max(1, Math.ceil((high - low) / 6));
		for (let power = low; power <= high; power += stride) ticks.push(10 ** power);
		const span = high - low || 1;
		return {
			at: value => from + ((Math.log10(Math.max(value, 10 ** low)) - low) / span) * (to - from),
			ticks,
			log: true,
		};
	}
	if (options.zero) {
		min = Math.min(0, min);
		max = Math.max(0, max);
	} else if (min > 0 && min < max * 0.35) {
		min = 0;
	}
	if (min === max) {
		max = min === 0 ? 1 : min + Math.abs(min) * 0.5;
		if (!options.zero) min -= Math.abs(min) * 0.5;
	}
	const unit = options.unit ?? 1;
	const nice = linearTicks(
		min / unit,
		max / unit,
		values.every(value => Number.isInteger(value / unit)),
	);
	const [low, high, step] = [nice.low * unit, nice.high * unit, nice.step * unit];
	const ticks: number[] = [];
	for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
	return { at: value => from + ((value - low) / (high - low || 1)) * (to - from), ticks, log: false };
}

/** Whether `values` are all positive and span {@link LOG_SPREAD}× or more: a value axis over them is logarithmic. */
function logSpread(values: readonly number[]): boolean {
	const min = Math.min(...values);
	return min > 0 && Math.max(...values) / min >= LOG_SPREAD;
}

/**
 * Nice tick spacing for a linear axis over `min`…`max`: of the
 * {@link niceStep}s giving three to six intervals, the one whose outer ticks
 * waste the least length past the values (`0–120`, not `0–150`, for 113),
 * four or five intervals preferred; whole steps only for `integral` values
 * (counts tick `0, 2, 4`, never `2.5`).
 */
function linearTicks(min: number, max: number, integral: boolean): { low: number; high: number; step: number } {
	let best: { low: number; high: number; step: number; cost: number } | undefined;
	for (const intervals of [4, 5, 3, 6]) {
		const step = niceStep((max - min) / intervals);
		if (integral && !Number.isInteger(step)) continue;
		const low = Math.floor(min / step) * step;
		const high = Math.ceil(max / step) * step;
		const count = Math.round((high - low) / step);
		if (count < 2 || count > 7) continue;
		const waste = (high - low - (max - min)) / (high - low || 1);
		// Steps of 2.5 tick at `7.5`: a last resort beside the rounder 1, 2 and 5.
		const quarter = Math.abs(step / 10 ** Math.floor(Math.log10(step)) - 2.5) < 1e-9;
		const cost = waste + 0.03 * Math.max(0, Math.abs(count - 4.5) - 0.5) + (quarter ? 0.08 : 0);
		if (!best || cost < best.cost - 1e-9) best = { low, high, step, cost };
	}
	if (best) return best;
	const step = integral ? Math.max(1, Math.ceil(niceStep((max - min) / 4))) : niceStep((max - min) / 4);
	return { low: Math.floor(min / step) * step, high: Math.ceil(max / step) * step, step };
}

/**
 * A positional axis for dots and intervals, which mark where values lie rather
 * than how far they reach from zero: logarithmic once positive values span
 * {@link SPAN_LOG}×, on ticks at 1, 2 and 5 times powers of ten while it spans
 * at most {@link FINE_DECADES} decades (powers of ten past that), its ends on
 * the ticks just outside the values; else {@link valueScale}'s linear axis.
 * Durations from a second up tick on the clock ({@link CLOCK_TICKS}: `1m`,
 * `5m`, `1h`) rather than at `16.7m`. The axis reaches `marks` too (reference
 * rules), which never make it logarithmic.
 */
function spanScale(
	values: readonly number[],
	from: number,
	to: number,
	marks: readonly number[] = [],
	dim?: Dimension,
	unit = 1,
): Scale {
	const reach = [...values, ...marks];
	const [min, max] = [Math.min(...reach), Math.max(...reach)];
	if (!(Math.min(...values) > 0) || !(min > 0) || Math.max(...values) / Math.min(...values) < SPAN_LOG)
		return valueScale(reach, from, to, { zero: false, unit });
	const fine = Math.log10(max / min) <= FINE_DECADES;
	const steps = fine ? [1, 2, 5] : [1];
	const grid: number[] = [];
	for (let power = Math.floor(Math.log10(min)); power <= Math.ceil(Math.log10(max)); power++)
		for (const step of steps) {
			const tick = Number((step * 10 ** power).toPrecision(6));
			if (dim !== "duration" || tick < 1 || tick > CLOCK_TICKS.at(-1)!) grid.push(tick);
		}
	if (dim === "duration") grid.push(...(fine ? CLOCK_TICKS : CLOCK_TICKS.filter((_, at) => at % 3 === 0)));
	grid.sort((a, b) => a - b);
	const low = Math.max(...grid.filter(tick => tick <= min * (1 + 1e-9)));
	const high = Math.min(...grid.filter(tick => tick >= max * (1 - 1e-9)));
	const all = grid.filter(tick => tick >= low && tick <= high);
	// Past six decades every other power keeps the labels apart.
	const stride = Math.max(1, Math.ceil(all.length / 7));
	const ticks = all.filter((_, at) => at % stride === 0 || at === all.length - 1);
	const [a, b] = [Math.log10(low), Math.log10(high)];
	return {
		at: value => from + ((Math.log10(Math.max(value, low)) - a) / (b - a || 1)) * (to - from),
		ticks,
		log: true,
	};
}

/**
 * The few values (at most {@link MAX_TIER_SHARE} of them) standing
 * {@link TIER_GAP}× or more above the largest of the rest, at the widest such
 * jump — when the rest still read on a linear axis (spread under
 * `restSpread`, {@link LOG_SPREAD} by default), so breaking the axis beats a
 * logarithmic one; signed bars, never logarithmic, pass no limit.
 */
function outlierTier(values: readonly number[], restSpread = LOG_SPREAD): Tier | undefined {
	if (values.some(value => value < 0)) return undefined;
	const sorted = values.filter(value => value > 0).sort((a, b) => b - a);
	const most = Math.floor(values.length * MAX_TIER_SHARE);
	let best: Tier | undefined;
	let gap = TIER_GAP;
	for (let k = 1; k <= most && k + MIN_BELOW_TIER <= sorted.length; k++) {
		const ratio = sorted[k - 1]! / sorted[k]!;
		if (ratio >= gap) {
			gap = ratio;
			best = { rest: sorted[k]!, low: sorted[k - 1]!, high: sorted[0]! };
		}
	}
	if (!best || best.rest / sorted.at(-1)! >= restSpread) return undefined;
	return best;
}

/**
 * A linear axis from zero over the rest of `tier` up to {@link CUT_AT} of its
 * length, then a gap, then a second linear segment zoomed on the tier, so the
 * outliers neither flatten the rest nor lose their own differences. `nice`
 * rounds the segments' ends out to tick values; without, the largest value of
 * each segment reaches its end (bars in a panel without an axis).
 */
function brokenScale(tier: Tier, from: number, to: number, nice: boolean): Scale {
	const middle = from + (to - from) * CUT_AT;
	const start = middle - (Math.sign(to - from) * CUT_GAP) / 2;
	const end = middle + (Math.sign(to - from) * CUT_GAP) / 2;
	const step = niceStep(tier.rest / 4);
	const top = nice ? Math.ceil(tier.rest / step) * step : tier.rest;
	const spread = tier.high - tier.low;
	const zoom = niceStep(Math.max(spread, tier.high * 0.1) / 2);
	// Zoomed no further than half the tier's peak, so an 8% difference never reads as 80%.
	const floor = Math.min(tier.low - Math.max(spread * 0.25, tier.high * 0.05), tier.high / 2);
	const low = Math.max(top, nice ? Math.floor(floor / zoom) * zoom : floor);
	const high = nice ? Math.ceil(tier.high / zoom) * zoom : tier.high;
	const ticks: number[] = [];
	for (let tick = 0; tick <= top + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
	ticks.push(high);
	return {
		at: value =>
			value <= top
				? from + (Math.max(0, value) / top) * (start - from)
				: end + ((Math.max(value, low) - low) / (high - low || 1)) * (to - end),
		ticks,
		log: false,
		cut: { below: top, start, end },
	};
}

/**
 * Bar ends from `from` to `to` for a panel without an axis: broken over an
 * outlier tier ({@link outlierTier}), else linear from zero (from the
 * smallest value when one is negative). No axis would tell a reader a bar is
 * logarithmic, so lengths stay proportional.
 */
function panelScale(values: readonly number[], from: number, to: number): Scale {
	const tier = outlierTier(values);
	if (tier) return brokenScale(tier, from, to, false);
	const max = Math.max(...values);
	const min = Math.min(0, ...values);
	const span = Number.isFinite(max) && max > min ? max - min : 0;
	return { at: value => from + (span ? (value - min) / span : 1) * (to - from), ticks: [], log: false };
}

/**
 * Fill strength 0–1 of heat cells: from zero, logarithmic over the positive
 * values once they span {@link LOG_SPREAD}× or hold an outlier tier — a zero
 * cell (no reasoning tokens) neither blocks that nor takes a shade — min–max
 * when values go negative.
 */
function shade(values: readonly number[]): (value: number) => number {
	const lowest = Math.min(...values);
	if (lowest < 0) {
		const span = Math.max(...values) - lowest;
		return value => (span ? (value - lowest) / span : 1);
	}
	const positive = values.filter(value => value > 0);
	const max = Math.max(...positive);
	const min = Math.min(...positive);
	if (positive.length < 2 || max === min) return value => (value > 0 ? 1 : 0);
	if (logShaded(values)) {
		const low = Math.log10(min);
		const span = Math.log10(max) - low;
		return value => (value > 0 ? 0.1 + (0.9 * (Math.log10(value) - low)) / span : 0);
	}
	const floor = heatFloor(values);
	return value => Math.max(0, value - floor) / (max - floor);
}

/**
 * Where a linear heat ramp starts: zero, or for values all in a narrow band
 * well above it (scores of 1.8–2.9) a third of the band's width below its
 * least, so the cells spread over the ramp instead of all reading strong.
 */
function heatFloor(values: readonly number[]): number {
	const [min, max] = [Math.min(...values), Math.max(...values)];
	if (!(min > 0 && min >= max * 0.5 && max > min)) return 0;
	// Rounded down to a nice figure, which the ramp's key prints.
	const step = niceStep((max - min) / 4);
	return Math.max(0, Math.floor((min - (max - min) / 3) / step) * step);
}

/** Whether {@link shade} maps `values` logarithmically: non-negative, positive ones spanning decades or an outlier tier. */
function logShaded(values: readonly number[]): boolean {
	const positive = values.filter(value => value > 0);
	if (positive.length < 2 || values.some(value => value < 0)) return false;
	return Math.max(...positive) / Math.min(...positive) >= LOG_SPREAD || outlierTier(values) !== undefined;
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
	const power = 10 ** Math.floor(Math.log10(raw || 1));
	const fraction = raw / power;
	return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/** Gridlines and tick labels under a horizontal value axis; zero, where bars start, draws as a firmer baseline. */
function drawValueAxis(scale: Scale, series: ChartSeries, top: number, bottom: number): string {
	const parts: string[] = [];
	const format = tickFormat(scale, series);
	for (const tick of scale.ticks) {
		const x = scale.at(tick);
		parts.push(tick === 0 && !scale.log ? line(x, top, x, bottom, "border", 1) : rule(x, top, x, bottom));
		// The break mark stands where the first segment's last label would.
		if (tick === scale.cut?.below) continue;
		parts.push(
			text(x, bottom + 12, format(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		);
	}
	if (scale.cut) parts.push(breakMark((scale.cut.start + scale.cut.end) / 2, bottom + 12, 5, "muted"));
	return parts.join("");
}

/** A bar from `zero` to `end` crossing a broken axis: both segments, the gap between them marked. */
function cutBar(cut: Cut, zero: number, end: number, y: number, height: number, fill: string, opacity: number): string {
	return [
		rect(zero, y, cut.start - zero, height, fill, opacity),
		rect(cut.end, y, Math.max(1, end - cut.end), height, fill, opacity),
		breakMark((cut.start + cut.end) / 2, y + height / 2, height / 2 + 1, "muted"),
	].join("");
}

/** Two slanted strokes centred on `x`, `y`: the sign of a broken axis or a bar crossing its gap. */
function breakMark(x: number, y: number, half: number, stroke: string): string {
	const slant = half * 0.55;
	return [-2.5, 2.5]
		.map(offset => line(x + offset - slant, y + half, x + offset + slant, y - half, stroke, 1.25))
		.join("");
}

/**
 * A {@link referenceRule} at each reference category's value of `entry`
 * ({@link ChartSpec.reference}) through the rows of its group (all rows
 * without groups), so the others read as shorter or longer than it; with,
 * per category, the x of its group's rule, which its figure clears.
 */
function referenceRules(
	spec: ChartSpec,
	entry: ChartSeries,
	tops: readonly number[],
	rowHeight: number,
	at: (value: number) => number,
): { readonly body: string; readonly at: readonly (number | undefined)[] } {
	const parts: string[] = [];
	const xs: (number | undefined)[] = spec.categories.map(() => undefined);
	for (const index of spec.reference ?? []) {
		const point = entry.points[index];
		if (!point) continue;
		const [first, last] = groupSpan(spec, index);
		const x = at(point.value);
		xs.fill(x, first, last + 1);
		parts.push(referenceRule(x, tops[first]! + 2, x, tops[last]! + rowHeight - 2));
	}
	return { body: parts.join(""), at: xs };
}

/** First and last category index of the group holding category `at`; every category without groups. */
function groupSpan(spec: ChartSpec, at: number): [number, number] {
	let first = 0;
	for (const group of spec.groups ?? []) {
		const last = first + group.members.length - 1;
		if (at <= last) return [first, last];
		first = last + 1;
	}
	return [0, spec.categories.length - 1];
}

/** Width of one legend entry: its mark (and tone dots), name, and the gap before the next. */
function legendItemWidth(item: LegendItem): number {
	return 12 + 9 * (item.tones?.length ?? 0) + measure(clip(item.name, MAX_LEGEND_CHARS), TICK_SIZE) + 16;
}

/** Width of `items` on one line, without the trailing gap. */
function legendWidth(items: readonly LegendItem[]): number {
	return items.reduce((sum, item) => sum + legendItemWidth(item), 0) - 16;
}

/** Dot-and-name legend wrapping across `left`…`right`, its first line centred on `y`. */
function drawLegend(items: readonly LegendItem[], left: number, right: number, y: number): Layer {
	const parts: string[] = [];
	const labels = clipNames(
		items.map(item => item.name),
		MAX_LEGEND_CHARS,
	);
	let x = left;
	items.forEach((item, at) => {
		const width = legendItemWidth(item);
		if (x + width - 16 > right + 0.5 && x > left) {
			x = left;
			y += LEGEND_LINE;
		}
		parts.push(item.ring ? ring(x + 4, y, 3.25, item.color) : dot(x + 4, y, 4, item.color, item.opacity));
		const tones = item.tones ?? [];
		tones.forEach((tone, slot) => parts.push(dot(x + 13 + slot * 9, y, 4, tone, item.opacity)));
		parts.push(text(x + 12 + 9 * tones.length, y, labels[at]!, { size: TICK_SIZE, fill: "muted" }));
		x += width;
	});
	return { height: y + 8, body: parts.join("") };
}

/** Width of a heat {@link RampKey}: low figure, five swatches, high figure. */
function rampWidth(ramp: RampKey): number {
	return measure(ramp.low, 10) + 6 + 5 * 13 + 4 + measure(ramp.high, 10);
}

/** A heat scale key from `x`, centred on `y`: the low figure, swatches from faint to opaque, the high figure. */
function drawRamp(ramp: RampKey, x: number, y: number): string {
	const parts = [text(x, y, ramp.low, { size: 10, fill: "muted" })];
	let at = x + measure(ramp.low, 10) + 6;
	for (let step = 0; step < 5; step++, at += 13)
		parts.push(rect(at, y - 5, 11, 10, ramp.color, HEAT_FLOOR + ((1 - HEAT_FLOOR) * step) / 4, 2));
	parts.push(text(at + 4, y, ramp.high, { size: 10, fill: "muted" }));
	return parts.join("");
}

/**
 * Each name as the lines its label sets in: whole on one line when it is
 * short or fits {@link WIDE_LABEL_WIDTH}; else, with `wrap`, two lines of
 * {@link LABEL_WIDTH} split where they balance best ({@link wrapLabel});
 * without, one line clipped to {@link WIDE_LABEL_WIDTH} ({@link clipNames}).
 */
function labelLines(names: readonly string[], wrap: boolean): string[][] {
	const wide = Math.floor(WIDE_LABEL_WIDTH / (LABEL_SIZE * ADVANCE));
	const clipped = clipNames(names, wide);
	return names.map((name, at) => {
		if (name.length <= MAX_LABEL_CHARS || measure(name, LABEL_SIZE) <= WIDE_LABEL_WIDTH) return [name];
		if (!wrap) return [fitText(clipped[at]!, WIDE_LABEL_WIDTH, LABEL_SIZE)];
		const lines = wrapLabel(name, LABEL_WIDTH, WRAP_SIZE);
		return lines.length > 1 ? lines : [fitText(name, LABEL_WIDTH, LABEL_SIZE)];
	});
}

/**
 * `name` over two lines of at most `width` at `size`: split after the space
 * (or, in an identifier or path, the `/ . _ - , : +`, before the `(`, or
 * between camel-cased words) that balances the lines best, the second
 * clipped if still too long. A name with no such break clips on one line.
 * Category names ({@link labelLines}) and column headings
 * ({@link wrapHeader}) wrap through it.
 */
function wrapLabel(name: string, width: number, size: number): string[] {
	let best: { lines: string[]; cost: number } | undefined;
	for (let at = 1; at < name.length; at++) {
		const [before, after] = [name[at - 1]!, name[at]!];
		const space = before === " ";
		const camel = /[a-z]/.test(before) && /[A-Z]/.test(after);
		if (!space && !camel && !"/._-,:+".includes(before) && after !== "(") continue;
		const first = name.slice(0, at).trimEnd();
		const second = name.slice(at).trimStart();
		const firstWidth = measure(first, size);
		if (!first || !second || firstWidth > width) continue;
		// The longer line sets the cost (a first line filled as far as it goes where the rest overflows anyway);
		// a break inside an identifier costs a little, so words part at spaces where they can.
		const cost = Math.max(firstWidth, measure(second, size)) + (space ? 0 : 8);
		if (!best || cost < best.cost) best = { lines: [first, fitText(second, width, size)], cost };
	}
	return best?.lines ?? [fitText(name, width, size)];
}

/** Each category's label lines ({@link labelLines}): its own name, or its member name beside a group. */
function categoryLines(spec: ChartSpec): string[][] {
	const names = spec.groups ? spec.groups.flatMap(group => group.members) : spec.categories;
	return labelLines(names, spec.categories.length <= MAX_WRAP_ROWS);
}

/** `row` grown to {@link WRAP_ROW} where a category's name wraps, so both lines fit its row. */
function labelRow(spec: ChartSpec, row: number): number {
	return row < WRAP_ROW && categoryLines(spec).some(lines => lines.length > 1) ? WRAP_ROW : row;
}

/** A label's lines from `x`, centred on `y` as a block: one at {@link LABEL_SIZE}, two at {@link WRAP_SIZE}. */
function labelText(x: number, y: number, lines: readonly string[], style: TextStyle): string {
	if (lines.length === 1) return text(x, y, lines[0]!, style);
	return lines
		.map((line, at) => text(x, y + (at - (lines.length - 1) / 2) * WRAP_LINE, line, { ...style, size: WRAP_SIZE }))
		.join("");
}

/**
 * Category names down the label column, centred on their rows from `tops`;
 * a group's name once, semibold, beside its first member. Names start at the
 * column's left, so one set wider than {@link measure} estimates (another
 * font, a larger size) runs toward the plot instead of off the canvas. Long
 * names wrap to two lines ({@link categoryLines}); the renderer grows its rows
 * to hold them ({@link labelRow}).
 */
function categoryLabels(
	spec: ChartSpec,
	tops: readonly number[],
	rowHeight: number,
	strong: ReadonlySet<number> = new Set(),
): string {
	const middle = (at: number) => tops[at]! + rowHeight / 2;
	const { groups, status } = spec;
	const matrix = matrixDots(spec, middle);
	// A status badge leads the name: a dot in the status color.
	const badges = status?.some(Boolean) ? STATUS_WIDTH : 0;
	const badge = (x: number, at: number) => {
		const state = status?.[at];
		return state ? dot(x + 4, middle(at), 4, STATUS_COLORS[state]) : "";
	};
	const lines = categoryLines(spec);
	if (!groups)
		return (
			matrix +
			lines
				.map(
					(name, at) =>
						badge(PAD, at) +
						labelText(PAD + badges, middle(at), name, {
							fill: "fg",
							weight: strong.has(at) ? 600 : undefined,
						}),
				)
				.join("")
		);
	const memberX = PAD + groupNameWidth(groups) + 10;
	const heads = clipNames(
		groups.map(group => group.name),
		groupChars(groups),
	);
	const parts: string[] = [matrix];
	let at = 0;
	groups.forEach((group, index) => {
		parts.push(text(PAD, middle(at), heads[index]!, { fill: "fg", weight: 600 }));
		for (const end = at + group.members.length; at < end; at++)
			parts.push(
				badge(memberX, at) +
					labelText(memberX + badges, middle(at), lines[at]!, {
						fill: "fg",
						weight: strong.has(at) ? 600 : undefined,
					}),
			);
	});
	return parts.join("");
}

/** Characters a matrix column's heading takes per line, wrapped to two lines at most. */
const MATRIX_HEAD_CHARS = 11;
/** Height of one matrix heading line. */
const MATRIX_LINE = 12;

/** A {@link ChartSpec.matrix} column as drawn: its heading lines and its width. */
interface MatrixColumn {
	readonly lines: readonly string[];
	readonly width: number;
}

/** Each matrix column's heading, wrapped, and the width it takes (the heading's, or a dot's). */
function matrixColumns(spec: ChartSpec): MatrixColumn[] {
	return (spec.matrix ?? []).map(column => {
		const lines = wrapHeader(column.name, MATRIX_HEAD_CHARS * TICK_SIZE * ADVANCE, TICK_SIZE);
		return { lines, width: Math.max(STATUS_WIDTH, ...lines.map(line => measure(line, TICK_SIZE))) + 12 };
	});
}

/** Each matrix column's centre; the matrix closes the label column. */
function matrixCentres(spec: ChartSpec, columns: readonly MatrixColumn[]): number[] {
	let x = PAD + labelColumnWidth(spec) - columns.reduce((sum, column) => sum + column.width, 0);
	return columns.map(column => {
		x += column.width;
		return x - column.width / 2;
	});
}

/**
 * The matrix columns' headings, a muted row between the header and the plot,
 * each centred over its column of dots and bottom-aligned when one wraps; a
 * single plotted series is headed too, at the plot's start, so the bars read
 * as the matrix's last column (no legend names it).
 */
function matrixHead(spec: ChartSpec): { height: number; body: string } {
	const columns = matrixColumns(spec);
	if (columns.length === 0) return { height: 0, body: "" };
	const lines = Math.max(...columns.map(column => column.lines.length));
	const centres = matrixCentres(spec, columns);
	const body = columns.flatMap((column, index) =>
		column.lines.map((line, at) =>
			text(centres[index]!, (lines - column.lines.length + at) * MATRIX_LINE + 6, line, {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		),
	);
	if (spec.series.length === 1)
		body.push(
			text(PAD + labelColumnWidth(spec) + 10, (lines - 1) * MATRIX_LINE + 6, clip(spec.series[0]!.name, 40), {
				size: TICK_SIZE,
				fill: "muted",
			}),
		);
	return { height: lines * MATRIX_LINE + 4, body: body.join("") };
}

/** The matrix's dots, closing the label column: a status color per cell, a faint speck where a cell says none. */
function matrixDots(spec: ChartSpec, middle: (at: number) => number): string {
	const columns = matrixColumns(spec);
	const centres = matrixCentres(spec, columns);
	return (spec.matrix ?? [])
		.flatMap((column, index) =>
			spec.categories.map((_, at) => {
				const state = column.statuses[at];
				return state
					? dot(centres[index]!, middle(at), 4.5, STATUS_COLORS[state])
					: dot(centres[index]!, middle(at), 1.5, "muted", 0.6);
			}),
		)
		.join("");
}

/**
 * Characters a group name may take: {@link MAX_GROUP_CHARS}, or what short
 * members leave of the two budgets together (`canto-identity-protocol` beside `gpt-5.5`).
 */
function groupChars(groups: readonly ChartGroup[]): number {
	const widest = Math.max(
		0,
		...groups.flatMap(group => group.members.map(member => Math.min(member.length, MAX_LABEL_CHARS))),
	);
	return Math.max(MAX_GROUP_CHARS, MAX_LABEL_CHARS + MAX_GROUP_CHARS - widest);
}

/** Top of each category's row from `top`, a {@link GROUP_GAP} parting consecutive groups, then the bottom of the last row. */
function rowTops(spec: ChartSpec, top: number, rowHeight: number): number[] {
	const sizes = spec.groups?.map(group => group.members.length) ?? [spec.categories.length];
	const tops: number[] = [];
	let y = top;
	sizes.forEach((size, index) => {
		if (index > 0) y += GROUP_GAP;
		for (let at = 0; at < size; at++, y += rowHeight) tops.push(y);
	});
	tops.push(y);
	return tops;
}

/** Width of the category label column: the widest name, or the widest group name beside the widest member. */
function labelColumnWidth(spec: ChartSpec): number {
	// One line sets at the label size, a wrapped pair a step smaller.
	const widest = Math.max(
		0,
		...categoryLines(spec).flatMap(lines =>
			lines.map(line => measure(line, lines.length > 1 ? WRAP_SIZE : LABEL_SIZE)),
		),
	);
	const { groups } = spec;
	const width = groups ? groupNameWidth(groups) + 10 + widest : widest;
	const matrix = matrixColumns(spec).reduce((sum, column) => sum + column.width, 0);
	return Math.max(4 * LABEL_SIZE * ADVANCE, width) + (spec.status?.some(Boolean) ? STATUS_WIDTH : 0) + matrix;
}

/** Width of the widest semibold group name. */
function groupNameWidth(groups: readonly ChartGroup[]): number {
	const heads = clipNames(
		groups.map(group => group.name),
		groupChars(groups),
	);
	return Math.max(0, ...heads.map(name => measure(name, LABEL_SIZE) * SEMIBOLD_WIDTH));
}

/**
 * Labels for a linear axis' ticks in one unit, so it reads `0, 5k, 10k`
 * rather than `0, 5000, 10k`; a log axis spans units, each tick in its own.
 * A duration reads in the largest unit its ticks are whole (or half) steps
 * of (`50s, 100s, 150s`, not `0.833m, 1.67m`); sizes the table wrote in
 * binary units (`GiB`) tick in them too, so bars and labels agree.
 */
function tickFormat(
	scale: Scale,
	axis: { readonly dim: Dimension; readonly unit: string; readonly points?: readonly (ChartPoint | null)[] },
): (tick: number) => string {
	const unit = binaryBytes(axis) ? "iB" : axis.unit;
	const format = (ticks: readonly number[], magnitude: number) =>
		formatValue(ticks[0]!, axis.dim, unit, axis.dim === "duration" ? durationMagnitude(ticks, magnitude) : magnitude);
	// A log axis' round thousand reads `1k` beside `10k`, not `1,000`.
	const counted = axis.dim !== "duration" && axis.dim !== "bytes";
	if (scale.log)
		return tick => format([tick], counted && Math.abs(tick) >= 1000 ? Math.max(1e4, Math.abs(tick)) : Math.abs(tick));
	const magnitude = Math.max(0, ...scale.ticks.map(Math.abs));
	const { cut } = scale;
	// Each segment of a broken axis reads in its own unit (`100k` before the break, `7M` after).
	if (cut) return tick => format([tick, ...scale.ticks], tick <= cut.below ? cut.below : magnitude);
	return tick => format([tick, ...scale.ticks], magnitude);
}

/** Whether `axis` holds sizes the table wrote in binary units (`GiB`, `MiB`), which its ticks then read in too. */
function binaryBytes(axis: { readonly dim: Dimension; readonly points?: readonly (ChartPoint | null)[] }): boolean {
	return axis.dim === "bytes" && !!axis.points?.some(point => point && /[KMGTP]iB/i.test(point.text));
}

/**
 * One tick unit for an axis of `series` over `values`, in base units: the
 * binary size unit the largest value reads in (1 GiB) where the table wrote
 * binary sizes, so ticks fall on `25 GiB` rather than `23.3 GiB`; else 1.
 */
function tickUnit(series: ChartSeries, values: readonly number[]): number {
	if (!binaryBytes(series)) return 1;
	const max = Math.max(0, ...values.map(Math.abs));
	let unit = 1;
	while (unit * 1024 <= max) unit *= 1024;
	return unit;
}

/** Durations' units: each one's length in seconds and the least magnitude that reads in it. */
const DURATION_UNITS: readonly (readonly [seconds: number, suffix: string, from: number])[] = [
	[1e-9, "ns", 0],
	[1e-6, "µs", 1e-6],
	[1e-3, "ms", 1e-3],
	[1, "s", 1],
	[60, "m", 120],
	[3600, "h", 7200],
	[86_400, "d", 172_800],
];

/** The {@link DURATION_UNITS} entry `magnitude` reads in; zero reads in seconds. */
function durationUnit(magnitude: number): readonly [number, string, number] {
	if (magnitude === 0) return DURATION_UNITS[3]!;
	return DURATION_UNITS.findLast(([, , from]) => magnitude >= from) ?? DURATION_UNITS[0]!;
}

/**
 * A magnitude for {@link formatValue} that reads `ticks` in the largest unit
 * up to `magnitude`'s in which each is a whole or half step (`150s`, not `2.5m`
 * beside `0.833m`).
 */
function durationMagnitude(ticks: readonly number[], magnitude: number): number {
	const clean = (seconds: number) =>
		ticks.every(tick => {
			const count = tick / seconds;
			return Math.abs(count * 2 - Math.round(count * 2)) < 1e-6 && Math.abs(count) < 10_000;
		});
	const own = DURATION_UNITS.indexOf(durationUnit(magnitude));
	// Down to seconds at most (smaller units only ever read sub-second axes); where no unit reads clean, the own one.
	for (let index = own; index >= 3; index--) {
		const [seconds, , from] = DURATION_UNITS[index]!;
		if (clean(seconds)) return Math.max(seconds, from);
	}
	return magnitude;
}

/** A point's written figure, or its value formatted when the table wrote none. */
function pointText(series: ChartSeries, at: number): string {
	const point: ChartPoint | null | undefined = series.points[at];
	if (!point) return "";
	return point.text || formatValue(point.value, series.dim, binaryBytes(series) ? "iB" : series.unit);
}

/**
 * A value in base units as an axis label: durations and sizes in the unit,
 * counts compacted under the suffix (`12k`, `3.4M`), that `magnitude` reads
 * best in — the value's own size by default, an axis' largest tick to keep
 * its labels in one unit. Sizes read in decimal units (`20 GB`), or binary
 * ones (`16 GiB`) when `unit` is `iB`.
 */
export function formatValue(value: number, dim: Dimension, unit: string, magnitude = Math.abs(value)): string {
	switch (dim) {
		case "percent":
			return `${compact(value, magnitude)}%`;
		case "ratio":
			return `${compact(value, magnitude)}×`;
		case "currency":
			return `${value < 0 ? "-" : ""}${unit}${compact(Math.abs(value), magnitude)}`;
		case "duration": {
			const [divisor, suffix] = durationUnit(magnitude);
			return `${compact(value / divisor)}${suffix}`;
		}
		case "bytes": {
			const binary = unit === "iB";
			const base = binary ? 1024 : 1000;
			const units = binary ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "KB", "MB", "GB", "TB"];
			let index = 0;
			while (magnitude >= base ** (index + 1) && index < units.length - 1) index++;
			return `${compact(value / base ** index)} ${units[index]}`;
		}
		default:
			return compact(value, magnitude);
	}
}

/** `1234567` → `1.2M`, `0.0123` → `0.012`; the suffix follows `magnitude` (`5000` → `5k` beside `10k`). */
function compact(value: number, magnitude = Math.abs(value)): string {
	if (value === 0) return "0";
	if (magnitude >= 1e9) return `${trim(value / 1e9)}B`;
	if (magnitude >= 1e6) return `${trim(value / 1e6)}M`;
	if (magnitude >= 1e4) return `${trim(value / 1e3)}k`;
	return trim(value);
}

/** `value` to three significant digits or so; thousands take a separator (`2,500`). */
function trim(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude >= 1000) return Math.round(value).toLocaleString("en-US");
	const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
	return Number(value.toFixed(digits)).toString();
}

/** Narrow and wide glyphs of a UI sans (Geist, SF Pro, Helvetica Neue), for {@link measure}. */
const NARROW = "iljtfrI.,:;'!|()[] ";
const WIDE = "mwMW%@—";

/** Estimated width of `content` set in the chart's sans at `size`. */
function measure(content: string, size: number): number {
	let em = 0;
	for (const char of content) {
		if (NARROW.includes(char)) em += 0.3;
		else if (WIDE.includes(char)) em += 0.85;
		else if (char >= "0" && char <= "9") em += 0.58;
		else if (char >= "A" && char <= "Z") em += 0.66;
		else if (char.codePointAt(0)! >= 0x1100) em += 1;
		else em += 0.53;
	}
	return em * size;
}

function clip(content: string, chars: number): string {
	return content.length <= chars ? content : `${content.slice(0, Math.max(1, chars - 1))}…`;
}

/** `content` clipped to fit `width` user units at `size` (an em scale; pass the semibold width for bold text). */
function fitText(content: string, width: number, size: number): string {
	let chars = content.length;
	while (chars > 1 && measure(clip(content, chars), size) > width) chars--;
	return clip(content, chars);
}

/**
 * Category names clipped to `chars`, keeping their start; where two clip to
 * one label, an identifier or path (no spaces) keeps both ends instead
 * (`V12X_DAEM…TENV_DEV`), the end being where such names differ.
 */
function clipNames(names: readonly string[], chars: number): string[] {
	const clipped = names.map(name => clip(name, chars));
	const owners = new Map<string, string>();
	const clashing = new Set<string>();
	clipped.forEach((label, at) => {
		const owner = owners.get(label);
		if (owner === undefined) owners.set(label, names[at]!);
		else if (owner !== names[at]) clashing.add(label);
	});
	if (clashing.size === 0 || chars < 7) return clipped;
	const head = Math.ceil((chars - 1) / 2);
	return clipped.map((label, at) => {
		const name = names[at]!;
		if (!clashing.has(label) || /\s/.test(name)) return label;
		return `${name.slice(0, head)}…${name.slice(name.length - (chars - 1 - head))}`;
	});
}

function token(name: string): string {
	return `var(--${name})`;
}

function num(value: number): string {
	return Number(value.toFixed(1)).toString();
}

interface TextStyle {
	size?: number;
	fill: string;
	anchor?: "start" | "middle" | "end";
	weight?: number;
	italic?: boolean;
}

/** A stretch of one {@link text} set apart from the rest: its own color and/or weight. */
interface TextRun {
	readonly content: string;
	readonly fill?: string;
	readonly weight?: number;
}

/**
 * Text vertically centred on `y`: one string, or {@link TextRun}s set in a
 * line, each in its own color or weight where it states one (a title's key
 * figure, each figure of `a · b` in its series' color).
 */
function text(x: number, y: number, content: string | readonly TextRun[], style: TextStyle): string {
	const runs: readonly TextRun[] = typeof content === "string" ? [{ content }] : content;
	if (!runs.some(run => run.content)) return "";
	const size = style.size ?? LABEL_SIZE;
	const attrs = [
		`x="${num(x)}"`,
		`y="${num(y + size * 0.35)}"`,
		`fill="${token(style.fill)}"`,
		size === LABEL_SIZE ? "" : `font-size="${size}"`,
		style.anchor && style.anchor !== "start" ? `text-anchor="${style.anchor}"` : "",
		style.weight ? `font-weight="${style.weight}"` : "",
		style.italic ? `font-style="italic"` : "",
	].filter(Boolean);
	const escape = (raw: string) =>
		raw.replace(/[&<>"]/g, char =>
			char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
		);
	const body = runs
		.filter(run => run.content)
		.map(run => {
			const own = [
				run.fill ? ` fill="${token(run.fill)}"` : "",
				run.weight ? ` font-weight="${run.weight}"` : "",
			].join("");
			return own ? `<tspan${own}>${escape(run.content)}</tspan>` : escape(run.content);
		})
		.join("");
	return `<text ${attrs.join(" ")}>${body}</text>`;
}

/**
 * Text in a dark ink that reads on a strong fill of a series color in either
 * theme: series colors are bright on dark themes and mid-tone on light ones,
 * so the ink must be dark in both, yet neither `fg` (light on dark themes)
 * nor `surface` (light on light themes) is. The text draws in `fg`, then
 * twice in `surface` through a mask of `fg`'s own luminance: a light `fg`
 * (dark theme) lets the dark `surface` cover it, a dark `fg` (light theme)
 * masks it away and leaves `fg` itself. Tokens only, no theme branch.
 */
function ink(x: number, y: number, content: string, style: TextStyle): string {
	if (!content) return "";
	const cover = text(x, y, content, { ...style, fill: "surface" }).replace(
		"<text ",
		`<text mask="url(#${INK_MASK})" `,
	);
	return text(x, y, content, { ...style, fill: "fg" }) + cover + cover;
}

/** The mask {@link ink} draws through: `fg` everywhere, so its luminance decides how much `surface` covers. */
const INK_DEFS = `<defs><mask id="${INK_MASK}"><rect x="-10000" y="-10000" width="20000" height="20000" fill="var(--fg)"/></mask></defs>`;

/**
 * Annotation primitive: a soft `surface` band behind a highlighted row (or
 * column), under the marks and labels drawn after it.
 */
function band(x: number, y: number, width: number, height: number): string {
	return rect(x, y, width, height, "surface", 0.55, 4);
}

/** Annotation primitive: a dashed reference rule (a budget, a baseline value) over the gridlines. */
function referenceRule(x1: number, y1: number, x2: number, y2: number): string {
	return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${token("fg")}" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="0.6"/>`;
}

/**
 * Annotation primitive: a callout — semibold `note` at `x`, joined to the mark
 * it explains by a dotted leader from `from` (both centred on `y`).
 */
function callout(from: number, y: number, x: number, note: string): string {
	const leader =
		x - 4 > from + 2
			? `<line x1="${num(from)}" y1="${num(y)}" x2="${num(x - 4)}" y2="${num(y)}" stroke="${token("muted")}" stroke-width="1" stroke-dasharray="1 2"/>`
			: "";
	return leader + text(x, y, note, { size: TICK_SIZE, fill: "fg", weight: 600 });
}

/**
 * A status word or prose standing where a cell holds no number: known
 * statuses ({@link cellStatus}) take their color, other short all-caps words
 * (`MISS`) warn, prose (`Binary blob churn`) recedes in muted italics.
 */
function noteText(x: number, y: number, note: string, centred = false): string {
	// A status word (`FAIL`, `ok`, `pending`) takes its status color.
	const said = cellStatus(note);
	const status = said !== undefined || /^[A-Z0-9 _/!-]{1,12}$/.test(note);
	return text(x, y, note, {
		size: TICK_SIZE,
		fill: said ? STATUS_COLORS[said] : status ? "warning" : "muted",
		italic: !status,
		anchor: centred ? "middle" : undefined,
	});
}

/** An occupied rectangle, for keeping labels apart. */
interface Box {
	readonly x0: number;
	readonly y0: number;
	readonly x1: number;
	readonly y1: number;
}

/** A rectangle with corners rounded by `corner` ({@link RADIUS} by default), less for one too small to hold it. */
function rect(
	x: number,
	y: number,
	width: number,
	height: number,
	fill: string,
	opacity: number,
	corner = RADIUS,
): string {
	const w = Math.max(0, width);
	const radius = Math.min(corner, w / 2, height / 2);
	const rounded = radius >= 0.5 ? ` rx="${num(radius)}"` : "";
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(height)}"${rounded} fill="${token(fill)}"${alpha}/>`;
}

/**
 * Indices of `entry`'s estimated figures (`~15`, `≈2k`) — only where they
 * are the exceptions among measured ones; a series of mostly estimates marks
 * none, since its few measured figures would then look like the odd ones.
 * A bolded figure keeps its solid bar: the table's emphasis outranks its doubt.
 */
function estimatedPoints(entry: ChartSeries): Set<number> {
	const estimated = (point: ChartPoint | null | undefined) => !!point && /^\s*[~≈]/.test(point.text);
	const marked = entry.points.flatMap((point, at) => (estimated(point) && !point?.emphasis ? [at] : []));
	const measured = entry.points.filter(point => point && !estimated(point)).length;
	return new Set(marked.length <= measured ? marked : []);
}

/**
 * A value's bar: a {@link rect}, or with `estimate` a faint fill
 * ({@link ESTIMATE_OPACITY}) inside a dashed outline of its color, so an
 * estimate reads as less certain than the measured bars beside it.
 */
function barRect(
	x: number,
	y: number,
	width: number,
	height: number,
	fill: string,
	opacity: number,
	options: { estimate?: boolean } = {},
): string {
	if (!options.estimate) return rect(x, y, width, height, fill, opacity);
	const radius = Math.min(RADIUS, width / 2, height / 2);
	return (
		rect(x, y, width, height, fill, opacity * ESTIMATE_OPACITY) +
		`<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(Math.max(0, width - 1))}" height="${num(height - 1)}" rx="${num(radius)}" fill="none" stroke="${token(fill)}" stroke-opacity="${Number(opacity.toFixed(2))}" stroke-width="1" stroke-dasharray="3 2"/>`
	);
}

/** A round-capped line. */
function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, opacity = 1): string {
	const alpha = opacity < 1 ? ` stroke-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${token(stroke)}" stroke-width="${width}" stroke-linecap="round"${alpha}/>`;
}

/** A gridline: a hairline that recedes behind the marks. */
function rule(x1: number, y1: number, x2: number, y2: number): string {
	return line(x1, y1, x2, y2, "border", 1, GRID_OPACITY);
}

/** A rectangle's outline with corners rounded by {@link RADIUS}: the best cell of a heatmap column. */
function outline(x: number, y: number, width: number, height: number, stroke: string): string {
	return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="4" fill="none" stroke="${token(stroke)}" stroke-width="1.5"/>`;
}

/**
 * The `best` mark beside a series' best value: small regular type in the
 * success color, a footnote to the figure (already semibold) rather than a
 * second headline competing with the title and the bolded rows.
 */
function bestTag(x: number, y: number, size: number): string {
	return text(x, y, "best", { size: size - 1.5, fill: "success" });
}

/**
 * The color a move by `factor` takes for a measure of `polarity`: `success`
 * when it improves, `error` when it regresses; none for a neutral measure or
 * a move within {@link STILL}.
 */
function moveTone(polarity: Polarity | undefined, factor: number): string | undefined {
	if (!polarity || !Number.isFinite(factor) || factor < 0) return undefined;
	// A drop to zero has no log, but it is a move all the same.
	if (factor > 0 && Math.abs(Math.log(factor)) < Math.log(STILL)) return undefined;
	return factor > 1 === (polarity === "higher") ? "success" : "error";
}

/** A hollow circle: a transition's starting value, or its legend mark. */
function ring(x: number, y: number, radius: number, stroke: string): string {
	return `<circle cx="${num(x)}" cy="${num(y)}" r="${radius}" fill="none" stroke="${token(stroke)}" stroke-width="1.75"/>`;
}

function dot(x: number, y: number, radius: number, fill: string, opacity = 1): string {
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<circle cx="${num(x)}" cy="${num(y)}" r="${radius}" fill="${token(fill)}"${alpha}/>`;
}
