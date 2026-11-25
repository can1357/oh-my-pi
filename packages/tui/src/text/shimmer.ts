/**
 * The shimmer as a text terminal draws it: a soft band of light travelling
 * 20 cells a second along the text (`classic`), entering and leaving through
 * a margin, or a scanner head bouncing between its ends with a fading trail
 * (`kitt`). Each grapheme falls in one of three tiers (low, mid, high) by the
 * band's intensity over it; the caller styles the tiers.
 */
import { pieces } from "./width";

/** How a tier styles its run of text. */
export type TierStyle = (text: string) => string;

/** The three tiers of a shimmer, dimmest first. */
export interface ShimmerTiers {
	readonly low: TierStyle;
	readonly mid: TierStyle;
	readonly high: TierStyle;
}

export type ShimmerMode = "classic" | "kitt";

/** Band travel in cells per second, whatever the text's length. */
const SPEED = 20;
/** Cells the classic band travels beyond each end of the text. */
const PADDING = 10;
/** Half-width of the classic band's cosine profile, in cells. */
const BAND = 6;
/** Half-width of the scanner's head, and the length of its trail. */
const HEAD = 0.6;
const TRAIL = 7;
/** Intensity at or above which a grapheme is high, else mid. */
const HIGH = 0.65;
const MID = 0.22;

/** Plain `text` lit by the shimmer at terminal time `now` (ms), one styled run per tier change. */
export function shimmerText(text: string, now: number, mode: ShimmerMode, tiers: ShimmerTiers): string {
	const graphemes = pieces(text).filter(piece => !piece.escape);
	const total = graphemes.length;
	if (total === 0) return "";
	const travel = (now / 1000) * SPEED;
	const intensity: (index: number) => number =
		mode === "kitt" ? kitt(total, travel) : index => classic(index, travel % (total + PADDING * 2));
	let out = "";
	let run = "";
	let runTier: keyof ShimmerTiers | undefined;
	for (let i = 0; i < total; i++) {
		const lit = intensity(i);
		const tier: keyof ShimmerTiers = lit >= HIGH ? "high" : lit >= MID ? "mid" : "low";
		if (tier !== runTier && run !== "") {
			out += tiers[runTier!](run);
			run = "";
		}
		runTier = tier;
		run += graphemes[i]!.text;
	}
	if (run !== "" && runTier) out += tiers[runTier](run);
	return out;
}

function classic(index: number, position: number): number {
	const distance = Math.abs(index + PADDING - position);
	return distance >= BAND ? 0 : 0.5 * (1 + Math.cos((Math.PI * distance) / BAND));
}

function kitt(total: number, travel: number): (index: number) => number {
	const range = total - 1;
	let head = 0;
	let right = true;
	if (range > 0) {
		const sweep = travel % (2 * range);
		right = sweep < range;
		head = right ? sweep : 2 * range - sweep;
	}
	return index => {
		const delta = index - head;
		if (Math.abs(delta) <= HEAD) return 1;
		// Only cells behind the head trail light.
		const behind = right ? -delta : delta;
		if (behind <= HEAD) return 0;
		const t = (behind - HEAD) / TRAIL;
		return t >= 1 ? 0 : (1 - t) * (1 - t);
	};
}
