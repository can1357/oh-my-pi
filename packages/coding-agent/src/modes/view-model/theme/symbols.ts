// ============================================================================
// Symbol Presets
// ============================================================================

export type SymbolPreset = "unicode" | "nerd" | "ascii";

/**
 * Icon vocabulary for slash-command autocomplete type indicators. Each name
 * resolves through `Theme.cmd` to either a dedicated `cmd.*` symbol or an
 * existing `icon.*` symbol shared with the rest of the UI.
 */
export type SlashCommandIconName =
	// Dedicated cmd.* symbols
	| "action"
	| "prompt"
	| "extension"
	| "settings"
	| "gear"
	| "shield"
	| "wave"
	| "compass"
	| "inbox"
	| "swap"
	| "expand"
	| "computer"
	| "eye"
	| "todo"
	| "stats"
	| "news"
	| "keyboard"
	| "export"
	| "clipboard"
	| "share"
	| "broadcast"
	| "globe"
	| "copy"
	| "plus"
	| "restart"
	| "eraser"
	| "trash"
	| "compress"
	| "vibrate"
	| "handoff"
	| "history"
	| "question"
	| "rocket"
	| "stethoscope"
	| "redo"
	| "bug"
	| "memory"
	| "pencil"
	| "folderMove"
	| "folderPlus"
	| "folderMinus"
	| "hammer"
	| "power"
	| "cart"
	// Shared icon.* symbols
	| "model"
	| "plan"
	| "prewalk"
	| "goal"
	| "pause"
	| "loop"
	| "session"
	| "jobs"
	| "gauge"
	| "context"
	| "ghost"
	| "agents"
	| "branch"
	| "tree"
	| "signIn"
	| "signOut"
	| "advisor"
	| "host"
	| "package"
	| "fast"
	| "voice"
	| "tools"
	| "rule"
	| "skill"
	| "mcp"
	| "pin";

export type SpinnerType = "status" | "activity";

export const SPINNER_FRAMES: Record<SymbolPreset, Record<SpinnerType, string[]>> = {
	unicode: {
		status: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
		activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
	nerd: {
		status: ["󱑖", "󱑋", "󱑌", "󱑍", "󱑎", "󱑏", "󱑐", "󱑑", "󱑒", "󱑓", "󱑔", "󱑕"],
		activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
	ascii: {
		// Bracketed like the `status.*` glyphs, so a settling call keeps its column width.
		status: ["[|]", "[/]", "[-]", "[\\]"],
		activity: ["-", "\\", "|", "/"],
	},
};
