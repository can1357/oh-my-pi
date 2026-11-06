/**
 * The Spotlight experiment's trace on a tool result (`details.spotlight`, written by the coding agent's shaping
 * hooks and persisted with the message): what shaping did to the model-facing text, and, when it changed
 * it, where the original is and how Spotlight scored and kept its lines. A native transcript draws it as a notice
 * row under the tool card ({@link SpotlightNotice}); a click on a "saved" or "held out" notice opens the sheet.
 */
import { formatNumber, isRecord } from "@oh-my-pi/pi-utils";
import type { TspPropNode, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { col, node, propNode, span, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import type { Component } from "../tui";
import { hasTranscriptActions, runTranscriptAction } from "./transcript-actions";

/** Original lines a result's heat and the sheet cover; later lines are shown in neither. */
export const SPOTLIGHT_VIEW_LINES = 5_000;

/** The original of a result whose text shaping changed. */
export interface SpotlightOriginal {
	/** Session artifact holding the original text (`artifact://N`). */
	url: string;
	/** Its line count. */
	lines: number;
	/** Line number of its first line: a `read` window's first file line, else 1. */
	start: number;
	/** The file a `read` showed (picks the sheet's grammar). */
	path?: string;
	/**
	 * One character per original line, from its first (at most {@link SPOTLIGHT_VIEW_LINES}): Spotlight's score as
	 * `0`–`9` relative to the result's hottest line, `-` for a line it never scored. Lines past the end are unscored.
	 */
	heat: string;
	/** Runs of original lines the model was shown verbatim, `[first, last]` 1-based positions in the original. */
	kept: [number, number][];
	/**
	 * One {@link SpotlightReason} character per original line, over the span {@link heat} covers: why shaping showed or
	 * hid the line. Absent on traces written before it.
	 */
	why?: string;
	/** How the step that cut by rank chose its lines; absent when no step ranked them. */
	rank?: SpotlightRank;
	/**
	 * One entry per line of the text the model saw (of a held-out result: the text it would have seen): the original
	 * line it shows (1-based position in the original), the `[first, last]` run a marker stands for, or null for a line
	 * of its own (a shaping note).
	 */
	map?: (number | [number, number] | null)[];
	/** A held-out result's would-be text, the cut the model was not shown (`artifact://N`). */
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

/** The reason for original line `i` (0-based), or undefined past the trace or without one. */
export function reasonAt(why: string | undefined, i: number): SpotlightReason | undefined {
	const c = why?.[i];
	return c !== undefined && "asncbrf-".includes(c) ? (c as SpotlightReason) : undefined;
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

/**
 * Tokens the shaped text saves against the plain result (negative: it costs more), or against the original on
 * traces without {@link SpotlightDetails.plainTokens}.
 */
export function spotlightSaving(spotlight: SpotlightDetails): number {
	return spotlight.plainTokens === undefined ? spotlight.savedTokens : spotlight.plainTokens - spotlight.outTokens;
}

/** The trace a result's details carry, or undefined when the experiment did not shape it. */
export function spotlightDetails(details: unknown): SpotlightDetails | undefined {
	if (!isRecord(details) || !isRecord(details.spotlight)) return undefined;
	const s = details.spotlight;
	if (typeof s.tool !== "string" || typeof s.savedTokens !== "number") return undefined;
	return s as unknown as SpotlightDetails;
}

/** The {@link SpotlightOriginal.heat} of per-line scores: each relative to the best, in ten steps. */
export function encodeHeat(scores: readonly (number | null)[]): string {
	const n = Math.min(scores.length, SPOTLIGHT_VIEW_LINES);
	let top = 0;
	for (let i = 0; i < n; i++) top = Math.max(top, scores[i] ?? 0);
	let out = "";
	for (let i = 0; i < n; i++) {
		const s = scores[i];
		out += s === null || s === undefined ? "-" : String(top > 0 ? Math.round((Math.max(0, s) / top) * 9) : 0);
	}
	return out.replace(/-+$/, "");
}

/** The heat of original line `i` (0-based) in [0, 1], or undefined when Spotlight never scored it. */
export function heatAt(heat: string, i: number): number | undefined {
	const c = heat.charCodeAt(i);
	return c >= 48 && c <= 57 ? (c - 48) / 9 : undefined;
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

/** Heat digit from which a line counts as hot: a hidden one was cut though hot. */
const HOT_DIGIT = 6;

/** Whether original line `i` (0-based) scored hot: a heat digit of {@link HOT_DIGIT} or more. */
export function spotlightHot(heat: string, i: number): boolean {
	const c = heat.charCodeAt(i);
	return c >= 48 + HOT_DIGIT && c <= 57;
}

/** The tone of each reason that shows a line. */
const SHOWN_TONES: Record<"a" | "s" | "n" | "c", TspTone> = { a: "accent", s: "neutral", n: "user", c: "info" };

/**
 * The tone the sheet and the notice give original line `i` (0-based): why shaping showed it (`accent` score,
 * `neutral` structure, `user` named, `info` context), `error` for a hidden line that scored hot; undefined for any
 * other hidden line and for a line without a reason.
 */
export function spotlightTone(original: SpotlightOriginal, i: number): TspTone | undefined {
	const reason = reasonAt(original.why, i);
	if (reason === undefined || reason === "-") return undefined;
	if (reasonShows(reason)) return SHOWN_TONES[reason as keyof typeof SHOWN_TONES];
	return spotlightHot(original.heat, i) ? "error" : undefined;
}

/** At most this many bars in the notice card's chart; a longer result's lines share bars. */
const NOTICE_BARS = 120;

/** Tones a notice card bar takes from its lines, the most notable first (`muted`: a plain hidden line). */
const NOTICE_TONES: readonly TspTone[] = ["error", "accent", "user", "info", "neutral", "muted"];

/** The notice card's tone for original line `i` (0-based): {@link spotlightTone}, `muted` for a plain hidden line. */
function noticeTone(original: SpotlightOriginal, i: number): TspTone | undefined {
	const tone = spotlightTone(original, i);
	if (tone !== undefined) return tone;
	const reason = reasonAt(original.why, i);
	return reason !== undefined && reason !== "-" && !reasonShows(reason) ? "muted" : undefined;
}

/**
 * The hover card of a changed result's notice: its heat as at most {@link NOTICE_BARS} bars (each the hottest of its
 * lines, tinted by the most notable reason among them), then how many lines the model was shown, or of a held-out
 * result would have been.
 */
export function spotlightNoticeCard(original: SpotlightOriginal, heldOut = false): TspPropNode {
	const lines = original.heat.length;
	const bars = Math.min(NOTICE_BARS, lines);
	const series: { value: number; tone?: TspTone }[] = [];
	for (let bar = 0; bar < bars; bar++) {
		const end = Math.floor(((bar + 1) * lines) / bars);
		let value = 0;
		let best = NOTICE_TONES.length;
		for (let i = Math.floor((bar * lines) / bars); i < end; i++) {
			value = Math.max(value, heatAt(original.heat, i) ?? 0);
			const tone = noticeTone(original, i);
			if (tone !== undefined) best = Math.min(best, NOTICE_TONES.indexOf(tone));
		}
		series.push(best < NOTICE_TONES.length ? { value, tone: NOTICE_TONES[best] } : { value });
	}
	const kept = original.kept.reduce((sum, [from, to]) => sum + to - from + 1, 0);
	let scored = 0;
	let hot = 0;
	for (let i = 0; i < (original.why?.length ?? 0); i++) {
		if (reasonAt(original.why, i) === "a") scored++;
		else if (spotlightTone(original, i) === "error") hot++;
	}
	const facts = [
		`${heldOut ? "would keep" : "kept"} ${kept.toLocaleString("en-US")} of ${original.lines.toLocaleString("en-US")} lines`,
	];
	if (scored > 0) facts.push(`${scored.toLocaleString("en-US")} by score`);
	if (hot > 0) facts.push(`${hot.toLocaleString("en-US")} cut though hot`);
	return propNode(
		col(
			[
				node("chart", { kind: "bars", size: "sm", min: 0, max: 1, series }),
				text([span(facts.join(" · "), "muted")]),
			],
			{ gap: "xs" },
		),
	);
}

/** The notice's star when the model saw the original (passthrough, held out): Nerd Font `md-star_off_outline`. */
const STAR_OFF = "\u{f155b}";
/** The notice's star when shaping changed what the model saw: Nerd Font `fa-star`. */
const STAR = "\uf005";
/** {@link STAR} past {@link SHOOTING_STAR_TOKENS} saved: Nerd Font `md-star_shooting_outline`. */
const SHOOTING_STAR = "\u{f1742}";
/** Tokens saved past which the lit star shoots. */
const SHOOTING_STAR_TOKENS = 10_000;

/**
 * The notice's spans: Spotlight's star, then what shaping did to the result. A passthrough is the star alone. A
 * changed result's star is lit and pulses (Tern twinkles it), a shooting star past {@link SHOOTING_STAR_TOKENS} saved.
 */
function noticeSpans(spotlight: SpotlightDetails): TspSpan[] {
	const saving = spotlightSaving(spotlight);
	if (spotlight.holdout || spotlight.gated) {
		const why = spotlight.gated ? "kept whole for editing" : "held out";
		return [span(STAR_OFF, "icon"), span(`spotlight: ${why} · would save ${formatNumber(Math.max(0, saving))} toks`)];
	}
	if (!spotlight.original) return [span(STAR_OFF, "icon")];
	const star = saving > SHOOTING_STAR_TOKENS ? SHOOTING_STAR : STAR;
	return [
		span(star, "icon", { fx: "pulse" }),
		span(
			saving > 0
				? `spotlight: saved ${formatNumber(saving)} toks`
				: `spotlight: reshaped, +${formatNumber(-saving)} toks`,
		),
	];
}

/**
 * The notice row under one tool card (role `omp.tool.spotlight`, key `spotlight:<toolCallId>`): muted for a
 * passthrough (its star alone, named by its tooltip) and for a held-out result, accent for a changed result
 * ({@link noticeSpans}). One with an original (changed or held out) has a hover card charting its heat
 * ({@link spotlightNoticeCard}) and a click that opens its sheet through the host's transcript actions. A native
 * transcript block of its own, placed right after its card ({@link Component.nativeTrailers}), so it shows while the
 * card is collapsed; nothing in the terminal rows.
 */
export class SpotlightNotice implements Component {
	readonly #toolCallId: string;
	#spotlight: SpotlightDetails;
	#reduced: string;
	#hidden = false;
	#native: NativeNode | undefined;

	constructor(toolCallId: string, spotlight: SpotlightDetails, reduced: string) {
		this.#toolCallId = toolCallId;
		this.#spotlight = spotlight;
		this.#reduced = reduced;
	}

	update(spotlight: SpotlightDetails, reduced: string): void {
		if (spotlight === this.#spotlight && reduced === this.#reduced) return;
		this.#spotlight = spotlight;
		this.#reduced = reduced;
		this.#native = undefined;
	}

	/** Hidden with its card (tool activity hidden). */
	setHidden(hidden: boolean): void {
		if (hidden === this.#hidden) return;
		this.#hidden = hidden;
		this.#native = undefined;
	}

	describe(): NativeNode {
		if (this.#native) return this.#native;
		const original = this.#spotlight.original;
		this.#native = node("text", {
			role: "omp.tool.spotlight",
			key: `spotlight:${this.#toolCallId}`,
			tone: original && !this.#spotlight.holdout && !this.#spotlight.gated ? "accent" : "muted",
			spans: noticeSpans(this.#spotlight),
			...(original
				? {
						hovercard: spotlightNoticeCard(
							original,
							this.#spotlight.holdout === true || this.#spotlight.gated === true,
						),
					}
				: { title: "Spotlight: passthrough", aria: "Spotlight: passthrough" }),
			...(original && hasTranscriptActions() ? { actions: { click: "spotlight" } } : {}),
			...(this.#hidden ? { hidden: true } : {}),
		});
		return this.#native;
	}

	/** Never mounted in the terminal rows. */
	render(): readonly string[] {
		return [];
	}

	invalidate(): void {
		this.#native = undefined;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action" || event.act !== "spotlight" || !this.#spotlight.original) return;
		runTranscriptAction({
			act: "spotlight",
			toolCallId: this.#toolCallId,
			spotlight: this.#spotlight,
			reduced: this.#reduced,
		});
	}
}

/** The notices of one transcript block's calls, in the order the calls first reported a trace. */
export class SpotlightNotices {
	readonly #byCall = new Map<string, SpotlightNotice>();
	#list: readonly SpotlightNotice[] = [];
	#hidden = false;

	/** Records call `toolCallId`'s final result; true when a notice appeared or went. */
	set(toolCallId: string, details: unknown, reduced: string): boolean {
		const spotlight = spotlightDetails(details);
		const existing = this.#byCall.get(toolCallId);
		if (!spotlight) {
			if (!existing) return false;
			this.#byCall.delete(toolCallId);
			this.#list = [...this.#byCall.values()];
			return true;
		}
		if (existing) {
			existing.update(spotlight, reduced);
			return false;
		}
		const notice = new SpotlightNotice(toolCallId, spotlight, reduced);
		notice.setHidden(this.#hidden);
		this.#byCall.set(toolCallId, notice);
		this.#list = [...this.#byCall.values()];
		return true;
	}

	setHidden(hidden: boolean): void {
		this.#hidden = hidden;
		for (const notice of this.#list) notice.setHidden(hidden);
	}

	/**
	 * The notice blocks, the same array while none came or went; `shown` drops the notices of calls a
	 * transcript presenter hides (a fresh array then).
	 */
	list(shown?: (toolCallId: string) => boolean): readonly Component[] {
		if (!shown) return this.#list;
		const kept: SpotlightNotice[] = [];
		for (const [toolCallId, notice] of this.#byCall) if (shown(toolCallId)) kept.push(notice);
		return kept.length === this.#list.length ? this.#list : kept;
	}
}
