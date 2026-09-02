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
	// Progress Bar
	| "progress.filled"
	| "progress.empty"
	// Context gauge boundaries
	| "context.speculation"
	| "context.compaction"
	// Box Drawing - Rounded
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box Drawing - Dotted (selection outlines)
	| "boxDotted.horizontal"
	| "boxDotted.vertical"
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
	| "sep.powerlineCapLeft"
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
	| "icon.prewalk"
	| "icon.goal"
	| "icon.pause"
	| "icon.loop"
	| "icon.folder"
	| "icon.worktree"
	| "icon.search"
	| "icon.scratchFolder"
	| "icon.file"
	| "icon.git"
	| "icon.branch"
	| "icon.pr"
	| "icon.pin"
	| "icon.tokens"
	| "icon.context"
	| "icon.cost"
	| "icon.subscription"
	| "icon.advisor"
	| "icon.advisorClosed"
	| "icon.time"
	| "icon.omp"
	| "icon.esc"
	| "icon.ghost"
	| "icon.agents"
	| "icon.job"
	| "icon.cache"
	| "icon.cacheMiss"
	| "icon.input"
	| "icon.output"
	| "icon.throughput"
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
	// Slash-command type indicators (autocomplete); names without an existing
	// icon.* equivalent — see SlashCommandIconName for the full vocabulary.
	| "cmd.action"
	| "cmd.prompt"
	| "cmd.extension"
	| "cmd.settings"
	| "cmd.gear"
	| "cmd.shield"
	| "cmd.wave"
	| "cmd.compass"
	| "cmd.inbox"
	| "cmd.swap"
	| "cmd.expand"
	| "cmd.computer"
	| "cmd.eye"
	| "cmd.todo"
	| "cmd.stats"
	| "cmd.news"
	| "cmd.keyboard"
	| "cmd.export"
	| "cmd.clipboard"
	| "cmd.share"
	| "cmd.broadcast"
	| "cmd.globe"
	| "cmd.copy"
	| "cmd.plus"
	| "cmd.restart"
	| "cmd.eraser"
	| "cmd.trash"
	| "cmd.compress"
	| "cmd.vibrate"
	| "cmd.handoff"
	| "cmd.history"
	| "cmd.question"
	| "cmd.rocket"
	| "cmd.stethoscope"
	| "cmd.redo"
	| "cmd.bug"
	| "cmd.memory"
	| "cmd.pencil"
	| "cmd.folderMove"
	| "cmd.folderPlus"
	| "cmd.folderMinus"
	| "cmd.hammer"
	| "cmd.power"
	| "cmd.cart"
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
	| "thinking.max"
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
	// Advisor note rail
	| "advisor.rail"
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
	| "lang.julia"
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
	// Composer attachment chips (image paste / large text paste)
	| "chip.image"
	| "chip.paste"
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
	| "tool.launch"
	| "tool.task"
	| "tool.todo"
	| "tool.memory"
	| "tool.ask"
	| "tool.resolve"
	| "tool.review"
	| "tool.inspectImage"
	| "tool.goal"
	| "tool.irc"
	| "tool.delete"
	| "tool.move";

export type SymbolMap = Record<SymbolKey, string>;
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
	"status.shadowed": "○",
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
	// Progress bar
	"progress.filled": "━",
	"progress.empty": "─",
	// Context gauge boundaries
	"context.speculation": "╎",
	"context.compaction": "┃",
	// Box (rounded)
	"boxRound.topLeft": "╭",
	"boxRound.topRight": "╮",
	"boxRound.bottomLeft": "╰",
	"boxRound.bottomRight": "╯",
	"boxRound.horizontal": "─",
	"boxRound.vertical": "│",
	// Box (dotted)
	"boxDotted.horizontal": "┄",
	"boxDotted.vertical": "┆",
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
	// Soft band opening cap: no unicode equivalent, bands start flat.
	"sep.powerlineCapLeft": "",
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
	"icon.prewalk": "🏃",
	"icon.goal": "🎯",
	"icon.pause": "⏸",
	"icon.loop": "↻",
	"icon.folder": "📁",
	"icon.worktree": "🌳",
	"icon.search": "🔍",
	"icon.scratchFolder": "🗑",
	"icon.file": "📄",
	"icon.git": "⎇",
	"icon.branch": "⑂",
	"icon.pr": "⤴",
	"icon.pin": "📌",
	"icon.tokens": "🪙",
	"icon.context": "◫",
	"icon.cost": "💲",
	"icon.subscription": "(sub)",
	"icon.advisor": "👁",
	"icon.advisorClosed": "🙈",
	"icon.time": "⏱",
	"icon.omp": "π",
	"icon.esc": "⎋",
	"icon.ghost": "👻",
	"icon.agents": "👥",
	"icon.job": "⚙",
	"icon.cache": "💾",
	"icon.cacheMiss": "⊘",
	"icon.input": "⤵",
	"icon.output": "⤴",
	"icon.throughput": "⚡",
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
	// Slash-command type indicators
	"cmd.action": "❯",
	"cmd.prompt": "✎",
	"cmd.extension": "🧩",
	"cmd.settings": "🎛",
	"cmd.gear": "⚙",
	"cmd.shield": "🛡",
	"cmd.wave": "∿",
	"cmd.compass": "🧭",
	"cmd.inbox": "📥",
	"cmd.swap": "⇄",
	"cmd.expand": "⤢",
	"cmd.computer": "🖥",
	"cmd.eye": "👁",
	"cmd.todo": "☑",
	"cmd.stats": "📊",
	"cmd.news": "📰",
	"cmd.keyboard": "⌨",
	"cmd.export": "📤",
	"cmd.clipboard": "📋",
	"cmd.share": "↗",
	"cmd.broadcast": "📡",
	"cmd.globe": "🌐",
	"cmd.copy": "⧉",
	"cmd.plus": "✚",
	"cmd.restart": "↻",
	"cmd.eraser": "🧹",
	"cmd.trash": "🗑",
	"cmd.compress": "🗜",
	"cmd.vibrate": "📳",
	"cmd.handoff": "➦",
	"cmd.history": "🕘",
	"cmd.question": "❓",
	"cmd.rocket": "🚀",
	"cmd.stethoscope": "🩺",
	"cmd.redo": "🔁",
	"cmd.bug": "🐛",
	"cmd.memory": "🧠",
	"cmd.pencil": "✏",
	"cmd.folderMove": "📂",
	"cmd.folderPlus": "📁",
	"cmd.folderMinus": "📁",
	"cmd.hammer": "🔨",
	"cmd.power": "⏻",
	"cmd.cart": "🛒",
	// STT
	"icon.mic": "🎤",
	// Compaction divider
	"icon.camera": "📷",
	// Thinking levels
	"thinking.minimal": "○ min",
	"thinking.low": "◔ low",
	"thinking.medium": "◑ med",
	"thinking.high": "◒ high",
	"thinking.xhigh": "◕ xhigh",
	"thinking.max": "◉ max",
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
	// Advisor note rail (heavier than md.quoteBorder so notes read as a distinct voice)
	"advisor.rail": "▎",
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
	"lang.julia": "Ⓙ",
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
	// Composer attachment chips
	"chip.image": "🖼",
	"chip.paste": "📄",
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
	"tool.launch": "🚀",
	"tool.task": "⇶",
	"tool.todo": "☑",
	"tool.memory": "🧠",
	"tool.ask": "?",
	"tool.resolve": "✓",
	"tool.review": "◉",
	"tool.inspectImage": "🖼",
	"tool.goal": "◎",
	"tool.irc": "✉",
	"tool.delete": "🗑",
	"tool.move": "➜",
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
	// pick:  (nf-fa-circle_o, pairs with status.enabled's nf-fa-circle) | alt: ◐ ◑
	"status.shadowed": "\uf10c",
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
	// Progress Bar (same as unicode)
	// pick: ━ | alt: ▰ ▮ ■
	"progress.filled": "━",
	// pick: ─ | alt: ▱ ▯ ╌
	"progress.empty": "─",
	// Context gauge boundaries — vector intersection starts async speculation; auto-fix applies compaction.
	"context.speculation": "\u{f055d}",
	"context.compaction": "\u{f0068}",
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
	// Box Drawing - Dotted (same as unicode)
	// pick: ┄ | alt: ╌ ┈ ⋯
	"boxDotted.horizontal": "┄",
	// pick: ┆ | alt: ╎ ┊ ⋮
	"boxDotted.vertical": "┆",
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
	// pick:  | alt: 
	"sep.powerlineCapLeft": "\ue0b6",
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
	"icon.prewalk": "\uf29d",
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
	// pick: nf-fa-sitemap | alt: nf-cod-list_tree
	"icon.worktree": "\uf0e8",
	// pick:  | alt:  
	"icon.file": "\uf15b",
	// pick:  | alt:  ⎇
	"icon.git": "\uf1d3",
	// pick:  | alt:  ⎇
	"icon.branch": "\uf126",
	// pick:  (nf-cod-git_pull_request) | alt:  (nf-oct-git_pull_request)
	"icon.pr": "\uea64",
	// pick:  (nf-fa-thumb_tack) | alt:  󰐃
	"icon.pin": "\uf08d",
	// pick:  | alt: ⊛ ◍ 
	"icon.tokens": "\ue26b",
	// pick:  (nf-cod-window) | alt:  (nf-cod-empty_window) ◫ ▦
	"icon.context": "\ueb7f",
	// pick:  | alt: $ ¢
	"icon.cost": "\uf155",
	// pick: 󰙺 (nf-md-currency_usd_off)
	"icon.subscription": "\u{f067a}",
	// pick:  (nf-cod-eye)
	"icon.advisor": "\uea70",
	// pick:  (nf-oct-eye_closed)
	"icon.advisorClosed": "\ueae7",
	// pick:  | alt: ◷ ◴
	"icon.time": "\uf017",
	// pick: 󰵗 (nf-md-pi) | alt:  π ∏ ∑
	"icon.omp": "\u{f0d57}",
	// pick: 󱊷 (nf-md-keyboard_esc) | alt: ⎋
	"icon.esc": "\u{f12b7}",
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
	// pick:  (nf-fa-tachometer) | alt:  ⚡ ↬
	"icon.throughput": "\uf0e4",
	// pick:  | alt:  
	"icon.host": "\uf109",
	// pick: 󰁑 (nf-md-arrow_left_bold_hexagon_outline) | alt:  
	"icon.session": "\u{f0051}",
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
	// Slash-command type indicators
	// pick:  (nf-cod-terminal) | alt:  (nf-fa-terminal)
	"cmd.action": "\uea85",
	// pick: 󰺫 (nf-md-text_box_plus_outline) | alt:  (nf-fa-comment, matches icon.extensionPrompt)
	"cmd.prompt": "\u{f0eab}",
	// pick:  (nf-fa-puzzle_piece) | alt: 󰐱 (nf-md-puzzle)
	"cmd.extension": "\uf12e",
	// pick:  (nf-fa-sliders) | alt:  (nf-cod-settings)
	"cmd.settings": "\uf1de",
	// pick:  (nf-cod-settings_gear)
	"cmd.gear": "\ueb51",
	// pick:  (nf-fa-shield) | alt:  (nf-cod-shield)
	"cmd.shield": "\uf132",
	// pick: 󰥛 (nf-md-sine_wave)
	"cmd.wave": "\u{f095b}",
	// pick:  (nf-fa-compass) | alt: 󰆌 (nf-md-compass)
	"cmd.compass": "\uf14e",
	// pick:  (nf-fa-inbox) | alt:  (nf-cod-inbox)
	"cmd.inbox": "\uf01c",
	// pick: 󰓡 (nf-md-swap_horizontal)
	"cmd.swap": "\u{f04e1}",
	// pick: 󰁌 (nf-md-arrow_expand_all) | alt: 󰘖 (nf-md-arrow_expand)
	"cmd.expand": "\u{f004c}",
	// pick:  (nf-fa-desktop) | alt:  (nf-oct-device_desktop)
	"cmd.computer": "\uf108",
	// pick:  (nf-fa-eye) | alt:  (nf-cod-eye, matches icon.advisor)
	"cmd.eye": "\uf06e",
	// pick:  (nf-fa-tasks) | alt:  (nf-cod-checklist)
	"cmd.todo": "\uf0ae",
	// pick:  (nf-fa-bar_chart) | alt: 󰄨 (nf-md-chart_bar)
	"cmd.stats": "\uf080",
	// pick:  (nf-fa-newspaper_o) | alt: 󰎕 (nf-md-newspaper)
	"cmd.news": "\uf1ea",
	// pick:  (nf-fa-keyboard_o) | alt: 󰌌 (nf-md-keyboard)
	"cmd.keyboard": "\uf11c",
	// pick:  (nf-fa-external_link) | alt:  (nf-cod-link_external)
	"cmd.export": "\uf08e",
	// pick:  (nf-fa-clipboard) | alt: 󰅇 (nf-md-clipboard)
	"cmd.clipboard": "\uf0ea",
	// pick:  (nf-fa-share_alt)
	"cmd.share": "\uf1e0",
	// pick:  (nf-cod-broadcast) | alt: 󱜠 (nf-md-broadcast)
	"cmd.broadcast": "\ueaad",
	// pick:  (nf-fa-globe) | alt:  (nf-cod-globe)
	"cmd.globe": "\uf0ac",
	// pick:  (nf-fa-copy) | alt:  (nf-cod-copy)
	"cmd.copy": "\uf0c5",
	// pick:  (nf-fa-circle_plus) | alt:  (nf-cod-add)
	"cmd.plus": "\uf055",
	// pick: 󰜉 (nf-md-restart) | alt:  (nf-cod-sync)
	"cmd.restart": "\u{f0709}",
	// pick:  (nf-fa-eraser) | alt: 󰇾 (nf-md-eraser)
	"cmd.eraser": "\uf12d",
	// pick:  (nf-fa-trash_can) | alt: 󰩹 (nf-md-trash_can)
	"cmd.trash": "\uf014",
	// pick:  (nf-fa-compress)
	"cmd.compress": "\uf066",
	// pick: 󰕦 (nf-md-vibrate)
	"cmd.vibrate": "\u{f0566}",
	// pick:  (nf-fa-mail_forward)
	"cmd.handoff": "\uf064",
	// pick: 󰋚 (nf-md-history) | alt:  (nf-fa-history)
	"cmd.history": "\u{f02da}",
	// pick:  (nf-fa-question_circle) | alt: 󰋗 (nf-md-help_circle)
	"cmd.question": "\uf059",
	// pick:  (nf-fa-rocket) | alt:  (nf-cod-rocket)
	"cmd.rocket": "\uf135",
	// pick:  (nf-fa-stethoscope) | alt: 󰓙 (nf-md-stethoscope)
	"cmd.stethoscope": "\uf0f1",
	// pick: 󰑎 (nf-md-redo) | alt:  (nf-cod-redo)
	"cmd.redo": "\u{f044e}",
	// pick:  (nf-fa-bug) | alt:  (nf-cod-bug)
	"cmd.bug": "\uf188",
	// pick: 󰍛 (nf-md-memory) | alt:  (nf-oct-cpu)
	"cmd.memory": "\u{f035b}",
	// pick:  (nf-fa-edit) | alt:  (nf-cod-edit)
	"cmd.pencil": "\uf044",
	// pick: 󰉒 (nf-md-folder_move)
	"cmd.folderMove": "\u{f0252}",
	// pick: 󰉗 (nf-md-folder_plus)
	"cmd.folderPlus": "\u{f0257}",
	// pick: 󰉘 (nf-md-folder_remove)
	"cmd.folderMinus": "\u{f0258}",
	// pick: 󰣪 (nf-md-hammer)
	"cmd.hammer": "\u{f08ea}",
	// pick:  (nf-fa-power_off) | alt: 󰤆 (nf-md-power_off)
	"cmd.power": "\uf011",
	// pick:  (nf-fa-shopping_cart) | alt: 󰄋 (nf-md-cart)
	"cmd.cart": "\uf07a",
	// STT - fa-microphone
	"icon.mic": "\uf130",
	// Compaction divider - fa-camera-retro
	"icon.camera": "\uf083",
	// Thinking levels — increasing circle slices, with fire reserved for max.
	"thinking.minimal": "\u{F0A9E} min",
	"thinking.low": "\u{F0A9F} low",
	"thinking.medium": "\u{F0AA1} med",
	"thinking.high": "\u{F0AA3} high",
	"thinking.xhigh": "\u{F0AA5} xhi",
	"thinking.max": "\u{F06D} max",
	// Auto mode uses shuffle until the model resolves its thinking level.
	"thinking.autoPending": "\u{F074}",
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
	// pick: ▎ | alt: ┃ │
	"advisor.rail": "▎",
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
	"lang.csharp": "\u{E7B2}",
	"lang.ruby": "\u{E791}",
	"lang.julia": "\u{E624}",
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
	// Composer attachment chips
	// pick:  (fa-image, matches omp2) | alt: 󰋩 (md-image) 󰈟 (md-file_image)
	"chip.image": "\uf03e",
	// pick:  (fa-file_text, matches omp2) | alt: 󰈙 (md-file_document)  (cod-file)
	"chip.paste": "\uf15c",
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
	"tool.launch": "\uF135",
	"tool.task": "\uf4a0",
	"tool.todo": "\uEAB3",
	"tool.memory": "\uEACE",
	"tool.ask": "\uEAC7",
	"tool.resolve": "\uEBB1",
	"tool.review": "\uEA70",
	"tool.inspectImage": "\uEAEA",
	"tool.goal": "\uEBF8",
	"tool.irc": "\uF086",
	"tool.delete": "\uf12d",
	"tool.move": "\uf061",
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
	// Progress Bar
	"progress.filled": "=",
	"progress.empty": "-",
	// Context gauge boundaries
	"context.speculation": ":",
	"context.compaction": "|",
	// Box Drawing - Rounded (ASCII fallback)
	"boxRound.topLeft": "+",
	"boxRound.topRight": "+",
	"boxRound.bottomLeft": "+",
	"boxRound.bottomRight": "+",
	"boxRound.horizontal": "-",
	"boxRound.vertical": "|",
	// Box Drawing - Dotted (ASCII fallback)
	"boxDotted.horizontal": "-",
	"boxDotted.vertical": ":",
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
	"sep.powerlineCapLeft": "",
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
	"icon.prewalk": "prewalk",
	"icon.goal": "goal",
	"icon.pause": "||",
	"icon.loop": "loop",
	"icon.folder": "[D]",
	"icon.worktree": "[wt]",
	"icon.search": "[/]",
	"icon.scratchFolder": "[T]",
	"icon.file": "[F]",
	"icon.git": "git:",
	"icon.branch": "@",
	"icon.pr": "PR",
	"icon.pin": "*",
	"icon.tokens": "tok:",
	"icon.context": "ctx:",
	"icon.cost": "$",
	"icon.subscription": "(sub)",
	"icon.advisor": "(adv)",
	"icon.advisorClosed": "(adv)",
	"icon.time": "t:",
	"icon.omp": "pi",
	"icon.esc": "esc",
	"icon.ghost": "@",
	"icon.agents": "AG",
	"icon.job": "bg",
	"icon.output": "out:",
	"icon.throughput": "tok/s:",
	"icon.cache": "cache",
	"icon.cacheMiss": "!",
	"icon.input": "in:",
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
	// Slash-command type indicators — unused; the icon column is disabled in ASCII mode
	"cmd.action": "",
	"cmd.prompt": "",
	"cmd.extension": "",
	"cmd.settings": "",
	"cmd.gear": "",
	"cmd.shield": "",
	"cmd.wave": "",
	"cmd.compass": "",
	"cmd.inbox": "",
	"cmd.swap": "",
	"cmd.expand": "",
	"cmd.computer": "",
	"cmd.eye": "",
	"cmd.todo": "",
	"cmd.stats": "",
	"cmd.news": "",
	"cmd.keyboard": "",
	"cmd.export": "",
	"cmd.clipboard": "",
	"cmd.share": "",
	"cmd.broadcast": "",
	"cmd.globe": "",
	"cmd.copy": "",
	"cmd.plus": "",
	"cmd.restart": "",
	"cmd.eraser": "",
	"cmd.trash": "",
	"cmd.compress": "",
	"cmd.vibrate": "",
	"cmd.handoff": "",
	"cmd.history": "",
	"cmd.question": "",
	"cmd.rocket": "",
	"cmd.stethoscope": "",
	"cmd.redo": "",
	"cmd.bug": "",
	"cmd.memory": "",
	"cmd.pencil": "",
	"cmd.folderMove": "",
	"cmd.folderPlus": "",
	"cmd.folderMinus": "",
	"cmd.hammer": "",
	"cmd.power": "",
	"cmd.cart": "",
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
	"thinking.max": "[max]",
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
	"advisor.rail": "|",
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
	"lang.julia": "jl",
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
	// Composer attachment chips
	"chip.image": "img",
	"chip.paste": "txt",
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
	"tool.launch": "run",
	"tool.task": ">>>",
	"tool.todo": "[x]",
	"tool.memory": "mem",
	"tool.ask": "[?]",
	"tool.resolve": "[v]",
	"tool.review": "rev",
	"tool.inspectImage": "[i]",
	"tool.goal": "(o)",
	"tool.irc": "#",
	"tool.delete": "rm",
	"tool.move": "mv",
};

export const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
	unicode: UNICODE_SYMBOLS,
	nerd: NERD_SYMBOLS,
	ascii: ASCII_SYMBOLS,
};

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
export type SpinnerFramesOverride = string[] | { status?: string[]; activity?: string[] };

export function normalizeSpinnerFramesOverride(
	value: SpinnerFramesOverride | undefined,
): Partial<Record<SpinnerType, string[]>> {
	if (value === undefined) return {};
	if (Array.isArray(value)) return { status: value, activity: value };
	const result: Partial<Record<SpinnerType, string[]>> = {};
	if (value.status) result.status = value.status;
	if (value.activity) result.activity = value.activity;
	return result;
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
