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
import { isPageBack, isTestRun, namesSource, printsFiles, runsProgram, SOURCE_PATH } from "./command";
import { foldBashDocs, foldReadDoc } from "./docs";
import { shapeDumpOutput, shapeDumpRead } from "./dumps";
import { AGAIN_CHARS, indentOfFirst, MARKER, norm, words } from "./lines";
import { outlineBash, outlineRead } from "./outline";
import { alignedTo, bump, headTail, noteRank, noteWhy, type Origin, type Run, scoreLines } from "./run";
import { noteCall, noteShown, type ShapeState } from "./state";
import { shapeTestRun } from "./test-runs";
import { fileSpans, runSpan, type Span, type View } from "./view";
import {
	DENSITY_MAX,
	DENSITY_PARTS,
	densityScores,
	frameLines,
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
/** Results shaped earlier or reading source are left whole up to this size. */
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

const foldedNote = (paths: string[]) =>
	`[folded: read ${paths.length === 1 ? paths[0] : "FILE"}:A-B prints a shown range]`;
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
 * spans from its first hidden line's file line to its last's, folded bodies included), else a saved copy (command
 * output, compacted data).
 */
async function cutTarget(run: Run, view: View): Promise<{ url: string; spans: Span[] | null }> {
	const read = run.input.read;
	if (read && view.spans) return { url: read.path, spans: view.spans };
	return { url: await run.sink.save(view.lines.join("\n"), run.input.tool), spans: null };
}

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

/** A collapsed run of already-seen lines, with where they are, so the agent never has to run the call again. */
const seenMarker = (count: number, [a, z]: [number, number]) => `… [${count} lines as shown before: ${a}-${z}]`;

/** The footer of a result with hidden lines: where its numbered gaps are. */
const cutFooter = (url: string) => `[cut: … [A-B] are lines A-B of ${url} (read ${url}:A-B)]`;

/**
 * Lines no seen-collapse hides: a line holding a word of the call's intent that few lines hold (the agent asked for
 * that line now, beside this result), and for command output its last line, which says how the run ended. An output
 * matching an earlier one but cut short otherwise collapses whole and reads as the earlier run.
 */
function seenKeeps(run: Run, lines: readonly string[]): boolean[] {
	const keep = Array.from<boolean>({ length: lines.length }).fill(false);
	const terms = words(run.ctx.intent);
	if (terms.size) {
		const hits = new Map<string, number[]>();
		lines.forEach((line, i) => {
			if (MARKER.test(line)) return;
			for (const w of words(line)) {
				if (!terms.has(w)) continue;
				const at = hits.get(w);
				if (at) at.push(i);
				else hits.set(w, [i]);
			}
		});
		for (const at of hits.values()) if (at.length <= INTENT_LINES) for (const i of at) keep[i] = true;
	}
	if (!run.input.read) {
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i].trim() || MARKER.test(lines[i])) continue;
			keep[i] = true;
			break;
		}
	}
	return keep;
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
		if (chars < seenMarker(j - i, [i + 1, j]).length + 1 + SEEN_MARGIN) out.fill(false, i, j);
		i = j;
	}
	return out;
}

/**
 * A short result's view with every run of ≥ 3 already-seen lines that pays for its marker ({@link payingRuns})
 * collapsed to one marker naming where the lines are, under the cut footer.
 */
async function collapseSeen(run: Run, view: View, steps: string[]): Promise<View> {
	const keep = seenKeeps(run, view.lines);
	const mask = payingRuns(view.lines, witnessedMask(view.lines, run.state.seen, SHORT_SEEN_RUN, keep));
	if (!mask.includes(true)) return view;
	noteWhy(
		run,
		viewOrigin(run, view) ?? alignedTo(run, view.lines),
		mask.map(m => (m ? "r" : undefined)),
	);
	const target = await cutTarget(run, view);
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
		lines.push(`${indentOfFirst(view.lines.slice(i, j))}${seenMarker(j - i, runLines(target.spans, i, j))}`);
		spans.push(view.spans && runSpan(view.spans, i, j));
		omitted += j - i;
		i = j;
	}
	lines.push(cutFooter(target.url));
	spans.push(null);
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
 * 3.9k (the agent's own program output past 7.8k) is cut to ~3k, except outlines and source reads up to 12k and
 * pictures. Re-asks and reads of folded code come back whole.
 */
async function shapeSubject(run: Run, subject: Subject): Promise<{ view: View; steps: string[] }> {
	const { input, state } = run;
	const command = input.command ?? "";
	const b = await base(run, subject);
	const steps = [...b.steps];
	const lines = input.tool === "read" ? [...b.view.lines] : b.view.lines.map(l => l.replace(NP_SCALAR, "$1"));
	const spans = b.view.spans;
	const unwrapped = lines.some((l, i) => l !== b.view.lines[i]);

	let again = b.recovery;
	if (!again && state.hidden.size) {
		const distinct = new Set(lines.map(norm).filter(l => l.length >= AGAIN_CHARS));
		let n = 0;
		for (const l of distinct) if (state.hidden.has(l)) n++;
		again = n >= REASK_LINES && n >= distinct.size * 0.2;
	}
	if (again) bump(run, "reasks");

	const keep = seenKeeps(run, lines);
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
	const exempt = ((folded || sourceRead) && shown <= EXEMPT_MAX) || isGrid(lines);
	const cut = !again && !exempt && shown > VALVE_OVER * scale * (program ? PROGRAM_SCALE : 1);
	// Scalars unwrapped above no longer equal their base lines; the view's own lines still do.
	const origin = viewOrigin(run, b.view) ?? alignedTo(run, b.view.lines);
	// Why the valve shows or hides each line; undefined: shown, as the base layers decided.
	let why: (SpotlightReason | undefined)[] = witnessed.map(w => (w ? "r" : undefined));
	let frame: { chosen: Window; density: number[] } | undefined;
	if (cut) {
		const spot = await lineScores(run, lines, origin);
		const density = densityScores(lines, spot);
		// Earlier shaping's markers are cheap and say what is where, and lines the intent names are what the agent
		// asked for: chosen first.
		const scores = density.map((s, i) => ((MARKER.test(lines[i]) && lines[i].length < 200) || keep[i] ? 10 : s));
		const chosen = frameLines(width, lines, witnessed, scores, {
			budget: WINDOW_BUDGET * scale,
			ctx: 1,
			head: 3,
			tail: 4,
		});
		frame = { chosen, density };
		why = chosen.why;
		if (!shapesItself(input.tool)) keepHeadings(lines, why);
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
	const target = await cutTarget(run, { lines, spans });
	keepUnaddressed(why, target.spans, witnessed);
	noteWhy(run, origin, why);
	if (frame) {
		noteRank(run, origin, {
			parts: DENSITY_PARTS,
			max: DENSITY_MAX,
			values: [frame.density],
			why,
			floor: DENSITY_MAX,
			budget: WINDOW_BUDGET * scale,
			used: frame.chosen.used,
			last: frame.chosen.last,
		});
	}
	const out: string[] = [];
	const outSpans: Span[] = [];
	let hidden = 0;
	let omitted = 0;
	let shortened = 0;
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
		const indent = indentOfFirst(lines.slice(i, j));
		if (fresh) {
			out.push(`${indent}… [${a}-${z}]`);
			hidden += j - i;
		} else {
			out.push(`${indent}${seenMarker(j - i, [a, z])}`);
			omitted += j - i;
		}
		outSpans.push(spans && runSpan(spans, i, j));
		i = j;
	}
	out.push(cutFooter(target.url));
	outSpans.push(null);
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
	let outTokens = text === input.text ? inTokens : countTokens(text);
	let capped = false;
	if (inTokens - outTokens >= MIN_SAVED_TOKENS) {
		capped =
			plain !== undefined &&
			plain.tokens - outTokens < MIN_SAVED_TOKENS &&
			!(plain.widthCut && text.length <= VALVE_OVER);
		if (capped) {
			bump(run, "plainCapped");
			steps.push("plain-cap");
		} else if (!holdout) commit(run);
	} else if (text !== input.text) {
		// Shaping that saves too few tokens is dropped: the agent sees the result whole, so nothing was cut or folded.
		bump(run, "reverted");
		text = input.text;
		steps = [];
		outTokens = inTokens;
	}
	const applied = text !== input.text && !holdout && !capped;
	noteShown(state, applied ? text : (plain?.text ?? input.text), input.toolCallId);
	stats.charsOut = text.length;
	const outcome: ShapeOutcome = { text, steps: steps.length ? steps : ["none"], stats, inTokens, outTokens };
	if (capped) outcome.capped = true;
	else if (subject && text !== input.text) outcome.lines = traceLines(run, text);
	return outcome;
}

/** A gap marker: a line of shaping standing for a hidden run (`… [lines A-B]`, `… [N lines: …]`, `… [A-B]`). */
const GAP = /^\s*… \[/;

/**
 * The run a gap marker names: how many lines it hides and, when it names them by number (`… [lines A-B]`, `… [A-B]`,
 * `… [N lines: read T:A-B]`), the first and last and where they are numbered (`T`; none for a bare range).
 */
function gapRun(marker: string): { count: number; range?: [number, number]; target?: string } | undefined {
	const bare = /^\s*… \[(?:lines )?(\d+)-(\d+)\]$/.exec(marker);
	if (bare) return { count: Number(bare[2]) - Number(bare[1]) + 1, range: [Number(bare[1]), Number(bare[2])] };
	const count = /^\s*… \[(\d+) (?:lines|rows)\b/.exec(marker);
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
