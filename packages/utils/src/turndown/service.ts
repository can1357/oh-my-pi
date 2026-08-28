import { parseHtmlFragment, serializeNode } from "./html";
import type {
	ResolvedTurndownOptions,
	RuleFilter,
	TurndownNode,
	TurndownOptions,
	TurndownPlugin,
	TurndownRule,
} from "./types";

const BLOCK_ELEMENTS: Readonly<Record<string, true>> = {
	ADDRESS: true,
	ARTICLE: true,
	ASIDE: true,
	BLOCKQUOTE: true,
	BODY: true,
	CANVAS: true,
	CENTER: true,
	DD: true,
	DETAILS: true,
	DIR: true,
	DIV: true,
	DL: true,
	DT: true,
	FIELDSET: true,
	FIGCAPTION: true,
	FIGURE: true,
	FOOTER: true,
	FORM: true,
	FRAMESET: true,
	H1: true,
	H2: true,
	H3: true,
	H4: true,
	H5: true,
	H6: true,
	HEADER: true,
	HGROUP: true,
	HR: true,
	HTML: true,
	ISINDEX: true,
	LI: true,
	MAIN: true,
	MENU: true,
	NAV: true,
	NOFRAMES: true,
	NOSCRIPT: true,
	OL: true,
	OUTPUT: true,
	P: true,
	PRE: true,
	SECTION: true,
	SUMMARY: true,
	TABLE: true,
	TBODY: true,
	TD: true,
	TFOOT: true,
	TH: true,
	THEAD: true,
	TR: true,
	UL: true,
};
const NONBLANK_EMPTY_ELEMENTS: Readonly<Record<string, true>> = {
	A: true,
	AUDIO: true,
	BR: true,
	HR: true,
	IFRAME: true,
	IMG: true,
	INPUT: true,
	SCRIPT: true,
	SOURCE: true,
	TD: true,
	TH: true,
	VIDEO: true,
};

type RuleEntry = { key: string; rule: TurndownRule };
type Reference = { destination: string };

const DEFAULT_OPTIONS: ResolvedTurndownOptions = {
	headingStyle: "setext",
	hr: "* * *",
	bulletListMarker: "*",
	codeBlockStyle: "indented",
	fence: "```",
	emDelimiter: "_",
	strongDelimiter: "**",
	linkStyle: "inlined",
	linkReferenceStyle: "full",
	preformattedCode: false,
};

function matchesFilter(filter: RuleFilter, node: TurndownNode, options: ResolvedTurndownOptions): boolean {
	if (typeof filter === "function") return filter(node, options);
	const name = node.nodeName.toLowerCase();
	if (typeof filter === "string") return name === filter.toLowerCase();
	return filter.some(tag => name === tag.toLowerCase());
}

function contentWithFlankingWhitespace(content: string, delimiter: string): string {
	const leading = content.match(/^\s+/)?.[0] ?? "";
	const trailing = content.match(/\s+$/)?.[0] ?? "";
	const body = content.slice(leading.length, trailing ? -trailing.length : undefined);
	return body ? `${leading}${delimiter}${body}${delimiter}${trailing}` : "";
}

function languageFromCode(node: TurndownNode): string {
	const code = Array.from(node.children).find(child => child.nodeName === "CODE");
	const className = code?.getAttribute("class") ?? "";
	return /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? "";
}

function listItemPrefix(node: TurndownNode, options: ResolvedTurndownOptions): string {
	const parent = node.parentNode;
	if (parent?.nodeName !== "OL") return `${options.bulletListMarker}   `;
	const start = Number(parent.getAttribute("start") ?? "1");
	const siblings = Array.from(parent.children);
	return `${(Number.isFinite(start) ? start : 1) + siblings.indexOf(node)}.  `;
}
function hasNonblankDescendant(node: TurndownNode): boolean {
	for (const child of Array.from(node.children)) {
		if (NONBLANK_EMPTY_ELEMENTS[child.nodeName] || hasNonblankDescendant(child)) return true;
	}
	return false;
}

/** Convert HTML fragments to Markdown with extensible Turndown-compatible rules. */
export default class TurndownService {
	readonly options: ResolvedTurndownOptions;
	readonly #rules: RuleEntry[] = [];
	readonly #keepFilters: RuleFilter[] = [];
	readonly #removeFilters: RuleFilter[] = [];
	#references: Reference[] = [];
	#previousSourceWhitespace = false;

	constructor(options: TurndownOptions = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/** Install a highest-priority named conversion rule. */
	addRule(key: string, rule: TurndownRule): this {
		const previous = this.#rules.findIndex(entry => entry.key === key);
		if (previous >= 0) this.#rules.splice(previous, 1);
		this.#rules.unshift({ key, rule });
		return this;
	}

	/** Preserve matching elements as HTML when no custom rule handles them. */
	keep(filter: RuleFilter): this {
		this.#keepFilters.unshift(filter);
		return this;
	}

	/** Drop matching elements and all of their converted content. */
	remove(filter: RuleFilter): this {
		this.#removeFilters.unshift(filter);
		return this;
	}

	/** Install one plugin or an ordered list of plugins. */
	use(plugin: TurndownPlugin | readonly TurndownPlugin[]): this {
		if (typeof plugin === "function") {
			plugin(this);
		} else {
			for (const install of plugin) install(this);
		}
		return this;
	}

	/** Escape Markdown punctuation using Turndown's public escaping rules. */
	escape(text: string): string {
		return text
			.replace(/\\/g, "\\\\")
			.replace(/([*_[\]])/g, "\\$1")
			.replace(/^(\s*)(#{1,6}|[+>])(?=\s)/gm, "$1\\$2")
			.replace(/^(\s*)-(?=\s)/gm, "$1\\-")
			.replace(/^(\s*\d+)\.(?=\s)/gm, "$1\\.");
	}

	/** Convert an HTML string or standards-shaped DOM node to Markdown. */
	turndown(input: string | TurndownNode): string {
		const root = typeof input === "string" ? parseHtmlFragment(input) : input;
		this.#references = [];
		this.#previousSourceWhitespace = false;
		let markdown =
			root.nodeType === 9 || root.nodeType === 11 ? this.#convertChildren(root) : this.#convertNode(root);
		markdown = markdown
			.replace(/^[\t\r\n]+/, "")
			.replace(/[\t\r\n ]+$/, "")
			.replace(/\n{3,}/g, "\n\n");
		if (this.#references.length > 0) {
			markdown += `\n\n${this.#references.map(reference => reference.destination).join("\n")}`;
		}
		return markdown;
	}

	/** Convert only a node's children within the active conversion. */
	convertChildren(node: TurndownNode): string {
		return this.#convertChildren(node);
	}

	#convertChildren(node: TurndownNode): string {
		let content = "";
		for (const child of Array.from(node.childNodes)) content += this.#convertNode(child);
		return content;
	}

	#convertNode(node: TurndownNode): string {
		if (node.nodeType === 3) {
			const text = node.textContent ?? "";
			if (node.parentNode?.nodeName === "PRE") return text;
			let collapsed = text.replace(/[\t\r\n\f ]+/g, " ");
			if (this.#previousSourceWhitespace && collapsed.startsWith(" ")) collapsed = collapsed.slice(1);
			this.#previousSourceWhitespace = collapsed.endsWith(" ");
			return node.parentNode?.nodeName === "CODE" ? collapsed : this.escape(collapsed);
		}
		if (node.nodeType !== 1) return this.#convertChildren(node);
		if (!(node.textContent ?? "").trim() && !NONBLANK_EMPTY_ELEMENTS[node.nodeName] && !hasNonblankDescendant(node)) {
			return (
				this.options.blankReplacement?.("", node, this.options) ?? (BLOCK_ELEMENTS[node.nodeName] ? "\n\n" : "")
			);
		}

		const block = Boolean(BLOCK_ELEMENTS[node.nodeName]);
		if (block) this.#previousSourceWhitespace = false;
		const content = this.#convertChildren(node);
		if (block) this.#previousSourceWhitespace = false;
		if (node.nodeName === "CODE") this.#previousSourceWhitespace = false;
		const custom = this.#rules.find(entry => matchesFilter(entry.rule.filter, node, this.options));
		if (custom) return custom.rule.replacement(content, node, this.options);
		if (this.#keepFilters.some(filter => matchesFilter(filter, node, this.options))) {
			return this.options.keepReplacement?.(content, node, this.options) ?? serializeNode(node);
		}
		if (this.#removeFilters.some(filter => matchesFilter(filter, node, this.options))) return "";
		return this.#defaultReplacement(content, node);
	}

	#defaultReplacement(content: string, node: TurndownNode): string {
		const name = node.nodeName;
		if (name === "P") return content.trim() ? `\n\n${content.trim()}\n\n` : "";
		if (/^H[1-6]$/.test(name)) {
			const level = Number(name.charAt(1));
			const body = content.trim();
			if (this.options.headingStyle === "setext" && level < 3) {
				return `\n\n${body}\n${(level === 1 ? "=" : "-").repeat(body.length)}\n\n`;
			}
			return `\n\n${"#".repeat(level)} ${body}\n\n`;
		}
		if (name === "BR") return "  \n";
		if (name === "HR") return `\n\n${this.options.hr}\n\n`;
		if (name === "BLOCKQUOTE") {
			const body = content
				.trim()
				.replace(/\n{3,}/g, "\n\n")
				.replace(/^/gm, "> ");
			return body ? `\n\n${body}\n\n` : "";
		}
		if (name === "UL" || name === "OL") {
			const body = content.replace(/^\n+|\n+$/g, "");
			return node.parentNode?.nodeName === "LI" ? `\n${body}` : `\n\n${body}\n\n`;
		}
		if (name === "LI") {
			const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n    ");
			return `${listItemPrefix(node, this.options)}${body}${node.nextSibling ? "\n" : ""}`;
		}
		if (name === "PRE" && Array.from(node.children).some(child => child.nodeName === "CODE")) {
			return this.#replacePre(node);
		}
		if (name === "EM" || name === "I") return contentWithFlankingWhitespace(content, this.options.emDelimiter);
		if (name === "STRONG" || name === "B") {
			return contentWithFlankingWhitespace(content, this.options.strongDelimiter);
		}
		if (name === "CODE") return this.#replaceInlineCode(content);
		if (name === "A") return this.#replaceLink(content, node);
		if (name === "IMG") return this.#replaceImage(node);
		if (this.options.defaultReplacement) return this.options.defaultReplacement(content, node, this.options);
		if (BLOCK_ELEMENTS[name]) return content.trim() ? `\n\n${content.trim()}\n\n` : "";
		return content;
	}

	#replacePre(node: TurndownNode): string {
		const text = node.textContent ?? "";
		if (this.options.codeBlockStyle === "indented") {
			return `\n\n${text.replace(/^/gm, "    ")}\n\n`;
		}
		const fenceCharacter = this.options.fence.charAt(0);
		let longestFence = this.options.fence.length;
		let run = 0;
		for (const character of text) {
			run = character === fenceCharacter ? run + 1 : 0;
			longestFence = Math.max(longestFence, run + 1);
		}
		const fence = fenceCharacter.repeat(longestFence);
		const body = text.replace(/\n$/, "");
		return `\n\n${fence}${languageFromCode(node)}\n${body}\n${fence}\n\n`;
	}

	#replaceInlineCode(text: string): string {
		const body = text.trim();
		if (!body) return "";
		let longestRun = 0;
		let run = 0;
		for (const character of body) {
			run = character === "`" ? run + 1 : 0;
			longestRun = Math.max(longestRun, run);
		}
		const delimiter = "`".repeat(longestRun + 1);
		const padding = /^`|`$/.test(body) ? " " : "";
		return `${delimiter}${padding}${body}${padding}${delimiter}`;
	}

	#replaceLink(content: string, node: TurndownNode): string {
		const href = (node.getAttribute("href") ?? "").replace(/([()<>])/g, "\\$1");
		const title = node.getAttribute("title");
		const destination = `${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""}`;
		if (this.options.linkStyle !== "referenced") return `[${content}](${destination})`;
		const referenceNumber = this.#references.length + 1;
		let label = String(referenceNumber);
		if (this.options.linkReferenceStyle === "collapsed") label = "";
		if (this.options.linkReferenceStyle === "shortcut") label = content;
		const marker = this.options.linkReferenceStyle === "shortcut" ? `[${content}]` : `[${content}][${label}]`;
		this.#references.push({ destination: `[${label || content}]: ${destination}` });
		return marker;
	}

	#replaceImage(node: TurndownNode): string {
		const source = (node.getAttribute("src") ?? "").replace(/([()<>])/g, "\\$1");
		if (!source) return "";
		const alternative = this.escape(node.getAttribute("alt") ?? "");
		const title = node.getAttribute("title");
		return `![${alternative}](${source}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
	}
}
