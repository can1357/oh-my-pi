import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";

/** A fenced code block extracted from assistant markdown. */
export interface CodeBlock {
	/** Info string after the opening fence (language id), trimmed. */
	lang: string;
	/** Block body with the trailing newline stripped. */
	code: string;
}

/** A blockquote block: a maximal run of `>`-prefixed lines from markdown. */
export interface QuoteBlock {
	/** Block body with each line's `>` marker (and one optional space) removed. */
	text: string;
}

/** A drillable block within an assistant message, in document order. */
export type MessageBlock = ({ kind: "code" } & CodeBlock) | ({ kind: "quote" } & QuoteBlock);

/** A runnable command found in the transcript. */
export interface LastCommand {
	kind: "bash" | "eval";
	code: string;
	/** Highlight language: "bash" for bash, or the resolved eval language ("python"/"javascript"/"ruby"/"julia"). */
	language: string;
}

/**
 * A node in the `/copy` picker tree. Leaves carry `content` (placed on the
 * clipboard) plus `copyMessage` (the status shown afterwards); groups carry
 * `children` to drill into.
 */
export interface CopyTarget {
	/** Stable id (e.g. "msg:1", "msg:1:code:0", "msg:1:quote:0", "msg:1:all", "you:1", "cmd:1"). */
	id: string;
	label: string;
	/** Dim annotation: line/block counts, language, or tool name. */
	hint?: string;
	/** Full text rendered in the preview pane. */
	preview: string;
	/** Highlight language for code/command previews (undefined = plain/markdown). */
	language?: string;
	/** Leaf: text copied to the clipboard. */
	content?: string;
	/** Leaf: status message shown after copying. */
	copyMessage?: string;
	/** Group: nested targets to drill into. */
	children?: CopyTarget[];
}

/** Minimal session surface needed to assemble copy targets (eases testing). */
export interface CopySource {
	readonly messages: readonly AgentMessage[];
	getLastVisibleHandoffText(): string | undefined;
}

/** Cap on how many recent messages of each kind (assistant, user) the picker lists. */
const MAX_MESSAGES = 50;

/** Whose turn produced a message target; also selects the target id namespace. */
type MessageKind = "assistant" | "user";

/**
 * Openers of the synthetic "user" turns the runtime injects (environment
 * context, skills, token budget, model switch). Nobody typed these, so `/copy`
 * hides them. Mirrors the contextual filter the compaction retention pass uses.
 */
const CONTEXTUAL_USER_PREFIXES = [
	"<environment_context>",
	"<user_instructions>",
	"<additional_context>",
	"<skills",
	"<token_budget>",
	"<model_switch>",
];

const OPEN_FENCE_RE = /^```([^\n]*)$/;
const CLOSE_FENCE_RE = /^```/;
const QUOTE_LINE_RE = /^>(.*)$/;

/**
 * Split assistant markdown into drillable blocks — fenced code and `>`-quoted
 * runs — in document order. Fences mask their bodies, so a `>` line inside a
 * code block is never mistaken for a quote. An unclosed fence is treated as
 * ordinary text, matching the fenced-block grammar.
 */
export function extractBlocks(text: string): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	const lines = text.split("\n");
	let quote: string[] | undefined;
	const flushQuote = () => {
		if (quote) {
			blocks.push({ kind: "quote", text: quote.join("\n") });
			quote = undefined;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const open = OPEN_FENCE_RE.exec(line);
		if (open) {
			let close = -1;
			for (let k = i + 1; k < lines.length; k++) {
				if (CLOSE_FENCE_RE.test(lines[k]!)) {
					close = k;
					break;
				}
			}
			if (close !== -1) {
				flushQuote();
				blocks.push({ kind: "code", lang: open[1].trim(), code: lines.slice(i + 1, close).join("\n") });
				i = close;
				continue;
			}
		}

		const quoted = QUOTE_LINE_RE.exec(line);
		if (quoted) {
			// Strip the `>` marker plus one optional following space.
			quote ??= [];
			quote.push(quoted[1].startsWith(" ") ? quoted[1].slice(1) : quoted[1]);
		} else {
			flushQuote();
		}
	}
	flushQuote();
	return blocks;
}

/** Extract fenced code blocks from assistant markdown, in document order. */
export function extractCodeBlocks(text: string): CodeBlock[] {
	return extractBlocks(text)
		.filter((b): b is { kind: "code" } & CodeBlock => b.kind === "code")
		.map(b => ({ lang: b.lang, code: b.code }));
}

/** Walk the transcript backwards for the most recent fenced assistant code block. */
export function extractLastCodeBlock(messages: readonly AgentMessage[]): CodeBlock | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const text = assistantText(msg);
		if (!text) continue;
		const blocks = extractCodeBlocks(text);
		if (blocks.length > 0) return blocks[blocks.length - 1];
	}
	return undefined;
}

/** Extract `>`-quoted blocks from assistant markdown, in document order. */
export function extractQuoteBlocks(text: string): QuoteBlock[] {
	return extractBlocks(text)
		.filter((b): b is { kind: "quote" } & QuoteBlock => b.kind === "quote")
		.map(b => ({ text: b.text }));
}

function extractEvalCode(args: unknown): { code: string; language: string } | undefined {
	if (!args || typeof args !== "object") return undefined;
	const argsObj = args as { cells?: unknown; code?: unknown };
	const cells = Array.isArray(argsObj.cells)
		? argsObj.cells
		: typeof argsObj.code === "string"
			? [argsObj]
			: undefined;
	if (!cells) return undefined;

	const codeBlocks: string[] = [];
	let language = "python";
	let languageResolved = false;
	for (const cell of cells) {
		if (!cell || typeof cell !== "object") continue;
		const code = (cell as { code?: unknown }).code;
		if (typeof code !== "string" || code.length === 0) continue;
		codeBlocks.push(code);
		if (!languageResolved) {
			const lang = (cell as { language?: unknown }).language;
			language = lang === "js" ? "javascript" : lang === "rb" ? "ruby" : lang === "jl" ? "julia" : "python";
			languageResolved = true;
		}
	}

	return codeBlocks.length > 0 ? { code: codeBlocks.join("\n\n"), language } : undefined;
}

function commandFromToolCall(tc: ToolCall): LastCommand | undefined {
	if (tc.name === "bash" && typeof tc.arguments.command === "string") {
		return { kind: "bash", code: tc.arguments.command, language: "bash" };
	}
	if (tc.name === "eval") {
		const evalResult = extractEvalCode(tc.arguments);
		if (evalResult) return { kind: "eval", code: evalResult.code, language: evalResult.language };
	}
	return undefined;
}

/** Walk the transcript backwards for the most recent bash command or eval code. */
export function extractLastCommand(messages: readonly AgentMessage[]): LastCommand | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
		for (let j = toolCalls.length - 1; j >= 0; j--) {
			const command = commandFromToolCall(toolCalls[j]!);
			if (command) return command;
		}
	}
	return undefined;
}

/** Concatenated visible text of an assistant message, or undefined when empty. */
function assistantText(msg: AgentMessage): string | undefined {
	if (msg.role !== "assistant") return undefined;
	let text = "";
	for (const content of msg.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() || undefined;
}

/**
 * Text a human actually typed in a user turn, or undefined when the message is
 * empty or is one of the contextual blocks the runtime injects as a "user"
 * turn. User content is a bare string on some transports and text/image blocks
 * on others, so both shapes are handled.
 */
function userText(msg: AgentMessage): string | undefined {
	if (msg.role !== "user") return undefined;
	let text = "";
	if (typeof msg.content === "string") {
		text = msg.content;
	} else {
		for (const content of msg.content) {
			if (content.type === "text") text += content.text;
		}
	}
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const probe = trimmed.toLowerCase();
	return CONTEXTUAL_USER_PREFIXES.some(prefix => probe.startsWith(prefix)) ? undefined : trimmed;
}

function pluralLines(text: string): string {
	const count = text.length === 0 ? 0 : text.split("\n").length;
	return `${count} line${count === 1 ? "" : "s"}`;
}

function blockHint(block: CodeBlock): string {
	const lines = pluralLines(block.code);
	return block.lang ? `${block.lang} · ${lines}` : lines;
}

/** First non-empty line, whitespace-collapsed, used as a message label. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.replace(/\s+/g, " ");
	}
	return text.trim().replace(/\s+/g, " ");
}

/** "<n> lines · <c> code · <q> quote" — omitting block kinds that are absent. */
function blockSummaryHint(text: string, codeCount: number, quoteCount: number): string {
	const parts = [pluralLines(text)];
	if (codeCount > 0) parts.push(`${codeCount} code`);
	if (quoteCount > 0) parts.push(`${quoteCount} quote`);
	return parts.join(" · ");
}

/** Status line shown after copying a whole message, by whose turn it was. */
function messageCopyLabel(kind: MessageKind, rank: number): string {
	const subject = `${kind === "user" ? "your " : ""}${rank === 1 ? "last message" : "message"}`;
	return `Copied ${subject} to clipboard`;
}

/** Build the target node for one message: a leaf when it has no
 * drillable blocks, otherwise a group exposing the full message plus each
 * fenced code block and `>`-quoted block (de-prefixed) as a child target.
 * `kind` picks the id namespace so assistant and user entries never collide. */
function messageTarget(text: string, rank: number, kind: MessageKind = "assistant"): CopyTarget {
	const id = kind === "user" ? `you:${rank}` : `msg:${rank}`;
	const label = firstLine(text);
	const blocks = extractBlocks(text);
	const messageCopy = messageCopyLabel(kind, rank);
	// User entries are tagged in the hint so the two streams stay tellable apart.
	const hintPrefix = kind === "user" ? "you · " : "";

	if (blocks.length === 0) {
		const hint = `${hintPrefix}${pluralLines(text)}`;
		return { id, label, hint, preview: text, content: text, copyMessage: messageCopy };
	}

	// The message node itself copies the full message; each block is a child
	// copy target you can drill into, kept in document order.
	const children: CopyTarget[] = [];
	const codeBlocks: CodeBlock[] = [];
	const quoteBlocks: QuoteBlock[] = [];
	for (const block of blocks) {
		if (block.kind === "code") {
			const j = codeBlocks.length;
			codeBlocks.push(block);
			children.push({
				id: `${id}:code:${j}`,
				label: `Block ${j + 1}`,
				hint: blockHint(block),
				preview: block.code,
				language: block.lang || undefined,
				content: block.code,
				copyMessage: `Copied code block ${j + 1} to clipboard`,
			});
		} else {
			const j = quoteBlocks.length;
			quoteBlocks.push(block);
			children.push({
				id: `${id}:quote:${j}`,
				label: `Quote ${j + 1}`,
				hint: pluralLines(block.text),
				preview: block.text,
				content: block.text,
				copyMessage: `Copied quote block ${j + 1} to clipboard`,
			});
		}
	}

	if (codeBlocks.length > 1) {
		const combined = codeBlocks.map(b => b.code).join("\n\n");
		children.push({
			id: `${id}:all`,
			label: `All ${codeBlocks.length} blocks`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${codeBlocks.length} code blocks to clipboard`,
		});
	}
	if (quoteBlocks.length > 1) {
		const combined = quoteBlocks.map(b => b.text).join("\n\n");
		children.push({
			id: `${id}:all-quotes`,
			label: `All ${quoteBlocks.length} quotes`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${quoteBlocks.length} quote blocks to clipboard`,
		});
	}

	const hint = `${hintPrefix}${blockSummaryHint(text, codeBlocks.length, quoteBlocks.length)}`;
	return { id, label, hint, preview: text, content: text, copyMessage: messageCopy, children };
}

function commandTitle(command: LastCommand): string {
	return command.kind === "bash" ? "Bash command" : "Eval code";
}

function commandTarget(command: LastCommand, rank: number): CopyTarget {
	const title = commandTitle(command);
	return {
		id: `cmd:${rank}`,
		label: firstLine(command.code) || title,
		hint: `${command.kind} · ${pluralLines(command.code)}`,
		preview: command.code,
		language: command.language,
		content: command.code,
		copyMessage: `Copied ${command.kind === "bash" ? "bash command" : "eval code"} to clipboard`,
	};
}

/**
 * Assemble the unified `/copy` target tree: recent assistant and user messages
 * (most recent first, each drillable into its code and quote blocks), runnable
 * command targets interleaved after the assistant message that issued them, and
 * a fresh-handoff fallback when no assistant message exists yet.
 */
export function buildCopyTargets(source: CopySource): CopyTarget[] {
	const targets: CopyTarget[] = [];
	const pendingCommands: LastCommand[] = [];
	let messageRank = 0;
	let userRank = 0;
	let commandRank = 0;

	const appendCommands = (commands: readonly LastCommand[]) => {
		for (const command of commands) {
			commandRank += 1;
			targets.push(commandTarget(command, commandRank));
		}
	};

	for (let i = source.messages.length - 1; i >= 0 && messageRank < MAX_MESSAGES; i--) {
		const msg = source.messages[i];

		if (msg.role === "user") {
			// Your own turns are copy targets too: before #7976 the prompt you
			// typed was structurally unreachable from the picker.
			if (userRank >= MAX_MESSAGES) continue;
			const typed = userText(msg);
			if (!typed) continue;
			userRank += 1;
			targets.push(messageTarget(typed, userRank, "user"));
			continue;
		}

		if (msg.role !== "assistant") continue;

		const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
		const commands: LastCommand[] = [];
		for (let j = toolCalls.length - 1; j >= 0; j--) {
			const command = commandFromToolCall(toolCalls[j]!);
			if (command) commands.push(command);
		}

		const text = assistantText(msg);
		if (!text) {
			pendingCommands.push(...commands);
			continue;
		}

		messageRank += 1;
		targets.push(messageTarget(text, messageRank));
		appendCommands(pendingCommands);
		appendCommands(commands);
		pendingCommands.length = 0;
	}

	if (messageRank === 0) {
		const handoff = source.getLastVisibleHandoffText();
		if (handoff) {
			targets.unshift({
				id: "handoff",
				label: "Handoff context",
				hint: pluralLines(handoff),
				preview: handoff,
				content: handoff,
				copyMessage: "Copied handoff context to clipboard",
			});
		}
		appendCommands(pendingCommands);
	}

	return targets;
}
