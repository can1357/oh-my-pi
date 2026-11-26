/**
 * `elapsed`: a running duration. `age` is what had elapsed when the node was
 * written; the terminal counts on from the clock time it first saw that age
 * (as a Tern terminal counts from the frame's arrival) until `stopped`.
 */
import type { TspElapsedProps, TspTone } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { definePainter } from "../paint";
import { lineBlock } from "./badge";

/** Duration as `850ms`, `4.2s`, `1m 5s`, `2h 3m` (short) or `0:04`, `1:05`, `2:03:00` (clock). */
export function formatDuration(ms: number, format: TspElapsedProps["format"] = "short"): string {
	const safe = Math.max(0, ms);
	if (format === "clock") {
		const total = Math.floor(safe / 1000);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const ss = String(total % 60).padStart(2, "0");
		return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
	}
	if (safe < 1000) return `${Math.round(safe)}ms`;
	if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
	const total = Math.floor(safe / 1000);
	if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
	return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/** Clock time a node's current `age` was first painted at. */
const kAnchor = Symbol("pi-tui.term.elapsed-anchor");

interface AnchoredNode {
	[kAnchor]?: { readonly age: number; readonly at: number };
}

/** Milliseconds an `elapsed` node shows at `now`. */
export function elapsedAt(node: UiNode, props: TspElapsedProps, now: number): number {
	if (props.stopped !== undefined) return props.stopped;
	const holder = node as AnchoredNode;
	let anchor = holder[kAnchor];
	if (!anchor || anchor.age !== props.age) {
		anchor = { age: props.age, at: now };
		holder[kAnchor] = anchor;
	}
	return anchor.age + Math.max(0, now - anchor.at);
}

definePainter("elapsed", (node, cx) => {
	const props = node.props() as TspElapsedProps & { tone?: TspTone };
	const ms = props.stopped ?? elapsedAt(node, props, cx.now());
	return lineBlock(cx.theme.style(props.tone ?? "muted", formatDuration(ms, props.format)), cx);
});
