/**
 * Overlay chrome for `describe()`: root cards, key-hint footers, selectable
 * lists and annotation callouts.
 *
 * The overlay frame itself (glass, ring, placement) is the terminal's: the
 * engine wraps every overlay-stack component in an `overlay` node. An overlay
 * component's root is a `card` whose `head` carries the title.
 */
import type { TspProps, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { formatTooltipKey, type KeyName } from "../key-hint-format";
import { getKeybindings, type Keybinding } from "../keybindings";
import { card, kbd, list, node, row, span, text } from "./describe";
import type { NativeChild, NativeNode } from "./node";

/** One footer hint: the keys that trigger it and what it does. */
export interface NativeHint {
	/** Key ids (`"ctrl+o"`, `"escape"`); alternatives render side by side. */
	readonly keys: readonly KeyName[];
	readonly label: string;
}

/**
 * A hint for the primary keys of one or more keybinding actions
 * (`actionHint(["tui.select.up", "tui.select.down"], "navigate")`);
 * `undefined` when every action is unbound.
 */
export function actionHint(actions: Keybinding | readonly Keybinding[], label: string): NativeHint | undefined {
	const keys: KeyName[] = [];
	const bindings = getKeybindings();
	for (const action of typeof actions === "string" ? [actions] : actions) {
		const [key] = bindings.getKeys(action);
		if (key) keys.push(key);
	}
	return keys.length > 0 ? { keys, label } : undefined;
}

/**
 * A wrapping row of `kbd` keycaps with muted labels: the footer hint strip of
 * a selector. `undefined` entries (unbound actions) are skipped. Build it once
 * per hint-set change and reuse the node (memoization contract).
 */
export function hintsRow(hints: readonly (NativeHint | undefined)[], key = "hints"): NativeNode {
	const children: NativeChild[] = [];
	for (const hint of hints) {
		if (!hint) continue;
		const group: NativeChild[] = hint.keys.map(k => kbd(k));
		group.push(text([span(hint.label, "muted")]));
		children.push(row(group, { gap: "xs", align: "center" }));
	}
	return node("row", { gap: "md", wrap: true, role: "omp.overlay.hints" }, children, key);
}

/** A wrapping footer: a status line (`✓ Clean`, `⚠ Cancelled`) followed by key hints. */
export function statusHintsRow(status: TspText, hints: readonly (NativeHint | undefined)[]): NativeNode {
	return row([text(status), hintsRow(hints)], { gap: "md", wrap: true, align: "center" });
}

/**
 * Root card of an overlay. `head` is the overlay title (whitespace runs
 * collapse; empty means no head); `role` is `omp.overlay.<name>`.
 */
export function overlayCard(
	role: string,
	head: TspText | undefined,
	children: readonly NativeChild[],
	props?: Omit<TspProps<"card">, "head" | "role">,
): NativeNode {
	const title = typeof head === "string" ? head.replace(/\s+/g, " ").trim() : head;
	return card({ ...props, role, head: title === "" ? undefined : title }, children);
}

/** A selectable list: click selects, double-click activates. */
export function selectList(key: string, items: readonly NativeChild[], p: TspProps<"list">): NativeNode {
	return list(items, { ...p, actions: { click: "select", dblclick: "activate" } }, key);
}

/** The index encoded in an item key built as `<prefix><index>`, or -1 when it isn't one. */
export function itemIndex(item: string, prefix: string): number {
	if (!item.startsWith(prefix)) return -1;
	const index = Number(item.slice(prefix.length));
	return Number.isInteger(index) && index >= 0 ? index : -1;
}

/** Options of an {@link actionButton}. */
export interface ActionButtonOptions {
	/** Sibling identity key (defaults to the action id); `leafKey(event.key)` reports it back. */
	readonly key?: string;
	/** Key id of the keyboard path the button mirrors, drawn as a keycap inside it (`"r"`, `"ctrl+g"`). */
	readonly keys?: KeyName;
	/** `accent` = the view's hero action, `error` = destructive. */
	readonly tone?: "accent" | "error";
	/** Tooltip; defaults to the label plus the keycap (`"Refresh  r"`, see {@link formatTooltipKey}). */
	readonly title?: string;
	/** Target of an `open` action (URL or `file://` path). */
	readonly href?: string;
}

/**
 * A native button (role `omp.btn`): a label plus an optional keycap. A click
 * sends `act` back as an `action` event (or runs a terminal-local `open`/`copy`),
 * which the component routes to the same code path as the key.
 */
export function actionButton(label: string, act: string, options: ActionButtonOptions = {}): NativeNode {
	const children: NativeChild[] = [text(label)];
	if (options.keys) children.push(kbd(options.keys));
	return node(
		"row",
		{
			role: "omp.btn",
			gap: "xs",
			align: "center",
			actions: { click: act },
			title: options.title ?? (options.keys ? `${label}  ${formatTooltipKey(options.keys)}` : label),
			...(options.tone ? { tone: options.tone } : {}),
			...(options.href ? { href: options.href } : {}),
		},
		children,
		options.key ?? act,
	);
}

/** A row of {@link actionButton}s (role `omp.actions`); `null` entries become the spacer that end-aligns what follows. */
export function actionBar(buttons: readonly (NativeNode | null)[], key = "actions"): NativeNode {
	const children = buttons.map(button => button ?? node("spacer", { grow: 1 }));
	return node("row", { role: "omp.actions", gap: "sm", align: "center" }, children, key);
}

/** Spans of an annotation callout: a dim `label:` then the note. */
export function noteSpans(label: string, note: string): TspSpan[] {
	return [span(`${label}: `, "dim"), span(note, "accent")];
}
