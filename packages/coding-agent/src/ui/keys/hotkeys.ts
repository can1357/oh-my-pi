/**
 * The `/hotkeys` reference: the composer's fixed editing keys and every app
 * action with the keys the user's bindings give it, as markdown tables
 * (Navigation, Editing, Other). Unbound actions read `Disabled`.
 */
import type { Keybinding } from "../../config/keybindings/app-keybindings";
import { canonicalKeyId } from "../../config/keybindings/key-id";
import type { KeybindingsManager } from "../../config/keybindings/keybindings";
import { keyHintPlatform } from "@oh-my-pi/pi-tui/theme/keys";
import { formatKeyHint, formatKeyHints } from "./hints";

/** One piece of a shortcut cell: key alternatives (ids like `ctrl+r`; none: unbound), a typed token (`#<number>`), or prose. */
export type HotkeyPart = { readonly keys: readonly string[] } | { readonly token: string } | { readonly text: string };

/** One shortcut: its cell parts and what it does (backticks mark code). */
export interface HotkeyRow {
	readonly keys: readonly HotkeyPart[];
	readonly action: string;
}

/** A titled group of shortcuts. */
export interface HotkeyGroup {
	readonly title: string;
	readonly rows: readonly HotkeyRow[];
}

function cell(part: HotkeyPart): string {
	if ("text" in part) return part.text;
	if ("token" in part) return `\`${part.token}\``;
	return `\`${part.keys.length > 0 ? formatKeyHints(part.keys) : "Disabled"}\``;
}

/** The shortcut groups (Navigation, Editing, Other), built from the effective bindings. */
export function hotkeyGroups(keybindings: KeybindingsManager): HotkeyGroup[] {
	const isMac = keyHintPlatform() === "darwin";
	const act = (action: Keybinding): HotkeyPart => ({ keys: keybindings.keysFor(action) });
	const keys = (...ids: string[]): HotkeyPart => ({ keys: ids });
	// The composer tests the chord pressed: an exit key also bound to forward delete deletes while
	// the prompt holds a draft, any other exit key quits. Mixed bindings get one row per behavior.
	const deleteIds = new Set(keybindings.keysFor("tui.editor.deleteCharForward").map(canonicalKeyId));
	const exitKeys = keybindings.keysFor("app.exit");
	const deletingExitKeys = exitKeys.filter(key => deleteIds.has(canonicalKeyId(key)));
	const quittingExitKeys = exitKeys.filter(key => !deleteIds.has(canonicalKeyId(key)));
	const exitRows: HotkeyRow[] = [];
	if (deletingExitKeys.length > 0)
		exitRows.push({
			keys: [{ keys: deletingExitKeys }],
			action: "Delete char forward (with draft) / exit (empty prompt)",
		});
	if (quittingExitKeys.length > 0 || deletingExitKeys.length === 0)
		exitRows.push({ keys: [{ keys: quittingExitKeys }], action: "Exit" });
	const pushToTalk = keybindings.keysFor("app.stt.pushToTalk").length > 0;
	return [
		{
			title: "Navigation",
			rows: [
				{
					keys: [keys("up", "down", "left", "right")],
					action: `Move cursor / browse history (${formatKeyHint("up")} when empty)`,
				},
				{ keys: [keys("alt+left", "alt+right")], action: "Move by word" },
				{
					keys: [isMac ? keys("ctrl+a", "home", "super+left") : keys("ctrl+a", "home")],
					action: "Start of line",
				},
				{ keys: [isMac ? keys("ctrl+e", "end", "super+right") : keys("ctrl+e", "end")], action: "End of line" },
			],
		},
		{
			title: "Editing",
			rows: [
				{ keys: [keys("enter")], action: "Send message" },
				{ keys: [keys("shift+enter", "alt+enter")], action: "New line" },
				{ keys: [keys("ctrl+w", "alt+backspace")], action: "Delete word backwards" },
				{ keys: [keys("ctrl+u")], action: "Delete to start of line" },
				{ keys: [keys("ctrl+k")], action: "Delete to end of line" },
				{ keys: [act("app.clipboard.copyLine")], action: "Copy current line" },
				{ keys: [act("app.clipboard.copyPrompt")], action: "Copy whole prompt" },
			],
		},
		{
			title: "Other",
			rows: [
				{ keys: [keys("tab")], action: "Path completion / accept autocomplete" },
				{ keys: [act("app.interrupt")], action: "Cancel autocomplete / interrupt active work" },
				{ keys: [act("app.clear")], action: "Clear editor (first) / exit (second)" },
				...exitRows,
				{ keys: [act("app.suspend")], action: "Suspend to background" },
				{ keys: [act("app.display.reset")], action: "Reset terminal display" },
				{
					keys: [act("app.transcript.pageUp"), { text: " / " }, act("app.transcript.pageDown")],
					action: "Scroll the transcript a page (fullscreen screen)",
				},
				{
					keys: [act("app.transcript.top"), { text: " / " }, act("app.transcript.bottom")],
					action: "Transcript start / end and follow (fullscreen screen)",
				},
				{ keys: [act("app.transcript.search")], action: "Find text in the fullscreen transcript" },
				{ keys: [act("app.transcript.copySelection")], action: "Copy selected fullscreen transcript text" },
				{ keys: [act("app.thinking.cycle")], action: "Cycle thinking level" },
				{ keys: [act("app.model.cycleForward")], action: "Cycle role models (slow/default/smol)" },
				{ keys: [act("app.model.cycleBackward")], action: "Cycle role models (backward)" },
				{ keys: [act("app.model.selectTemporary")], action: "Select model (temporary)" },
				{ keys: [act("app.model.select")], action: "Select model (set roles)" },
				{ keys: [act("app.plan.toggle")], action: "Toggle plan mode" },
				{ keys: [act("app.history.search")], action: "Search prompt history" },
				{ keys: [act("app.tools.expand")], action: "Toggle tool output expansion" },
				{ keys: [act("app.tools.toggleVisibility")], action: "Cycle tool activity (detailed, concise, hidden)" },
				{
					keys: [act("app.links.hint")],
					action: "Pick an extension link on screen by its tag; press again to browse the whole transcript",
				},
				{ keys: [act("app.ask.hide")], action: "Hide/show a pending ask question" },
				{ keys: [act("app.ask.note")], action: "Add or edit a note on an ask option" },
				{ keys: [act("app.approval.approve")], action: "Approve a pending tool call" },
				{ keys: [act("app.thinking.toggle")], action: "Toggle thinking block visibility" },
				{ keys: [act("app.editor.external")], action: "Edit message in external editor" },
				{ keys: [act("app.local.open")], action: "Open a local:// file in external editor" },
				{ keys: [act("app.retry")], action: "Retry last failed assistant turn" },
				{ keys: [act("app.clipboard.pasteImage")], action: "Paste image or text from clipboard" },
				{
					keys: pushToTalk ? [{ text: "Hold " }, act("app.stt.pushToTalk")] : [act("app.stt.pushToTalk")],
					action: pushToTalk
						? "Speech-to-text (push-to-talk): hold to record, release to transcribe"
						: "Speech-to-text (push-to-talk) (disabled)",
				},
				{ keys: [act("app.live.toggle")], action: "Start/stop live voice mode (/live)" },
				{
					keys: [
						act("app.agents.hub"),
						{ text: " / " },
						act("app.session.observe"),
						{ text: " / double-tap " },
						keys("left"),
						{ text: " (empty editor)" },
					],
					action: "Open the agent hub",
				},
				{ keys: [{ token: "#<number>" }], action: "GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`)" },
				{
					keys: [{ token: "#" }, { text: " / " }, { token: "#<text>" }],
					action: "Prompt actions (copy / undo / move cursor)",
				},
				{ keys: [{ token: "/" }], action: "Slash commands" },
				{ keys: [{ token: "!" }], action: "Run bash command" },
				{ keys: [{ token: "!!" }], action: "Run bash command (excluded from context)" },
				{ keys: [{ token: "$" }], action: "Run Python in shared kernel" },
				{ keys: [{ token: "$$" }], action: "Run Python (excluded from context)" },
			],
		},
	];
}

/** The hotkey reference as markdown tables, platform- and binding-aware. */
export function buildHotkeysMarkdown(keybindings: KeybindingsManager): string {
	const lines: string[] = [];
	for (const [index, group] of hotkeyGroups(keybindings).entries()) {
		if (index > 0) lines.push("");
		lines.push(`**${group.title}**`, "| Key | Action |", "|-----|--------|");
		for (const row of group.rows) lines.push(`| ${row.keys.map(cell).join("")} | ${row.action} |`);
	}
	return lines.join("\n");
}
