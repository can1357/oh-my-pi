/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The Spotlight sheet: how shaping reduced one tool result.
 *
 * From the top: what Spotlight was asked (the intent; the other request
 * parameters behind a toggle), a legend counting why lines were shown or
 * hidden beside the ranking budget and cutoff, the original as `code` (one
 * per window, each under its path when there are several) with every line
 * tinted by its reason and washed by its score parts, every run of hidden
 * lines folded under the marker the model read in its place (a fold hiding a
 * hot line says why it went, with a hover card), the shaping notes the model
 * saw, and a footer with the rank legend and Close.
 *
 * The terminal shows only the head line and how to close; the sheet is a
 * native glass overlay ({@link spotlightOverlay}).
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	type TspCodeFold,
	type TspCodeMark,
	type TspPropNode,
	type TspSpan,
	type TspTone,
	toolIntentLabel,
} from "@oh-my-pi/pi-wire";
import {
	rankPartAt,
	reasonShows,
	SPOTLIGHT_VIEW_LINES,
	type SpotlightDetails,
	type SpotlightOriginal,
	type SpotlightRank,
	type SpotlightReason,
	type SpotlightRequestParams,
	type SpotlightWindow,
} from "../../../tools/details/spotlight";
import "../../styles/panels/spotlight-sheet";
import { ActionButton } from "./common";
import { rowsRole } from "../sheet";

export interface SpotlightSheetProps {
	readonly spotlight: SpotlightDetails & { original: SpotlightOriginal };
	/** The original text, as its artifact holds it. */
	readonly original: string;
	/** The text the model saw (of a held-out result: the text it would have seen). */
	readonly reduced: string;
	onClose(): void;
}

// ─── Trace reading ──────────────────────────────────────────────────────────

/** The reason of 0-based original line `i`, if the trace has one. */
function reasonOf(why: string | undefined, i: number): SpotlightReason | undefined {
	const c = why?.[i];
	return c !== undefined && "asncbrf-".includes(c) ? (c as SpotlightReason) : undefined;
}

/** Heat of 0-based original line `i` in [0, 1] (a digit 0–9), or undefined when unscored. */
function heatOf(heat: string, i: number): number | undefined {
	const code = heat.charCodeAt(i);
	return code >= 48 && code <= 57 ? (code - 48) / 9 : undefined;
}

/** A hidden line counts as hot at the top heat digit. */
function isHot(heat: string, i: number): boolean {
	return heat[i] === "9";
}

const SHOWN_TONE: Readonly<Record<string, TspTone>> = { a: "accent", s: "neutral", n: "user", c: "info" };

/** Tone of a line: why it was shown, `error` when hidden though hot, else none. */
function toneOf(original: SpotlightOriginal, i: number): TspTone | undefined {
	const reason = reasonOf(original.why, i);
	if (reason === undefined || reason === "-") return undefined;
	if (reasonShows(reason)) return SHOWN_TONE[reason];
	return isHot(original.heat, i) ? "error" : undefined;
}

/** The windows of an original (a single implicit window when it lists none). */
function windowsOf(original: SpotlightOriginal): SpotlightWindow[] {
	if (Array.isArray(original.windows) && original.windows.length > 0) return original.windows;
	return [
		{
			at: 0,
			lines: original.lines,
			start: original.start,
			...(original.path !== undefined ? { path: original.path } : {}),
			...(original.rank ? { rank: original.rank } : {}),
		},
	];
}

/** Tokens saved against the plain result (negative: it cost more). */
function savingOf(spotlight: SpotlightDetails): number {
	return spotlight.plainTokens === undefined ? spotlight.savedTokens : spotlight.plainTokens - spotlight.outTokens;
}

const thousands = (n: number) => n.toLocaleString("en-US");
const two = (n: number) => n.toFixed(2);
const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

/** Score parts of window line `i` (relative to the window), in the rank's order. */
function partsOf(rank: SpotlightRank, i: number): number[] {
	return rank.values.map(values => rankPartAt(values, i, rank.max));
}

const lineNumber = (window: SpotlightWindow, i: number) => window.start + i - window.at;

// ─── Head ───────────────────────────────────────────────────────────────────

/** The sheet's overlay facts: role, head line, size, anchor. */
export function spotlightOverlay(spotlight: SpotlightDetails): {
	role: string;
	head: string;
	size: "lg";
	anchor: "center";
} {
	const saving = savingOf(spotlight);
	const unseen = spotlight.holdout === true || spotlight.gated === true;
	const saved = unseen
		? `would save ${formatNumber(Math.max(0, saving))} toks`
		: saving >= 0
			? `saved ${formatNumber(saving)} toks`
			: `+${formatNumber(-saving)} toks`;
	const kept = spotlight.holdout
		? "held out (the model saw the original) · "
		: spotlight.gated
			? "kept whole for editing (the model saw the original) · "
			: "";
	return {
		role: "omp.overlay.spotlight",
		head: `⭐ Spotlight · ${kept}${spotlight.tool} · ${formatNumber(spotlight.inChars)} → ${formatNumber(spotlight.outChars)} chars · ${saved}`,
		size: "lg",
		anchor: "center",
	};
}

// ─── Request parameters ─────────────────────────────────────────────────────

interface Param {
	readonly name: string;
	readonly values: readonly string[];
	readonly style?: string;
}

function paramsOf(request: SpotlightRequestParams): Param[] {
	const all: Param[] = [
		{ name: "intent", values: [request.intent] },
		{ name: "said", values: [request.said] },
		{ name: "task", values: [request.task] },
		{ name: "commands", values: request.commands, style: "mono" },
		{ name: "source", values: [request.source], style: "mono" },
		{ name: "probe", values: [request.probe], style: "mono" },
		{ name: "model", values: [request.model, `${request.thinking} thinking`] },
	];
	return all.filter(param => param.values.some(value => sanitizeText(value).trim() !== ""));
}

function ParamRow(props: { readonly param: Param; readonly expanded: boolean; readonly toggle?: JSXNode }): JSXNode {
	const { param, expanded } = props;
	const values = param.values.map(value => sanitizeText(value).trim()).filter(Boolean);
	const spans: TspSpan[] = [];
	values.forEach((value, i) => {
		const shown = param.name === "intent" && !expanded ? toolIntentLabel(value) : value;
		if (i > 0) spans.push(param.style ? { s: `dim ${param.style}`, t: " · " } : { s: "dim", t: " · " });
		const t = shown.replace(/\s+/g, " ");
		spans.push(param.style ? { s: param.style, t } : { t });
	});
	return (
		<row role="omp.spotlight.param" gap="md" align="baseline">
			<text text={param.name} />
			<text lines={expanded ? 2 : 1} truncate="end" title={values.join("\n")} spans={spans} />
			{props.toggle}
		</row>
	);
}

function RequestParams(props: { readonly request: SpotlightRequestParams; readonly expanded: boolean }): JSXNode {
	const params = paramsOf(props.request);
	if (params.length === 0) return null;
	const rest = params.slice(1);
	const toggle =
		rest.length > 0 ? (
			<text
				role="omp.spotlight.more"
				actions={{ click: "params" }}
				text={props.expanded ? "fewer ▾" : `${rest.map(p => p.name).join(", ")} ▸`}
			/>
		) : undefined;
	return (
		<col role="omp.spotlight.params" gap="xs">
			{(props.expanded ? params : params.slice(0, 1)).map((param, i) => (
				<ParamRow param={param} expanded={props.expanded} toggle={i === 0 ? toggle : undefined} />
			))}
		</col>
	);
}

// ─── Summary ────────────────────────────────────────────────────────────────

type LineClass = "a" | "s" | "n" | "c" | "hot" | "cut";

const LEGEND: readonly { readonly cls: LineClass; readonly tone: TspTone; readonly label: string }[] = [
	{ cls: "a", tone: "accent", label: "kept by score" },
	{ cls: "s", tone: "neutral", label: "kept as structure" },
	{ cls: "n", tone: "user", label: "named" },
	{ cls: "c", tone: "info", label: "kept as context" },
	{ cls: "hot", tone: "error", label: "cut though hot" },
	{ cls: "cut", tone: "muted", label: "cut" },
];

function classOf(original: SpotlightOriginal, i: number): LineClass | undefined {
	const reason = reasonOf(original.why, i);
	if (reason === undefined || reason === "-") return undefined;
	if (reasonShows(reason)) return reason as LineClass;
	return isHot(original.heat, i) ? "hot" : "cut";
}

function LegendKey(props: { readonly swatch: JSXNode; readonly label: string }): JSXNode {
	return (
		<row role="omp.spotlight.key" gap="xs" align="center">
			{props.swatch}
			<text spans={[{ s: "muted", t: props.label }]} />
		</row>
	);
}

function rankFacts(rank: SpotlightRank): string {
	return rank.budget !== undefined
		? `budget ${thousands(rank.used ?? 0)} of ${thousands(rank.budget)} chars · cutoff ${two(rank.cutoff)}`
		: `cutoff ${two(rank.cutoff)}`;
}

function Summary(props: {
	readonly original: SpotlightOriginal;
	readonly rank: SpotlightRank | undefined;
	readonly shown: number;
	readonly total: number;
}): JSXNode {
	const { original } = props;
	const keys: JSXNode[] = [];
	if (original.why !== undefined) {
		const counts: Partial<Record<LineClass, number>> = {};
		for (let i = 0; i < props.shown; i++) {
			const cls = classOf(original, i);
			if (cls) counts[cls] = (counts[cls] ?? 0) + 1;
		}
		for (const { cls, tone, label } of LEGEND) {
			const n = counts[cls];
			if (n) {
				keys.push(
					<LegendKey
						swatch={<text role="omp.spotlight.swatch" tone={tone} text="■" />}
						label={`${label} ${thousands(n)}`}
					/>,
				);
			}
		}
	}
	const facts: string[] = [];
	if (props.rank) facts.push(rankFacts(props.rank));
	if (props.shown < props.total) facts.push(`first ${thousands(props.shown)} of ${thousands(props.total)} lines`);
	if (keys.length === 0 && facts.length === 0) return null;
	return (
		<row role="omp.spotlight.summary" gap="md" align="center" wrap>
			{keys}
			<spacer grow={1} />
			{facts.length > 0 && <text role="omp.spotlight.budget" spans={[{ s: "muted", t: facts.join(" · ") }]} />}
		</row>
	);
}

// ─── Code ───────────────────────────────────────────────────────────────────

/** What the code views read: the original's lines (view-capped), which reached the model, and the reduced lines. */
interface Sheet {
	readonly original: SpotlightOriginal;
	readonly lines: readonly string[];
	readonly shown: readonly boolean[];
	readonly reduced: readonly string[];
}

/** Which of the first `count` original lines reached the model: their reason, else whether `kept` covers them. */
function shownLines(original: SpotlightOriginal, count: number): boolean[] {
	const shown = Array.from({ length: count }, () => false);
	for (const [from, to] of original.kept)
		for (let i = Math.max(1, from); i <= Math.min(count, to); i++) shown[i - 1] = true;
	for (let i = 0; i < count; i++) {
		const reason = reasonOf(original.why, i);
		if (reason !== undefined && reason !== "-") shown[i] = reasonShows(reason);
	}
	return shown;
}

function markOf(original: SpotlightOriginal, window: SpotlightWindow, i: number): TspCodeMark | undefined {
	const heat = heatOf(original.heat, i);
	const tone = toneOf(original, i);
	if (heat === undefined && tone === undefined) return undefined;
	return {
		line: lineNumber(window, i),
		...(heat !== undefined ? { heat } : {}),
		...(tone !== undefined ? { tone } : {}),
		...(window.rank ? { wash: partsOf(window.rank, i - window.at) } : {}),
	};
}

/** The reduced line standing for original lines `from..to` (0-based): the single marker mapping exactly over them. */
function markerOf(sheet: Sheet, from: number, to: number): string | undefined {
	const map = sheet.original.map;
	if (!map) return undefined;
	let marker = -1;
	for (let j = 0; j < map.length; j++) {
		const entry = map[j];
		if (!Array.isArray(entry) || entry[0] > from + 1 || entry[1] < to + 1) continue;
		if (marker >= 0) return undefined;
		marker = j;
	}
	return (marker >= 0 ? sheet.reduced[marker]?.trimEnd() : undefined) || undefined;
}

const CUT_WHY: Partial<Record<SpotlightReason, string>> = {
	b: "cut by the budget",
	r: "seen in an earlier call",
	f: "folded",
};

function cutReason(original: SpotlightOriginal, window: SpotlightWindow, i: number): string | undefined {
	const reason = reasonOf(original.why, i);
	const last = window.rank?.last;
	if (reason === "b" && window.rank && last) {
		const score = sum(partsOf(window.rank, last.line - 1));
		return `cut by the budget: line ${window.start + last.line - 1} (${two(score)}) took the last ${thousands(last.chars)} chars`;
	}
	return reason === undefined ? undefined : CUT_WHY[reason];
}

/** The hover card of a fold hiding hot line `i`: the line, its score, why it went. */
function hotCard(sheet: Sheet, window: SpotlightWindow, i: number): TspPropNode {
	const { original } = sheet;
	const line = lineNumber(window, i);
	const why = cutReason(original, window, i);
	const mark = markOf(original, window, i);
	const codeProps: Record<string, unknown> = { text: sheet.lines[i] ?? "", start: line, numbers: true };
	if (window.path !== undefined) codeProps.path = window.path;
	if (mark) codeProps.marks = [mark];
	const children: TspPropNode[] = [
		{ k: "text", p: { spans: [{ s: "muted", t: `line ${line} · the hottest line this fold hides` }] } },
		{ k: "code", p: codeProps },
	];
	if (window.rank) {
		const parts = partsOf(window.rank, i - window.at);
		const t = `${parts.map(two).join(" + ")} = ${two(sum(parts))} · cutoff ${two(window.rank.cutoff)}`;
		children.push({ k: "text", p: { spans: [{ s: "muted", t }] } });
	}
	if (why !== undefined) children.push({ k: "text", p: { spans: [{ s: "error", t: why }] } });
	return { k: "col", p: { gap: "xs", role: "omp.spotlight.card" }, c: children } as TspPropNode;
}

function foldOf(sheet: Sheet, window: SpotlightWindow, from: number, to: number): TspCodeFold {
	const { original } = sheet;
	let peak: number | undefined;
	let hot = -1;
	let hotHeat = -1;
	for (let i = from; i <= to; i++) {
		const heat = heatOf(original.heat, i);
		if (heat === undefined) continue;
		if (peak === undefined || heat > peak) peak = heat;
		if (heat > hotHeat && toneOf(original, i) === "error") {
			hot = i;
			hotHeat = heat;
		}
	}
	const n = to - from + 1;
	const note: TspSpan[] = [
		{
			s: "muted",
			t: `${thousands(n)} ${n === 1 ? "line" : "lines"}${peak === undefined ? "" : ` · peak ${two(peak)}`}`,
		},
	];
	const label = markerOf(sheet, from, to);
	const fold: TspCodeFold = {
		from: lineNumber(window, from),
		to: lineNumber(window, to),
		...(label ? { label } : {}),
	};
	if (hot < 0) return { ...fold, note };
	const why = CUT_WHY[reasonOf(original.why, hot) ?? "-"];
	note.push({ s: "error", t: ` · line ${lineNumber(window, hot)}${why ? ` ${why}` : ""}` });
	return { ...fold, note, tone: "error", hovercard: hotCard(sheet, window, hot) };
}

/** A window's lines as the sheet shows them: 0-based `from` to `end` (exclusive) of its `lines`. */
interface Section {
	readonly window: SpotlightWindow;
	readonly from: number;
	readonly end: number;
	readonly lines: number;
}

function sectionsOf(original: SpotlightOriginal, shown: number, total: number): Section[] {
	const windows = windowsOf(original);
	return windows.map((window, w) => {
		const from = Math.max(0, window.at);
		const full = w === windows.length - 1 ? Math.max(total, from) : window.at + window.lines;
		return { window, from, end: Math.max(from, Math.min(full, shown)), lines: full - from };
	});
}

/** Originals with at least this many lines get an overview strip. */
const OVERVIEW_MIN_LINES = 60;

function WindowCode(props: { readonly sheet: Sheet; readonly section: Section }): JSXNode {
	const { sheet, section } = props;
	const { window, from, end } = section;
	const lines = sheet.lines.slice(from, end);
	const marks: TspCodeMark[] = [];
	for (let i = from; i < end; i++) {
		const mark = markOf(sheet.original, window, i);
		if (mark) marks.push(mark);
	}
	const folds: TspCodeFold[] = [];
	for (let i = from; i < end; i++) {
		if (sheet.shown[i]) continue;
		let last = i;
		while (last + 1 < end && !sheet.shown[last + 1]) last++;
		folds.push(foldOf(sheet, window, i, last));
		i = last;
	}
	return (
		<code
			role="omp.spotlight.code"
			text={lines.join("\n")}
			path={window.path}
			start={window.start}
			numbers
			wrap={window.path ? undefined : true}
			overview={lines.length >= OVERVIEW_MIN_LINES ? true : undefined}
			marks={marks.length > 0 ? marks : undefined}
			folds={folds.length > 0 ? folds : undefined}
		/>
	);
}

function WindowSection(props: { readonly sheet: Sheet; readonly section: Section }): JSXNode {
	const { section } = props;
	const { path, rank } = section.window;
	const shown = section.end - section.from;
	const clip =
		shown === 0
			? `not shown: past the first ${thousands(SPOTLIGHT_VIEW_LINES)} lines`
			: shown < section.lines
				? `${thousands(shown)} of ${thousands(section.lines)} lines shown`
				: undefined;
	const hasHead = path !== undefined || clip !== undefined || rank !== undefined;
	return (
		<col role="omp.spotlight.window" gap="xs">
			{hasHead && (
				<row role="omp.spotlight.head" gap="md" align="baseline">
					{path !== undefined && <text spans={[{ s: "mono", t: path }]} />}
					{clip !== undefined && <text role="omp.spotlight.clip" spans={[{ s: "muted", t: clip }]} />}
					<spacer grow={1} />
					{rank && <text role="omp.spotlight.budget" spans={[{ s: "muted", t: rankFacts(rank) }]} />}
				</row>
			)}
			{shown > 0 && <WindowCode sheet={props.sheet} section={section} />}
		</col>
	);
}

function ShapingNotes(props: { readonly sheet: Sheet; readonly heldOut: boolean }): JSXNode {
	const map = props.sheet.original.map;
	if (!map) return null;
	const notes: string[] = [];
	map.forEach((entry, j) => {
		const line = entry === null ? props.sheet.reduced[j]?.trimEnd() : undefined;
		if (line) notes.push(line);
	});
	if (notes.length === 0) return null;
	return (
		<col role="omp.spotlight.notes" gap="xs">
			<text spans={[{ s: "muted", t: props.heldOut ? "notes the model would have seen" : "notes the model saw" }]} />
			{notes.map(note => (
				<text spans={[{ s: "muted mono", t: note }]} />
			))}
		</col>
	);
}

function rankLabel(rank: SpotlightRank): string {
	return rank.parts.length > 1 ? `row tint, left to right: ${rank.parts.join(" → ")}` : `row tint: ${rank.parts[0]}`;
}

// ─── Sheet ──────────────────────────────────────────────────────────────────

export function SpotlightSheet(props: SpotlightSheetProps): JSXNode {
	const { spotlight } = props;
	const original = spotlight.original;
	const expanded = signal(false);
	const all = sanitizeText(props.original).split("\n");
	const lines = all.slice(0, SPOTLIGHT_VIEW_LINES);
	const sheet: Sheet = {
		original,
		lines,
		shown: shownLines(original, lines.length),
		reduced: sanitizeText(props.reduced).split("\n"),
	};
	const windows = windowsOf(original);
	const single = windows.length === 1;
	const legends = [...new Set(windows.flatMap(window => (window.rank ? [rankLabel(window.rank)] : [])))];
	return (
		<col
			role={rowsRole("omp.spotlight")}
			gap="md"
			term={{ head: spotlightOverlay(spotlight).head }}
			onKey={key => {
				if (key.id !== "escape") return false;
				props.onClose();
				return true;
			}}
			onAction={act => {
				if (act === "close") props.onClose();
				else if (act === "params") expanded.set(!expanded());
			}}
		>
			{() => spotlight.request && <RequestParams request={spotlight.request} expanded={expanded()} />}
			<Summary
				original={original}
				rank={single ? windows[0]!.rank : undefined}
				shown={lines.length}
				total={all.length}
			/>
			{sectionsOf(original, lines.length, all.length).map(section =>
				single ? (
					section.end > section.from && <WindowCode sheet={sheet} section={section} />
				) : (
					<WindowSection sheet={sheet} section={section} />
				),
			)}
			<ShapingNotes sheet={sheet} heldOut={spotlight.holdout === true || spotlight.gated === true} />
			<row key="actions" role="omp.actions" align="center" gap="sm">
				{legends.map(label => (
					<row role="omp.spotlight.legend" align="center">
						<LegendKey swatch={<text role="omp.spotlight.ramp" text="" />} label={label} />
					</row>
				))}
				<spacer grow={1} />
				<ActionButton id="close" label="Close" title="Close  esc" keys={["escape"]} />
			</row>
		</col>
	);
}
