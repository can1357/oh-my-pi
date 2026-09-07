import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { extractMarkdownLinks } from "@oh-my-pi/pi-tui";

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
	/** Highlight language: "bash" for bash, or the resolved eval language ("python"/"javascript"). */
	language: string;
}

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

/** A hyperlink found in assistant markdown: inline `[text](href)`, `<autolink>`, bare URL, or reference link. */
export interface LinkTarget {
	/** Visible link text; equals `href` for autolinks and bare URLs. */
	text: string;
	/** Absolute http(s) URL as marked resolved it. */
	href: string;
}

/**
 * Hyperlinks the renderer would draw for `text`, in document order and
 * deduplicated by href. Tokenization is the renderer's own
 * ({@link extractMarkdownLinks}), so fenced code, code spans, escapes,
 * reference definitions and GFM autolink rules agree with the screen. Only
 * http(s) targets qualify: the result feeds both the clipboard and the system
 * opener, and a `mailto:`/`file:` destination is not something to hand to
 * either from a transcript.
 */
export function extractLinks(text: string): LinkTarget[] {
	const seen = new Set<string>();
	const links: LinkTarget[] = [];
	for (const link of extractMarkdownLinks(text)) {
		if (!/^https?:\/\//i.test(link.href) || seen.has(link.href)) continue;
		seen.add(link.href);
		links.push({ text: link.text, href: link.href });
	}
	return links;
}

/** Walk the transcript backwards for the most recent link in an assistant message. */
export function extractLastLink(messages: readonly AgentMessage[]): LinkTarget | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantText(messages[i]);
		if (!text) continue;
		const links = extractLinks(text);
		if (links.length > 0) return links[links.length - 1];
	}
	return undefined;
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
			language = lang === "js" ? "javascript" : "python";
			languageResolved = true;
		}
	}

	return codeBlocks.length > 0 ? { code: codeBlocks.join("\n\n"), language } : undefined;
}

/** Runnable command carried by a `bash`/`eval` tool call, if any. */
export function commandFromToolCall(tc: ToolCall): LastCommand | undefined {
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
