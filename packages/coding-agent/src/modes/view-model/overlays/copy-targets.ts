import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { extractFencedCodeBlocks } from "@oh-my-pi/pi-tui/text/markdown/index";
import { lexMarkdown } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import type { Token, Tokens } from "@oh-my-pi/pi-utils/marked";

/** A runnable command found in the transcript. */
export interface LastCommand {
	kind: "bash" | "eval";
	code: string;
	/** Highlight language: "bash" for bash, or the resolved eval language ("python"/"javascript"). */
	language: string;
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

/** Concatenated visible text of an assistant message, verbatim; undefined when blank. */
export function assistantText(msg: AgentMessage): string | undefined {
	if (msg.role !== "assistant") return undefined;
	let text = "";
	for (const content of msg.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() ? text : undefined;
}

/** A fenced code block extracted from assistant markdown. */
export interface CodeBlock {
	/** Info string after the opening fence (language id), trimmed. */
	lang: string;
	/** Block body with the trailing newline stripped. */
	code: string;
}

/** A hyperlink found in assistant markdown: inline `[text](href)`, `<autolink>`, bare URL, or reference link. */
export interface LinkTarget {
	/** Visible link label flattened to one display row; falls back to `href` when empty. */
	text: string;
	/** Absolute http(s) URL as marked resolved it. */
	href: string;
}

type TokenWithChildren = Token & { tokens?: Token[]; items?: Token[] };

/**
 * Fenced code blocks of assistant markdown in document order (inside list
 * items too, never inside quotes), tokenized as the renderer does, with
 * trailing horizontal whitespace stripped from every line.
 */
function extractCodeBlocks(text: string): CodeBlock[] {
	return extractFencedCodeBlocks(text).map(({ lang, code }) => ({ lang, code }));
}

/**
 * Walk the transcript backwards for the most recent assistant message that
 * contains fenced code blocks, returning all of its blocks in document order.
 */
export function extractLastReplyCodeBlocks(messages: readonly AgentMessage[]): CodeBlock[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantText(messages[i]!);
		if (!text) continue;
		const blocks = extractCodeBlocks(text);
		if (blocks.length > 0) return blocks;
	}
	return [];
}

/** Walk the transcript backwards for the most recent fenced assistant code block. */
export function extractLastCodeBlock(messages: readonly AgentMessage[]): CodeBlock | undefined {
	return extractLastReplyCodeBlocks(messages).at(-1);
}

/**
 * The http(s) links the renderer would draw for `text`, in document order and
 * deduplicated by href (fenced code, code spans and escapes never link). Only
 * http(s) targets qualify: the result feeds the clipboard and the system opener.
 */
function extractLinks(text: string): LinkTarget[] {
	const seen = new Set<string>();
	const links: LinkTarget[] = [];
	const walk = (tokens: readonly Token[] | undefined): void => {
		for (const token of tokens ?? []) {
			if (token.type === "link") {
				const link = token as Tokens.Link;
				if (/^https?:\/\//i.test(link.href) && !seen.has(link.href)) {
					seen.add(link.href);
					links.push({
						text: link.text.replace(/\s+/g, " ").trim() || link.href,
						href: link.href,
					});
				}
				continue;
			}
			if (token.type === "table") {
				const table = token as Tokens.Table;
				for (const cell of table.header) walk(cell.tokens);
				for (const row of table.rows) for (const cell of row) walk(cell.tokens);
				continue;
			}
			const node = token as TokenWithChildren;
			walk(node.items);
			walk(node.tokens);
		}
	};
	walk(lexMarkdown(text));
	return links;
}

/** Walk the transcript backwards for the most recent link in an assistant message. */
export function extractLastLink(messages: readonly AgentMessage[]): LinkTarget | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantText(messages[i]!);
		if (!text) continue;
		const links = extractLinks(text);
		if (links.length > 0) return links[links.length - 1];
	}
	return undefined;
}
