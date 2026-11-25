/**
 * The keys terminal widgets answer to, by action. pi-tui ships the native
 * defaults; a program that lets users rebind keys replaces them with
 * {@link setWidgetKeymap} (at startup and whenever its bindings reload), and
 * every widget (picker, prefs, menu, buttons, editor/input fields) reads its
 * keys from here instead of matching key ids itself.
 *
 * Keys are {@link KeyEvent} ids (`up`, `ctrl+p`, `alt+super+backspace`:
 * modifiers in `ctrl+alt+shift+super` order). Keys no action names stay
 * literal: Home/End jump to the ends of a list, Space toggles and presses,
 * ←/→ and Tab step tabs and button groups, Ctrl+Enter, Alt+Enter and a bare LF insert
 * a new line in an editor.
 */
import type { KeyEvent } from "../events";

/** Every rebindable widget action and its native keys. */
export const DEFAULT_WIDGET_KEYMAP = {
	/** Move a list's selection (picker, prefs, menu) one row up. */
	"select.up": ["up"],
	/** Move a list's selection one row down; also opens a closed menu. */
	"select.down": ["down"],
	/** Move a list's selection a page up (prefs: the previous section). */
	"select.pageUp": ["pageUp"],
	/** Move a list's selection a page down (prefs: the next section). */
	"select.pageDown": ["pageDown"],
	/** Activate the selection; a picker action bound to Enter runs on these too. */
	"select.confirm": ["enter"],
	/** Close (prefs, an open menu or prefs editor); a picker action bound to Escape runs on these too. */
	"select.cancel": ["escape"],
	"editor.selectAll": ["super+a"],
	"editor.cursorUp": ["up"],
	"editor.cursorDown": ["down"],
	"editor.cursorLeft": ["left", "ctrl+b"],
	"editor.cursorRight": ["right", "ctrl+f"],
	"editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
	"editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
	"editor.cursorLineStart": ["home", "ctrl+a"],
	"editor.cursorLineEnd": ["end", "ctrl+e"],
	"editor.pageUp": ["pageUp"],
	"editor.pageDown": ["pageDown"],
	"editor.deleteCharBackward": ["backspace"],
	"editor.deleteCharForward": ["delete", "ctrl+d"],
	"editor.deleteWordBackward": ["ctrl+w", "alt+backspace", "ctrl+backspace", "alt+super+backspace"],
	"editor.deleteWordForward": ["alt+delete", "alt+d", "ctrl+delete", "alt+super+delete", "alt+super+d"],
	"editor.deleteToLineStart": ["ctrl+u"],
	"editor.deleteToLineEnd": ["ctrl+k"],
	"editor.yank": ["ctrl+y"],
	"editor.yankPop": ["alt+y"],
	"editor.undo": ["ctrl+-", "ctrl+_"],
	/** Insert a new line in a multi-line editor (unhandled Ctrl+Enter, Alt+Enter and a bare LF also do). */
	"editor.newLine": ["shift+enter", "ctrl+j"],
} as const satisfies Record<string, readonly string[]>;

/** A rebindable widget action. */
export type WidgetAction = keyof typeof DEFAULT_WIDGET_KEYMAP;

/** Keys per action; an action left out keeps its default, an empty list unbinds it. */
export type WidgetKeymap = { readonly [A in WidgetAction]?: readonly string[] };

let keymap = new Map<WidgetAction, ReadonlySet<string>>();
let ordered = new Map<WidgetAction, readonly string[]>();

/**
 * Replace the widget keymap: each action takes its keys from `overrides`,
 * else its default. Call with no argument to restore the defaults.
 */
export function setWidgetKeymap(overrides: WidgetKeymap = {}): void {
	const next = new Map<WidgetAction, ReadonlySet<string>>();
	const lists = new Map<WidgetAction, readonly string[]>();
	for (const id in DEFAULT_WIDGET_KEYMAP) {
		const action = id as WidgetAction;
		const keys = [...(overrides[action] ?? DEFAULT_WIDGET_KEYMAP[action])];
		next.set(action, new Set(keys));
		lists.set(action, keys);
	}
	keymap = next;
	ordered = lists;
}

setWidgetKeymap();

/** The keys bound to `action`, primary first (for hints). */
export function widgetKeys(action: WidgetAction): readonly string[] {
	return ordered.get(action)!;
}

/** Whether `key` (a press or repeat; releases never match) is bound to `action`. */
export function widgetKeyMatches(key: KeyEvent, action: WidgetAction): boolean {
	return key.kind !== "release" && keymap.get(action)!.has(key.id);
}

/** Whether the key id `id` is bound to `action`. */
export function widgetKeyBound(id: string, action: WidgetAction): boolean {
	return keymap.get(action)!.has(id);
}

/** The first of `actions` whose keys hold `id`. */
export function widgetActionOf<A extends WidgetAction>(id: string, actions: readonly A[]): A | undefined {
	for (const action of actions) if (keymap.get(action)!.has(id)) return action;
	return undefined;
}
