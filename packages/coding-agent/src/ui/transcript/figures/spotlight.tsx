/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The Spotlight notice under a shaped tool result: one native line (role
 * `omp.tool.spotlight`, key `spotlight:<toolCallId>`) saying what shaping
 * saved, with a hover card charting the original's heat. Muted for a cut
 * that was held back (held out, or kept whole for editing) or carries no
 * original, accent with a pulsing star for an applied one. The terminal
 * shows nothing.
 */
import { formatNumber } from "@oh-my-pi/pi-utils";
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import type { TspPropNode, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { SpotlightDetails, SpotlightOriginal, SpotlightReason } from "../../../tools/details/spotlight";

/** The notice's action: open the result's Spotlight sheet. */
const SPOTLIGHT_ACT = "spotlight";
/** Bars at most in the hover card's chart; a longer original's lines share bars. */
const CARD_BARS = 120;
/** Heat digit from which a line counts as hot. */
const HOT_DIGIT = 9;
/** Nerd Font `fa-star`: shaping changed what the model saw. */
const STAR = "\uf005";
/** Nerd Font `md-star_shooting_outline`: past {@link SHOOTING_STAR_TOKENS} saved. */
const SHOOTING_STAR = "\u{f1742}";
const SHOOTING_STAR_TOKENS = 10_000;

/** Tones of the reasons that show a line. */
const SHOWN: Readonly<Record<string, TspTone>> = { a: "accent", s: "neutral", n: "user", c: "info" };
/** Bar tones, the most notable first (`muted`: a line hidden for no notable reason). */
const BAR_TONES: readonly TspTone[] = ["error", "accent", "user", "info", "neutral", "muted"];

function reasonAt(original: SpotlightOriginal, line: number): SpotlightReason | undefined {
	const c = original.why?.[line];
	return c !== undefined && "asncbrf-".includes(c) ? (c as SpotlightReason) : undefined;
}

/** A line's heat in 0–1, or undefined when Spotlight never scored it. */
function heatAt(heat: string, line: number): number | undefined {
	const c = heat.charCodeAt(line);
	return c >= 48 && c <= 57 ? (c - 48) / 9 : undefined;
}

/**
 * A line's tone: why it was shown (`accent` score, `neutral` structure, `user`
 * named, `info` context); a hidden line `error` when it scored hot, else
 * `muted`; none without a reason.
 */
function lineTone(original: SpotlightOriginal, line: number): TspTone | undefined {
	const reason = reasonAt(original, line);
	if (reason === undefined || reason === "-") return undefined;
	const shown = SHOWN[reason];
	if (shown) return shown;
	const c = original.heat.charCodeAt(line);
	return c >= 48 + HOT_DIGIT && c <= 57 ? "error" : "muted";
}

/** The hover card: the heat as bars (each its lines' hottest, toned by their most notable reason), then the counts. */
function heatCard(original: SpotlightOriginal, heldBack: boolean): TspPropNode {
	const lines = original.heat.length;
	const bars = Math.min(CARD_BARS, lines);
	const series: { value: number; tone?: TspTone }[] = [];
	for (let bar = 0; bar < bars; bar++) {
		let value = 0;
		let best = BAR_TONES.length;
		for (let line = Math.floor((bar * lines) / bars); line < Math.floor(((bar + 1) * lines) / bars); line++) {
			value = Math.max(value, heatAt(original.heat, line) ?? 0);
			const tone = lineTone(original, line);
			if (tone !== undefined) best = Math.min(best, BAR_TONES.indexOf(tone));
		}
		series.push(best < BAR_TONES.length ? { value, tone: BAR_TONES[best] } : { value });
	}
	let scored = 0;
	let hot = 0;
	for (let line = 0; line < (original.why?.length ?? 0); line++) {
		if (reasonAt(original, line) === "a") scored++;
		else if (lineTone(original, line) === "error") hot++;
	}
	const kept = original.kept.reduce((sum, [from, to]) => sum + to - from + 1, 0);
	const count = (n: number): string => n.toLocaleString("en-US");
	const facts = [`${heldBack ? "would keep" : "kept"} ${count(kept)} of ${count(original.lines)} lines`];
	if (scored > 0) facts.push(`${count(scored)} by score`);
	if (hot > 0) facts.push(`${count(hot)} cut though hot`);
	return {
		k: "col",
		p: { gap: "xs" },
		c: [
			{ k: "chart", p: { kind: "bars", size: "sm", min: 0, max: 1, series } },
			{ k: "text", p: { spans: [{ t: facts.join(" · "), s: "muted" }] } },
		],
	};
}

/** The notice line. */
function noticeSpans(spotlight: SpotlightDetails, saving: number): TspSpan[] {
	if (spotlight.holdout || spotlight.gated) {
		const why = spotlight.gated ? "kept whole for editing" : "held out";
		return [{ t: `spotlight: ${why} · would save ${formatNumber(Math.max(0, saving))} toks` }];
	}
	return [
		{ t: saving > SHOOTING_STAR_TOKENS ? SHOOTING_STAR : STAR, s: "icon", fx: "pulse" },
		{
			t:
				saving > 0
					? `spotlight: saved ${formatNumber(saving)} toks`
					: `spotlight: reshaped, +${formatNumber(-saving)} toks`,
		},
	];
}

/** The notice of one shaped result. */
export function SpotlightNotice(props: {
	readonly toolCallId: string;
	readonly spotlight: SpotlightDetails;
	readonly hidden?: Reactive<boolean | undefined>;
	/** Open the result's Spotlight sheet: a notice with an original activates it (click, Enter). */
	readonly onOpen?: () => void;
}): JSXNode {
	const spotlight = props.spotlight;
	const heldBack = spotlight.holdout === true || spotlight.gated === true;
	const saving =
		spotlight.plainTokens === undefined ? spotlight.savedTokens : spotlight.plainTokens - spotlight.outTokens;
	return (
		<text
			role="omp.tool.spotlight"
			propKey={`spotlight:${props.toolCallId}`}
			tone={spotlight.original && !heldBack ? "accent" : "muted"}
			spans={noticeSpans(spotlight, saving)}
			hovercard={spotlight.original ? heatCard(spotlight.original, heldBack) : undefined}
			hidden={() => (read(props.hidden) ? true : undefined)}
			actions={spotlight.original && props.onOpen ? { click: SPOTLIGHT_ACT } : undefined}
			onAction={act => {
				if (act === SPOTLIGHT_ACT) props.onOpen?.();
			}}
		/>
	);
}
