/**
 * Icon glyph normalization for native frames.
 *
 * Components style icons as Private Use Area codepoints (Nerd Font glyphs)
 * baked into text with a padding space, e.g. `{t:"<glyph> Model", s:"statusLineModel"}`.
 * The terminal draws icons and spaces them itself, so every PUA run becomes
 * its own span carrying the `icon` token next to the original tokens (colour
 * survives), and the single space that padded it from the neighbouring text
 * is dropped. Applied once, centrally, to every `TspText` field of a node's
 * props before they go on the wire.
 */
import type { TspKind, TspSpan, TspText } from "@oh-my-pi/pi-wire";

const PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
const PUA_RUNS = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+/gu;

/** `TspText` props per kind (besides the structured ones handled below). */
const TEXT_FIELDS: Partial<Record<TspKind, readonly string[]>> = {
	text: ["spans"],
	shimmer: ["spans"],
	seg: ["spans"],
	card: ["head"],
	section: ["head"],
	overlay: ["head"],
	rule: ["label"],
	spinner: ["label"],
	progress: ["label"],
	list: ["empty"],
	item: ["label", "detail", "value"],
	editor: ["prompt"],
	input: ["prompt"],
};

function withIcon(s: string | undefined): string {
	if (s === undefined || s.length === 0) return "icon";
	return s.split(" ").includes("icon") ? s : `${s} icon`;
}

/** Spans with every PUA run split into an `icon` span; the same array when there is none. */
export function normalizeIconSpans(spans: readonly TspSpan[]): readonly TspSpan[] {
	let found = false;
	for (const span of spans) {
		if (PUA.test(span.t)) {
			found = true;
			break;
		}
	}
	if (!found) return spans;
	const pieces: { span: TspSpan; icon: boolean }[] = [];
	for (const span of spans) {
		let at = 0;
		for (const match of span.t.matchAll(PUA_RUNS)) {
			if (match.index > at) pieces.push({ span: { ...span, t: span.t.slice(at, match.index) }, icon: false });
			pieces.push({ span: { ...span, t: match[0], s: withIcon(span.s) }, icon: true });
			at = match.index + match[0].length;
		}
		if (at < span.t.length) pieces.push({ span: at === 0 ? span : { ...span, t: span.t.slice(at) }, icon: false });
	}
	// The terminal spaces icons itself: drop the one space on each side that padded them.
	for (let i = 0; i < pieces.length; i++) {
		if (!pieces[i]!.icon) continue;
		const prev = pieces[i - 1];
		if (prev && !prev.icon && prev.span.t.endsWith(" ")) prev.span = { ...prev.span, t: prev.span.t.slice(0, -1) };
		const next = pieces[i + 1];
		if (next && !next.icon && next.span.t.startsWith(" ")) next.span = { ...next.span, t: next.span.t.slice(1) };
	}
	const out: TspSpan[] = [];
	for (const piece of pieces) if (piece.span.t.length > 0) out.push(piece.span);
	return out;
}

/** A `TspText` with icons normalized; plain strings with icons become spans. */
export function normalizeIconText(text: TspText): TspText {
	if (typeof text === "string") return PUA.test(text) ? normalizeIconSpans([{ t: text }]) : text;
	return normalizeIconSpans(text);
}

function isText(value: unknown): value is TspText {
	return typeof value === "string" || Array.isArray(value);
}

/** Map `fn` over `items`, returning the same array when nothing changed. */
function mapSame<T>(items: readonly T[], fn: (item: T) => T): readonly T[] {
	let out: T[] | undefined;
	for (let i = 0; i < items.length; i++) {
		const next = fn(items[i]!);
		if (next !== items[i] && !out) out = items.slice(0, i);
		out?.push(next);
	}
	return out ?? items;
}

interface TreeNodeLike {
	label?: unknown;
	children?: readonly TreeNodeLike[];
}

function normalizeTree(node: TreeNodeLike): TreeNodeLike {
	const label = isText(node.label) ? normalizeIconText(node.label) : node.label;
	const children = node.children ? mapSame(node.children, normalizeTree) : node.children;
	return label === node.label && children === node.children ? node : { ...node, label, children };
}

/** Props with every `TspText` field's icons normalized; the same object when nothing changed. */
export function normalizeIconProps(
	kind: TspKind,
	props: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
	if (!props) return props;
	let out: Record<string, unknown> | undefined;
	const put = (key: string, value: unknown): void => {
		if (value === props[key]) return;
		out ??= { ...props };
		out[key] = value;
	};
	// A plain `text` label holding an icon becomes spans.
	if ((kind === "text" || kind === "shimmer") && typeof props.text === "string" && PUA.test(props.text)) {
		put("text", undefined);
		put("spans", normalizeIconSpans([{ t: props.text }]));
	}
	for (const key of TEXT_FIELDS[kind] ?? []) {
		const value = (out ?? props)[key];
		if (isText(value)) put(key, normalizeIconText(value));
	}
	switch (kind) {
		case "tabs":
		case "kv": {
			const items = props.items;
			if (!Array.isArray(items)) break;
			put(
				"items",
				mapSame(items as readonly Record<string, unknown>[], item => {
					let next = item;
					for (const field of kind === "tabs" ? ["label"] : ["k", "v"]) {
						const value = item[field];
						if (!isText(value)) continue;
						const normalized = normalizeIconText(value);
						if (normalized !== value) next = { ...next, [field]: normalized };
					}
					return next;
				}),
			);
			break;
		}
		case "table": {
			const cols = props.cols;
			if (Array.isArray(cols)) {
				put(
					"cols",
					mapSame(cols as readonly Record<string, unknown>[], col => {
						if (!isText(col.head)) return col;
						const head = normalizeIconText(col.head);
						return head === col.head ? col : { ...col, head };
					}),
				);
			}
			const rows = props.rows;
			if (Array.isArray(rows)) {
				put(
					"rows",
					mapSame(rows as readonly { cells?: Record<string, unknown> }[], row => {
						const cells = row.cells;
						if (!cells) return row;
						let nextCells: Record<string, unknown> | undefined;
						for (const col in cells) {
							const value = cells[col];
							if (!isText(value)) continue;
							const normalized = normalizeIconText(value);
							if (normalized !== value) (nextCells ??= { ...cells })[col] = normalized;
						}
						return nextCells ? { ...row, cells: nextCells } : row;
					}),
				);
			}
			break;
		}
		case "tree": {
			const nodes = props.nodes;
			if (Array.isArray(nodes)) put("nodes", mapSame(nodes as readonly TreeNodeLike[], normalizeTree));
			break;
		}
	}
	return out ?? props;
}
