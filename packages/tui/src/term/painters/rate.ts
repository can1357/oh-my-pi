/** `rate`: a throughput (`42.3 tok/s`): the value, then its unit per second. */
import type { TspRateProps, TspTone } from "@oh-my-pi/pi-wire";
import { definePainter } from "../paint";
import { lineBlock } from "./badge";

/** A rate value with at most one decimal (none from 100 up). */
export function formatRate(value: number): string {
	if (!Number.isFinite(value)) return "–";
	return Math.abs(value) >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

definePainter("rate", (node, cx) => {
	const props = node.props() as TspRateProps & { tone?: TspTone };
	const unit = props.unit ? ` ${props.unit}/s` : "/s";
	return lineBlock(cx.theme.style(props.tone ?? "muted", `${formatRate(props.value)}${unit}`), cx);
});
