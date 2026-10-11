/**
 * Numeric reading of GFM table cells and columns, the input to
 * {@link planChart}: what number a cell holds (in base units, with its
 * dimension and annotations) and which role each column plays — a measure to
 * plot, a category label, an ordered x axis, or a row index to ignore.
 *
 * Cells are model-written prose, not CSV: `~1,400`, `**4** ✅`, `17 (21.5%)`,
 * `24–72 h`, `12 → 15`, `5/8`, `1m 56s`, `TIMEOUT`. The reader keeps the first
 * number and its unit and classifies the rest, so a column of mostly clean
 * numbers survives a few annotated or sentinel cells.
 */

/** What a number measures; values of one dimension share an axis after unit normalization. */
export type Dimension = "count" | "percent" | "duration" | "bytes" | "currency" | "ratio" | "fraction" | "rate";

/**
 * How cleanly a cell reads as its number: bare (`12 ms`), with a short note
 * (`17 (21.5%)`, `16 pass`), a range (`24–72 h`), a transition (`12 → 15`), a
 * fraction (`5/8`), or a number leading prose (`~1,400w, nearly ready`).
 */
export type CellFit = "pure" | "note" | "range" | "arrow" | "fraction" | "prose";

/** A cell that reads as a number. */
export interface NumberCell {
	readonly kind: "number";
	/** Value in base units: seconds, bytes, a plain count, percent points. */
	readonly value: number;
	readonly dim: Dimension;
	/** Unit or currency symbol as written (`ms`, `KiB`, `$`, `tok/s`); empty for bare numbers. */
	readonly unit: string;
	readonly fit: CellFit;
	/** Written as an estimate or bound (`~`, `≈`, `<`, `≥`). */
	readonly approx: boolean;
	/** Written with an explicit sign (`+12%`, `-3`). */
	readonly signed: boolean;
	/** The cell was bolded: models bold the value they want noticed. */
	readonly emphasis: boolean;
	/** The cell text without Markdown decoration. */
	readonly text: string;
	/** The number as written, with approximation, sign, currency and unit (`~$250`, `12.5 ms`, `24–72 h`). */
	readonly figure: string;
	/** `a → b`: `b`, in the same base units. */
	readonly to?: number;
	/** `a → b`: `b` as written. */
	readonly toFigure?: string;
	/** `a–b`: `b`, in the same base units. */
	readonly upper?: number;
	/**
	 * `a/b`: `b`. {@link analyzeTable} reads a score (`12/12`, `154/160`, a mean
	 * like `0.6/4`) as the percent of `b` reached, unless its column also holds a
	 * plain fraction; a pair (`85 / 147` under `Edit / read calls`) keeps `a`.
	 */
	readonly denominator?: number;
	/**
	 * `a ± e` (`3.67s ± 0.69`, `~404ms ± 60`, `$0.72 (±0.16)`): `e`, in the same base units — the
	 * spread the table states around the value; {@link figure} then writes both (`3.67s ± 0.69`).
	 */
	readonly error?: number;
	/**
	 * A slash list of measurements in one unit (`79 / 124 µs`, `1,864 ms /
	 * 2,678 ms`, `**675ms** / 680ms`): every listed value, the first included,
	 * in base units, 2–4 of them. `value` is the first.
	 */
	readonly values?: readonly number[];
}

/** A cell that is not a quantity. */
export interface OtherCell {
	readonly kind: "missing" | "date" | "time" | "version" | "id" | "text";
	readonly text: string;
	readonly emphasis: boolean;
}

export type Cell = NumberCell | OtherCell;

/**
 * What a column contributes to a chart: `measure` values to plot, `label`
 * category names, `temporal` dates or times, `sequence` an ordered step
 * (`Run`, `Day`, `Workers`), `index` a row number or identifier never plotted.
 */
export type ColumnRole = "measure" | "label" | "temporal" | "sequence" | "index";

export interface TableColumn {
	readonly index: number;
	/** Header text without Markdown decoration. */
	readonly header: string;
	readonly role: ColumnRole;
	readonly cells: readonly Cell[];
	/** Dominant dimension of the numeric cells. */
	readonly dim: Dimension | undefined;
	/** Representative unit of the dominant dimension (`$`, `tok/s`); empty when bare. */
	readonly unit: string;
	/** Numeric cells disagree on dimension (a metric-per-row table). */
	readonly mixed: boolean;
	/** Numeric cells are mostly scores out of a total (`12/12`), read as percent of it. */
	readonly scores: boolean;
	/**
	 * Per row, the status its cell leads with ({@link cellStatus}), when most
	 * of the column's cells lead with one: a pass/fail or progress column.
	 */
	readonly statuses?: readonly (Status | undefined)[];
	/** Every numeric data cell holds the same value: an echoed setting, not a measure. */
	readonly constant: boolean;
	/** Share of numeric cells written with an explicit sign. */
	readonly signedShare: number;
	/** Share of numeric cells written as `a → b`. */
	readonly arrowShare: number;
	/**
	 * Index of the measure column this one restates, read from the values: a
	 * proportional copy (`pass` 33/38 beside `pass%` 87%, `Samples` beside `% of
	 * Total`, `Leverage vs $200` beside the cost) or a running total of it
	 * (`Offset` summing `Verts`). Such a column is never a measure of its own.
	 */
	readonly restates?: number;
}

/**
 * Measure columns that add up, read from the values: leaf `parts` summing to
 * `whole` in every row (`Cached + Uncached input = Input`, `Input + Output =
 * Total` → parts Cached, Uncached input, Output of Total), or — when not
 * `exact` — parts falling within a `Total` column, the rest unlisted (`New +
 * Edited ≤ Prose total`).
 */
export interface Composition {
	/** Column the parts make up; absent when only a judge says the parts form a whole. */
	readonly whole: number | undefined;
	/** Leaf part columns, in table order. */
	readonly parts: readonly number[];
	/** The parts sum to the whole within the written precision in every row. */
	readonly exact: boolean;
}

/** A table read for charting. */
export interface TableAnalysis {
	readonly columns: readonly TableColumn[];
	/**
	 * Category labels: the first text or temporal column not made only of codes
	 * (`#2233`, `00`), else the first text column, else a sequence or index column.
	 */
	readonly label: TableColumn | undefined;
	/** Plottable measure columns, constant ones excluded. */
	readonly measures: readonly TableColumn[];
	/** Data rows, in table order, without total/summary rows. */
	readonly rows: readonly number[];
	/** Total/summary rows (`Total`, `Average`, …), kept out of the scale. */
	readonly totals: readonly number[];
	/** Measure columns adding up to a whole, when the values show it. */
	readonly composition?: Composition;
}

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+`;
const CELL = new RegExp(
	String.raw`^(?<approx>~|≈|<=|>=|<|>|≤|≥)?\s*(?<sign>[+\-−±])?\s*(?<cur>[$€£¥])?\s*(?<num>${NUMBER})(?<plus>\+(?=\s*[A-Za-zµμ%]))?\s*(?<unit>%|[A-Za-zµμ×]+(?:\/[A-Za-z]+)?|\/s)?(?<rest>.*)$`,
);
const FRACTION = new RegExp(String.raw`^(${NUMBER})\s*\/\s*(${NUMBER})(?![\d/])(.*)$`);
const RANGE_TAIL = new RegExp(String.raw`^[-–—]\s*[~≈]?\s*[$€£¥]?\s*(${NUMBER})\s*(%|[A-Za-zµμ×]+)?`);
const ARROW_TAIL = new RegExp(String.raw`^(?:→|->|⇒)\s*[~≈]?\s*([+\-−])?\s*[$€£¥]?\s*(${NUMBER})\s*(%|[A-Za-zµμ×]+)?`);
/** The stated spread after a value: `± 0.69`, `±.074`, `(±0.16)`, `± 2.9 t/s`. */
const ERROR_TAIL = new RegExp(String.raw`^\(?\s*±\s*(${NUMBER})\s*(%|[A-Za-zµμ]+(?:\/[A-Za-z]+)?)?\s*\)?$`);
const COMPOUND_DURATION =
	/^(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/;
const DATE =
	/^\d{4}-\d{2}(?:-\d{2})?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b|^\d{1,2}\/\d{1,2}\/\d{2,4}$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:am|pm)?$/i;
const VERSION = /^v?\d+\.\d+\.\d+|^v\d/i;
/** `#12`, a bare hex hash, a hash leading its subject (`42e18af0 (Responses API)`), `PR #3`, `L42`. */
const IDENTIFIER =
	/^(?:#\d+|[0-9a-f]{7,40}$|(?=[0-9a-f]{7,40}\s)(?=\d*[a-f])(?=[a-f]*\d)[0-9a-f]{7,40}\s|PR\s*#?\d+|L\d+\b)/i;
/** One number of a slash list or a sum, as written: estimate mark, sign, currency, number, unit or noun. */
const ITEM = new RegExp(
	String.raw`(?<approx>[~≈])?\s*(?<sign>[+\-−])?\s*(?<cur>[$€£¥])?\s*(?<num>${NUMBER})\s*(?<unit>%|[A-Za-zµμ×]+(?:\/[A-Za-z]+)?)?`,
	"y",
);
/** Between the items of a slash list (`79 / 124 µs`, `9/47/85`). */
const LIST_SEPARATOR = /\s*\/\s*/y;
/** Between the terms of a sum (`27.8 GB + 4.1 GB`, `4 hooks + 9 overlays`). */
const SUM_SEPARATOR = /\s*\+\s*/y;
/** The total a sum is written to equal (`… = 14 files`). */
const SUM_TOTAL = /\s*=\s*/y;
/** A cell that is one Markdown link, bold or not, and nothing else. */
const LINKED = /^\s*(?:\*\*|__)?\[[^\]]*\]\([^)]*\)(?:\*\*|__)?\s*$/;
/** Most values one slash list holds; longer lists are prose. */
const MAX_LISTED_VALUES = 4;
/** Spread (max/min) within which a bare slash list repeats one measurement rather than listing different things. */
const ALIKE_SPREAD = 3;
/** Cell texts that stand for "no value". */
const MISSING: Readonly<Record<string, true>> = {
	"": true,
	"-": true,
	"—": true,
	"–": true,
	"−": true,
	"n/a": true,
	na: true,
	none: true,
	"?": true,
	"…": true,
	"...": true,
	null: true,
	nan: true,
	tbd: true,
	"·": true,
	x: true,
	"✗": true,
};
/**
 * What a status cell (`ok`, `FAIL`, `pending`, ✅) says about its row: `good`
 * passed or landed, `bad` failed or broke, `warn` partly or flaky, `pending`
 * not settled yet.
 */
export type Status = "good" | "bad" | "warn" | "pending";
/** Leading status words, matched whole and case-insensitively. */
const STATUS_WORDS: Readonly<Record<string, Status>> = {
	ok: "good",
	pass: "good",
	passed: "good",
	passes: "good",
	passing: "good",
	success: "good",
	succeeded: "good",
	done: "good",
	complete: "good",
	completed: "good",
	landed: "good",
	merged: "good",
	fixed: "good",
	works: "good",
	working: "good",
	green: "good",
	fail: "bad",
	failed: "bad",
	fails: "bad",
	failing: "bad",
	failure: "bad",
	error: "bad",
	errored: "bad",
	broken: "bad",
	timeout: "bad",
	"timed out": "bad",
	crash: "bad",
	crashed: "bad",
	oom: "bad",
	panic: "bad",
	red: "bad",
	blocked: "bad",
	truncated: "bad",
	partial: "warn",
	flaky: "warn",
	degraded: "warn",
	pending: "pending",
	running: "pending",
	waiting: "pending",
	queued: "pending",
	skipped: "pending",
	wip: "pending",
	"in progress": "pending",
};
/** Leading status marks. */
const STATUS_MARKS: readonly (readonly [RegExp, Status])[] = [
	[/^[✅✓✔🟢]/u, "good"],
	[/^[❌✗✘🔴]/u, "bad"],
	[/^[⚠🟡]/u, "warn"],
	[/^[⏳🕐]/u, "pending"],
];
const STATUS_WORD = new RegExp(
	String.raw`^(?:${Object.keys(STATUS_WORDS)
		.sort((a, b) => b.length - a.length)
		.join("|")})(?![\w-])`,
	"i",
);

/**
 * The status a cell's text leads with (`FAIL`, `✓ via mmdc`, `**pending**`,
 * `1 ok`), or `undefined` for any other text. A count before the word
 * (`3 ok`) still reads as the word's status.
 */
export function cellStatus(text: string): Status | undefined {
	const trimmed = plainCell(text).text.trim();
	for (const [mark, status] of STATUS_MARKS) if (mark.test(trimmed)) return status;
	const word = STATUS_WORD.exec(trimmed.replace(/^\d+\s+/, ""));
	return word ? STATUS_WORDS[word[0].toLowerCase()] : undefined;
}

/** `~Sort of (bad coords)` in a column of ✓ and ✗: a tilde before words hedges the verdict, read as `warn`. */
const HEDGE = /^~\s*\p{L}/u;

/** Status and trend marks that decorate a value without changing it (`**4** ✅`, `⚠️ 12`, `6 ↓`, `32 ▲`). */
const MARKS = /[✅❌⚠🟢🔴🟡✓✗✔★⭐↑↓⬆⬇▲▼]|\uFE0E|\uFE0F/gu;
/** Footnote marks after a value (`165*`, `12 ms†`): the value stands as written. */
const FOOTNOTE = /^[*†‡]+$/;
/** A whole number written with a leading zero (`03`, `004,006`): a code or a list of codes, never a quantity. */
const ZERO_PADDED = /^0\d/;
/** HTML tags a Markdown cell may carry; other `<…>` (`<cwd>`, `<T>`) is literal text. */
const HTML_TAG =
	/<\/?(?:a|abbr|b|br|code|del|details|div|em|i|img|ins|kbd|mark|p|s|small|span|strong|sub|summary|sup|u)\b[^>]*>/gi;

/** Unit → dimension and factor to base units. Matched case-insensitively unless listed in {@link CASED_UNITS}. */
const UNITS: Readonly<Record<string, readonly [Dimension, number]>> = {
	"%": ["percent", 1],
	pp: ["percent", 1],
	pct: ["percent", 1],
	ns: ["duration", 1e-9],
	µs: ["duration", 1e-6],
	μs: ["duration", 1e-6],
	us: ["duration", 1e-6],
	ms: ["duration", 1e-3],
	s: ["duration", 1],
	sec: ["duration", 1],
	secs: ["duration", 1],
	seconds: ["duration", 1],
	min: ["duration", 60],
	mins: ["duration", 60],
	minutes: ["duration", 60],
	h: ["duration", 3600],
	hr: ["duration", 3600],
	hrs: ["duration", 3600],
	hours: ["duration", 3600],
	d: ["duration", 86_400],
	days: ["duration", 86_400],
	bytes: ["bytes", 1],
	kb: ["bytes", 1e3],
	kib: ["bytes", 1024],
	mb: ["bytes", 1e6],
	mib: ["bytes", 1024 ** 2],
	gb: ["bytes", 1e9],
	gib: ["bytes", 1024 ** 3],
	tb: ["bytes", 1e12],
	tib: ["bytes", 1024 ** 4],
	x: ["ratio", 1],
	"×": ["ratio", 1],
	k: ["count", 1e3],
	bn: ["count", 1e9],
};
/**
 * Units whose case decides their meaning: `B` bytes vs `b` billions, `M`
 * millions vs `m` minutes; `G` and `T` are giga and tera of a count until
 * {@link resolveMagnitudes} reads them as sizes.
 */
const CASED_UNITS: Readonly<Record<string, readonly [Dimension, number]>> = {
	B: ["bytes", 1],
	b: ["count", 1e9],
	M: ["count", 1e6],
	m: ["duration", 60],
	G: ["count", 1e9],
	T: ["count", 1e12],
};

/**
 * Header names of row numbers and identifiers: never plotted, never a category
 * axis when text exists. A header ending in an identifier noun (`New version`,
 * `Issue ID`) counts too; either only for plain numbers, so `PR | 20 ms` stays a measure.
 */
const INDEX_HEADER =
	/^(?:#|no\.?|n°|id|ids|rank|row|idx|index|line|lines?\s*#|ln|pr|pr\s*#|issue|commit|sha|hash|port|pid|code|exit\s*code|status|version|ver|ref|offset|priority|prio)$|\s(?:id|ids|version|ver|sha|hash|pid|port)$/i;
/** Header names of ordered steps: with monotonic values, a valid x axis for a line chart. */
const SEQUENCE_HEADER =
	/^(?:step|phase|stage|round|tier|level|wave|pass|attempt|iter|iteration|epoch|run|batch|day|week|month|year|quarter|n|workers?|threads?|concurrency|jobs|depth|k)$/i;
/**
 * Row labels that summarize the rows above them: `Total …` in any wording, an
 * average only as a bare label (`Mean latency` is a metric, `Mean` a summary).
 */
const TOTAL_ROW =
	/^(?:(?:total|totals|sum|overall|grand total|subtotal|σ)\b|(?:average|avg|mean|median|all|combined|net)\s*(?:\(.*\))?:?$)/i;
/**
 * Summary labels that say nothing else (`Total`, `**Grand total**`, `Median:`), which sum or average the
 * rows above them wherever they stand. Longer names (`Total spend`, `Totals by agent`) and words that also
 * name options (`all`, `net`, `combined`) summarize only at the table's start or end.
 */
const BARE_TOTAL = /^(?:total|totals|sum|grand total|sub-?total|σ|average|avg|mean|median)\s*(?:\(.*\))?:?$/i;
/** Relative slack within which a total row's figure matches the sum of the rows above it. */
const APPROX_TOTAL = 0.005;

/**
 * Strip inline Markdown from a cell: links keep their text; bold, italics,
 * strikethrough, code spans and `<br>` keep their content.
 */
export function plainCell(markdown: string): { text: string; emphasis: boolean } {
	let text = markdown.replace(/\\\|/g, "|");
	// A closed pair: `__advisor*.jsonl` holds underscores, not bold.
	const emphasis = /(\*\*|__)(?=\S).*?\S\1/.test(text);
	// Code spans are literal: `sessions/<cwd>/*.jsonl` keeps its `<cwd>` and `*`.
	const spans: string[] = [];
	text = text
		.replace(/`([^`]*)`/g, (_, code: string) => `\u0000${spans.push(code) - 1}\u0000`)
		// A backslash escape (`\$12.50`, `\*`) is its character, never markup.
		.replace(/\\([!-/:-@[-`{-~])/g, (_, escaped: string) => `\u0000${spans.push(escaped) - 1}\u0000`)
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
		.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(HTML_TAG, "")
		.replace(/\u0000(\d+)\u0000/g, (_, at: string) => spans[Number(at)]!)
		.replace(/\s+/g, " ")
		.trim();
	return { text, emphasis };
}

/** Parse the first number of a (Markdown) cell, or classify why it is not one. */
export function parseCell(markdown: string): Cell {
	const plain = plainCell(markdown);
	const text = plain.text.replace(MARKS, "").replace(/\s+/g, " ").trim();
	const emphasis = plain.emphasis;
	const other = (kind: OtherCell["kind"]): OtherCell => ({ kind, text: plain.text, emphasis });
	if (Object.hasOwn(MISSING, text.toLowerCase())) return other("missing");
	if (DATE.test(text)) return other("date");
	if (TIME.test(text)) return other("time");
	if (VERSION.test(text)) return other("version");
	if (IDENTIFIER.test(text) || ZERO_PADDED.test(text)) return other("id");
	// A number that is a link's whole text (`[312530](…/models/312530)`) names what it points at.
	if (LINKED.test(markdown) && /^\d/.test(text)) return other("id");

	const base = { approx: false, signed: false, emphasis, text: plain.text };
	const listed = listCell(text, base);
	if (listed) return listed;
	const summed = sumCell(text, base);
	if (summed) return summed;
	const fraction = FRACTION.exec(text);
	if (fraction) {
		const rest = fraction[3]!;
		return {
			...base,
			kind: "number",
			value: toNumber(fraction[1]!),
			dim: "fraction",
			unit: "/",
			fit: rest.trim() ? "note" : "fraction",
			figure: text.slice(0, text.length - rest.length).trim(),
			denominator: toNumber(fraction[2]!),
		};
	}

	const compound = COMPOUND_DURATION.exec(text);
	if (compound && compound.slice(1).filter(Boolean).length >= 2) {
		const [, days, hours, minutes, seconds] = compound.map(part => Number(part ?? 0));
		const value = days! * 86_400 + hours! * 3600 + minutes! * 60 + seconds!;
		return { ...base, kind: "number", value, dim: "duration", unit: "s", fit: "pure", figure: text };
	}

	const match = CELL.exec(text);
	if (!match?.groups) return other("text");
	const groups = match.groups;
	let unit = groups.unit ?? "";
	let rest = groups.rest!.trim();
	let dim: Dimension = groups.cur ? "currency" : "count";
	let factor = 1;
	if (unit) {
		const known = knownUnit(unit);
		if (known) {
			[dim, factor] = known;
		} else if (unit.includes("/")) {
			dim = "rate";
		} else {
			// A word after the number is a noun (`16 pass`, `8+ structs`), not a unit.
			rest = `${groups.plus ?? ""}${unit} ${rest}`.trim();
			unit = "";
		}
	}
	// Through the unit when it stayed one, else through the number.
	const figureEnd = unit ? text.length - groups.rest!.length : text.indexOf(groups.num!) + groups.num!.length;
	const figure = text.slice(0, figureEnd).trim();
	if (groups.cur) unit = groups.cur;
	// `24–72 h`: the unit after the range's end applies to its start too.
	const range = RANGE_TAIL.exec(rest);
	const rangeUnit = range?.[2] ? knownUnit(range[2]) : undefined;
	if (!unit && rangeUnit) {
		[dim, factor] = rangeUnit;
		unit = range![2]!;
	}
	// A magnitude suffix on money (`$6.0k`, `$1.2M`, `$4.4k–6.1k`) scales it; the amount stays currency.
	if (groups.cur && dim === "count") {
		dim = "currency";
		unit = groups.cur;
	}
	const negative = groups.sign === "-" || groups.sign === "−";
	const value = toNumber(groups.num!) * factor * (negative ? -1 : 1);
	const cell = {
		...base,
		kind: "number" as const,
		value,
		dim,
		unit,
		figure,
		// A trailing `+` (`~$250+`, `4.9+ GiB`) marks a lower bound.
		approx: groups.approx !== undefined || (groups.plus !== undefined && unit !== "") || rest === "+",
		signed: groups.sign !== undefined,
	};
	if (!rest || rest === "+" || FOOTNOTE.test(rest)) return { ...cell, fit: "pure" };
	const spread = ERROR_TAIL.exec(rest);
	if (spread) {
		// `482.8 ± 1.2 t/s`: a unit after the spread applies to the value too.
		const written = spread[2] ?? "";
		const tail: readonly [Dimension, number] | undefined =
			knownUnit(written) ?? (written.includes("/") ? ["rate", 1] : undefined);
		const own = !unit && tail ? { dim: tail[0], unit: written, value: value * tail[1] } : undefined;
		const error = toNumber(spread[1]!) * (tail && own ? tail[1] : factor);
		return {
			...cell,
			...own,
			fit: "note",
			error,
			figure: `${figure} ± ${spread[1]}${spread[2] ? ` ${spread[2]}` : ""}`,
		};
	}
	if (range) {
		const upper = toNumber(range[1]!) * tailFactor(range[2], factor);
		return { ...cell, fit: "range", upper, figure: `${figure}${range[0].trim()}` };
	}
	const arrow = ARROW_TAIL.exec(rest);
	if (arrow) {
		const sign = arrow[1] === "-" || arrow[1] === "−" ? -1 : 1;
		const to = sign * toNumber(arrow[2]!) * tailFactor(arrow[3], factor);
		return { ...cell, fit: "arrow", to, toFigure: arrow[0].replace(/^(?:→|->|⇒)\s*/, "").trim() };
	}
	if (/^\(.*\)$/.test(rest) || /^[A-Za-z][\w-]{0,11}$/.test(rest)) return { ...cell, fit: "note" };
	return { ...cell, fit: "prose" };
}

function toNumber(written: string): number {
	return Number(written.replaceAll(",", ""));
}

/** A number of a list or sum: its value as written, its unit (known or a noun) and how it was marked. */
interface Item {
	readonly value: number;
	readonly unit: string;
	readonly approx: boolean;
	readonly signed: boolean;
	readonly currency: string;
}

/**
 * The items of `text` from its start joined by `separator` (two at least, `max`
 * at most), and where they end; `undefined` when fewer than two lead it.
 */
function readItems(
	text: string,
	separator: RegExp,
	max: number,
): { items: Item[]; separators: string[]; end: number } | undefined {
	const items: Item[] = [];
	const separators: string[] = [];
	let end = 0;
	let at = 0;
	while (items.length < max) {
		ITEM.lastIndex = at;
		const match = ITEM.exec(text);
		if (!match?.groups) break;
		const { approx, sign, cur, num } = match.groups;
		// A word that is no unit (`214 / 72 cumulative`, `4 hooks`) ends the item at its number.
		const unit = match.groups.unit ?? "";
		const noun = unit !== "" && !knownUnit(unit) && !unit.includes("/");
		items.push({
			value: toNumber(num!) * (sign === "-" || sign === "−" ? -1 : 1),
			unit: noun ? "" : unit,
			approx: approx !== undefined,
			signed: sign !== undefined,
			currency: cur ?? "",
		});
		end = at = noun ? at + match[0].indexOf(num!) + num!.length : ITEM.lastIndex;
		if (noun) break;
		separator.lastIndex = at;
		if (!separator.test(text)) break;
		separators.push(text.slice(at, separator.lastIndex));
		at = separator.lastIndex;
	}
	return items.length >= 2 ? { items, separators: separators.slice(0, items.length - 1), end } : undefined;
}

/**
 * Dimension and per-item factor of `items` read as one quantity: a unit written
 * after some items carries to the bare ones before it (`79 / 124 µs`); two
 * dimensions make no one quantity ({@link readItems} ends an item at a noun).
 * Bare items are counts; a unit per something (`tok/s`) is a rate.
 */
function itemUnits(items: readonly Item[]): { dim: Dimension; factors: number[]; unit: string } | undefined {
	let dim: Dimension | undefined;
	const written: (number | undefined)[] = [];
	const carried: (number | undefined)[] = [];
	for (const item of items) {
		const known = item.unit ? knownUnit(item.unit) : undefined;
		// Money keeps its symbol; only a magnitude (`$1.2k`) may follow it.
		if (item.currency && known && known[0] !== "count") return undefined;
		const itemDim: Dimension | undefined = item.currency
			? "currency"
			: item.unit
				? (known?.[0] ?? "rate")
				: undefined;
		if (itemDim && dim && itemDim !== dim) return undefined;
		dim ??= itemDim;
		// An item's own unit or currency scales it alone (`$627 + $1.48k`); only a physical unit carries back to
		// bare items before it (`3.2 + 9.8 s`), never a magnitude (`5 + 4k`) or a currency sign.
		written.push(item.unit || item.currency ? (known?.[1] ?? 1) : undefined);
		carried.push(item.unit && !item.currency && known && known[0] !== "count" ? known[1] : undefined);
	}
	const factors: number[] = [];
	for (let at = items.length - 1; at >= 0; at--)
		factors[at] =
			written[at] ?? (items[at + 1]?.unit || items[at + 1]?.currency ? carried[at + 1] : factors[at + 1]) ?? 1;
	const lead = items.find(item => item.currency) ?? items.find(item => item.unit);
	return { dim: dim ?? "count", factors, unit: lead?.currency || lead?.unit || "" };
}

/** Text after a list or a sum that only annotates it: nothing, a parenthetical, or one short word (`(45 total)`, `pass`). */
const SHORT_NOTE = /^$|^\(.*\)$|^[A-Za-z][\w-]{0,11}$/;
/** What a list or sum cell shares with any cell: its text and emphasis. */
type CellBase = Pick<NumberCell, "emphasis" | "text">;

/**
 * A slash list of measurements as its first value with every value kept
 * ({@link NumberCell.values}): two to {@link MAX_LISTED_VALUES} values of one
 * unit written on each (`1,864 ms / 2,678 ms`) or after the last only (`79 /
 * 124 µs`), slashes all spaced or all tight; or a spaced pair of bare values
 * that is no score (`25.0 / 27.8`, `12.6 / 9.4`). Other bare lists (`5/8`,
 * `27 / 30`, `19 / 1 / 0`) are fractions, scores or tallies, read elsewhere;
 * `2/1/20k/3k` and `7/12 / 29%` are no one list.
 */
function listCell(text: string, base: CellBase): NumberCell | undefined {
	const read = readItems(text, LIST_SEPARATOR, MAX_LISTED_VALUES + 1);
	if (!read || read.items.length > MAX_LISTED_VALUES) return undefined;
	const { items, separators, end } = read;
	const rest = text.slice(end).trim();
	// `1/3 clean, else …`, `12/` and `3/6/9 more` read as prose or fractions; a list ends at its last value.
	if (/^[\d/]/.test(rest)) return undefined;
	if (new Set(separators.map(separator => separator === "/")).size > 1) return undefined;
	// A unit after the last value carries back to bare ones; a currency sign leads only its own (`1.000 / $3.31`
	// is a score and a price), and a magnitude only its own (`2/1/20k` is turns, edits and tokens).
	const marked = items.map(item => Boolean(item.unit || item.currency));
	const last = items.at(-1)!;
	const carried = marked.slice(0, -1).every(mark => !mark) && !last.currency && knownUnit(last.unit)?.[0] !== "count";
	// A spaced pair of bare numbers that is no score (`25.0 / 27.8`, `12.6 / 9.4`: the second is no whole, or
	// the first exceeds it) lists two values of the column's quantity; `27 / 30` stays a score.
	const [first, second] = items;
	const whole = /^\d[\d,]*$/.test(text.slice(text.indexOf("/") + 1, end).trim());
	const score = whole && first!.value >= 0 && first!.value <= second!.value;
	const pair = items.length === 2 && !marked.some(Boolean) && separators[0] !== "/" && !score;
	if (!pair && (!marked.at(-1) || !(marked.every(Boolean) || carried))) return undefined;
	const units = itemUnits(items);
	if (!units) return undefined;
	const values = items.map((item, at) => item.value * units.factors[at]!);
	return {
		...base,
		kind: "number",
		value: values[0]!,
		dim: units.dim,
		unit: units.unit,
		fit: SHORT_NOTE.test(rest) ? "note" : "prose",
		figure: text.slice(0, end).trim(),
		approx: items.some(item => item.approx),
		signed: items[0]!.signed,
		values,
	};
}

/**
 * A sum of one quantity as its total: `27.8 GB + 4.1 GB` (the terms' sum, when
 * they share a dimension and name no other thing) or `4 hooks + 9 overlays + 1
 * helper = 14 files` (the total written after `=`).
 */
function sumCell(text: string, base: CellBase): NumberCell | undefined {
	const read = readItems(text, SUM_SEPARATOR, Number.POSITIVE_INFINITY);
	if (!read || read.items[0]!.signed) return undefined;
	let { end } = read;
	SUM_TOTAL.lastIndex = end;
	let total: Item | undefined;
	if (SUM_TOTAL.test(text)) {
		ITEM.lastIndex = SUM_TOTAL.lastIndex;
		const match = ITEM.exec(text);
		if (match?.groups) {
			const { approx, cur, num, unit } = match.groups;
			total = {
				value: toNumber(num!),
				unit: cur ?? unit ?? "",
				approx: approx !== undefined,
				signed: false,
				currency: cur ?? "",
			};
			end = ITEM.lastIndex;
		}
	}
	const rest = text.slice(end).trim();
	if (/^[\d+=]/.test(rest)) return undefined;
	const terms = total ? [total] : read.items;
	const units = itemUnits(terms);
	if (!units) return undefined;
	const value = terms.reduce((sum, item, at) => sum + item.value * units.factors[at]!, 0);
	return {
		...base,
		kind: "number",
		value,
		dim: units.dim,
		unit: units.unit,
		fit: SHORT_NOTE.test(rest) ? "note" : "prose",
		figure: text.slice(0, end).trim(),
		approx: terms.some(item => item.approx) || read.items.some(item => item.approx),
		signed: false,
	};
}

/** Factor of a unit written after the second number of a range or transition; the first number's when absent. */
function tailFactor(unit: string | undefined, fallback: number): number {
	if (!unit) return fallback;
	return knownUnit(unit)?.[1] ?? fallback;
}

/** Dimension and base factor of `unit`, cased spellings first; own keys only, so `constructor` is no unit. */
function knownUnit(unit: string): readonly [Dimension, number] | undefined {
	if (Object.hasOwn(CASED_UNITS, unit)) return CASED_UNITS[unit];
	const lower = unit.toLowerCase();
	return Object.hasOwn(UNITS, lower) ? UNITS[lower] : undefined;
}

/** Read a table's columns and rows for charting. Cells are the raw Markdown of each cell. */
export function analyzeTable(header: readonly string[], rows: readonly (readonly string[])[]): TableAnalysis {
	let headers = header.map(cell => plainCell(cell).text);
	const stacked = unstack(headers, rows);
	if (stacked) {
		headers = headers.slice(0, stacked.width);
		rows = stacked.rows;
	}
	rows = unlist(rows);
	const raw = rows.map(row => headers.map((_, index) => parseCell(row[index] ?? "")));
	// `Edit / read calls | 85 / 147`: a spaced slash in the row's name (text before its numbers) pairs two
	// values; one in a note after them (`copies whole message / hallucinates bullets`) pairs nothing.
	const paired = raw.map(cells =>
		cells
			.slice(0, Math.max(0, cells.findIndex(isNumber)))
			.some(cell => cell.kind === "text" && PAIR_SLASH.test(cell.text)),
	);
	// Scores or plain fractions, never both in one column: the two read on different axes and one kind drops out.
	const scoring = headers.map(
		(text, index) =>
			!PAIR_SLASH.test(text) && raw.every((cells, row) => paired[row] || fractionKind(cells[index]) !== "fraction"),
	);
	// A column listing bare pairs (`214 / 104`) reads every spaced pair in it as one (`22 / 49` too, which alone
	// would read as a score).
	const pairing = headers.map((_, index) =>
		raw.some(cells => {
			const cell = cells[index];
			return isNumber(cell) && cell.values !== undefined && cell.unit === "";
		}),
	);
	const parsed = raw.map((cells, row) =>
		cells.map((cell, index): Cell =>
			// A list the header does not name item by item (`Layers/heads/d_model`, unlike `in / out / cache`)
			// holds different things where its values are unlike: none of them is the cell's number.
			!PAIR_SLASH.test(headers[index]!) && unlikeList(cell)
				? { kind: "text", text: cell.text, emphasis: cell.emphasis }
				: pairing[index]
					? asPair(cell)
					: scoring[index] && !paired[row]
						? asScore(cell)
						: cell,
		),
	);
	const draft = fillDown(headers.map((text, index) => readColumn(index, text, parsed)));
	// Without a text column, a leading column of named numbers (`4096B chunks`, `03`, `12-hover`) names the rows.
	const lead = draft[0];
	const unnamed = !draft.some(column => column.role === "label" || column.role === "temporal");
	if (
		lead?.role === "measure" &&
		unnamed &&
		lead.cells.some(
			cell => cell.kind !== "missing" && (!isNumber(cell) || cell.fit === "note" || cell.fit === "prose"),
		)
	)
		draft[0] = { ...lead, role: "label" };
	else if (unnamed) {
		// Else a column of words around numbers in mixed units (`5m write`, `+ 1 ping`) says how each row is
		// done: it names the rows rather than measuring them.
		const worded = draft.findIndex(
			column =>
				column.role === "measure" &&
				column.mixed &&
				column.cells.filter(cell => isNumber(cell) && cell.fit !== "pure").length * 2 > column.cells.length,
		);
		if (worded >= 0) draft[worded] = { ...draft[worded]!, role: "label" };
	}
	const labels = draft.filter(column => column.role === "label" || column.role === "temporal");
	// Bare codes and numbers (`#2233`, `00`, `14`) name rows only when no worded column does; `#1 (baseline)` is worded.
	const worded = (cell: Cell) =>
		cell.kind !== "missing" && ((cell.kind !== "id" && !isNumber(cell)) || /\s/.test(cell.text));
	const label =
		labels.find(column => column.cells.some(worded)) ??
		labels[0] ??
		draft.find(column => column.role === "sequence") ??
		draft.find(column => column.role === "index");
	const totals: number[] = [];
	const data: number[] = [];
	const names = rows.map((_, row) => (label ? label.cells[row]!.text.replace(MARKS, "").trim() : ""));
	const summary = names.map(name => label !== undefined && TOTAL_ROW.test(name));
	// Whether a figure of `row` is the sum of two or more rows right above it (`Total scrapers | 74`).
	const sumsAbove = (row: number) =>
		draft.some(column => {
			const total = column.cells[row];
			if (column.role !== "measure" || !isNumber(total) || total.value <= 0) return false;
			let sum = 0;
			for (let above = row - 1; above >= 0; above--) {
				const cell = column.cells[above];
				if (!isNumber(cell) || cell.dim !== total.dim) return false;
				sum += cell.value;
				if (above < row - 1 && Math.abs(sum - total.value) <= total.value * APPROX_TOTAL) return true;
			}
			return false;
		});
	// A summary closes (or opens) the table, after any other summary rows; one amid the data only shares a
	// name with one (a `net` suite, a `Totals by agent` query) unless its name is the bare summary word or
	// its figure adds up the rows above it.
	for (let row = 0; row < rows.length; row++) {
		const summarizes =
			summary[row] &&
			(summary.slice(row + 1).every(Boolean) ||
				summary.slice(0, row).every(Boolean) ||
				BARE_TOTAL.test(names[row]!) ||
				sumsAbove(row));
		(summarizes ? totals : data).push(row);
	}
	const finished = keepSweeps(draft.map(column => finishColumn(column, data)));
	const restated = restatedColumns(
		finished.filter(column => column.role === "measure" && !column.constant),
		data,
	);
	const columns = finished.map(column =>
		restated.has(column.index) ? { ...column, restates: restated.get(column.index) } : column,
	);
	const measures = columns.filter(
		column => column.role === "measure" && !column.constant && column.restates === undefined,
	);
	return {
		columns,
		label: label ? columns[label.index] : undefined,
		measures,
		rows: data,
		totals,
		composition: findComposition(measures, data),
	};
}

/** A header with its numbers blanked: `scale 1 (200 tiles)` and `scale 8 (1600 tiles)` are one sweep. */
const SWEEP_STEP = /\d+(?:\.\d+)?/g;

/**
 * `columns` with constant measures that are one step of a sweep kept as
 * measures: `scale 8 (1600 tiles)` at 165 in every row beside `scale 1 (200
 * tiles)` and `scale 4 (800 tiles)` is the sweep's last condition, not an
 * echoed setting — the header, numbers blanked, matches a varying measure's.
 */
function keepSweeps(columns: readonly TableColumn[]): TableColumn[] {
	const varying = new Set(
		columns
			.filter(column => column.role === "measure" && !column.constant && /\d/.test(column.header))
			.map(column => column.header.replace(SWEEP_STEP, "#")),
	);
	return columns.map(column =>
		column.constant && column.role === "measure" && varying.has(column.header.replace(SWEEP_STEP, "#"))
			? { ...column, constant: false }
			: column,
	);
}

/** Most columns searched for parts summing to a whole (subsets grow combinatorially). */
const MAX_COMPOSED = 8;
/** Most parts one whole splits into directly. */
const MAX_PARTS = 4;
/** Share of its total that parts falling within it must make up in one row at least. */
const MIN_PART_SHARE = 0.25;
/** A whole that parts may fall within, leaving an unlisted rest. */
const WHOLE_HEADER = /\b(?:total|all|sum|overall)\b/i;

/**
 * Half the last written digit of `cell`, in base units (`6,313k` → 500,
 * `38.5%` → 0.05): how far its value may sit from the exact quantity it
 * rounds. A score (`33/38` read as percent) and a whole count written in full
 * (`46`, `1,980`) are exact.
 */
export function writtenSlack(cell: NumberCell): number {
	if (cell.denominator !== undefined && cell.dim === "percent") return 0;
	const match = /(\d[\d,]*)(?:\.(\d+))?/.exec(cell.figure);
	if (!match) return 0;
	const written = Number(`${match[1]!.replaceAll(",", "")}${match[2] ? `.${match[2]}` : ""}`);
	const factor = written ? Math.abs(cell.value) / written : 1;
	const decimals = match[2]?.length ?? 0;
	if (cell.dim === "count" && decimals === 0 && factor === 1 && !cell.approx) return 0;
	return 0.5 * 10 ** -decimals * factor;
}

/** The cell of `column` at `row` as a plain number of the column's dimension; ranges and transitions hold no single value. */
function plainValue(column: TableColumn, row: number): NumberCell | undefined {
	const cell = column.cells[row];
	return isNumber(cell) && cell.dim === column.dim && cell.upper === undefined && cell.to === undefined
		? cell
		: undefined;
}

/**
 * Columns restating another column's values: `y = k·x` within the written
 * precision over three or more rows where `x` varies, or a running total
 * (`Offset` stepping by `Verts`). Of a proportional pair the first column
 * stays, unless the second is a share summing to 100% beside counts or the
 * table bolded more of its cells (`**87%**` beside `33/38`).
 */
function restatedColumns(measures: readonly TableColumn[], rows: readonly number[]): Map<number, number> {
	const restated = new Map<number, number>();
	const share = (column: TableColumn) => {
		if (column.dim !== "percent" || column.scores) return false;
		const sum = rows.reduce((total, row) => total + (plainValue(column, row)?.value ?? 0), 0);
		return sum >= 97 && sum <= 103;
	};
	for (const [at, a] of measures.entries()) {
		for (const b of measures.slice(at + 1)) {
			if (restated.has(a.index) || restated.has(b.index) || !proportional(a, b, rows)) continue;
			const bolder = emphasized(b, rows) > emphasized(a, rows);
			if ((share(b) && !share(a)) || bolder) restated.set(a.index, b.index);
			else restated.set(b.index, a.index);
		}
	}
	for (const column of measures) {
		if (restated.has(column.index)) continue;
		const source = measures.find(other => other !== column && runningTotal(column, other, rows));
		if (source) restated.set(column.index, source.index);
	}
	return restated;
}

/** How many of `rows` the table bolded in `column`. */
function emphasized(column: TableColumn, rows: readonly number[]): number {
	return rows.filter(row => column.cells[row]?.emphasis).length;
}

/** Most relative rounding a row may carry to count toward proving a proportion (`2%` beside `1` proves little). */
const TIGHT = 0.015;

/**
 * `b = k·a` for one `k` in every row holding both (positive), within their
 * written precision, over three or more rows where `a` varies and three
 * written precisely enough to pin `k` down.
 */
function proportional(a: TableColumn, b: TableColumn, rows: readonly number[]): boolean {
	const pairs = rows.flatMap(row => {
		const x = plainValue(a, row);
		const y = plainValue(b, row);
		return x && y ? [[x, y] as const] : [];
	});
	if (pairs.length < 3 || pairs.some(([x, y]) => x.value <= 0 || y.value <= 0)) return false;
	const xs = pairs.map(([x]) => x.value);
	if (Math.max(...xs) < 1.5 * Math.min(...xs)) return false;
	let low = 0;
	let high = Number.POSITIVE_INFINITY;
	let tight = 0;
	for (const [x, y] of pairs) {
		const [sx, sy] = [writtenSlack(x), writtenSlack(y)];
		if (sx >= x.value) return false;
		low = Math.max(low, (y.value - sy) / (x.value + sx));
		high = Math.min(high, (y.value + sy) / (x.value - sx));
		if (sx / x.value + sy / y.value <= TIGHT) tight++;
	}
	return low <= high * (1 + 1e-9) && tight >= 3;
}

/** `total` steps by `step` from row to row (`Offset` 0, 16, 20 beside `Verts` 16, 4, 8), over three or more steps. */
function runningTotal(total: TableColumn, step: TableColumn, rows: readonly number[]): boolean {
	if (total.dim !== step.dim || rows.length < 4) return false;
	const at = (column: TableColumn, row: number) => plainValue(column, row)?.value;
	const fits = (offset: 0 | 1) =>
		rows.slice(1).every((row, index) => {
			const now = at(total, row);
			const before = at(total, rows[index]!);
			const by = at(step, offset ? row : rows[index]!);
			return now !== undefined && before !== undefined && by !== undefined && by !== 0 && now - before === by;
		});
	return fits(0) || fits(1);
}

/**
 * The parts `measures` add up to: every relation `whole = a + b (+ …)` holding
 * within the written precision in each row (three rows at least), expanded from
 * the largest whole down to leaves. Without one, the same-unit columns beside
 * a `Total` column that never exceed it are parts with an unlisted rest.
 */
function findComposition(measures: readonly TableColumn[], rows: readonly number[]): Composition | undefined {
	const pool = measures
		.filter(
			column =>
				!column.mixed &&
				column.arrowShare === 0 &&
				rows.every(row => {
					const cell = column.cells[row];
					return !isNumber(cell) || (cell.value >= 0 && cell.upper === undefined);
				}),
		)
		.slice(0, MAX_COMPOSED);
	const sums = new Map<number, readonly TableColumn[]>();
	for (const whole of pool) {
		const others = pool.filter(column => column !== whole && column.dim === whole.dim);
		for (const subset of subsets(others, 2, MAX_PARTS)) {
			if (sums.has(whole.index)) break;
			if (adds(whole, subset, rows, true)) sums.set(whole.index, subset);
		}
	}
	if (sums.size > 0) {
		// Parts are non-negative and non-zero somewhere, so no column sums into itself: the expansion ends.
		const leaves = (index: number): number[] => sums.get(index)?.flatMap(part => leaves(part.index)) ?? [index];
		const nested = new Set([...sums.values()].flatMap(parts => parts.map(part => part.index)));
		const roots = [...sums.keys()].filter(index => !nested.has(index));
		const root = roots.sort((a, b) => leaves(b).length - leaves(a).length)[0] ?? [...sums.keys()][0]!;
		return { whole: root, parts: leaves(root).sort((a, b) => a - b), exact: true };
	}
	const whole = pool.find(column => WHOLE_HEADER.test(column.header));
	if (!whole) return undefined;
	// Within a total, a signed column (`vs current` +$4.66k) is a change from another row, not a part.
	const parts = pool.filter(
		column =>
			column !== whole && column.dim === whole.dim && !WHOLE_HEADER.test(column.header) && column.signedShare < 0.5,
	);
	if (parts.length < 2 || parts.length > MAX_PARTS || !adds(whole, parts, rows, false)) return undefined;
	// Parts make up a real share of their total somewhere: `27` tests and `6` turns fall within `16.8k` total tokens
	// only because they count other things.
	const share = (row: number) => {
		const total = plainValue(whole, row)?.value ?? 0;
		const sum = parts.reduce((acc, part) => acc + (plainValue(part, row)?.value ?? 0), 0);
		return total > 0 ? sum / total : 0;
	};
	if (!rows.some(row => share(row) >= MIN_PART_SHARE)) return undefined;
	return { whole: whole.index, parts: parts.map(column => column.index), exact: false };
}

/** Subsets of `items` from `min` to `max` long, smallest first, each in `items` order. */
function subsets<T>(items: readonly T[], min: number, max: number): T[][] {
	const out: T[][] = [];
	const grow = (start: number, picked: T[]) => {
		if (picked.length >= min) out.push(picked);
		if (picked.length === max) return;
		for (let at = start; at < items.length; at++) grow(at + 1, [...picked, items[at]!]);
	};
	grow(0, []);
	return out.sort((a, b) => a.length - b.length);
}

/**
 * `parts` sum to `whole` (`exact`) or stay within it, short of it somewhere,
 * in every row holding all of them (three at least), each part non-zero in one.
 */
function adds(whole: TableColumn, parts: readonly TableColumn[], rows: readonly number[], exact: boolean): boolean {
	let held = 0;
	let short = false;
	const used = new Set<TableColumn>();
	for (const row of rows) {
		const total = plainValue(whole, row);
		const cells = parts.map(part => plainValue(part, row));
		if (!total || cells.some(cell => !cell)) continue;
		held++;
		const sum = cells.reduce((acc, cell) => acc + cell!.value, 0);
		const slack =
			writtenSlack(total) + cells.reduce((acc, cell) => acc + writtenSlack(cell!), 0) + 1e-9 * total.value;
		if (exact ? Math.abs(sum - total.value) > slack : sum > total.value + slack) return false;
		if (sum < total.value - slack) short = true;
		cells.forEach((cell, at) => {
			if (cell!.value > 0) used.add(parts[at]!);
		});
	}
	return held >= 3 && used.size === parts.length && (exact || short);
}

type DraftColumn = Omit<TableColumn, "constant">;

/**
 * Two or more copies of one table set side by side to save height
 * (`| | doc | lines | | doc | lines |`): the header repeats in blocks of
 * `width` columns, read as one table of `width` columns, block after block.
 * Block rows left empty (an odd row count) are dropped.
 */
function unstack(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
): { width: number; rows: string[][] } | undefined {
	for (let width = 2; width * 2 <= headers.length; width++) {
		if (headers.length % width !== 0 || !headers.slice(0, width).some(Boolean)) continue;
		if (!headers.every((name, at) => name === headers[at % width])) continue;
		const stacked: string[][] = [];
		for (let start = 0; start < headers.length; start += width)
			for (const row of rows) {
				const block = headers.slice(0, width).map((_, at) => row[start + at] ?? "");
				if (block.some(cell => plainCell(cell).text)) stacked.push(block);
			}
		return { width, rows: stacked };
	}
	return undefined;
}

/** Fewest items a slash list must hold to split into rows wherever its name cell stands. */
const MIN_LISTED = 3;
/** Fewest items a slash list splits into when the row's name lists them before the values they pair. */
const MIN_LISTED_PAIR = 2;
/** Fewest numeric columns listing values in a row it splits: one list of numbers may be a row of unrelated metrics. */
const MIN_LISTS = 2;
/** A spaced slash between list items. */
const LIST_SLASH = /\s+\/\s+/;
/** A list item that is one number, as written (`12`, `~1,400`, `3.5 ms`, `40%`). */
const LISTED_NUMBER = /^[~≈]?[$€£¥]?\d[\d,]*(?:\.\d+)?\s*(?:%|[A-Za-zµμ]+)?$/;

/**
 * Rows folding several rows into one (`response anthropic / chat / responses /
 * gemini → 3 wires | 12 / 12 / 12 / 9 | 6 / 0 / 0 / 0`), split back into one
 * row per item: a name cell listing {@link MIN_LISTED} or more items (a pair
 * only when the name cell comes before every list: `pager 24×80 / 48×120 |
 * 25.0 / 27.8 | 12.6 / 9.4`), {@link MIN_LISTS} or more numeric cells each
 * listing that many numbers, and no other number in the row. Each
 * item keeps the words the name cell writes before its first item and the
 * aside after its last (` → 3 wires`, ` (ms)`: a tail opening on a symbol, so
 * `blocks / conditional branches` keeps its last item whole); other text cells repeat.
 */
function unlist(rows: readonly (readonly string[])[]): readonly (readonly string[])[] {
	return rows.flatMap(row => {
		const lists = row.map(cell => plainCell(cell).text.split(LIST_SLASH));
		const size = Math.max(...lists.map(list => list.length));
		if (size < MIN_LISTED_PAIR) return [row];
		const numeric = lists.map(list => list.every(item => LISTED_NUMBER.test(item)));
		const name = lists.findIndex((list, at) => list.length === size && !numeric[at]);
		const fits = lists.every(
			(list, at) => at === name || (list.length === size ? numeric[at] : !numeric[at] || !list[0]),
		);
		const listed = lists.filter((list, at) => list.length === size && numeric[at]).length;
		if (name < 0 || !fits || listed < MIN_LISTS) return [row];
		// A pair splits only where the row's name lists it, before the values it pairs (`pager 24×80 / 48×120 |
		// 25.0 / 27.8 | 12.6 / 9.4`); a slash in a note after them pairs nothing.
		if (size < MIN_LISTED && lists.some((list, at) => at < name && list.length === size)) return [row];
		const items = [...lists[name]!];
		const first = items[0]!;
		const last = items[size - 1]!;
		const before = first.includes(" ") ? first.slice(0, first.lastIndexOf(" ") + 1) : "";
		const aside = /\s+[^\p{L}\p{N}\s]/u.exec(last);
		const after = aside ? last.slice(aside.index) : "";
		items[0] = first.slice(before.length);
		items[size - 1] = last.slice(0, last.length - after.length);
		return items.map((item, index) =>
			row.map((cell, at) =>
				at === name ? `${before}${item}${after}` : lists[at]!.length === size ? lists[at]![index]! : cell,
			),
		);
	});
}

/**
 * Leading text columns written as an outline: a blank cell under a filled one
 * repeats it (`DB | Table.Column` naming the database once for its tables), so
 * the continuation rows keep their parent's name. Only columns before the
 * first measure; a blank written as `—` stays missing.
 */
function fillDown(columns: DraftColumn[]): DraftColumn[] {
	const firstMeasure = columns.findIndex(column => column.role === "measure");
	return columns.map(column => {
		if (column.role !== "label" || (firstMeasure >= 0 && column.index > firstMeasure)) return column;
		const { cells } = column;
		const blank = (cell: Cell) => cell.kind === "missing" && cell.text === "";
		if (cells.length < 3 || blank(cells[0]!) || !cells.some(blank)) return column;
		const filled: Cell[] = [];
		for (const cell of cells) filled.push(blank(cell) ? filled.at(-1)! : cell);
		return { ...column, cells: filled };
	});
}

/** A spaced slash naming two values (`p50 / p95`, `median / max`) rather than a path or a score. */
const PAIR_SLASH = /\S \/ \S/;

/**
 * How an `a/b` cell reads: a `score` out of a whole-number `b` with
 * `0 ≤ a ≤ b` (`12/12`, `154/160`, a mean like `0.6/4`), a `list` like
 * `327 / 333 / 339`, else a plain `fraction` (`5/3`, `1.2/3.4`);
 * `undefined` for any other cell.
 */
function fractionKind(cell: Cell | undefined): "score" | "list" | "fraction" | undefined {
	if (!isNumber(cell) || cell.dim !== "fraction" || !cell.denominator) return undefined;
	const after = cell.text.indexOf(cell.figure);
	if (after < 0 || /^\s*\//.test(cell.text.slice(after + cell.figure.length))) return "list";
	// The figure ends in its denominator as written: `/4` counts a whole, `/3.4` is a second value.
	const whole = /\/\s*\d[\d,]*$/.test(cell.figure);
	return whole && cell.value >= 0 && cell.value <= cell.denominator ? "score" : "fraction";
}

/**
 * A bare slash list of three or more values unlike each other (`12 / 12 / 768`, `19 / 1 / 0`): a list of
 * different things, where alike values (`327 / 333 / 339`) repeat one measurement.
 */
function unlikeList(cell: Cell): boolean {
	if (!isNumber(cell) || cell.dim !== "fraction") return false;
	const items = readItems(cell.text.replace(MARKS, "").trim(), LIST_SEPARATOR, MAX_LISTED_VALUES)?.items;
	if (!items || items.length < 3 || items.some(item => item.unit || item.currency)) return false;
	const values = items.map(item => item.value);
	return values.some(value => value <= 0) || Math.max(...values) > ALIKE_SPREAD * Math.min(...values);
}

/** A spaced bare `a / b` read as a fraction or score (`22 / 49`) as the pair of values it lists; any other cell unchanged. */
function asPair(cell: Cell): Cell {
	if (!isNumber(cell) || cell.denominator === undefined || cell.fit !== "fraction" || !PAIR_SLASH.test(cell.figure))
		return cell;
	return {
		...cell,
		dim: "count",
		unit: "",
		fit: "note",
		denominator: undefined,
		values: [cell.value, cell.denominator],
	};
}

/** A {@link fractionKind} `score` as the percent of its denominator it reached; any other cell unchanged. */
function asScore(cell: Cell): Cell {
	if (!isNumber(cell) || !cell.denominator || fractionKind(cell) !== "score") return cell;
	return { ...cell, dim: "percent", value: (100 * cell.value) / cell.denominator };
}

function readColumn(index: number, header: string, parsed: readonly (readonly Cell[])[]): DraftColumn {
	const cells = otherNouns(
		resolveClock(resolveMagnitudes(resolveMinutes(parsed.map(row => row[index]!)), header)),
		header,
	);
	const present = cells.filter(cell => cell.kind !== "missing");
	const numbers = present.filter(isNumber);
	const strict = numbers.filter(cell => cell.fit !== "prose");
	const total = Math.max(1, present.length);
	const numberShare = numbers.length / total;
	const strictShare = strict.length / total;
	const temporalShare = present.filter(cell => cell.kind === "date" || cell.kind === "time").length / total;

	const dims = new Map<Dimension, NumberCell[]>();
	for (const cell of numbers) {
		const same = dims.get(cell.dim);
		if (same) same.push(cell);
		else dims.set(cell.dim, [cell]);
	}
	let dominant: NumberCell[] = [];
	for (const group of dims.values()) if (group.length > dominant.length) dominant = group;
	const dim = dominant[0]?.dim;
	const mixed = numbers.length > 0 && dominant.length / numbers.length < 0.8;
	const scored = numbers.filter(cell => cell.dim === "percent" && cell.denominator !== undefined).length;
	const unit = dim === "currency" || dim === "rate" ? (dominant[0]?.unit ?? "") : "";

	// A lone `✗` reads as a missing value yet still says failed.
	const statuses = cells.map(cell => cellStatus(cell.text));
	const written = cells.filter(cell => cell.text.trim()).length;
	const statusShare = written ? statuses.filter(Boolean).length / written : 0;

	const trimmed = header.trim();
	const sequential =
		index === 0 &&
		numbers.length >= 3 &&
		numbers.length === present.length &&
		numbers.every((cell, at) => cell.dim === "count" && cell.value === numbers[0]!.value + at);
	// Row numbers and identifiers are bare counts; a unit (`20 ms` under `PR`) makes the column a measure.
	const bare = numbers.every(cell => cell.dim === "count" && !cell.unit);
	// `1 ok`, `87 ok`, `3 fail`: every count tallies an outcome, a verdict per row rather than a quantity to plot.
	const tallies =
		numbers.length > 0 && bare && cells.every((cell, at) => !isNumber(cell) || statuses[at] !== undefined);
	let role: ColumnRole;
	if (temporalShare >= 0.8) role = "temporal";
	else if (tallies) role = "label";
	else if (numberShare >= 0.8 && (sequential || (bare && INDEX_HEADER.test(trimmed)))) role = "index";
	// Case numbers `01–11`, `12–17`, …, `64`, `65` beside the rows' names: spans tiling one numbering say where each
	// row sits, not how much it holds.
	else if (index > 0 && bare && tilesSpans(present)) role = "index";
	// A step header over ordered values (`Tier` 1, 1, 2, 3): repeats make it a bucket the rows fall into, still no measure.
	else if (
		numberShare >= 0.8 &&
		bare &&
		SEQUENCE_HEADER.test(trimmed) &&
		(isMonotonic(numbers.map(cell => cell.value)) || isOrdered(numbers.map(cell => cell.value)))
	)
		role = "sequence";
	else if (numberShare >= 0.8 && strictShare >= 0.6) role = "measure";
	// A mostly numeric column whose other cells are short status words (`TIMEOUT`, `MISS`, `OOM`).
	else if (numberShare >= 0.6 && strictShare >= 0.5 && present.every(cell => isNumber(cell) || cell.text.length <= 24))
		role = "measure";
	else role = "label";

	return {
		index,
		header,
		role,
		cells,
		dim,
		unit,
		mixed,
		scores: numbers.length > 0 && scored / numbers.length >= 0.8,
		statuses:
			statusShare >= 0.6
				? statuses.map((status, at) => status ?? (HEDGE.test(cells[at]!.text) ? "warn" : undefined))
				: undefined,
		signedShare: numbers.length ? numbers.filter(cell => cell.signed).length / numbers.length : 0,
		arrowShare: numbers.length ? numbers.filter(cell => cell.to !== undefined).length / numbers.length : 0,
	};
}

/**
 * A lone `m` means minutes beside other durations and millions otherwise;
 * {@link CASED_UNITS} reads it as minutes, so a column whose only durations
 * are `m` cells reads them as millions.
 */
function resolveMinutes(cells: Cell[]): Cell[] {
	const durations = cells.filter(cell => isNumber(cell) && cell.dim === "duration");
	if (durations.length === 0 || !durations.every(cell => isNumber(cell) && cell.unit === "m")) return cells;
	const rescale = (seconds: number | undefined) => (seconds === undefined ? undefined : (seconds / 60) * 1e6);
	return cells.map(cell =>
		isNumber(cell) && cell.unit === "m"
			? { ...cell, dim: "count", value: rescale(cell.value)!, to: rescale(cell.to), upper: rescale(cell.upper) }
			: cell,
	);
}

/** The word a bare count names after its figure (`4 new (45 total)` → `new`, `371 entries`). */
const COUNTED_NOUN = /^\s*([A-Za-z][A-Za-z-]*)/;

/**
 * Counts of another thing than most of the column's (`371 entries` among `4
 * new` tests) read as text: one axis would set them against the rest. Applies
 * where most counts name one noun and two or more others name one the header
 * does not (a lone `1200px` among `rem` sizes is a stray unit, not a second quantity).
 */
function otherNouns(cells: Cell[], header: string): Cell[] {
	const nouns = cells.map(cell => {
		if (!isNumber(cell) || cell.dim !== "count" || cell.unit || cell.fit === "pure" || cellStatus(cell.text))
			return undefined;
		const word = COUNTED_NOUN.exec(cell.text.slice(cell.text.indexOf(cell.figure) + cell.figure.length))?.[1];
		return word?.toLowerCase().replace(/e?s$/, "");
	});
	const tally = new Map<string, number>();
	for (const noun of nouns) if (noun) tally.set(noun, (tally.get(noun) ?? 0) + 1);
	const [main, count] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
	if (count < 2 || count * 2 <= cells.filter(isNumber).length) return cells;
	const named = header.toLowerCase();
	return cells.map((cell, at) => {
		const noun = nouns[at];
		return noun && noun !== main && (tally.get(noun) ?? 0) >= 2 && !named.includes(noun)
			? { kind: "text", text: cell.text, emphasis: cell.emphasis }
			: cell;
	});
}

/** Headers of a size on disk or in memory, whose bare magnitudes (`3.4G`, `960M`) count bytes. */
const SIZE_HEADER = /\b(?:sizes?|disk|du|rss|memory|mem|heap|storage|footprint|bytes)\b/i;
/** Bare magnitude suffixes of a `du -h` size, as powers of 1024. */
const BINARY_POWER: Readonly<Record<string, number>> = { K: 1, k: 1, M: 2, G: 3, T: 4 };

/**
 * Bare magnitudes read by what they stand beside: under a size header
 * ({@link SIZE_HEADER}), `3.4G`, `960M` and `12K` are `du -h` sizes in powers
 * of 1024; beside millions (`600M` parameters), `1.2B` is billions, not bytes.
 */
function resolveMagnitudes(cells: Cell[], header: string): Cell[] {
	const numbers = cells.filter(isNumber);
	const suffixed = numbers.filter(cell => cell.dim === "count" && Object.hasOwn(BINARY_POWER, cell.unit));
	if (suffixed.length === 0) return cells;
	const rescale = (value: number | undefined, from: number, to: number) =>
		value === undefined ? undefined : (value / from) * to;
	if (SIZE_HEADER.test(header) && numbers.every(cell => cell.dim === "count" || cell.dim === "bytes"))
		return cells.map(cell => {
			if (!isNumber(cell) || !suffixed.includes(cell)) return cell;
			const from = knownUnit(cell.unit)![1];
			const to = 1024 ** BINARY_POWER[cell.unit]!;
			return {
				...cell,
				dim: "bytes",
				value: rescale(cell.value, from, to)!,
				to: rescale(cell.to, from, to),
				upper: rescale(cell.upper, from, to),
			};
		});
	const bytes = numbers.filter(cell => cell.dim === "bytes");
	// Billions read like millions: a few units each (`1.2B` beside `600M`), where bytes would be thousands (`4096B`).
	if (
		bytes.length === 0 ||
		!suffixed.some(cell => cell.unit === "M") ||
		!bytes.every(cell => cell.unit === "B" && Math.abs(cell.value) < 1000)
	)
		return cells;
	return cells.map(cell =>
		isNumber(cell) && cell.dim === "bytes"
			? {
					...cell,
					dim: "count",
					value: cell.value * 1e9,
					to: rescale(cell.to, 1, 1e9),
					upper: rescale(cell.upper, 1, 1e9),
				}
			: cell,
	);
}

/** An elapsed time written on a clock face: `m:ss` or `h:mm:ss`, optionally with fractions of a second. */
const CLOCK = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2}(?:\.\d+)?)$/;

/**
 * `4:14` beside `8s` and `24s` is four minutes fourteen seconds, not a time of
 * day: in a column holding other durations, clock cells read as durations
 * (`m:ss`, or `h:mm:ss`).
 */
function resolveClock(cells: Cell[]): Cell[] {
	if (!cells.some(cell => isNumber(cell) && cell.dim === "duration")) return cells;
	return cells.map(cell => {
		if (cell.kind !== "time") return cell;
		const text = cell.text.replace(MARKS, "").trim();
		const clock = CLOCK.exec(text);
		if (!clock) return cell;
		const value = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
		return {
			kind: "number",
			value,
			dim: "duration",
			unit: "s",
			fit: "pure",
			approx: false,
			signed: false,
			emphasis: cell.emphasis,
			text: cell.text,
			figure: text,
		} satisfies NumberCell;
	});
}

function finishColumn(column: DraftColumn, rows: readonly number[]): TableColumn {
	const values = new Set<number>();
	let count = 0;
	for (const row of rows) {
		const cell = column.cells[row];
		if (cell && isNumber(cell)) {
			values.add(cell.value);
			count++;
		}
	}
	return { ...column, constant: count > 0 && values.size <= 1 };
}

/** A span of whole numbers written `a–b` (zero-padded or not: `01–11`), or one number. */
const SPAN = /^(\d+)(?:\s*[-–—]\s*(\d+))?$/;
/** Fewest spans that tile a numbering; two in a row may meet by chance. */
const MIN_TILES = 3;

/**
 * Whether `cells` are spans of whole numbers laid end to end in order (`01–11`, `12–17`, `18–21`, `64`):
 * each starts right after the previous one ends, one at least a range, {@link MIN_TILES} at least.
 */
function tilesSpans(cells: readonly Cell[]): boolean {
	if (cells.length < MIN_TILES) return false;
	let end: number | undefined;
	let ranged = false;
	for (const cell of cells) {
		const span = SPAN.exec(cell.text.replace(MARKS, "").trim());
		if (!span) return false;
		const first = Number(span[1]);
		const last = span[2] === undefined ? first : Number(span[2]);
		if (last < first || (end !== undefined && first !== end + 1)) return false;
		ranged ||= last > first;
		end = last;
	}
	return ranged;
}

/** Strictly increasing or strictly decreasing. */
export function isMonotonic(values: readonly number[]): boolean {
	if (values.length < 2) return false;
	const up = values[1]! > values[0]!;
	for (let at = 1; at < values.length; at++) {
		const step = values[at]! - values[at - 1]!;
		if (step === 0 || step > 0 !== up) return false;
	}
	return true;
}

/** Non-decreasing with at least one repeat: ordered buckets (`1, 1, 2, 2, 3`), not a strictly monotonic axis. */
function isOrdered(values: readonly number[]): boolean {
	if (values.length < 3 || new Set(values).size === values.length) return false;
	return values.every((value, at) => at === 0 || value >= values[at - 1]!);
}

/** Whether `cell` reads as a number. */
export function isNumber(cell: Cell | undefined): cell is NumberCell {
	return cell?.kind === "number";
}
