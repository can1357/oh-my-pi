import { canonicalKeyId } from "@oh-my-pi/pi-tui";
import {
	type AppKeybinding,
	formatKeyHints,
	type KeybindingsManager,
	keyHintPlatform,
	modifierLabel,
} from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString" | "getKeys" | "matchesCanonical">;
}

function appKey(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const platform = keyHintPlatform();
	const isMac = platform === "darwin";
	const alt = modifierLabel("alt", platform);
	const cmd = modifierLabel("super", platform);
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
		"| `Arrow keys` | Move cursor / browse history (Up when empty) |",
		`| \`${alt}+Left/Right\` | Move by word |`,
		isMac ? `| \`Ctrl+A\` / \`Home\` / \`${cmd}+Left\` | Start of line |` : "| `Ctrl+A` / `Home` | Start of line |",
		isMac ? `| \`Ctrl+E\` / \`End\` / \`${cmd}+Right\` | End of line |` : "| `Ctrl+E` / `End` | End of line |",
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Enter` | Send message |",
		`| \`Shift+Enter\` / \`${alt}+Enter\` | New line |`,
		`| \`Ctrl+W\` / \`${alt}+Backspace\` | Delete word backwards |`,
		"| `Ctrl+U` | Delete to start of line |",
		"| `Ctrl+K` | Delete to end of line |",
		`| \`${appKey(bindings, "app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${appKey(bindings, "app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Tab` | Path completion / accept autocomplete |",
		`| \`${appKey(bindings, "app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${appKey(bindings, "app.clear")}\` | Clear editor (first) / exit (second) |`,
		...exitRows,
		`| \`${appKey(bindings, "app.suspend")}\` | Suspend to background |`,
		`| \`${appKey(bindings, "app.display.reset")}\` | Reset terminal display |`,
		`| \`${appKey(bindings, "app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${appKey(bindings, "app.model.cycleForward")}\` | Cycle role models (slow/default/smol) |`,
		`| \`${appKey(bindings, "app.model.cycleBackward")}\` | Cycle role models (backward) |`,
		`| \`${appKey(bindings, "app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${appKey(bindings, "app.model.select")}\` | Select model (set roles) |`,
		`| \`${appKey(bindings, "app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${appKey(bindings, "app.history.search")}\` | Search prompt history |`,
		`| \`${appKey(bindings, "app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${appKey(bindings, "app.tools.toggleVisibility")}\` | Toggle tool activity visibility |`,
		`| \`${appKey(bindings, "app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${appKey(bindings, "app.editor.external")}\` | Edit message in external editor |`,
		`| \`${appKey(bindings, "app.retry")}\` | Retry last failed assistant turn |`,
		`| \`${appKey(bindings, "app.clipboard.pasteImage")}\` | Paste image or text from clipboard |`,
		"| Hold `Space` | Speech-to-text (push-to-talk): hold to record, release to transcribe |",
		`| \`${appKey(bindings, "app.live.toggle")}\` | Start/stop live voice mode (/live) |`,
		`| \`${appKey(bindings, "app.agents.hub")}\` / \`${appKey(bindings, "app.session.observe")}\` / double-tap \`←\` (empty editor) | Open the agent hub |`,
		"| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |",
		"| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
