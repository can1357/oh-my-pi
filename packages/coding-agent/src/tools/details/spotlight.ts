import { isRecord } from "@oh-my-pi/pi-utils";

/** Original lines a result's heat and the sheet cover; later lines are shown in neither. */
export const SPOTLIGHT_VIEW_LINES = 5_000;

/**
 * One window of an original that several reads make up (a `;`/`,` path `read`, one window per part): where its lines
 * sit in the original and how they are numbered.
 */
export interface SpotlightWindow {
	/** 0-based position of its first line in the original. */
	at: number;
	/** Its line count. */
	lines: number;
	/** Line number of its first line: a `read` window's first file line, else 1. */
	start: number;
	/** The file it shows (picks its grammar); absent for text no file names (a fetched page). */
	path?: string;
	/** How the step that cut its lines by rank chose them, positions relative to the window; absent when none did. */
	rank?: SpotlightRank;
	/** The part read its file with no line selector (a whole-file read): a tail of the file lies in it. */
	wholeFile?: true;
}

/** The original of a result whose text shaping changed. */
export interface SpotlightOriginal {
	/** Session spill holding the original text (`local://N.log`). */
	url: string;
	/** Its line count. */
	lines: number;
	/** Line number of its first line: a `read` window's first file line, else 1. With {@link windows}, 1. */
	start: number;
	/** The file a `read` showed (picks the sheet's grammar). Absent with {@link windows}. */
	path?: string;
	/**
	 * The windows the original is made of, in order and covering it, when the result joins several reads (a `;`/`,`
	 * path `read`): each numbered and ranked on its own, so {@link start}, {@link path} and {@link rank} are then
	 * absent or 1. Absent for a result of one window: read it through {@link originalWindows}.
	 */
	windows?: SpotlightWindow[];
	/**
	 * One character per original line, from its first (at most {@link SPOTLIGHT_VIEW_LINES}): the line's rank among
	 * the lines Spotlight scored, `0` (coldest) to `9` (hottest), `-` for a line it never scored. Lines past the end
	 * are unscored.
	 */
	heat: string;
	/** Runs of original lines the model was shown verbatim, `[first, last]` 1-based positions in the original. */
	kept: [number, number][];
	/**
	 * One {@link SpotlightReason} character per original line, over the span {@link heat} covers: why shaping showed or
	 * hid the line. Absent on traces written before it.
	 */
	why?: string;
	/** How the step that cut by rank chose its lines; absent when no step ranked them, and with {@link windows}. */
	rank?: SpotlightRank;
	/**
	 * One entry per line of the text the model saw (of a held-out result: the text it would have seen): the original
	 * line it shows (1-based position in the original), the `[first, last]` run a marker stands for, or null for a line
	 * of its own (a shaping note).
	 */
	map?: (number | [number, number] | null)[];
	/** A held-out result's would-be text, the cut the model was not shown (`local://N.log`). */
	shapedUrl?: string;
}

/**
 * Why shaping showed or hid one original line ({@link SpotlightOriginal.why}). Shown: `a` won on its score, `s`
 * structure kept regardless of score (head and tail lines, signatures, headings, table headers), `n` named by the
 * intent or the conversation, `c` context (a neighbour of a chosen line, or a lone gap filled). Hidden: `b` ranked
 * below the cutoff or past the budget, `r` seen in an earlier call, `f` folded by structure (an outline body, a doc
 * section, test-run noise, dump rows). `-` unknown.
 */
export type SpotlightReason = "a" | "s" | "n" | "c" | "b" | "r" | "f" | "-";

/** Whether a {@link SpotlightReason} shows the line. */
export function reasonShows(reason: SpotlightReason): boolean {
	return reason === "a" || reason === "s" || reason === "n" || reason === "c";
}

/**
 * The ranking of the step that cut by rank ({@link SpotlightOriginal.rank}): a line's score is the sum of its parts,
 * and the step kept the best lines while its budget lasted.
 */
export interface SpotlightRank {
	/**
	 * The parts a score adds up, in order, each in [0, 1] (shaping writes one; older traces may carry two, the ranks of
	 * `Spotlight` and of `word overlap`).
	 */
	parts: string[];
	/** The highest score a line can reach. */
	max: number;
	/** Per part, its value on every original line over the span {@link SpotlightOriginal.heat} covers ({@link encodeRankPart}). */
	values: string[];
	/** The lowest score the step kept on rank. */
	cutoff: number;
	/** Characters the step could show, and how many it showed; absent for a step with no character budget. */
	budget?: number;
	used?: number;
	/** The last line kept on rank (1-based position in the original) and the characters it cost. */
	last?: { line: number; chars: number };
}

/** Levels of one {@link encodeRankPart} value: two base-36 digits. */
const RANK_LEVELS = 36 * 36 - 1;

/** One {@link SpotlightRank.values} entry: two base-36 digits per line, each value relative to `max`. */
export function encodeRankPart(values: readonly number[], max: number): string {
	const n = Math.min(values.length, SPOTLIGHT_VIEW_LINES);
	let out = "";
	for (let i = 0; i < n; i++) {
		const level = max > 0 ? Math.round(Math.min(1, Math.max(0, values[i] / max)) * RANK_LEVELS) : 0;
		out += level.toString(36).padStart(2, "0");
	}
	return out;
}

/** The value of original line `i` (0-based) in an {@link encodeRankPart} string; 0 past its end. */
export function rankPartAt(encoded: string, i: number, max: number): number {
	const level = Number.parseInt(encoded.slice(2 * i, 2 * i + 2), 36);
	return Number.isNaN(level) ? 0 : (level / RANK_LEVELS) * max;
}

/**
 * What a result's Spotlight requests sent besides the output lines they ranked (`POST /v1/spotlight`): the agent's
 * state at the call, the command that produced the output, the question its lines were ranked under, and the model.
 */
export interface SpotlightRequestParams {
	/** The user's first message of the session. */
	task: string;
	/** Up to three earlier bash commands of the session, oldest first. */
	commands: string[];
	/** The agent's text before the call. */
	said: string;
	/** The call's intent argument. */
	intent: string;
	/** The command, code or `read <path>` that produced the output. */
	source: string;
	/** The probe the lines were ranked under: Spotlight scores each line's relevance to the agent's current call. */
	probe: string;
	model: string;
	thinking: string;
}

/** `details.spotlight`: one tool result as shaping left it. */
export interface SpotlightDetails {
	tool: string;
	/** The shaping steps that ran (`outline`, `window`, …; `none` for a passthrough). */
	steps: string[];
	inChars: number;
	outChars: number;
	/** o200k tokens of the original and of the text the model saw. */
	inTokens: number;
	outTokens: number;
	/**
	 * Size of the plain (unshaped) result for the same call (a spilled output's capped text, a read's page), notices
	 * included. Absent on traces written before pi recorded it.
	 */
	plainChars?: number;
	plainTokens?: number;
	/**
	 * `plainTokens - outTokens` for a changed (or held-out) result, else 0: negative for a column-cap cut longer than
	 * the preview it replaced. On older traces `inTokens - outTokens`.
	 */
	savedTokens: number;
	/** The score-free coin skipped Spotlight: the result was shaped by the no-score rules. Absent otherwise. */
	scoreFree?: boolean;
	/**
	 * The cut saved too few tokens against the plain result to apply, so the model got the plain text (`steps` ends
	 * with `plain-cap`, the out sizes are the plain text's): the would-be cut's size. Absent otherwise.
	 */
	cappedChars?: number;
	cappedTokens?: number;
	/**
	 * Shaping would have changed the text, but the result was held out at random: the model saw the plain result. The
	 * sizes, steps and {@link original} describe the would-be cut. Absent otherwise.
	 */
	holdout?: boolean;
	/**
	 * Transcripts from before the edit gate was removed: the gate kept a read pi guessed the agent would edit whole, and
	 * the model got the plain page. Like {@link holdout}, the sizes, steps and {@link original} describe the would-be
	 * cut, but `savedTokens` is 0. pi no longer writes it.
	 */
	gated?: boolean;
	/** Present only when shaping changed the text, or would have ({@link holdout}, {@link gated}). */
	original?: SpotlightOriginal;
	/** Present with {@link original} when Spotlight ranked the result's lines. */
	request?: SpotlightRequestParams;
}

/** The trace a result's details carry, or undefined when the experiment did not shape it. */
export function spotlightDetails(details: unknown): SpotlightDetails | undefined {
	if (!isRecord(details) || !isRecord(details.spotlight)) return undefined;
	const s = details.spotlight;
	if (typeof s.tool !== "string" || typeof s.savedTokens !== "number") return undefined;
	return s as unknown as SpotlightDetails;
}

/**
 * The {@link SpotlightOriginal.heat} of per-line scores: each scored line's rank among them in ten steps, ties sharing
 * their mean place. Spotlight's attention is heavy-tailed (a line or two take most of it), so a share of the hottest
 * line would put nearly every line at `0`.
 */
export function encodeHeat(scores: readonly (number | null)[]): string {
	const n = Math.min(scores.length, SPOTLIGHT_VIEW_LINES);
	const order: { score: number; line: number }[] = [];
	for (let i = 0; i < n; i++) {
		const score = scores[i];
		if (score !== null && score !== undefined) order.push({ score, line: i });
	}
	order.sort((a, b) => a.score - b.score);
	const digits = Array.from<string>({ length: n }).fill("-");
	for (let i = 0; i < order.length;) {
		let j = i;
		while (j + 1 < order.length && order[j + 1].score === order[i].score) j++;
		const digit = String(order.length > 1 ? Math.round(((i + j) / 2 / (order.length - 1)) * 9) : 9);
		for (let k = i; k <= j; k++) digits[order[k].line] = digit;
		i = j + 1;
	}
	return digits.join("").replace(/-+$/, "");
}

/** {@link SpotlightOriginal.kept} of a per-line kept mask. */
export function keptRanges(kept: readonly boolean[]): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < kept.length; i++) {
		if (!kept[i]) continue;
		let j = i;
		while (j + 1 < kept.length && kept[j + 1]) j++;
		out.push([i + 1, j + 1]);
		i = j;
	}
	return out;
}
