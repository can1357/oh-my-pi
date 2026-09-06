import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Effort } from "@pk-nerdsaver-ai/pi-ai";
import {
	detectMacOSAppearance,
	MacAppearanceObserver,
	type HighlightColors as NativeHighlightColors,
	highlightCode as nativeHighlightCode,
	supportsLanguage as nativeSupportsLanguage,
} from "@pk-nerdsaver-ai/pi-natives";
import type {
	EditorTheme,
	MarkdownTheme,
	SelectListTheme,
	SettingsListTheme,
	SymbolTheme,
} from "@pk-nerdsaver-ai/pi-tui";
import {
	adjustHsv,
	colorLuma,
	getCustomThemesDir,
	isEnoent,
	logger,
	relativeLuminance,
} from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import chalk from "chalk";
import { LRUCache } from "lru-cache/raw";
// Embed theme JSON files at build time
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
import lightThemeJson from "./light.json" with { type: "json" };
import { resolveMermaidAscii } from "./mermaid-cache";

export { getLanguageFromPath } from "../../utils/lang-from-path";

// ============================================================================
// Symbol Presets
// ============================================================================

export type SymbolPreset = "unicode" | "nerd" | "ascii";

/**
 * All available symbol keys organized by category.
 */
export type SymbolKey =
	// Status Indicators
	| "status.success"
	| "status.error"
	| "status.warning"
	| "status.info"
	| "status.pending"
	| "status.disabled"
	| "status.enabled"
	| "status.running"
	| "status.shadowed"
	| "status.aborted"
	| "status.done"
	// Navigation
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	// Tree Connectors
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	// Box Drawing - Rounded
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box Drawing - Sharp
	| "boxSharp.topLeft"
	| "boxSharp.topRight"
	| "boxSharp.bottomLeft"
	| "boxSharp.bottomRight"
	| "boxSharp.horizontal"
	| "boxSharp.vertical"
	| "boxSharp.cross"
	| "boxSharp.teeDown"
	| "boxSharp.teeUp"
	| "boxSharp.teeRight"
	| "boxSharp.teeLeft"
	// Separators
	| "sep.powerline"
	| "sep.powerlineThin"
	| "sep.powerlineLeft"
	| "sep.powerlineRight"
	| "sep.powerlineThinLeft"
	| "sep.powerlineThinRight"
	| "sep.block"
	| "sep.space"
	| "sep.asciiLeft"
	| "sep.asciiRight"
	| "sep.dot"
	| "sep.slash"
	| "sep.pipe"
	// Icons
	| "icon.model"
	| "icon.plan"
	| "icon.goal"
	| "icon.pause"
	| "icon.loop"
	| "icon.folder"
	| "icon.search"
	| "icon.scratchFolder"
	| "icon.file"
	| "icon.git"
	| "icon.branch"
	| "icon.pr"
	| "icon.tokens"
	| "icon.context"
	| "icon.cost"
	| "icon.time"
	| "icon.pi"
	| "icon.ghost"
	| "icon.agents"
	| "icon.job"
	| "icon.cache"
	| "icon.cacheMiss"
	| "icon.input"
	| "icon.output"
	| "icon.host"
	| "icon.session"
	| "icon.package"
	| "icon.warning"
	| "icon.rewind"
	| "icon.auto"
	| "icon.fast"
	| "icon.extensionSkill"
	| "icon.extensionTool"
	| "icon.extensionSlashCommand"
	| "icon.extensionMcp"
	| "icon.extensionRule"
	| "icon.extensionHook"
	| "icon.extensionPrompt"
	| "icon.extensionContextFile"
	| "icon.extensionInstruction"
	// STT
	| "icon.mic"
	// Compaction divider
	| "icon.camera"
	// Thinking Levels
	| "thinking.minimal"
	| "thinking.low"
	| "thinking.medium"
	| "thinking.high"
	| "thinking.xhigh"
	| "thinking.autoPending"
	// Checkboxes
	| "checkbox.checked"
	| "checkbox.unchecked"
	// Radio (single-choice)
	| "radio.selected"
	| "radio.unselected"
	// Text Formatting
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	// Markdown-specific
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	| "md.colorSwatch"
	// Language/file type icons
	| "lang.default"
	| "lang.typescript"
	| "lang.javascript"
	| "lang.python"
	| "lang.rust"
	| "lang.go"
	| "lang.java"
	| "lang.c"
	| "lang.cpp"
	| "lang.csharp"
	| "lang.ruby"
	| "lang.php"
	| "lang.swift"
	| "lang.kotlin"
	| "lang.shell"
	| "lang.html"
	| "lang.css"
	| "lang.json"
	| "lang.yaml"
	| "lang.markdown"
	| "lang.sql"
	| "lang.docker"
	| "lang.lua"
	| "lang.text"
	| "lang.env"
	| "lang.toml"
	| "lang.xml"
	| "lang.ini"
	| "lang.conf"
	| "lang.log"
	| "lang.csv"
	| "lang.tsv"
	| "lang.image"
	| "lang.pdf"
	| "lang.archive"
	| "lang.binary"
	// Settings tab icons
	| "tab.appearance"
	| "tab.model"
	| "tab.interaction"
	| "tab.context"
	| "tab.files"
	| "tab.shell"
	| "tab.tools"
	| "tab.memory"
	| "tab.tasks"
	| "tab.providers"
	// Tool identity icons
	| "tool.write"
	| "tool.edit"
	| "tool.delete"
	| "tool.move"
	| "tool.bash"
	| "tool.ssh"
	| "tool.lsp"
	| "tool.gh"
	| "tool.webSearch"
	| "tool.exa"
	| "tool.browser"
	| "tool.eval"
	| "tool.debug"
	| "tool.mcp"
	| "tool.job"
	| "tool.task"
	| "tool.todo"
	| "tool.memory"
	| "tool.ask"
	| "tool.resolve"
	| "tool.review"
	| "tool.inspectImage"
	| "tool.goal"
	| "tool.irc";

type SymbolMap = Record<SymbolKey, string>;

const UNICODE_SYMBOLS: SymbolMap = {
	// Status
	"status.success": "✔",
	"status.error": "✘",
	"status.warning": "⚠",
	"status.info": "ⓘ",
	"status.pending": "⏳",
	"status.disabled": "⦸",
	"status.enabled": "●",
	"status.running": "⟳",
	"status.shadowed": "◌",
	"status.aborted": "⏹",
	"status.done": "•",
	// Navigation
	"nav.cursor": "❯",
	"nav.selected": "➤",
	"nav.expand": "▸",
	"nav.collapse": "▾",
	"nav.back": "⟵",
	// Tree
	"tree.branch": "├─",
	"tree.last": "└─",
	"tree.vertical": "│",
	"tree.horizontal": "─",
	"tree.hook": "└",
	// Box (rounded)
	"boxRound.topLeft": "╭",
	"boxRound.topRight": "╮",
	"boxRound.bottomLeft": "╰",
	"boxRound.bottomRight": "╯",
	"boxRound.horizontal": "─",
	"boxRound.vertical": "│",
	// Box (sharp)
	"boxSharp.topLeft": "┌",
	"boxSharp.topRight": "┐",
	"boxSharp.bottomLeft": "└",
	"boxSharp.bottomRight": "┘",
	"boxSharp.horizontal": "─",
	"boxSharp.vertical": "│",
	"boxSharp.cross": "┼",
	"boxSharp.teeDown": "┬",
	"boxSharp.teeUp": "┴",
	"boxSharp.teeRight": "├",
	"boxSharp.teeLeft": "┤",
	// Separators (powerline-ish, but pure Unicode)
	"sep.powerline": "▕",
	"sep.powerlineThin": "┆",
	"sep.powerlineLeft": "▶",
	"sep.powerlineRight": "◀",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "▌",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " · ",
	"sep.slash": " / ",
	"sep.pipe": " │ ",
	// Icons
	"icon.model": "⬢",
	"icon.plan": "🗺",
	"icon.goal": "🎯",
	"icon.pause": "⏸",
	"icon.loop": "↻",
	"icon.folder": "📁",
	"icon.search": "🔍",
	"icon.scratchFolder": "🗑",
	"icon.file": "📄",
	"icon.git": "⎇",
	"icon.branch": "⑂",
	"icon.pr": "⤴",
	"icon.tokens": "🪙",
	"icon.context": "◫",
	"icon.cost": "💲",
	"icon.time": "⏱",
	"icon.pi": "pk",
	"icon.ghost": "👻",
	"icon.agents": "👥",
	"icon.job": "⚙",
	"icon.cache": "💾",
	"icon.cacheMiss": "⊘",
	"icon.input": "⤵",
	"icon.output": "⤴",
	"icon.host": "🖥",
	"icon.session": "🆔",
	"icon.package": "📦",
	"icon.warning": "⚠",
	"icon.rewind": "↶",
	"icon.auto": "⟲",
	"icon.fast": "⚡",
	"icon.extensionSkill": "✦",
	"icon.extensionTool": "🛠",
	"icon.extensionSlashCommand": "⌘",
	"icon.extensionMcp": "🔌",
	"icon.extensionRule": "⚖",
	"icon.extensionHook": "🪝",
	"icon.extensionPrompt": "✎",
	"icon.extensionContextFile": "📎",
	"icon.extensionInstruction": "📘",
	// STT
	"icon.mic": "🎤",
	// Compaction divider
	"icon.camera": "📷",
	// Thinking levels
	"thinking.minimal": "◔ min",
	"thinking.low": "◑ low",
	"thinking.medium": "◒ med",
	"thinking.high": "◕ high",
	"thinking.xhigh": "◉ xhigh",
	"thinking.autoPending": "⟳",
	// Checkboxes
	"checkbox.checked": "☑",
	"checkbox.unchecked": "☐",
	// Radio (single-choice)
	"radio.selected": "◉",
	"radio.unselected": "○",
	// Formatting
	"format.bullet": "•",
	"format.dash": "—",
	"format.bracketLeft": "⟦",
	"format.bracketRight": "⟧",
	// Markdown
	"md.quoteBorder": "▏",
	"md.hrChar": "─",
	"md.bullet": "•",
	"md.colorSwatch": "■",
	// Language/file icons (emoji-centric, no Nerd Font required)
	"lang.default": "⌘",
	"lang.typescript": "🟦",
	"lang.javascript": "🟨",
	"lang.python": "🐍",
	"lang.rust": "🦀",
	"lang.go": "🐹",
	"lang.java": "☕",
	"lang.c": "Ⓒ",
	"lang.cpp": "➕",
	"lang.csharp": "♯",
	"lang.ruby": "💎",
	"lang.php": "🐘",
	"lang.swift": "🕊",
	"lang.kotlin": "🅺",
	"lang.shell": "💻",
	"lang.html": "🌐",
	"lang.css": "🎨",
	"lang.json": "🧾",
	"lang.yaml": "📋",
	"lang.markdown": "📝",
	"lang.sql": "🗄",
	"lang.docker": "🐳",
	"lang.lua": "🌙",
	"lang.text": "🗒",
	"lang.env": "🔧",
	"lang.toml": "🧾",
	"lang.xml": "⟨⟩",
	"lang.ini": "⚙",
	"lang.conf": "⚙",
	"lang.log": "📜",
	"lang.csv": "📑",
	"lang.tsv": "📑",
	"lang.image": "🖼",
	"lang.pdf": "📕",
	"lang.archive": "🗜",
	"lang.binary": "⚙",
	// Settings tabs
	"tab.appearance": "🎨",
	"tab.model": "🤖",
	"tab.interaction": "⌨",
	"tab.context": "📋",
	"tab.files": "📁",
	"tab.shell": "💻",
	"tab.tools": "🔧",
	"tab.memory": "🧠",
	"tab.tasks": "📦",
	"tab.providers": "🌐",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "✎",
	"tool.edit": "✎",
	"tool.delete": "🗑",
	"tool.move": "➜",
	"tool.bash": "❯",
	"tool.ssh": "⇄",
	"tool.lsp": "💡",
	"tool.gh": "⎇",
	"tool.webSearch": "⌕",
	"tool.exa": "🔭",
	"tool.browser": "🌐",
	"tool.eval": "▶",
	"tool.debug": "🐞",
	"tool.mcp": "🔌",
	"tool.job": "⚙",
	"tool.task": "⇶",
	"tool.todo": "☑",
	"tool.memory": "🧠",
	"tool.ask": "?",
	"tool.resolve": "✓",
	"tool.review": "◉",
	"tool.inspectImage": "🖼",
	"tool.goal": "◎",
	"tool.irc": "✉",
};

const NERD_SYMBOLS: SymbolMap = {
	// Status Indicators
	// pick:  | alt:   
	"status.success": "\uf00c",
	// pick:  | alt:   
	"status.error": "\uf00d",
	// pick:  | alt:  
	"status.warning": "\uf12a",
	// pick:  | alt: 
	"status.info": "\uf129",
	// pick:  | alt:   
	"status.pending": "\uf254",
	// pick:  | alt:  
	"status.disabled": "\uf05e",
	// pick:  | alt:  
	"status.enabled": "\uf111",
	// pick:  | alt:   
	"status.running": "\uf110",
	// pick: ◐ | alt: ◑ ◒ ◓ ◔
	"status.shadowed": "◐",
	// pick:  | alt:  
	"status.aborted": "\uf04d",
	// pick: • | alt: ● ·
	"status.done": "•",
	// Navigation
	// pick:  | alt:  
	"nav.cursor": "\uf054",
	// pick:  | alt:  
	"nav.selected": "\uf178",
	// pick:  | alt:  
	"nav.expand": "\uf0da",
	// pick:  | alt:  
	"nav.collapse": "\uf0d7",
	// pick:  | alt:  
	"nav.back": "\uf060",
	// Tree Connectors (same as unicode)
	// pick: ├─ | alt: ├╴ ├╌ ╠═ ┣━
	"tree.branch": "├─",
	// pick: └─ | alt: └╴ └╌ ╚═ ┗━
	"tree.last": "└─",
	// pick: │ | alt: ┃ ║ ▏ ▕
	"tree.vertical": "│",
	// pick: ─ | alt: ━ ═ ╌ ┄
	"tree.horizontal": "─",
	// pick: └ | alt: ╰ ⎿ ↳
	"tree.hook": "└",
	// Box Drawing - Rounded (same as unicode)
	// pick: ╭ | alt: ┌ ┏ ╔
	"boxRound.topLeft": "╭",
	// pick: ╮ | alt: ┐ ┓ ╗
	"boxRound.topRight": "╮",
	// pick: ╰ | alt: └ ┗ ╚
	"boxRound.bottomLeft": "╰",
	// pick: ╯ | alt: ┘ ┛ ╝
	"boxRound.bottomRight": "╯",
	// pick: ─ | alt: ━ ═ ╌
	"boxRound.horizontal": "─",
	// pick: │ | alt: ┃ ║ ▏
	"boxRound.vertical": "│",
	// Box Drawing - Sharp (same as unicode)
	// pick: ┌ | alt: ┏ ╭ ╔
	"boxSharp.topLeft": "┌",
	// pick: ┐ | alt: ┓ ╮ ╗
	"boxSharp.topRight": "┐",
	// pick: └ | alt: ┗ ╰ ╚
	"boxSharp.bottomLeft": "└",
	// pick: ┘ | alt: ┛ ╯ ╝
	"boxSharp.bottomRight": "┘",
	// pick: ─ | alt: ━ ═ ╌
	"boxSharp.horizontal": "─",
	// pick: │ | alt: ┃ ║ ▏
	"boxSharp.vertical": "│",
	// pick: ┼ | alt: ╋ ╬ ┿
	"boxSharp.cross": "┼",
	// pick: ┬ | alt: ╦ ┯ ┳
	"boxSharp.teeDown": "┬",
	// pick: ┴ | alt: ╩ ┷ ┻
	"boxSharp.teeUp": "┴",
	// pick: ├ | alt: ╠ ┝ ┣
	"boxSharp.teeRight": "├",
	// pick: ┤ | alt: ╣ ┥ ┫
	"boxSharp.teeLeft": "┤",
	// Separators - Nerd Font specific
	// pick:  | alt:   
	"sep.powerline": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineThin": "\ue0b1",
	// pick:  | alt:  
	"sep.powerlineLeft": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineRight": "\ue0b2",
	// pick:  | alt: 
	"sep.powerlineThinLeft": "\ue0b1",
	// pick:  | alt: 
	"sep.powerlineThinRight": "\ue0b3",
	// pick: █ | alt: ▓ ▒ ░ ▉ ▌
	"sep.block": "█",
	// pick: space | alt: ␠ ·
	"sep.space": " ",
	// pick: > | alt: › » ▸
	"sep.asciiLeft": ">",
	// pick: < | alt: ‹ « ◂
	"sep.asciiRight": "<",
	// pick: · | alt: • ⋅
	"sep.dot": " · ",
	// pick:  | alt: / ∕ ⁄
	"sep.slash": "\ue0bb",
	// pick:  | alt: │ ┃ |
	"sep.pipe": "\ue0b3",
	// Icons - Nerd Font specific
	// pick:  | alt:   ◆
	"icon.model": "\uec19",
	// pick:  | alt:  
	"icon.plan": "\uf2d2",
	// pick:  (nf-fa-bullseye) | alt:  (nf-md-target) ◎ ⌖
	"icon.goal": "\uf140",
	// pick:  (nf-fa-pause) | alt: ⏸ ||
	"icon.pause": "\uf04c",
	// pick: ↻ | alt: ⟳
	"icon.loop": "\uf021",
	// pick:  | alt:  
	"icon.folder": "\uf115",
	"icon.search": "\uf002",
	// pick:  | alt:
	"icon.scratchFolder": "\uf014",
	// pick:  | alt:  
	"icon.file": "\uf15b",
	// pick:  | alt:  ⎇
	"icon.git": "\uf1d3",
	// pick:  | alt:  ⎇
	"icon.branch": "\uf126",
	// pick:  (nf-cod-git_pull_request) | alt:  (nf-oct-git_pull_request)
	"icon.pr": "\uea64",
	// pick:  | alt: ⊛ ◍ 
	"icon.tokens": "\ue26b",
	// pick:  | alt: ◫ ▦
	"icon.context": "\ue70f",
	// pick:  | alt: $ ¢
	"icon.cost": "\uf155",
	// pick:  | alt: ◷ ◴
	"icon.time": "\uf017",
	// pick:  | alt: π ∏ ∑
	"icon.pi": "PK",
	// pick: 󰊠 (nf-md-ghost) | alt: 👻
	"icon.ghost": "\u{f02a0}",
	// pick:  | alt: 
	"icon.agents": "\uf0c0",
	// pick:  (nf-fa-gear) | alt:  ⚙
	"icon.job": "\uf013",
	// pick:  | alt:  
	"icon.cache": "\uf1c0",
	// pick:  (fa-ban) | alt: ⊘
	"icon.cacheMiss": "\uf05e",
	// pick:  | alt:  →
	"icon.input": "\uf090",
	// pick:  | alt:  →
	"icon.output": "\uf08b",
	// pick:  | alt:  
	"icon.host": "\uf109",
	// pick:  | alt:  
	"icon.session": "\uf550",
	// pick:  | alt: 
	"icon.package": "\uf487",
	// pick:  | alt:  
	"icon.warning": "\uf071",
	// pick:  | alt:  ↺
	"icon.rewind": "\uf0e2",
	// pick: 󰁨 | alt:   
	"icon.auto": "\u{f0068}",
	"icon.fast": "\uf0e7",
	"icon.extensionSkill": "\uf0eb",
	// pick:  | alt:  
	"icon.extensionTool": "\uf0ad",
	// pick:  | alt: 
	"icon.extensionSlashCommand": "\uf120",
	// pick:  | alt:  
	"icon.extensionMcp": "\uf1e6",
	// pick:  | alt:  
	"icon.extensionRule": "\uf0e3",
	// pick:  | alt: 
	"icon.extensionHook": "\uf0c1",
	// pick:  | alt:  
	"icon.extensionPrompt": "\uf075",
	// pick:  | alt:  
	"icon.extensionContextFile": "\uf0f6",
	// pick:  | alt:  
	"icon.extensionInstruction": "\uf02d",
	// STT - fa-microphone
	"icon.mic": "\uf130",
	// Compaction divider - fa-camera-retro
	"icon.camera": "\uf083",
	// Thinking Levels - emoji labels
	// pick: 🤨 min | alt:  min  min
	"thinking.minimal": "\u{F0E7} min",
	// pick: 🤔 low | alt:  low  low
	"thinking.low": "\u{F10C} low",
	// pick: 🤓 med | alt:  med  med
	"thinking.medium": "\u{F192} med",
	// pick: 🤯 high | alt:  high  high
	"thinking.high": "\u{F111} high",
	// pick: 🧠 xhi | alt:  xhi  xhi
	"thinking.xhigh": "\u{F06D} xhi",
	// pick:  (fa-circle-o-notch) | alt: 󰂼 (nf-md-cached) ⟳
	"thinking.autoPending": "\uf1ce",
	// Checkboxes
	// pick:  | alt:  
	"checkbox.checked": "\uf14a",
	// pick:  | alt: 
	"checkbox.unchecked": "\uf096",
	// Radio (single-choice)
	// pick:  (fa-dot-circle-o) | alt:  ◉
	"radio.selected": "\uf192",
	// pick:  (fa-circle-o) | alt:  ○
	"radio.unselected": "\uf10c",
	// pick:  | alt:   •
	"format.bullet": "\uf111",
	// pick: – | alt: — ― -
	"format.dash": "–",
	// pick: ⟨ | alt: [ ⟦
	"format.bracketLeft": "⟨",
	// pick: ⟩ | alt: ] ⟧
	"format.bracketRight": "⟩",
	// Markdown-specific
	// pick: │ | alt: ┃ ║
	"md.quoteBorder": "│",
	// pick: ─ | alt: ━ ═
	"md.hrChar": "─",
	// pick:  | alt:  •
	"md.bullet": "\uf111",
	// pick: ■ | alt:  (U+F096)
	"md.colorSwatch": "■",
	// Language icons (nerd font devicons)
	"lang.default": "",
	"lang.typescript": "\u{E628}",
	"lang.javascript": "\u{E60C}",
	"lang.python": "\u{E606}",
	"lang.rust": "\u{E7A8}",
	"lang.go": "\u{E627}",
	"lang.java": "\u{E738}",
	"lang.c": "\u{E61E}",
	"lang.cpp": "\u{E61D}",
	"lang.csharp": "\u{E7BC}",
	"lang.ruby": "\u{E791}",
	"lang.php": "\u{E608}",
	"lang.swift": "\u{E755}",
	"lang.kotlin": "\u{E634}",
	"lang.shell": "\u{E795}",
	"lang.html": "\u{E736}",
	"lang.css": "\u{E749}",
	"lang.json": "\u{E60B}",
	"lang.yaml": "\u{E615}",
	"lang.markdown": "\u{E609}",
	"lang.sql": "\u{E706}",
	"lang.docker": "\u{E7B0}",
	"lang.lua": "\u{E620}",
	"lang.text": "\u{E612}",
	"lang.env": "\u{E615}",
	"lang.toml": "\u{E615}",
	"lang.xml": "\u{F05C0}",
	"lang.ini": "\u{E615}",
	"lang.conf": "\u{E615}",
	"lang.log": "\u{F0331}",
	"lang.csv": "\u{F021B}",
	"lang.tsv": "\u{F021B}",
	"lang.image": "\u{F021F}",
	"lang.pdf": "\u{F0226}",
	"lang.archive": "\u{F187}",
	"lang.binary": "\u{F019A}",
	// Settings tab icons
	"tab.appearance": "󰃣",
	"tab.model": "󰚩",
	"tab.interaction": "󰌌",
	"tab.context": "󰘸",
	"tab.files": "󰈔",
	"tab.shell": "󰆍",
	"tab.tools": "󰠭",
	"tab.memory": "󰧑",
	"tab.tasks": "󰐱",
	"tab.providers": "󰖟",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "\uEA7F",
	"tool.edit": "\uEA73",
	"tool.delete": "\uEA81",
	"tool.move": "\uEA9C",
	"tool.bash": "\uEBCA",
	"tool.ssh": "\uEB3A",
	"tool.lsp": "\uEA61",
	"tool.gh": "\uEA84",
	"tool.webSearch": "\uEB01",
	"tool.exa": "\uEB68",
	"tool.browser": "\uEAAE",
	"tool.eval": "\uEBAF",
	"tool.debug": "\uEAD8",
	"tool.mcp": "\uEB2D",
	"tool.job": "\uEBA2",
	"tool.task": "\uf4a0",
	"tool.todo": "\uEAB3",
	"tool.memory": "\uEACE",
	"tool.ask": "\uEAC7",
	"tool.resolve": "\uEBB1",
	"tool.review": "\uEA70",
	"tool.inspectImage": "\uEAEA",
	"tool.goal": "\uEBF8",
	"tool.irc": "\uF086",
};

const ASCII_SYMBOLS: SymbolMap = {
	// Status Indicators
	"status.success": "[ok]",
	"status.error": "[!!]",
	"status.warning": "[!]",
	"status.info": "[i]",
	"status.pending": "[*]",
	"status.disabled": "[ ]",
	"status.enabled": "[x]",
	"status.running": "[~]",
	"status.shadowed": "[/]",
	"status.aborted": "[-]",
	"status.done": "*",
	// Navigation
	"nav.cursor": ">",
	"nav.selected": "->",
	"nav.expand": "+",
	"nav.collapse": "-",
	"nav.back": "<-",
	// Tree Connectors
	"tree.branch": "|--",
	"tree.last": "'--",
	"tree.vertical": "|",
	"tree.horizontal": "-",
	"tree.hook": "`-",
	// Box Drawing - Rounded (ASCII fallback)
	"boxRound.topLeft": "+",
	"boxRound.topRight": "+",
	"boxRound.bottomLeft": "+",
	"boxRound.bottomRight": "+",
	"boxRound.horizontal": "-",
	"boxRound.vertical": "|",
	// Box Drawing - Sharp (ASCII fallback)
	"boxSharp.topLeft": "+",
	"boxSharp.topRight": "+",
	"boxSharp.bottomLeft": "+",
	"boxSharp.bottomRight": "+",
	"boxSharp.horizontal": "-",
	"boxSharp.vertical": "|",
	"boxSharp.cross": "+",
	"boxSharp.teeDown": "+",
	"boxSharp.teeUp": "+",
	"boxSharp.teeRight": "+",
	"boxSharp.teeLeft": "+",
	// Separators
	"sep.powerline": ">",
	"sep.powerlineThin": ">",
	"sep.powerlineLeft": ">",
	"sep.powerlineRight": "<",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "#",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " - ",
	"sep.slash": " / ",
	"sep.pipe": " | ",
	// Icons
	"icon.model": "[M]",
	"icon.plan": "plan",
	"icon.goal": "goal",
	"icon.pause": "||",
	"icon.loop": "loop",
	"icon.folder": "[D]",
	"icon.search": "[/]",
	"icon.scratchFolder": "[T]",
	"icon.file": "[F]",
	"icon.git": "git:",
	"icon.branch": "@",
	"icon.pr": "PR",
	"icon.tokens": "tok:",
	"icon.context": "ctx:",
	"icon.cost": "$",
	"icon.time": "t:",
	"icon.pi": "pk",
	"icon.ghost": "@",
	"icon.agents": "AG",
	"icon.job": "bg",
	"icon.cache": "cache",
	"icon.cacheMiss": "!",
	"icon.input": "in:",
	"icon.output": "out:",
	"icon.host": "host",
	"icon.session": "id",
	"icon.package": "[P]",
	"icon.warning": "[!]",
	"icon.rewind": "<-",
	"icon.auto": "[A]",
	"icon.fast": ">>",
	"icon.extensionSkill": "SK",
	"icon.extensionTool": "TL",
	"icon.extensionSlashCommand": "/",
	"icon.extensionMcp": "MCP",
	"icon.extensionRule": "RL",
	"icon.extensionHook": "HK",
	"icon.extensionPrompt": "PR",
	"icon.extensionContextFile": "CF",
	"icon.extensionInstruction": "IN",
	// STT
	"icon.mic": "MIC",
	// Compaction divider
	"icon.camera": "[o]",
	// Thinking Levels
	"thinking.minimal": "[min]",
	"thinking.low": "[low]",
	"thinking.medium": "[med]",
	"thinking.high": "[high]",
	"thinking.xhigh": "[xhi]",
	"thinking.autoPending": "[~]",
	// Checkboxes
	"checkbox.checked": "[x]",
	"checkbox.unchecked": "[ ]",
	"radio.selected": "(o)",
	"radio.unselected": "( )",
	"format.bullet": "*",
	"format.dash": "-",
	"format.bracketLeft": "[",
	"format.bracketRight": "]",
	// Markdown-specific
	"md.quoteBorder": "|",
	"md.hrChar": "-",
	"md.bullet": "*",
	"md.colorSwatch": "[]",
	// Language icons (ASCII uses abbreviations)
	"lang.default": "code",
	"lang.typescript": "ts",
	"lang.javascript": "js",
	"lang.python": "py",
	"lang.rust": "rs",
	"lang.go": "go",
	"lang.java": "java",
	"lang.c": "c",
	"lang.cpp": "cpp",
	"lang.csharp": "cs",
	"lang.ruby": "rb",
	"lang.php": "php",
	"lang.swift": "swift",
	"lang.kotlin": "kt",
	"lang.shell": "sh",
	"lang.html": "html",
	"lang.css": "css",
	"lang.json": "json",
	"lang.yaml": "yaml",
	"lang.markdown": "md",
	"lang.sql": "sql",
	"lang.docker": "docker",
	"lang.lua": "lua",
	"lang.text": "txt",
	"lang.env": "env",
	"lang.toml": "toml",
	"lang.xml": "xml",
	"lang.ini": "ini",
	"lang.conf": "conf",
	"lang.log": "log",
	"lang.csv": "csv",
	"lang.tsv": "tsv",
	"lang.image": "img",
	"lang.pdf": "pdf",
	"lang.archive": "zip",
	"lang.binary": "bin",
	// Settings tab icons
	"tab.appearance": "[A]",
	"tab.model": "[M]",
	"tab.interaction": "[I]",
	"tab.context": "[X]",
	"tab.files": "[F]",
	"tab.shell": "[S]",
	"tab.tools": "[T]",
	"tab.memory": "[Y]",
	"tab.tasks": "[K]",
	"tab.providers": "[P]",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "+f",
	"tool.edit": "~",
	"tool.delete": "-f",
	"tool.move": "mv",
	"tool.bash": "$",
	"tool.ssh": "ssh",
	"tool.lsp": "lsp",
	"tool.gh": "gh",
	"tool.webSearch": "web",
	"tool.exa": "exa",
	"tool.browser": "[w]",
	"tool.eval": ">_",
	"tool.debug": "dbg",
	"tool.mcp": "<>",
	"tool.job": "job",
	"tool.task": ">>>",
	"tool.todo": "[x]",
	"tool.memory": "mem",
	"tool.ask": "[?]",
	"tool.resolve": "[v]",
	"tool.review": "rev",
	"tool.inspectImage": "[i]",
	"tool.goal": "(o)",
	"tool.irc": "irc",
};

const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
	unicode: UNICODE_SYMBOLS,
	nerd: NERD_SYMBOLS,
	ascii: ASCII_SYMBOLS,
};

export type SpinnerType = "status" | "activity";

const SPINNER_FRAMES: Record<SymbolPreset, Record<SpinnerType, string[]>> = {
	unicode: {
		status: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
		activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
	nerd: {
		status: ["󱑖", "󱑋", "󱑌", "󱑍", "󱑎", "󱑏", "󱑐", "󱑑", "󱑒", "󱑓", "󱑔", "󱑕"],
		activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
	ascii: {
		status: ["|", "/", "-", "\\"],
		activity: ["-", "\\", "|", "/"],
	},
};

/**
 * Shape accepted by `themeJson.symbols.spinnerFrames`. A flat array applies to
 * both spinner types; an object lets a theme override `status` and/or
 * `activity` independently. Anything not specified falls back to the symbol
 * preset's default frames.
 */
type SpinnerFramesOverride = string[] | { status?: string[]; activity?: string[] };

function normalizeSpinnerFramesOverride(
	value: SpinnerFramesOverride | undefined,
): Partial<Record<SpinnerType, string[]>> {
	if (value === undefined) return {};
	if (Array.isArray(value)) return { status: value, activity: value };
	const result: Partial<Record<SpinnerType, string[]>> = {};
	if (value.status) result.status = value.status;
	if (value.activity) result.activity = value.activity;
	return result;
}

// ============================================================================
// Types & Schema
// ============================================================================

type ColorValue = string | number;

const themeColorsSchema = type({
	accent: "string | number",
	border: "string | number",
	borderAccent: "string | number",
	borderMuted: "string | number",
	success: "string | number",
	error: "string | number",
	warning: "string | number",
	muted: "string | number",
	dim: "string | number",
	text: "string | number",
	thinkingText: "string | number",
	selectedBg: "string | number",
	userMessageBg: "string | number",
	userMessageText: "string | number",
	customMessageBg: "string | number",
	customMessageText: "string | number",
	customMessageLabel: "string | number",
	toolPendingBg: "string | number",
	toolSuccessBg: "string | number",
	toolErrorBg: "string | number",
	toolTitle: "string | number",
	toolOutput: "string | number",
	mdHeading: "string | number",
	mdLink: "string | number",
	mdLinkUrl: "string | number",
	mdCode: "string | number",
	mdCodeBlock: "string | number",
	mdCodeBlockBorder: "string | number",
	mdQuote: "string | number",
	mdQuoteBorder: "string | number",
	mdHr: "string | number",
	mdListBullet: "string | number",
	toolDiffAdded: "string | number",
	toolDiffRemoved: "string | number",
	toolDiffContext: "string | number",
	syntaxComment: "string | number",
	syntaxKeyword: "string | number",
	syntaxFunction: "string | number",
	syntaxVariable: "string | number",
	syntaxString: "string | number",
	syntaxNumber: "string | number",
	syntaxType: "string | number",
	syntaxOperator: "string | number",
	syntaxPunctuation: "string | number",
	thinkingOff: "string | number",
	thinkingMinimal: "string | number",
	thinkingLow: "string | number",
	thinkingMedium: "string | number",
	thinkingHigh: "string | number",
	thinkingXhigh: "string | number",
	bashMode: "string | number",
	pythonMode: "string | number",
	statusLineBg: "string | number",
	statusLineSep: "string | number",
	statusLineModel: "string | number",
	statusLinePath: "string | number",
	statusLineGitClean: "string | number",
	statusLineGitDirty: "string | number",
	statusLineContext: "string | number",
	statusLineSpend: "string | number",
	statusLineStaged: "string | number",
	statusLineDirty: "string | number",
	statusLineUntracked: "string | number",
	statusLineOutput: "string | number",
	statusLineCost: "string | number",
	statusLineSubagents: "string | number",
});
const spinnerFramesSchema = type("unknown").narrow((value): value is SpinnerFramesOverride => {
	if (Array.isArray(value)) {
		return value.length >= 1 && value.every(item => typeof item === "string");
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const status = obj.status;
		const activity = obj.activity;
		if (status === undefined && activity === undefined) return false;
		if (status !== undefined) {
			if (!Array.isArray(status) || status.length < 1 || !status.every(item => typeof item === "string")) {
				return false;
			}
		}
		if (activity !== undefined) {
			if (!Array.isArray(activity) || activity.length < 1 || !activity.every(item => typeof item === "string")) {
				return false;
			}
		}
		return true;
	}
	return false;
});
const themeJsonSchema = type({
	"$schema?": "string",
	name: "string",
	"vars?": "Record<string, string | number>",
	colors: themeColorsSchema,
	"export?": {
		"pageBg?": "string | number",
		"cardBg?": "string | number",
		"infoBg?": "string | number",
	},
	"symbols?": {
		"preset?": "'unicode' | 'nerd' | 'ascii'",
		"overrides?": "Record<string, string>",
		"spinnerFrames?": spinnerFramesSchema,
	},
});

type ThemeJson = typeof themeJsonSchema.infer;

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode"
	| "pythonMode"
	| "statusLineSep"
	| "statusLineModel"
	| "statusLinePath"
	| "statusLineGitClean"
	| "statusLineGitDirty"
	| "statusLineContext"
	| "statusLineSpend"
	| "statusLineStaged"
	| "statusLineDirty"
	| "statusLineUntracked"
	| "statusLineOutput"
	| "statusLineCost"
	| "statusLineSubagents";

/** Set of all valid ThemeColor string values for runtime validation */
const THEME_COLOR_RECORD = {
	accent: true,
	border: true,
	borderAccent: true,
	borderMuted: true,
	success: true,
	error: true,
	warning: true,
	muted: true,
	dim: true,
	text: true,
	thinkingText: true,
	userMessageText: true,
	customMessageText: true,
	customMessageLabel: true,
	toolTitle: true,
	toolOutput: true,
	mdHeading: true,
	mdLink: true,
	mdLinkUrl: true,
	mdCode: true,
	mdCodeBlock: true,
	mdCodeBlockBorder: true,
	mdQuote: true,
	mdQuoteBorder: true,
	mdHr: true,
	mdListBullet: true,
	toolDiffAdded: true,
	toolDiffRemoved: true,
	toolDiffContext: true,
	syntaxComment: true,
	syntaxKeyword: true,
	syntaxFunction: true,
	syntaxVariable: true,
	syntaxString: true,
	syntaxNumber: true,
	syntaxType: true,
	syntaxOperator: true,
	syntaxPunctuation: true,
	thinkingOff: true,
	thinkingMinimal: true,
	thinkingLow: true,
	thinkingMedium: true,
	thinkingHigh: true,
	thinkingXhigh: true,
	bashMode: true,
	pythonMode: true,
	statusLineSep: true,
	statusLineModel: true,
	statusLinePath: true,
	statusLineGitClean: true,
	statusLineGitDirty: true,
	statusLineContext: true,
	statusLineSpend: true,
	statusLineStaged: true,
	statusLineDirty: true,
	statusLineUntracked: true,
	statusLineOutput: true,
	statusLineCost: true,
	statusLineSubagents: true,
} satisfies Record<ThemeColor, true>;

const VALID_THEME_COLORS: ReadonlySet<string> = new Set(Object.keys(THEME_COLOR_RECORD));

/** Check if a string is a valid ThemeColor value */
export function isValidThemeColor(color: string): color is ThemeColor {
	return VALID_THEME_COLORS.has(color);
}

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "statusLineBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = Bun.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (Bun.env.WT_SESSION) {
		return "truecolor";
	}
	const term = Bun.env.TERM || "";
	// Only fall back to 256color for truly limited terminals
	if (term === "dumb" || term === "" || term === "linux") {
		return "256color";
	}
	// Assume truecolor for everything else - virtually all modern terminals support it
	return "truecolor";
}

function colorToAnsi(color: string, mode: ColorMode): string {
	const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
	const ansi = Bun.color(color, format);
	if (ansi === null) {
		throw new Error(`Invalid color value: ${color}`);
	}
	return ansi;
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (typeof color === "string") {
		return colorToAnsi(color, mode);
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	const ansi = colorToAnsi(color, mode);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

const langMap: Record<string, SymbolKey> = {
	typescript: "lang.typescript",
	ts: "lang.typescript",
	tsx: "lang.typescript",
	javascript: "lang.javascript",
	js: "lang.javascript",
	jsx: "lang.javascript",
	mjs: "lang.javascript",
	cjs: "lang.javascript",
	python: "lang.python",
	py: "lang.python",
	rust: "lang.rust",
	rs: "lang.rust",
	go: "lang.go",
	java: "lang.java",
	c: "lang.c",
	cpp: "lang.cpp",
	"c++": "lang.cpp",
	cc: "lang.cpp",
	cxx: "lang.cpp",
	csharp: "lang.csharp",
	cs: "lang.csharp",
	ruby: "lang.ruby",
	rb: "lang.ruby",
	php: "lang.php",
	swift: "lang.swift",
	kotlin: "lang.kotlin",
	kt: "lang.kotlin",
	bash: "lang.shell",
	sh: "lang.shell",
	zsh: "lang.shell",
	fish: "lang.shell",
	powershell: "lang.shell",
	just: "lang.shell",
	shell: "lang.shell",
	html: "lang.html",
	htm: "lang.html",
	astro: "lang.html",
	vue: "lang.html",
	svelte: "lang.html",
	css: "lang.css",
	scss: "lang.css",
	sass: "lang.css",
	less: "lang.css",
	json: "lang.json",
	yaml: "lang.yaml",
	yml: "lang.yaml",
	markdown: "lang.markdown",
	md: "lang.markdown",
	sql: "lang.sql",
	dockerfile: "lang.docker",
	docker: "lang.docker",
	lua: "lang.lua",
	text: "lang.text",
	txt: "lang.text",
	plain: "lang.text",
	log: "lang.log",
	env: "lang.env",
	dotenv: "lang.env",
	toml: "lang.toml",
	xml: "lang.xml",
	ini: "lang.ini",
	conf: "lang.conf",
	cfg: "lang.conf",
	config: "lang.conf",
	properties: "lang.conf",
	csv: "lang.csv",
	tsv: "lang.tsv",
	image: "lang.image",
	img: "lang.image",
	png: "lang.image",
	jpg: "lang.image",
	jpeg: "lang.image",
	gif: "lang.image",
	webp: "lang.image",
	svg: "lang.image",
	ico: "lang.image",
	bmp: "lang.image",
	tiff: "lang.image",
	pdf: "lang.pdf",
	zip: "lang.archive",
	tar: "lang.archive",
	gz: "lang.archive",
	tgz: "lang.archive",
	bz2: "lang.archive",
	xz: "lang.archive",
	"7z": "lang.archive",
	exe: "lang.binary",
	dll: "lang.binary",
	so: "lang.binary",
	dylib: "lang.binary",
	wasm: "lang.binary",
	bin: "lang.binary",
};

/**
 * Resolve a theme color value (hex string or 256-color index) to a CSS hex string.
 * Empty string represents the default terminal color.
 */
function resolveToHex(value: string | number, isLight: boolean): string {
	if (typeof value === "number") return ansi256ToHex(value);
	if (value === "") return isLight ? "#000000" : "#e5e5e7";
	return value;
}

export class Theme {
	#fgColors: Record<ThemeColor, string>;
	#bgColors: Record<ThemeBg, string>;
	/** Resolved hex strings for foreground colors — populated at construction. */
	readonly #hexFgColors: Record<ThemeColor, string>;
	/** Resolved hex strings for background colors — populated at construction. */
	readonly #hexBgColors: Record<ThemeBg, string>;
	#symbols: SymbolMap;
	#spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>>;
	/**
	 * Perceptual luma (0..1) of the status-line background — used to classify the
	 * theme light/dark. Undefined when it can't be resolved. Classified against the
	 * status line (the surface session accents render on) rather than the chat bubble
	 * (`userMessageBg`), which some themes (e.g. `porcelain`) style dark on an
	 * otherwise-light theme.
	 */
	readonly statusLineLuminance: number | undefined;
	/** WCAG relative luminance of the status-line background — basis for accent contrast. */
	readonly #statusLineContrastLuminance: number | undefined;
	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		private readonly mode: ColorMode,
		private readonly symbolPreset: SymbolPreset,
		symbolOverrides: Partial<Record<SymbolKey, string>>,
		spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>> = {},
	) {
		this.statusLineLuminance = colorLuma(bgColors.statusLineBg);
		this.#statusLineContrastLuminance = relativeLuminance(bgColors.statusLineBg);
		const slIsLight = this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;

		this.#fgColors = {} as Record<ThemeColor, string>;
		this.#hexFgColors = {} as Record<ThemeColor, string>;
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.#fgColors[key] = fgAnsi(value, mode);
			this.#hexFgColors[key] = resolveToHex(value, slIsLight);
		}
		this.#bgColors = {} as Record<ThemeBg, string>;
		this.#hexBgColors = {} as Record<ThemeBg, string>;
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.#bgColors[key] = bgAnsi(value, mode);
			this.#hexBgColors[key] = resolveToHex(value, slIsLight);
		}
		// Build symbol map from preset + overrides
		const baseSymbols = SYMBOL_PRESETS[symbolPreset];
		this.#symbols = { ...baseSymbols };
		for (const [key, value] of Object.entries(symbolOverrides)) {
			if (key in this.#symbols) {
				this.#symbols[key as SymbolKey] = value;
			} else {
				logger.debug("Invalid symbol key in override", { key, availableKeys: Object.keys(this.#symbols) });
			}
		}
		this.#spinnerFramesOverrides = spinnerFramesOverrides;
	}

	/** True when the active theme has a light status-line background. */
	get isLight(): boolean {
		return this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;
	}

	/**
	 * Surface luminance to size session accents against on light themes; undefined on
	 * dark themes so accents stay vivid. Pass straight to `getSessionAccentHex`.
	 */
	get accentSurfaceLuminance(): number | undefined {
		return this.isLight ? this.#statusLineContrastLuminance : undefined;
	}

	/**
	 * Get the resolved CSS hex string for a foreground theme color.
	 */
	getColorHex(color: ThemeColor): string {
		const hex = this.#hexFgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme color: ${color}`);
		return hex || (this.isLight ? "#000000" : "#e5e5e7");
	}

	/**
	 * Get all foreground and background theme colors as CSS hex strings.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
	getAllThemeColorHexes(): string[] {
		const hexes: string[] = [];
		for (const hex of Object.values(this.#hexFgColors)) {
			if (hex) hexes.push(hex);
		}
		for (const hex of Object.values(this.#hexBgColors)) {
			if (hex) hexes.push(hex);
		}
		return hexes;
	}

	/**
	 * Get the most visually dominant theme colors as CSS hex strings — accent,
	 * border, success, error, warning, heading, link, diff markers, etc.
	 * These are the colors the session accent could visually clash with.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
	getMajorThemeColorHexes(): string[] {
		const majors: ThemeColor[] = [
			"accent",
			"border",
			"borderAccent",
			"borderMuted",
			"success",
			"error",
			"warning",
			"mdHeading",
			"mdLink",
			"mdCode",
			"mdCodeBlock",
			"mdQuoteBorder",
			"mdListBullet",
			"toolDiffAdded",
			"toolDiffRemoved",
			"customMessageLabel",
			"thinkingText",
		];
		const hexes: string[] = [];
		for (const key of majors) {
			const hex = this.#hexFgColors[key];
			if (hex) hexes.push(hex);
		}
		return hexes;
	}
	/**
	 * Get the resolved CSS hex string for the theme's accent color.
	 */
	getAccentColorHex(): string {
		return this.getColorHex("accent");
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	/**
	 * Foreground ANSI for text drawn **on top of** `fillColor` used as a solid
	 * background (e.g. a powerline chip). Picks near-black or near-white by the
	 * fill's perceived luminance (Rec. 601 luma) so the label stays legible on
	 * both bright and dark fills, across light and dark themes.
	 *
	 * Reads the RGB out of the already-resolved truecolor escape; when the fill
	 * is encoded as a 256-palette index (limited terminals) the RGB is
	 * unavailable, so it falls back to the theme `text` color.
	 */
	getContrastFgAnsi(fillColor: ThemeColor): string {
		const ansi = this.#fgColors[fillColor];
		const match = ansi ? /38;2;(\d+);(\d+);(\d+)/.exec(ansi) : null;
		if (!match) return this.#fgColors.text;
		const luma = 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
		return luma > 140 ? "\x1b[38;2;0;0;0m" : "\x1b[38;2;255;255;255m";
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: ThinkingLevel | Effort): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
			case "max":
			case "ultra":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}

	getPythonModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("pythonMode", str);
	}

	// ============================================================================
	// Symbol Methods
	// ============================================================================

	/**
	 * Get a symbol by key.
	 */
	symbol(key: SymbolKey): string {
		return this.#symbols[key];
	}

	/**
	 * Get a symbol styled with a color.
	 */
	styledSymbol(key: SymbolKey, color: ThemeColor): string {
		return this.fg(color, this.#symbols[key]);
	}

	/**
	 * Get the current symbol preset.
	 */
	getSymbolPreset(): SymbolPreset {
		return this.symbolPreset;
	}

	// ============================================================================
	// Symbol Category Accessors
	// ============================================================================

	get status() {
		return {
			success: this.#symbols["status.success"],
			error: this.#symbols["status.error"],
			warning: this.#symbols["status.warning"],
			info: this.#symbols["status.info"],
			pending: this.#symbols["status.pending"],
			disabled: this.#symbols["status.disabled"],
			enabled: this.#symbols["status.enabled"],
			running: this.#symbols["status.running"],
			shadowed: this.#symbols["status.shadowed"],
			aborted: this.#symbols["status.aborted"],
			done: this.#symbols["status.done"],
		};
	}

	get nav() {
		return {
			cursor: this.#symbols["nav.cursor"],
			selected: this.#symbols["nav.selected"],
			expand: this.#symbols["nav.expand"],
			collapse: this.#symbols["nav.collapse"],
			back: this.#symbols["nav.back"],
		};
	}

	get tree() {
		return {
			branch: this.#symbols["tree.branch"],
			last: this.#symbols["tree.last"],
			vertical: this.#symbols["tree.vertical"],
			horizontal: this.#symbols["tree.horizontal"],
			hook: this.#symbols["tree.hook"],
		};
	}

	get boxRound() {
		return {
			topLeft: this.#symbols["boxRound.topLeft"],
			topRight: this.#symbols["boxRound.topRight"],
			bottomLeft: this.#symbols["boxRound.bottomLeft"],
			bottomRight: this.#symbols["boxRound.bottomRight"],
			horizontal: this.#symbols["boxRound.horizontal"],
			vertical: this.#symbols["boxRound.vertical"],
			// Junctions have no rounded Unicode variant, so a rounded box reuses the
			// sharp tee/cross glyphs. Sourcing them from the boxSharp.* tokens keeps a
			// theme's `boxSharp.tee*` overrides effective for rounded-box dividers.
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	get boxSharp() {
		return {
			topLeft: this.#symbols["boxSharp.topLeft"],
			topRight: this.#symbols["boxSharp.topRight"],
			bottomLeft: this.#symbols["boxSharp.bottomLeft"],
			bottomRight: this.#symbols["boxSharp.bottomRight"],
			horizontal: this.#symbols["boxSharp.horizontal"],
			vertical: this.#symbols["boxSharp.vertical"],
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	get sep() {
		return {
			powerline: this.#symbols["sep.powerline"],
			powerlineThin: this.#symbols["sep.powerlineThin"],
			powerlineLeft: this.#symbols["sep.powerlineLeft"],
			powerlineRight: this.#symbols["sep.powerlineRight"],
			powerlineThinLeft: this.#symbols["sep.powerlineThinLeft"],
			powerlineThinRight: this.#symbols["sep.powerlineThinRight"],
			block: this.#symbols["sep.block"],
			space: this.#symbols["sep.space"],
			asciiLeft: this.#symbols["sep.asciiLeft"],
			asciiRight: this.#symbols["sep.asciiRight"],
			dot: this.#symbols["sep.dot"],
			slash: this.#symbols["sep.slash"],
			pipe: this.#symbols["sep.pipe"],
		};
	}

	get icon() {
		return {
			model: this.#symbols["icon.model"],
			plan: this.#symbols["icon.plan"],
			goal: this.#symbols["icon.goal"],
			pause: this.#symbols["icon.pause"],
			loop: this.#symbols["icon.loop"],
			folder: this.#symbols["icon.folder"],
			scratchFolder: this.#symbols["icon.scratchFolder"],
			file: this.#symbols["icon.file"],
			git: this.#symbols["icon.git"],
			branch: this.#symbols["icon.branch"],
			pr: this.#symbols["icon.pr"],
			tokens: this.#symbols["icon.tokens"],
			context: this.#symbols["icon.context"],
			cost: this.#symbols["icon.cost"],
			time: this.#symbols["icon.time"],
			pi: this.#symbols["icon.pi"],
			ghost: this.#symbols["icon.ghost"],
			agents: this.#symbols["icon.agents"],
			job: this.#symbols["icon.job"],
			cache: this.#symbols["icon.cache"],
			cacheMiss: this.#symbols["icon.cacheMiss"],
			input: this.#symbols["icon.input"],
			output: this.#symbols["icon.output"],
			host: this.#symbols["icon.host"],
			session: this.#symbols["icon.session"],
			package: this.#symbols["icon.package"],
			warning: this.#symbols["icon.warning"],
			rewind: this.#symbols["icon.rewind"],
			auto: this.#symbols["icon.auto"],
			fast: this.#symbols["icon.fast"],
			extensionSkill: this.#symbols["icon.extensionSkill"],
			extensionTool: this.#symbols["icon.extensionTool"],
			extensionSlashCommand: this.#symbols["icon.extensionSlashCommand"],
			extensionMcp: this.#symbols["icon.extensionMcp"],
			extensionRule: this.#symbols["icon.extensionRule"],
			extensionHook: this.#symbols["icon.extensionHook"],
			extensionPrompt: this.#symbols["icon.extensionPrompt"],
			extensionContextFile: this.#symbols["icon.extensionContextFile"],
			extensionInstruction: this.#symbols["icon.extensionInstruction"],
			mic: this.#symbols["icon.mic"],
			camera: this.#symbols["icon.camera"],
		};
	}

	get thinking() {
		return {
			minimal: this.#symbols["thinking.minimal"],
			low: this.#symbols["thinking.low"],
			medium: this.#symbols["thinking.medium"],
			high: this.#symbols["thinking.high"],
			xhigh: this.#symbols["thinking.xhigh"],
			autoPending: this.#symbols["thinking.autoPending"],
		};
	}

	get checkbox() {
		return {
			checked: this.#symbols["checkbox.checked"],
			unchecked: this.#symbols["checkbox.unchecked"],
		};
	}

	get radio() {
		return {
			selected: this.#symbols["radio.selected"],
			unselected: this.#symbols["radio.unselected"],
		};
	}

	get format() {
		return {
			bullet: this.#symbols["format.bullet"],
			dash: this.#symbols["format.dash"],
			bracketLeft: this.#symbols["format.bracketLeft"],
			bracketRight: this.#symbols["format.bracketRight"],
		};
	}

	get md() {
		return {
			quoteBorder: this.#symbols["md.quoteBorder"],
			hrChar: this.#symbols["md.hrChar"],
			bullet: this.#symbols["md.bullet"],
			colorSwatch: this.#symbols["md.colorSwatch"],
		};
	}

	/**
	 * Default spinner frames (status spinner).
	 */
	get spinnerFrames(): string[] {
		return this.getSpinnerFrames();
	}

	/**
	 * Get spinner frames by type.
	 */
	getSpinnerFrames(type: SpinnerType = "status"): string[] {
		return this.#spinnerFramesOverrides[type] ?? SPINNER_FRAMES[this.symbolPreset][type];
	}

	/**
	 * Get language icon for a language name.
	 * Maps common language names to their corresponding symbol keys.
	 */
	getLangIcon(lang: string | undefined): string {
		if (!lang) return this.#symbols["lang.default"];
		const normalized = lang.toLowerCase();
		const key = langMap[normalized];
		return key ? this.#symbols[key] : this.#symbols["lang.default"];
	}

	/**
	 * Get a language icon with its standard styling applied — the muted
	 * foreground every renderer wraps {@link getLangIcon} in.
	 */
	getLangIconStyled(lang: string | undefined): string {
		return this.fg("muted", this.getLangIcon(lang));
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

const BUILTIN_THEMES: Record<string, ThemeJson> = {
	dark: darkThemeJson as ThemeJson,
	light: lightThemeJson as ThemeJson,
	...(defaultThemes as Record<string, ThemeJson>),
};

function getBuiltinThemes(): Record<string, ThemeJson> {
	return BUILTIN_THEMES;
}

export async function getAvailableThemes(): Promise<string[]> {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export async function getAvailableThemesWithPaths(): Promise<ThemeInfo[]> {
	const result: ThemeInfo[] = [];

	// Built-in themes (embedded, no file path)
	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: undefined });
	}

	// Custom themes
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				const name = file.slice(0, -5);
				if (!result.some(themeInfo => themeInfo.name === name)) {
					result.push({ name, path: path.join(customThemesDir, file) });
				}
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadThemeJson(name: string): Promise<ThemeJson> {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	let content: string;
	try {
		content = await Bun.file(themePath).text();
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Theme not found: ${name}`);
		throw err;
	}
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${error}`);
	}
	let parsed: ThemeJson;
	try {
		parsed = themeJsonSchema(json) as ThemeJson;
		if (parsed instanceof type.errors) {
			throw new Error(parsed.summary);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Extract color key information if available
		const missingColorMatch = errorMessage.match(/missing keys: (.+)/i);
		const missingColors: string[] = missingColorMatch ? missingColorMatch[1].split(",").map(s => s.trim()) : [];

		let fullErrorMessage = `Invalid theme "${name}":\n`;
		if (missingColors.length > 0) {
			fullErrorMessage += `\nMissing required color tokens:\n`;
			fullErrorMessage += missingColors.map(c => `  - ${c}`).join("\n");
			fullErrorMessage += `\n\nPlease add these colors to your theme's "colors" object.`;
			fullErrorMessage += `\nSee the built-in themes (dark.json, light.json) for reference values.`;
		}
		fullErrorMessage += `\n\nValidation error:\n  - ${errorMessage}`;

		throw new Error(fullErrorMessage);
	}
	return parsed;
}

interface CreateThemeOptions {
	mode?: ColorMode;
	symbolPresetOverride?: SymbolPreset;
	colorBlindMode?: boolean;
}

/** HSV adjustment to shift green toward blue for colorblind mode (red-green colorblindness) */
const COLORBLIND_ADJUSTMENT = { h: 60, s: 0.71 };

function createTheme(themeJson: ThemeJson, options: CreateThemeOptions = {}): Theme {
	const { mode, symbolPresetOverride, colorBlindMode } = options;
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);

	if (colorBlindMode) {
		const added = resolvedColors.toolDiffAdded;
		if (typeof added === "string" && added.startsWith("#")) {
			resolvedColors.toolDiffAdded = adjustHsv(added, COLORBLIND_ADJUSTMENT);
		}
	}

	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"statusLineBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	// Extract symbol configuration - settings override takes precedence over theme
	const symbolPreset: SymbolPreset = symbolPresetOverride ?? themeJson.symbols?.preset ?? "unicode";
	const symbolOverrides = themeJson.symbols?.overrides ?? {};
	const spinnerFramesOverrides = normalizeSpinnerFramesOverride(themeJson.symbols?.spinnerFrames);
	return new Theme(fgColors, bgColors, colorMode, symbolPreset, symbolOverrides, spinnerFramesOverrides);
}

async function loadTheme(name: string, options: CreateThemeOptions = {}): Promise<Theme> {
	const themeJson = await loadThemeJson(name);
	return createTheme(themeJson, options);
}

export async function getThemeByName(name: string): Promise<Theme | undefined> {
	try {
		return await loadTheme(name);
	} catch {
		return undefined;
	}
}

/** Appearance detected via OSC 11 background color query, or undefined if not yet available. */
var terminalReportedAppearance: "dark" | "light" | undefined;

/** Appearance reported by the macOS fallback observer, or undefined if not yet available. */
var macOSReportedAppearance: "dark" | "light" | undefined;

function shouldUseMacOSAppearanceFallback(): boolean {
	// Zellij currently breaks OSC 11 passthrough on macOS, so terminal-derived
	// appearance cannot be trusted there. Fall back to host macOS appearance
	// without letting it override valid terminal signals elsewhere.
	return process.platform === "darwin" && !!Bun.env.ZELLIJ;
}

function detectTerminalBackground(): "dark" | "light" {
	// Tier 1: terminal-reported appearance from OSC 11 luminance.
	if (!shouldUseMacOSAppearanceFallback() && terminalReportedAppearance) {
		return terminalReportedAppearance;
	}

	// Tier 2: COLORFGBG env var (static at process start, but still terminal-derived).
	const colorfgbg = Bun.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) return bg < 8 ? "dark" : "light";
		}
	}

	// Tier 3: host macOS appearance for known-broken terminal paths only.
	if (shouldUseMacOSAppearanceFallback()) {
		const macAppearance = macOSReportedAppearance ?? detectMacOSAppearance();
		if (macAppearance) return macAppearance;
	}

	return "dark";
}

function getDefaultTheme(): string {
	const bg = detectTerminalBackground();
	return bg === "light" ? autoLightTheme : autoDarkTheme;
}

// ============================================================================
// Global Theme Instance
// ============================================================================

export var theme: Theme;
var currentThemeName: string | undefined;

/** Get the name of the currently active theme. */
export function getCurrentThemeName(): string | undefined {
	return currentThemeName;
}

/** Returns unstyled `text` before `initTheme()` assigns the global theme; use only for early-render paths. */
export function fgOrPlain(color: ThemeColor, text: string, styledText: string = text): string {
	return typeof theme === "undefined" ? text : theme.fg(color, styledText);
}
var currentSymbolPresetOverride: SymbolPreset | undefined;
var currentColorBlindMode: boolean = false;
var themeWatcher: fs.FSWatcher | undefined;
var themeReloadTimer: NodeJS.Timeout | undefined;
var sigwinchHandler: (() => void) | undefined;
var autoDetectedTheme: boolean = false;
var autoDarkTheme: string = "dark";
var autoLightTheme: string = "light";
var onThemeChangeCallback: (() => void) | undefined;
var themeLoadRequestId: number = 0;
let themeEpoch = 0;

function getCurrentThemeOptions(): CreateThemeOptions {
	return {
		symbolPresetOverride: currentSymbolPresetOverride,
		colorBlindMode: currentColorBlindMode,
	};
}

export async function initTheme(
	enableWatcher: boolean = false,
	symbolPreset?: SymbolPreset,
	colorBlindMode?: boolean,
	darkTheme?: string,
	lightTheme?: string,
): Promise<void> {
	autoDetectedTheme = true;
	autoDarkTheme = darkTheme ?? "dark";
	autoLightTheme = lightTheme ?? "light";
	const name = getDefaultTheme();
	currentThemeName = name;
	currentSymbolPresetOverride = symbolPreset;
	currentColorBlindMode = colorBlindMode ?? false;
	try {
		theme = await loadTheme(name, getCurrentThemeOptions());
		if (enableWatcher) {
			await startThemeWatcher();
			startSigwinchListener();
		}
	} catch (err) {
		logger.debug("Theme loading failed, falling back to dark theme", { error: String(err) });
		currentThemeName = "dark";
		theme = await loadTheme("dark", getCurrentThemeOptions());
		// Don't start watcher for fallback theme
	}
}

export async function setTheme(
	name: string,
	enableWatcher: boolean = false,
): Promise<{ success: boolean; error?: string }> {
	autoDetectedTheme = false;
	currentThemeName = name;
	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(name, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme change superseded by a newer request" };
		}
		theme = loadedTheme;
		if (enableWatcher) {
			await startThemeWatcher();
		}
		notifyThemeChange();
		return { success: true };
	} catch (error) {
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme change superseded by a newer request" };
		}
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		theme = await loadTheme("dark", getCurrentThemeOptions());
		// The active theme just changed to the fallback — bump the epoch so memoized
		// renderers (e.g. ToolExecutionComponent) re-shape with the fallback colors
		// instead of holding the failed theme's stale styling.
		notifyThemeChange();
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function previewTheme(name: string): Promise<{ success: boolean; error?: string }> {
	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(name, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme preview superseded by a newer request" };
		}
		theme = loadedTheme;
		notifyThemeChange();
		return { success: true };
	} catch (error) {
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme preview superseded by a newer request" };
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Enable auto-detection mode, switching to the appropriate dark/light theme.
 */
export function enableAutoTheme(): void {
	autoDetectedTheme = true;
	reevaluateAutoTheme("enableAutoTheme");
}

/**
 * Update the theme mappings for auto-detection mode.
 * When a dark/light mapping changes and auto-detection is active, re-evaluate the theme.
 */
export function setAutoThemeMapping(mode: "dark" | "light", themeName: string): void {
	if (mode === "dark") autoDarkTheme = themeName;
	else autoLightTheme = themeName;
	reevaluateAutoTheme("setAutoThemeMapping");
}

/**
 * Called when the terminal detects a dark/light appearance change.
 * The terminal layer queries OSC 11 (background color) and computes luminance;
 * Mode 2031 notifications trigger re-queries rather than providing the value directly.
 */
export function onTerminalAppearanceChange(mode: "dark" | "light"): void {
	if (terminalReportedAppearance === mode) return;
	terminalReportedAppearance = mode;
	reevaluateAutoTheme("terminal appearance");
}

export function setThemeInstance(themeInstance: Theme): void {
	autoDetectedTheme = false;
	theme = themeInstance;
	currentThemeName = "<in-memory>";
	stopThemeWatcher();
	notifyThemeChange();
}

/**
 * Set the symbol preset override, recreating the theme with the new preset.
 */
export async function setSymbolPreset(preset: SymbolPreset): Promise<void> {
	currentSymbolPresetOverride = preset;
	if (!currentThemeName) return;

	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(currentThemeName, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) return;
		theme = loadedTheme;
	} catch {
		if (requestId !== themeLoadRequestId) return;
		// Fall back to dark theme with new preset
		theme = await loadTheme("dark", getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) return;
	}
	notifyThemeChange();
}

/**
 * Get the current symbol preset override.
 */
export function getSymbolPresetOverride(): SymbolPreset | undefined {
	return currentSymbolPresetOverride;
}

/**
 * Set color blind mode, recreating the theme with the new setting.
 * When enabled, uses blue instead of green for diff additions.
 */
export async function setColorBlindMode(enabled: boolean): Promise<void> {
	currentColorBlindMode = enabled;
	if (!currentThemeName) return;

	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(currentThemeName, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) return;
		theme = loadedTheme;
	} catch {
		if (requestId !== themeLoadRequestId) return;
		// Fall back to dark theme
		theme = await loadTheme("dark", getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) return;
	}
	notifyThemeChange();
}

/**
 * Get the current color blind mode setting.
 */
export function getColorBlindMode(): boolean {
	return currentColorBlindMode;
}

export function onThemeChange(callback: () => void): () => void {
	onThemeChangeCallback = callback;
	return () => {
		if (onThemeChangeCallback === callback) {
			onThemeChangeCallback = undefined;
		}
	};
}

/**
 * Monotonic counter bumped on any theme-affecting change that should invalidate
 * cached renders: theme swaps and reloads (including the invalid-theme dark
 * fallback), theme previews, symbol-preset changes, and color-blind-mode
 * changes — everything that routes through {@link notifyThemeChange}. Consumers
 * key cached renders on it so the next render re-shapes their output.
 */
export function getThemeEpoch(): number {
	return themeEpoch;
}

/** Bump the theme epoch and notify the registered theme-change listener. */
function notifyThemeChange(): void {
	themeEpoch++;
	onThemeChangeCallback?.();
}

/**
 * Get available symbol presets.
 */
export function getAvailableSymbolPresets(): SymbolPreset[] {
	return ["unicode", "nerd", "ascii"];
}

/**
 * Check if a string is a valid symbol preset.
 */
export function isValidSymbolPreset(preset: string): preset is SymbolPreset {
	return preset === "unicode" || preset === "nerd" || preset === "ascii";
}

async function startThemeWatcher(): Promise<void> {
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			loadTheme(watchedThemeName, getCurrentThemeOptions())
				.then(loadedTheme => {
					theme = loadedTheme;
					notifyThemeChange();
				})
				.catch(() => {
					// Ignore errors (file might be in invalid state while being edited)
				});
		}, 100);
	};

	try {
		themeWatcher = fs.watch(customThemesDir, (_eventType, filename) => {
			if (currentThemeName !== watchedThemeName) {
				return;
			}
			if (!filename) {
				scheduleReload();
				return;
			}
			const changedFile = String(filename);
			if (changedFile !== watchedFileName) {
				return;
			}
			scheduleReload();
		});
	} catch {
		// Ignore errors starting watcher
	}
}

/**
 * Shared logic for re-evaluating the auto-detected theme.
 * Called from SIGWINCH, terminal appearance change handler, and macOS fallback observer.
 */
function reevaluateAutoTheme(debugLabel: string): void {
	if (!autoDetectedTheme) return;
	const resolved = getDefaultTheme();
	if (resolved === currentThemeName) return;
	currentThemeName = resolved;
	loadTheme(resolved, getCurrentThemeOptions())
		.then(loadedTheme => {
			theme = loadedTheme;
			notifyThemeChange();
		})
		.catch(err => {
			logger.debug(`Theme switch on ${debugLabel} failed`, { error: String(err) });
		});
}

// ============================================================================
// macOS Appearance Fallback Observer
// ============================================================================

var macObserver: { stop(): void } | undefined;

function startMacAppearanceObserver(): void {
	stopMacAppearanceObserver();
	if (!shouldUseMacOSAppearanceFallback()) return;
	try {
		macOSReportedAppearance = detectMacOSAppearance() ?? undefined;
		macObserver = MacAppearanceObserver.start((err, appearance) => {
			if (!err && (appearance === "dark" || appearance === "light")) {
				macOSReportedAppearance = appearance;
				reevaluateAutoTheme("macOS fallback");
			}
		});
	} catch (err) {
		logger.warn("Failed to start macOS appearance observer", { err });
	}
}

function stopMacAppearanceObserver(): void {
	if (macObserver) {
		macObserver.stop();
		macObserver = undefined;
	}
	macOSReportedAppearance = undefined;
}

// ============================================================================
// SIGWINCH Listener
// ============================================================================

/** Re-check appearance on SIGWINCH and switch dark/light when using auto-detected theme. */
function startSigwinchListener(): void {
	stopSigwinchListener();
	sigwinchHandler = () => {
		reevaluateAutoTheme("SIGWINCH");
	};
	process.on("SIGWINCH", sigwinchHandler);
	startMacAppearanceObserver();
}

function stopSigwinchListener(): void {
	if (sigwinchHandler) {
		process.removeListener("SIGWINCH", sigwinchHandler);
		sigwinchHandler = undefined;
	}
	stopMacAppearanceObserver();
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
	stopSigwinchListener();
	terminalReportedAppearance = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Classify a parsed theme JSON as light/dark by the perceived luminance of its
 * status-line background. Mirrors {@link Theme.isLight} so the synchronous
 * helpers below stay in lockstep with the runtime classifier — see the comment
 * on `Theme.statusLineLuminance` for why `statusLineBg` is the source of truth
 * (themes like `porcelain` style a dark chat bubble on an otherwise-light
 * theme, so `userMessageBg` is unreliable).
 */
function isLightThemeJson(themeJson: ThemeJson): boolean {
	try {
		const resolved = resolveVarRefs(themeJson.colors.statusLineBg, themeJson.vars ?? {});
		const luminance = colorLuma(resolved);
		return luminance !== undefined && luminance > 0.5;
	} catch {
		return false;
	}
}

function getHtmlDefaultTextForSurface(surface: string | number | undefined): string {
	const luminance = surface === undefined ? undefined : colorLuma(surface);
	return luminance !== undefined && luminance > 0.5 ? "#000000" : "#e5e5e7";
}

function resolveThemeExportColors(themeJson: ThemeJson): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const exportSection = themeJson.export;
	if (!exportSection) return {};

	const vars = themeJson.vars ?? {};
	const resolve = (value: string | number | undefined): string | undefined => {
		if (value === undefined) return undefined;
		if (typeof value === "number") return ansi256ToHex(value);
		if (value === "" || value.startsWith("#")) return value;
		const varName = value.startsWith("$") ? value.slice(1) : value;
		if (varName in vars) {
			const resolved = resolveVarRefs(varName, vars);
			return typeof resolved === "number" ? ansi256ToHex(resolved) : resolved;
		}
		return value;
	};

	return {
		pageBg: resolve(exportSection.pageBg),
		cardBg: resolve(exportSection.cardBg),
		infoBg: resolve(exportSection.infoBg),
	};
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export async function getResolvedThemeColors(themeName?: string): Promise<Record<string, string>> {
	const name = themeName ?? getDefaultTheme();
	const themeJson = await loadThemeJson(name);
	const exportColors = resolveThemeExportColors(themeJson);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Empty foreground tokens use the terminal default color. In HTML export,
	// that default must contrast the export surface, not the TUI status line:
	// custom light themes can still export dark transcript cards when they omit
	// `export`, because generateThemeVars derives those cards from userMessageBg.
	const defaultText = getHtmlDefaultTextForSurface(
		exportColors.cardBg ?? exportColors.pageBg ?? resolved.userMessageBg,
	);

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Check if a theme is a "light" theme by analyzing its status-line background
 * luminance. Loads theme JSON synchronously (built-in or custom file on disk)
 * for callers in synchronous flows (settings migration, setup wizard).
 */
export function isLightTheme(themeName?: string): boolean {
	const name = themeName ?? "dark";
	const builtinThemes = getBuiltinThemes();
	let themeJson: ThemeJson | undefined;
	if (name in builtinThemes) {
		themeJson = builtinThemes[name];
	} else {
		try {
			const customPath = path.join(getCustomThemesDir(), `${name}.json`);
			const content = fs.readFileSync(customPath, "utf-8");
			themeJson = JSON.parse(content) as ThemeJson;
		} catch {
			return false;
		}
	}
	return isLightThemeJson(themeJson);
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export async function getThemeExportColors(themeName?: string): Promise<{
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
}> {
	const name = themeName ?? getDefaultTheme();
	try {
		const themeJson = await loadThemeJson(name);
		return resolveThemeExportColors(themeJson);
	} catch {
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

let cachedHighlightColorsFor: Theme | undefined;
let cachedHighlightColors: NativeHighlightColors | undefined;

function getHighlightColors(t: Theme): NativeHighlightColors {
	if (cachedHighlightColorsFor !== t || !cachedHighlightColors) {
		cachedHighlightColorsFor = t;
		cachedHighlightColors = {
			comment: t.getFgAnsi("syntaxComment"),
			keyword: t.getFgAnsi("syntaxKeyword"),
			function: t.getFgAnsi("syntaxFunction"),
			variable: t.getFgAnsi("syntaxVariable"),
			string: t.getFgAnsi("syntaxString"),
			number: t.getFgAnsi("syntaxNumber"),
			type: t.getFgAnsi("syntaxType"),
			operator: t.getFgAnsi("syntaxOperator"),
			punctuation: t.getFgAnsi("syntaxPunctuation"),
			inserted: t.getFgAnsi("toolDiffAdded"),
			deleted: t.getFgAnsi("toolDiffRemoved"),
		};
	}
	return cachedHighlightColors;
}

/**
 * Memoized native syntax highlight. Returns the joined ANSI string, or `null`
 * when the native tokenizer throws so callers can apply their own fallback.
 *
 * Keyed on `(lang, code)` and reset whenever the active `theme` instance
 * changes — the ANSI colors are baked into the highlighted output, so a theme
 * switch (which always reassigns `theme`) must invalidate every entry.
 *
 * Why this exists: animated tool blocks (eval/bash) repaint their box on every
 * ~33ms border-shimmer frame, and markdown re-lexes on every streamed delta.
 * Without memoization each frame can re-tokenize an unchanged code body through
 * the Rust FFI — ~26ms for 100 lines, ~40ms for 150 — consuming or overrunning
 * the 33ms frame budget and starving the spinner/render timers (the "TUI freeze").
 */
const HIGHLIGHT_CACHE_MAX = 256;
const highlightCache = new LRUCache<string, string>({ max: HIGHLIGHT_CACHE_MAX });
let highlightCacheTheme: Theme | undefined;

function highlightCached(code: string, validLang: string | undefined, highlightTheme: Theme): string | null {
	if (highlightCacheTheme !== highlightTheme) {
		highlightCache.clear();
		highlightCacheTheme = highlightTheme;
	}
	const key = `${validLang ?? ""}\x00${code}`;
	const hit = highlightCache.get(key);
	if (hit !== undefined) {
		return hit;
	}
	let highlighted: string;
	try {
		highlighted = nativeHighlightCode(code, validLang, getHighlightColors(highlightTheme));
	} catch {
		return null;
	}
	highlightCache.set(key, highlighted);
	return highlighted;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string, highlightTheme: Theme = theme): string[] {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	const highlighted = highlightCached(code, validLang, highlightTheme);
	// Always return a fresh array: callers (e.g. renderCodeCell) push extra lines
	// onto the result, which would corrupt the cached string otherwise.
	return (highlighted ?? code).split("\n");
}

export function getSymbolTheme(): SymbolTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). Fall back to the ASCII preset so the returned symbols are
	// usable instead of crashing. See #2998.
	if (typeof theme === "undefined") {
		const box = {
			topLeft: "+",
			topRight: "+",
			bottomLeft: "+",
			bottomRight: "+",
			horizontal: "-",
			vertical: "|",
			cross: "+",
			teeDown: "+",
			teeUp: "+",
			teeLeft: "+",
			teeRight: "+",
		};
		return {
			cursor: ">",
			inputCursor: "|",
			boxRound: box,
			boxSharp: box,
			table: box,
			quoteBorder: "|",
			hrChar: "-",
			colorSwatch: "[]",
			spinnerFrames: ["-", "\\", "|", "/"],
		};
	}
	const preset = theme.getSymbolPreset();

	return {
		cursor: theme.nav.cursor,
		inputCursor: preset === "ascii" ? "|" : "▏",
		boxRound: theme.boxRound,
		boxSharp: theme.boxSharp,
		table: theme.boxSharp,
		quoteBorder: theme.md.quoteBorder,
		hrChar: theme.md.hrChar,
		colorSwatch: theme.md.colorSwatch,
		spinnerFrames: theme.getSpinnerFrames("activity"),
	};
}

let cachedMarkdownTheme: MarkdownTheme | undefined;
let cachedMarkdownThemeRef: Theme | undefined;

/** Whether Markdown renders ```mermaid fences as ASCII diagrams. When off,
 *  the resolver returns null and the fence falls back to a highlighted code
 *  block. Read at call time, so toggling never invalidates the cached theme. */
let markdownMermaidRenderingEnabled = true;

export function setMarkdownMermaidRendering(enabled: boolean): void {
	markdownMermaidRenderingEnabled = enabled;
}

export function getMarkdownTheme(): MarkdownTheme {
	if (cachedMarkdownTheme !== undefined && cachedMarkdownThemeRef === theme) {
		return cachedMarkdownTheme;
	}
	// Mermaid ASCII diagrams render with the active palette so they read as
	// content rather than raw monochrome. Roles mirror the SVG renderer's
	// mapping; `text`/`muted`/`border`/`borderMuted`/`accent` exist in every theme.
	const mermaidColorMode = theme.getColorMode() === "truecolor" ? "truecolor" : "ansi256";
	const mermaidTheme = {
		fg: theme.getColorHex("text"),
		border: theme.getColorHex("border"),
		line: theme.getColorHex("muted"),
		arrow: theme.getColorHex("accent"),
		corner: theme.getColorHex("muted"),
		junction: theme.getColorHex("borderMuted"),
	};
	const markdownTheme: MarkdownTheme = {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		symbols: getSymbolTheme(),
		resolveMermaidAscii: (source, maxWidth) =>
			markdownMermaidRenderingEnabled
				? resolveMermaidAscii(source, { maxWidth, theme: mermaidTheme, colorMode: mermaidColorMode })
				: null,
		highlightCode: (code: string, lang?: string): string[] => {
			const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
			const highlighted = highlightCached(code, validLang, theme);
			if (highlighted !== null) return highlighted.split("\n");
			return code.split("\n").map(line => theme.fg("mdCodeBlock", line));
		},
	};
	cachedMarkdownTheme = markdownTheme;
	cachedMarkdownThemeRef = theme;
	return markdownTheme;
}

export function getSelectListTheme(): SelectListTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). See #2998.
	if (typeof theme === "undefined") {
		return {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
			symbols: getSymbolTheme(),
			hovered: (text: string) => text,
		};
	}
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		symbols: getSymbolTheme(),
		hovered: (text: string) => theme.bg("selectedBg", text),
	};
}

export function getEditorTheme(): EditorTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). See #2998.
	if (typeof theme === "undefined") {
		return {
			borderColor: (text: string) => text,
			selectList: getSelectListTheme(),
			symbols: getSymbolTheme(),
			hintStyle: (text: string) => text,
		};
	}
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		symbols: getSymbolTheme(),
		hintStyle: (text: string) => theme.fg("dim", text),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	// Plugins (e.g. pi-rtk-optimizer) may call this before `initTheme()` assigns
	// the global `theme`, or from a separate module instance under npm-global
	// installs where the live binding was never initialized. Fall back to plain
	// text so the call returns a usable (unstyled) theme instead of crashing with
	// "undefined is not an object (evaluating 'theme.fg')". See #2998.
	if (typeof theme === "undefined") {
		return {
			label: (text: string) => text,
			value: (text: string) => text,
			description: (text: string) => text,
			cursor: "> ",
			hint: (text: string) => text,
			heading: (text: string) => text,
			section: (text: string) => text,
			hovered: (text: string) => text,
		};
	}
	return {
		label: (text: string, selected: boolean, changed: boolean) =>
			changed ? theme.fg("statusLineGitDirty", text) : selected ? theme.fg("accent", text) : text,
		value: (text: string, selected: boolean, changed: boolean) =>
			changed ? theme.fg("statusLineGitDirty", text) : selected ? theme.fg("accent", text) : theme.fg("muted", text),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", `${theme.nav.cursor} `),
		hint: (text: string) => theme.fg("dim", text),
		heading: (text: string, dimmed: boolean) =>
			dimmed ? theme.fg("dim", theme.underline(text)) : theme.fg("muted", theme.bold(theme.underline(text))),
		section: (text: string, active: boolean) =>
			active ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text),
		hovered: (text: string) => theme.bg("selectedBg", text),
	};
}
