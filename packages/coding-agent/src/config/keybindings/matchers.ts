/**
 * Actions that must stay reachable by keyboard even when the user unbinds
 * them: each falls back to a fixed chord when its binding is empty.
 */
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import type { Keybinding } from "./app-keybindings";
import { canonicalKeyId, type KeyId } from "./key-id";
import { getKeybindings, type KeybindingsManager } from "./keybindings";

/** Keys approval and follow-up fall back to when unbound. */
const UNBOUND_SUBMIT_KEYS: readonly KeyId[] = ["ctrl+enter", "ctrl+q"];

/** Whether `event` presses one of `keys`. */
export function matchesAnyKey(event: KeyEvent, keys: readonly KeyId[]): boolean {
	if (event.kind === "release") return false;
	for (const key of keys) if (canonicalKeyId(key) === event.id) return true;
	return false;
}

/** Effective interrupt keys: `app.interrupt`, or Escape when unbound. */
export function appInterruptKeys(keybindings: KeybindingsManager = getKeybindings()): readonly KeyId[] {
	const keys = keybindings.keysFor("app.interrupt");
	return keys.length > 0 ? keys : ["escape"];
}

/** Effective tools-expand keys: `app.tools.expand`, or Ctrl+O when unbound. */
export function appToolsExpandKeys(keybindings: KeybindingsManager = getKeybindings()): readonly KeyId[] {
	const keys = keybindings.keysFor("app.tools.expand");
	return keys.length > 0 ? keys : ["ctrl+o"];
}

/** Effective external-editor keys: `app.editor.external`, or Ctrl+G when unbound. */
export function appExternalEditorKeys(keybindings: KeybindingsManager = getKeybindings()): readonly KeyId[] {
	const keys = keybindings.keysFor("app.editor.external");
	return keys.length > 0 ? keys : ["ctrl+g"];
}

/**
 * Effective follow-up keys (`app.message.followUp`, or Ctrl+Enter/Ctrl+Q when
 * unbound). Forms where Enter inserts a newline submit on these: the main
 * editor's follow-up, the agent dashboard's new-agent description, the hook
 * editor's hook-style mode.
 */
export function appFollowUpKeys(keybindings: KeybindingsManager = getKeybindings()): readonly KeyId[] {
	const keys = keybindings.keysFor("app.message.followUp");
	return keys.length > 0 ? keys : UNBOUND_SUBMIT_KEYS;
}

/** Effective tool-approval keys: `app.approval.approve`, or Ctrl+Enter/Ctrl+Q when unbound. */
export function appApproveKeys(keybindings: KeybindingsManager = getKeybindings()): readonly KeyId[] {
	const keys = keybindings.keysFor("app.approval.approve");
	return keys.length > 0 ? keys : UNBOUND_SUBMIT_KEYS;
}

/** Whether `event` (or a bare key id: a press) is an effective interrupt key ({@link appInterruptKeys}). */
export function matchesAppInterrupt(
	event: KeyEvent | string,
	keybindings: KeybindingsManager = getKeybindings(),
): boolean {
	if (typeof event === "string") return appInterruptKeys(keybindings).some(key => canonicalKeyId(key) === event);
	return matchesAnyKey(event, appInterruptKeys(keybindings));
}

/** Whether `event` (or a bare key id: a press) is a `tui.select.cancel` key (Escape and Ctrl+C by default). */
export function matchesSelectCancel(
	event: KeyEvent | string,
	keybindings: KeybindingsManager = getKeybindings(),
): boolean {
	if (typeof event === "string") return keybindings.matchesId(event, "tui.select.cancel");
	return keybindings.matches(event, "tui.select.cancel");
}

/** Selector actions and the key id each defaults to. */
const SELECT_IDS = [
	["tui.select.up", "up"],
	["tui.select.down", "down"],
	["tui.select.pageUp", "pageUp"],
	["tui.select.pageDown", "pageDown"],
	["tui.select.confirm", "enter"],
] as const satisfies readonly (readonly [Keybinding, string])[];

/**
 * `event`'s id (or a bare key id: a press) through the selector keymap, for screens that move their own
 * list cursor with a `switch` on key ids: a key bound to `tui.select.up`/
 * `down`/`pageUp`/`pageDown`/`confirm` reads as that action's default id
 * (`up`, `down`, `pageUp`, `pageDown`, `enter`); one of those ids whose key
 * the user moved elsewhere reads as `""`; any other key keeps its id.
 * Cancel stays with the screen ({@link matchesSelectCancel} or
 * {@link matchesAppInterrupt}).
 */
export function selectKeyId(event: KeyEvent | string, keybindings: KeybindingsManager = getKeybindings()): string {
	if (typeof event !== "string" && event.kind === "release") return "";
	const pressed = typeof event === "string" ? event : event.id;
	for (const [action, id] of SELECT_IDS) if (keybindings.matchesId(pressed, action)) return id;
	for (const [, id] of SELECT_IDS) if (pressed === id) return "";
	return pressed;
}

/**
 * {@link selectKeyId} plus cancel: a `tui.select.cancel` key reads as
 * `escape` (and an Escape the user moved off cancel as `""`), for screens
 * whose `switch` also closes on `escape`.
 */
export function listKeyId(event: KeyEvent | string, keybindings: KeybindingsManager = getKeybindings()): string {
	if (matchesSelectCancel(event, keybindings)) return "escape";
	const id = selectKeyId(event, keybindings);
	return id === "escape" ? "" : id;
}
