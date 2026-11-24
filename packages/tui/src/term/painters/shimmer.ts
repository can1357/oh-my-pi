/**
 * `shimmer`: text lit by the terminal shimmer (`text/shimmer`) on the
 * terminal clock: `classic` sweeps a band left to right, `kitt` bounces a
 * scanner head. The palette's theme keys color the tiers (default dim, muted,
 * accent); the high tier is bold. Reduced motion draws the text in its own
 * styles.
 */
import type { TspShimmerProps } from "@oh-my-pi/pi-wire";
import { type ShimmerTiers, shimmerText } from "../../text/shimmer";
import type { Theme } from "../../theme/contract";
import { definePainter, EMPTY_BLOCK } from "../paint";
import { lineBlock } from "./badge";
import { styledText } from "./layout";

/** Shimmer tiers in theme colors (unknown keys fall back to dim, muted, accent); the high tier is bold. */
export function shimmerTiers(theme: Theme, palette: TspShimmerProps["palette"] = {}): ShimmerTiers {
	const pick = (key: string | undefined, fallback: string): string => (key && theme.has(key) ? key : fallback);
	const low = pick(palette.low, "dim");
	const mid = pick(palette.mid, "muted");
	const high = pick(palette.high, "accent");
	return {
		low: text => theme.fg(low, text),
		mid: text => theme.fg(mid, text),
		high: text => theme.style("strong", theme.fg(high, text)),
	};
}

definePainter("shimmer", (node, cx) => {
	const props = node.props() as TspShimmerProps;
	const content = props.spans ?? props.text;
	if (cx.reduceMotion) return lineBlock(styledText(cx.theme, content), cx);
	const plain = props.spans ? props.spans.map(span => span.t).join("") : (props.text ?? "");
	const out = shimmerText(plain, cx.now(true), props.mode ?? "classic", shimmerTiers(cx.theme, props.palette));
	return out === "" ? EMPTY_BLOCK : lineBlock(out, cx);
});
