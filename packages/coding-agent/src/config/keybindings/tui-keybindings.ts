import { type KeyId } from "./key-id";

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;

export const TUI_KEYBINDINGS = {
	"tui.editor.selectAll": { defaultKeys: "super+a", description: "Select all text" },
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.jumpForward": {
		defaultKeys: "ctrl+]",
		description: "Jump forward to character",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: "ctrl+alt+]",
		description: "Jump backward to character",
	},
	"tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: "backspace",
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "ctrl+d"],
		description: "Delete character forward",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace", "ctrl+backspace", "super+alt+backspace"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+delete", "alt+d", "ctrl+delete", "super+alt+delete", "super+alt+d"],
		description: "Delete word forward",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	"tui.editor.undo": { defaultKeys: ["ctrl+-", "ctrl+_"], description: "Undo" },
	"tui.editor.redo": { defaultKeys: ["ctrl+^", "ctrl+shift+6"], description: "Redo in the prompt editor" },
	"tui.editor.spellingSuggestions": {
		defaultKeys: "ctrl+.",
		description: "Show spelling replacements",
	},
	"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: "pageDown",
		description: "Selection page down",
	},
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
} as const satisfies KeybindingDefinitions;
