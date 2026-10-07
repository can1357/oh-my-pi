import type { TspProps, TspText } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "./node";

// Descriptions are immutable. Retaining their identity also keeps unchanged
// reduced-motion subtrees cheap to reconcile, including memoized descriptions.
const frozenNodes = new WeakMap<NativeNode, NativeNode>();

/** Remove terminal-clocked span/decorations effects, preserving unchanged prop bags. */
function freezeEffects(value: unknown): unknown {
	if (Array.isArray(value)) {
		const next = value.map(freezeEffects);
		return next.some((item, i) => item !== value[i]) ? next : value;
	}
	if (value === null || typeof value !== "object") return value;
	let next: Record<string, unknown> | undefined;
	for (const [key, item] of Object.entries(value)) {
		const frozen = key === "fx" && (item === "shimmer" || item === "pulse") ? "none" : freezeEffects(item);
		if (frozen === item) continue;
		next ??= { ...value };
		next[key] = frozen;
	}
	return next ?? value;
}

function indicator(label: TspText | undefined): Pick<TspProps<"text">, "text" | "spans"> {
	return typeof label === "string" || label === undefined
		? { text: label ? `… ${label}` : "…" }
		: { spans: [{ t: "… " }, ...label] };
}

/** Freeze cosmetic native motion while retaining live data, counters, actions and keys. */
export function reduceNativeMotion(source: NativeNode): NativeNode {
	const cached = frozenNodes.get(source);
	if (cached) return cached;
	let described = source;
	if (source.k === "spinner") {
		const { style: _style, label, ...props } = source.p ?? {};
		described = { ...source, k: "text", p: { ...props, ...indicator(label) } };
	} else if (source.k === "shimmer") {
		const { mode: _mode, palette: _palette, ...props } = source.p ?? {};
		described = { ...source, k: "text", p: props };
	} else if (source.k === "progress" && source.p?.value === null) {
		const { value: _value, label, ...props } = source.p;
		described = { ...source, k: "text", p: { ...props, ...indicator(label) } };
	}
	const props = freezeEffects(described.p) as TspProps | undefined;
	const children = described.c?.map((child): NativeChild => ("k" in child ? reduceNativeMotion(child) : child));
	if (props !== described.p || children?.some((child, i) => child !== described.c?.[i])) {
		described = { ...described, p: props, c: children } as NativeNode;
	}
	frozenNodes.set(source, described);
	return described;
}
