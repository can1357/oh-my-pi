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
import { type Component, matchesKey, routeSgrMouseInput, type TUI, truncateToWidth, visibleWidth } from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import {
	recentTranscriptEntries,
	type SessionMessageEntryLike as SessionMessageEntry,
	type TranscriptEntryLike as TranscriptEntry,
	transcriptEntryMessage,
	userTurnDraft,
} from "../chat/transcript-entry";
import { replaceTabs } from "../render/render-utils";
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

export interface CopySelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
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
			if (this.#blocks) this.#ascend();
			else this.deps.onCancel();
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
			if (this.#blocks) return;
			const target = this.#targets[this.#selected];
			if (!target) return;
			const blocks = this.#blocksFor(target);
			if (blocks.length === 0) return;
			this.#blocks = blocks;
			this.#blockSelected = 0;
			this.deps.requestRender();
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
			const block = this.#blocks?.[this.#blockSelected];
			if (block?.href && this.deps.onOpen) this.deps.onOpen(block.href, block.label);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (this.#blocks) {
				const block = this.#blocks[this.#blockSelected];
				if (block) this.deps.onPick(block.content, block.label, { entry: block.entry, block });
				return;
			}
			const target = this.#targets[this.#selected];
			if (!target) return;
			const item = targetCopy(target, this.#blocksFor(target));
			this.deps.onPick(item.content, item.label, { entry: target.entries[0]! });
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#browser.handleScrollKey(data)) {
			this.deps.requestRender();
		}
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
					caption: blocks.length > 0 ? `${blocks.length} block${blocks.length === 1 ? "" : "s"} →` : undefined,
				},
			}).column;
		}

		const selectedBlock = this.#blocks?.[this.#blockSelected];
		const openHint = selectedBlock?.href && this.deps.onOpen ? "  o open" : "";
		const action = this.deps.actionLabel ?? "copy";
		const hint = this.#blocks
			? `${this.#blockSelected + 1}/${this.#blocks.length}  ↑/↓ block  ←/esc back  enter ${action}${openHint}  click ${theme.cmd.copy}/${theme.cmd.share}`
			: `${this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : ""}↑/↓ step  ${blocks.length > 0 ? "→ blocks  " : ""}enter ${action}  ${this.#truncated ? "a earlier turns  " : ""}ctrl+o expand  esc close`;
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
function collectBlocks(entries: readonly TranscriptEntry[]): CopyBlock[] {
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
function targetCopy(target: OutlineTarget, blocks: readonly CopyBlock[]): { content: string; label: string } {
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
