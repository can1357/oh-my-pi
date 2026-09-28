import {
	type AppKeybinding,
	formatKeyHint,
	formatKeyHints,
	type KeybindingsManager,
	keyHintPlatform,
} from "./app-keybindings";
import { canonicalKeyId } from "./keybindings";

/** Effective keybinding operations used to render the hotkey reference. */
export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString" | "getKeys" | "matchesCanonical">;
}

function hotkeyLabel(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

/** Build the platform-aware Markdown reference for effective application hotkeys. */
export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const isMac = keyHintPlatform() === "darwin";
	// CustomEditor tests the chord that was actually pressed, so exit keys split by role: a key
	// that also carries tui.editor.deleteCharForward (the readline `^D` overlap) forward-deletes
	// while the prompt holds a draft, any other exit key quits immediately. Mixed bindings such as
	// `["ctrl+d", "ctrl+q"]` therefore get one row per behavior instead of a single row claiming
	// both keys delete.
	const exitKeys = bindings.keybindings.getKeys("app.exit");
	const deletingExitKeys = exitKeys.filter(key =>
		bindings.keybindings.matchesCanonical(canonicalKeyId(key), "tui.editor.deleteCharForward"),
	);
	const quittingExitKeys = exitKeys.filter(
		key => !bindings.keybindings.matchesCanonical(canonicalKeyId(key), "tui.editor.deleteCharForward"),
	);
	const exitRows: string[] = [];
	if (deletingExitKeys.length > 0) {
		exitRows.push(
			`| \`${formatKeyHints(deletingExitKeys)}\` | Delete char forward (with draft) / exit (empty prompt) |`,
		);
	}
	// An unbound exit action still gets its row, mirroring the `Disabled` hint every other row uses.
	if (quittingExitKeys.length > 0 || deletingExitKeys.length === 0) {
		exitRows.push(`| \`${formatKeyHints(quittingExitKeys) || "Disabled"}\` | Exit |`);
	}
	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${formatKeyHints(["up", "down", "left", "right"])}\` | Move cursor / browse history (${formatKeyHint("up")} when empty) |`,
		`| \`${formatKeyHints(["alt+left", "alt+right"])}\` | Move by word |`,
		`| \`${formatKeyHints(isMac ? ["ctrl+a", "home", "super+left"] : ["ctrl+a", "home"])}\` | Start of line |`,
		`| \`${formatKeyHints(isMac ? ["ctrl+e", "end", "super+right"] : ["ctrl+e", "end"])}\` | End of line |`,
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${formatKeyHint("enter")}\` | Send message |`,
		`| \`${formatKeyHints(["shift+enter", "alt+enter"])}\` | New line |`,
		`| \`${formatKeyHints(["ctrl+w", "alt+backspace"])}\` | Delete word backwards |`,
		`| \`${formatKeyHint("ctrl+u")}\` | Delete to start of line |`,
		`| \`${formatKeyHint("ctrl+k")}\` | Delete to end of line |`,
		`| \`${hotkeyLabel(bindings, "app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${hotkeyLabel(bindings, "app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${formatKeyHint("tab")}\` | Path completion / accept autocomplete |`,
		`| \`${hotkeyLabel(bindings, "app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${hotkeyLabel(bindings, "app.clear")}\` | Clear editor (first) / exit (second) |`,
		...exitRows,
		`| \`${hotkeyLabel(bindings, "app.suspend")}\` | Suspend to background |`,
		`| \`${hotkeyLabel(bindings, "app.display.reset")}\` | Reset terminal display |`,
		`| \`${hotkeyLabel(bindings, "app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${hotkeyLabel(bindings, "app.model.cycleForward")}\` | Cycle role models (slow/default/smol) |`,
		`| \`${hotkeyLabel(bindings, "app.model.cycleBackward")}\` | Cycle role models (backward) |`,
		`| \`${hotkeyLabel(bindings, "app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${hotkeyLabel(bindings, "app.model.select")}\` | Select model (set roles) |`,
		`| \`${hotkeyLabel(bindings, "app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${hotkeyLabel(bindings, "app.history.search")}\` | Search prompt history |`,
		`| \`${hotkeyLabel(bindings, "app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${hotkeyLabel(bindings, "app.tools.toggleVisibility")}\` | Toggle tool activity visibility |`,
		`| \`${hotkeyLabel(bindings, "app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${hotkeyLabel(bindings, "app.editor.external")}\` | Edit message in external editor |`,
		`| \`${hotkeyLabel(bindings, "app.retry")}\` | Retry last failed assistant turn |`,
		`| \`${hotkeyLabel(bindings, "app.clipboard.pasteImage")}\` | Paste image or text from clipboard |`,
		`| Hold \`${formatKeyHint("space")}\` | Speech-to-text (push-to-talk): hold to record, release to transcribe |`,
		`| \`${hotkeyLabel(bindings, "app.live.toggle")}\` | Start/stop live voice mode (/live) |`,
		`| \`${hotkeyLabel(bindings, "app.agents.hub")}\` / \`${hotkeyLabel(bindings, "app.session.observe")}\` / double-tap \`${formatKeyHint("left")}\` (empty editor) | Open the agent hub |`,
		"| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |",
		"| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
