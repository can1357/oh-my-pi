/**
 * Code reads become outlines: bodies fold
 * to `… [lines A-B]` markers with exact file line numbers, the biggest containers open one level, and the bodies the
 * conversation names or Spotlight ranks near the window's best stay open within a keep budget. Signatures and
 * markers are structure (`s`), bodies open on a name `n` or on rank `a`, folded bodies `f`.
 */
import type { SpotlightReason } from "@oh-my-pi/pi-tui/chat/spotlight";
import { countNewlines } from "@oh-my-pi/pi-utils";
import { fileLines, readTargets, resolveTarget, SOURCE_PATH } from "./command";
import { bump, noteRank, noteWhy, type Origin, type Run, scoreLines, shifted, spanShares } from "./run";
import { renderFolds, type View } from "./view";

/** Outline knobs. */
const MIN_WINDOW = 150;
const TARGET_SHARE = 0.2;
const TARGET_MIN = 30;
const KEEP_SHARE = 0.25;
const KEEP_MIN = 30;
/** Bodies shorter than this never fold: folding a five-line body costs as much in markers as the body. */
const MIN_FOLD = 6;
/** A folded body opens at this share of the window's best block. */
const KEEP_CUT = 0.5;
/** Folded containers larger than this always unfold one level, so member signatures show. */
const OPEN_ALWAYS = 80;
/** An outline hiding less than this share of the window is not worth its markers: the window is shown whole. */
const MIN_HIDDEN = 0.2;
/** Names shorter than this are too generic to count as named in the conversation. */
const MIN_NAME = 4;
/** The part an outline ranks bodies by: its block's hottest line as a share of the window's hottest block. */
const OUTLINE_PARTS = ["Spotlight, block ÷ best block"];

/** One foldable block: a header line and its more-indented body. 0-based window indexes. */
interface FoldBlock {
	head: number;
	from: number;
	to: number;
	children: FoldBlock[];
	name: string;
}

const BLOCK_NAME =
	/(?:def|class|function\*?|interface|enum|type|const|let|var|async\s+def)\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\(|function)/;

/** Indentation width: a space counts 1, a tab 4. */
function indentOf(line: string): number {
	let n = 0;
	for (const ch of line) {
		if (ch === " ") n++;
		else if (ch === "\t") n += 4;
		else break;
	}
	return n;
}

/** Lines a multi-line signature may span above the line that closes it and opens the body. */
const SIGNATURE_LINES = 20;

/**
 * The name a block's header gives it. A header closing a multi-line signature (`): Promise<T> {`) names nothing
 * itself: the name is on the line at its depth that opened the signature (`async #shapeOutput(`), so the
 * conversation naming the function still opens its body.
 */
function blockName(lines: readonly string[], ind: readonly number[], head: number): string {
	const own = BLOCK_NAME.exec(lines[head]);
	if (own || !/^\s*[)\]]/.test(lines[head])) return own?.slice(1).find(Boolean) ?? "";
	for (let k = head - 1; k >= Math.max(0, head - SIGNATURE_LINES); k--) {
		if (lines[k].trim() === "" || ind[k] > ind[head]) continue;
		if (ind[k] < ind[head]) break;
		return BLOCK_NAME.exec(lines[k])?.slice(1).find(Boolean) ?? "";
	}
	return "";
}

/**
 * Indentation blocks of `lines` (any language): a non-blank line followed by more-indented lines heads a block whose
 * body runs while lines are blank or more indented. A Python docstring at the top of a body stays with the header
 * (whole when ≤ 3 lines, else its first line). Bodies shorter than {@link MIN_FOLD} don't fold; their children lift.
 */
function foldBlocks(lines: readonly string[]): FoldBlock[] {
	const blank = lines.map(l => l.trim() === "");
	const ind = lines.map(indentOf);
	const build = (from: number, to: number, parentIndent: number): FoldBlock[] => {
		const out: FoldBlock[] = [];
		for (let i = from; i <= to; i++) {
			if (blank[i] || ind[i] <= parentIndent - 1) continue;
			let j = i + 1;
			while (j <= to && blank[j]) j++;
			if (j > to || ind[j] <= ind[i]) continue;
			let end = j;
			for (let k = j; k <= to; k++) {
				if (blank[k]) continue;
				if (ind[k] > ind[i]) end = k;
				else break;
			}
			let bodyFrom = i + 1;
			const first = lines[j]?.trim() ?? "";
			if (/^[rRuUbB]{0,2}("""|''')/.test(first)) {
				const at = first.search(/("""|''')/);
				const quote = first.slice(at, at + 3);
				let close = j;
				if (first.indexOf(quote) === first.lastIndexOf(quote)) {
					close = j + 1;
					while (close < end && !lines[close].includes(quote)) close++;
				}
				bodyFrom = close - j + 1 <= 3 ? close + 1 : j + 1;
			}
			const children = build(bodyFrom, end, ind[i] + 1);
			if (end - bodyFrom + 1 >= MIN_FOLD) {
				out.push({ head: i, from: bodyFrom, to: end, children, name: blockName(lines, ind, i) });
			} else out.push(...children);
			i = end;
		}
		return out;
	};
	return build(0, lines.length - 1, 0);
}

/** An outlined window: the view to show and the spans (1-based file lines) it folded. */
export interface Outline {
	view: View;
	folded: [number, number][];
}

/**
 * Outline of a printed code window. `content` is the window's source lines, `shown` the same lines as printed
 * (prefixes kept), `first` the 1-based file line of `content[0]`, `origin` where its lines are in the run's base
 * (for the heat; `null`: nowhere). Undefined when the window is too short, has no blocks, or the outline would hide
 * too little.
 */
export async function outlineWindow(
	run: Run,
	content: readonly string[],
	shown: readonly string[],
	first: number,
	origin: Origin | null,
): Promise<Outline | undefined> {
	const n = content.length;
	if (n < MIN_WINDOW) return undefined;
	const roots = foldBlocks(content);
	if (!roots.length) return undefined;
	const size = (b: FoldBlock) => b.to - b.from + 1;
	const folded = new Set<FoldBlock>(roots);
	let visible = n - roots.reduce((s, b) => s + size(b) - 1, 0);
	const target = Math.max(TARGET_MIN, TARGET_SHARE * n);
	// Unfold largest first: containers over OPEN_ALWAYS lines always open one level; others while the outline stays
	// under twice the target (then the target).
	for (;;) {
		const candidates = [...folded].filter(b => b.children.length).sort((a, b) => size(b) - size(a));
		let opened = false;
		for (const b of candidates) {
			const after = visible + (size(b) - 1) - b.children.reduce((s, c) => s + size(c) - 1, 0);
			if (after > (visible < target ? 2 * target : target) && size(b) <= OPEN_ALWAYS) continue;
			folded.delete(b);
			for (const c of b.children) folded.add(c);
			visible = after;
			opened = true;
			break;
		}
		if (!opened) break;
	}
	const leaves = [...folded];
	const score = new Map<FoldBlock, number>();
	for (const b of leaves) if (b.name.length >= MIN_NAME && run.state.names.has(b.name)) score.set(b, 2);
	const named = new Set(score.keys());
	let share: Map<FoldBlock, number> | undefined;
	if (leaves.some(b => !score.has(b))) {
		const scores = await scoreLines(run, content, origin);
		// Every leaf's share, so a named block can be the window's best; only unnamed ones take theirs. Without
		// scores the unnamed bodies stay folded: the skeleton plus what the conversation names.
		if (scores) {
			const shares = spanShares(
				scores,
				leaves.map(b => ({ from: b.head, to: b.to })),
			);
			share = new Map(leaves.map((b, k) => [b, shares[k]]));
		}
		for (const b of leaves) if (!score.has(b)) score.set(b, share?.get(b) ?? 0);
	}
	const budget = Math.max(KEEP_MIN, KEEP_SHARE * n);
	let kept = 0;
	const opened: FoldBlock[] = [];
	for (const b of leaves.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.from - b.from)) {
		if ((score.get(b) ?? 0) < KEEP_CUT) break;
		if (kept + size(b) > budget) continue;
		folded.delete(b);
		opened.push(b);
		kept += size(b);
	}
	const spans = [...folded].filter(b => size(b) >= MIN_FOLD).sort((a, b) => a.from - b.from);
	const hidden = spans.reduce((s, b) => s + size(b), 0);
	if (hidden < MIN_HIDDEN * n) return undefined;
	const why = Array.from<SpotlightReason>({ length: n }).fill("s");
	for (const b of opened) why.fill(named.has(b) ? "n" : "a", b.from, b.to + 1);
	for (const b of spans) why.fill("f", b.from, b.to + 1);
	noteWhy(run, origin, why);
	if (share) {
		const values = Array.from<number>({ length: n }).fill(0);
		for (const [b, s] of share) values.fill(s, b.head, b.to + 1);
		const last = opened.findLast(b => !named.has(b));
		noteRank(run, origin, {
			parts: OUTLINE_PARTS,
			max: 1,
			values: [values],
			why,
			floor: KEEP_CUT,
			last: last && {
				item: last.from,
				chars: content.slice(last.from, last.to + 1).reduce((s, l) => s + l.length + 1, 0),
			},
		});
	}
	bump(run, "outlines");
	bump(run, "outlineHiddenLines", hidden);
	bump(run, "outlineKeptLines", kept);
	if (named.size) bump(run, "outlineNamed", named.size);
	return {
		view: renderFolds(content, shown, first, spans, true),
		folded: spans.map(b => [first + b.from, first + b.to]),
	};
}

/** A later read overlapping a span folded earlier is the agent paging folded code back in. */
function isRecovery(run: Run, abs: string, first: number, last: number): boolean {
	const overlaps = ([a, b]: [number, number]) => first <= b && a <= last;
	return (run.state.folded.get(abs) ?? []).some(overlaps) || (run.folds.get(abs) ?? []).some(overlaps);
}

function rememberFolds(run: Run, abs: string, folded: [number, number][]): void {
	run.folds.set(abs, [...(run.folds.get(abs) ?? []), ...folded]);
}

/** Result of outlining the code windows of one output. */
export interface Outlined {
	/** The shaped view, or undefined when nothing was outlined. */
	view?: View;
	/** Some window was a read of folded code (shown whole). */
	recovery: boolean;
}

/** Outline of one `read` of a source file; a read overlapping folded code is shown whole. */
export async function outlineRead(run: Run, abs: string): Promise<Outlined> {
	const read = run.input.read;
	if (!read) return { recovery: false };
	if (isRecovery(run, abs, read.firstLine, read.firstLine + read.lines.length - 1)) {
		bump(run, "outlineRecoveries");
		return { recovery: true };
	}
	const o = await outlineWindow(run, read.lines, read.shown, read.firstLine, shifted(0));
	if (!o) return { recovery: false };
	rememberFolds(run, abs, o.folded);
	return { view: o.view, recovery: false };
}

interface CodeWindow {
	abs: string;
	first: number;
	content: string[];
	shown: string[];
	/** Offset of the window's first character in the output, and its length. */
	at: number;
	len: number;
}

/** Code windows of `output` printed by `command`: file-printing segments and grep/rg context runs over source files. */
async function codeWindows(command: string, output: string, cwd: string): Promise<CodeWindow[]> {
	const out: CodeWindow[] = [];
	const targets = readTargets(command).filter(t => /[*?[]/.test(t.arg) || SOURCE_PATH.test(t.arg));
	let cursor = 0;
	for (const t of targets) {
		for (const abs of await resolveTarget(t, cwd)) {
			if (!SOURCE_PATH.test(abs)) continue;
			const lines = await fileLines(abs);
			if (!lines) continue;
			for (const [a, b] of t.ranges ?? [[1, lines.length]]) {
				const lo = Math.max(1, a);
				const hi = Math.min(lines.length, b);
				if (hi < lo) continue;
				const content = lines.slice(lo - 1, hi);
				const shown = t.numbered ? content.map((l, i) => `${String(lo + i).padStart(6)}\t${l}`) : content;
				const block = shown.join("\n");
				const at = output.indexOf(block, cursor);
				if (at < 0) continue;
				out.push({ abs, first: lo, content, shown, at, len: block.length });
				cursor = at + block.length;
			}
		}
	}
	if (/\b(grep|rg)\b[^|\n]*\s-[A-Za-z]*[ABC]\s*\d+/.test(command) || /\b(grep|rg)\b[^|\n]*--context/.test(command)) {
		const single = /\b(?:grep|rg)\b[^|;&\n]*\s([\w./-]+\.\w+)\s*(?:$|[;|&\n])/.exec(command)?.[1];
		const lines = output.split("\n");
		const starts: number[] = [];
		let offset = 0;
		for (const l of lines) {
			starts.push(offset);
			offset += l.length + 1;
		}
		const parse = (l: string) =>
			/^([\w./@+-]+\.\w+)[:-](\d+)[:-](.*)$/.exec(l) ?? (single ? /^()(\d+)[:-](.*)$/.exec(l) : null);
		for (let i = 0; i < lines.length;) {
			const m = parse(lines[i]);
			if (!m) {
				i++;
				continue;
			}
			const file = m[1] || single || "";
			let j = i + 1;
			let next = Number(m[2]) + 1;
			while (j < lines.length) {
				const m2 = parse(lines[j]);
				if (!m2 || (m2[1] || single) !== file || Number(m2[2]) !== next) break;
				next++;
				j++;
			}
			if (SOURCE_PATH.test(file)) {
				const shown = lines.slice(i, j);
				const resolved = await resolveTarget({ arg: file, numbered: false, cds: [] }, cwd);
				out.push({
					abs: resolved[0] ?? file,
					first: Number(m[2]),
					content: shown.map(l => parse(l)?.[3] ?? ""),
					shown,
					at: starts[i],
					len: shown.join("\n").length,
				});
			}
			i = j;
		}
	}
	return out.sort((a, b) => a.at - b.at);
}

/** Outlines every long code window a bash command printed; windows inside a span folded earlier stay whole. */
export async function outlineBash(run: Run, output: string): Promise<{ text?: string; recovery: boolean }> {
	const command = run.input.command ?? "";
	const windows = await codeWindows(command, output, run.cwd);
	let text = "";
	let pos = 0;
	let outlined = false;
	let recovery = false;
	for (const w of windows) {
		if (w.at < pos) continue;
		if (isRecovery(run, w.abs, w.first, w.first + w.content.length - 1)) {
			bump(run, "outlineRecoveries");
			recovery = true;
			continue;
		}
		// The output is the result's own text (outlining runs first), so a window's lines are base lines from its row.
		const origin = output === run.input.text ? shifted(countNewlines(output.slice(0, w.at))) : null;
		const o = await outlineWindow(run, w.content, w.shown, w.first, origin);
		if (!o) continue;
		rememberFolds(run, w.abs, o.folded);
		text += output.slice(pos, w.at) + o.view.lines.join("\n");
		pos = w.at + w.len;
		outlined = true;
	}
	if (!outlined) return { recovery };
	return { text: text + output.slice(pos), recovery };
}
