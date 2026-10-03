/**
 * Fullscreen `/copy` picker over the transcript itself.
 *
 * Replays the current branch with {@link ChatTranscriptBuilder} on the
 * alternate screen and moves the same dotted outline the esc-esc rewind
 * selector uses over the rendered items; Enter copies the outlined turn's
 * text. Right descends into the turn's inner blocks — fenced code, `>`-quotes,
 * bash/eval commands, tool output, and links — replacing the turn's rendered
 * region with a stacked, syntax-highlighted block view whose outline steps per
 * block; Left/Esc ascend back to the transcript. Every block caption carries a
 * clickable `⧉ copy` control and link blocks add `↗ open`; the overlay is
 * fullscreen, so the terminal reports clicks here (SGR mouse) even though the
 * main transcript never captures the mouse. Keyboard: Enter copies, `o` opens.
 * A URL that wrapped across terminal rows therefore needs neither a careful
 * mouse selection nor cmd-click.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TspPickerColumn, TspPickerItem, TspPickerProps, TspText } from "@oh-my-pi/pi-wire";
import { type Component, matchesKey, routeSgrMouseInput, type TUI, truncateToWidth, visibleWidth } from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import type { LayoutMode } from "../chat/layout-mode";
import {
	recentTranscriptEntries,
	type SessionMessageEntryLike as SessionMessageEntry,
	type TranscriptEntryLike as TranscriptEntry,
	textContent,
	transcriptEntryMessage,
	userMessageLabel,
	userTurnDraft,
} from "../chat/transcript-entry";
import { expandKeyHint, replaceTabs } from "../render/render-utils";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { highlightCode, type ThemeColor, theme } from "../theme/theme";
import { commandFromToolCall, extractBlocks, extractLinks } from "./copy-targets";
import { matchesAppToolsExpand, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { ChatTranscriptBuilder } from "../chat/chat-transcript-builder";
import { TranscriptBrowser, type TranscriptBrowserFrame } from "../chat/transcript-browser";
import {
	appendOutlineEntries,
	type ComposedColumn,
	composeOutlineColumn,
	type OutlineTarget,
	outlineRows,
} from "../chat/transcript-outline";
import { code, compact, md, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, type NativeHint, overlayCard } from "../native/overlay";
import { CLOSE_ACTION, type PickerEvent, picker, pickerAction, pickerEvent } from "../native/picker";

/** Key of the leading list item that replays the history older than the startup tail. */
const EARLIER_TURNS_KEY = "earlier";

/** Leading item of a truncated transcript list; selecting it loads the older turns. */
const earlierTurnsItem: NativeNode = node(
	"item",
	{ label: [span("Earlier turns…", "muted")], hint: ["a"] },
	undefined,
	EARLIER_TURNS_KEY,
);

/** First non-blank line of `source`, whitespace collapsed. */
function firstLine(source: string): string {
	const line = source.split("\n").find(part => part.trim().length > 0) ?? "";
	return line.replace(/\s+/g, " ").trim();
}

/** Plain one-line label and styling role for the turn a target opens. */
function turnSummary(entry: TranscriptEntry): { label: string; role: string } {
	const message = transcriptEntryMessage(entry);
	switch (message?.role) {
		case "user":
			return { label: userMessageLabel(message.content), role: "omp.user" };
		case "assistant": {
			let prose = "";
			const tools: string[] = [];
			for (const content of message.content) {
				if (content.type === "text") prose += content.text;
				else if (content.type === "toolCall") tools.push(content.name);
			}
			const label = firstLine(prose) || tools.join(", ") || "thinking";
			return { label, role: "omp.assistant" };
		}
		case "toolResult":
			return { label: `${message.toolName} result`, role: `omp.tool.${message.toolName}` };
		case "bashExecution":
			return { label: `$ ${firstLine(message.command)}`, role: "omp.tool.bash" };
		case "pythonExecution":
			return { label: firstLine(message.code), role: "omp.tool.eval" };
		case "compactionSummary":
			return { label: "Compaction summary", role: "omp.summary" };
		case "branchSummary":
			return { label: "Branch summary", role: "omp.summary" };
		case "custom":
		case "hookMessage": {
			const draft = userTurnDraft(entry);
			if (draft !== undefined) return { label: firstLine(draft), role: "omp.user" };
			return { label: firstLine(textContent(message.content, " ")) || message.customType, role: "omp.custom" };
		}
		default:
			return { label: entry.id, role: "omp.message" };
	}
}

/** Local `HH:MM` of an entry's persisted timestamp; empty when unparsable. */
function entryTime(entry: TranscriptEntry): string {
	const date = new Date(entry.timestamp);
	if (Number.isNaN(date.getTime())) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * One list item per outline target, keyed by the turn's opening entry id:
 * the plain turn summary as label, `detail` (or the entry time) on the right.
 */
function turnItem(target: OutlineTarget, detail?: TspText): NativeNode {
	const entry = target.entries[0]!;
	const { label, role } = turnSummary(entry);
	const time = entryTime(entry);
	return node(
		"item",
		{
			label: label || "(empty)",
			detail: detail ?? (time || undefined),
			value: detail !== undefined && time ? [span(time, "dim")] : undefined,
			role,
			tone: target.isUserTurn ? "user" : undefined,
		},
		undefined,
		target.turnId,
	);
}

/** Preview of a turn's text: prose as markdown, command/tool output as a plain code block. */
export function turnPreview(target: OutlineTarget, content: string): NativeNode {
	if (!content.trim()) return text([span("(no text)", "muted")]);
	const message = transcriptEntryMessage(target.entries[0]!);
	switch (message?.role) {
		case "assistant":
			// A pure tool turn previews its joined commands/results, not prose.
			return message.content.some(part => part.type === "text" && part.text.trim())
				? md(content)
				: code(content, { wrap: true });
		case "user":
		case "custom":
		case "hookMessage":
		case "compactionSummary":
		case "branchSummary":
			return md(content);
		default:
			return code(content, { wrap: true });
	}
}

/** Argument keys naming what a tool call works on, in preference order. */
const TOOL_TARGET_KEYS = ["command", "pattern", "path", "file_path", "query", "url", "code"] as const;

/** One-line label of a tool call: its name and main argument (`grep ack`, `bash ls -la`). */
function toolCallLabel(name: string, args: Record<string, unknown> | undefined): string {
	for (const key of TOOL_TARGET_KEYS) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return `${name} ${firstLine(value)}`;
	}
	return name;
}

/** The timeline pickers' one fact column: a user turn's clock time. */
const TIMELINE_COLUMNS: readonly TspPickerColumn[] = [{ id: "at", format: "dim", priority: 1 }];

/**
 * The `timeline` picker item of one outline target (rewind, copy), keyed by
 * the turn's opening entry id: user turns carry their `HH:MM`, pure tool turns
 * the tool's role and a `name target` label.
 */
function timelineItem(target: OutlineTarget): TspPickerItem {
	const entry = target.entries[0]!;
	const id = target.turnId;
	const summary = turnSummary(entry);
	const label = summary.label || "(empty)";
	if (target.isUserTurn) {
		const at = entryTime(entry);
		return { id, label, node: "user", ...(at ? { facts: { at } } : {}) };
	}
	const message = transcriptEntryMessage(entry);
	switch (message?.role) {
		case "assistant": {
			const prose = message.content.some(part => part.type === "text" && part.text.trim());
			const calls = message.content.filter(part => part.type === "toolCall");
			if (prose || calls.length === 0) return { id, label, node: "assistant" };
			return {
				id,
				label: calls.map(call => toolCallLabel(call.name, call.arguments)).join(" · "),
				node: "tool",
				role: `omp.tool.${calls[0]!.name}`,
			};
		}
		case "toolResult":
		case "bashExecution":
		case "pythonExecution":
			return { id, label, node: "tool", role: summary.role };
		default:
			return { id, label, node: "marker" };
	}
}

/** Timeline picker items for `targets`, reused while `targets` is the same array. */
class TimelineItems {
	#memo: { targets: readonly OutlineTarget[]; items: TspPickerItem[] } | undefined;

	of(targets: readonly OutlineTarget[]): TspPickerItem[] {
		if (this.#memo?.targets !== targets) this.#memo = { targets, items: targets.map(timelineItem) };
		return this.#memo.items;
	}
}

/** Lines of a copy block shown in the native preview; longer blocks copy through omp. */
const PREVIEW_BLOCK_LINES = 400;

/** A block's preview caption: `rust · 12 lines`, `quote`, `link · docs`. */
function blockCaption(block: CopyBlock): string {
	if (block.href || block.kind === "quote") return block.label;
	const lines = block.content.split("\n").length;
	const kind = block.kind === "code" ? (block.language ?? "code") : block.label;
	return `${kind}${theme.sep.dot}${lines} line${lines === 1 ? "" : "s"}`;
}

/** A block's preview content: the link, the quote as markdown, else highlighted code. */
function blockBody(block: CopyBlock): NativeNode {
	if (block.href) return text([span(block.href, "link")], { wrap: "char", href: block.href });
	if (block.kind === "quote") return md(block.content);
	const lines = block.content.split("\n");
	if (lines.length <= PREVIEW_BLOCK_LINES) return code(block.content, { lang: block.language, wrap: true });
	const shown = lines.slice(0, PREVIEW_BLOCK_LINES).join("\n");
	return node("col", { gap: "xs" }, [
		code(shown, { lang: block.language, wrap: true }),
		text([span(`… +${lines.length - PREVIEW_BLOCK_LINES} more lines`, "dim")]),
	]);
}

/**
 * One borderless preview section of the copy picker. A click copies it in the
 * terminal (`copy`) when the preview holds the whole text, else asks omp to
 * (`pick`); link sections also offer `open`. The focused block's section takes
 * the `omp.picker.block.focused` role and the accent tone.
 */
function previewSection(
	key: string,
	caption: string,
	body: NativeNode,
	content: string,
	focused: boolean,
	href?: string,
): NativeNode {
	const whole = content.split("\n").length <= PREVIEW_BLOCK_LINES;
	return node(
		"section",
		{
			head: caption,
			role: focused ? "omp.picker.block.focused" : "omp.picker.block",
			...(focused ? { tone: "accent" as const } : {}),
			...(href ? { href } : {}),
			actions: { click: whole ? "copy" : "pick", ...(href ? { menu: ["copy", "open"] } : {}) },
		},
		[body],
		key,
	);
}

export interface CopySelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	/** Owning mode's transcript layout accessor (replicated transcript matches the live one). */
	layout?: () => LayoutMode;
	linkTargets?: ReadonlyMap<string, string>;
	requestRender: () => void;
	/** Replaces the "Copy" header when the picker is reused for another purpose. */
	title?: string;
	/** Verb shown for the pick action in hints and block controls (default "copy"). */
	actionLabel?: string;
	/**
	 * The outlined content was chosen — copy it. `label` feeds the status line;
	 * `source` names the transcript entry (and inner block, when descended) it came from.
	 */
	onPick: (content: string, label: string, source: CopyPickSource) => void;
	/** `o` on a link block — open `href` with the system opener. Absent: `o` is ignored. */
	onOpen?: (href: string, label: string) => void;
	onCancel: () => void;
}

/** Where picked content came from in the transcript. */
export interface CopyPickSource {
	entry: TranscriptEntry;
	/** The inner block, when the pick happened in the descended block view. */
	block?: CopyBlock;
}

/** One copyable inner block of a transcript turn. */
export interface CopyBlock {
	/** Short kind label ("code · ts", "bash command", "read result", …). */
	label: string;
	/** Exact text placed on the clipboard. */
	content: string;
	/** Transcript entry that produced this block. */
	entry: TranscriptEntry;
	/** Markdown code/quote block, or a bash/eval tool-call command. */
	kind?: "code" | "quote" | "command";
	/** Highlight language for the block preview. */
	language?: string;
	/** Set for link blocks: the URL `o` opens. `content` is the same URL. */
	href?: string;
}

/** Preview rows shown per block in the descended view; copy always takes the full text. */
const BLOCK_PREVIEW_LINES = 12;
/** The copy picker's outline stroke — green, distinct from the rewind selector's accent. */
const OUTLINE_COLOR: ThemeColor = "success";

/** A clickable control on a block caption, in composed-column columns. */
interface ControlRegion {
	action: "copy" | "open";
	blockIndex: number;
	start: number;
	end: number;
}

export class CopySelectorComponent implements Component {
	#builder: ChatTranscriptBuilder;
	#browser: TranscriptBrowser;
	#targets: OutlineTarget[] = [];
	#selected = 0;
	#visible: boolean[] | undefined;
	#expanded = false;
	/** Inner blocks of the selected turn while descended, else undefined. */
	#blocks: CopyBlock[] | undefined;
	#blockSelected = 0;
	#blockCache = new Map<string, CopyBlock[]>();
	/** Click targets of the last render, keyed by composed-column line index. */
	#controls = new Map<number, ControlRegion[]>();

	/** Whole branch; the picker may currently replay only its tail. */
	#entries: TranscriptEntry[];
	/** True while older history is still unreplayed. */
	#truncated = false;

	/** Last described root and the state it was built from. */
	#native: { memo: string; targets: OutlineTarget[]; blocks: CopyBlock[] | undefined; node: NativeNode } | undefined;
	/** Transcript list items, rebuilt only when the replayed targets change. */
	#nativeItems: { targets: OutlineTarget[]; truncated: boolean; items: NativeNode[] } | undefined;
	/** Timeline picker items of the replayed targets. */
	#pickerItems = new TimelineItems();
	/** Last described picker and the state it was built from. */
	#picker: { memo: string; targets: OutlineTarget[]; blocks: CopyBlock[] | undefined; node: NativeNode } | undefined;

	constructor(
		entries: TranscriptEntry[],
		private readonly deps: CopySelectorDeps,
	) {
		this.#entries = entries;
		const tail = recentTranscriptEntries(entries);
		this.#truncated = tail.length < entries.length;
		this.#builder = this.#replay(tail);
		this.#selected = Math.max(0, this.#targets.length - 1);
		this.#browser = new TranscriptBrowser({
			getHeight: () => this.deps.ui.terminal?.rows || process.stdout.rows || 40,
			frame: context => this.#frame(context.contentWidth),
		});
	}

	/** Build a transcript for `entries` and adopt its targets. */
	#replay(entries: TranscriptEntry[]): ChatTranscriptBuilder {
		const builder = new ChatTranscriptBuilder({
			ui: this.deps.ui,
			getTool: this.deps.getTool,
			isBuiltInTool: this.deps.isBuiltInTool,
			getMessageRenderer: this.deps.getMessageRenderer,
			cwd: this.deps.cwd,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
			layout: this.deps.layout,
			linkTargets: this.deps.linkTargets,
			requestRender: this.deps.requestRender,
		});
		builder.setExpanded(this.#expanded);
		this.#targets = appendOutlineEntries(builder, entries);
		return builder;
	}

	/**
	 * Replay the whole branch, keeping the outline on the same turn. Pays the
	 * full replay cost once, only when the user asks for older history.
	 */
	#loadFullHistory(): void {
		if (!this.#truncated) return;
		const selectedId = this.#targets[this.#selected]?.turnId;
		const previous = this.#builder;
		this.#builder = this.#replay(this.#entries);
		previous.dispose();
		this.#truncated = false;
		this.#visible = undefined;
		const restored = selectedId ? this.#targets.findIndex(target => target.turnId === selectedId) : -1;
		this.#selected = restored >= 0 ? restored : Math.max(0, this.#targets.length - 1);
		this.#blocks = undefined;
		this.#blockSelected = 0;
		this.deps.requestRender();
	}

	/** Number of copyable transcript items; hosts skip mounting when zero. */
	get targetCount(): number {
		return this.#targets.length;
	}

	invalidate(): void {
		this.#builder.container.invalidate();
		this.#browser.invalidate();
	}

	dispose(): void {
		this.#builder.dispose();
	}

	#blocksFor(target: OutlineTarget): CopyBlock[] {
		const cached = this.#blockCache.get(target.turnId);
		if (cached) return cached;
		const blocks = collectBlocks(target.entries);
		this.#blockCache.set(target.turnId, blocks);
		return blocks;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					// A wheel notch at either end moves nothing: repainting it
					// anyway makes the frame twitch under a fast wheel.
					if (this.#browser.scroll(event.wheel * 3)) this.deps.requestRender();
					return true;
				}
				if (event.leftClick) this.#click(event.row, event.col);
				return true;
			});
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.#escape();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#expanded = !this.#expanded;
			this.#builder.setExpanded(this.#expanded);
			this.deps.requestRender();
			return;
		}
		if (matchesSelectUp(data)) {
			this.#moveVertical(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveVertical(1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.#descend();
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#blocks) this.#ascend();
			return;
		}
		if ((data === "a" || data === "A") && !this.#blocks) {
			this.#loadFullHistory();
			return;
		}
		if (data === "o" || data === "O") {
			this.#openSelectedBlock();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#pickOutlined();
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#browser.handleScrollKey(data)) {
			this.deps.requestRender();
		}
	}

	/** Esc: leave the block view, else close. */
	#escape(): void {
		if (this.#blocks) this.#ascend();
		else this.deps.onCancel();
	}

	/** Right: replace the outlined turn with its inner blocks. */
	#descend(): void {
		if (this.#blocks) return;
		const target = this.#targets[this.#selected];
		if (!target) return;
		const blocks = this.#blocksFor(target);
		if (blocks.length === 0) return;
		this.#blocks = blocks;
		this.#blockSelected = 0;
		this.deps.requestRender();
	}

	/** Enter: pick the outlined block, or the outlined turn's text. */
	#pickOutlined(): void {
		if (this.#blocks) {
			const block = this.#blocks[this.#blockSelected];
			if (block) this.deps.onPick(block.content, block.label, { entry: block.entry, block });
			return;
		}
		const target = this.#targets[this.#selected];
		if (!target) return;
		const item = targetCopy(target, this.#blocksFor(target));
		this.deps.onPick(item.content, item.label, { entry: target.entries[0]! });
	}

	#openSelectedBlock(): void {
		const block = this.#blocks?.[this.#blockSelected];
		if (block?.href && this.deps.onOpen) this.deps.onOpen(block.href, block.label);
	}

	#ascend(): void {
		this.#blocks = undefined;
		this.#blockSelected = 0;
		this.deps.requestRender();
	}

	/** A left click at terminal (row, col): act if it lands on a caption control. */
	#click(row: number, col: number): void {
		if (!this.#blocks) return;
		const point = this.#browser.toContentPoint(row, col);
		if (!point) return;
		const line = point.row;
		const regions = this.#controls.get(line);
		if (!regions) return;
		const hit = regions.find(region => point.col >= region.start && point.col < region.end);
		if (!hit) return;
		const block = this.#blocks[hit.blockIndex];
		if (!block) return;
		this.#blockSelected = hit.blockIndex;
		if (hit.action === "open") {
			if (block.href && this.deps.onOpen) this.deps.onOpen(block.href, block.label);
			return;
		}
		this.deps.onPick(block.content, block.label, { entry: block.entry, block });
	}

	#moveVertical(delta: -1 | 1): void {
		if (this.#blocks) {
			const next = this.#blockSelected + delta;
			if (next >= 0 && next < this.#blocks.length) {
				this.#blockSelected = next;
				this.deps.requestRender();
			}
			return;
		}
		let index = this.#selected + delta;
		while (index >= 0 && index < this.#targets.length) {
			if (this.#visible?.[index] !== false) {
				this.#selected = index;
				this.deps.requestRender();
				return;
			}
			index += delta;
		}
		// Stepping above the replayed tail continues into the earlier history.
		if (delta < 0 && this.#truncated) {
			this.#loadFullHistory();
			this.#moveVertical(delta);
		}
	}

	// ========================================================================
	// Native
	// ========================================================================

	/** A `picker` is its own sheet: the backend mounts it in `layer` without a wrapper. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event);
		if (picked) {
			this.#handlePickerEvent(picked);
			return;
		}
		if (event.type === "action" && event.act === "pick") {
			// A preview section too long to copy in the terminal: omp copies the full text.
			this.#pickSection(event.key);
			return;
		}
		if (event.type === "action") {
			if (event.act === "blocks") this.#descend();
			else if (event.act === "back") this.#ascend();
			else if (event.act === "open") this.#openSelectedBlock();
			else if (event.act === "copy") this.#pickOutlined();
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		// A click on an item outlines it and picks it, as Enter would.
		if (event.key === "list" && !this.#blocks) {
			if (event.item === EARLIER_TURNS_KEY) {
				this.#loadFullHistory();
				return;
			}
			const index = this.#targets.findIndex(target => target.turnId === event.item);
			if (index < 0) return;
			this.#selected = index;
		} else if (event.key === "blocks" && this.#blocks) {
			const index = Number(event.item);
			if (!Number.isInteger(index) || !this.#blocks[index]) return;
			this.#blockSelected = index;
		} else {
			return;
		}
		this.deps.requestRender();
		this.#pickOutlined();
	}

	/** Row click selects a turn (leaving the block view), a second click copies it; the action bar runs its key. */
	#handlePickerEvent(event: PickerEvent): void {
		if (event.kind === "action") {
			switch (event.act) {
				case "pick":
					this.#pickOutlined();
					return;
				case "blocks":
					this.#descend();
					return;
				case "open-link":
					this.#openSelectedBlock();
					return;
				case "earlier":
					this.#loadFullHistory();
					return;
				case "close":
					this.#escape();
					return;
				default:
					return;
			}
		}
		const index = this.#targets.findIndex(target => target.turnId === event.item);
		if (index < 0) return;
		if (index !== this.#selected || this.#blocks) {
			this.#selected = index;
			this.#blocks = undefined;
			this.#blockSelected = 0;
			this.deps.requestRender();
		}
		if (event.kind === "activate") this.#pickOutlined();
	}

	/** Pick the preview section keyed `key` (`whole` or `b<index>`) of the selected turn. */
	#pickSection(key: string): void {
		const target = this.#targets[this.#selected];
		if (!target) return;
		const blocks = this.#blocksFor(target);
		if (key === "whole") {
			const item = targetCopy(target, blocks);
			this.deps.onPick(item.content, item.label, { entry: target.entries[0]! });
			return;
		}
		const block = key.startsWith("b") ? blocks[Number(key.slice(1))] : undefined;
		if (block) this.deps.onPick(block.content, block.label, { entry: block.entry, block });
	}

	describe(cx: DescribeContext): NativeNode {
		return cx.supports("picker") ? this.#describePicker() : this.#describeCard();
	}

	/**
	 * The `timeline` picker: the turns as rows, the selected turn's blocks as
	 * preview sections (the whole message first), each copied by a click. In
	 * the block view the focused block's section takes the
	 * `omp.picker.block.focused` role and the preview owns the focus.
	 */
	#describePicker(): NativeNode {
		const memo = `${this.#selected}|${this.#blockSelected}|${this.#truncated}`;
		const cached = this.#picker;
		if (cached?.memo === memo && cached.targets === this.#targets && cached.blocks === this.#blocks) {
			return cached.node;
		}
		const target = this.#targets[this.#selected];
		const blocks = target ? this.#blocksFor(target) : [];
		const descended = this.#blocks !== undefined;
		const focused = this.#blocks?.[this.#blockSelected];
		const action = this.deps.actionLabel ?? "copy";
		const props: TspPickerProps = {
			title: this.deps.title ?? "Copy",
			...(this.deps.title ? {} : { subtitle: "Pick what to put on the clipboard" }),
			icon: "clipboard",
			noun: "turns",
			size: "lg",
			layout: "timeline",
			preview: "side",
			query: null,
			columns: TIMELINE_COLUMNS,
			items: this.#pickerItems.of(this.#targets),
			selected: target?.turnId ?? null,
			total: this.#targets.length,
			empty: "Nothing to copy",
			focus: descended ? "preview" : "list",
			actions: compact([
				pickerAction("pick", `${action[0]!.toUpperCase()}${action.slice(1)}`, "enter", { primary: true }),
				!descended && blocks.length > 0 ? pickerAction("blocks", "Blocks", "right") : undefined,
				focused?.href && this.deps.onOpen ? pickerAction("open-link", "Open link", "o") : undefined,
				!descended && this.#truncated ? pickerAction("earlier", "Earlier turns", "a") : undefined,
				descended ? { ...CLOSE_ACTION, label: "Back" } : CLOSE_ACTION,
			]),
		};
		const preview: NativeNode[] = [];
		if (target) {
			const whole = targetCopy(target, blocks);
			if (whole.content.trim()) {
				preview.push(
					previewSection("whole", "Whole message", turnPreview(target, whole.content), whole.content, false),
				);
			}
			blocks.forEach((block, index) => {
				preview.push(
					previewSection(
						`b${index}`,
						blockCaption(block),
						blockBody(block),
						block.content,
						descended && index === this.#blockSelected,
						block.href,
					),
				);
			});
		}
		const root = picker(props, preview);
		this.#picker = { memo, targets: this.#targets, blocks: this.#blocks, node: root };
		return root;
	}

	#describeCard(): NativeNode {
		const memo = `${this.#selected}|${this.#blockSelected}|${this.#truncated}`;
		const cached = this.#native;
		if (cached?.memo === memo && cached.targets === this.#targets && cached.blocks === this.#blocks) {
			return cached.node;
		}
		const target = this.#targets[this.#selected];
		const action = this.deps.actionLabel ?? "copy";
		const upDown = actionHint(["tui.select.up", "tui.select.down"], this.#blocks ? "block" : "step");
		const cancel = actionHint("tui.select.cancel", this.#blocks ? "back" : "close");
		const children: NativeChild[] = [];
		let hints: (NativeHint | undefined)[];
		if (this.#blocks && target) {
			const block = this.#blocks[this.#blockSelected];
			children.push(
				row([text([span("‹ back", "accent")], { actions: { click: "back" } })], { gap: "md" }),
				node(
					"list",
					{ selected: String(this.#blockSelected), empty: "No blocks" },
					this.#blocks.map((item, index) => {
						const lines = item.content.split("\n").length;
						return node(
							"item",
							{ label: item.label, detail: `${lines} line${lines === 1 ? "" : "s"}` },
							undefined,
							String(index),
						);
					}),
					"blocks",
				),
			);
			if (block) children.push(this.#blockPreview(block, action));
			hints = [
				upDown,
				{ keys: ["left", ...(cancel?.keys ?? [])], label: "back" },
				{ keys: ["enter"], label: action },
				block?.href && this.deps.onOpen ? { keys: ["o"], label: "open" } : undefined,
			];
		} else {
			const blocks = target ? this.#blocksFor(target) : [];
			children.push(
				node(
					"list",
					{ selected: target?.turnId ?? null, virtual: true, max: 0.5, empty: "Nothing to copy" },
					this.#transcriptItems(),
					"list",
				),
			);
			if (target) {
				const item = targetCopy(target, blocks);
				const body: NativeChild[] = [turnPreview(target, item.content)];
				if (blocks.length > 0) {
					body.push(
						text([span(`${blocks.length} block${blocks.length === 1 ? "" : "s"} ›`, "accent")], {
							actions: { click: "blocks" },
						}),
					);
				}
				children.push(node("section", { head: [span(item.label, "strong")] }, body, "preview"));
			}
			hints = [
				upDown,
				blocks.length > 0 ? { keys: ["right"], label: "blocks" } : undefined,
				{ keys: ["enter"], label: action },
				this.#truncated ? { keys: ["a"], label: "earlier turns" } : undefined,
				cancel,
			];
		}
		children.push(hintsRow(hints));
		const head: TspText = this.deps.title ?? [
			span(`${theme.cmd.copy} `),
			span("Copy", "strong"),
			span(`${theme.sep.dot}pick what to put on the clipboard`, "dim"),
		];
		const root = overlayCard("omp.overlay.copy", head, children);
		this.#native = { memo, targets: this.#targets, blocks: this.#blocks, node: root };
		return root;
	}

	#transcriptItems(): NativeNode[] {
		const cached = this.#nativeItems;
		if (cached?.targets === this.#targets && cached.truncated === this.#truncated) return cached.items;
		const items = this.#targets.map(target => turnItem(target));
		if (this.#truncated) items.unshift(earlierTurnsItem);
		this.#nativeItems = { targets: this.#targets, truncated: this.#truncated, items };
		return items;
	}

	/** The selected block in full: highlighted code, a link, a quote, or plain output. */
	#blockPreview(block: CopyBlock, action: string): NativeNode {
		let body: NativeNode;
		if (block.href) body = text([span(block.href, "link")], { wrap: "char" });
		else if (block.kind === "quote") body = md(block.content);
		else body = code(block.content, { lang: block.language, wrap: true });
		const controls: NativeChild[] = [
			text([span(`${theme.cmd.copy} ${action}`, "accent")], { actions: { click: "copy" } }),
		];
		if (block.href && this.deps.onOpen) {
			controls.push(text([span(`${theme.cmd.share} open`, "accent")], { actions: { click: "open" } }));
		}
		return node("section", { head: [span(block.label, "strong")] }, [body, row(controls, { gap: "md" })], "preview");
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		return this.#browser.render(width);
	}

	#frame(contentWidth: number): TranscriptBrowserFrame {
		const children = this.#builder.container.children;
		const prepared = this.#browser.prepareOutline(children, this.#targets, this.#selected, contentWidth);
		this.#visible = prepared.visible;
		if (prepared.selected !== this.#selected) {
			this.#selected = prepared.selected;
			this.#blocks = undefined;
			this.#blockSelected = 0;
		}

		const target = this.#targets[this.#selected];
		const blocks = target ? this.#blocksFor(target) : [];
		let composed: ComposedColumn;
		this.#controls = new Map();
		if (this.#blocks && target) {
			// Descended: the turn's rendered region is replaced by its block stack.
			const before = composeOutlineColumn(prepared.childRows, 0, target.start, [], -1, contentWidth, undefined);
			const stack = this.#composeBlocks(this.#blocks, contentWidth, before.lines.length);
			const after = composeOutlineColumn(
				prepared.childRows,
				target.end,
				children.length,
				[],
				-1,
				contentWidth,
				undefined,
			);
			composed = {
				lines: [...before.lines, ...stack.lines, ...after.lines],
				selStart: stack.selStart >= 0 ? before.lines.length + stack.selStart : -1,
				selEnd: stack.selEnd >= 0 ? before.lines.length + stack.selEnd : -1,
			};
		} else {
			// The caption on the outline advertises Right's descent into blocks.
			composed = this.#browser.composeOutline({
				children,
				targets: this.#targets,
				selected: this.#selected,
				columnWidth: contentWidth,
				prepared,
				style: {
					color: OUTLINE_COLOR,
					caption:
						blocks.length > 0
							? `${blocks.length} block${blocks.length === 1 ? "" : "s"} ${formatKeyHint("right")}`
							: undefined,
				},
			}).column;
		}

		const selectedBlock = this.#blocks?.[this.#blockSelected];
		const openHint = selectedBlock?.href && this.deps.onOpen ? `  ${formatKeyHint("o")} open` : "";
		const action = this.deps.actionLabel ?? "copy";
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const enter = formatKeyHint("enter");
		const cancel = editorKey("tui.select.cancel");
		const hint = this.#blocks
			? `${this.#blockSelected + 1}/${this.#blocks.length}  ${upDown} block  ${formatKeyHint("left")}/${cancel} back  ${enter} ${action}${openHint}  click ${theme.cmd.copy}/${theme.cmd.share}`
			: `${this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : ""}${upDown} step  ${blocks.length > 0 ? `${formatKeyHint("right")} blocks  ` : ""}${enter} ${action}  ${this.#truncated ? `${formatKeyHint("a")} earlier turns  ` : ""}${expandKeyHint()} expand  ${cancel} close`;
		const anchorId = target
			? this.#blocks
				? `copy:${target.turnId}:block:${this.#blockSelected}`
				: `copy:${target.turnId}`
			: undefined;
		return {
			header: [
				this.deps.title
					? theme.bold(this.deps.title)
					: `${theme.cmd.copy} ${theme.bold("Copy")}${theme.sep.dot}${theme.fg("dim", "pick what to put on the clipboard")}`,
			],
			body: {
				lines: composed.lines,
				anchor:
					anchorId !== undefined && composed.selStart >= 0
						? { id: anchorId, start: composed.selStart, end: composed.selEnd }
						: undefined,
			},
			footer: [theme.fg("dim", hint)],
		};
	}

	/**
	 * The selected turn exploded into captioned block previews, selected one
	 * outlined. Each caption ends with clickable controls; their column spans
	 * are recorded in `#controls` under the composed line index
	 * (`lineOffset` + local index) so {@link #click} can resolve a mouse hit.
	 */
	#composeBlocks(blocks: CopyBlock[], columnWidth: number, lineOffset: number): ComposedColumn {
		const inner = Math.max(10, columnWidth - 4);
		const lines: string[] = [];
		let selStart = -1;
		let selEnd = -1;
		for (let index = 0; index < blocks.length; index++) {
			const block = blocks[index]!;
			const raw = block.content.split("\n");
			const shown = raw.slice(0, BLOCK_PREVIEW_LINES);
			const styled = block.language ? highlightCode(shown.join("\n"), block.language) : shown;
			const rows = styled.map(row => truncateToWidth(replaceTabs(row), inner));
			if (raw.length > shown.length) {
				rows.push(theme.fg("dim", `… +${raw.length - shown.length} more lines`));
			}
			const selected = index === this.#blockSelected;
			const captionColor: ThemeColor = selected ? OUTLINE_COLOR : "dim";
			const controls: Array<{ action: ControlRegion["action"]; text: string }> = [
				{ action: "copy", text: `${theme.cmd.copy} ${this.deps.actionLabel ?? "copy"}` },
			];
			if (block.href && this.deps.onOpen) controls.push({ action: "open", text: `${theme.cmd.share} open` });
			const controlsWidth = controls.reduce((sum, control) => sum + visibleWidth(control.text) + 2, 0);
			const summary = truncateToWidth(
				`${index + 1}/${blocks.length}${theme.sep.dot}${block.label}${theme.sep.dot}${raw.length} line${raw.length === 1 ? "" : "s"}`,
				Math.max(4, inner - controlsWidth),
			);
			// Caption: two-space gutter, summary, then the controls, each preceded by two spaces.
			let caption = theme.fg(captionColor, summary);
			let cursor = 2 + visibleWidth(summary);
			const regions: ControlRegion[] = [];
			for (const control of controls) {
				cursor += 2;
				regions.push({
					action: control.action,
					blockIndex: index,
					start: cursor,
					end: cursor + visibleWidth(control.text),
				});
				caption += `  ${theme.fg("accent", control.text)}`;
				cursor += visibleWidth(control.text);
			}
			lines.push("");
			this.#controls.set(lineOffset + lines.length, regions);
			if (selected) {
				selStart = lines.length;
				lines.push(`  ${caption}`);
				lines.push(...outlineRows(rows, inner, { color: OUTLINE_COLOR }));
				selEnd = lines.length;
			} else {
				lines.push(`  ${caption}`);
				for (const row of rows) lines.push(row ? `  ${row}` : row);
			}
		}
		lines.push("");
		return { lines, selStart, selEnd };
	}
}

/** Raw multi-line text of a user message (string or text blocks). */
function rawUserText(message: Extract<SessionMessageEntry["message"], { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** Concatenated visible text blocks of an assistant message. */
function assistantVisibleText(message: Extract<SessionMessageEntry["message"], { role: "assistant" }>): string {
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim();
}

/** Joined text content of a tool result. */
function toolResultText(message: Extract<SessionMessageEntry["message"], { role: "toolResult" }>): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
}

function pushMarkdownBlocks(blocks: CopyBlock[], text: string, entry: TranscriptEntry): void {
	for (const block of extractBlocks(text)) {
		if (block.kind === "code") {
			blocks.push({
				label: block.lang ? `${block.lang} code` : "code",
				content: block.code,
				entry,
				kind: "code",
				language: block.lang || undefined,
			});
		} else {
			blocks.push({ label: "quote", content: block.text, entry, kind: "quote" });
		}
	}
	// Links follow the message's blocks. The preview shows the whole URL on one
	// row, so a link the transcript wrapped is copied or opened intact.
	for (const link of extractLinks(text)) {
		blocks.push({
			label: link.text !== link.href ? `link${theme.sep.dot}${link.text}` : "link",
			content: link.href,
			entry,
			href: link.href,
		});
	}
}

/** Inner blocks of one turn: markdown code/quotes, commands, and tool output. */
export function collectBlocks(entries: readonly TranscriptEntry[]): CopyBlock[] {
	const blocks: CopyBlock[] = [];
	for (const entry of entries) {
		const message = transcriptEntryMessage(entry);
		if (!message) continue;
		switch (message.role) {
			case "user":
				pushMarkdownBlocks(blocks, rawUserText(message), entry);
				break;
			case "assistant": {
				pushMarkdownBlocks(blocks, assistantVisibleText(message), entry);
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const command = commandFromToolCall(content);
					if (command) {
						blocks.push({
							label: command.kind === "bash" ? "bash command" : "eval code",
							content: command.code,
							entry,
							kind: "command",
							language: command.language,
						});
					}
				}
				break;
			}
			case "toolResult": {
				const text = toolResultText(message);
				if (text) blocks.push({ label: `${message.toolName} result`, content: text, entry });
				break;
			}
			case "bashExecution":
				blocks.push({ label: "command", content: message.command, entry, language: "bash" });
				if (message.output.trim()) blocks.push({ label: "output", content: message.output, entry });
				break;
			case "pythonExecution":
				blocks.push({ label: "eval code", content: message.code, entry, language: "python" });
				if (message.output.trim()) blocks.push({ label: "output", content: message.output, entry });
				break;
			default:
				break;
		}
	}
	return blocks;
}

/** Clipboard payload for a whole turn, falling back to its blocks when the turn has no prose. */
export function targetCopy(target: OutlineTarget, blocks: readonly CopyBlock[]): { content: string; label: string } {
	const entry = target.entries[0]!;
	const message = transcriptEntryMessage(entry);
	switch (message?.role) {
		case "user":
			return { content: rawUserText(message), label: "user message" };
		case "assistant": {
			const text = assistantVisibleText(message);
			if (text) return { content: text, label: "assistant message" };
			break;
		}
		case "toolResult": {
			const text = toolResultText(message);
			if (text) return { content: text, label: `${message.toolName} result` };
			break;
		}
		case "bashExecution":
			return {
				content: [message.command, message.output].filter(part => part.trim()).join("\n"),
				label: "bash execution",
			};
		case "pythonExecution":
			return {
				content: [message.code, message.output].filter(part => part.trim()).join("\n"),
				label: "eval execution",
			};
		case "compactionSummary":
		case "branchSummary":
			return { content: message.summary, label: "summary" };
		case "custom":
		case "hookMessage": {
			// A user-invoked skill/collab prompt copies as what the user typed, not the expanded body.
			const draft = message.role === "custom" ? userTurnDraft(entry) : undefined;
			if (draft?.trim()) return { content: draft, label: "user message" };
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map(block => block.text)
							.join("\n");
			if (content.trim()) return { content, label: "message" };
			break;
		}
		default:
			break;
	}
	// No direct prose (e.g. a pure tool turn): fall back to its blocks joined.
	return { content: blocks.map(block => block.content).join("\n\n"), label: "turn content" };
}
