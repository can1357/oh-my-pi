/**
 * Diffs as styled terminal rows.
 *
 * omp's compact diff text numbers every line: `+12|added`, `-12|removed`,
 * ` 12|context` (legacy `+12 added` too), with blank or `…` rows between
 * regions and any other row (a `@@` header) drawn as a dim note. Rows get a
 * `-12│` gutter (a number repeated from the row above is blanked), removed
 * rows the removed color, added rows the added color, context the muted diff
 * color with syntax highlighting when the file's language is known. A single
 * removed line replaced by a single added line marks the changed words in
 * inverse. Indentation of changed rows shows as dim `·` (spaces) and `→`
 * (tabs); tabs elsewhere expand to spaces.
 *
 * The TSP `diff` kind carries hunks instead: `parseCompactDiff` and
 * `parseUnifiedDiff` produce them and `renderDiffHunks` draws them.
 */
import { diffWords } from "@oh-my-pi/pi-natives";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspDiffHunk } from "@oh-my-pi/pi-wire";
import type { Theme } from "../theme/contract";
import { highlightCode } from "./highlight";
import { languageFromPath } from "./lang";
import { replaceTabs, spaces, TAB_WIDTH, visibleWidth, wrap } from "./width";

type Marker = "+" | "-" | " ";

interface DiffRow {
	readonly marker: Marker;
	/** The line number as written (trimmed); "" when the row has none. */
	readonly number: string;
	readonly content: string;
}

const CANONICAL = /^([+\- ])(\s*\d+)\|(.*)$/s;
const LEGACY = /^([+\- ])(?:(\s*\d+)\s)?(.*)$/s;

function parseRow(line: string): DiffRow | undefined {
	const match = CANONICAL.exec(line) ?? LEGACY.exec(line);
	if (match === null) return undefined;
	return { marker: match[1] as Marker, number: (match[2] ?? "").trim(), content: match[3] ?? "" };
}

function isGap(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === "" || trimmed === "..." || trimmed === "…";
}

function isCollapseMarker(row: DiffRow): boolean {
	return row.marker === " " && (row.content === "..." || row.content === "…");
}

const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";
const LEADING_INDENT = /^[ \t]+/;
const TAB_MARKER = `${DIM}${spaces(Math.floor(TAB_WIDTH / 2))}→${spaces(Math.max(0, TAB_WIDTH - Math.floor(TAB_WIDTH / 2) - 1))}${DIM_OFF}`;

/** Leading indentation drawn as dim `·` / `→`; tabs after it expand to spaces. */
function showIndent(text: string): string {
	const indent = LEADING_INDENT.exec(text)?.[0];
	if (indent === undefined) return replaceTabs(text);
	let shown = "";
	for (const char of indent) shown += char === "\t" ? TAB_MARKER : `${DIM}·${DIM_OFF}`;
	return `${shown}${replaceTabs(text.slice(indent.length))}`;
}

/** Changed words of a one-for-one replacement in inverse (leading whitespace of a change stays plain). */
function markChangedWords(removed: string, added: string, theme: Theme): { removed: string; added: string } {
	let before = "";
	let after = "";
	let firstRemoved = true;
	let firstAdded = true;
	for (const part of diffWords(removed, added)) {
		if (!part.added && !part.removed) {
			before += part.value;
			after += part.value;
			continue;
		}
		let value = part.value;
		let lead = "";
		if (part.removed ? firstRemoved : firstAdded) {
			lead = /^\s*/.exec(value)![0];
			value = value.slice(lead.length);
		}
		const marked = value === "" ? lead : `${lead}${theme.style("inverse", value)}`;
		if (part.removed) {
			before += marked;
			firstRemoved = false;
		} else {
			after += marked;
			firstAdded = false;
		}
	}
	return { removed: before, added: after };
}

/** Options for drawing a diff. */
export interface DiffRenderOptions {
	readonly theme: Theme;
	/** The changed file: its language highlights context rows. */
	readonly path?: string;
	/** A language overriding the one `path` gives. */
	readonly lang?: string;
}

/** Context rows highlighted run by run (a run never spans a gap or a collapse marker). */
function highlightContext(
	rows: readonly (DiffRow | undefined)[],
	lang: string | undefined,
	theme: Theme,
): Map<number, string> {
	const out = new Map<number, string>();
	if (lang === undefined) return out;
	let run: number[] = [];
	const flush = (): void => {
		if (run.length === 0) return;
		const lines = highlightCode(run.map(index => rows[index]!.content).join("\n"), lang, theme);
		run.forEach((index, i) => out.set(index, lines[i] ?? rows[index]!.content));
		run = [];
	};
	rows.forEach((row, index) => {
		if (row !== undefined && row.marker === " " && !isCollapseMarker(row)) run.push(index);
		else flush();
	});
	flush();
	return out;
}

/** omp compact diff text as styled rows, one per diff line (unwrapped; see `wrapDiffRow`). */
export function renderDiff(text: string, options: DiffRenderOptions): string[] {
	const { theme } = options;
	const lines = sanitizeText(text).split("\n");
	const rows = lines.map(parseRow);
	// At least 3 digits, so a streaming diff keeps its gutter as it passes line 100.
	let numberWidth = 3;
	for (const row of rows) if (row !== undefined) numberWidth = Math.max(numberWidth, row.number.length);
	const lang = options.lang ?? (options.path === undefined ? undefined : languageFromPath(options.path));
	const highlighted = highlightContext(rows, lang, theme);

	let previous = "";
	const gutter = (marker: Marker, number: string, content: string): string => {
		if (number === "") {
			previous = "";
			return `${marker}${content}`;
		}
		const shown = number === previous ? "" : number;
		previous = number;
		const label = marker.trim() !== "" && shown !== "" ? `${marker}${shown}` : shown || marker.trim();
		return `${label.padStart(numberWidth + 1)}│${content}`;
	};

	const out: string[] = [];
	for (let i = 0; i < lines.length;) {
		const row = rows[i];
		if (row === undefined) {
			previous = "";
			out.push(theme.fg("toolDiffContext", isGap(lines[i]!) ? "…" : replaceTabs(lines[i]!)));
			i++;
			continue;
		}
		if (row.marker === " ") {
			const content = highlighted.get(i);
			out.push(
				theme.fg(
					"toolDiffContext",
					gutter(" ", row.number, content === undefined ? showIndent(row.content) : replaceTabs(content)),
				),
			);
			i++;
			continue;
		}
		const removed: DiffRow[] = [];
		while (i < lines.length && rows[i]?.marker === "-") removed.push(rows[i++]!);
		const added: DiffRow[] = [];
		while (i < lines.length && rows[i]?.marker === "+") added.push(rows[i++]!);
		if (removed.length === 1 && added.length === 1) {
			const marked = markChangedWords(replaceTabs(removed[0]!.content), replaceTabs(added[0]!.content), theme);
			out.push(theme.fg("toolDiffRemoved", gutter("-", removed[0]!.number, showIndent(marked.removed))));
			out.push(theme.fg("toolDiffAdded", gutter("+", added[0]!.number, showIndent(marked.added))));
			continue;
		}
		for (const line of removed)
			out.push(theme.fg("toolDiffRemoved", gutter("-", line.number, showIndent(line.content))));
		for (const line of added) out.push(theme.fg("toolDiffAdded", gutter("+", line.number, showIndent(line.content))));
	}
	return out;
}

const LEADING_SGR = /^(?:\x1b\[[0-9;:]*m)*/;
const DIFF_GUTTER = /^(\s*[+-]?\s*\d*)([|│])(.*)$/s;

/**
 * One rendered diff row wrapped to `width`: content wraps beside the gutter,
 * continuation rows show a blank gutter with its rule, every row re-opens the
 * row's color and closes it at its end (`wrap` closes inverse at each break).
 * Rows without a gutter wrap plainly.
 */
export function wrapDiffRow(row: string, width: number): string[] {
	if (width <= 0) return [row];
	if (row === "") return [""];
	const open = LEADING_SGR.exec(row)![0];
	const rest = row.slice(open.length);
	const body = rest.endsWith("\x1b[39m") ? rest.slice(0, -5) : rest;
	const match = DIFF_GUTTER.exec(body);
	if (match === null || match[1] === "" || (match[2] === "|" && !/^[+\-\s]\s*\d+$/.test(match[1]!))) {
		return wrap(row, width);
	}
	const prefix = `${match[1]}${match[2]}`;
	const prefixWidth = visibleWidth(prefix);
	const continuation = `${spaces(prefixWidth - 1)}${match[2]}`;
	return wrap(match[3]!, Math.max(1, width - prefixWidth)).map(
		(segment, index) => `${open}${index === 0 ? prefix : continuation}${segment}\x1b[39m`,
	);
}

// ─── Hunks ──────────────────────────────────────────────────────────────────

/**
 * Hunks of omp compact diff text. A blank or `…` row, or a jump in line
 * numbers, starts a new hunk. Removed rows carry old numbers, added rows new
 * ones, context rows old ones; the other side follows from the running
 * offset. Runs without a change (far anchor lines) are dropped.
 */
export function parseCompactDiff(text: string): TspDiffHunk[] {
	const hunks: TspDiffHunk[] = [];
	let lines: string[] = [];
	let changed = false;
	let oldStart = 1;
	let newStart = 1;
	let nextOld = 1;
	let nextNew = 1;
	const close = (): void => {
		if (changed) hunks.push({ oldStart, newStart, lines });
		lines = [];
		changed = false;
	};
	for (const line of sanitizeText(text).split("\n")) {
		const row = parseRow(line);
		if (row === undefined || isCollapseMarker(row)) {
			if (isGap(line)) close();
			continue;
		}
		const number = Number.parseInt(row.number, 10);
		const expected = row.marker === "+" ? nextNew : nextOld;
		if (Number.isFinite(number) && number !== expected) {
			close();
			nextOld += number - expected;
			nextNew += number - expected;
		}
		if (lines.length === 0) {
			oldStart = nextOld;
			newStart = nextNew;
		}
		if (row.marker !== "+") nextOld++;
		if (row.marker !== "-") nextNew++;
		changed ||= row.marker !== " ";
		lines.push(`${row.marker}${row.content}`);
	}
	close();
	return hunks;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Hunks of a standard unified diff (file headers and `\ No newline` notes are skipped). */
export function parseUnifiedDiff(text: string): TspDiffHunk[] {
	const hunks: TspDiffHunk[] = [];
	let current: { oldStart: number; newStart: number; lines: string[] } | undefined;
	for (const line of text.split("\n")) {
		const header = HUNK_HEADER.exec(line);
		if (header !== null) {
			current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
			hunks.push(current);
			continue;
		}
		if (current === undefined || line.startsWith("\\")) continue;
		const marker = line[0];
		if (marker === "+" || marker === "-" || marker === " ") current.lines.push(line);
		else if (line === "") current.lines.push(" ");
		else current = undefined;
	}
	return hunks;
}

/** Hunks as omp compact diff text (removed rows numbered old, added and context rows by their side), `…` between hunks. */
export function compactDiffText(hunks: readonly TspDiffHunk[]): string {
	const out: string[] = [];
	for (const hunk of hunks) {
		if (out.length > 0) out.push("…");
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const line of hunk.lines) {
			const marker = line[0] === "+" || line[0] === "-" ? line[0] : " ";
			const content = line.slice(1);
			if (marker === "+") out.push(`+${newLine++}|${content}`);
			else if (marker === "-") out.push(`-${oldLine++}|${content}`);
			else {
				out.push(` ${oldLine++}|${content}`);
				newLine++;
			}
		}
	}
	return out.join("\n");
}

/** Hunks (the TSP `diff` kind) as styled rows wrapped to `width`, a dim `…` row between hunks. */
export function renderDiffHunks(hunks: readonly TspDiffHunk[], width: number, options: DiffRenderOptions): string[] {
	return renderDiff(compactDiffText(hunks), options).flatMap(row => wrapDiffRow(row, width));
}
