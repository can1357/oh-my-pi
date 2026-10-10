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
	 * `a/b`: `b`. {@link analyzeTable} reads a score (`12/12`, `154/160`) as the
	 * percent of `b` reached; a pair (`85 / 147` under `Edit / read calls`) keeps `a`.
	 */
	readonly denominator?: number;
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
	/** Every numeric data cell holds the same value: an echoed setting, not a measure. */
	readonly constant: boolean;
	/** Share of numeric cells written with an explicit sign. */
	readonly signedShare: number;
	/** Share of numeric cells written as `a → b`. */
	readonly arrowShare: number;
}

/** A table read for charting. */
export interface TableAnalysis {
	readonly columns: readonly TableColumn[];
	/** Category labels: the first text or temporal column, else a sequence or index column. */
	readonly label: TableColumn | undefined;
	/** Plottable measure columns, constant ones excluded. */
	readonly measures: readonly TableColumn[];
	/** Data rows, in table order, without total/summary rows. */
	readonly rows: readonly number[];
	/** Total/summary rows (`Total`, `Average`, …), kept out of the scale. */
	readonly totals: readonly number[];
}

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+`;
const CELL = new RegExp(
	String.raw`^(?<approx>~|≈|<=|>=|<|>|≤|≥)?\s*(?<sign>[+\-−±])?\s*(?<cur>[$€£¥])?\s*(?<num>${NUMBER})\s*(?<unit>%|[A-Za-zµμ×]+(?:\/[A-Za-z]+)?|\/s)?(?<rest>.*)$`,
);
const FRACTION = new RegExp(String.raw`^(${NUMBER})\s*\/\s*(${NUMBER})(?![\d/])(.*)$`);
const RANGE_TAIL = new RegExp(String.raw`^[-–—]\s*[~≈]?\s*[$€£¥]?\s*(${NUMBER})\s*(%|[A-Za-zµμ×]+)?`);
const ARROW_TAIL = new RegExp(String.raw`^(?:→|->|⇒)\s*[~≈]?\s*([+\-−])?\s*[$€£¥]?\s*(${NUMBER})\s*(%|[A-Za-zµμ×]+)?`);
const COMPOUND_DURATION =
	/^(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/;
const DATE =
	/^\d{4}-\d{2}(?:-\d{2})?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b|^\d{1,2}\/\d{1,2}\/\d{2,4}$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:am|pm)?$/i;
const VERSION = /^v?\d+\.\d+\.\d+|^v\d/i;
const IDENTIFIER = /^(?:#\d+|[0-9a-f]{7,40}$|PR\s*#?\d+|L\d+\b)/i;
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
/** Status marks that decorate a value without changing it (`**4** ✅`, `⚠️ 12`). */
const MARKS = /[✅❌⚠🟢🔴🟡✓✗✔★⭐]|\uFE0E|\uFE0F/gu;

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
/** Units whose case decides their meaning: `B` bytes vs `b` billions, `M` millions vs `m` minutes. */
const CASED_UNITS: Readonly<Record<string, readonly [Dimension, number]>> = {
	B: ["bytes", 1],
	b: ["count", 1e9],
	M: ["count", 1e6],
	m: ["duration", 60],
};

/** Header names of row numbers and identifiers: never plotted, never a category axis when text exists. */
const INDEX_HEADER =
	/^(?:#|no\.?|n°|id|ids|rank|row|idx|index|line|lines?\s*#|ln|pr|pr\s*#|issue|commit|sha|hash|port|pid|code|exit\s*code|status|version|ver|ref|offset|priority|prio)$/i;
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
 * Strip inline Markdown from a cell: links keep their text; bold, italics,
 * strikethrough, code spans and `<br>` keep their content.
 */
export function plainCell(markdown: string): { text: string; emphasis: boolean } {
	let text = markdown.replace(/\\\|/g, "|");
	const emphasis = /(\*\*|__)\S/.test(text);
	text = text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
		.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]+>/g, "")
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
	if (IDENTIFIER.test(text)) return other("id");

	const base = { approx: false, signed: false, emphasis, text: plain.text };
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
			// A word after the number is a noun (`16 pass`), not a unit.
			rest = `${unit} ${rest}`.trim();
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
	const negative = groups.sign === "-" || groups.sign === "−";
	const value = toNumber(groups.num!) * factor * (negative ? -1 : 1);
	const cell = {
		...base,
		kind: "number" as const,
		value,
		dim,
		unit,
		figure,
		// A trailing `+` (`~$250+`) marks a lower bound.
		approx: groups.approx !== undefined || rest === "+",
		signed: groups.sign !== undefined,
	};
	if (!rest || rest === "+") return { ...cell, fit: "pure" };
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
	const headers = header.map(cell => plainCell(cell).text);
	const parsed = rows.map(row => {
		const cells = headers.map((_, index) => parseCell(row[index] ?? ""));
		// `Edit / read calls | 85 / 147`: a spaced slash in the row's name pairs two values.
		const paired = cells.some(cell => cell.kind === "text" && PAIR_SLASH.test(cell.text));
		return cells.map((cell, index) => (paired || PAIR_SLASH.test(headers[index]!) ? cell : asScore(cell)));
	});
	const draft = headers.map((text, index) => readColumn(index, text, parsed));
	const labels = draft.filter(column => column.role === "label" || column.role === "temporal");
	const label =
		labels[0] ?? draft.find(column => column.role === "sequence") ?? draft.find(column => column.role === "index");
	const totals: number[] = [];
	const data: number[] = [];
	for (let row = 0; row < rows.length; row++) {
		const name = label ? label.cells[row]!.text : "";
		(label && TOTAL_ROW.test(name.replace(MARKS, "").trim()) ? totals : data).push(row);
	}
	const columns = draft.map(column => finishColumn(column, data));
	const measures = columns.filter(column => column.role === "measure" && !column.constant);
	return { columns, label: label ? columns[label.index] : undefined, measures, rows: data, totals };
}

type DraftColumn = Omit<TableColumn, "constant">;

/** A spaced slash naming two values (`p50 / p95`, `median / max`) rather than a path or a score. */
const PAIR_SLASH = /\S \/ \S/;

/**
 * A whole-number `a/b` with `a ≤ b` as the percent of `b` it reached; any
 * other cell unchanged, a list like `327 / 333 / 339` included.
 */
function asScore(cell: Cell): Cell {
	if (!isNumber(cell) || cell.dim !== "fraction" || !cell.denominator) return cell;
	const { value, denominator } = cell;
	if (!Number.isInteger(value) || !Number.isInteger(denominator) || value > denominator) return cell;
	const after = cell.text.indexOf(cell.figure);
	if (after < 0 || /^\s*\//.test(cell.text.slice(after + cell.figure.length))) return cell;
	return { ...cell, dim: "percent", value: (100 * value) / denominator };
}

function readColumn(index: number, header: string, parsed: readonly (readonly Cell[])[]): DraftColumn {
	const cells = resolveMinutes(parsed.map(row => row[index]!));
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

	const trimmed = header.trim();
	const sequential =
		index === 0 &&
		numbers.length >= 3 &&
		numbers.length === present.length &&
		numbers.every((cell, at) => cell.dim === "count" && cell.value === numbers[0]!.value + at);
	let role: ColumnRole;
	if (temporalShare >= 0.8) role = "temporal";
	else if (numberShare >= 0.8 && (INDEX_HEADER.test(trimmed) || sequential)) role = "index";
	else if (numberShare >= 0.8 && SEQUENCE_HEADER.test(trimmed) && isMonotonic(numbers.map(cell => cell.value)))
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

/** Whether `cell` reads as a number. */
export function isNumber(cell: Cell | undefined): cell is NumberCell {
	return cell?.kind === "number";
}
