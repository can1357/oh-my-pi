/**
 * The Spotlight experiment's tool-output shaping: base layers (outlines,
 * docs, test runs, lossless dump compaction), then the already-seen collapse, a 400-character line cap and the size
 * valve. Every relevance-driven keep/fold decision comes from the session's {@link Scorer}; without
 * scores each step falls back to a rule.
 *
 * `read`, `bash` and `eval` have steps of their own (outlines, docs, test runs keyed off the command); every other
 * tool's result goes down eval's path: dumps compacted, lines already seen collapsed, and the valve; every cut keeps
 * the headings of the lines it shows (`grep`'s `# dir/` and `## file`). Their short results pass whole, but for runs
 * of lines already seen that pay for their marker.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { countNewlines } from "@oh-my-pi/pi-utils";
import { reasonShows, type SpotlightReason } from "@oh-my-pi/pi-tui/chat/spotlight";
import { isMarkdownPath } from "@oh-my-pi/pi-tui/lang-from-path";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import shapeProbe from "../../prompts/spotlight/shape-probe.md" with { type: "text" };
import shapeRule from "../../prompts/spotlight/shape-rule.md" with { type: "text" };
import { parseSel } from "../../tools/read-selector";
import {
	type CallContext,
	type Scorer,
	type ShapedLines,
	type ShapeInput,
	type ShapeOutcome,
	type ShapeSink,
	shapesItself,
} from "../types";
import { lineIndex, matchLine } from "./align";
import { EDIT_TOOLS } from "../edit-gate";
import {
	isPageBack,
	isTestRun,
	namesSource,
	narrowsOutput,
	printsFiles,
	runsAgent,
	runsProgram,
	SOURCE_PATH,
} from "./command";
import { foldBashDocs, foldReadDoc } from "./docs";
import { shapeDumpOutput, shapeDumpRead } from "./dumps";
import { AGAIN_CHARS, indentOfFirst, MARKER, norm, words } from "./lines";
import { outlineBash, outlineRead } from "./outline";
import { alignedTo, bump, headTail, noteRank, noteWhy, type Origin, type Run, scoreLines } from "./run";
import { noteCall, noteShown, type ShapeState } from "./state";
import { shapeTestRun } from "./test-runs";
import { fileSpans, runSpan, type Span, type View } from "./view";
import {
	fillSmallGaps,
	keepCommitHeaders,
	lineShape,
	uniformShape,
	COMMIT,
	DENSITY_MAX,
	DENSITY_PARTS,
	densityScores,
	frameLines,
	isDiff,
	isGrid,
	keepHeadings,
	type Window,
	witnessedMask,
} from "./window";

/** The probe Spotlight scores output lines under: each line's relevance to the agent's current call. */
export const SHAPE_PROBE: string = shapeProbe;

/** The system-prompt paragraph telling the agent how shaped output reads (read narrowly, batch calls). */
export const SHAPE_RULE: string = shapeRule.trim();

let tokenizer: Tokenizer | undefined;

/** Tokens of `text` as a result's trace counts them (`inTokens`, `outTokens`). */
export function countTokens(text: string): number {
	tokenizer ??= new Tokenizer();
	return tokenizer.countTokens(text);
}

/** Records what a kept shaping hid and folded, so later results can tell re-asks and recoveries. */
function commit(run: Run): void {
	for (const line of run.hid) run.state.hidden.add(line);
	for (const [abs, spans] of run.folds) run.state.folded.set(abs, [...(run.state.folded.get(abs) ?? []), ...spans]);
}

/** Shortest run of already-seen lines that collapses. */
const SEEN_RUN = 4;
/**
 * In a short result (which passes whole otherwise), a run of already-seen lines collapses from this many lines, and
 * only when its text is at least {@link SEEN_MARGIN} characters longer than its marker: shorter runs save too little
 * to be worth the agent's look at a marker.
 */
const SHORT_SEEN_RUN = 3;
const SEEN_MARGIN = 80;
/**
 * A word of the call's intent names a line for keeping when it is in at most this many of the result's lines: a word
 * in more says nothing about which line the agent wants.
 */
const INTENT_LINES = 6;
/** The valve's budget: a cut result shows about this many characters. */
const WINDOW_BUDGET = 3_000;
/** A result holding at least this many lines a cut hid before is the agent asking again: shown whole. */
const REASK_LINES = 3;
/** The valve: a result over this many characters is cut to {@link WINDOW_BUDGET}. */
const VALVE_OVER = 3_900;
/** Output of the agent's own programs triggers the valve only past twice the size. */
const PROGRAM_SCALE = 2;
/** Results shaped earlier, source reads, and sub-agent reports and edit results are left whole up to this size. */
const EXEMPT_MAX = 12_000;
/**
 * A result of a tool without steps of its own this short, in characters and lines, passes whole (under every size
 * the steps act on) but for runs of lines already seen that pay for their marker ({@link SHORT_SEEN_RUN}).
 */
const SHORT_CHARS = 3_900;
const SHORT_LINES = 40;
/**
 * Fewest tokens a changed text must save against what the agent gets without it: below this, the gap markers and
 * footers a cut adds, and the reads back they invite, outweigh the saving.
 */
export const MIN_SAVED_TOKENS = 100;
/** Lines longer than this keep their first {@link LINE_KEEP} characters. */
const MAX_LINE = 400;
const LINE_KEEP = 280;
/** A numpy scalar's repr (`np.float64(103.6)`), printed as its number. */
const NP_SCALAR = /np\.(?:float|int|uint)\d*\(([-+\d.e]+|nan|inf)\)/g;
/** The verbatim-copy pointer at the end of a compaction header, dropped when the valve cuts the result again. */
const VERBATIM = /[;,]\s*verbatim(?: copy)?: \S+\]$/;
/**
 * Targets shown whole besides page-backs: text the agent or its subagents wrote (`agent://`, `local://`) and
 * instructions it must follow (`skill://`, `rule://`).
 */
const WHOLE_READ = /^(?:agent|local|skill|rule):\/\//i;

/**
 * Whether a result is shown whole besides page-backs: a {@link WHOLE_READ} target, or a `read` of Markdown or of one
 * line range without `:raw` (`file.ts:120-180`). Cuts of those two were mostly read back, or saved only on rereads
 * of the same few files.
 */
function isWholeRead(input: ShapeInput): boolean {
	const target = input.path ?? "";
	if (WHOLE_READ.test(target)) return true;
	if (input.tool !== "read") return false;
	const { path: file, sel } = splitPathAndSel(target.trim());
	if (isMarkdownPath(file)) return true;
	try {
		const parsed = parseSel(sel);
		return (
			parsed.kind === "lines" && !parsed.raw && parsed.ranges.length === 1 && parsed.ranges[0].endLine !== undefined
		);
	} catch {
		// `read` rejects a malformed range before shaping; what only another reader parses (a video frame) is no range.
		return false;
	}
}

/** The text being shaped: the whole result, or the block of a read's file lines inside it. */
interface Subject {
	before: string;
	after: string;
	view: View;
}

function subjectOf(input: ShapeInput): Subject | undefined {
	const read = input.read;
	// Without a window (command output, a URL, any read not printed as its file's lines) the whole text is shaped.
	if (!read) return { before: "", after: "", view: { lines: input.text.split("\n"), spans: null } };
	if (!read.shown.length) return undefined;
	const block = read.shown.join("\n");
	const at = input.text.indexOf(block);
	if (at < 0) return undefined;
	return {
		before: input.text.slice(0, at),
		after: input.text.slice(at + block.length),
		view: { lines: [...read.shown], spans: fileSpans(read.shown.length, read.firstLine) },
	};
}

/** What the base layers made of a result. */
interface Base {
	view: View;
	steps: string[];
	/** A read of folded code, shown whole. */
	recovery: boolean;
}

function withNote(view: View, note: string): View {
	return { lines: [...view.lines, note], spans: view.spans && [...view.spans, null] };
}

const foldedNote = (paths: string[]) => {
	const file = paths.length === 1 ? paths[0] : "FILE";
	return `[folded: … [lines A-B] are lines A-B of ${file} (read ${file}:A-B)]`;
};
const docsNote = (paths: string[]) =>
	`[sections folded: read ${paths.length === 1 ? paths[0] : "FILE"}:A-B prints one]`;

async function realPath(cwd: string, file: string): Promise<string> {
	const abs = path.resolve(cwd, file);
	try {
		return await fs.realpath(abs);
	} catch {
		return abs;
	}
}

/**
 * The base layers: code reads outlined, docs folded, test runs cut to failures; anything else down the dump path.
 * `read` results go through the same steps on the file's lines.
 */
async function base(run: Run, subject: Subject): Promise<Base> {
	const { input } = run;
	if (input.read) {
		let recovery = false;
		if (SOURCE_PATH.test(input.read.path)) {
			const o = await outlineRead(run, await realPath(run.cwd, input.read.path));
			if (o.view) return { view: withNote(o.view, foldedNote(o.paths)), steps: ["outline"], recovery: false };
			recovery = o.recovery;
		}
		const doc = await foldReadDoc(run);
		if (doc) return { view: withNote(doc, docsNote([input.read.path])), steps: ["docs"], recovery };
		const dump = await shapeDumpRead(run);
		if (dump) return { view: dump, steps: ["dump"], recovery };
		return { view: subject.view, steps: [], recovery };
	}
	const command = input.command ?? "";
	let text = input.text;
	const steps: string[] = [];
	let recovery = false;
	if (input.tool === "bash") {
		const code = await outlineBash(run, text);
		recovery = code.recovery;
		if (code.text !== undefined) {
			text = `${code.text}\n${foldedNote(code.paths)}`;
			steps.push("outline");
		}
		const docs = await foldBashDocs(run, text);
		if (docs) {
			text = `${docs.text}\n${docsNote(docs.paths)}`;
			steps.push("docs");
		}
		if (isTestRun(command)) {
			const tests = await shapeTestRun(run, text);
			if (tests !== undefined) {
				text = tests;
				steps.push("tests");
			}
		}
	}
	if (!steps.length) {
		const dump = await shapeDumpOutput(run, text);
		if (dump !== undefined) {
			text = dump;
			steps.push("dump");
		}
	}
	return { view: steps.length ? { lines: text.split("\n"), spans: null } : subject.view, steps, recovery };
}

/**
 * Where the hidden runs of a view point: the file, for a read whose lines map to file lines (raw or outlined: a run
 * spans from its first hidden line's file line to its last's, folded bodies included); the run's own artifact, when
 * the view is its output line for line; else a saved copy (compacted data, unspilled output). The copy is written
 * only once the shaped text clears the savings gate ({@link shapeResult}); until then {@link PENDING_COPY} stands for
 * its URL.
 */
function cutTarget(run: Run, view: View): { url: string; spans: Span[] | null } {
	const read = run.input.read;
	if (read && view.spans) return { url: read.path, spans: view.spans };
	const copy = view.lines.join("\n");
	const own = run.input.artifact;
	if (own && copy.replace(/\n+$/, "") === run.input.text.replace(/\n+$/, "")) return { url: own, spans: null };
	run.copy = copy;
	return { url: PENDING_COPY, spans: null };
}

/** Stands in the shaped text for the saved copy's URL until the copy is written; no tool output holds it. */
const PENDING_COPY = "\u0000spotlight-copy\u0000";
/** What the savings gate counts {@link PENDING_COPY} as: a session artifact's URL, the size it ships with. */
const COUNTED_COPY = "artifact://100";

/**
 * Lines of no file (notes of earlier shaping) can't be named by file lines, so a file-addressed cut keeps them, as
 * structure.
 */
function keepUnaddressed(
	why: (SpotlightReason | undefined)[],
	spans: readonly Span[] | null,
	skip?: readonly boolean[],
): void {
	if (!spans) return;
	spans.forEach((s, i) => {
		if (!s && !skip?.[i]) why[i] = "s";
	});
}

/** File (or saved-copy) line numbers of the run [i, j) of a view. */
function runLines(spans: readonly Span[] | null, i: number, j: number): [number, number] {
	return (spans && runSpan(spans, i, j)) ?? [i + 1, j];
}

/**
 * What a hidden run of `git log` output holds of whole commits, or "" when it holds no commit line: a marker naming
 * them says no commit vanished without trace. Up to four are named by hash prefix and subject
 * (` (2 commits: 3102b08 "fix(task): …", 9b72b7e "…")`), more by hash prefix alone (at most twelve named).
 */
function commitNote(hidden: readonly string[]): string {
	const commits: { hash: string; subject?: string }[] = [];
	hidden.forEach((line, i) => {
		if (!COMMIT.test(line)) return;
		let k = i + 1;
		while (k < hidden.length && (!hidden[k].trim() || /^[A-Z][A-Za-z]*:/.test(hidden[k]))) k++;
		const subject = k < hidden.length && !COMMIT.test(hidden[k]) ? hidden[k].trim() : undefined;
		commits.push({ hash: line.slice(7, 14), subject });
	});
	if (!commits.length) return "";
	const named =
		commits.length <= 4
			? commits.map(c =>
					c.subject ? `${c.hash} "${c.subject.length > 50 ? `${c.subject.slice(0, 50)}…` : c.subject}"` : c.hash,
				)
			: commits.map(c => c.hash);
	const listed = named.length > 12 ? `${named.slice(0, 12).join(", ")}, …` : named.join(", ");
	return ` (${commits.length === 1 ? "1 commit" : `${commits.length} commits`}: ${listed})`;
}

/** A collapsed run of already-seen lines and the read that brings them back, so the agent never reruns the call. */
const seenMarker = (count: number, url: string, [a, z]: [number, number], note = "") =>
	`… [${count} ${count === 1 ? "line" : "lines"} as shown before${note}: read ${url}:${a}-${z}]`;

/** The footer of a result with numbered gaps (`… [A-B]`) or capped lines: where those numbers are. */
const cutFooter = (url: string) => `[cut: … [A-B] are lines A-B of ${url} (read ${url}:A-B)]`;

/**
 * Lines no seen-collapse hides: a line holding a word of the call's intent that few lines hold (the agent asked for
 * that line now, beside this result), and for command output its last line, which says how the run ended. An output
 * matching an earlier one but cut short otherwise collapses whole and reads as the earlier run. `named` lists the
 * lines holding such an intent word, `terms` the words, and `missing` the intent's words no line holds.
 */
function seenKeeps(
	run: Run,
	lines: readonly string[],
): { keep: boolean[]; named: number[]; terms: string[]; missing: string[] } {
	const keep = Array.from<boolean>({ length: lines.length }).fill(false);
	const named: number[] = [];
	const terms: string[] = [];
	const missing: string[] = [];
	const asked = words(run.ctx.intent);
	if (asked.size) {
		const hits = new Map<string, number[]>();
		lines.forEach((line, i) => {
			if (MARKER.test(line)) return;
			for (const w of words(line)) {
				if (!asked.has(w)) continue;
				const at = hits.get(w);
				if (at) at.push(i);
				else hits.set(w, [i]);
			}
		});
		for (const [term, at] of hits) {
			if (at.length > INTENT_LINES) {
				// Too common to name one line, but newest-first and newest-last output put the latest at an end.
				keep[at[0]] = true;
				keep[at[at.length - 1]] = true;
				continue;
			}
			terms.push(term);
			for (const i of at) {
				if (!keep[i]) named.push(i);
				keep[i] = true;
			}
		}
		// A word counts as present when any line holds its stem anywhere (`shape` in `#shapeOutput`, `truncat` in
		// `truncated`): a claim that no line holds it must be true of every spelling a reader would accept.
		const text = lines.join("\n").toLowerCase();
		const stems = new Map<string, string>();
		for (const term of asked) {
			if (hits.has(term)) continue;
			const stem = term.slice(0, Math.max(5, term.length - 3));
			if (!text.includes(stem)) stems.set(stem, term);
		}
		// `truncate` and `truncation` miss as `trunc…` and `truncat…`: the shorter stem says both.
		for (const [stem, shown] of stems) {
			if (![...stems.keys()].some(other => other !== stem && stem.startsWith(other))) missing.push(shown);
		}
	}
	if (!run.input.read) {
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i].trim() || MARKER.test(lines[i])) continue;
			keep[i] = true;
			break;
		}
	}
	return { keep, named, terms, missing };
}

/** `mask` without the runs whose text (newlines included) is shorter than their marker plus {@link SEEN_MARGIN}. */
function payingRuns(lines: readonly string[], mask: readonly boolean[]): boolean[] {
	const out = [...mask];
	for (let i = 0; i < lines.length;) {
		if (!out[i]) {
			i++;
			continue;
		}
		let j = i;
		let chars = 0;
		while (j < lines.length && out[j]) chars += lines[j++].length + 1;
		if (chars < seenMarker(j - i, COUNTED_COPY, [i + 1, j]).length + 1 + SEEN_MARGIN) out.fill(false, i, j);
		i = j;
	}
	return out;
}

/**
 * A short result's view with every run of ≥ 3 already-seen lines that pays for its marker ({@link payingRuns})
 * collapsed to one marker naming the read that brings the lines back.
 */
async function collapseSeen(run: Run, view: View, steps: string[]): Promise<View> {
	const { keep } = seenKeeps(run, view.lines);
	const mask = payingRuns(view.lines, witnessedMask(view.lines, run.state.seen, SHORT_SEEN_RUN, keep));
	if (!mask.includes(true)) return view;
	noteWhy(
		run,
		viewOrigin(run, view) ?? alignedTo(run, view.lines),
		mask.map(m => (m ? "r" : undefined)),
	);
	const target = cutTarget(run, view);
	const lines: string[] = [];
	const spans: Span[] = [];
	let omitted = 0;
	for (let i = 0; i < view.lines.length;) {
		if (!mask[i]) {
			lines.push(view.lines[i]);
			spans.push(view.spans?.[i] ?? null);
			i++;
			continue;
		}
		let j = i;
		while (j < view.lines.length && mask[j]) j++;
		lines.push(
			`${run.input.read ? indentOfFirst(view.lines.slice(i, j)) : ""}${seenMarker(j - i, target.url, runLines(target.spans, i, j), commitNote(view.lines.slice(i, j)))}`,
		);
		spans.push(view.spans && runSpan(view.spans, i, j));
		omitted += j - i;
		i = j;
	}
	bump(run, "seenLines", omitted);
	steps.push("seen");
	return { lines, spans: view.spans && spans };
}

/** Spotlight's line scores with nulls as 0, or the head + tail order when Spotlight did not answer. */
async function lineScores(run: Run, lines: readonly string[], origin?: Origin): Promise<number[]> {
	const scores = await scoreLines(run, lines, origin);
	return scores ? scores.map(s => s ?? 0) : headTail(lines.length);
}

/**
 * Where a view's lines are in the run's base: a read's file lines by their spans (a line standing for one file
 * line is that window line), else the base lines they equal.
 */
function viewOrigin(run: Run, view: View): Origin | undefined {
	const read = run.input.read;
	const spans = view.spans;
	if (!read || !spans) return undefined;
	return i => {
		const s = spans[i];
		return s && s[0] === s[1] ? s[0] - read.firstLine : null;
	};
}

/**
 * The base layers, then the valve: already-seen runs collapse, lines over 400 characters keep 280, and a result over
 * 3.9k (the agent's own program output past 7.8k) is cut to ~3k, except outlines, source reads, sub-agent reports
 * (`task`, `wait`, `omp -p`) and edit results up to 12k, and pictures. Output repeating one line shape is cut to the
 * lines that differ, its ends, and a line naming the shape.
 * Re-asks (results up to 12k bringing back lines a cut hid) and reads of folded code come back whole.
 */
async function shapeSubject(run: Run, subject: Subject): Promise<{ view: View; steps: string[] }> {
	const { input, state } = run;
	const command = input.command ?? "";
	const b = await base(run, subject);
	const steps = [...b.steps];
	const lines = input.tool === "read" ? [...b.view.lines] : b.view.lines.map(l => l.replace(NP_SCALAR, "$1"));
	const spans = b.view.spans;
	const unwrapped = lines.some((l, i) => l !== b.view.lines[i]);

	// A rerun of a long command brings back the lines its last cut hid too; only a narrow result is the agent asking.
	let again = b.recovery;
	if (!again && state.hidden.size && lines.reduce((chars, l) => chars + l.length + 1, 0) <= EXEMPT_MAX) {
		const distinct = new Set(lines.map(norm).filter(l => l.length >= AGAIN_CHARS));
		let n = 0;
		for (const l of distinct) if (state.hidden.has(l)) n++;
		again = n >= REASK_LINES && n >= distinct.size * 0.2;
	}
	if (again) bump(run, "reasks");

	const { keep, named, terms, missing } = seenKeeps(run, lines);
	const witnessed = witnessedMask(lines, state.seen, again ? Math.min(SEEN_RUN, 2) : SEEN_RUN, keep);
	const width = lines.map(l => (!again && l.length > MAX_LINE ? LINE_KEEP + 36 : l.length));
	let shown = 0;
	lines.forEach((_, i) => {
		if (!witnessed[i]) shown += width[i] + 1;
	});
	const folded = b.steps.some(s => s === "outline" || s === "docs" || s === "tests");
	const scale = input.tool === "bash" && isTestRun(command) ? 2 : 1;
	const program = input.tool === "eval" || (input.tool === "bash" && runsProgram(command));
	const sourceRead = input.read
		? SOURCE_PATH.test(input.read.path)
		: input.tool === "bash" && printsFiles(command) && namesSource(command) && !program;
	// A sub-agent's report is read in full: cut, it came back as a read of the cut's copy (8 of 9), costing more than
	// the cut saved. An edit's result came back 5 of 13 times for ~600 tokens saved: even, so it stays whole too.
	const report =
		input.tool === "task" ||
		input.tool === "wait" ||
		Object.hasOwn(EDIT_TOOLS, input.tool) ||
		(input.tool === "bash" && runsAgent(command));
	// A diff is reviewed whole: each cut one a review needed its hidden lines (4 of 4).
	const diff = isDiff(input.read?.lines ?? lines);
	// Lines the agent already picked (a search, a filtered command): a cut one needed its hidden lines 6 of 8 times
	// and maybe the other 2, so a cut pays only past ~15k chars.
	const narrowed =
		input.tool === "grep" ||
		input.tool === "find" ||
		input.tool === "glob" ||
		(input.tool === "bash" && narrowsOutput(command));
	const exempt = ((folded || sourceRead || report || diff || narrowed) && shown <= EXEMPT_MAX) || isGrid(lines);
	const cut = !again && !exempt && shown > VALVE_OVER * scale * (program ? PROGRAM_SCALE : 1);
	// Scalars unwrapped above no longer equal their base lines; the view's own lines still do.
	const origin = viewOrigin(run, b.view) ?? alignedTo(run, b.view.lines);
	// Why the valve shows or hides each line; undefined: shown, as the base layers decided.
	let why: (SpotlightReason | undefined)[] = witnessed.map(w => (w ? "r" : undefined));
	let frame: { chosen: Window; density: number[] } | undefined;
	let budget = WINDOW_BUDGET * scale;
	let uniform: { shapes: string[]; differs: boolean[]; edges: boolean[] } | undefined;
	if (cut) {
		const spot = await lineScores(run, lines, origin);
		const density = densityScores(lines, spot);
		uniform = input.read ? undefined : uniformShape(lines, witnessed);
		const forced = lines.map(
			(l, i) =>
				(MARKER.test(l) && l.length < 200) || keep[i] || uniform?.differs[i] === true || uniform?.edges[i] === true,
		);
		// Chosen first: lines the intent names and the bodies the outline opened because the conversation names them
		// (what the agent asked for) and, in uniform output, the lines that differ (the news); then earlier shaping's
		// markers, cheap and saying what is where. A long outline holds dozens of fold markers: at one rank with them,
		// the asked-for lines lost to the markers above them.
		const namedBody = (i: number) => {
			const at = origin(i);
			return at !== null && run.why[at] === "n";
		};
		// Within a tier Spotlight's rank decides, so position alone never picks among equals.
		const scores = density.map((s, i) =>
			keep[i] || uniform?.differs[i] ? 30 + s : namedBody(i) ? 20 + s : forced[i] ? 10 + s : s,
		);
		// A body the conversation names is what the agent came for: the window grows to hold it, up to the size a
		// source read is shown whole at.
		let named = 0;
		lines.forEach((_, i) => {
			if (namedBody(i)) named += width[i] + 1;
		});
		budget = Math.min(Math.max(EXEMPT_MAX, WINDOW_BUDGET * scale), WINDOW_BUDGET * scale + named);
		const chosen = frameLines(width, lines, witnessed, scores, {
			budget,
			// Neighbours of a line that differs in uniform output are routine lines themselves.
			ctx: uniform ? 0 : 1,
			head: 3,
			tail: 4,
			// In uniform output only the lines that say something new are picked; the rest are routine samples.
			...(uniform ? { pick: forced } : {}),
		});
		frame = { chosen, density };
		why = chosen.why;
		if (!shapesItself(input.tool)) keepHeadings(lines, why);
		if (!input.read) keepCommitHeaders(lines, why);
		fillSmallGaps(width, why);
		// A filled gap can show a commit's lines whose header is still hidden.
		if (!input.read) keepCommitHeaders(lines, why);
	}
	const show = (i: number) => {
		const reason = why[i];
		return reason === undefined || reasonShows(reason);
	};
	const capped = !again && lines.some((l, i) => show(i) && l.length > MAX_LINE);
	if (!cut && !capped && !witnessed.includes(true)) {
		return { view: unwrapped ? { lines, spans } : b.view, steps };
	}

	if (cut && lines[0]?.startsWith("[display only:")) lines[0] = lines[0].replace(VERBATIM, "]");
	// Every line hidden past here gets an address, seen ones included: a marker the agent cannot follow costs a rerun.
	const target = cutTarget(run, { lines, spans });
	keepUnaddressed(why, target.spans, witnessed);
	noteWhy(run, origin, why);
	if (frame) {
		noteRank(run, origin, {
			parts: DENSITY_PARTS,
			max: DENSITY_MAX,
			values: [frame.density],
			why,
			floor: DENSITY_MAX,
			budget,
			used: frame.chosen.used,
			last: frame.chosen.last,
		});
	}
	const out: string[] = [];
	const outSpans: Span[] = [];
	let hidden = 0;
	let omitted = 0;
	let bare = 0;
	let shortened = 0;
	// Rows of a compacted view begin with values (`317|item317|…`): a bare `… [A-B]` beside them reads as data.
	const addressGaps = b.steps.includes("dump");
	for (let i = 0; i < lines.length;) {
		if (show(i)) {
			const l = lines[i];
			if (!again && l.length > MAX_LINE) {
				const at = target.spans?.[i]?.[0] ?? i + 1;
				out.push(
					`${l.slice(0, LINE_KEEP)} …[+${(l.length - LINE_KEEP).toLocaleString("en-US")} chars: line ${at}]`,
				);
				shortened++;
			} else out.push(l);
			outSpans.push(spans?.[i] ?? null);
			i++;
			continue;
		}
		let j = i;
		while (j < lines.length && !show(j)) j++;
		// A run the window hid holds a line not seen before, short ones included: it is a gap, not "as shown before".
		let fresh = false;
		for (let k = i; k < j; k++) {
			if (witnessed[k]) continue;
			fresh = true;
			if (norm(lines[k]).length >= AGAIN_CHARS) run.hid.add(norm(lines[k]));
		}
		const [a, z] = runLines(target.spans, i, j);
		// A read's markers sit at the code's depth; in command output an indented marker reads as part of the text.
		const indent = input.read ? indentOfFirst(lines.slice(i, j)) : "";
		if (fresh) {
			if (addressGaps) out.push(`${indent}… [${j - i} lines: read ${target.url}:${a}-${z}]`);
			else {
				out.push(`${indent}… [${a}-${z}]${commitNote(lines.slice(i, j))}`);
				bare++;
			}
			hidden += j - i;
		} else {
			out.push(`${indent}${seenMarker(j - i, target.url, [a, z], commitNote(lines.slice(i, j)))}`);
			omitted += j - i;
		}
		outSpans.push(spans && runSpan(spans, i, j));
		i = j;
	}
	if (uniform) {
		const hiddenOf = new Map(uniform.shapes.map(s => [s, 0]));
		const differAt: number[] = [];
		let differHidden = 0;
		for (let i = 0; i < lines.length; i++) {
			if (uniform.differs[i]) differAt.push(i);
			if (show(i) || witnessed[i] || !lines[i].trim() || MARKER.test(lines[i])) continue;
			const shape = lineShape(lines[i]);
			const n = hiddenOf.get(shape);
			if (n !== undefined) hiddenOf.set(shape, n + 1);
			else if (uniform.differs[i]) differHidden++;
		}
		const differ = differAt.length;
		const listed = [...hiddenOf]
			.filter(([, n]) => n > 0)
			.map(([s, n]) => `${n.toLocaleString("en-US")} match "${s.length > 200 ? `${s.slice(0, 200)}…` : s}"`);
		if (listed.length) {
			// Lines that differ are named by number when few, else counted by their own shapes when those are few.
			const kinds = new Map<string, number>();
			for (const i of differAt) kinds.set(lineShape(lines[i]), (kinds.get(lineShape(lines[i])) ?? 0) + 1);
			const which =
				differ <= 3
					? ` (${differ === 1 ? "line" : "lines"} ${differAt.map(i => runLines(target.spans, i, i + 1)[0]).join(", ")})`
					: kinds.size <= 3
						? ` (${[...kinds].map(([s, n]) => `${n.toLocaleString("en-US")} like "${s.length > 80 ? `${s.slice(0, 80)}…` : s}"`).join(", ")})`
						: "";
			const differs = !differ
				? "none differ"
				: `${differ.toLocaleString("en-US")} ${differ === 1 ? "line differs" : "lines differ"}${which}, ${differHidden ? `${differHidden.toLocaleString("en-US")} of them hidden` : differ === 1 ? "shown" : "all shown"}`;
			out.push(`[uniform: hidden lines: ${listed.join(", ")} (N: any number); ${differs}]`);
			outSpans.push(null);
		}
	}
	// What a cut means for the intent's words: every line naming a rare one is shown, and none holds the missing ones.
	// Saying so spares the agent a read to check the gaps.
	if (hidden) {
		const quoted = (ws: readonly string[]) =>
			`${ws
				.slice(0, 4)
				.map(w => `"${w}"`)
				.join(", ")}${ws.length > 4 ? ", …" : ""}`;
		const said: string[] = [];
		if (terms.length && named.every(i => show(i))) said.push(`every line naming ${quoted(terms)} is shown`);
		if (missing.length) {
			// A tool that stopped at its own result limit returned only part of what exists.
			const limited = lines.some(l => /\blimit reached\]?$/i.test(l.trim()));
			said.push(
				`no line contains any spelling of ${quoted(missing)}${limited ? " (of those the tool returned before its limit)" : ""}`,
			);
		}
		if (said.length) {
			out.push(`[intent: ${said.join("; ")}]`);
			outSpans.push(null);
		}
	}
	if (bare || shortened) {
		out.push(cutFooter(target.url));
		outSpans.push(null);
	}
	if (cut) {
		bump(run, "windowed");
		bump(run, "windowHiddenLines", hidden);
		steps.push("window");
	}
	if (omitted) {
		bump(run, "seenLines", omitted);
		steps.push("seen");
	}
	if (shortened) {
		bump(run, "cappedLines", shortened);
		steps.push("lines");
	}
	return { view: { lines: out, spans: spans && outSpans }, steps };
}

/**
 * Shapes one tool result and records what the agent was shown in `state`. A changed text reports what became of its
 * subject's lines: scores, kept lines, the reasons its steps recorded and the ranking of the last cut by rank. Never
 * throws for a scorer that cannot answer.
 *
 * A changed text saving fewer than {@link MIN_SAVED_TOKENS} tokens against the input is dropped (`stats.reverted`).
 * `plain` is the unshaped text for the call (default: the input), which can be far less than the full output shaping
 * reads. A changed text saving fewer than {@link MIN_SAVED_TOKENS} tokens against it is capped: the outcome keeps the
 * would-be text, adds the `plain-cap` step and sets `capped`. A `plain` whose lines the sink cut to its column cap
 * (`widthCut`) lost text only a read of the saved output brings back, so a cut up to {@link VALVE_OVER} characters is
 * applied even when longer than it. With `holdout`, a changed text is the cut shaping would make. Either way, and for
 * a text shaping keeps, the agent is shown `plain`'s text: `state` records that, not what the cut hid.
 */
export async function shapeResult(
	input: ShapeInput,
	ctx: CallContext,
	scorer: Scorer,
	state: ShapeState,
	sink: ShapeSink,
	signal?: AbortSignal,
	holdout = false,
	plain?: { text: string; tokens: number; widthCut?: boolean },
): Promise<ShapeOutcome> {
	const stats: Record<string, number> = { charsIn: input.text.length };
	const inTokens = countTokens(input.text);
	// Another tool's command is its arguments as JSON, which may name an artifact in passing: its `path` decides.
	const target = shapesItself(input.tool) ? (input.command ?? input.path) : input.path;
	const pageBack = isPageBack(target ?? "");
	const wholeRead = !pageBack && isWholeRead(input);
	const short =
		!pageBack &&
		!shapesItself(input.tool) &&
		input.text.length <= SHORT_CHARS &&
		countNewlines(input.text) < SHORT_LINES;
	const subject = pageBack || wholeRead ? undefined : subjectOf(input);
	const own = subject ? (input.read?.lines ?? subject.view.lines) : [];
	const run: Run = {
		input,
		ctx,
		scorer,
		state,
		sink,
		signal,
		cwd: input.cwd ?? process.cwd(),
		stats,
		base: own,
		heat: Array.from<number | null>({ length: own.length }).fill(null),
		why: Array.from<SpotlightReason | undefined>({ length: own.length }),
		hid: new Set(),
		folds: new Map(),
	};
	noteCall(state, ctx, input.tool, input.command ?? "", input.toolCallId);
	let text = input.text;
	let steps: string[] = [];
	if (pageBack) bump(run, "pageBacks");
	else if (wholeRead) bump(run, "wholeReads");
	else if (short) {
		bump(run, "short");
		if (subject) {
			const view = await collapseSeen(run, subject.view, steps);
			if (steps.length) text = view.lines.join("\n");
		}
	} else if (subject) {
		const shaped = await shapeSubject(run, subject);
		steps = shaped.steps;
		if (steps.length) text = subject.before + shaped.view.lines.join("\n") + subject.after;
	} else if (input.read) bump(run, "unlocated");
	// A changed command output leads with how the command ended: a cut can hide the lines that say so.
	if (text !== input.text && input.exitCode !== undefined && !input.read) {
		text = `[exit code ${input.exitCode}]\n${text}`;
	}
	let outTokens = text === input.text ? inTokens : countTokens(text.replaceAll(PENDING_COPY, COUNTED_COPY));
	let capped = false;
	if (inTokens - outTokens >= MIN_SAVED_TOKENS) {
		capped =
			plain !== undefined &&
			plain.tokens - outTokens < MIN_SAVED_TOKENS &&
			!(plain.widthCut && text.length <= VALVE_OVER);
		if (capped) {
			bump(run, "plainCapped");
			steps.push("plain-cap");
		}
	} else if (text !== input.text) {
		// Shaping that saves too few tokens is dropped: the agent sees the result whole, so nothing was cut or folded.
		bump(run, "reverted");
		text = input.text;
		steps = [];
		outTokens = inTokens;
	}
	// A kept text names its saved copy: written now, so a reverted or capped result leaves no artifact behind.
	let textUrl = input.artifact;
	if (run.copy !== undefined && text !== input.text && !capped) {
		const url = await sink.save(run.copy, input.tool);
		text = text.replaceAll(PENDING_COPY, url);
		outTokens = countTokens(text);
		if (run.copy === input.text) textUrl ??= url;
	}
	const applied = text !== input.text && !holdout && !capped;
	// What the cut hid and folded joins the session only now: a failed save above throws before the state changes.
	if (applied) commit(run);
	noteShown(state, applied ? text : (plain?.text ?? input.text), input.toolCallId);
	stats.charsOut = text.length;
	const outcome: ShapeOutcome = { text, steps: steps.length ? steps : ["none"], stats, inTokens, outTokens };
	if (capped) outcome.capped = true;
	else if (subject && text !== input.text) {
		outcome.lines = traceLines(run, text);
		if (textUrl) outcome.textUrl = textUrl;
	}
	return outcome;
}

/** A gap marker: a line of shaping standing for a hidden run (`… [lines A-B]`, `… [N lines: …]`, `… [A-B]`). */
const GAP = /^\s*… \[/;

/**
 * The run a gap marker names: how many lines it hides and, when it names them by number (`… [lines A-B]`, `… [A-B]`,
 * `… [N lines: read T:A-B]`), the first and last and where they are numbered (`T`; none for a bare range).
 */
function gapRun(marker: string): { count: number; range?: [number, number]; target?: string } | undefined {
	const bare = /^\s*… \[(?:lines )?(\d+)-(\d+)\](?: \(\d+ commits?: [^)]*\))?$/.exec(marker);
	if (bare) return { count: Number(bare[2]) - Number(bare[1]) + 1, range: [Number(bare[1]), Number(bare[2])] };
	const count = /^\s*… \[(\d+) (?:lines?|rows)\b/.exec(marker);
	if (!count) return undefined;
	const named = /read (\S+):(\d+)-(\d+)\]$/.exec(marker);
	if (!named) return { count: Number(count[1]) };
	const range: [number, number] = [Number(named[2]), Number(named[3])];
	return { count: range[1] - range[0] + 1, range, target: named[1] };
}

/**
 * What the shaped `text` shows of the run's base lines (a read's matched as printed, prefixes and all): which it shows
 * verbatim, why (the steps' records where they agree with that, else `-`), and what each line of `text` stands for:
 * a base line, the hidden run a gap marker stands for, or nothing.
 *
 * Lines are matched in order. A marker naming its run is authoritative: the run it names (a read's file lines, else
 * as many lines as it counts from where matching stands) is hidden and matching resumes after it, as long as the
 * next shaped line is the line after the run (or another marker, or no base line), so no shown line is matched to a
 * line inside it. A marker that names nothing fitting stands for the lines between the matches around it.
 */
function traceLines(run: Run, text: string): ShapedLines {
	const read = run.input.read;
	const lines = read?.shown ?? run.base;
	const index = lineIndex(lines);
	const shown = text.split("\n");
	const map = Array.from<number | [number, number] | null>({ length: shown.length }).fill(null);
	let cursor = 0;
	shown.forEach((line, k) => {
		if (!GAP.test(line)) {
			const at = matchLine(lines, index, line, cursor);
			if (at < 0) return;
			map[k] = at + 1;
			cursor = at + 1;
			return;
		}
		const gap = gapRun(line);
		if (!gap || gap.count < 1) return;
		const starts = [cursor];
		if (read && gap.range && (gap.target === undefined || gap.target === read.path)) {
			starts.unshift(gap.range[0] - read.firstLine);
		}
		const next = shown[k + 1];
		for (const start of starts) {
			const end = start + gap.count - 1;
			if (start < cursor || end >= lines.length) continue;
			const fits =
				next === undefined ||
				GAP.test(next) ||
				matchLine(lines, index, next, end + 1) === end + 1 ||
				matchLine(lines, index, next, 0) < 0;
			if (!fits) continue;
			map[k] = [start + 1, end + 1];
			cursor = end + 1;
			return;
		}
	});
	for (let i = 0; i < shown.length;) {
		if (map[i] !== null) {
			i++;
			continue;
		}
		let j = i;
		while (j < shown.length && map[j] === null) j++;
		// The lines between the entries resolved around [i, j), 1-based; several markers split them in order, each
		// taking the lines it names and the last the rest.
		const prev = map[i - 1] ?? 0;
		const following = j < shown.length ? (map[j] as number | [number, number]) : undefined;
		let from = (typeof prev === "number" ? prev : prev[1]) + 1;
		const to =
			following === undefined ? lines.length : (typeof following === "number" ? following : following[0]) - 1;
		const markers: number[] = [];
		for (let k = i; k < j; k++) if (GAP.test(shown[k])) markers.push(k);
		markers.forEach((k, m) => {
			const after = markers.length - 1 - m;
			const room = to - from + 1 - after;
			if (room < 1) return;
			const take = after ? Math.min(room, Math.max(1, gapRun(shown[k])?.count ?? 1)) : room;
			map[k] = [from, from + take - 1];
			from += take;
		});
		i = j;
	}
	const kept = Array.from<boolean>({ length: run.base.length }).fill(false);
	for (const entry of map) if (typeof entry === "number") kept[entry - 1] = true;
	const why = kept.map((k, i): SpotlightReason => {
		const reason = run.why[i];
		return reason !== undefined && reasonShows(reason) === k ? reason : "-";
	});
	return { scores: run.heat, kept, why, map, ...(run.rank ? { rank: run.rank } : {}) };
}
