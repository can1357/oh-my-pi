import type { TurndownNode } from "./types";

const VOID_ELEMENTS: Readonly<Record<string, true>> = {
	AREA: true,
	BASE: true,
	BR: true,
	COL: true,
	EMBED: true,
	HR: true,
	IMG: true,
	INPUT: true,
	LINK: true,
	META: true,
	PARAM: true,
	SOURCE: true,
	TRACK: true,
	WBR: true,
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	copy: "©",
	gt: ">",
	hellip: "…",
	laquo: "«",
	lt: "<",
	mdash: "—",
	nbsp: " ",
	ndash: "–",
	quot: '"',
	raquo: "»",
	reg: "®",
};

function decodeEntities(value: string): string {
	return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);?/gi, (entity, name: string) => {
		if (name.charAt(0) === "#") {
			const hexadecimal = name.charAt(1).toLowerCase() === "x";
			const number = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
			if (!Number.isFinite(number) || number <= 0 || number > 0x10ffff) return entity;
			try {
				return String.fromCodePoint(number);
			} catch {
				return "�";
			}
		}
		return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
	});
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

abstract class HtmlNode implements TurndownNode {
	parentNode: HtmlNode | null = null;
	readonly childNodes: HtmlNode[] = [];
	abstract readonly nodeType: number;
	abstract readonly nodeName: string;

	get children(): HtmlNode[] {
		return this.childNodes.filter(child => child.nodeType === 1);
	}

	get firstChild(): HtmlNode | null {
		return this.childNodes[0] ?? null;
	}

	get lastChild(): HtmlNode | null {
		return this.childNodes[this.childNodes.length - 1] ?? null;
	}

	get previousSibling(): HtmlNode | null {
		if (!this.parentNode) return null;
		const index = this.parentNode.childNodes.indexOf(this);
		return index > 0 ? (this.parentNode.childNodes[index - 1] ?? null) : null;
	}

	get nextSibling(): HtmlNode | null {
		if (!this.parentNode) return null;
		const index = this.parentNode.childNodes.indexOf(this);
		return index >= 0 ? (this.parentNode.childNodes[index + 1] ?? null) : null;
	}

	get textContent(): string {
		return this.childNodes.map(child => child.textContent).join("");
	}

	abstract get outerHTML(): string;

	getAttribute(_name: string): string | null {
		return null;
	}

	hasAttribute(_name: string): boolean {
		return false;
	}

	append(child: HtmlNode): void {
		child.parentNode = this;
		this.childNodes.push(child);
	}
}

class HtmlText extends HtmlNode {
	readonly nodeType = 3;
	readonly nodeName = "#text";
	readonly value: string;

	constructor(value: string) {
		super();
		this.value = value;
	}

	override get textContent(): string {
		return this.value;
	}

	get outerHTML(): string {
		return this.value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}
}

class HtmlElement extends HtmlNode {
	readonly nodeType = 1;
	readonly nodeName: string;
	readonly #attributes: Map<string, string>;

	constructor(name: string, attributes: Map<string, string>) {
		super();
		this.nodeName = name.toUpperCase();
		this.#attributes = attributes;
	}

	override getAttribute(name: string): string | null {
		return this.#attributes.get(name.toLowerCase()) ?? null;
	}

	override hasAttribute(name: string): boolean {
		return this.#attributes.has(name.toLowerCase());
	}

	get outerHTML(): string {
		const tag = this.nodeName.toLowerCase();
		const attributes = [...this.#attributes]
			.map(([name, value]) => (value === "" ? name : `${name}="${escapeAttribute(value)}"`))
			.join(" ");
		const opening = `<${tag}${attributes ? ` ${attributes}` : ""}>`;
		if (VOID_ELEMENTS[this.nodeName]) return opening;
		return `${opening}${this.childNodes.map(child => child.outerHTML).join("")}</${tag}>`;
	}
}

class HtmlFragment extends HtmlNode {
	readonly nodeType = 11;
	readonly nodeName = "#document-fragment";

	get outerHTML(): string {
		return this.childNodes.map(child => child.outerHTML).join("");
	}
}

function parseAttributes(source: string): Map<string, string> {
	const attributes = new Map<string, string>();
	const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const match of source.matchAll(pattern)) {
		const name = match[1]?.toLowerCase();
		if (!name) continue;
		attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
	}
	return attributes;
}

function* htmlTokens(html: string): Generator<string> {
	let cursor = 0;
	while (cursor < html.length) {
		if (html.charAt(cursor) !== "<") {
			const nextTag = html.indexOf("<", cursor);
			const end = nextTag < 0 ? html.length : nextTag;
			yield html.slice(cursor, end);
			cursor = end;
			continue;
		}
		if (!/[/!a-z]/i.test(html.charAt(cursor + 1))) {
			yield "<";
			cursor++;
			continue;
		}
		if (html.startsWith("<!--", cursor)) {
			const commentEnd = html.indexOf("-->", cursor + 4);
			const end = commentEnd < 0 ? html.length : commentEnd + 3;
			yield html.slice(cursor, end);
			cursor = end;
			continue;
		}
		let quote: string | undefined;
		let tagEnd = cursor + 1;
		for (; tagEnd < html.length; tagEnd++) {
			const character = html.charAt(tagEnd);
			if (quote) {
				if (character === quote) quote = undefined;
			} else if (character === '"' || character === "'") {
				quote = character;
			} else if (character === ">") {
				break;
			}
		}
		if (tagEnd >= html.length) {
			yield "<";
			cursor++;
			continue;
		}
		yield html.slice(cursor, tagEnd + 1);
		cursor = tagEnd + 1;
	}
}

/** Parse an HTML fragment into the small DOM subset needed by Turndown. */
export function parseHtmlFragment(html: string): TurndownNode {
	const root = new HtmlFragment();
	const stack: HtmlNode[] = [root];
	for (const token of htmlTokens(html)) {
		const parent = stack[stack.length - 1] ?? root;
		if (token.startsWith("<!--") || token.startsWith("<!")) continue;
		if (!token.startsWith("<")) {
			parent.append(new HtmlText(decodeEntities(token)));
			continue;
		}
		const closing = /^<\/\s*([a-z][\w:-]*)[^>]*>$/i.exec(token);
		if (closing) {
			const name = closing[1]?.toUpperCase();
			for (let index = stack.length - 1; index > 0; index--) {
				if (stack[index]?.nodeName !== name) continue;
				stack.length = index;
				break;
			}
			continue;
		}
		const opening = /^<\s*([a-z][\w:-]*)([\s\S]*?)\/?\s*>$/i.exec(token);
		if (!opening?.[1]) {
			parent.append(new HtmlText("<"));
			continue;
		}
		const element = new HtmlElement(opening[1], parseAttributes(opening[2] ?? ""));
		parent.append(element);
		if (!VOID_ELEMENTS[element.nodeName] && !/\/\s*>$/.test(token)) stack.push(element);
	}
	return root;
}

/** Serialize a standards-shaped or internal HTML node. */
export function serializeNode(node: TurndownNode): string {
	if (typeof node.outerHTML === "string") return node.outerHTML;
	if (node.nodeType === 3) return node.textContent ?? "";
	return Array.from(node.childNodes).map(serializeNode).join("");
}
