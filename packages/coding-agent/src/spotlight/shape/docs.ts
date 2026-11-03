/**
 * Long docs printed whole become headings plus the sections Spotlight ranks near the file's best. Every heading
 * stays; a folded section body becomes `… [lines A-B]`. Headings and short
 * sections are structure (`s`), sections kept on rank `a`, folded ones `f`.
 */
import type { SpotlightReason } from "@oh-my-pi/pi-tui/chat/spotlight";
import { countNewlines } from "@oh-my-pi/pi-utils";
import { DOC_FILE, fileLines, readTargets, resolveTarget } from "./command";
import { words } from "./lines";
import { bump, noteRank, noteWhy, type Origin, type Run, scoreLines, shifted, spanShares } from "./run";
import { renderFolds, type View } from "./view";

/** Shorter docs are shown as printed. */
const MIN_LINES = 80;
/** Sections with a shorter body are never folded. */
const MIN_BODY = 4;
/** A section stays shown at this share of the file's best section. */
const KEEP_CUT = 0.5;
/** The part a doc ranks sections by: its section's hottest line as a share of the doc's hottest section. */
const DOC_PARTS = ["Spotlight, section ÷ best section"];

/**
 * The section bodies of a doc to fold (0-based indexes), or undefined when the doc is too short, has fewer than two
 * foldable sections, or keeps them all. Without scores a section stays when its heading names a word of the
 * conversation (`n`) and folds otherwise, as an outline keeps the bodies the conversation names. `origin` places the
 * lines in the run's base for the heat.
 */
async function docFolds(
	run: Run,
	lines: readonly string[],
	origin: Origin | null,
): Promise<{ from: number; to: number }[] | undefined> {
	if (lines.length < MIN_LINES) return undefined;
	const heads: number[] = [];
	let fence = false;
	lines.forEach((l, i) => {
		if (/^\s*```/.test(l)) fence = !fence;
		if (!fence && /^#{1,6}\s/.test(l)) heads.push(i);
	});
	const sections = heads
		.map((h, k) => ({ head: h, from: h + 1, to: (heads[k + 1] ?? lines.length) - 1 }))
		.filter(s => s.to - s.from + 1 >= MIN_BODY);
	if (sections.length < 2) return undefined;
	const scores = await scoreLines(run, lines, origin);
	const shares = scores
		? spanShares(
				scores,
				sections.map(s => ({ from: s.head, to: s.to })),
			)
		: undefined;
	const keep = sections.map((s, k) =>
		shares ? shares[k] >= KEEP_CUT : [...words(lines[s.head])].some(w => run.state.words.has(w)),
	);
	const hide = sections.filter((_, k) => !keep[k]);
	if (!hide.length) return undefined;
	const why = Array.from<SpotlightReason>({ length: lines.length }).fill("s");
	sections.forEach((s, k) => {
		why.fill(!keep[k] ? "f" : shares ? "a" : "n", s.from, s.to + 1);
	});
	noteWhy(run, origin, why);
	if (shares) {
		const values = Array.from<number>({ length: lines.length }).fill(0);
		sections.forEach((s, k) => {
			values.fill(shares[k], s.head, s.to + 1);
		});
		noteRank(run, origin, { parts: DOC_PARTS, max: 1, values: [values], why, floor: KEEP_CUT });
	}
	bump(run, "docSections", hide.length);
	bump(
		run,
		"docHiddenLines",
		hide.reduce((s, h) => s + h.to - h.from + 1, 0),
	);
	return hide;
}

/** A `read` of a whole doc file, folded; undefined when nothing folds. */
export async function foldReadDoc(run: Run): Promise<View | undefined> {
	const read = run.input.read;
	if (!read || read.selected || !DOC_FILE.test(read.path)) return undefined;
	const folds = await docFolds(run, read.lines, shifted(0));
	return folds && renderFolds(read.lines, read.shown, read.firstLine, folds, false);
}

/** Docs a bash command printed whole (`cat README.md`), each folded in place; undefined when nothing folds. */
export async function foldBashDocs(run: Run, output: string): Promise<{ text: string; paths: string[] } | undefined> {
	const targets = readTargets(run.input.command ?? "").filter(t => !t.ranges && DOC_FILE.test(t.arg));
	let text = output;
	let cursor = 0;
	const paths: string[] = [];
	for (const t of targets) {
		for (const file of await resolveTarget(t, run.cwd)) {
			const lines = await fileLines(file.abs);
			if (!lines) continue;
			const block = lines.join("\n");
			const at = text.indexOf(block, cursor);
			if (at < 0) continue;
			// Until a fold rewrites it, the text is the result's own: the doc's lines are base lines from its row.
			const origin = text === run.input.text ? shifted(countNewlines(text.slice(0, at))) : null;
			const folds = await docFolds(run, lines, origin);
			if (!folds) continue;
			const view = renderFolds(lines, lines, 1, folds, false).lines.join("\n");
			text = text.slice(0, at) + view + text.slice(at + block.length);
			cursor = at + view.length;
			paths.push(file.path);
		}
	}
	return paths.length ? { text, paths } : undefined;
}
