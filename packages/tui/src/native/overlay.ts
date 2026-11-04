/**
 * Overlay chrome for `describe()`: root cards, key-hint footers, buttons and
 * segmented controls, selectable lists and annotation callouts.
 *
 * The overlay frame itself (glass, ring, placement) is the terminal's: the
 * engine wraps every overlay-stack component in an `overlay` node. An overlay
 * component's root is a `card` whose `head` carries the title.
 */
import type { TspProps, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { formatTooltipKey, type KeyName } from "../key-hint-format";
import { getKeybindings, type Keybinding } from "../keybindings";
import { card, kbd, keyNames, list, node, row, span, text } from "./describe";
import type { NativeChild, NativeNode } from "./node";
import { nativeButtons } from "./state";

/** Below this many columns a centered sheet fills the pane instead of floating with margins. */
export const NARROW_SHEET_COLS = 100;

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
	/** Why the action can't run now: the button dims and a click sends nothing. */
	readonly disabled?: string;
	/** The button's work is running: a spinner leads the label. */
	readonly busy?: boolean;
	/** Icon beside the label (before it on a `button` node, after it on a row). */
	readonly icon?: string;
}

/**
 * A native button (role `omp.btn`): a label plus an optional keycap. A click
 * sends `act` back as an `action` event (or runs a terminal-local `open`/`copy`),
 * which the component routes to the same code path as the key.
 *
 * A terminal that draws the `button` kind ({@link nativeButtons}) gets one
 * (tone `accent` → variant `primary`, `error` → `danger`, `disabled` with its
 * reason as the tooltip); older ones get the row their stylesheets draw by
 * role. Both keep the role and tone the omp sheets' context rules key on; a
 * disabled button's tone is `muted`.
 */
export function actionButton(label: string, act: string, options: ActionButtonOptions = {}): NativeNode {
	const { keys, href, disabled, busy, icon } = options;
	const title = options.title ?? (keys ? `${label}  ${formatTooltipKey(keys)}` : label);
	const tone = disabled === undefined ? options.tone : "muted";
	const key = options.key ?? act;
	if (nativeButtons()) {
		return node(
			"button",
			{
				role: "omp.btn",
				text: label,
				actions: { click: act },
				title,
				...(keys ? { keys: keyNames(keys) } : {}),
				...(icon ? { icon } : {}),
				...(tone === "accent" ? { variant: "primary" } : tone === "error" ? { variant: "danger" } : {}),
				...(tone ? { tone } : {}),
				...(disabled !== undefined ? { disabled: disabled || true } : {}),
				...(busy ? { busy } : {}),
				...(href ? { href } : {}),
			},
			undefined,
			key,
		);
	}
	const children: NativeChild[] = [];
	if (busy) children.push(node("spinner", { style: "dots" }));
	children.push(text(label));
	if (icon) children.push(node("icon", { name: icon }, undefined, "icon"));
	if (keys) children.push(kbd(keys));
	return node(
		"row",
		{
			role: "omp.btn",
			gap: "xs",
			align: "center",
			...(disabled === undefined ? { actions: { click: act } } : {}),
			title,
			...(tone ? { tone } : {}),
			...(href ? { href } : {}),
		},
		children,
		key,
	);
}

/**
 * A bare `esc` keycap button for a view's top-right corner: a click sends
 * `act` (default `close`), which the component routes to its Esc path.
 */
export function escCloseButton(act = "close", key = "esc-close"): NativeNode {
	const title = `Close  ${formatTooltipKey("escape")}`;
	if (nativeButtons()) {
		return node(
			"button",
			{ role: "omp.btn", keys: ["escape"], actions: { click: act }, title, aria: "Close" },
			undefined,
			key,
		);
	}
	return node("row", { role: "omp.btn", align: "center", actions: { click: act }, title }, [kbd("escape")], key);
}

/** Options of an {@link iconButton}. */
export interface IconButtonOptions {
	/** Sibling identity key; unkeyed buttons take their position. */
	readonly key?: string;
	/** Accessible name; defaults to the title. */
	readonly aria?: string;
	/** A toggle that is on (role `omp.app.ibtn.set`). */
	readonly on?: boolean;
}

/**
 * A quiet icon-only button (role `omp.app.ibtn`, the kit's icon button) for an
 * app head or toolbar: a `button` node where the terminal draws one
 * ({@link nativeButtons}), else an `icon` with a click action.
 */
export function iconButton(name: string, act: string, title: string, options: IconButtonOptions = {}): NativeNode {
	const role = options.on ? "omp.app.ibtn.set" : "omp.app.ibtn";
	const aria = options.aria ?? title;
	if (nativeButtons()) {
		return node(
			"button",
			{
				role,
				variant: "quiet",
				icon: name,
				title,
				aria,
				actions: { click: act },
				...(options.on ? { on: true } : {}),
			},
			undefined,
			options.key,
		);
	}
	return node("icon", { name, role, title, aria, actions: { click: act } }, undefined, options.key);
}

/**
 * A quiet text button (role `omp.app.qbtn`, the kit's quiet button) for a
 * section head or toolbar, keyed by its action: a small quiet `button` where
 * the terminal draws one ({@link nativeButtons}), else a row.
 */
export function quietButton(label: string, act: string, title: string): NativeNode {
	if (nativeButtons()) {
		return node(
			"button",
			{ role: "omp.app.qbtn", variant: "quiet", size: "sm", text: label, actions: { click: act }, title },
			undefined,
			act,
		);
	}
	return node("row", { role: "omp.app.qbtn", actions: { click: act }, title }, [text(label)], act);
}

/**
 * A segmented control: `tabs` drawn as a well with a raised thumb on the
 * active tab. A terminal that draws the `button` kind ({@link nativeButtons})
 * draws `variant: "segmented"` too; older ones restyle the tabs by role
 * (`omp.app.seg`) or parent.
 */
export function segmentedTabs(p: TspProps<"tabs">, key: string): NativeNode {
	return node("tabs", nativeButtons() ? { ...p, variant: "segmented" } : p, undefined, key);
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
