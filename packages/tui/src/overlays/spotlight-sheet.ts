/**
 * The Spotlight sheet: how shaping reduced one tool result. A large glass sheet (role
 * `omp.overlay.spotlight`; it fills a narrow pane) in one column: what Spotlight was asked (the intent, the other
 * request parameters a click away), a legend of why lines were shown or hidden beside the ranking step's budget and
 * cutoff, then the original as one `code` element per window (a `;`/`,` path `read` joins several, each under its path
 * and its own ranking's budget and cutoff). Every run of lines the model did not see folds into one row
 * labelled with the marker the model read in its place; each line's gutter takes the tone of why shaping showed or hid
 * it, and its row is washed by its score's parts, a gradient across it from left to right like a heat map (by
 * Spotlight's heat without a rank), and an overview strip above the lines maps the whole result. A fold hiding a hot
 * line says why it was cut, on its row and in a hover card. The
 * shaping notes the model saw follow the code. A held-out result's sheet shows the cut shaping would have made (its
 * title says the model saw the original): folds, labels and notes come from the would-be text. Esc, Close or a
 * backdrop click closes it; nothing enters the transcript.
 */
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspCodeFold, TspCodeMark, TspPropNode, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import {
	SPOTLIGHT_VIEW_LINES,
	type SpotlightDetails,
	type SpotlightOriginal,
	type SpotlightRank,
	type SpotlightReason,
	type SpotlightRequestParams,
	type SpotlightWindow,
	heatAt,
	originalWindows,
	rankPartAt,
	reasonAt,
	reasonShows,
	spotlightHot,
	spotlightSaving,
	spotlightTone,
} from "../chat/spotlight";
import { matchesSelectCancel } from "../keybinding-matchers";
import { code, col, compact, node, propNode, row, span, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import type { Component } from "../tui";
import { truncateToWidth } from "../utils";

export interface SpotlightSheetOptions {
	spotlight: SpotlightDetails & { original: SpotlightOriginal };
	/** The original text, as its artifact holds it. */
	original: string;
	/**
	 * The text the model saw, or of a held-out result the would-be text its `shapedUrl` holds (its lines label folds and
	 * give the shaping notes, through the trace's `map`).
	 */
	reduced: string;
	close(): void;
}

/** Why a hidden line went, as a fold says it. */
const CUT_WHY: Partial<Record<SpotlightReason, string>> = {
	b: "cut by the budget",
	r: "seen in an earlier call",
	f: "folded",
};

/** A class of line the summary counts: a reason that showed it, or how it was hidden. */
type LineClass = "a" | "s" | "n" | "c" | "hot" | "cut";

/** The summary's legend, in order: each class, its swatch tone and its label. */
const LEGEND: readonly { cls: LineClass; tone: TspTone; label: string }[] = [
	{ cls: "a", tone: "accent", label: "kept by score" },
	{ cls: "s", tone: "neutral", label: "kept as structure" },
	{ cls: "n", tone: "user", label: "named" },
	{ cls: "c", tone: "info", label: "kept as context" },
	{ cls: "hot", tone: "error", label: "cut though hot" },
	{ cls: "cut", tone: "muted", label: "cut" },
];

/** One legend entry (role `omp.spotlight.key`): a swatch and a muted label. */
function legendKey(swatch: NativeNode, label: string): NativeNode {
	return row([swatch, text([span(label, "muted")])], { gap: "xs", align: "center", role: "omp.spotlight.key" });
}

/** A count with thousands separators. */
function count(n: number): string {
	return n.toLocaleString("en-US");
}

/** A score or heat to two decimals. */
function fixed(n: number): string {
	return n.toFixed(2);
}

/** One request parameter: its name, its values (dim dots between them), and how its row draws them. */
interface Param {
	name: string;
	values: readonly string[];
	style?: string;
}

/** The request's parameters that are not blank, in the sheet's order. */
function nonBlankParams(params: SpotlightRequestParams): Param[] {
	const all: Param[] = [
		{ name: "intent", values: [params.intent] },
		{ name: "said", values: [params.said] },
		{ name: "task", values: [params.task] },
		{ name: "commands", values: params.commands, style: "mono" },
		{ name: "source", values: [params.source], style: "mono" },
		{ name: "probe", values: [params.probe], style: "mono" },
		{ name: "model", values: [params.model, `${params.thinking} thinking`] },
	];
	return all.filter(param => param.values.some(value => sanitizeText(value).trim() !== ""));
}

/**
 * One parameter's row (role `omp.spotlight.param`): its name, then its non-blank values on one run of spaces and at
 * most `lines` lines, whole in the tooltip; `end` (the toggle) last.
 */
function paramRow(param: Param, lines: number, end?: NativeNode): NativeNode {
	const whole = param.values.map(value => sanitizeText(value).trim()).filter(Boolean);
	const spans = whole.flatMap((value, i) => {
		const part = span(value.replace(/\s+/g, " "), param.style);
		// The separator takes the values' face: Geist spaces between mono runs read as none.
		return i === 0 ? [part] : [span(" · ", param.style ? `dim ${param.style}` : "dim"), part];
	});
	const shown = text(spans, { lines, truncate: "end", title: whole.join("\n") });
	return row(compact([text(param.name), shown, end]), { gap: "md", align: "baseline", role: "omp.spotlight.param" });
}

/**
 * What the result's Spotlight requests sent besides its lines (role `omp.spotlight.params`): collapsed, the first
 * parameter (the intent) on one line and a toggle naming the rest; expanded, a row per parameter.
 */
function requestParams(params: SpotlightRequestParams, expanded: boolean): NativeNode | undefined {
	const named = nonBlankParams(params);
	if (named.length === 0) return undefined;
	const rest = named.slice(1);
	const toggle =
		rest.length > 0
			? text(expanded ? "fewer ▾" : `${rest.map(param => param.name).join(", ")} ▸`, {
					role: "omp.spotlight.more",
					actions: { click: "params" },
				})
			: undefined;
	const rows = (expanded ? named : named.slice(0, 1)).map((param, i) =>
		paramRow(param, expanded ? 2 : 1, i === 0 ? toggle : undefined),
	);
	return col(rows, { gap: "xs", role: "omp.spotlight.params" });
}

/** The class the summary counts original line `i` (0-based) in; undefined without a reason. */
function lineClass(original: SpotlightOriginal, i: number): LineClass | undefined {
	const reason = reasonAt(original.why, i);
	if (reason === undefined || reason === "-") return undefined;
	if (reasonShows(reason)) return reason as LineClass;
	return spotlightHot(original.heat, i) ? "hot" : "cut";
}

/** A ranking step's budget and cutoff, as the summary or a window's head says them. */
function rankFacts(rank: SpotlightRank): string {
	return rank.budget !== undefined
		? `budget ${count(rank.used ?? 0)} of ${count(rank.budget)} chars · cutoff ${fixed(rank.cutoff)}`
		: `cutoff ${fixed(rank.cutoff)}`;
}

/**
 * The summary row (role `omp.spotlight.summary`): a legend swatch and count per class of the shown lines (with
 * reasons), then the ranking step's budget and cutoff (`rank`, of a one-window original) and whether the view is cut;
 * undefined when it has nothing.
 */
function summary(
	original: SpotlightOriginal,
	rank: SpotlightRank | undefined,
	shown: number,
	total: number,
): NativeNode | undefined {
	const items: NativeNode[] = [];
	if (original.why !== undefined) {
		const counts = new Map<LineClass, number>();
		for (let i = 0; i < shown; i++) {
			const cls = lineClass(original, i);
			if (cls !== undefined) counts.set(cls, (counts.get(cls) ?? 0) + 1);
		}
		for (const { cls, tone, label } of LEGEND) {
			const n = counts.get(cls);
			if (n) items.push(legendKey(text("■", { role: "omp.spotlight.swatch", tone }), `${label} ${count(n)}`));
		}
	}
	const facts: string[] = [];
	if (rank) facts.push(rankFacts(rank));
	if (shown < total) facts.push(`first ${count(shown)} of ${count(total)} lines`);
	if (items.length === 0 && facts.length === 0) return undefined;
	const budget = facts.length > 0 && text([span(facts.join(" · "), "muted")], { role: "omp.spotlight.budget" });
	return row(compact([...items, node("spacer", { grow: 1 }), budget]), {
		gap: "md",
		align: "center",
		wrap: true,
		role: "omp.spotlight.summary",
	});
}

/** The parts of a window's line `i`'s (0-based, relative to the window) score, in the rank's order. */
function rankParts(rank: SpotlightRank, i: number): number[] {
	return rank.values.map(values => rankPartAt(values, i, rank.max));
}

/** The line number original line `i` (0-based) of `window` is drawn with. */
function lineNumber(window: SpotlightWindow, i: number): number {
	return window.start + i - window.at;
}

/**
 * The mark of original line `i` (0-based) of `window`, numbered from the window's `start`: its heat, its reason's tone
 * and its score's parts in the window's rank as the row's wash (each a rank in [0, 1]); undefined for a line with
 * neither heat nor tone (a bare mark would draw the default accent bar).
 */
function lineMark(original: SpotlightOriginal, window: SpotlightWindow, i: number): TspCodeMark | undefined {
	const heat = heatAt(original.heat, i);
	const tone = spotlightTone(original, i);
	if (heat === undefined && tone === undefined) return undefined;
	const mark: { line: number; heat?: number; tone?: TspTone; wash?: number[] } = { line: lineNumber(window, i) };
	if (heat !== undefined) mark.heat = heat;
	if (tone !== undefined) mark.tone = tone;
	if (window.rank) mark.wash = rankParts(window.rank, i - window.at);
	return mark;
}

/** Whether each of the first `shown` original lines reached the model: by its reason when it has one, else `kept`. */
function shownMask(original: SpotlightOriginal, shown: number): boolean[] {
	const mask = Array.from({ length: shown }, () => false);
	for (const [from, to] of original.kept) {
		for (let i = Math.max(1, from); i <= Math.min(shown, to); i++) mask[i - 1] = true;
	}
	for (let i = 0; i < shown; i++) {
		const reason = reasonAt(original.why, i);
		if (reason !== undefined && reason !== "-") mask[i] = reasonShows(reason);
	}
	return mask;
}

/** The original's lines as the sheet shows them, and the model-facing lines its trace maps them to. */
interface SheetText {
	original: SpotlightOriginal;
	/** The original's lines, up to the view cap. */
	lines: readonly string[];
	/** Whether each of {@link lines} reached the model ({@link shownMask}). */
	shown: readonly boolean[];
	/** The text the model saw, line by line. */
	reduced: readonly string[];
}

/**
 * One window as the sheet shows it: its 0-based original lines `from` to `end` (exclusive), within the view cap, of
 * the `lines` it has.
 */
interface Section {
	window: SpotlightWindow;
	from: number;
	end: number;
	lines: number;
}

/**
 * The original's windows, `shown` of its `total` lines in view; the last runs to the original's end, as the windows
 * cover it. A window past the view keeps its section, empty.
 */
function sections(original: SpotlightOriginal, shown: number, total: number): Section[] {
	const windows = originalWindows(original);
	return windows.map((window, w) => {
		const from = Math.max(0, window.at);
		const full = w === windows.length - 1 ? Math.max(total, from) : window.at + window.lines;
		return { window, from, end: Math.max(from, Math.min(full, shown)), lines: full - from };
	});
}

/** The model-facing marker standing for 0-based original lines `from..to`: the one `map` pair covering them all. */
function foldLabel(sheet: SheetText, from: number, to: number): string | undefined {
	const map = sheet.original.map;
	if (!map) return undefined;
	let marker = -1;
	for (let j = 0; j < map.length; j++) {
		const entry = map[j];
		if (!Array.isArray(entry) || entry[0] > from + 1 || entry[1] < to + 1) continue;
		if (marker >= 0) return undefined;
		marker = j;
	}
	const label = marker >= 0 ? sheet.reduced[marker]?.trimEnd() : undefined;
	return label || undefined;
}

/**
 * Why hot original line `i` (0-based) of `window` was cut, naming the line that took the window's budget's end when
 * the budget cut it.
 */
function cutWhy(original: SpotlightOriginal, window: SpotlightWindow, i: number): string | undefined {
	const reason = reasonAt(original.why, i);
	const rank = window.rank;
	const last = rank?.last;
	if (reason === "b" && rank && last) {
		const total = rankParts(rank, last.line - 1).reduce((sum, part) => sum + part, 0);
		return `cut by the budget: line ${window.start + last.line - 1} (${fixed(total)}) took the last ${count(last.chars)} chars`;
	}
	return reason === undefined ? undefined : CUT_WHY[reason];
}

/**
 * The hover card of a fold hiding hot original line `i` (0-based) of `window`: the line as the sheet draws it, its
 * score, why it went.
 */
function hotCard(sheet: SheetText, window: SpotlightWindow, i: number): TspPropNode {
	const { original } = sheet;
	const rank = window.rank;
	const line = lineNumber(window, i);
	const why = cutWhy(original, window, i);
	const parts = rank ? rankParts(rank, i - window.at) : [];
	return propNode(
		col(
			compact([
				text([span(`line ${line} · the hottest line this fold hides`, "muted")]),
				code(sheet.lines[i] ?? "", {
					path: window.path,
					start: line,
					numbers: true,
					marks: compact([lineMark(original, window, i)]),
				}),
				rank &&
					text([
						span(
							`${parts.map(fixed).join(" + ")} = ${fixed(parts.reduce((sum, part) => sum + part, 0))} · cutoff ${fixed(rank.cutoff)}`,
							"muted",
						),
					]),
				why !== undefined && text([span(why, "error")]),
			]),
			{ gap: "xs", role: "omp.spotlight.card" },
		),
	);
}

/**
 * The fold of 0-based original lines `from..to` of `window`, all hidden from the model: the marker it read for them, how many
 * there are and their peak heat, and, when one scored hot, which and why it was cut (tinted, with a hover card).
 */
function fold(sheet: SheetText, window: SpotlightWindow, from: number, to: number): TspCodeFold {
	const { original } = sheet;
	let peak: number | undefined;
	let hot = -1;
	let hotHeat = -1;
	for (let i = from; i <= to; i++) {
		const heat = heatAt(original.heat, i);
		if (heat === undefined) continue;
		if (peak === undefined || heat > peak) peak = heat;
		if (heat > hotHeat && spotlightTone(original, i) === "error") {
			hot = i;
			hotHeat = heat;
		}
	}
	const n = to - from + 1;
	const note: TspSpan[] = [
		span(`${count(n)} ${n === 1 ? "line" : "lines"}${peak === undefined ? "" : ` · peak ${fixed(peak)}`}`, "muted"),
	];
	const out: TspCodeFold = { from: lineNumber(window, from), to: lineNumber(window, to) };
	const label = foldLabel(sheet, from, to);
	if (hot < 0) return { ...out, ...(label ? { label } : {}), note };
	const why = CUT_WHY[reasonAt(original.why, hot) ?? "-"];
	note.push(span(` · line ${lineNumber(window, hot)}${why ? ` ${why}` : ""}`, "error"));
	return { ...out, ...(label ? { label } : {}), note, tone: "error", hovercard: hotCard(sheet, window, hot) };
}

/** One fold per maximal run of a section's lines the model did not see; none spans two windows. */
function folds(sheet: SheetText, { window, from, end }: Section): TspCodeFold[] {
	const mask = sheet.shown;
	const out: TspCodeFold[] = [];
	for (let i = from; i < end; i++) {
		if (mask[i]) continue;
		let last = i;
		while (last + 1 < end && !mask[last + 1]) last++;
		out.push(fold(sheet, window, i, last));
		i = last;
	}
	return out;
}

/** Fewer original lines than this fit the sheet whole: an overview of them would only repeat the gutter. */
const OVERVIEW_MIN_LINES = 60;

/**
 * One window of the original as a `code` element (role `omp.spotlight.code`), numbered from the window's start:
 * marks, folds, and the overview past {@link OVERVIEW_MIN_LINES}. Command output (no file) wraps, a file keeps its
 * lines.
 */
function windowCode(sheet: SheetText, section: Section): NativeNode {
	const { original } = sheet;
	const { window, from, end } = section;
	const lines = sheet.lines.slice(from, end);
	const marks = compact(lines.map((_, j) => lineMark(original, window, from + j)));
	const shut = folds(sheet, section);
	return code(lines.join("\n"), {
		role: "omp.spotlight.code",
		path: window.path,
		start: window.start,
		numbers: true,
		...(window.path ? {} : { wrap: true }),
		...(lines.length >= OVERVIEW_MIN_LINES ? { overview: true } : {}),
		...(marks.length > 0 ? { marks } : {}),
		...(shut.length > 0 ? { folds: shut } : {}),
	});
}

/**
 * A window of several (role `omp.spotlight.window`): its head (role `omp.spotlight.head`: the file it shows, how much
 * of it the view cap left (role `omp.spotlight.clip`), and its ranking's budget and cutoff, when it has any) over its
 * code, absent when the cap left none of it.
 */
function windowSection(sheet: SheetText, section: Section): NativeNode {
	const { path, rank } = section.window;
	const shown = section.end - section.from;
	const clip =
		shown === 0
			? `not shown: past the first ${count(SPOTLIGHT_VIEW_LINES)} lines`
			: shown < section.lines
				? `${count(shown)} of ${count(section.lines)} lines shown`
				: undefined;
	const head =
		(path !== undefined || clip !== undefined || rank) &&
		row(
			compact([
				path !== undefined && text([span(path, "mono")]),
				clip !== undefined && text([span(clip, "muted")], { role: "omp.spotlight.clip" }),
				node("spacer", { grow: 1 }),
				rank && text([span(rankFacts(rank), "muted")], { role: "omp.spotlight.budget" }),
			]),
			{ gap: "md", align: "baseline", role: "omp.spotlight.head" },
		);
	return col(compact([head, shown > 0 && windowCode(sheet, section)]), { gap: "xs", role: "omp.spotlight.window" });
}

/**
 * The shaping notes the model saw, or would have seen (its lines no original line maps to), under a heading; undefined
 * without any.
 */
function shapingNotes(sheet: SheetText, heldOut: boolean): NativeNode | undefined {
	const map = sheet.original.map;
	if (!map) return undefined;
	const notes: string[] = [];
	for (let j = 0; j < map.length; j++) {
		const line = map[j] === null ? sheet.reduced[j]?.trimEnd() : undefined;
		if (line) notes.push(line);
	}
	if (notes.length === 0) return undefined;
	const heading = heldOut ? "notes the model would have seen" : "notes the model saw";
	return col([text([span(heading, "muted")]), ...notes.map(note => text([span(note, "muted mono")]))], {
		gap: "xs",
		role: "omp.spotlight.notes",
	});
}

/** A rank's parts in their order across a row, as its legend names them. */
function rankLabel(rank: SpotlightRank): string {
	return rank.parts.length > 1 ? `row tint, left to right: ${rank.parts.join(" → ")}` : `row tint: ${rank.parts[0]}`;
}

/**
 * The footer's key to the rows' wash (role `omp.spotlight.legend`): the heat ramp (role `omp.spotlight.ramp`, drawn
 * by the terminal) before a rank's parts in their order across a row ({@link rankLabel}).
 */
function rankLegend(label: string): NativeNode {
	return row([legendKey(text("", { role: "omp.spotlight.ramp" }), label)], {
		align: "center",
		role: "omp.spotlight.legend",
	});
}

export class SpotlightSheet implements Component {
	readonly nativeOverlay: { role: string; head: string; size: "lg"; anchor: "center" };
	readonly #options: SpotlightSheetOptions;
	/** Every request parameter shown, not only the intent. */
	#expanded = false;
	/** The column below the parameters, which no toggle changes. */
	#body: NativeNode[] | undefined;
	#native: NativeNode | undefined;

	constructor(options: SpotlightSheetOptions) {
		this.#options = options;
		const s = options.spotlight;
		const saving = spotlightSaving(s);
		const saved =
			s.holdout || s.gated
				? `would save ${formatNumber(Math.max(0, saving))} toks`
				: saving >= 0
					? `saved ${formatNumber(saving)} toks`
					: `+${formatNumber(-saving)} toks`;
		const heldOut = s.holdout
			? "held out (the model saw the original) · "
			: s.gated
				? "kept whole for editing (the model saw the original) · "
				: "";
		this.nativeOverlay = {
			role: "omp.overlay.spotlight",
			head: `⭐ Spotlight · ${heldOut}${s.tool} · ${formatNumber(s.inChars)} → ${formatNumber(s.outChars)} chars · ${saved}`,
			size: "lg",
			anchor: "center",
		};
	}

	describe(): NativeNode {
		if (this.#native) return this.#native;
		const request = this.#options.spotlight.request;
		this.#native = col(compact([request && requestParams(request, this.#expanded), ...this.#describeBody()]), {
			gap: "md",
		});
		return this.#native;
	}

	#describeBody(): NativeNode[] {
		if (this.#body) return this.#body;
		const { spotlight } = this.#options;
		const original = spotlight.original;
		const all = sanitizeText(this.#options.original).split("\n");
		const lines = all.slice(0, SPOTLIGHT_VIEW_LINES);
		const sheet: SheetText = {
			original,
			lines,
			shown: shownMask(original, lines.length),
			reduced: sanitizeText(this.#options.reduced).split("\n"),
		};
		const windows = originalWindows(original);
		const single = windows.length === 1;
		// One legend per distinct order of rank parts across the windows.
		const legends = [...new Set(compact(windows.map(window => window.rank && rankLabel(window.rank))))];
		this.#body = compact([
			summary(original, single ? windows[0].rank : undefined, lines.length, all.length),
			...sections(original, lines.length, all.length).map(section =>
				single ? section.end > section.from && windowCode(sheet, section) : windowSection(sheet, section),
			),
			shapingNotes(sheet, spotlight.holdout === true || spotlight.gated === true),
			actionBar([...legends.map(rankLegend), null, actionButton("Close", "close", { keys: "escape" })]),
		]);
		return this.#body;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.nativeOverlay.head, width), truncateToWidth("Esc closes", width)];
	}

	invalidate(): void {
		this.#native = undefined;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) this.#options.close();
	}

	/** Close runs what Esc runs; the parameters' toggle shows every parameter or only the intent. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "close") this.#options.close();
		else if (event.act === "params") {
			this.#expanded = !this.#expanded;
			this.#native = undefined;
		}
	}
}

/** Whether a trace has an original to show. */
export function hasSpotlightOriginal(
	spotlight: SpotlightDetails,
): spotlight is SpotlightDetails & { original: SpotlightOriginal } {
	return spotlight.original !== undefined;
}
