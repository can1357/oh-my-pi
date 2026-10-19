import type { KeyId } from "./app-keybindings";
import { getKeybindings } from "./keybindings";
import { matchesKey } from "./keys";

/**
 * Match the coding-agent interrupt key.
 *
 * Interactive mode installs a keybinding manager that exposes `app.interrupt`
 * globally, but some isolated component tests still run with only TUI
 * keybindings registered. In that case, fall back to raw Escape matching.
 */
export function matchesAppInterrupt(data: string): boolean {
	const keybindings = getKeybindings();
	const interruptKeys = keybindings.getKeys("app.interrupt");
	if (interruptKeys.length > 0) {
		return keybindings.matches(data, "app.interrupt");
	}
	return matchesKey(data, "escape") || matchesKey(data, "esc");
}

/** Match `app.tools.expand`, falling back to Ctrl+O when the action is unbound. */
export function matchesAppToolsExpand(data: string): boolean {
	const keybindings = getKeybindings();
	const expandKeys = keybindings.getKeys("app.tools.expand");
	if (expandKeys.length > 0) {
		return keybindings.matches(data, "app.tools.expand");
	}
	return matchesKey(data, "ctrl+o");
}

/** Effective tools-expand key: the first bound key, or Ctrl+O when unbound. */
export function appToolsExpandKey(): KeyId {
	return getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
}

/** Match the generic selector cancel keybinding. */
export function matchesSelectCancel(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

/** Match the generic selector up-navigation keybinding. */
export function matchesSelectUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.up");
}

/** Match the generic selector down-navigation keybinding. */
export function matchesSelectDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.down");
}

/** Match the generic selector page-up keybinding. */
export function matchesSelectPageUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageUp");
}

/** Match the generic selector page-down keybinding. */
export function matchesSelectPageDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageDown");
}

/** Effective external-editor key: the first bound key, or Ctrl+G when unbound. */
export function appExternalEditorKey(): KeyId {
	return getKeybindings().getKeys("app.editor.external")[0] ?? "ctrl+g";
}

/** Match the external-editor keybinding, falling back to Ctrl+G when unbound. */
export function matchesAppExternalEditor(data: string): boolean {
	const keybindings = getKeybindings();
	if (keybindings.getKeys("app.editor.external").length > 0) {
		return keybindings.matches(data, "app.editor.external");
	}
	return matchesKey(data, "ctrl+g");
}

function matchesEffectiveKey(data: string, key: KeyId): boolean {
	if ((key === "ctrl+enter" || key === "ctrl+return") && data.charCodeAt(0) === 10 && data.length > 1) {
		return true;
	}
	return matchesKey(data, key);
}

function matchesEffectiveKeys(data: string, keys: readonly KeyId[]): boolean {
	for (const key of keys) {
		if (matchesEffectiveKey(data, key)) return true;
	}
	return false;
}

/**
 * Match the "submit multi-line text input" keybinding (`app.message.followUp`).
 *
 * Used by forms where plain Enter inserts a newline and a modified-Enter chord
 * submits — the main editor's follow-up handler, the agent dashboard's new-agent
 * description, and the hook editor's hook-style mode. The keybinding defaults to
 * `["ctrl+q", "ctrl+enter"]` so Windows Terminal (which can't deliver a distinct
 * Ctrl+Enter event; #1903) still has a working chord without user remapping.
 *
 * Also recognizes modifier-tagged LF as Ctrl+Enter only when Ctrl+Enter is an
 * effective follow-up binding.
 */
export function matchesAppFollowUp(data: string): boolean {
	const keybindings = getKeybindings();
	const keys = keybindings.getKeys("app.message.followUp");
	if (keys.length > 0) {
		return matchesEffectiveKeys(data, keys);
	}
	return matchesEffectiveKeys(data, ["ctrl+enter", "ctrl+q"]);
}

/** Approve-key defaults when `app.approval.approve` is unbound: approval must stay reachable by keyboard. */
const APPROVE_DEFAULT_KEYS: readonly KeyId[] = ["ctrl+enter", "ctrl+q"];

/** Effective tool-approval keys: the `app.approval.approve` bindings, or Ctrl+Enter/Ctrl+Q when unbound. */
export function appApproveKeys(): readonly KeyId[] {
	const keys = getKeybindings().getKeys("app.approval.approve");
	return keys.length > 0 ? keys : APPROVE_DEFAULT_KEYS;
}

/** Match the tool-approval key, recognizing modifier-tagged LF as Ctrl+Enter like {@link matchesAppFollowUp}. */
export function matchesAppApprove(data: string): boolean {
	return matchesEffectiveKeys(data, appApproveKeys());
}
