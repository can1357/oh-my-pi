/**
 * Describe-time gate for the animations a TSP terminal clocks itself. The protocol has no "static
 * spinner" or "no effects" knob — a `spinner` node and an `fx` span animate until they are removed —
 * so `tui.motion` is honoured here, on the way to the wire: with static spinners a `spinner` node
 * becomes its frame-0 glyph (label and common props kept), and with decorative motion off every
 * `fx` (span effects, editor decorations) is dropped. Subtrees with nothing to still keep their identity (the reconciler
 * memoizes on it); translations are cached per described node until a switch flips.
 */
import type { TspSpan, TspSpinnerProps, TspText } from "@oh-my-pi/pi-wire";
import { motionEffectsEnabled } from "../motion-effects";
import { spinnerAnimated, STATIC_SPINNER_GLYPH } from "../spinner-clock";
import type { NativeChild, NativeNode } from "./node";

let cache = new WeakMap<NativeNode, NativeNode>();

/** Forget cached translations; the backend calls this when a motion switch flips, then re-describes. */
export function resetQuietMotion(): void {
	cache = new WeakMap();
}

/** `node` as described, or with its terminal-clocked animations stilled per the motion switches. */
export function quietMotion(node: NativeNode): NativeNode {
	const stillSpinners = !spinnerAnimated();
	const noEffects = !motionEffectsEnabled();
	if (!stillSpinners && !noEffects) return node;
	const hit = cache.get(node);
	if (hit) return hit;
	const out = quiet(node, stillSpinners, noEffects);
	cache.set(node, out);
	return out;
}

function quiet(node: NativeNode, stillSpinners: boolean, noEffects: boolean): NativeNode {
	const props = node.p as Readonly<Record<string, unknown>> | undefined;
	const quietProps = noEffects && props ? (withoutEffects(props) as Readonly<Record<string, unknown>>) : props;
	const children = node.c ? quietChildren(node.c, stillSpinners, noEffects) : undefined;
	if (stillSpinners && node.k === "spinner") return stillSpinner(node, quietProps);
	if (quietProps === props && children === node.c) return node;
	return { ...node, p: quietProps, c: children } as NativeNode;
}

function quietChildren(
	children: readonly NativeChild[],
	stillSpinners: boolean,
	noEffects: boolean,
): readonly NativeChild[] {
	let out: NativeChild[] | undefined;
	for (let i = 0; i < children.length; i++) {
		const child = children[i]!;
		// Components are described (and stilled) on their own when the reconciler resolves them.
		if (typeof (child as { render?: unknown }).render === "function") continue;
		const next = quiet(child as NativeNode, stillSpinners, noEffects);
		if (next !== child) (out ??= children.slice())[i] = next;
	}
	return out ?? children;
}

/** A `spinner` as the static text it would show at frame 0: glyph, then its label, under its common props. */
function stillSpinner(node: NativeNode, props: Readonly<Record<string, unknown>> | undefined): NativeNode {
	const { style: _style, label, ...common } = (props ?? {}) as TspSpinnerProps & { label?: TspText };
	const spans: TspSpan[] = [{ t: STATIC_SPINNER_GLYPH }];
	if (typeof label === "string") {
		if (label.length > 0) spans.push({ t: ` ${label}` });
	} else if (label && label.length > 0) {
		spans.push({ t: " " }, ...label);
	}
	return { ...node, k: "text", p: { ...common, spans }, c: undefined } as unknown as NativeNode;
}

/**
 * `value` with `fx` removed from every plain object carrying one — spans in any `TspText`, editor
 * decorations, whatever a future prop nests — walking arrays and plain objects alike. Copy-on-write:
 * the same reference comes back when nothing below it had an effect.
 */
function withoutEffects(value: unknown): unknown {
	if (Array.isArray(value)) {
		let out: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const next = withoutEffects(value[i]);
			if (next !== value[i]) (out ??= value.slice())[i] = next;
		}
		return out ?? value;
	}
	if (!isPlainObject(value)) return value;
	let out: Record<string, unknown> | undefined;
	for (const key in value) {
		if (key === "fx") {
			out ??= { ...value };
			delete out.fx;
			continue;
		}
		const next = withoutEffects(value[key]);
		if (next !== value[key]) (out ??= { ...value })[key] = next;
	}
	return out ?? value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
