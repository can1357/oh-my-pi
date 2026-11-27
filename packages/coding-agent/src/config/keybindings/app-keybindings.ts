import { type KeybindingDefinitions, TUI_KEYBINDINGS } from "./tui-keybindings";
import { type KeyId } from "./key-id";

/**
 * Application-level keybindings (coding agent specific).
 * Values are always `true` — used for declaration merging.
 */
interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.display.reset": true;
	"app.thinking.cycle": true;
	"app.thinking.toggle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.model.selectTemporary": true;
	"app.tools.expand": true;
	"app.tools.toggleVisibility": true;
	"app.ask.hide": true;
	"app.ask.note": true;
	"app.approval.approve": true;
	"app.editor.external": true;
	"app.local.open": true;
	"app.message.followUp": true;
	"app.retry": true;
	"app.message.dequeue": true;
	"app.btw.inject": true;
	"app.clipboard.pasteImage": true;
	"app.clipboard.pasteTextRaw": true;
	"app.clipboard.copyLine": true;
	"app.clipboard.copyPrompt": true;
	"app.transcript.pageUp": true;
	"app.transcript.pageDown": true;
	"app.transcript.halfPageUp": true;
	"app.transcript.halfPageDown": true;
	"app.transcript.previousPrompt": true;
	"app.transcript.nextPrompt": true;
	"app.transcript.search": true;
	"app.transcript.selectLeft": true;
	"app.transcript.selectRight": true;
	"app.transcript.selectUp": true;
	"app.transcript.selectDown": true;
	"app.transcript.selectLineStart": true;
	"app.transcript.selectLineEnd": true;
	"app.transcript.clearSelection": true;
	"app.transcript.copySelection": true;
	"app.transcript.lineUp": true;
	"app.transcript.lineDown": true;
	"app.transcript.top": true;
	"app.transcript.bottom": true;
	"app.agents.hub": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.session.observe": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.session.pin": true;
	"app.session.unpin": true;
	"app.tree.previousBranch": true;
	"app.tree.nextBranch": true;
	"app.plan.toggle": true;
	"app.history.search": true;
	"app.links.hint": true;
	"app.stt.pushToTalk": true;
	"app.stt.toggle": true;
	"app.live.toggle": true;
}

/** Application action identifier registered alongside the base TUI keybindings. */
export type AppKeybinding = keyof AppKeybindings;

/**
 * Resolve default image-paste shortcuts for the current terminal platform.
 */
export function getDefaultPasteImageKeys(platform: NodeJS.Platform = process.platform): KeyId[] {
	if (platform === "win32") return ["ctrl+v", "alt+v"];
	if (platform === "darwin") return ["ctrl+v", "super+v"];
	return ["ctrl+v"];
}

/**
 * All keybindings definitions: TUI + app-specific.
 */
export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": {
		defaultKeys: "escape",
		description: "Interrupt current operation",
	},
	"app.clear": {
		defaultKeys: "ctrl+c",
		description: "Clear screen or cancel",
	},
	"app.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit application",
	},
	"app.suspend": {
		defaultKeys: "ctrl+z",
		description: "Suspend application",
	},
	"app.display.reset": {
		defaultKeys: "alt+l",
		description: "Reset terminal display",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking mode",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": {
		defaultKeys: "alt+m",
		description: "Select model",
	},
	"app.model.selectTemporary": {
		defaultKeys: "alt+p",
		description: "Select temporary model for current session",
	},
	"app.tools.expand": {
		defaultKeys: "ctrl+o",
		description: "Expand tools",
	},
	"app.tools.toggleVisibility": {
		defaultKeys: "ctrl+shift+o",
		description: "Cycle tool activity: detailed, concise, hidden",
	},
	"app.ask.hide": {
		defaultKeys: "alt+h",
		description: "Hide or show a pending ask dialog",
	},
	"app.ask.note": {
		// Dropdowns keep printable keys for type-ahead, so they take the first non-printable key.
		defaultKeys: ["n", "alt+n"],
		description: "Add or edit a note on the highlighted ask option",
	},
	"app.approval.approve": {
		// A chord, not Enter: an Enter typed for the composer as the prompt appears must not approve.
		// Ctrl+Q backs up Ctrl+Enter, which Windows Terminal cannot deliver (#1903).
		defaultKeys: ["ctrl+enter", "ctrl+q"],
		description: "Approve a pending tool call",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.local.open": {
		defaultKeys: "alt+g",
		description: "Open a local:// file in external editor",
	},
	"app.message.followUp": {
		// Ctrl+Enter is preserved for terminals that deliver it (Kitty/iTerm2/WezTerm/Ghostty),
		// but Windows Terminal does not emit a distinct event for Ctrl+Enter — Ctrl+Q is listed
		// first so the default binding works there without remapping (#1903).
		defaultKeys: ["ctrl+q", "ctrl+enter"],
		description: "Send follow-up message",
	},
	"app.retry": {
		// F5 leads: it is delivered verbatim by every terminal, unlike modified
		// Enter chords (Ctrl/Alt/Cmd+Enter), which various terminals swallow or
		// fold into plain Enter. The idle "F5 to Retry" status row advertises it.
		defaultKeys: ["f5", "alt+r"],
		description: "Retry last failed assistant turn",
	},
	"app.message.dequeue": {
		// Shift+Up is listed alongside Alt+Up because macOS Terminal.app consumes Option
		// for character composition, leaving Alt+Up unreachable there.
		defaultKeys: ["alt+up", "shift+up"],
		description: "Dequeue message",
	},
	"app.btw.inject": {
		defaultKeys: "alt+i",
		description: "Send a /btw answer's steering prompt to the main session",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: getDefaultPasteImageKeys(),
		description: "Paste image or text from clipboard",
	},
	"app.clipboard.pasteTextRaw": {
		defaultKeys: ["ctrl+shift+v", "alt+shift+v"],
		description: "Paste text from clipboard as raw text (no collapse)",
	},
	"app.clipboard.copyLine": {
		defaultKeys: "alt+shift+l",
		description: "Copy current line",
	},
	"app.clipboard.copyPrompt": {
		defaultKeys: "alt+shift+c",
		description: "Copy prompt",
	},
	// Fullscreen screen mode only (`tui.screen`); inline, these keys reach the editor.
	"app.transcript.pageUp": {
		defaultKeys: "pageUp",
		description: "Scroll the fullscreen transcript up a page",
	},
	"app.transcript.pageDown": {
		defaultKeys: "pageDown",
		description: "Scroll the fullscreen transcript down a page",
	},
	"app.transcript.halfPageUp": {
		defaultKeys: [],
		description: "Scroll the fullscreen transcript up half a page",
	},
	"app.transcript.halfPageDown": {
		defaultKeys: [],
		description: "Scroll the fullscreen transcript down half a page",
	},
	"app.transcript.previousPrompt": {
		defaultKeys: "alt+pageUp",
		description: "Scroll to the previous user prompt",
	},
	"app.transcript.nextPrompt": {
		defaultKeys: "alt+pageDown",
		description: "Scroll to the next user prompt",
	},
	"app.transcript.search": {
		defaultKeys: "alt+/",
		description: "Find text in the fullscreen transcript",
	},
	"app.transcript.selectLeft": {
		defaultKeys: [],
		description: "Extend the fullscreen selection left",
	},
	"app.transcript.selectRight": {
		defaultKeys: [],
		description: "Extend the fullscreen selection right",
	},
	"app.transcript.selectUp": {
		defaultKeys: [],
		description: "Extend the fullscreen selection up",
	},
	"app.transcript.selectDown": {
		defaultKeys: [],
		description: "Extend the fullscreen selection down",
	},
	"app.transcript.selectLineStart": {
		defaultKeys: [],
		description: "Extend the fullscreen selection to line start",
	},
	"app.transcript.selectLineEnd": {
		defaultKeys: [],
		description: "Extend the fullscreen selection to line end",
	},
	"app.transcript.clearSelection": {
		defaultKeys: [],
		description: "Clear the fullscreen selection",
	},
	"app.transcript.copySelection": {
		defaultKeys: ["alt+c", "ctrl+shift+c", "super+c"],
		description: "Copy selected fullscreen transcript text",
	},
	"app.transcript.lineUp": {
		defaultKeys: [],
		description: "Scroll the fullscreen transcript up one line",
	},
	"app.transcript.lineDown": {
		defaultKeys: [],
		description: "Scroll the fullscreen transcript down one line",
	},
	"app.transcript.top": {
		defaultKeys: "ctrl+home",
		description: "Scroll the fullscreen transcript to its start",
	},
	"app.transcript.bottom": {
		defaultKeys: "ctrl+end",
		description: "Scroll the fullscreen transcript to its end and follow new output",
	},
	"app.session.new": {
		defaultKeys: [],
		description: "Create new session",
	},
	"app.session.tree": {
		defaultKeys: [],
		description: "Show session tree",
	},
	"app.session.fork": {
		defaultKeys: [],
		description: "Fork session",
	},
	"app.session.resume": {
		defaultKeys: [],
		description: "Resume session",
	},
	"app.agents.hub": {
		defaultKeys: "alt+a",
		description: "Open the agent hub",
	},
	"app.session.observe": {
		defaultKeys: "ctrl+s",
		description: "Open the agent hub",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort order",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: ["backspace", "delete"],
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session (non-invasive)",
	},
	"app.session.pin": {
		defaultKeys: "alt+k",
		description: "Pin the selected session in the resume picker",
	},
	"app.session.unpin": {
		defaultKeys: "alt+shift+k",
		description: "Unpin the selected session in the resume picker",
	},
	"app.tree.previousBranch": {
		defaultKeys: [],
		description: "Jump to the previous branch in /tree",
	},
	"app.tree.nextBranch": {
		defaultKeys: [],
		description: "Jump to the next branch in /tree",
	},
	"app.plan.toggle": {
		defaultKeys: "alt+shift+p",
		description: "Toggle plan mode",
	},
	"app.history.search": {
		defaultKeys: "ctrl+r",
		description: "Search history",
	},
	"app.links.hint": {
		defaultKeys: "alt+o",
		description: "Pick an extension link on screen by its hint tag",
	},
	"app.stt.pushToTalk": {
		defaultKeys: "space",
		description: "Hold to record speech-to-text",
	},
	"app.stt.toggle": {
		defaultKeys: [],
		description: "Toggle speech-to-text recording",
	},
	"app.live.toggle": {
		defaultKeys: "ctrl+l",
		description: "Start or stop live voice mode (/live)",
	},
} as const satisfies KeybindingDefinitions;

/** Any keybinding action id: the base `tui.*` editing/selection actions and the `app.*` actions. */
export type Keybinding = keyof typeof KEYBINDINGS;
