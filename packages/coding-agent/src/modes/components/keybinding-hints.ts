/**
 * Utilities for formatting keybinding hints in the UI.
 */
import { getKeybindings, type Keybinding } from "@oh-my-pi/pi-tui";
import { type AppKeybinding, formatKeyHints, type KeybindingsManager } from "../../config/keybindings";
import { theme } from "../../modes/theme/theme";

/**
 * Get display string for an editor action.
 */
export function editorKey(action: Keybinding): string {
	return formatKeyHints(getKeybindings().getKeys(action));
}

/**
 * Get display string for an app action.
 */
export function appKey(keybindings: KeybindingsManager, action: AppKeybinding): string {
	return formatKeyHints(keybindings.getKeys(action));
}

/**
 * Format a keybinding hint with consistent styling: dim key, muted description.
 * Looks up the key from editor keybindings automatically.
 *
 * @param action - Keybinding action name (e.g., "tui.select.confirm", "app.tools.expand")
 * @param description - Description text (e.g., "to expand", "cancel")
 * @returns Formatted string with dim key and muted description
 */
export function keyHint(action: Keybinding, description: string): string {
	return theme.fg("dim", editorKey(action)) + theme.fg("muted", ` ${description}`);
}

/**
 * Format a keybinding hint for app-level actions.
 * Requires the KeybindingsManager instance.
 *
 * @param keybindings - KeybindingsManager instance
 * @param action - App keybinding name (e.g., "app.interrupt", "app.editor.external")
 * @param description - Description text
 * @returns Formatted string with dim key and muted description
 */
export function appKeyHint(keybindings: KeybindingsManager, action: AppKeybinding, description: string): string {
	return theme.fg("dim", appKey(keybindings, action)) + theme.fg("muted", ` ${description}`);
}

/**
 * Format a raw key string with description (for non-configurable keys like ↑↓).
 *
 * @param key - Raw key string
 * @param description - Description text
 * @returns Formatted string with dim key and muted description
 */
export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}
