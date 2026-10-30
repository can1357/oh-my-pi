import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { combine, register } from "../config/registry";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgBashEnabled } from "../exec/settings";
import { cfgCompactionExperimentalContextManagement } from "../session/context-settings";
import { cfgEvalJs, cfgEvalPy } from "../eval/settings";
import { cfgIdaAvailable } from "../ida/install";
import { cfgLspEnabled } from "../lsp/settings";
import { cfgTaskMaxRecursionDepth } from "../task/settings";

const EMPTY_STRING_ARRAY: string[] = [];

export const cfgToolsArtifactSpillThreshold = register({
	id: "tools.artifactSpillThreshold",
	type: "number",
	default: 50,
	ui: {
		tab: "tools",
		group: "Output Limits",
		label: __ompTranslate("Artifact Spill Threshold (KB)"),
		description: "Tool output above this size is saved as an artifact; tail is kept inline",
		options: [
			{ value: "1", label: "1 KB", description: __ompTranslate("~250 tokens") },
			{ value: "2.5", label: "2.5 KB", description: __ompTranslate("~625 tokens") },
			{ value: "5", label: "5 KB", description: __ompTranslate("~1.25K tokens") },
			{ value: "10", label: "10 KB", description: __ompTranslate("~2.5K tokens") },
			{ value: "20", label: "20 KB", description: __ompTranslate("~5K tokens") },
			{ value: "30", label: "30 KB", description: __ompTranslate("~7.5K tokens") },
			{ value: "50", label: "50 KB", description: __ompTranslate("Default; ~12.5K tokens") },
			{ value: "75", label: "75 KB", description: __ompTranslate("~19K tokens") },
			{ value: "100", label: "100 KB", description: __ompTranslate("~25K tokens") },
			{ value: "200", label: "200 KB", description: __ompTranslate("~50K tokens") },
			{ value: "500", label: "500 KB", description: __ompTranslate("~125K tokens") },
			{ value: "1000", label: "1 MB", description: __ompTranslate("~250K tokens") },
		],
	},
});

export const cfgToolsArtifactTailBytes = register({
	id: "tools.artifactTailBytes",
	type: "number",
	default: 20,
	ui: {
		tab: "tools",
		group: "Output Limits",
		label: __ompTranslate("Artifact Tail Size (KB)"),
		description: "Amount of tail content kept inline when output spills to artifact",
		options: [
			{ value: "1", label: "1 KB", description: __ompTranslate("~250 tokens") },
			{ value: "2.5", label: "2.5 KB", description: __ompTranslate("~625 tokens") },
			{ value: "5", label: "5 KB", description: __ompTranslate("~1.25K tokens") },
			{ value: "10", label: "10 KB", description: __ompTranslate("~2.5K tokens") },
			{ value: "20", label: "20 KB", description: __ompTranslate("Default; ~5K tokens") },
			{ value: "50", label: "50 KB", description: __ompTranslate("~12.5K tokens") },
			{ value: "100", label: "100 KB", description: __ompTranslate("~25K tokens") },
			{ value: "200", label: "200 KB", description: __ompTranslate("~50K tokens") },
		],
	},
});

export const cfgToolsArtifactHeadBytes = register({
	id: "tools.artifactHeadBytes",
	type: "number",
	default: 20,
	ui: {
		tab: "tools",
		group: "Output Limits",
		label: __ompTranslate("Artifact Head Size (KB)"),
		description:
			"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.",
		options: [
			{ value: "0", label: "0 KB", description: __ompTranslate("Disabled; tail-only truncation") },
			{ value: "1", label: "1 KB", description: __ompTranslate("~250 tokens") },
			{ value: "2.5", label: "2.5 KB", description: __ompTranslate("~625 tokens") },
			{ value: "5", label: "5 KB", description: __ompTranslate("~1.25K tokens") },
			{ value: "10", label: "10 KB", description: __ompTranslate("~2.5K tokens") },
			{ value: "20", label: "20 KB", description: __ompTranslate("Default; ~5K tokens") },
			{ value: "50", label: "50 KB", description: __ompTranslate("~12.5K tokens") },
			{ value: "100", label: "100 KB", description: __ompTranslate("~25K tokens") },
			{ value: "200", label: "200 KB", description: __ompTranslate("~50K tokens") },
		],
	},
});

export const cfgToolsOutputMaxColumns = register({
	id: "tools.outputMaxColumns",
	type: "number",
	default: 768,
	ui: {
		tab: "tools",
		group: "Output Limits",
		label: __ompTranslate("Output Column Cap"),
		description:
			"Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.",
		options: [
			{ value: "0", label: __ompTranslate("Off"), description: __ompTranslate("No per-line cap") },
			{ value: "256", label: "256", description: __ompTranslate("Tight") },
			{ value: "512", label: "512" },
			{ value: "768", label: "768", description: __ompTranslate("Default\u0004settings.value.default") },
			{ value: "1024", label: "1024" },
			{ value: "2048", label: "2048" },
			{ value: "4096", label: "4096", description: __ompTranslate("Loose") },
		],
	},
});

export const cfgToolsArtifactTailLines = register({
	id: "tools.artifactTailLines",
	type: "number",
	default: 500,
	ui: {
		tab: "tools",
		group: "Output Limits",
		label: __ompTranslate("Artifact Tail Lines"),
		description: "Maximum lines of tail content kept inline when output spills to artifact",
		options: [
			{ value: "50", label: __ompTranslate("50 lines"), description: __ompTranslate("~250 tokens") },
			{
				value: "100",
				label: __ompTranslate("100 lines\u0004tool.artifact.tail-lines"),
				description: __ompTranslate("~500 tokens"),
			},
			{
				value: "250",
				label: __ompTranslate("250 lines\u0004tool.artifact.tail-lines"),
				description: __ompTranslate("~1.25K tokens"),
			},
			{
				value: "500",
				label: __ompTranslate("500 lines\u0004tool.artifact.tail-lines"),
				description: __ompTranslate("Default; ~2.5K tokens"),
			},
			{
				value: "1000",
				label: __ompTranslate("1000 lines\u0004tool.artifact.tail-lines"),
				description: __ompTranslate("~5K tokens"),
			},
			{ value: "2000", label: __ompTranslate("2000 lines"), description: __ompTranslate("~10K tokens") },
			{ value: "5000", label: __ompTranslate("5000 lines"), description: __ompTranslate("~25K tokens") },
		],
	},
});

export const cfgToolsArtifactMaxBytes = register({
	id: "tools.artifactMaxBytes",
	type: "number",
	default: 16,
	ui: {
		tab: "tools",
		group: "Output Limits",
		label: __ompTranslate("Artifact File Cap (MB)"),
		description:
			"Maximum size of the artifact file saved for streaming tool output (bash, python, js eval). Larger output keeps its beginning (up to 3 MB) and its most recent remainder, with a truncation notice between them. 0 = unlimited.",
		options: [
			{ value: "0", label: __ompTranslate("Unlimited"), description: __ompTranslate("Save the complete output") },
			{ value: "4", label: "4 MB" },
			{ value: "16", label: "16 MB", description: __ompTranslate("Default\u0004settings.value.default") },
			{ value: "64", label: "64 MB" },
			{ value: "256", label: "256 MB" },
			{ value: "1024", label: "1 GB" },
		],
	},
});

export const cfgReadLineNumbers = register({
	id: "readLineNumbers",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "Reading",
		label: __ompTranslate("Line Numbers"),
		description: "Prepend line numbers to read tool output by default",
	},
});

export const cfgReadDefaultLimit = register({
	id: "read.defaultLimit",
	type: "number",
	default: 300,
	ui: {
		tab: "files",
		group: "Reading",
		label: __ompTranslate("Default Read Limit"),
		description: "Default number of lines returned when agent calls read without a limit",
		options: [
			{ value: "200", label: __ompTranslate("200 lines") },
			{ value: "300", label: __ompTranslate("300 lines") },
			{ value: "500", label: __ompTranslate("500 lines\u0004tool.artifact.tail-lines") },
			{ value: "1000", label: __ompTranslate("1000 lines\u0004tool.artifact.tail-lines") },
			{ value: "5000", label: __ompTranslate("5000 lines") },
		],
	},
});

export const cfgReadRenderMarkdown = register({
	id: "read.renderMarkdown",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "Reading",
		label: __ompTranslate("Markdown Previews"),
		description: "Render Markdown read results as formatted terminal Markdown previews instead of raw source",
	},
});

export const cfgReadSummarizeEnabled = register({
	id: "read.summarize.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "Read Summaries",
		label: __ompTranslate("Read Summaries"),
		description: "Return structural code summaries when read is called without an explicit selector",
	},
});

export const cfgReadSummarizeProse = register({
	id: "read.summarize.prose",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "Read Summaries",
		label: __ompTranslate("Prose Summaries"),
		description: "Return structural summaries for Markdown and plain text reads",
	},
});

export const cfgReadSummarizeMinBodyLines = register({
	id: "read.summarize.minBodyLines",
	type: "number",
	default: 4,
	ui: {
		tab: "files",
		group: "Read Summaries",
		label: __ompTranslate("Read Summary Body Lines"),
		description: "Minimum multiline body or literal length before read summaries collapse it",
	},
});

export const cfgReadSummarizeMinCommentLines = register({
	id: "read.summarize.minCommentLines",
	type: "number",
	default: 6,
	ui: {
		tab: "files",
		group: "Read Summaries",
		label: __ompTranslate("Read Summary Comment Lines"),
		description: "Minimum multiline block comment length before read summaries collapse it",
	},
});

export const cfgReadSummarizeMinTotalLines = register({
	id: "read.summarize.minTotalLines",
	type: "number",
	default: 100,
	ui: {
		tab: "files",
		group: "Read Summaries",
		label: __ompTranslate("Read Summary Minimum File Length"),
		description: "Files with fewer total lines are read verbatim instead of structurally summarized",
	},
});

export const cfgReadSummarizeUnfoldUntil = register({
	id: "read.summarize.unfoldUntil",
	type: "number",
	default: 50,
	ui: {
		tab: "files",
		group: "Read Summaries",
		label: __ompTranslate("Read Summary Unfold Target"),
		description:
			"BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.",
	},
});

export const cfgReadSummarizeUnfoldLimit = register({
	id: "read.summarize.unfoldLimit",
	type: "number",
	default: 100,
	ui: {
		tab: "files",
		group: "Read Summaries",
		label: __ompTranslate("Read Summary Unfold Ceiling"),
		description:
			"Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans.",
	},
});

export const cfgReadToolResultPreview = register({
	id: "read.toolResultPreview",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "Reading",
		label: __ompTranslate("Inline Read Previews"),
		description: "Render read tool results inline in the transcript instead of summary rows",
	},
});

// ────────────────────────────────────────────────────────────────────────
// Tools
// ────────────────────────────────────────────────────────────────────────

// Tool approval policies
export const cfgToolsApproval = register({
	id: "tools.approval",
	type: "record",
	default: {},
	ui: {
		tab: "interaction",
		group: "Approvals",
		label: __ompTranslate("Tool Approval Policies"),
		description:
			"Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.",
	},
});

// Default tool approval mode (interaction tab, but governs the tool wrapper).
//   "always-ask"        — auto-approves read-tier tools only; prompts for write/exec.
//   "always-ask-cached" — like always-ask, but file reads and writes can be approved
//                         for a file or folder, this session or across sessions.
//   "write"             — auto-approves read and write-tier tools; prompts for exec.
//   "yolo"              — auto-approves every tier.
export const cfgToolsApprovalMode = register({
	id: "tools.approvalMode",
	type: "enum",
	values: ["always-ask", "always-ask-cached", "write", "yolo"] as const,
	default: "yolo",
	ui: {
		tab: "interaction",
		group: "Approvals",
		label: __ompTranslate("Tool Approval"),
		description:
			"Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Ask and remember' also asks before file reads, and can remember a file or folder. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.",
		options: [
			{
				value: "always-ask",
				label: __ompTranslate("Always ask"),
				description: __ompTranslate("Auto-approve read-only tools; require confirmation for write and exec tools."),
			},
			{
				value: "always-ask-cached",
				label: __ompTranslate("Ask and remember"),
				description: __ompTranslate(
					"Ask before reading or writing a file, with answers that remember the file or its folder for this session or every session; require confirmation for exec tools.",
				),
			},
			{
				value: "write",
				label: __ompTranslate("Write"),
				description: __ompTranslate(
					"Auto-approve read-only and write tools; require confirmation for exec tools such as bash, eval, browser, and task.",
				),
			},
			{
				value: "yolo",
				label: __ompTranslate("Yolo"),
				description: __ompTranslate(
					"Auto-approve read, write, and exec tools. User policy can still require confirmation or block calls.",
				),
			},
		],
	},
});

// Folders where every action asks, in every approval mode and whatever was remembered.
export const cfgToolsRestrictedFolders = register({
	id: "tools.restrictedFolders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Approvals",
		label: "Restricted Folders",
		editor: "json",
		description:
			'Folders where every read, write, edit, search, or command needs an explicit approval, whatever the approval mode or a remembered grant. The folder and everything under it is restricted; commands are matched by the directory they run in. A JSON list of paths, e.g. ["~/secrets"].',
		condition: "restrictedFoldersNotProject",
	},
	validate: raw => {
		if (raw === undefined) return;
		if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string" || entry.trim().length === 0)) {
			throw new Error("tools.restrictedFolders must be a list of folder paths");
		}
	},
});

// Todo tool
// Todo settings deliberately have no `protocolDefault`: protocol embedders need project-level opt-outs
// for reminder/prelude prompt injection.
export const cfgTodoEnabled = register({
	id: "todo.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Todos"),
		description: "Enable the todo tool for task tracking",
	},
});

export const cfgTodoReminders = register({
	id: "todo.reminders",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Todos",
		label: __ompTranslate("Todo Reminders"),
		description: "Remind the agent to complete todos before stopping",
	},
});

export const cfgTodoRemindersMax = register({
	id: "todo.remindersMax",
	type: "number",
	default: 3,
	ui: {
		tab: "tools",
		group: "Todos",
		label: __ompTranslate("Todo Reminder Limit"),
		description: "Maximum number of todo reminders before giving up",
		options: [
			{ value: "1", label: __ompTranslate("1 reminder") },
			{ value: "2", label: __ompTranslate("2 reminders") },
			{ value: "3", label: __ompTranslate("3 reminders") },
			{ value: "5", label: __ompTranslate("5 reminders") },
		],
	},
});

export const cfgTodoEager = register({
	id: "todo.eager",
	type: "enum",
	values: ["default", "preferred", "always"] as const,
	default: "default",
	ui: {
		tab: "tools",
		group: "Todos",
		label: __ompTranslate("Create Todos Automatically"),
		description: "How strongly to push automatic todo-list creation after the first message",
		options: [
			{
				value: "default",
				label: __ompTranslate("Default\u0004settings.value.default"),
				description: __ompTranslate("Model decides; no automatic todo list"),
			},
			{
				value: "preferred",
				label: __ompTranslate("Preferred"),
				description: __ompTranslate("Suggests a todo list on the first message (reminder, not forced)"),
			},
			{
				value: "always",
				label: __ompTranslate("Always"),
				description: __ompTranslate("Forces a comprehensive todo list on the first message"),
			},
		],
	},
});

export const cfgTasksTodoClearDelay = register({
	id: "tasks.todoClearDelay",
	type: "number",
	default: 60,
	ui: {
		tab: "tools",
		group: "Todos",
		label: __ompTranslate("Todo Auto-Clear Delay"),
		description: "Delay before completed or abandoned todos are removed from the todo widget",
		options: [
			{ value: "0", label: __ompTranslate("Instant") },
			{
				value: "60",
				label: __ompTranslate("1 minute"),
				description: __ompTranslate("Default\u0004settings.value.default"),
			},
			{ value: "300", label: __ompTranslate("5 minutes") },
			{ value: "900", label: __ompTranslate("15 minutes") },
			{ value: "1800", label: __ompTranslate("30 minutes") },
			{ value: "3600", label: __ompTranslate("1 hour") },
			{ value: "-1", label: __ompTranslate("Never\u0004todo.auto-clear.never") },
		],
	},
});

// Grep, glob, and AST tools
export const cfgGlobEnabled = register({
	id: "glob.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Glob",
		description: "Enable the glob tool for glob-based file lookup",
	},
});

export const cfgGrepEnabled = register({
	id: "grep.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Grep",
		description: "Enable the grep tool for regex content search",
	},
});

export const cfgGrepContextBefore = register({
	id: "grep.contextBefore",
	type: "number",
	default: 1,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: __ompTranslate("Grep Context Before"),
		description: "Lines of context before each grep match",
		options: [
			{ value: "0", label: __ompTranslate("0 lines") },
			{ value: "1", label: __ompTranslate("1 line") },
			{ value: "2", label: __ompTranslate("2 lines") },
			{ value: "3", label: __ompTranslate("3 lines") },
			{ value: "5", label: __ompTranslate("5 lines") },
		],
	},
});

export const cfgGrepContextAfter = register({
	id: "grep.contextAfter",
	type: "number",
	default: 3,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: __ompTranslate("Grep Context After"),
		description: "Lines of context after each grep match",
		options: [
			{ value: "0", label: __ompTranslate("0 lines") },
			{ value: "1", label: __ompTranslate("1 line") },
			{ value: "2", label: __ompTranslate("2 lines") },
			{ value: "3", label: __ompTranslate("3 lines") },
			{ value: "5", label: __ompTranslate("5 lines") },
			{ value: "10", label: __ompTranslate("10 lines") },
		],
	},
});

export const cfgAstGrepEnabled = register({
	id: "astGrep.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("AST Grep"),
		description: "Enable the ast_grep tool for structural AST search",
	},
});

export const cfgAstEditEnabled = register({
	id: "astEdit.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("AST Edit"),
		description: "Enable the ast_edit tool for structural AST rewrites",
	},
});

export const cfgFindEnabled = register({
	id: "find.enabled",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Find (semantic grep)"),
		description:
			"Enable the find tool: natural-language search for files and line ranges, judged by the judge model role. Auto enables it only when the judge role resolves to a native TypeSafe jev model",
		options: [
			{
				value: "auto",
				label: __ompTranslate("Auto"),
				description: __ompTranslate("Enable when the judge role resolves to a native TypeSafe jev model"),
			},
			{
				value: "on",
				label: __ompTranslate("On"),
				description: __ompTranslate("Always enable, whichever model the judge role resolves to"),
			},
			{ value: "off", label: __ompTranslate("Off"), description: __ompTranslate("Disable the find tool") },
		],
	},
});

// Optional tools

export const cfgDebugEnabled = register({
	id: "debug.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Debug\u0004tool.debug.setting"),
		description: "Enable the debug tool for DAP-based debugging",
	},
});

export const cfgLaunchEnabled = register({
	id: "launch.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Services"),
		description: "Enable named bash services and proc:// supervision for shared long-running project processes",
	},
});

export const cfgSpeechgenEnabled = register({
	id: "speechgen.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Speech Generation"),
		description: "Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis",
	},
});

export const cfgGenerateImageEnabled = register({
	id: "generate_image.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Generate Image"),
		description:
			"Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on.",
	},
});

export const cfgComputerEnabled = register({
	id: "computer.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Computer"),
		description: "Enable the scriptable host-desktop eval prelude (screenshots, input, accessibility)",
	},
});

export const cfgRatchetEnabled = register({
	id: "ratchet.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Ratchet",
		description: "Enable the ratchet eval/hillclimb prelude; /ratchet turns it on for the current session",
	},
});

export const cfgArchiveEnabled = register({
	id: "archive.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Archive"),
		description:
			"Enable the read-only archive eval prelude: prompt history, recent projects, past sessions and recaps",
	},
});

export const cfgComputerDisplay = register({
	id: "computer.display",
	type: "string",
	default: "active",
	ui: {
		tab: "tools",
		group: "Computer",
		label: __ompTranslate("Computer Display"),
		description: "Active window's display (active), all displays (all), or a native display id",
	},
});

export const cfgComputerMaxWidth = register({
	id: "computer.maxWidth",
	type: "number",
	default: 3840,
	ui: {
		tab: "tools",
		group: "Computer",
		label: __ompTranslate("Computer Screenshot Width"),
		description: "Maximum screenshot width in pixels",
	},
});

export const cfgComputerMaxHeight = register({
	id: "computer.maxHeight",
	type: "number",
	default: 2400,
	ui: {
		tab: "tools",
		group: "Computer",
		label: __ompTranslate("Computer Screenshot Height"),
		description: "Maximum screenshot height in pixels",
	},
});

export const cfgComputerBackgroundFallback = register({
	id: "computer.backgroundFallback",
	type: "enum",
	values: ["takeover", "refuse"] as const,
	default: "takeover",
	ui: {
		tab: "tools",
		group: "Computer",
		label: __ompTranslate("Computer Background Fallback"),
		description:
			"What window input does when its background route is unavailable: rerun it in takeover and return focus to your app (macOS; elsewhere plain takeover), or refuse, which also keeps the agent from taking the foreground or opening macOS menus itself",
		options: [
			{
				value: "takeover",
				label: __ompTranslate("Takeover"),
				description: __ompTranslate(
					"Briefly bring the target forward for that one call, then return focus to your app (on macOS even if you kept typing)",
				),
			},
			{
				value: "refuse",
				label: __ompTranslate("Refuse"),
				description: __ompTranslate(
					"Fail the call; nothing takes over, and the agent's own takeover, raise, activating open, desktop input and macOS menus (context menus, popup and menu buttons; they take your keyboard while open) are refused too",
				),
			},
		],
	},
});

export const cfgImagesQuestionTimeoutMs = register({
	id: "images.questionTimeoutMs",
	type: "number",
	default: 300_000,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Image Question Timeout"),
		description:
			"Per-request timeout for the vision-model call behind read's ?q= image questions, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort. Set to 0 to disable the timeout.",
		options: [
			{ value: "0", label: __ompTranslate("Disabled\u0004display.shimmer.disabled") },
			{ value: "60000", label: __ompTranslate("1 minute") },
			{ value: "120000", label: __ompTranslate("2 minutes") },
			{ value: "180000", label: __ompTranslate("3 minutes") },
			{ value: "300000", label: __ompTranslate("5 minutes") },
		],
	},
});

export const cfgCheckpointEnabled = register({
	id: "checkpoint.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Checkpoint/Rewind"),
		description: "Enable the checkpoint and rewind tools for context checkpointing",
	},
});

// Fetching and browser
export const cfgFetchEnabled = register({
	id: "fetch.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Read URLs"),
		description: "Allow the read tool to fetch and process URLs",
	},
});

export const cfgVaultEnabled = register({
	id: "vault.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Obsidian Vault"),
		description:
			"Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.",
	},
});

export const cfgGithubEnabled = register({
	id: "github.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "GitHub CLI",
		description:
			"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)",
	},
});

export const cfgGithubCacheEnabled = register({
	id: "github.cache.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: __ompTranslate("GitHub View Cache"),
		description: "Cache rendered issue/PR view output in ~/.omp/cache/github-cache.db so repeated reads are free",
	},
});

export const cfgGithubCacheSoftTtlSec = register({
	id: "github.cache.softTtlSec",
	type: "number",
	default: 300,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: __ompTranslate("GitHub Cache Soft TTL"),
		description: "Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)",
	},
});

export const cfgGithubCacheHardTtlSec = register({
	id: "github.cache.hardTtlSec",
	type: "number",
	default: 604800,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: __ompTranslate("GitHub Cache Hard TTL"),
		description:
			"Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)",
	},
});

export const cfgWebSearchEnabled = register({
	id: "web_search.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Web Search"),
		description: "Enable the web_search tool for live web results",
	},
});

export const cfgSecurityEnabled = register({
	id: "security.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Security"),
		description:
			"Enable OMP-native security scan planning, execution, and the read-only security:// resource namespace",
	},
});

export const cfgAskEnabled = register({
	id: "ask.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: __ompTranslate("Ask\u0004tool.ask.action"),
		description: "Enable the ask tool for interactive user questions",
	},
});

export const cfgOutEnabled = register({
	id: "out.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Out",
		description:
			"Let the agent reply mid-task by writing to out://, shown like a response without ending its turn. Unset: on in the interactive TUI, off in print, RPC, and ACP",
	},
});

// Tool execution
export const cfgToolsIntentTracing = register({
	id: "tools.intentTracing",
	type: "boolean",
	default: true,
	env: "PI_INTENT_TRACING",
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Intent Tracing"),
		description: "Ask the agent to describe the intent of each tool call before executing it",
	},
});

export const cfgToolsAbortOnFabricatedResult = register({
	id: "tools.abortOnFabricatedResult",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Abort On Fabricated Tool Result"),
		description:
			"With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.",
	},
});

export const cfgToolsSpeculativeExecutionEnabled = register({
	id: "tools.speculativeExecution.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Experimental Speculative Execution"),
		description:
			"Enable the discard-safe first slice: validated local reads through direct read calls and nested eval. Network requests, provider completions, and live filesystem writes are not part of this baseline.",
	},
});

export const cfgToolsSpeculativeExecutionMaxInFlight = register({
	id: "tools.speculativeExecution.maxInFlight",
	type: "number",
	default: 2,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Speculative Execution Concurrency"),
		description: "Maximum number of validated local reads allowed to run before normal dispatch.",
		options: [
			{ value: "1", label: __ompTranslate("1 operation") },
			{ value: "2", label: __ompTranslate("2 operations") },
			{ value: "3", label: __ompTranslate("3 operations") },
			{ value: "4", label: __ompTranslate("4 operations") },
		],
	},
});

export const cfgToolsMaxTimeout = register({
	id: "tools.maxTimeout",
	type: "number",
	default: 0,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Max Tool Timeout"),
		description: "Maximum timeout in seconds the agent can set for any tool (0 = no limit)",
		options: [
			{ value: "0", label: __ompTranslate("No limit") },
			{ value: "30", label: __ompTranslate("30 seconds") },
			{ value: "60", label: __ompTranslate("60 seconds") },
			{ value: "120", label: __ompTranslate("120 seconds") },
			{ value: "300", label: __ompTranslate("5 minutes") },
			{ value: "600", label: __ompTranslate("10 minutes") },
		],
	},
});

// Async jobs. RPC hosts start from the neutral background-job defaults (`protocolDefault`), as do the
// bash/eval auto-background settings.
export const cfgAsyncEnabled = register({
	id: "async.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Async Execution"),
		description: "Enable async bash commands and background task execution",
	},
});

export const cfgAsyncMaxJobs = register({
	id: "async.maxJobs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 100,
});

// Print mode is single-shot by default: it disposes after the last prompt, cancelling the
// run's background jobs. Opting in keeps `-p` alive so each job's async-result wakes the same
// session, as the TUI does, before exiting (issue #10363).
export const cfgAsyncPrintWake = register({
	id: "async.printWake",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Wake Print Mode on Job Results"),
		description:
			"In print mode (-p, --mode json), keep running after the last prompt while this run's background jobs are active, and start another turn in the same session with each job's result; exits once no job or result is pending. Off: print mode exits after its prompts and cancels running jobs",
	},
});

export const cfgAsyncWidgets = register({
	id: "async.widgets",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Execution",
		label: __ompTranslate("Live Job Widgets"),
		description:
			"Draw a live widget for each running background job (charts, bars, status grids derived from its output) in the wait card, the jobs pill and the jobs sheet. The `widget` model role (default: `smol`) writes one spec per job; updates need no further model calls",
	},
});

export const cfgToolsXdev = register({
	id: "tools.xdev",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: __ompTranslate("xd:// Tools"),
		description:
			"Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions whose explicit tool list grants read but omits write mount devices through a device-only write transport (only local:// scratch stays writable besides devices). Disable to expose every enabled tool top-level.",
	},
});

export const cfgToolsXdevDocs = register({
	id: "tools.xdevDocs",
	type: "enum",
	values: ["inline", "builtins", "catalog"] as const,
	default: "catalog",
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: __ompTranslate("xd:// Prompt Docs"),
		description:
			"Choose which mounted-device docs and schemas are inlined in the system prompt. Built-ins keeps core tools inline while MCP and extension tools stay on-demand.",
		options: [
			{
				value: "inline",
				label: __ompTranslate("All Devices"),
				description: __ompTranslate("Inline docs and schemas for every mounted device."),
			},
			{
				value: "builtins",
				label: __ompTranslate("Built-ins Only"),
				description: __ompTranslate("Inline built-in docs; fetch MCP and extension docs on demand."),
			},
			{
				value: "catalog",
				label: __ompTranslate("Catalog Only"),
				description: __ompTranslate("List every device; fetch all docs on demand."),
			},
		],
	},
});

export const cfgToolsXdevInlineDevices = register({
	id: "tools.xdevInlineDevices",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: __ompTranslate("xd:// Inline Devices"),
		description:
			"When xd:// Prompt Docs is Built-ins Only, inline dynamic devices whose names match these glob patterns (for example mcp__context_mode_*). Catalog Only ignores this setting.",
	},
});

export const cfgToolsXdevNotices = register({
	id: "tools.xdevNotices",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "xd:// Mount Notices",
		description:
			"Show an `xd://: mounted …` notice when MCP or extension tools are mounted or unmounted. The model still learns of the change with its next prompt.",
	},
});

export const cfgDevAutoqa = register({
	id: "dev.autoqa",
	type: "boolean",
	default: true,
	env: "PI_AUTO_QA",
	ui: {
		tab: "tools",
		group: "Developer",
		label: __ompTranslate("Auto QA"),
		description:
			"Automated tool issue reporting (xd://report_issue). On by default; the first report asks for consent, and denying it disables reporting until re-enabled explicitly",
	},
});

export const cfgDevAutoqaPushEndpoint = register({
	id: "dev.autoqaPush.endpoint",
	type: "string",
	default: "https://qa.omp.sh/v1/grievances" as const,
	ui: {
		tab: "tools",
		group: "Developer",
		label: __ompTranslate("Auto QA Push Endpoint"),
		description: "Full URL receiving Auto QA JSON reports (default https://qa.omp.sh/v1/grievances)",
	},
});

export const cfgDevAutoqaPushToken = register({
	id: "dev.autoqaPush.token",
	type: "string",
	default: undefined,
	credential: true,
});

/**
 * User decision on sharing automatic `report_tool_issue` grievances.
 *
 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
 *                  pops a consent dialog and persists the answer here.
 *   - `"granted"` — record and (when push is configured) ship grievances.
 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
 *
 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via the
 * process-global consent handler registered by `InteractiveMode`.
 *
 * @default "unset"
 */
export const cfgDevAutoqaConsent = register({
	id: "dev.autoqaConsent",
	type: "enum",
	values: ["unset", "granted", "denied"] as const,
	default: "unset" as const,
});

/** Settings read by `resolveBuiltinToolPlan` (`tools/index.ts`); a live session reconciles its built-ins when any changes. */
export const cfgBuiltinToolGates = combine({
	ask: cfgAskEnabled,
	astEdit: cfgAstEditEnabled,
	astGrep: cfgAstGrepEnabled,
	async: cfgAsyncEnabled,
	autolearn: cfgAutolearnEnabled,
	bash: cfgBashEnabled,
	checkpoint: cfgCheckpointEnabled,
	contextManagement: cfgCompactionExperimentalContextManagement,
	debug: cfgDebugEnabled,
	evalJs: cfgEvalJs,
	evalPy: cfgEvalPy,
	find: cfgFindEnabled,
	github: cfgGithubEnabled,
	glob: cfgGlobEnabled,
	grep: cfgGrepEnabled,
	ida: cfgIdaAvailable,
	launch: cfgLaunchEnabled,
	lsp: cfgLspEnabled,
	security: cfgSecurityEnabled,
	taskMaxRecursionDepth: cfgTaskMaxRecursionDepth,
	todo: cfgTodoEnabled,
	webSearch: cfgWebSearchEnabled,
});

/** Settings that add or remove the built-in tools they gate (`AgentSession.reconcileBuiltinTools`). */
export const cfgSessionToolGates = combine({
	builtins: cfgBuiltinToolGates,
	generateImage: cfgGenerateImageEnabled,
	speechgen: cfgSpeechgenEnabled,
	xdev: cfgToolsXdev,
});
