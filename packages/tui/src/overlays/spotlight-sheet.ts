/**
 * The Spotlight sheet: how shaping reduced one tool result. A large glass sheet (role
 * `omp.overlay.spotlight`; it fills a narrow pane) in one column: what Spotlight was asked (the intent, the other
 * request parameters a click away), a legend of why lines were shown or hidden beside the ranking step's budget and
 * cutoff, then the original as one `code` element. Every run of lines the model did not see folds into one row
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
	heatAt,
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

/**
 * The summary row (role `omp.spotlight.summary`): a legend swatch and count per class of the shown lines (with
 * reasons), then the ranking step's budget and cutoff and whether the view is cut; undefined when it has nothing.
 */
function summary(original: SpotlightOriginal, shown: number, total: number): NativeNode | undefined {
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
	const rank = original.rank;
	if (rank) {
		facts.push(
			rank.budget !== undefined
				? `budget ${count(rank.used ?? 0)} of ${count(rank.budget)} chars · cutoff ${fixed(rank.cutoff)}`
				: `cutoff ${fixed(rank.cutoff)}`,
		);
	}
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

/** The parts of original line `i`'s (0-based) score, in the rank's order. */
function rankParts(rank: SpotlightRank, i: number): number[] {
	return rank.values.map(values => rankPartAt(values, i, rank.max));
}

/**
 * The mark of original line `i` (0-based), numbered from its `start`: its heat, its reason's tone and its score's
 * parts as the row's wash (each a rank in [0, 1]); undefined for a line with neither heat nor tone (a bare mark would
 * draw the default accent bar).
 */
function lineMark(original: SpotlightOriginal, i: number): TspCodeMark | undefined {
	const heat = heatAt(original.heat, i);
	const tone = spotlightTone(original, i);
	if (heat === undefined && tone === undefined) return undefined;
	const mark: { line: number; heat?: number; tone?: TspTone; wash?: number[] } = { line: original.start + i };
	if (heat !== undefined) mark.heat = heat;
	if (tone !== undefined) mark.tone = tone;
	if (original.rank) mark.wash = rankParts(original.rank, i);
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
	path: string | undefined;
	/** The original's lines, up to the view cap. */
	lines: readonly string[];
	/** The text the model saw, line by line. */
	reduced: readonly string[];
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

/** Why hot original line `i` (0-based) was cut, naming the line that took the budget's end when the budget cut it. */
function cutWhy(original: SpotlightOriginal, i: number): string | undefined {
	const reason = reasonAt(original.why, i);
	const last = original.rank?.last;
	if (reason === "b" && original.rank && last) {
		const total = rankParts(original.rank, last.line - 1).reduce((sum, part) => sum + part, 0);
		return `cut by the budget: line ${original.start + last.line - 1} (${fixed(total)}) took the last ${count(last.chars)} chars`;
	}
	return reason === undefined ? undefined : CUT_WHY[reason];
}

/** The hover card of a fold hiding hot original line `i` (0-based): the line as the sheet draws it, its score, why it went. */
function hotCard(sheet: SheetText, i: number): TspPropNode {
	const { original } = sheet;
	const rank = original.rank;
	const line = original.start + i;
	const why = cutWhy(original, i);
	const parts = rank ? rankParts(rank, i) : [];
	return propNode(
		col(
			compact([
				text([span(`line ${line} · the hottest line this fold hides`, "muted")]),
				code(sheet.lines[i] ?? "", {
					path: sheet.path,
					start: line,
					numbers: true,
					marks: compact([lineMark(original, i)]),
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
 * The fold of 0-based original lines `from..to`, all hidden from the model: the marker it read for them, how many
 * there are and their peak heat, and, when one scored hot, which and why it was cut (tinted, with a hover card).
 */
function fold(sheet: SheetText, from: number, to: number): TspCodeFold {
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
	const out: TspCodeFold = { from: original.start + from, to: original.start + to };
	const label = foldLabel(sheet, from, to);
	if (hot < 0) return { ...out, ...(label ? { label } : {}), note };
	const why = CUT_WHY[reasonAt(original.why, hot) ?? "-"];
	note.push(span(` · line ${original.start + hot}${why ? ` ${why}` : ""}`, "error"));
	return { ...out, ...(label ? { label } : {}), note, tone: "error", hovercard: hotCard(sheet, hot) };
}

/** One fold per maximal run of the shown lines the model did not see. */
function folds(sheet: SheetText): TspCodeFold[] {
	const mask = shownMask(sheet.original, sheet.lines.length);
	const out: TspCodeFold[] = [];
	for (let i = 0; i < mask.length; i++) {
		if (mask[i]) continue;
		let end = i;
		while (end + 1 < mask.length && !mask[end + 1]) end++;
		out.push(fold(sheet, i, end));
		i = end;
	}
	return out;
}

/** Fewer original lines than this fit the sheet whole: an overview of them would only repeat the gutter. */
const OVERVIEW_MIN_LINES = 60;

/**
 * The original as one `code` element (role `omp.spotlight.code`): marks, folds, and the overview past
 * {@link OVERVIEW_MIN_LINES}. Command output (no file) wraps, a file keeps its lines.
 */
function originalCode(sheet: SheetText): NativeNode {
	const { original } = sheet;
	const marks = compact(sheet.lines.map((_, i) => lineMark(original, i)));
	const shut = folds(sheet);
	return code(sheet.lines.join("\n"), {
		role: "omp.spotlight.code",
		path: sheet.path,
		start: original.start,
		numbers: true,
		...(sheet.path ? {} : { wrap: true }),
		...(sheet.lines.length >= OVERVIEW_MIN_LINES ? { overview: true } : {}),
		...(marks.length > 0 ? { marks } : {}),
		...(shut.length > 0 ? { folds: shut } : {}),
	});
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

/**
 * The footer's key to the rows' wash (role `omp.spotlight.legend`): the heat ramp (role `omp.spotlight.ramp`, drawn
 * by the terminal) before the rank's parts in their order across a row.
 */
function rankLegend(rank: SpotlightRank): NativeNode {
	const label =
		rank.parts.length > 1 ? `row tint, left to right: ${rank.parts.join(" → ")}` : `row tint: ${rank.parts[0]}`;
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
		const sheet: SheetText = {
			original,
			path: original.path,
			lines: all.slice(0, SPOTLIGHT_VIEW_LINES),
			reduced: sanitizeText(this.#options.reduced).split("\n"),
		};
		const rank = original.rank;
		this.#body = compact([
			summary(original, sheet.lines.length, all.length),
			originalCode(sheet),
			shapingNotes(sheet, spotlight.holdout === true || spotlight.gated === true),
			actionBar([...(rank ? [rankLegend(rank)] : []), null, actionButton("Close", "close", { keys: "escape" })]),
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
