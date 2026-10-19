/**
 * Deterministic derivation of a job's widget: read the new text of each
 * source, split it into lines, apply the rules reading that source with one
 * native {@link LineMatcher} call per refresh, fold the matches into per-field
 * state, and turn spec + state into a {@link JobWidgetView}. No model is
 * involved past the spec. Work per refresh is proportional to the new text:
 * series keep bounded rings and per-refresh match buckets.
 */
import { LineMatcher } from "@oh-my-pi/pi-natives";
import type {
	JobWidgetBlock,
	JobWidgetHeadline,
	JobWidgetSparkBlock,
	JobWidgetState,
	JobWidgetTrend,
	JobWidgetView,
} from "@oh-my-pi/pi-tui/tools/job-widget";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { formatWidgetNumber, formatWidgetTrend } from "./format";
import {
	type JobWidgetAgg,
	type JobWidgetBlockSpec,
	type JobWidgetRule,
	type JobWidgetSampleLines,
	type JobWidgetSpec,
	type JobWidgetValueRef,
	MAX_TITLE_CHARS,
	parseWidgetValue,
	ruleFields,
	ruleReadsSource,
} from "./spec";
import type { JobTextSource } from "./types";

/** Longest line kept; longer lines are cut. */
export const MAX_LINE_CHARS = 4096;
/** Points a series keeps for sparks. */
const RING_POINTS = 240;
/** Points a spark draws after downsampling. */
export const SPARK_POINTS = 48;
/** Window of `rate` and lines/s. */
export const RATE_WINDOW_MS = 60_000;
/** Non-empty lines kept per source from its start, for the author's samples. */
const SAMPLE_HEAD_LINES = 30;
/** Non-empty lines kept per source from its end, for the author's samples. */
const SAMPLE_TAIL_LINES = 60;
const MAX_STAGE_CHARS = 200;
const MAX_TEXT_CHARS = 200;
const MAX_BAR_ITEMS = 16;
const MAX_GRID_ITEMS = 48;

// ── Reading sources ─────────────────────────────────────────────────────────

/** Complete lines a {@link SourceLineReader} read, and whether the source may grow. */
export interface SourceLines {
	lines: string[];
	open: boolean;
	/** Offset just past the read text (the source's size so far). */
	end: number;
}

/**
 * Reads one source between refreshes: keeps a cursor, carries the trailing
 * partial line to the next read, turns CR/CRLF into line breaks, strips ANSI
 * and control characters, and cuts lines at {@link MAX_LINE_CHARS}. When the
 * source dropped text the reader never saw, the torn line at the gap is
 * skipped so no rule reads half a line.
 */
export class SourceLineReader {
	#cursor = 0;
	/** Raw text of the line in progress; sanitized once complete so split escapes still strip. */
	#partial = "";
	/** Skipping the rest of a line torn by a gap. */
	#torn = false;

	constructor(readonly source: JobTextSource) {}

	/** New complete lines; `flush` also ends the line in progress (the source closed or the job settled). */
	read(flush: boolean): SourceLines {
		const chunk = this.source.read(this.#cursor);
		let text = chunk.text;
		if (chunk.start > this.#cursor) {
			this.#partial = "";
			this.#torn = true;
		}
		this.#cursor = Math.max(this.#cursor, chunk.end);
		if (this.#torn) {
			const lineEnd = text.search(/[\r\n]/);
			if (lineEnd === -1) text = "";
			else {
				text = text.slice(lineEnd + 1);
				this.#torn = false;
			}
		}
		const raw = (this.#partial + text).replace(/\r\n?/g, "\n").split("\n");
		this.#partial = (raw.pop() ?? "").slice(0, MAX_LINE_CHARS * 2);
		if ((flush || !chunk.open) && this.#partial.length > 0) {
			raw.push(this.#partial);
			this.#partial = "";
		}
		const lines = raw.map(line => sanitizeText(line).slice(0, MAX_LINE_CHARS));
		return { lines, open: chunk.open, end: chunk.end };
	}
}

// ── Values and series ───────────────────────────────────────────────────────

/** One key's (or all keys') accumulated matches. */
export interface WidgetSeries {
	/** Matches, including those that carried no number. */
	count: number;
	/** Numbers folded in. */
	values: number;
	first: number;
	last: number;
	min: number;
	max: number;
	sum: number;
	/** Matches per refresh time within the last {@link RATE_WINDOW_MS}, oldest first. */
	recent: { t: number; n: number }[];
	/** Newest values with their times, oldest first; between {@link RING_POINTS} and twice that once full. */
	ring: { t: number; v: number }[];
	/** Latest captured text (untrimmed length; cut when drawn). */
	text?: string;
	/** Latest matching line (cut when drawn). */
	line?: string;
	updatedAt: number;
}

function emptySeries(): WidgetSeries {
	return {
		count: 0,
		values: 0,
		first: 0,
		last: 0,
		min: Number.POSITIVE_INFINITY,
		max: Number.NEGATIVE_INFINITY,
		sum: 0,
		recent: [],
		ring: [],
		updatedAt: 0,
	};
}

function pushMatch(
	series: WidgetSeries,
	value: number | undefined,
	text: string | undefined,
	line: string,
	t: number,
): void {
	series.count += 1;
	const bucket = series.recent.at(-1);
	if (bucket?.t === t) bucket.n += 1;
	else {
		series.recent.push({ t, n: 1 });
		const horizon = t - RATE_WINDOW_MS;
		let stale = 0;
		while (stale < series.recent.length && series.recent[stale].t < horizon) stale += 1;
		if (stale > 0) series.recent.splice(0, stale);
	}
	if (value !== undefined) {
		if (series.values === 0) series.first = value;
		series.values += 1;
		series.last = value;
		if (value < series.min) series.min = value;
		if (value > series.max) series.max = value;
		series.sum += value;
		series.ring.push({ t, v: value });
		// Trimmed in batches: dropping the oldest point on every push would copy the ring each time.
		if (series.ring.length >= RING_POINTS * 2) series.ring.splice(0, series.ring.length - RING_POINTS);
	}
	if (text) series.text = text;
	series.line = line;
	series.updatedAt = t;
}

/** Window `rate` divides by: the last minute, or the job's age when younger, at least 1 s. */
function rateWindowMs(now: number, startTime: number): number {
	return Math.min(RATE_WINDOW_MS, Math.max(1000, now - startTime));
}

/**
 * Reduce a series. `count` and `rate` are defined on an empty series (0);
 * value aggregations are `undefined` until a number arrived, and `change` is
 * `undefined` when it would divide a move by a zero start.
 */
export function aggregateSeries(
	series: WidgetSeries,
	agg: JobWidgetAgg,
	now: number,
	startTime: number,
): number | undefined {
	if (agg === "count") return series.count;
	if (agg === "rate") {
		const horizon = now - RATE_WINDOW_MS;
		let inWindow = 0;
		for (const bucket of series.recent) if (bucket.t >= horizon) inWindow += bucket.n;
		return inWindow / (rateWindowMs(now, startTime) / 1000);
	}
	if (series.values === 0) return undefined;
	switch (agg) {
		case "last":
			return series.last;
		case "first":
			return series.first;
		case "min":
			return series.min;
		case "max":
			return series.max;
		case "sum":
			return series.sum;
		case "mean":
			return series.sum / series.values;
		case "delta":
			return series.last - series.first;
		case "change":
			if (series.first === 0) return series.last === 0 ? 0 : undefined;
			return ((series.last - series.first) / Math.abs(series.first)) * 100;
	}
}

/** Equal-count bucket means, at most `points` of them, each with its last point's time. */
export function downsample(ring: readonly { t: number; v: number }[], points: number): { t: number; v: number }[] {
	if (ring.length <= points) return ring.slice();
	const out: { t: number; v: number }[] = [];
	for (let bucket = 0; bucket < points; bucket++) {
		const from = Math.floor((bucket * ring.length) / points);
		const to = Math.floor(((bucket + 1) * ring.length) / points);
		let sum = 0;
		for (let index = from; index < to; index++) sum += ring[index].v;
		out.push({ t: ring[to - 1].t, v: sum / (to - from) });
	}
	return out;
}

/** A field's series per key (`""` when its rules capture no key), plus every match merged. */
interface FieldState {
	keys: Map<string, WidgetSeries>;
	all: WidgetSeries;
}

/** One rule as the runtime applies it, with its pattern's named groups resolved to positions. */
interface CompiledRule {
	/** Position of the key group among the pattern's named groups; -1 without a key. */
	key: number;
	/** Fields fed by captures, by group position. */
	captures: { index: number; field: string; text: boolean }[];
	count: string | undefined;
	scale: number;
}

/** The rules reading one source, matched by one native matcher over their distinct patterns. */
interface SourceMatcher {
	matcher: LineMatcher;
	/** Per pattern, entries of a match in the spans: a start and an end per named group. */
	strides: number[];
	/** Per pattern, the rules using it, in spec order. */
	rules: CompiledRule[][];
}

function compileRule(rule: JobWidgetRule, groups: readonly string[]): CompiledRule {
	const captures: CompiledRule["captures"] = [];
	groups.forEach((field, index) => {
		if (field !== rule.key) captures.push({ index, field, text: field === rule.text });
	});
	return {
		key: rule.key === undefined ? -1 : groups.indexOf(rule.key),
		captures,
		count: rule.count,
		scale: rule.scale ?? 1,
	};
}

/** Per-source line statistics: the fallback view and the author's samples. */
interface SourceStats {
	id: string;
	label: string;
	size: number;
	lines: number;
	head: string[];
	tail: string[];
	lastLine?: string;
	lastActiveAt: number;
	/** Non-empty lines per refresh within the rate window. */
	recent: { t: number; n: number }[];
}

/** What the author reads about one source. */
export interface JobWidgetSourceSample {
	id: string;
	label: string;
	/** Text read so far, in the source's own unit (bytes for a pipe). */
	size: number;
	/** Non-empty lines read so far. */
	lines: number;
	/** First and last non-empty lines (no overlap), oldest first. */
	head: string[];
	tail: string[];
}

/** Job facts a view needs besides the derived state. */
export interface JobWidgetViewContext {
	label: string;
	/** A task's stage in its own words, from its progress; the stage line unless a spec rule reads one. */
	stage?: string;
	/**
	 * Whether the newest output line may stand for the stage when nothing
	 * else names it: true for a command's output, not for a subagent's tool
	 * results (file contents, search hits).
	 */
	lineStage?: boolean;
	/** A spec request is in flight. */
	authoring: boolean;
}

/**
 * One job's derivation state under one spec (or none: the fallback view).
 * Installing a new spec starts a fresh runtime that rereads every source
 * from its oldest retained text.
 */
export class JobWidgetRuntime {
	readonly #readers = new Map<string, SourceLineReader>();
	readonly #stats = new Map<string, SourceStats>();
	readonly #fields = new Map<string, FieldState>();
	/** Per source id: the matcher of the rules reading it; `null` when none does. */
	readonly #matchers = new Map<string, SourceMatcher | null>();
	/** Fields some rule splits by key; every other field keeps a single series. */
	readonly #keyedFields = new Set<string>();
	#lastMatchAt: number | undefined;
	#lastLineAt: number | undefined;
	/** Non-empty lines read from the rules' sources since the last match. */
	#unmatchedLines = 0;
	/**
	 * Newest non-empty line on the rules' sources that no rule matched (`warmup
	 * step 3`): a live widget's stage when its spec names no stage field, since
	 * a matched line only repeats what the blocks already show.
	 */
	#lastUnmatchedLine: string | undefined;

	constructor(
		readonly spec: JobWidgetSpec | undefined,
		readonly startTime: number,
		readonly now: () => number = Date.now,
	) {
		for (const rule of spec?.rules ?? []) {
			if (rule.key === undefined) continue;
			for (const { field } of ruleFields(rule)) this.#keyedFields.add(field);
		}
	}

	/** Lines seen since the last match on a source some rule reads. */
	get unmatchedLines(): number {
		return this.#unmatchedLines;
	}

	/** Time of the newest match; `undefined` before the first. */
	get lastMatchAt(): number | undefined {
		return this.#lastMatchAt;
	}

	/** Non-empty lines read across every source. */
	get totalLines(): number {
		let total = 0;
		for (const stats of this.#stats.values()) total += stats.lines;
		return total;
	}

	/** Read every source's new text; `flush` ends lines in progress. Returns whether anything new arrived. */
	ingest(sources: readonly JobTextSource[], flush: boolean): boolean {
		const t = this.now();
		let changed = false;
		for (const source of sources) {
			let reader = this.#readers.get(source.id);
			if (!reader || reader.source !== source) {
				reader = new SourceLineReader(source);
				this.#readers.set(source.id, reader);
			}
			const { lines, end } = reader.read(flush);
			let stats = this.#stats.get(source.id);
			if (!stats) {
				stats = {
					id: source.id,
					label: source.label,
					size: 0,
					lines: 0,
					head: [],
					tail: [],
					lastActiveAt: 0,
					recent: [],
				};
				this.#stats.set(source.id, stats);
			}
			stats.size = end;
			if (lines.length === 0) continue;
			changed = true;
			this.#recordLines(stats, lines, t);
			this.#matchLines(source.id, lines, t);
		}
		return changed;
	}

	#recordLines(stats: SourceStats, lines: readonly string[], t: number): void {
		let fresh = 0;
		// Lines before `tailFrom` filled the head; the tail only needs the newest non-empty ones.
		let tailFrom = 0;
		for (let index = 0; index < lines.length; index++) {
			if (lines[index].trim().length === 0) continue;
			fresh += 1;
			if (stats.head.length < SAMPLE_HEAD_LINES) {
				stats.head.push(lines[index]);
				tailFrom = index + 1;
			}
		}
		if (fresh === 0) return;
		const newest: string[] = [];
		for (let index = lines.length - 1; index >= tailFrom && newest.length < SAMPLE_TAIL_LINES; index--) {
			if (lines[index].trim().length > 0) newest.push(lines[index]);
		}
		if (newest.length > 0) {
			stats.lastLine = newest[0];
			newest.reverse();
			stats.tail =
				stats.tail.length + newest.length > SAMPLE_TAIL_LINES
					? [...stats.tail, ...newest].slice(-SAMPLE_TAIL_LINES)
					: [...stats.tail, ...newest];
		} else {
			stats.lastLine = stats.head.at(-1);
		}
		stats.lines += fresh;
		stats.lastActiveAt = t;
		this.#lastLineAt = t;
		stats.recent.push({ t, n: fresh });
		while (stats.recent.length > 0 && stats.recent[0].t < t - RATE_WINDOW_MS) stats.recent.shift();
	}

	/** The matcher of the rules reading source `id`, compiled on first use. */
	#sourceMatcher(id: string): SourceMatcher | undefined {
		const known = this.#matchers.get(id);
		if (known !== undefined) return known ?? undefined;
		// Rules sharing a pattern (one line read into several fields) run it once.
		const byPattern = new Map<string, JobWidgetRule[]>();
		for (const rule of this.spec?.rules ?? []) {
			if (!ruleReadsSource(rule.from, id)) continue;
			const rules = byPattern.get(rule.match);
			if (rules) rules.push(rule);
			else byPattern.set(rule.match, [rule]);
		}
		if (byPattern.size === 0) {
			this.#matchers.set(id, null);
			return undefined;
		}
		const patterns = [...byPattern.keys()];
		const matcher = new LineMatcher(patterns);
		const groups = matcher.groupNames();
		const entry: SourceMatcher = {
			matcher,
			strides: groups.map(names => names.length * 2),
			rules: patterns.map((pattern, index) =>
				(byPattern.get(pattern) ?? []).map(rule => compileRule(rule, groups[index])),
			),
		};
		this.#matchers.set(id, entry);
		return entry;
	}

	#matchLines(sourceId: string, lines: readonly string[], t: number): void {
		const entry = this.#sourceMatcher(sourceId);
		if (!entry) return;
		const hits = entry.matcher.matchLines(lines.join("\n"));
		const { spans } = hits;
		let offset = 0;
		for (let hit = 0; hit < hits.rules.length; hit++) {
			const pattern = hits.rules[hit];
			const line = lines[hits.lines[hit]];
			for (const rule of entry.rules[pattern]) {
				const keyAt = offset + rule.key * 2;
				const key = rule.key < 0 || spans[keyAt] < 0 ? "" : line.slice(spans[keyAt], spans[keyAt + 1]).trim();
				for (const capture of rule.captures) {
					const at = offset + capture.index * 2;
					if (spans[at] < 0) continue;
					const captured = line.slice(spans[at], spans[at + 1]);
					const value = capture.text ? Number.NaN : parseWidgetValue(captured) * rule.scale;
					// A capture holding no number is kept as text, so a status word still reaches grids.
					if (Number.isFinite(value)) this.#push(capture.field, key, value, undefined, line, t);
					else this.#push(capture.field, key, undefined, captured.trim(), line, t);
				}
				if (rule.count !== undefined) this.#push(rule.count, key, undefined, undefined, line, t);
			}
			offset += entry.strides[pattern];
		}
		const matchCount = hits.lines.length;
		if (matchCount > 0) this.#lastMatchAt = t;
		const lastMatchedLine = matchCount > 0 ? hits.lines[matchCount - 1] : -1;
		let unmatched = 0;
		for (let index = lastMatchedLine + 1; index < lines.length; index++) {
			if (lines[index].trim().length > 0) unmatched += 1;
		}
		this.#unmatchedLines = lastMatchedLine >= 0 ? unmatched : this.#unmatchedLines + unmatched;
		// Hits come ordered by line: walk both backwards to the newest line no rule matched.
		let next = matchCount - 1;
		for (let index = lines.length - 1; index >= 0; index--) {
			while (next >= 0 && hits.lines[next] > index) next -= 1;
			if (next >= 0 && hits.lines[next] === index) continue;
			const line = lines[index].trim();
			if (line.length === 0) continue;
			this.#lastUnmatchedLine = truncate(line, MAX_STAGE_CHARS);
			break;
		}
	}

	#push(
		name: string,
		key: string,
		value: number | undefined,
		text: string | undefined,
		line: string,
		t: number,
	): void {
		let field = this.#fields.get(name);
		if (!field) {
			const all = emptySeries();
			// Without keys the one series is the merged one: fold each match in once.
			field = { keys: this.#keyedFields.has(name) ? new Map() : new Map([["", all]]), all };
			this.#fields.set(name, field);
		}
		let series = field.keys.get(key);
		if (!series) {
			series = emptySeries();
			field.keys.set(key, series);
		}
		pushMatch(series, value, text, line, t);
		if (series !== field.all) pushMatch(field.all, value, text, line, t);
	}

	/** First and last lines per source, most active first, for the author and the dry run. */
	samples(): JobWidgetSourceSample[] {
		return [...this.#stats.values()]
			.filter(stats => stats.lines > 0)
			.sort((a, b) => b.lines - a.lines)
			.map(stats => ({
				id: stats.id,
				label: stats.label,
				size: stats.size,
				lines: stats.lines,
				head: stats.head.slice(),
				tail: stats.tail.slice(),
			}));
	}

	/** The view now: the spec's blocks when a spec drives it, else the fallback. */
	view(context: JobWidgetViewContext): JobWidgetView {
		const now = this.now();
		const updatedAt = this.#lastMatchAt ?? this.#lastLineAt ?? this.startTime;
		const spec = this.spec;
		const lineStage = context.lineStage === true;
		if (!spec) {
			const stage = context.stage ?? (lineStage ? this.#lastLine() : undefined);
			const state: JobWidgetState = context.authoring ? "authoring" : "fallback";
			return {
				title: truncate(context.label.replace(/\s+/g, " ").trim(), MAX_TITLE_CHARS),
				...(stage ? { stage } : {}),
				blocks: this.#fallbackBlocks(now),
				state,
				updatedAt,
			};
		}
		const headline = spec.headline ? this.#headline(spec.headline, now) : undefined;
		const stage =
			(spec.stage ? this.#specStage() : undefined) ??
			context.stage ??
			(lineStage ? this.#lastUnmatchedLine : undefined);
		return {
			title: spec.title,
			...(headline ? { headline } : {}),
			...(stage ? { stage } : {}),
			// A block with nothing to draw yet (no matches) is left out; the head row still shows.
			blocks: spec.blocks.map(block => this.#block(block, now)).filter(hasData),
			state: "live",
			updatedAt,
		};
	}

	#fallbackBlocks(now: number): JobWidgetBlock[] {
		const total = this.totalLines;
		if (total === 0) return [];
		let recent = 0;
		for (const stats of this.#stats.values()) {
			for (const entry of stats.recent) if (entry.t >= now - RATE_WINDOW_MS) recent += entry.n;
		}
		const perSecond = recent / (rateWindowMs(now, this.startTime) / 1000);
		return [
			{
				kind: "stat",
				items: [
					{ label: "lines", text: formatWidgetNumber(total) },
					{ label: "lines/s", text: formatWidgetNumber(perSecond) },
				],
			},
		];
	}

	#specStage(): string | undefined {
		const field = this.spec?.stage ? this.#fields.get(this.spec.stage) : undefined;
		const text = (field?.all.text ?? field?.all.line)?.trim();
		return text ? truncate(text, MAX_STAGE_CHARS) : undefined;
	}

	/** Last non-empty line of the most recently active source, a pipe preferred over the job's own output. */
	#lastLine(): string | undefined {
		let best: SourceStats | undefined;
		let bestIsPipe = false;
		for (const stats of this.#stats.values()) {
			if (!stats.lastLine) continue;
			const isPipe = /(?:^|:)pipe:/.test(stats.id);
			if (!best || (isPipe && !bestIsPipe) || (isPipe === bestIsPipe && stats.lastActiveAt >= best.lastActiveAt)) {
				best = stats;
				bestIsPipe = isPipe;
			}
		}
		return best?.lastLine ? truncate(best.lastLine.trim(), MAX_STAGE_CHARS) : undefined;
	}

	#series(field: string, key: string | undefined): WidgetSeries {
		const state = this.#fields.get(field);
		if (!state) return emptySeries();
		if (key === undefined) return state.all;
		return state.keys.get(key) ?? emptySeries();
	}

	#value(ref: JobWidgetValueRef, now: number): { text: string; value: number | undefined; trend?: JobWidgetTrend } {
		const series = this.#series(ref.field, ref.key);
		const value = aggregateSeries(series, ref.agg, now, this.startTime);
		const unit = ref.agg === "change" ? "%" : ref.unit;
		const text = value === undefined ? "—" : formatWidgetNumber(value, unit, ref.digits);
		// A trend reads as "where the value went": only for value-like aggs, with a
		// direction, at least two points, and an actual move.
		const trend =
			ref.better && TREND_AGGS[ref.agg] && series.values >= 2
				? formatWidgetTrend(series.first, series.last, ref.better, ref.unit)
				: undefined;
		return { text, value, ...(trend ? { trend } : {}) };
	}

	#headline(ref: JobWidgetValueRef & { label?: string }, now: number): JobWidgetHeadline | undefined {
		const { text, value, trend } = this.#value(ref, now);
		if (value === undefined) return undefined;
		return { text, ...(ref.label ? { label: ref.label } : {}), ...(trend ? { trend } : {}) };
	}

	#block(block: JobWidgetBlockSpec, now: number): JobWidgetBlock {
		switch (block.kind) {
			case "spark":
				return this.#spark(block);
			case "bars": {
				const state = this.#fields.get(block.field);
				const entries = state ? [...state.keys.entries()].slice(-MAX_BAR_ITEMS) : [];
				const unit = block.agg === "change" ? "%" : block.unit;
				const values = entries.map(([, series]) => aggregateSeries(series, block.agg, now, this.startTime) ?? 0);
				// With a direction, the leading bar(s) stand out once there is something to compare.
				const best =
					block.better && values.length > 1
						? block.better === "higher"
							? Math.max(...values)
							: Math.min(...values)
						: undefined;
				const labels = keyLabels(entries.map(([key]) => key));
				const items = entries.map(([key], index) => ({
					label: labels[index] || key || block.label,
					value: values[index],
					text: formatWidgetNumber(values[index], unit),
					...(best !== undefined && values[index] === best ? { tone: "success" as const } : {}),
				}));
				const peak = Math.max(0, ...values);
				return { kind: "bars", label: block.label, items, max: block.max ?? (peak > 0 ? peak : 1) };
			}
			case "meter": {
				const value = aggregateSeries(this.#series(block.field, block.key), block.agg, now, this.startTime) ?? 0;
				const total = typeof block.total === "number" ? block.total : (this.#value(block.total, now).value ?? 0);
				const fraction = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
				const text = `${formatWidgetNumber(value)}/${formatWidgetNumber(total, block.unit)}`;
				return {
					kind: "meter",
					label: block.label,
					value: fraction,
					text,
					...(total > 0 && value >= total ? { tone: "success" as const } : {}),
				};
			}
			case "stat":
				return {
					kind: "stat",
					items: block.items.map(item => {
						const { text, trend } = this.#value(item, now);
						return { label: item.label, text, ...(trend ? { trend } : {}) };
					}),
				};
			case "grid": {
				const state = this.#fields.get(block.field);
				const entries = state ? [...state.keys.entries()].slice(-MAX_GRID_ITEMS) : [];
				const labels = keyLabels(entries.map(([key]) => key));
				return {
					kind: "grid",
					label: block.label,
					items: entries.map(([key, series], index) => {
						const text = truncate(
							series.text ?? (series.values > 0 ? formatWidgetNumber(series.last) : (series.line?.trim() ?? "")),
							MAX_TEXT_CHARS,
						);
						return { label: labels[index] || key || block.label, text, tone: gridTone(block.tones, text) };
					}),
				};
			}
			case "text": {
				const series = this.#series(block.field, undefined);
				return { kind: "text", text: truncate(series.text ?? series.line?.trim() ?? "", MAX_TEXT_CHARS) };
			}
		}
	}

	#spark(block: Extract<JobWidgetBlockSpec, { kind: "spark" }>): JobWidgetSparkBlock {
		const series = this.#series(block.field, block.key);
		const ring = series.ring.length > RING_POINTS ? series.ring.slice(-RING_POINTS) : series.ring;
		const points = downsample(ring, SPARK_POINTS);
		const values = points.map(point => point.v);
		const marks =
			block.target === undefined
				? undefined
				: [
						{
							value: block.target,
							label: block.targetLabel ?? `target ${formatWidgetNumber(block.target, block.unit)}`,
							tone: "muted" as const,
						},
					];
		const { min, max } = sparkDomain([...values, ...(marks ?? []).map(mark => mark.value)], block.min, block.max);
		let tone: TspTone | undefined;
		if (block.better && block.target !== undefined && series.values > 0) {
			const reached = block.better === "higher" ? series.last >= block.target : series.last <= block.target;
			if (reached) tone = "success";
		}
		return {
			kind: "spark",
			label: block.label,
			values,
			min,
			max,
			...(marks ? { marks } : {}),
			last: series.values > 0 ? formatWidgetNumber(series.last, block.unit) : "—",
			tips: points.map(
				point => `${new Date(point.t).toTimeString().slice(0, 8)} · ${formatWidgetNumber(point.v, block.unit)}`,
			),
			...(tone ? { tone } : {}),
		};
	}
}

/**
 * A spark's value domain: the data's range (values and marks) padded by 10%
 * on both sides, so a series moving within 160–186 does not draw as a flat
 * bar; a flat series pads by max(1, 5% of its value). The bottom stays at or
 * above 0 when every bound is non-negative. A spec's `min`/`max` win.
 */
export function sparkDomain(
	bounds: readonly number[],
	specMin?: number,
	specMax?: number,
): { min: number; max: number } {
	let min = 0;
	let max = 1;
	if (bounds.length > 0) {
		const lo = Math.min(...bounds);
		const hi = Math.max(...bounds);
		const pad = hi > lo ? (hi - lo) * 0.1 : Math.max(1, Math.abs(hi) * 0.05);
		min = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
		max = hi + pad;
	}
	min = specMin ?? min;
	max = specMax ?? max;
	if (max <= min) max = min + 1;
	return { min, max };
}

/** Aggregations whose value a trend arrow can describe; counts, rates and derived numbers have none. */
const TREND_AGGS: Partial<Record<JobWidgetAgg, true>> = { last: true, min: true, max: true };

/** Whether a block has anything to draw; meters and stats always do. */
function hasData(block: JobWidgetBlock): boolean {
	switch (block.kind) {
		case "text":
			return block.text.length > 0;
		case "bars":
		case "grid":
			return block.items.length > 0;
		case "spark":
			return block.values.length > 0;
		default:
			return true;
	}
}

/**
 * Bar and cell labels for keys: the last `/` segment when every key has one
 * and those segments stay unique (`openai-codex/gpt-6-luna` → `gpt-6-luna`),
 * else the keys as they are.
 */
export function keyLabels(keys: readonly string[]): string[] {
	if (keys.length === 0 || !keys.every(key => key.includes("/"))) return keys.slice();
	const short = keys.map(key => key.slice(key.lastIndexOf("/") + 1));
	return short.every(label => label.length > 0) && new Set(short).size === short.length ? short : keys.slice();
}

/** Tone of a grid cell: the first `tones` entry whose status is a case-insensitive substring of the text. */
function gridTone(tones: Record<string, TspTone>, text: string): TspTone {
	const lower = text.toLowerCase();
	for (const status in tones) {
		if (lower.includes(status.toLowerCase())) return tones[status];
	}
	return "neutral";
}

/** Samples as plain line lists for {@link validateJobWidgetSpec}'s dry run. */
export function sampleLines(samples: readonly JobWidgetSourceSample[]): JobWidgetSampleLines[] {
	return samples.map(sample => ({ id: sample.id, lines: [...sample.head, ...sample.tail] }));
}
