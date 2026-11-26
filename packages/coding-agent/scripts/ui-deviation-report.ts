#!/usr/bin/env bun
/**
 * Side-by-side report of every listed corpus deviation (test/ui/deviations.ts).
 *
 * Runs the corpus suites (`bun test test/ui`) with `PI_UI_DEVIATION_DUMP`
 * set: each suite records the stages a listed deviation covers as it painted
 * and described them, through the same code path the tests compare. The
 * report then shows each entry once, by screen: its reason, how many stages
 * it covers, and one example — the first deviating stage's captured rows
 * (old) beside the new rows, differing cells outlined, or a compact
 * native-tree diff for native deviations.
 *
 *   bun scripts/ui-deviation-report.ts [--out /tmp/pi-ui-deviations.html] [--dump <dir>] [test paths…]
 *
 * `--dump <dir>` reuses the captures of an earlier run instead of running the suites.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Cell, cellGrid } from "@oh-my-pi/pi-tui/testing/cells";
import { CORPUS_DIR, type CorpusCase, type CorpusStage, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import { paletteHex } from "@oh-my-pi/pi-tui/theme/color";
import {
	caseStem,
	DEVIATIONS,
	type Deviation,
	type DeviationCategory,
	deviationsAt,
	type StageCapture,
} from "../test/ui/deviations";

const PACKAGE_DIR = path.join(import.meta.dir, "..");
const MAX_NATIVE_LINES = 60;

// ── arguments ──────────────────────────────────────────────────────────────

let out = "/tmp/pi-ui-deviations.html";
let dump: string | undefined;
const testPaths: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]!;
	if (arg === "--out") out = argv[++i]!;
	else if (arg === "--dump") dump = argv[++i]!;
	else if (arg === "--help" || arg === "-h") {
		console.log("bun scripts/ui-deviation-report.ts [--out file.html] [--dump captures-dir] [test paths…]");
		process.exit(0);
	} else testPaths.push(arg);
}

// ── capture ────────────────────────────────────────────────────────────────

if (!fs.existsSync(CORPUS_DIR)) {
	console.error(`no corpus at ${CORPUS_DIR}: the report compares against the local capture`);
	process.exit(1);
}

if (!dump) {
	dump = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-deviations-"));
	console.log(`running the corpus suites (captures in ${dump}) …`);
	const proc = Bun.spawn(["bun", "test", ...(testPaths.length > 0 ? testPaths : ["test/ui"])], {
		cwd: PACKAGE_DIR,
		env: { ...Bun.env, PI_UI_DEVIATION_DUMP: dump },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const summary = `${stdout}\n${stderr}`
		.split("\n")
		.filter(line => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(line))
		.map(line => line.trim());
	console.log(`suites: ${summary.join(", ")}`);
}

const captures = new Map<string, StageCapture>();
for (const name of fs.readdirSync(dump)) {
	if (!name.endsWith(".jsonl")) continue;
	for (const line of fs.readFileSync(path.join(dump, name), "utf8").split("\n")) {
		if (!line) continue;
		const capture = JSON.parse(line) as StageCapture;
		const file = capture.file.endsWith(".json") ? capture.file : `${capture.file}.dark.json`;
		// A stage may arrive once per size (app cases): merge its rows.
		const key = `${capture.screen}/${file}#${capture.index}`;
		const earlier = captures.get(key);
		captures.set(key, { ...earlier, ...capture, file, rows: { ...earlier?.rows, ...capture.rows } });
	}
}

/** A recorded stage; app stages also keep scrollback by size (`80x24`), `"same"` meaning the previous stage's. */
interface RecordedStage extends CorpusStage {
	readonly scrollback?: Readonly<Record<string, readonly string[] | "same">>;
}

/** A recorded case as the corpus stores it (screen cases and app cases). */
interface RecordedCase extends CorpusCase {
	readonly stages: readonly RecordedStage[];
}

/** A recorded stage's rows at `width`; app stages put their scrollback above the screen. */
function recordedRows(recorded: RecordedCase, index: number, width: string): readonly string[] {
	const stage = recorded.stages[index]!;
	const rows = stage.rows[width] ?? [];
	if (!stage.scrollback) return rows;
	let history: readonly string[] | "same" | undefined = stage.scrollback[width];
	for (let back = index - 1; history === "same" && back >= 0; back--)
		history = recorded.stages[back]!.scrollback?.[width];
	return history === undefined || history === "same" ? rows : [...history, ...rows];
}

const corpusCache = new Map<string, RecordedCase>();
function corpusCase(screen: string, file: string): RecordedCase {
	const at = path.join(CORPUS_DIR, screen, file);
	let found = corpusCache.get(at);
	if (!found) {
		found = JSON.parse(fs.readFileSync(at, "utf8")) as RecordedCase;
		corpusCache.set(at, found);
	}
	return found;
}

// ── cells ──────────────────────────────────────────────────────────────────

/** Whether a cell shows no ink (only its background and link are visible), as the parity check reads it. */
function inkless(cell: Cell): boolean {
	return cell.ch === " " && cell.underline === 0 && !cell.strike && !cell.overline && !cell.inverse;
}

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
	if (!a || !b) return a === b;
	if (inkless(a) && inkless(b)) return a.bg === b.bg && a.link === b.link;
	return (
		a.ch === b.ch &&
		a.fg === b.fg &&
		a.bg === b.bg &&
		a.bold === b.bold &&
		a.faint === b.faint &&
		a.italic === b.italic &&
		a.underline === b.underline &&
		a.blink === b.blink &&
		a.inverse === b.inverse &&
		a.hidden === b.hidden &&
		a.strike === b.strike &&
		a.overline === b.overline &&
		a.link === b.link
	);
}

interface GridDiff {
	readonly old: Cell[][];
	readonly new: Cell[][];
	/** Differing cells per row, by column (both grids). */
	readonly marks: Set<number>[];
	readonly cells: number;
}

/** Cell-by-cell difference of two row lists; `null` when they show the same. */
function gridDiff(oldRows: readonly string[], newRows: readonly string[], onlyRows?: Set<number>): GridDiff | null {
	const a = cellGrid(oldRows);
	const b = cellGrid(newRows);
	const marks: Set<number>[] = [];
	let cells = 0;
	for (let row = 0; row < Math.max(a.length, b.length); row++) {
		const set = new Set<number>();
		marks.push(set);
		if (onlyRows && !onlyRows.has(row)) continue;
		const left = a[row];
		const right = b[row];
		const cols = Math.max(left?.length ?? 0, right?.length ?? 0);
		for (let col = 0; col < Math.max(cols, left && right ? 0 : 1); col++) {
			if (left && right && sameCell(left[col], right[col])) continue;
			if (!left || !right || !(isBlank(left[col]) && isBlank(right[col]))) {
				set.add(col);
				cells++;
			}
		}
	}
	return cells === 0 ? null : { old: a, new: b, marks, cells };
}

/** A missing cell matches a blank one (rows are compared with trailing blanks trimmed). */
function isBlank(cell: Cell | undefined): boolean {
	return !cell || (inkless(cell) && cell.bg === "" && cell.link === "");
}

function colorOf(value: string): string | undefined {
	if (value === "") return undefined;
	if (value.startsWith("#")) return value;
	return paletteHex(Number(value.slice(1)));
}

const escapeHtml = (text: string): string =>
	text.replace(/[&<>"]/g, ch => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"));

/** CSS of every distinct cell style, by class name. */
const styleClasses = new Map<string, string>();

/** The class drawing a cell's style (`""` for the default look). */
function cellClass(cell: Cell): string {
	const css = cellStyle(cell);
	if (!css) return "";
	let name = styleClasses.get(css);
	if (!name) {
		name = `k${styleClasses.size}`;
		styleClasses.set(css, name);
	}
	return name;
}

function cellStyle(cell: Cell): string {
	let fg = colorOf(cell.fg);
	let bg = colorOf(cell.bg);
	if (cell.inverse) [fg, bg] = [bg ?? "var(--bg)", fg ?? "var(--fg)"];
	const css: string[] = [];
	if (fg) css.push(`color:${cell.hidden ? "transparent" : fg}`);
	else if (cell.hidden) css.push("color:transparent");
	if (bg) css.push(`background:${bg}`);
	if (cell.bold) css.push("font-weight:bold");
	if (cell.faint) css.push("opacity:.6");
	if (cell.italic) css.push("font-style:italic");
	const lines: string[] = [];
	if (cell.underline) lines.push("underline");
	if (cell.strike) lines.push("line-through");
	if (cell.overline) lines.push("overline");
	if (lines.length > 0)
		css.push(
			`text-decoration:${lines.join(" ")}${cell.underline === 3 ? " wavy" : cell.underline === 2 ? " double" : ""}`,
		);
	return css.join(";");
}

/** One row as HTML: runs of equally styled cells, differing cells marked, wide glyphs boxed to two columns. */
function rowHtml(cells: readonly Cell[] | undefined, marks: Set<number> | undefined): string {
	if (!cells) return `<div class="r gone">${marks && marks.size > 0 ? "<span class=d>∅</span>" : ""}</div>`;
	let html = "";
	let run = "";
	let runClass = "";
	let runLink = "";
	const flush = (): void => {
		if (!run) return;
		html +=
			runClass || runLink
				? `<span${runClass ? ` class="${runClass}"` : ""}${runLink ? ` title="${escapeHtml(runLink)}"` : ""}>${run}</span>`
				: run;
		run = "";
	};
	for (let col = 0; col < cells.length; col++) {
		const cell = cells[col]!;
		if (cell.ch === "") continue;
		const wide = cells[col + 1]?.ch === "";
		const marked = marks?.has(col) || (wide && marks?.has(col + 1));
		const classes = `${cellClass(cell)}${marked ? " d" : ""}`.trim();
		if (classes !== runClass || cell.link !== runLink) {
			flush();
			runClass = classes;
			runLink = cell.link;
		}
		run += wide ? `<span class="w">${escapeHtml(cell.ch)}</span>` : escapeHtml(cell.ch);
	}
	flush();
	// Differences past the end of this row (the other side is longer).
	if (marks) for (const col of marks) if (col >= cells.length) html += `<span class="d"> </span>`;
	return `<div class="r">${html}</div>`;
}

function gridHtml(grid: Cell[][], marks: readonly Set<number>[], width: number, rows: number): string {
	const body: string[] = [];
	for (let row = 0; row < rows; row++) body.push(rowHtml(grid[row], marks[row]));
	return `<div class="term" style="width:${width}ch">${body.join("")}</div>`;
}

// ── native trees ───────────────────────────────────────────────────────────

const short = (value: unknown): string => {
	const text = JSON.stringify(value) ?? "undefined";
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
};

/** Differences of the new tree from the recorded one, one line each (props the new tree adds are left out). */
/**
 * Differences between two described trees as `−`/`+`/`~` lines. Props a node
 * gained are left out (`additions: false`) unless nothing else differs.
 */
function nativeDiffLines(
	expected: unknown,
	actual: unknown,
	at: string,
	outLines: string[],
	options: { additions: boolean; props?: boolean },
): void {
	if (outLines.length > MAX_NATIVE_LINES) return;
	if (Object.is(expected, actual)) return;
	const object = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	if (Array.isArray(expected) && Array.isArray(actual)) {
		for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
			if (i >= actual.length) outLines.push(`− ${at}[${i}] ${short(expected[i])}`);
			else if (i >= expected.length) outLines.push(`+ ${at}[${i}] ${short(actual[i])}`);
			else nativeDiffLines(expected[i], actual[i], `${at}[${i}]`, outLines, { additions: options.additions });
		}
		return;
	}
	if (object(expected) && object(actual)) {
		for (const key in expected) {
			if (!(key in actual)) outLines.push(`− ${at}.${key} ${short(expected[key])}`);
			else
				nativeDiffLines(expected[key], actual[key], `${at}.${key}`, outLines, {
					additions: options.additions,
					props: key === "p",
				});
		}
		if (options.additions || !options.props)
			for (const key in actual) {
				if (key in expected) continue;
				if (key === "p" && typeof expected.k === "string") continue;
				outLines.push(`+ ${at}.${key} ${short(actual[key])}`);
			}
		return;
	}
	outLines.push(`~ ${at}: ${short(expected)} → ${short(actual)}`);
}

// ── collect ────────────────────────────────────────────────────────────────

interface RowsItem {
	readonly width: number;
	readonly diff: GridDiff;
	readonly deviations: readonly Deviation[];
}

interface StageItem {
	readonly screen: string;
	readonly file: string;
	readonly theme: string;
	readonly index: number;
	readonly label: string;
	readonly rows: RowsItem[];
	native?: { lines: string[]; deviations: readonly Deviation[] };
}

const items: StageItem[] = [];

for (const capture of [...captures.values()].sort(
	(a, b) => `${a.screen}/${a.file}`.localeCompare(`${b.screen}/${b.file}`) || a.index - b.index,
)) {
	const recorded = corpusCase(capture.screen, capture.file);
	const stage = recorded.stages[capture.index];
	if (!stage) continue;
	const ref = { screen: capture.screen, case: capture.file, index: capture.index, label: capture.label };
	const item: StageItem = {
		screen: capture.screen,
		file: capture.file,
		theme: recorded.theme,
		index: capture.index,
		label: capture.label,
		rows: [],
	};
	for (const width in capture.rows) {
		const entries = deviationsAt(ref, "rows", width);
		if (entries.length === 0) continue;
		const oldRows = recordedRows(recorded, capture.index, width);
		// Row masks cover only the recorded rows holding their text.
		let only: Set<number> | undefined;
		if (entries.every(entry => entry.rowsContaining !== undefined)) {
			only = new Set();
			const plain = cellGrid(oldRows).map(cells => cells.map(cell => cell.ch).join(""));
			plain.forEach((text, row) => {
				if (entries.some(entry => text.includes(entry.rowsContaining!))) only!.add(row);
			});
			if (only.size === 0) continue;
		}
		const diff = gridDiff(oldRows, capture.rows[width]!, only);
		if (!diff) continue;
		// App stages key rows by size (`80x24`): the width leads.
		item.rows.push({ width: Number.parseInt(width, 10), diff, deviations: entries });
	}
	const nativeEntries = deviationsAt(ref, "native");
	if (nativeEntries.length > 0 && capture.native !== undefined) {
		const lines: string[] = [];
		const expected = capture.expectedNative ?? stageNative(recorded, capture.index);
		nativeDiffLines(expected, capture.native, "$", lines, { additions: false });
		if (lines.length === 0) nativeDiffLines(expected, capture.native, "$", lines, { additions: true });
		if (lines.length > 0) {
			if (lines.length > MAX_NATIVE_LINES) lines.splice(MAX_NATIVE_LINES, Infinity, "… (more differences)");
			item.native = { lines, deviations: nativeEntries };
		}
	}
	if (item.rows.length > 0 || item.native) items.push(item);
}

// ── render ─────────────────────────────────────────────────────────────────

const CATEGORY_CLASS: Record<DeviationCategory, string> = {
	"capture artifact": "cap",
	"old bug": "bug",
	"design change": "design",
	"natives build": "natives",
};

const badge = (entry: Deviation): string =>
	`<span class="cat ${CATEGORY_CLASS[entry.category]}">${entry.category}</span> <span class="kind">${entry.kind}</span>`;

function entryScope(entry: Deviation): string {
	const parts = [`case <code>${escapeHtml(entry.case)}</code>`];
	parts.push(entry.stages ? `stages <code>${escapeHtml(entry.stages.join(", "))}</code>` : "every stage");
	if (entry.widths) parts.push(`widths <code>${entry.widths.join(", ")}</code>`);
	if (entry.rowsContaining)
		parts.push(`rows containing <code>${escapeHtml(JSON.stringify(entry.rowsContaining))}</code>`);
	if (entry.normalize) parts.push("recorded tree normalized before comparing");
	return parts.join(" · ");
}

/** One deviation's example: the first stage it shows at (rows at the width nearest 80), or its native diff. */
interface Example {
	readonly item: StageItem;
	readonly rows?: RowsItem;
	readonly native?: readonly string[];
}

const EXAMPLE_WIDTH = 80;
const examples = new Map<Deviation, Example>();
/** Deviating stages per entry (a stage counts once however many widths differ). */
const stageCounts = new Map<Deviation, number>();
for (const item of items) {
	const entries = new Set([...item.rows.flatMap(rows => rows.deviations), ...(item.native?.deviations ?? [])]);
	for (const entry of entries) stageCounts.set(entry, (stageCounts.get(entry) ?? 0) + 1);
	for (const rowsItem of item.rows) {
		for (const entry of rowsItem.deviations) {
			const known = examples.get(entry);
			const closer =
				known?.item === item &&
				known.rows !== undefined &&
				Math.abs(rowsItem.width - EXAMPLE_WIDTH) < Math.abs(known.rows.width - EXAMPLE_WIDTH);
			if (!known || closer) examples.set(entry, { item, rows: rowsItem });
		}
	}
	if (item.native)
		for (const entry of item.native.deviations)
			if (!examples.has(entry)) examples.set(entry, { item, native: item.native.lines });
}

function exampleHtml(example: Example): string {
	const { item } = example;
	const where = `${escapeHtml(caseStem(item.file))} <span class="theme">${escapeHtml(item.theme)}</span> · [${item.index}] ${escapeHtml(item.label)}`;
	if (example.rows) {
		const { diff, width } = example.rows;
		const height = Math.max(diff.old.length, diff.new.length);
		return `<div class="lbl">${where} @${width} · ${diff.cells} cells differ</div><div class="pair ${item.theme === "light" ? "light" : "dark"}"><div class="side"><div class="lbl">old</div>${gridHtml(diff.old, diff.marks, width, height)}</div><div class="side"><div class="lbl">new</div>${gridHtml(diff.new, diff.marks, width, height)}</div></div>`;
	}
	const lines = example.native ?? [];
	return `<div class="lbl">${where} · native tree</div><pre class="native">${lines.map(line => `<span class="${line[0] === "+" ? "add" : line[0] === "−" ? "del" : "chg"}">${escapeHtml(line)}</span>`).join("\n")}</pre>`;
}

const screens = [...new Set(DEVIATIONS.map(entry => entry.screen))].sort();
const anchor = (screen: string): string => `s-${screen.replace(/[^a-z0-9]+/gi, "-")}`;

const sections = screens.map(screen => {
	const entries = DEVIATIONS.filter(entry => entry.screen === screen).map(entry => {
		const example = examples.get(entry);
		const stages = stageCounts.get(entry) ?? 0;
		const seen = example
			? `differs at ${stages} stage${stages === 1 ? "" : "s"}`
			: '<b class="warn">no difference captured</b>';
		return `<div class="entry"><div>${badge(entry)} ${entryScope(entry)} — ${seen}</div><div class="why">${escapeHtml(entry.reason)}</div>${example ? exampleHtml(example) : ""}</div>`;
	});
	return `<section id="${anchor(screen)}"><h2>${escapeHtml(screen)}</h2>${entries.join("\n")}</section>`;
});

const byCategory = new Map<DeviationCategory, number>();
for (const entry of DEVIATIONS) byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
const unseen = DEVIATIONS.filter(entry => !examples.has(entry));
const toc = screens.map(screen => `<a href="#${anchor(screen)}">${escapeHtml(screen)}</a>`).join(" · ");

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>pi-tui deviations</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#f6f6f6;color:#222}
h2{border-bottom:2px solid #ccc;padding-top:12px;font-size:17px}
.theme{color:#777;font-weight:normal}
.entry{margin:10px 0 22px}.warn{color:#b00}
.cat{display:inline-block;border-radius:3px;padding:0 5px;font-size:11px;color:#fff}
.lbl{font-size:11px;color:#777;margin:4px 0 2px}.cat.cap{color:#fff;background:#6a5acd}.bug{background:#c0392b}.design{background:#2e86c1}.natives{background:#7d6608}
.kind{font-size:11px;color:#555;border:1px solid #aaa;border-radius:3px;padding:0 4px}
.why{font-size:13px;margin:2px 0 4px}
.pair{display:flex;gap:16px;align-items:flex-start;overflow-x:auto;padding:8px;border-radius:4px;width:fit-content;max-width:100%;box-sizing:border-box}
.pair.dark{--bg:#1e1e1e;--fg:#d4d4d4;background:#2b2b2b}.pair.light{--bg:#ffffff;--fg:#1e1e1e;background:#ddd}
.pair .lbl{color:#999}
.term{font:13px/1.25 "SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;background:var(--bg);color:var(--fg);white-space:pre;outline:1px solid #888;box-sizing:content-box}
.r{height:1.25em;white-space:pre}.r.gone{background:repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,0,0,.25) 4px 8px)}
.w{display:inline-block;width:2ch;overflow:hidden;vertical-align:top}
.d{outline:1px solid #ff3b3b;outline-offset:-1px;box-shadow:inset 0 0 0 99px rgba(255,59,59,.22)}
.native{background:#fff;border:1px solid #ccc;padding:6px;font-size:12px;overflow-x:auto;margin:0}.add{color:#11772d}.del{color:#b00}.chg{color:#7a4b00}
${[...styleClasses].map(([css, name]) => `.${name}{${css}}`).join("\n")}
</style></head><body>
<h1>pi-tui deviations from the corpus</h1>
<p>One example per entry of <code>packages/coding-agent/test/ui/deviations.ts</code>: its first deviating stage, old (captured today's UI) beside new (pi-tui through the same harness the corpus tests run), differing cells outlined. Native diffs: <span class="del">−</span> recorded only, <span class="add">+</span> new only, <span class="chg">~</span> changed.</p>
<p>${DEVIATIONS.length} entries (${[...byCategory].map(([category, n]) => `${n} ${category}`).join(", ")}) across ${items.length} deviating stages${unseen.length ? ` · <b class="warn">${unseen.length} without a captured difference</b>` : ""} · generated ${new Date().toISOString()}</p>
<p>${toc}</p>
${sections.join("\n")}
</body></html>
`;

await Bun.write(out, page);

console.log(`${DEVIATIONS.length} entries: ${[...byCategory].map(([category, n]) => `${n} ${category}`).join(", ")}`);
for (const entry of unseen)
	console.log(
		`no difference captured: ${entry.screen} ${entry.case} (${entry.kind}) ${entry.stages?.join(",") ?? "*"}`,
	);
console.log(
	`${items.length} deviating stages, one example per entry → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`,
);
