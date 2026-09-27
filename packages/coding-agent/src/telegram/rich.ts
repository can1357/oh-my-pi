/**
 * Bridge markdown (Telegram's "rich message" flavour) for outbound text.
 *
 * Model output is escaped so Telegram's extensions (`$math$`, `<tags>`, tables,
 * `==marks==`, `||spoilers||`) cannot be triggered by accident, while code
 * fences and `<details>` blocks keep their meaning. The result is packed into
 * chunks of at most {@link RICH_TEXT_LIMIT} characters with fences reopened.
 */

import { type Fence, type HtmlLine, packLines } from "./chunks";

/** Longest text a single rich message may carry. */
export const RICH_TEXT_LIMIT = 32768;

const TEXT_SPECIAL = /[\\`*_[\]()#+\-.!|>~=$<&]/gu;
const FENCE_EDGE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/u;
const DETAILS_OPEN = /^\s{0,3}<details(?:\s[^<>]*)?>/u;
const DETAILS_SHUT = /^\s{0,3}<\/details>\s*$/u;
const TAG = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/u;
const PROSE_TAGS: Record<string, true> = {
	a: true,
	b: true,
	strong: true,
	i: true,
	em: true,
	u: true,
	ins: true,
	s: true,
	strike: true,
	del: true,
	code: true,
	mark: true,
	sub: true,
	sup: true,
	"tg-spoiler": true,
	"tg-reference": true,
	"tg-emoji": true,
	img: true,
	"tg-time": true,
	"tg-math": true,
	"tg-collage": true,
	"tg-slideshow": true,
	h1: true,
	h2: true,
	h3: true,
	h4: true,
	h5: true,
	h6: true,
	p: true,
	pre: true,
	footer: true,
	hr: true,
	br: true,
	ul: true,
	ol: true,
	li: true,
	input: true,
	blockquote: true,
	cite: true,
	aside: true,
	video: true,
	audio: true,
	"tg-document": true,
	figure: true,
	figcaption: true,
	"tg-map": true,
	table: true,
	tr: true,
	th: true,
	td: true,
	caption: true,
	details: true,
	summary: true,
	"tg-math-block": true,
	"tg-button": true,
	"tg-button-row": true,
	"tg-thinking": true,
};

/** Escapes any dynamic value into bridge markdown. */
export function mdText(value: unknown): string {
	return String(value ?? "").replace(TEXT_SPECIAL, char => {
		if (char === "<") return "&lt;";
		if (char === "&") return "&amp;";
		return `\\${char}`;
	});
}

/** Wraps a value in an inline code span, choosing a fence that cannot collide with its backticks. */
export function mdCode(value: unknown): string {
	const text = String(value ?? "").replace(/\n+/gu, " ");
	const runs = text.match(/`+/gu) ?? [];
	const fence = "`".repeat(Math.max(1, ...runs.map(run => run.length + 1)));
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** English two-form pluralisation: `one` for exactly 1, `many` otherwise. */
export function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

function neutral(line: string): string {
	let out = "";
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\\") {
			out += line.slice(index, index + 2);
			index += 1;
			continue;
		}
		if (char === "`") {
			let length = 0;
			while (line[index + length] === "`") length += 1;
			const run = "`".repeat(length);
			const close = line.indexOf(run, index + run.length);
			if (close === -1) return out + line.slice(index);
			out += line.slice(index, close + run.length);
			index = close + run.length - 1;
			continue;
		}
		if (char === "$") {
			out += "\\$";
			continue;
		}
		if ((char === "=" || char === "|") && line[index + 1] === char) {
			out += `\\${char}\\${char}`;
			index += 1;
			continue;
		}
		if (char === "<") {
			const tag = TAG.exec(line.slice(index));
			if (tag !== null && PROSE_TAGS[tag[1].toLowerCase()] === true) {
				out += tag[0];
				index += tag[0].length - 1;
				continue;
			}
			out += "&lt;";
			continue;
		}
		out += char;
	}
	return out;
}

interface Token {
	text: string;
	fence: Fence | null;
}

function fenced(
	source: readonly string[],
	start: number,
	edge: RegExpExecArray,
	fence?: Fence,
	stop?: (line: string) => boolean,
): { out: Token[]; next: number } {
	const marker = edge[1][0];
	const closing = new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`, "u");
	const box = fence ?? { open: `${source[start]}\n`, close: `\n${edge[1]}` };
	const out: Token[] = [];
	let index = start + 1;
	while (index < source.length && !closing.test(source[index]) && !(stop?.(source[index]) ?? false)) {
		out.push({ text: source[index], fence: box });
		index += 1;
	}
	if (out.length === 0) out.push({ text: "", fence: box });
	const closed = index < source.length && closing.test(source[index]);
	return { out, next: closed ? index + 1 : index };
}

function details(source: readonly string[], start: number): { out: Token[]; next: number } {
	const fence: Fence = { open: `${source[start]}\n`, close: "\n</details>" };
	const out: Token[] = [];
	let index = start + 1;
	while (index < source.length && !DETAILS_SHUT.test(source[index])) {
		const edge = FENCE_EDGE.exec(source[index]);
		if (edge !== null) {
			const block = fenced(source, index, edge, fence, line => DETAILS_SHUT.test(line));
			out.push({ text: source[index], fence }, ...block.out, { text: edge[1], fence });
			index = block.next;
			continue;
		}
		out.push({ text: neutral(source[index]), fence });
		index += 1;
	}
	if (out.length === 0) out.push({ text: "", fence });
	return { out, next: index < source.length ? index + 1 : index };
}

function tokens(markdown: string): Token[] {
	const source = markdown.replace(/\r\n?/gu, "\n").split("\n");
	const out: Token[] = [];
	let index = 0;
	while (index < source.length) {
		if (DETAILS_OPEN.test(source[index])) {
			const block = details(source, index);
			out.push(...block.out);
			index = block.next;
			continue;
		}
		const edge = FENCE_EDGE.exec(source[index]);
		if (edge === null) {
			out.push({ text: neutral(source[index]), fence: null });
			index += 1;
			continue;
		}
		const block = fenced(source, index, edge);
		out.push(...block.out);
		index = block.next;
	}
	return out;
}

/** Renders bridge markdown into rich-message chunks, each within the rich text limit. */
export function richMarkdown(markdown: unknown): string[] {
	const text = String(markdown ?? "");
	if (text.trim() === "") return [];
	const lines: HtmlLine[] = tokens(text).map(({ text: line, fence }) => ({ fence, html: line }));
	return packLines(lines, RICH_TEXT_LIMIT);
}
