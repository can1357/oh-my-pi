/**
 * Fullscreen `/copy` picker over the transcript itself.
 *
 * Replays the current branch with {@link ChatTranscriptBuilder} on the
 * alternate screen and moves the same dotted outline the esc-esc rewind
 * selector uses over the rendered items; Enter copies the outlined turn's
 * text. Right descends into the turn's inner blocks — fenced code, `>`-quotes,
 * bash/eval commands, tool output — replacing the turn's rendered region with
 * a stacked, syntax-highlighted block view whose outline steps per block;
 * Left/Esc ascend back to the transcript.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	routeSgrMouseInput,
	ScrollView,
	type TUI,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { SessionMessageEntry } from "../../session/session-entries";
import { replaceTabs } from "../../tools/render-utils";
import { highlightCode, type ThemeColor, theme } from "../theme/theme";
import { commandFromToolCall, extractBlocks } from "../utils/copy-targets";
import {
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import {
	appendOutlineEntries,
	type ComposedColumn,
	composeOutlineColumn,
	type OutlineTarget,
	outlineRows,
	outlineVisibility,
	stripPromptZones,
} from "./transcript-outline";

export interface CopySelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
	/** The outlined content was chosen — copy it. `label` feeds the status line. */
	onPick: (content: string, label: string) => void;
	onCancel: () => void;
}

/** One copyable inner block of a transcript turn. */
interface CopyBlock {
	/** Short kind label ("code · ts", "bash command", "read result", …). */
	label: string;
	/** Exact text placed on the clipboard. */
	content: string;
	/** Highlight language for the block preview. */
	language?: string;
}

/** Rows the frame chrome occupies: top rule, header, rule, footer hint, bottom rule. */
const CHROME_ROWS = 5;
/** Preview rows shown per block in the descended view; copy always takes the full text. */
const BLOCK_PREVIEW_LINES = 12;
/** The copy picker's outline stroke — green, distinct from the rewind selector's accent. */
const OUTLINE_COLOR: ThemeColor = "success";

export class CopySelectorComponent implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#border = new DynamicBorder();
	#targets: OutlineTarget[] = [];
	#selected = 0;
	#visible: boolean[] | undefined;
	#scrollToSelection = true;
	#expanded = false;
	/** Inner blocks of the selected turn while descended, else undefined. */
	#blocks: CopyBlock[] | undefined;
	#blockSelected = 0;
	#blockCache = new Map<string, CopyBlock[]>();

	constructor(
		entries: SessionMessageEntry[],
		private readonly deps: CopySelectorDeps,
	) {
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			isBuiltInTool: deps.isBuiltInTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
		this.#targets = appendOutlineEntries(this.#builder, entries);
		this.#selected = Math.max(0, this.#targets.length - 1);
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
	}

	/** Number of copyable transcript items; hosts skip mounting when zero. */
	get targetCount(): number {
		return this.#targets.length;
	}

	invalidate(): void {
		this.#builder.container.invalidate();
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
					this.#scrollView.scroll(event.wheel * 3);
					this.deps.requestRender();
				}
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
			this.#scrollToSelection = true;
			this.deps.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#blocks) this.#ascend();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (this.#blocks) {
				const block = this.#blocks[this.#blockSelected];
				if (block) this.deps.onPick(block.content, block.label);
				return;
			}
			const target = this.#targets[this.#selected];
			if (!target) return;
			const item = targetCopy(target, this.#blocksFor(target));
			this.deps.onPick(item.content, item.label);
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#scrollView.handleScrollKey(data)) {
			this.deps.requestRender();
		}
	}

	#ascend(): void {
		this.#blocks = undefined;
		this.#blockSelected = 0;
		this.#scrollToSelection = true;
		this.deps.requestRender();
	}

	#moveVertical(delta: -1 | 1): void {
		if (this.#blocks) {
			const next = this.#blockSelected + delta;
			if (next >= 0 && next < this.#blocks.length) {
				this.#blockSelected = next;
				this.#scrollToSelection = true;
				this.deps.requestRender();
			}
			return;
		}
		let index = this.#selected + delta;
		while (index >= 0 && index < this.#targets.length) {
			if (this.#visible?.[index] !== false) {
				this.#selected = index;
				this.#scrollToSelection = true;
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
		const termHeight = process.stdout.rows || 40;
		const contentWidth = Math.max(1, width - 1);
		const children = this.#builder.container.children;
		const inner = Math.max(10, contentWidth - 4);
		const childRows = children.map(child => stripPromptZones(child.render(inner)));

		this.#visible = outlineVisibility(childRows, this.#targets);
		if (this.#visible[this.#selected] === false) {
			let above = this.#selected - 1;
			while (above >= 0 && this.#visible[above] === false) above--;
			let below = this.#selected + 1;
			while (below < this.#targets.length && this.#visible[below] === false) below++;
			if (above >= 0) this.#selected = above;
			else if (below < this.#targets.length) this.#selected = below;
			this.#blocks = undefined;
		}

		const target = this.#targets[this.#selected];
		const blocks = target ? this.#blocksFor(target) : [];
		let composed: ComposedColumn;
		if (this.#blocks && target) {
			// Descended: the turn's rendered region is replaced by its block stack.
			const before = composeOutlineColumn(childRows, 0, target.start, [], -1, contentWidth, undefined);
			const stack = this.#composeBlocks(this.#blocks, contentWidth);
			const after = composeOutlineColumn(childRows, target.end, children.length, [], -1, contentWidth, undefined);
			composed = {
				lines: [...before.lines, ...stack.lines, ...after.lines],
				selStart: stack.selStart >= 0 ? before.lines.length + stack.selStart : -1,
				selEnd: stack.selEnd >= 0 ? before.lines.length + stack.selEnd : -1,
			};
		} else {
			// The caption on the outline advertises Right's descent into blocks.
			composed = composeOutlineColumn(
				childRows,
				0,
				children.length,
				this.#targets,
				this.#selected,
				contentWidth,
				undefined,
				{
					color: OUTLINE_COLOR,
					caption: blocks.length > 0 ? `${blocks.length} block${blocks.length === 1 ? "" : "s"} →` : undefined,
				},
			);
		}

		const viewportHeight = Math.max(3, termHeight - CHROME_ROWS);
		this.#scrollView.setLines(composed.lines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#scrollToSelection && composed.selStart >= 0) {
			const offset = this.#scrollView.getScrollOffset();
			const top = Math.max(0, composed.selStart - 1);
			const bottom = Math.min(composed.lines.length, composed.selEnd + 1);
			if (top < offset) this.#scrollView.setScrollOffset(top);
			else if (bottom > offset + viewportHeight) this.#scrollView.setScrollOffset(bottom - viewportHeight);
			this.#scrollToSelection = false;
		}

		const output: string[] = [];
		output.push(...this.#border.render(width));
		output.push(
			` ${theme.cmd.copy} ${theme.bold("Copy")}${theme.sep.dot}${theme.fg("dim", "pick what to put on the clipboard")}`,
		);
		output.push(...this.#border.render(width));
		output.push(...this.#scrollView.render(width));
		const hint = this.#blocks
			? `${this.#blockSelected + 1}/${this.#blocks.length}  ↑/↓ block  ←/esc back  enter copy`
			: `${this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : ""}↑/↓ step  ${blocks.length > 0 ? "→ blocks  " : ""}enter copy  ctrl+o expand  esc close`;
		output.push(` ${theme.fg("dim", hint)}`);
		output.push(...this.#border.render(width));
		return output;
	}

	/** The selected turn exploded into captioned block previews, selected one outlined. */
	#composeBlocks(blocks: CopyBlock[], columnWidth: number): ComposedColumn {
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
			const caption = truncateToWidth(
				`${index + 1}/${blocks.length}${theme.sep.dot}${block.label}${theme.sep.dot}${raw.length} line${raw.length === 1 ? "" : "s"}`,
				inner,
			);
			lines.push("");
			if (index === this.#blockSelected) {
				selStart = lines.length;
				lines.push(`  ${theme.fg(OUTLINE_COLOR, caption)}`);
				lines.push(...outlineRows(rows, inner, { color: OUTLINE_COLOR }));
				selEnd = lines.length;
			} else {
				lines.push(`  ${theme.fg("dim", caption)}`);
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

function pushMarkdownBlocks(blocks: CopyBlock[], text: string): void {
	for (const block of extractBlocks(text)) {
		if (block.kind === "code") {
			blocks.push({
				label: block.lang ? `${block.lang} code` : "code",
				content: block.code,
				language: block.lang || undefined,
			});
		} else {
			blocks.push({ label: "quote", content: block.text });
		}
	}
}

/** Inner blocks of one turn: markdown code/quotes, commands, and tool output. */
function collectBlocks(entries: readonly SessionMessageEntry[]): CopyBlock[] {
	const blocks: CopyBlock[] = [];
	for (const entry of entries) {
		const message = entry.message;
		switch (message.role) {
			case "user":
				pushMarkdownBlocks(blocks, rawUserText(message));
				break;
			case "assistant": {
				pushMarkdownBlocks(blocks, assistantVisibleText(message));
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const command = commandFromToolCall(content);
					if (command) {
						blocks.push({
							label: command.kind === "bash" ? "bash command" : "eval code",
							content: command.code,
							language: command.language,
						});
					}
				}
				break;
			}
			case "toolResult": {
				const text = toolResultText(message);
				if (text) blocks.push({ label: `${message.toolName} result`, content: text });
				break;
			}
			case "bashExecution":
				blocks.push({ label: "command", content: message.command, language: "bash" });
				if (message.output.trim()) blocks.push({ label: "output", content: message.output });
				break;
			case "pythonExecution":
				blocks.push({ label: "eval code", content: message.code, language: "python" });
				if (message.output.trim()) blocks.push({ label: "output", content: message.output });
				break;
			default:
				break;
		}
	}
	return blocks;
}

/** Clipboard payload for a whole turn, falling back to its blocks when the turn has no prose. */
function targetCopy(target: OutlineTarget, blocks: readonly CopyBlock[]): { content: string; label: string } {
	const message = target.entries[0]!.message;
	switch (message.role) {
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
