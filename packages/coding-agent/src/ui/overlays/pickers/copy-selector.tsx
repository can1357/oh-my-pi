/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Shared transcript picker used by `/copy` and annotation session sources: a
 * `timeline` picker of the branch's turns.
 *
 * The selected turn's side preview holds its whole text and each inner block
 * (fenced code, quotes, links, commands, tool output) as sections the current
 * action can pick. Select/activate highlights a turn with blocks; use Blocks
 * to browse them or Copy/Select/Enter to accept the whole turn. A turn without
 * blocks activates immediately. When descended, ↑/↓ move between blocks, ← or
 * ⎋ back; ⏎ picks the focused block; `o` opens a link block. Long sessions
 * replay only their tail until ↑ walks past it (or `a`).
 *
 * The terminal fills the screen with the branch drawn by the transcript's own
 * blocks (`./transcript-turns`; ^O expands them), the outlined turn boxed, or
 * the turn's blocks in its place once descended.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Accessor, batch, computed, type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { lexMarkdown } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import type { TspPickerAction, TspPickerItem } from "@oh-my-pi/pi-wire";
import { sanitizeDisplaySingleLine } from "../../../extensibility/inventory/display-text";
import { previewLine, TRUNCATE_LENGTHS } from "../../../utils/render-utils";
import type { CopyBlock, CopyPickSource } from "../../../modes/view-model/overlays/copy-selector";
import { commandFromToolCall } from "../../../modes/view-model/overlays/copy-targets";
import { isReplyWrite, toolResultReplies } from "../../../session/transcript/reply-write";
import {
	isUserRequestEntry,
	recentTranscriptEntries,
	type TranscriptEntryLike,
	textContent,
	transcriptEntryMessage,
	userTurnDraft,
} from "../../../session/transcript/transcript-entry";
import "../../styles/pickers/copy";
import type { CopyLookTerm } from "../../styles/pickers/copy";
import { closeAction, pickerAction } from "./select-sheet";
import { TurnViews } from "./transcript-turns";
import {
	appToolsExpandKeys,
	matchesAnyKey,
	matchesSelectCancel,
	selectKeyId,
} from "../../../config/keybindings/matchers";

export interface CopySelectorProps {
	readonly entries: readonly TranscriptEntryLike[];
	/** Replaces the "Copy" heading when the picker serves another purpose. */
	readonly title?: string;
	/** The pick verb (default "copy"). */
	readonly actionLabel?: string;
	onPick(content: string, label: string, source: CopyPickSource): void;
	/** `o` on a link block; absent: links are not opened. */
	onOpen?(href: string, label: string): void;
	onCancel(): void;
	/** Screen rows, for a terminal layer that allots the screen no height. */
	readonly terminalRows?: Accessor<number>;
}

/** Maximum code lines rendered in a block's side preview; picking retains full content. */
const PREVIEW_BLOCK_LINES = 400;
/** Lines of a block the terminal shows while descended. */
const TERMINAL_BLOCK_LINES = 12;
const TOOL_TARGET_KEYS = ["command", "pattern", "path", "file_path", "query", "url", "code"] as const;

/** A turn: a message entry plus the tool results folded into it. */
export interface Target {
	readonly turnId: string;
	readonly isUserTurn: boolean;
	readonly entries: readonly TranscriptEntryLike[];
}

interface MarkdownToken {
	type: string;
	text?: string;
	lang?: string;
	href?: string;
	codeBlockStyle?: string;
	tokens?: MarkdownToken[];
	items?: MarkdownToken[];
}

function targetsOf(entries: readonly TranscriptEntryLike[]): Target[] {
	const targets: Target[] = [];
	for (const entry of entries) {
		const message = transcriptEntryMessage(entry);
		if (!message) continue;
		const previous = targets.at(-1);
		if (message.role === "toolResult" && previous) {
			targets[targets.length - 1] = { ...previous, entries: [...previous.entries, entry] };
			continue;
		}
		targets.push({ turnId: entry.id, isUserTurn: isUserRequestEntry(entry), entries: [entry] });
	}
	return targets;
}

const firstLine = (source: string): string =>
	(source.split("\n").find(part => part.trim().length > 0) ?? "").replace(/\s+/g, " ").trim();

/** One prose piece of a turn: message text, or an `out://` reply the transcript draws as prose of its own. */
interface ProsePiece {
	readonly text: string;
	/** A reply starts its own paragraph rather than continuing the text. */
	readonly reply: boolean;
}

/** Text a `write` call sends to the user as a reply (`out://`), else undefined. */
function replyWriteText(name: string, args: unknown): string | undefined {
	if (isReplyWrite(name, args) !== true || typeof args !== "object" || args === null) return undefined;
	const text = (args as { content?: unknown }).content;
	return typeof text === "string" && text.trim() ? text : undefined;
}

/** An assistant message's text blocks and reply writes, in document order. */
function assistantProse(entry: TranscriptEntryLike): ProsePiece[] {
	const message = transcriptEntryMessage(entry);
	if (message?.role !== "assistant") return [];
	const pieces: ProsePiece[] = [];
	for (const part of message.content) {
		if (part.type === "text") pieces.push({ text: (part as { text: string }).text, reply: false });
		else if (part.type === "toolCall") {
			const reply = replyWriteText(part.name, part.arguments);
			if (reply !== undefined) pieces.push({ text: reply, reply: true });
		}
	}
	return pieces;
}

/** Text blocks concatenate verbatim; a reply forms its own paragraph. */
function joinProse(pieces: readonly ProsePiece[]): string {
	let text = "";
	let afterReply = false;
	for (const piece of pieces) {
		if (!piece.text) continue;
		if ((piece.reply || afterReply) && text !== "" && !text.endsWith("\n")) text += "\n\n";
		text += piece.text;
		afterReply = piece.reply;
	}
	return text.trim();
}

function assistantText(entry: TranscriptEntryLike): string {
	return joinProse(assistantProse(entry));
}

/**
 * The prose a turn shows, in transcript order: its assistant text and `out://` replies, then
 * the replies its tool results carry (`bash > out://`, an eval cell's bridged write).
 */
function turnProse(target: Target): string {
	const pieces = assistantProse(target.entries[0]!);
	for (const entry of target.entries) {
		const message = transcriptEntryMessage(entry);
		if (message?.role !== "toolResult") continue;
		for (const reply of toolResultReplies(message.details)) pieces.push({ text: reply, reply: true });
	}
	return joinProse(pieces);
}

function toolResultText(entry: TranscriptEntryLike): string {
	const message = transcriptEntryMessage(entry);
	if (message?.role !== "toolResult") return "";
	return textContent(message.content as never, "\n").trim();
}

/** Fenced code, quotes and http(s) links of markdown, in document order. */
function markdownBlocks(text: string, entry: TranscriptEntryLike): CopyBlock[] {
	const blocks: CopyBlock[] = [];
	const links: CopyBlock[] = [];
	const seen = new Set<string>();
	const walk = (tokens: readonly MarkdownToken[] | undefined, top: boolean): void => {
		for (const token of tokens ?? []) {
			if (top && token.type === "code" && token.codeBlockStyle !== "indented") {
				const lang = (token.lang ?? "").trim();
				blocks.push({
					label: lang ? `${lang} code` : "code",
					content: token.text ?? "",
					entry,
					kind: "code",
					language: lang || undefined,
				});
				continue;
			}
			if (top && token.type === "blockquote") {
				blocks.push({ label: "quote", content: (token.text ?? "").replace(/\n+$/, ""), entry, kind: "quote" });
				walk(token.tokens, false);
				continue;
			}
			if (token.type === "link" && token.href && /^https?:\/\//i.test(token.href) && !seen.has(token.href)) {
				seen.add(token.href);
				const label = (token.text ?? "").replace(/\s+/g, " ").trim() || token.href;
				links.push({
					label: label !== token.href ? `link · ${label}` : "link",
					content: token.href,
					entry,
					href: token.href,
				});
			}
			if (token.type === "list") walk(token.items, top);
			else if (token.type === "list_item") walk(token.tokens, top);
			else walk(token.tokens, false);
		}
	};
	walk(lexMarkdown(text) as unknown as MarkdownToken[], true);
	return [...blocks, ...links];
}

/** Inner blocks of a turn: markdown code/quotes/links, commands and tool output. */
export function collectBlocks(target: Target): CopyBlock[] {
	const blocks: CopyBlock[] = [];
	/** Reply writes: their text came from the calls, their results hold a placeholder. */
	const replyCalls = new Set<string>();
	for (const entry of target.entries) {
		const message = transcriptEntryMessage(entry);
		if (!message) continue;
		if (message.role === "user") blocks.push(...markdownBlocks(textContent(message.content as never), entry));
		else if (message.role === "assistant") {
			blocks.push(...markdownBlocks(assistantText(entry), entry));
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (isReplyWrite(part.name, part.arguments) === true) {
					replyCalls.add(part.id);
					continue;
				}
				const command = commandFromToolCall(part);
				if (command)
					blocks.push({
						label: command.kind === "bash" ? "bash command" : "eval code",
						content: command.code,
						entry,
						kind: "command",
						language: command.language,
					});
			}
		} else if (message.role === "toolResult") {
			if (message.isError !== true && replyCalls.has(message.toolCallId)) continue;
			for (const reply of toolResultReplies(message.details)) blocks.push(...markdownBlocks(reply, entry));
			const text = toolResultText(entry);
			if (text) blocks.push({ label: `${message.toolName} result`, content: text, entry });
		} else if (message.role === "bashExecution") {
			blocks.push({ label: "command", content: message.command, entry, language: "bash" });
			if (message.output.trim()) blocks.push({ label: "output", content: message.output, entry });
		} else if (message.role === "pythonExecution") {
			blocks.push({ label: "eval code", content: message.code, entry, language: "python" });
			if (message.output.trim()) blocks.push({ label: "output", content: message.output, entry });
		}
	}
	return blocks;
}

/** The whole turn's clipboard text and what it is, falling back to its blocks when the turn has no prose. */
export function targetCopy(target: Target, blocks: readonly CopyBlock[]): { content: string; label: string } {
	const entry = target.entries[0]!;
	const message = transcriptEntryMessage(entry);
	switch (message?.role) {
		case "user":
			return { content: textContent(message.content as never, "\n"), label: "user message" };
		case "assistant": {
			const text = turnProse(target);
			if (text) return { content: text, label: "assistant message" };
			break;
		}
		case "toolResult": {
			const content = [...toolResultReplies(message.details), toolResultText(entry)]
				.filter(part => part.trim())
				.join("\n\n");
			if (content) return { content, label: `${message.toolName} result` };
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
			const content = textContent(message.content as never, "\n");
			if (content.trim()) return { content, label: "message" };
			break;
		}
	}
	return { content: blocks.map(block => block.content).join("\n\n"), label: "turn content" };
}

/** Everything a turn (`entries`: its entry and folded tool results) says, lowercased: its text, commands and tool output. */
export function turnSearchText(entries: readonly TranscriptEntryLike[]): string {
	const target: Target = { turnId: entries[0]?.id ?? "", isUserTurn: false, entries };
	const blocks = collectBlocks(target);
	return [targetCopy(target, blocks).content, ...blocks.map(block => block.content)].join("\n").toLowerCase();
}

function entryTime(entry: TranscriptEntryLike): string {
	const date = new Date((entry as { timestamp?: string }).timestamp ?? "");
	if (Number.isNaN(date.getTime())) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toolCallLabel(name: string, args: Record<string, unknown> | undefined): string {
	for (const key of TOOL_TARGET_KEYS) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return `${name} ${firstLine(value)}`;
	}
	return name;
}

/** A turn as a timeline row. */
function timelineItem(target: Target): TspPickerItem {
	const entry = target.entries[0]!;
	const id = target.turnId;
	const message = transcriptEntryMessage(entry);
	if (target.isUserTurn) {
		const label =
			message?.role === "user"
				? textContent(message.content as never, " ")
						.replace(/\s+/g, " ")
						.trim()
				: id;
		const at = entryTime(entry);
		return { id, label: label || "(empty)", node: "user", ...(at ? { facts: { at } } : {}) };
	}
	if (message?.role === "assistant") {
		const calls = message.content.filter(part => part.type === "toolCall") as {
			name: string;
			arguments: Record<string, unknown>;
		}[];
		const prose = assistantText(entry);
		if (prose || calls.length === 0)
			return { id, label: firstLine(prose) || calls.map(c => c.name).join(", ") || "thinking", node: "assistant" };
		return {
			id,
			label: calls.map(call => toolCallLabel(call.name, call.arguments)).join(" · "),
			node: "tool",
			role: `omp.tool.${calls[0]!.name}`,
		};
	}
	if (message?.role === "toolResult")
		return { id, label: `${message.toolName} result`, node: "tool", role: `omp.tool.${message.toolName}` };
	return { id, label: id, node: "marker" };
}

function blockCaption(block: CopyBlock): string {
	if (block.href || block.kind === "quote") return block.label;
	const lines = block.content.split("\n").length;
	const kind = block.kind === "code" ? (block.language ?? "code") : block.label;
	return `${kind} · ${lines} line${lines === 1 ? "" : "s"}`;
}

function blockItemId(target: Target, index: number): string {
	return `copy-block:${target.turnId}:${index}`;
}

/** A block row carries its caption and first source line, not just its language. */
function blockPickerItem(target: Target, block: CopyBlock, index: number): TspPickerItem {
	const firstSourceLine = block.content.split("\n").find(line => line.trim().length > 0) ?? "";
	const preview = previewLine(sanitizeDisplaySingleLine(firstSourceLine), TRUNCATE_LENGTHS.CONTENT);
	return {
		id: blockItemId(target, index),
		label: blockCaption(block),
		detail: preview || "(empty)",
	};
}

function blockBody(block: CopyBlock): JSXNode {
	if (block.href) return <text spans={[{ t: block.href, s: "link" }]} wrap="char" href={block.href} />;
	if (block.kind === "quote") return <md text={block.content} />;
	const lines = block.content.split("\n");
	if (lines.length <= PREVIEW_BLOCK_LINES) return <code text={block.content} lang={block.language} wrap={true} />;
	return (
		<col gap="xs">
			<code text={lines.slice(0, PREVIEW_BLOCK_LINES).join("\n")} lang={block.language} wrap={true} />
			<text spans={[{ t: `… +${lines.length - PREVIEW_BLOCK_LINES} more lines`, s: "dim" }]} />
		</col>
	);
}

/** A block as the terminal shows it while descended: a link on one row, else its first lines. */
function terminalBlockBody(block: CopyBlock): JSXNode {
	if (block.href) return <text text={block.href} truncate="end" />;
	const lines = block.content.split("\n");
	return (
		<>
			<code text={lines.slice(0, TERMINAL_BLOCK_LINES).join("\n")} lang={block.language} wrap={true} />
			{lines.length > TERMINAL_BLOCK_LINES && (
				<text spans={[{ t: `… +${lines.length - TERMINAL_BLOCK_LINES} more lines`, s: "dim" }]} />
			)}
		</>
	);
}

/** A preview click picks the full source through the program, not Tern's local Copy action. */
function previewSection(
	key: string,
	head: string,
	body: JSXNode,
	focused: boolean,
	onAction: (act: string, section?: string) => void,
	href?: string,
): JSXNode {
	return (
		<section
			key={key}
			head={head}
			role={focused ? "omp.picker.block.focused" : "omp.picker.block"}
			tone={focused ? "accent" : undefined}
			href={href}
			actions={{ click: "pick", ...(href ? { menu: ["copy", "open"] } : {}) }}
			onAction={act => onAction(act, key)}
		>
			{body}
		</section>
	);
}

/** Preview of a turn's text: prose as markdown, command and tool output as a plain code block. */
export function turnPreview(target: Target, content: string): JSXNode {
	if (!content.trim()) return <text spans={[{ t: "(no text)", s: "muted" }]} />;
	const message = transcriptEntryMessage(target.entries[0]!);
	switch (message?.role) {
		case "assistant":
			// A pure tool turn previews its joined commands and results, not prose.
			return turnProse(target) ? <md text={content} /> : <code text={content} wrap={true} />;
		case "user":
		case "custom":
		case "hookMessage":
		case "compactionSummary":
		case "branchSummary":
			return <md text={content} />;
		default:
			return <code text={content} wrap={true} />;
	}
}

export function CopySelector(props: CopySelectorProps): JSXNode {
	const all = props.entries;
	const tail = recentTranscriptEntries(all);
	const truncated = signal(tail.length < all.length);
	const targets = computed(() => targetsOf(truncated() ? tail : all));
	const selected = signal(Math.max(0, targets().length - 1));
	/** The focused block while descended into the turn's blocks. */
	const blockAt = signal<number | undefined>(undefined);
	const blockCache = new Map<string, CopyBlock[]>();
	const blocksOf = (target: Target): CopyBlock[] => {
		let blocks = blockCache.get(target.turnId);
		if (!blocks) blockCache.set(target.turnId, (blocks = collectBlocks(target)));
		return blocks;
	};
	const target = (): Target | undefined => targets()[selected()];
	const views = new TurnViews();
	const messagesOf = (t: Target): AgentMessage[] => t.entries.flatMap(entry => transcriptEntryMessage(entry) ?? []);
	const action = props.actionLabel ?? "copy";

	const loadEarlier = (): void => {
		if (!truncated()) return;
		const keep = target()?.turnId;
		batch(() => {
			truncated.set(false);
			const restored = keep ? targets().findIndex(t => t.turnId === keep) : -1;
			selected.set(restored >= 0 ? restored : Math.max(0, targets().length - 1));
			blockAt.set(undefined);
		});
	};
	const descend = (): void => {
		const current = target();
		if (blockAt() !== undefined || !current || blocksOf(current).length === 0) return;
		blockAt.set(0);
	};
	const pickSection = (key: string): void => {
		const current = target();
		if (!current) return;
		const blocks = blocksOf(current);
		if (key === "whole") {
			const whole = targetCopy(current, blocks);
			props.onPick(whole.content, whole.label, { entry: current.entries[0]! });
			return;
		}
		const block = key.startsWith("b") ? blocks[Number(key.slice(1))] : undefined;
		if (block) props.onPick(block.content, block.label, { entry: block.entry, block });
	};
	const pick = (): void => {
		const current = target();
		if (!current) return;
		const at = blockAt();
		if (at !== undefined) {
			const block = blocksOf(current)[at];
			if (block) props.onPick(block.content, block.label, { entry: block.entry, block });
			return;
		}
		pickSection("whole");
	};
	const openLink = (): void => {
		const at = blockAt();
		const current = target();
		const block = at === undefined || !current ? undefined : blocksOf(current)[at];
		if (block?.href && props.onOpen) props.onOpen(block.href, block.label);
	};
	const escape = (): void => {
		if (blockAt() !== undefined) blockAt.set(undefined);
		else props.onCancel();
	};
	const move = (delta: -1 | 1): void => {
		const at = blockAt();
		const current = target();
		if (at !== undefined && current) {
			const next = at + delta;
			if (next >= 0 && next < blocksOf(current).length) blockAt.set(next);
			return;
		}
		const next = selected() + delta;
		if (next >= 0 && next < targets().length) selected.set(next);
		else if (delta < 0 && truncated()) {
			loadEarlier();
			move(delta);
		}
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		if (matchesSelectCancel(key)) {
			escape();
			return true;
		}
		if (matchesAnyKey(key, appToolsExpandKeys())) {
			views.toggleExpanded();
			return true;
		}
		switch (selectKeyId(key)) {
			case "up":
				move(-1);
				return true;
			case "down":
				move(1);
				return true;
			case "right":
				descend();
				return true;
			case "left":
				if (blockAt() !== undefined) blockAt.set(undefined);
				return true;
			case "a":
			case "shift+a":
				if (blockAt() === undefined) loadEarlier();
				return true;
			case "o":
			case "shift+o":
				openLink();
				return true;
			case "enter":
				pick();
				return true;
			// Page keys scroll the transcript view; the outline stays.
			case "pageUp":
			case "pageDown":
			case "home":
			case "end":
				return true;
		}
		return false;
	};
	const onSelectItem = (id: string, activate: boolean): void => {
		if (blockAt() !== undefined) {
			const current = target();
			if (!current) return;
			const index = blocksOf(current).findIndex((_, blockIndex) => blockItemId(current, blockIndex) === id);
			if (index < 0) return;
			if (index !== blockAt()) blockAt.set(index);
			if (activate) pick();
			return;
		}
		const currentTargets = targets();
		const index = currentTargets.findIndex(t => t.turnId === id);
		if (index < 0) return;
		selected.set(index);
		// A single Tern tap can activate a row. Don't skip its block choices.
		if (activate && blocksOf(currentTargets[index]!).length === 0) pick();
	};

	const onAction = (act: string, section?: string): void => {
		switch (act) {
			case "pick":
				return section === undefined ? pick() : pickSection(section);
			case "blocks":
				return descend();
			case "back":
				blockAt.set(undefined);
				return;
			case "open":
			case "open-link":
				return openLink();
			case "earlier":
				return loadEarlier();
			case "close":
				return escape();
		}
	};

	const items = computed(() => {
		const current = target();
		const at = blockAt();
		return current && at !== undefined
			? blocksOf(current).map((block, index) => blockPickerItem(current, block, index))
			: targets().map(timelineItem);
	});
	const actions = (): TspPickerAction[] => {
		const current = target();
		const blocks = current ? blocksOf(current) : [];
		const at = blockAt();
		const focused = at === undefined ? undefined : blocks[at];
		const out = [pickerAction("pick", `${action[0]!.toUpperCase()}${action.slice(1)}`, "enter", { primary: true })];
		if (at === undefined && blocks.length > 0) out.push(pickerAction("blocks", "Blocks", "right"));
		if (focused?.href && props.onOpen) out.push(pickerAction("open-link", "Open link", "o"));
		if (at === undefined && truncated()) out.push(pickerAction("earlier", "Earlier turns", "a"));
		out.push(at !== undefined ? pickerAction("back", "Back", "left", { end: true }) : closeAction());
		return out;
	};

	const preview = (): JSXNode => {
		const current = target();
		if (!current) return null;
		const blocks = blocksOf(current);
		const at = blockAt();
		const blockSection = (block: CopyBlock, index: number) =>
			previewSection(`b${index}`, blockCaption(block), blockBody(block), at === index, onAction, block.href);
		if (at !== undefined) {
			const block = blocks[at];
			return block ? blockSection(block, at) : null;
		}
		const out: JSXNode[] = [];
		const whole = targetCopy(current, blocks);
		if (whole.content.trim())
			out.push(previewSection("whole", "Whole message", turnPreview(current, whole.content), false, onAction));
		blocks.forEach((block, index) => out.push(blockSection(block, index)));
		return out;
	};

	const term = (): CopyLookTerm => {
		const at = blockAt();
		const current = target();
		const blocks = current ? blocksOf(current) : [];
		return {
			look: "omp.copy",
			role: "omp.copy",
			heading: props.title,
			turns: targets().map((t, index) => ({
				blocks: views.blocks(t.turnId, messagesOf(t)),
				outlined: index === selected() && at === undefined,
				count: blocksOf(t).length,
			})),
			descended:
				at === undefined || !current
					? undefined
					: {
							at: selected(),
							blocks: blocks.map((block, index) => {
								const lines = block.content.split("\n");
								return {
									caption: `${block.label} · ${lines.length} line${lines.length === 1 ? "" : "s"}`,
									body: views.nodes(`${current.turnId}/b${index}`, () => terminalBlockBody(block)),
									focused: index === at,
									link: block.href !== undefined,
								};
							}),
						},
			counter:
				at !== undefined
					? `${at + 1}/${blocks.length}`
					: targets().length > 0
						? `${selected() + 1}/${targets().length}`
						: "",
			action,
			opens: props.onOpen !== undefined,
			truncated: truncated(),
			screenRows: props.terminalRows?.(),
		};
	};

	return (
		<picker
			title={props.title ?? "Copy"}
			subtitle={props.title ? undefined : "Pick what to put on the clipboard"}
			icon="clipboard"
			noun={() => (blockAt() === undefined ? "turns" : "blocks")}
			size="lg"
			layout={() => (blockAt() === undefined ? "timeline" : "rows")}
			preview="side"
			query={null}
			columns={[{ id: "at", format: "dim", priority: 1 }]}
			items={items}
			selected={() => {
				const current = target();
				const at = blockAt();
				return current ? (at === undefined ? current.turnId : blockItemId(current, at)) : null;
			}}
			total={() => {
				const current = target();
				return blockAt() !== undefined && current ? blocksOf(current).length : targets().length;
			}}
			empty="Nothing to copy"
			focus="list"
			actions={actions}
			term={term}
			onKey={onKey}
			onSelect={id => onSelectItem(id, false)}
			onActivate={id => onSelectItem(id, true)}
			onAction={act => onAction(act)}
		>
			{preview}
		</picker>
	);
}
