import type { TspSpan } from "@oh-my-pi/pi-wire";
import { type AppKeybinding, formatKeyHint, type KeybindingsManager, keyHintPlatform } from "./app-keybindings";
import { Markdown } from "./components/markdown";
import { matchesSelectCancel } from "./keybinding-matchers";
import type { KeyName } from "./key-hint-format";
import { canonicalKeyId } from "./keybindings";
import { col, node, span } from "./native/describe";
import type { NativeNode, NativeUiEvent } from "./native/node";
import { actionBar, actionButton } from "./native/overlay";
import { getMarkdownTheme } from "./theme/theme";
import type { Component } from "./tui";

/** Effective keybinding operations used to render the hotkey reference. */
export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString" | "getKeys" | "matchesCanonical">;
}

/**
 * One piece of a shortcut cell: formatted key hints (alternatives, one keycap
 * each), a literal typed token (`#<number>`, `!!`), or connecting prose.
 */
type HotkeyPart =
	| {
			/** Formatted for the markdown table (`⌃R`); `Disabled` when unbound. */
			keys: readonly string[];
			/** Key ids (`ctrl+r`) for native keycaps, which the terminal draws with platform glyphs. */
			ids: readonly KeyName[];
			action?: AppKeybinding;
	  }
	| { token: string }
	| { text: string };

interface HotkeyRow {
	readonly keys: readonly HotkeyPart[];
	readonly action: string;
}

interface HotkeyGroup {
	readonly title: string;
	readonly rows: readonly HotkeyRow[];
}

/** Formatted hints for key ids. */
function hints(keys: readonly KeyName[]): HotkeyPart {
	return { keys: keys.map(formatKeyHint), ids: keys };
}

/** The markdown cell text of a part; key alternatives join with `/` as `formatKeyHints` does. */
function markdownPart(bindings: HotkeysMarkdownBindings, part: HotkeyPart): string {
	if ("text" in part) return part.text;
	if ("token" in part) return `\`${part.token}\``;
	const label = part.action ? bindings.keybindings.getDisplayString(part.action) || "Disabled" : part.keys.join("/");
	return `\`${label}\``;
}

/** The shortcut groups, built from the effective bindings. */
function hotkeyGroups(bindings: HotkeysMarkdownBindings): HotkeyGroup[] {
	const isMac = keyHintPlatform() === "darwin";
	// An action's effective keys, one keycap each; `Disabled` when unbound.
	const act = (action: AppKeybinding): HotkeyPart => {
		const keys = bindings.keybindings.getKeys(action);
		if (keys.length > 0) return { keys: keys.map(formatKeyHint), ids: keys, action };
		return { keys: [bindings.keybindings.getDisplayString(action) || "Disabled"], ids: [], action };
	};
	const pushToTalkKeys = bindings.keybindings.getKeys("app.stt.pushToTalk");
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
	const exitRows: HotkeyRow[] = [];
	if (deletingExitKeys.length > 0) {
		exitRows.push({
			keys: [hints(deletingExitKeys)],
			action: "Delete char forward (with draft) / exit (empty prompt)",
		});
	}
	// An unbound exit action still gets its row, mirroring the `Disabled` hint every other row uses.
	if (quittingExitKeys.length > 0 || deletingExitKeys.length === 0) {
		exitRows.push({
			keys: [quittingExitKeys.length > 0 ? hints(quittingExitKeys) : { keys: ["Disabled"], ids: [] }],
			action: "Exit",
		});
	}
	const groups: HotkeyGroup[] = [
		{
			title: "Navigation",
			rows: [
				{
					keys: [hints(["up", "down", "left", "right"])],
					action: `Move cursor / browse history (${formatKeyHint("up")} when empty)`,
				},
				{ keys: [hints(["alt+left", "alt+right"])], action: "Move by word" },
				{
					keys: [hints(isMac ? ["ctrl+a", "home", "super+left"] : ["ctrl+a", "home"])],
					action: "Start of line",
				},
				{ keys: [hints(isMac ? ["ctrl+e", "end", "super+right"] : ["ctrl+e", "end"])], action: "End of line" },
			],
		},
		{
			title: "Editing",
			rows: [
				{ keys: [hints(["enter"])], action: "Send message" },
				{ keys: [hints(["shift+enter", "alt+enter"])], action: "New line" },
				{ keys: [hints(["ctrl+w", "alt+backspace"])], action: "Delete word backwards" },
				{ keys: [hints(["ctrl+u"])], action: "Delete to start of line" },
				{ keys: [hints(["ctrl+k"])], action: "Delete to end of line" },
				{ keys: [act("app.clipboard.copyLine")], action: "Copy current line" },
				{ keys: [act("app.clipboard.copyPrompt")], action: "Copy whole prompt" },
			],
		},
		{
			title: "Other",
			rows: [
				{ keys: [hints(["tab"])], action: "Path completion / accept autocomplete" },
				{ keys: [act("app.interrupt")], action: "Cancel autocomplete / interrupt active work" },
				{ keys: [act("app.clear")], action: "Clear editor (first) / exit (second)" },
				...exitRows,
				{ keys: [act("app.suspend")], action: "Suspend to background" },
				{ keys: [act("app.display.reset")], action: "Reset terminal display" },
				{ keys: [act("app.thinking.cycle")], action: "Cycle thinking level" },
				{ keys: [act("app.model.cycleForward")], action: "Cycle role models (slow/default/smol)" },
				{ keys: [act("app.model.cycleBackward")], action: "Cycle role models (backward)" },
				{ keys: [act("app.model.selectTemporary")], action: "Select model (temporary)" },
				{ keys: [act("app.model.select")], action: "Select model (set roles)" },
				{ keys: [act("app.plan.toggle")], action: "Toggle plan mode" },
				{ keys: [act("app.history.search")], action: "Search prompt history" },
				{ keys: [act("app.tools.expand")], action: "Toggle tool output expansion" },
				{ keys: [act("app.tools.toggleVisibility")], action: "Toggle tool activity visibility" },
				{ keys: [act("app.thinking.toggle")], action: "Toggle thinking block visibility" },
				{ keys: [act("app.editor.external")], action: "Edit message in external editor" },
				{
					keys: [act("app.editor.stash")],
					action: "Stash the draft; on an empty editor restore it (also restores after sending another prompt)",
				},
				{ keys: [act("app.retry")], action: "Retry last failed assistant turn" },
				{ keys: [act("app.clipboard.pasteImage")], action: "Paste image or text from clipboard" },
				{
					keys:
						pushToTalkKeys.length > 0
							? [{ text: "Hold " }, act("app.stt.pushToTalk")]
							: [act("app.stt.pushToTalk")],
					action:
						pushToTalkKeys.length > 0
							? "Speech-to-text (push-to-talk): hold to record, release to transcribe"
							: "Speech-to-text (push-to-talk) (disabled)",
				},
				{ keys: [act("app.live.toggle")], action: "Start/stop live voice mode (/live)" },
				{
					keys: [act("app.agents.hub"), { text: " / double-tap " }, hints(["left"]), { text: " (empty editor)" }],
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
	return groups;
}

/** Build the platform-aware Markdown reference for effective application hotkeys. */
export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const lines: string[] = [];
	for (const [index, group] of hotkeyGroups(bindings).entries()) {
		if (index > 0) lines.push("");
		lines.push(`**${group.title}**`, "| Key | Action |", "|-----|--------|");
		for (const row of group.rows) {
			const keys = row.keys.map(part => markdownPart(bindings, part)).join("");
			lines.push(`| ${keys} | ${row.action} |`);
		}
	}
	return lines.join("\n");
}

/**
 * A shortcut cell as spans: each key alternative a `key` span holding its key
 * id (`ctrl+r`, drawn as a keycap like `kbd`), literal tokens as code, prose dim.
 */
function keySpans(parts: readonly HotkeyPart[]): TspSpan[] {
	const spans: TspSpan[] = [];
	for (const part of parts) {
		if ("text" in part) spans.push(span(part.text, "dim"));
		else if ("token" in part) spans.push(span(part.token, "code"));
		else if (part.ids.length === 0) spans.push(span(part.keys.join("/"), "dim"));
		else {
			for (const [index, id] of part.ids.entries()) {
				if (index > 0) spans.push(span(" ", "dim"));
				spans.push(span(id, "key"));
			}
		}
	}
	return spans;
}

/** Inline markdown (backticks) of an action description as spans: code runs mono, the rest plain. */
function actionSpans(action: string): TspSpan[] {
	return action.split(/(`[^`]+`)/).flatMap(piece => {
		if (piece === "") return [];
		return piece.startsWith("`") && piece.endsWith("`") ? [span(piece.slice(1, -1), "code")] : [span(piece)];
	});
}

/**
 * `/hotkeys` under a native terminal: a large sheet "Keyboard shortcuts" with
 * one section per group, each a two-column table whose key cells carry `key`
 * spans (Tern draws them as keycaps). Esc (or Close) dismisses it. Terminals
 * without the native surface get the transcript markdown panel instead.
 */
export class HotkeysSheetComponent implements Component {
	readonly nativeOverlay = { role: "omp.overlay.hotkeys", size: "lg", head: "Keyboard shortcuts" } as const;
	readonly #bindings: HotkeysMarkdownBindings;
	readonly #onClose: () => void;
	#native: NativeNode | undefined;
	#markdown: Markdown | undefined;

	constructor(bindings: HotkeysMarkdownBindings, onClose: () => void) {
		this.#bindings = bindings;
		this.#onClose = onClose;
	}

	describe(): NativeNode {
		if (this.#native) return this.#native;
		const sections = hotkeyGroups(this.#bindings).map((group, index) =>
			node(
				"section",
				{ head: group.title, role: "omp.hotkeys.group" },
				[
					node("table", {
						role: "omp.hotkeys.table",
						cols: [
							{ id: "keys", head: "Key" },
							{ id: "action", head: "Action", grow: 1 },
						],
						rows: group.rows.map((row, rowIndex) => ({
							id: String(rowIndex),
							cells: { keys: keySpans(row.keys), action: actionSpans(row.action) },
						})),
					}),
				],
				`g${index}`,
			),
		);
		const close = actionButton("Close", "close", { keys: "escape" });
		this.#native = col([...sections, actionBar([null, close])], { gap: "lg" });
		return this.#native;
	}

	/** The markdown reference, for a terminal that falls back to rows. */
	render(width: number): readonly string[] {
		this.#markdown ??= new Markdown(buildHotkeysMarkdown(this.#bindings), 1, 1, getMarkdownTheme());
		return this.#markdown.render(width);
	}

	invalidate(): void {
		this.#native = undefined;
		this.#markdown = undefined;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) this.#onClose();
	}

	/** Close runs what Esc runs. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#onClose();
	}
}
