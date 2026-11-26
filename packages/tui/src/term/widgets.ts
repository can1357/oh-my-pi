/**
 * Widget behaviour: what a focusable kind does with keys, paste and mouse in
 * the terminal backend (what a Tern terminal does natively).
 *
 * A widget never mutates the program's state; it emits the UI events a Tern
 * terminal would send (an `editor` emits `edit`, a `list` emits `select`/
 * `activate`, a `button` emits `action`), and the program updates its props.
 * Purely visual state the protocol leaves to the terminal (a list's scroll
 * offset, an editor's preferred column) lives in {@link WidgetContext.state}.
 */
import { bubbleEvent, keypathOf } from "../dispatch";
import type { MouseEvent } from "../driver/contract";
import type { KeyEvent, PasteEvent, UiEvent } from "../events";
import type { UiKind, UiNode } from "../node";
import { type Signal, signal } from "../reactive";
import { byRole, type Cell, type Hit } from "./paint";

/** What a widget may do while handling input. */
export interface WidgetContext {
	/** Deliver a UI event from `node` (bubbles to the nearest handler, like a Tern event). */
	emit(event: UiEvent): void;
	/** Per-node visual state the terminal owns (scroll offsets, preferred columns); `init` runs once per node. */
	state<T>(name: string, init: () => T): Signal<T>;
	/** The node's keypath in its region (what events carry as `key`). */
	readonly keypath: string;
	/** Move keyboard focus (a widget passing focus on, a click into another field). */
	focus(node: UiNode | null): void;
	/** Rows of the screen the widget can use for paging. */
	readonly pageRows: number;
}

/** A focusable kind's input behaviour. Each returns true when it consumed the input. */
export interface Widget {
	key?(node: UiNode, key: KeyEvent, cx: WidgetContext): boolean;
	paste?(node: UiNode, paste: PasteEvent, cx: WidgetContext): boolean;
	/** A mouse event inside the node's block, in block coordinates. */
	/** `at` is relative to the hit rect; `hit` names the item (tab, row, option) under the pointer. */
	mouse?(node: UiNode, mouse: MouseEvent, at: Cell, cx: WidgetContext, hit: Hit): boolean;
}

const widgets = new Map<UiKind, Widget>();

/** Register the input behaviour of a kind. */
export function defineWidget(kind: UiKind, widget: Widget): void {
	widgets.set(kind, widget);
}

const roleWidgets = new Map<string, Widget>();

/**
 * Register the input behaviour of `kind` nodes whose role (wire `role`, else
 * `term.role`) is `role`, or starts with `role.` when `prefix` is set: the
 * input side of a role painter.
 */
export function defineRoleWidget(kind: UiKind, role: string, widget: Widget, options?: { prefix?: boolean }): void {
	roleWidgets.set(`${kind}|${role}${options?.prefix ? ".*" : ""}`, widget);
}

/** The input behaviour of `node` (its role's, else its kind's), if it is focusable or clickable. */
export function widgetFor(node: UiNode): Widget | undefined {
	return byRole(roleWidgets, node) ?? widgets.get(node.kind);
}

const kState = Symbol("pi-tui.term.widget-state");

interface StateHolder {
	[kState]?: Map<string, Signal<unknown>>;
}

/** The per-node widget state map (created on demand). */
export function widgetState(node: UiNode): Map<string, Signal<unknown>> {
	const holder = node as StateHolder;
	return (holder[kState] ??= new Map());
}

/**
 * The context a widget runs in for the node at the end of `path` (a focus or
 * hit path from a region root). Both backends build it: the terminal one for
 * the keys, pastes and clicks it paints, the native one for the keys and
 * pastes a terminal forwards raw (Tern leaves an `editor` to the program).
 */
export function widgetContext(
	path: readonly UiNode[],
	host: { focus(node: UiNode | null): void; readonly pageRows: number },
): WidgetContext {
	const node = path[path.length - 1]!;
	return {
		emit: event => {
			bubbleEvent(path, event);
		},
		state: <T>(name: string, init: () => T): Signal<T> => {
			const map = widgetState(node);
			let value = map.get(name) as Signal<T> | undefined;
			if (!value) {
				value = signal(init());
				map.set(name, value as Signal<unknown>);
			}
			return value;
		},
		keypath: keypathOf(path),
		focus: next => host.focus(next),
		pageRows: host.pageRows,
	};
}
