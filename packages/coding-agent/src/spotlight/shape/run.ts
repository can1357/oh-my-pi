import { encodeRankPart, type SpotlightRank, type SpotlightReason } from "@oh-my-pi/pi-tui/chat/spotlight";
import type { CallContext, Scorer, ShapeInput, ShapeSink } from "../types";
import { alignLines, lineIndex } from "./align";
import type { ShapeState } from "./state";

/** One shaping call: its input, the agent's context, the scorer and sink, the session state and the call's counters. */
export interface Run {
	input: ShapeInput;
	ctx: CallContext;
	scorer: Scorer;
	state: ShapeState;
	sink: ShapeSink;
	signal?: AbortSignal;
	/** Directory bash and eval ran in; paths of code windows resolve against it. */
	cwd: string;
	stats: Record<string, number>;
	/** The subject's own lines: a read's window lines (unprefixed), else the result text's lines. */
	base: readonly string[];
	/** Spotlight's latest score per {@link base} line, null while unscored; reported as the result's heat. */
	heat: (number | null)[];
	/**
	 * Why each {@link base} line was shown or hidden, as the latest step that decided on it recorded it (undefined
	 * while none did); reported as the result's `why` where it agrees with what the shaped text shows.
	 */
	why: (SpotlightReason | undefined)[];
	/** How the latest step that cut by rank ranked the {@link base} lines; reported as the result's rank. */
	rank?: SpotlightRank;
	/** Normalised lines this call's cuts hid; they join {@link ShapeState.hidden} only if the shaped text is kept. */
	hid: Set<string>;
	/** Code spans this call folded, per absolute path; they join {@link ShapeState.folded} only if the text is kept. */
	folds: Map<string, [number, number][]>;
	/** A cut's saved copy, as its footer names it; written only if the shaped text is kept. */
	copy?: string;
	/** {@link base} indexed by line text, built on first use. */
	baseIndex?: Map<string, number[]>;
}

/** The {@link Run.base} line that item `i` of a scored list is, or null for none. */
export type Origin = (i: number) => number | null;

/** Items that are base lines `offset`, `offset + 1`, …. */
export function shifted(offset: number): Origin {
	return i => offset + i;
}

/** Items matched to the base lines they equal, in order (see {@link alignLines}). */
export function alignedTo(run: Run, lines: readonly string[]): Origin {
	run.baseIndex ??= lineIndex(run.base);
	const at = alignLines(run.base, lines, run.baseIndex);
	return i => at[i] ?? null;
}

export function bump(run: Run, key: string, by = 1): void {
	run.stats[key] = (run.stats[key] ?? 0) + by;
}

/** Most characters of lines per Spotlight request; a longer output is scored in chunks, one request each. */
const CHUNK_CHARS = 32_000;
/** Longest item sent: a line's head says what it is, and one huge line must not overflow a request. */
const ITEM_CHARS = 4_000;

/**
 * Spotlight's score per line of `lines` (null for blank lines, which are not sent), or null when any request did not
 * answer or the scorer is score-free (nothing is sent): callers then fall back to a rule that needs no scores. Scores
 * of different chunks are compared as if they came from one request. The scores
 * land on the base lines `origin` names (by default the base lines the scored lines equal; `null` for lines that are
 * none, such as compacted data).
 */
export async function scoreLines(
	run: Run,
	lines: readonly string[],
	origin?: Origin | null,
): Promise<(number | null)[] | null> {
	if (run.scorer.scoreFree) return null;
	const index: number[] = [];
	lines.forEach((line, i) => {
		if (line.trim()) index.push(i);
	});
	const scores: (number | null)[] = lines.map(() => null);
	if (!index.length) return scores;
	const chunks: [number, number][] = [];
	let from = 0;
	let chars = 0;
	index.forEach((line, k) => {
		const size = Math.min(lines[line].length, ITEM_CHARS) + 1;
		if (k > from && chars + size > CHUNK_CHARS) {
			chunks.push([from, k]);
			from = k;
			chars = 0;
		}
		chars += size;
	});
	chunks.push([from, index.length]);
	const started = performance.now();
	const answers = await Promise.all(
		chunks.map(([a, b]) =>
			run.scorer.score(
				index.slice(a, b).map(i => lines[i].slice(0, ITEM_CHARS)),
				run.ctx,
				run.signal,
			),
		),
	);
	bump(run, "spotlightCalls", chunks.length);
	bump(run, "spotlightItems", index.length);
	bump(run, "spotlightMs", Math.round(performance.now() - started));
	const failed = answers.filter(a => a === null).length;
	if (failed) {
		bump(run, "spotlightFailures", failed);
		bump(run, "fallbacks");
		return null;
	}
	chunks.forEach(([a], c) => {
		(answers[c] as number[]).forEach((s, k) => {
			scores[index[a + k]] = s;
		});
	});
	if (origin !== null) noteHeat(run, scores, origin ?? alignedTo(run, lines));
	return scores;
}

/** Records why a step showed or hid each of its items on the base lines `origin` names (undefined: not decided). */
export function noteWhy(run: Run, origin: Origin | null, why: readonly (SpotlightReason | undefined)[]): void {
	if (!origin) return;
	why.forEach((reason, i) => {
		if (reason === undefined) return;
		const at = origin(i);
		if (at !== null && at >= 0 && at < run.why.length) run.why[at] = reason;
	});
}

/** One step's cut by rank over its items, as {@link noteRank} records it. */
export interface RankCut {
	/** The parts a score adds up, in order. */
	parts: string[];
	/** The highest score an item can reach. */
	max: number;
	/** Per part, its value on each item (items the step did not score: 0). */
	values: readonly (readonly number[])[];
	/** Per item, why the step showed or hid it: items chosen on their score are `a`. */
	why: readonly (SpotlightReason | undefined)[];
	/** The cutoff when no item of a base line was chosen on its score. */
	floor: number;
	/** Characters the step could show and showed, as it counts them. */
	budget?: number;
	used?: number;
	/** The last item chosen on its score and the characters it cost. */
	last?: { item: number; chars: number };
}

/**
 * Records a step's cut by rank over the base lines `origin` names (base lines it did not rank are 0): the cutoff is
 * the lowest score among the base lines it chose on their score.
 */
export function noteRank(run: Run, origin: Origin | null, cut: RankCut): void {
	if (!origin) return;
	const n = run.base.length;
	const values = cut.parts.map(() => Array.from<number>({ length: n }).fill(0));
	let cutoff = Number.POSITIVE_INFINITY;
	cut.why.forEach((reason, i) => {
		const at = origin(i);
		if (at === null || at < 0 || at >= n) return;
		let total = 0;
		cut.values.forEach((part, p) => {
			values[p][at] = part[i] ?? 0;
			total += part[i] ?? 0;
		});
		if (reason === "a") cutoff = Math.min(cutoff, total);
	});
	const rank: SpotlightRank = {
		parts: cut.parts,
		max: cut.max,
		values: values.map(v => encodeRankPart(v, cut.max)),
		cutoff: Number.isFinite(cutoff) ? cutoff : cut.floor,
	};
	if (cut.budget !== undefined) rank.budget = cut.budget;
	if (cut.used !== undefined) rank.used = cut.used;
	const last = cut.last ? origin(cut.last.item) : null;
	if (cut.last && last !== null && last >= 0 && last < n) {
		rank.last = { line: last + 1, chars: cut.last.chars };
	}
	run.rank = rank;
}

function noteHeat(run: Run, scores: readonly (number | null)[], origin: Origin): void {
	scores.forEach((score, i) => {
		if (score === null) return;
		const at = origin(i);
		if (at !== null && at >= 0 && at < run.heat.length) run.heat[at] = score;
	});
}

/** Each span's hottest line score (0 for spans without one), as a share of the best span; all 0 when none scored. */
export function spanShares(
	scores: readonly (number | null)[],
	spans: readonly { from: number; to: number }[],
): number[] {
	const best = spans.map(s => {
		let m = 0;
		for (let i = s.from; i <= s.to; i++) m = Math.max(m, scores[i] ?? 0);
		return m;
	});
	const top = best.reduce((a, b) => Math.max(a, b), 0);
	return best.map(m => (top > 0 ? m / top : 0));
}

/** The no-score order: lines nearer either end of the output rank higher (head + tail), in (0, 1]. */
export function headTail(n: number): number[] {
	return Array.from({ length: n }, (_, i) => 1 - Math.min(i, n - 1 - i) / Math.max(1, n));
}
