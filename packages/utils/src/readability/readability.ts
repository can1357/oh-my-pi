/** Behavior-compatible reimplementation of @mozilla/readability's used surface. */

import type {
	ReadabilityArticle,
	ReadabilityDocument,
	ReadabilityElement,
	ReadabilityNode,
	ReadabilityOptions,
} from "./types";

const UNLIKELY =
	/-ad-|ai2html|banner|breadcrumbs|comment|community|combx|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup/i;
const POSSIBLE = /and|article|body|column|content|main|shadow/i;
const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i;
const NEGATIVE =
	/-ad-|hidden|^hid$| hid$| hid |^hid |banner|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i;
const BYLINE = /byline|author|dateline|writtenby|p-author/i;
const SCORE_TAGS = new Set(["SECTION", "H2", "H3", "H4", "H5", "H6", "P", "TD", "PRE"]);
const DROP_TAGS = [
	"form",
	"fieldset",
	"object",
	"embed",
	"footer",
	"link",
	"aside",
	"iframe",
	"input",
	"textarea",
	"select",
	"button",
];
const UNLIKELY_ROLES = new Set(["menu", "menubar", "complementary", "navigation", "alert", "alertdialog", "dialog"]);
const ARTICLE_TYPES =
	/^(?:Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference)$/;
const NORMALIZE = /\s{2,}/g;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

type Metadata = {
	title?: string;
	byline?: string;
	excerpt?: string;
	siteName?: string;
	publishedTime?: string | null;
};

type Attempt = { element: ReadabilityElement; length: number; dir?: string | null };

function elements(collection: ArrayLike<ReadabilityElement>): ReadabilityElement[] {
	return Array.from(collection);
}

function descendants(root: ReadabilityElement): ReadabilityElement[] {
	const result: ReadabilityElement[] = [];
	const pending = elements(root.children).reverse();
	while (pending.length) {
		const node = pending.pop();
		if (!node) continue;
		result.push(node);
		const children = elements(node.children);
		for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
	}
	return result;
}

function text(node: ReadabilityNode): string {
	return (node.textContent ?? "").trim().replace(NORMALIZE, " ");
}

function matchLabel(node: ReadabilityElement): string {
	return `${typeof node.className === "string" ? node.className : ""} ${node.id ?? ""}`;
}

function classWeight(node: ReadabilityElement): number {
	const label = matchLabel(node);
	return (POSITIVE.test(label) ? 25 : 0) - (NEGATIVE.test(label) ? 25 : 0);
}

function initialScore(node: ReadabilityElement): number {
	let score = classWeight(node);
	switch (node.tagName) {
		case "DIV":
			score += 5;
			break;
		case "PRE":
		case "TD":
		case "BLOCKQUOTE":
			score += 3;
			break;
		case "ADDRESS":
		case "OL":
		case "UL":
		case "DL":
		case "DD":
		case "DT":
		case "LI":
		case "FORM":
			score -= 3;
			break;
		case "H1":
		case "H2":
		case "H3":
		case "H4":
		case "H5":
		case "H6":
		case "TH":
			score -= 5;
			break;
	}
	return score;
}

function linkDensity(node: ReadabilityElement): number {
	const total = text(node).length;
	if (!total) return 0;
	let linked = 0;
	for (const link of elements(node.getElementsByTagName("a"))) {
		linked += text(link).length * ((link.getAttribute("href") ?? "").startsWith("#") ? 0.3 : 1);
	}
	return linked / total;
}

/** Whether a UTF-16 code unit is whitespace to `String#trim` and `\s`. */
function isSpace(code: number): boolean {
	if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
	if (code < 0xa0) return false;
	return (
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

/** Separators `#scoreParagraph` counts clauses by. */
function isSeparator(code: number): boolean {
	return (
		code === 0x2c ||
		code === 0x060c ||
		code === 0xfe50 ||
		code === 0xfe10 ||
		code === 0xfe11 ||
		code === 0x2e41 ||
		code === 0x2e34 ||
		code === 0x2e32 ||
		code === 0xff0c
	);
}

const SEPARATORS = /[\u002c\u060c\ufe50\ufe10\ufe11\u2e41\u2e34\u2e32\uff0c]/;

/** {@link TextRun} flags: no non-whitespace text; starts with whitespace; ends with whitespace. */
const BLANK = 1;
const LEADING_SPACE = 2;
const TRAILING_SPACE = 4;

/** Measures `text()` of concatenated pieces without building the string. */
class TextRun {
	length = 0;
	/** A blank run that contains whitespace carries both space flags. */
	flags = BLANK;
	commas = 0;
	separators = 0;

	reset(): void {
		this.length = 0;
		this.flags = BLANK;
		this.commas = 0;
		this.separators = 0;
	}

	/** Append a run measured earlier. */
	append(length: number, flags: number, commas: number, separators: number): void {
		this.commas += commas;
		this.separators += separators;
		if (flags & BLANK) {
			if (flags & LEADING_SPACE) this.flags |= this.flags & BLANK ? LEADING_SPACE | TRAILING_SPACE : TRAILING_SPACE;
			return;
		}
		if (this.flags & BLANK) {
			this.length = length;
			this.flags = (this.flags & LEADING_SPACE) | flags;
			return;
		}
		// Whitespace between two non-blank runs collapses to a single character.
		if (this.flags & TRAILING_SPACE || flags & LEADING_SPACE) this.length++;
		this.length += length;
		this.flags = (this.flags & LEADING_SPACE) | (flags & TRAILING_SPACE);
	}

	appendText(value: string): void {
		if (!value) return;
		let length = 0;
		let commas = 0;
		let separators = 0;
		let seen = false;
		let gap = false;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (isSpace(code)) {
				if (seen) gap = true;
				continue;
			}
			if (gap) {
				length++;
				gap = false;
			}
			length++;
			seen = true;
			if (isSeparator(code)) {
				separators++;
				if (code === 0x2c) commas++;
			}
		}
		const flags = seen
			? (isSpace(value.charCodeAt(0)) ? LEADING_SPACE : 0) | (gap ? TRAILING_SPACE : 0)
			: BLANK | LEADING_SPACE | TRAILING_SPACE;
		this.append(length, flags, commas, separators);
	}
}

function isTag(node: ReadabilityElement, upper: string, lower: string): boolean {
	return node.tagName === upper || node.tagName === lower;
}

/**
 * `text()` lengths, comma counts, descendant tag counts and link density of every element in a tree, from one
 * bottom-up pass over the whole tree holding the first element asked about. Answers describe the tree as
 * measured, so only ask about elements whose subtree has not changed since.
 */
class SubtreeStats {
	readonly #countsAsText: (node: ReadabilityNode) => boolean;
	readonly #index = new Map<ReadabilityNode, number>();
	readonly #length: number[] = [];
	readonly #flags: number[] = [];
	readonly #commas: number[] = [];
	readonly #separators: number[] = [];
	readonly #paragraphs: number[] = [];
	readonly #images: number[] = [];
	readonly #inputs: number[] = [];
	/** Range of an element's descendant anchors in {@link #links}. */
	readonly #linkStart: number[] = [];
	readonly #linkEnd: number[] = [];
	/** `linkDensity` term of each anchor, in document order. */
	readonly #links: number[] = [];

	/** `countsAsText` tells whether a non-element child's `textContent` is part of its parent's. */
	constructor(countsAsText: (node: ReadabilityNode) => boolean) {
		this.#countsAsText = countsAsText;
	}

	/** `text(node).length`. */
	length(node: ReadabilityElement): number {
		const index = this.#at(node);
		return index < 0 ? text(node).length : this.#length[index];
	}

	/** `!text(node)`. */
	blank(node: ReadabilityElement): boolean {
		const index = this.#at(node);
		return index < 0 ? !text(node) : (this.#flags[index] & BLANK) !== 0;
	}

	/** `text(node).split(",").length - 1`. */
	commas(node: ReadabilityElement): number {
		const index = this.#at(node);
		return index < 0 ? text(node).split(",").length - 1 : this.#commas[index];
	}

	/** `text(node).split(SEPARATORS).length - 1`. */
	separators(node: ReadabilityElement): number {
		const index = this.#at(node);
		return index < 0 ? text(node).split(SEPARATORS).length - 1 : this.#separators[index];
	}

	/** `node.getElementsByTagName("p").length`. */
	paragraphs(node: ReadabilityElement): number {
		const index = this.#at(node);
		return index < 0 ? node.getElementsByTagName("p").length : this.#paragraphs[index];
	}

	/** `node.getElementsByTagName("img").length`. */
	images(node: ReadabilityElement): number {
		const index = this.#at(node);
		return index < 0 ? node.getElementsByTagName("img").length : this.#images[index];
	}

	/** `node.getElementsByTagName("input").length`. */
	inputs(node: ReadabilityElement): number {
		const index = this.#at(node);
		return index < 0 ? node.getElementsByTagName("input").length : this.#inputs[index];
	}

	/** `linkDensity(node)`, summed in the same order so the result is bit-identical. */
	linkDensity(node: ReadabilityElement): number {
		const index = this.#at(node);
		if (index < 0) return linkDensity(node);
		const total = this.#length[index];
		if (!total) return 0;
		let linked = 0;
		for (let link = this.#linkStart[index]; link < this.#linkEnd[index]; link++) linked += this.#links[link];
		return linked / total;
	}

	#at(node: ReadabilityElement): number {
		const index = this.#index.get(node);
		if (index !== undefined) return index;
		if (node.nodeType !== ELEMENT_NODE) return -1;
		let root: ReadabilityNode = node;
		while (root.parentNode?.nodeType === ELEMENT_NODE) root = root.parentNode;
		this.#measure(root as ReadabilityElement);
		return this.#index.get(node) ?? -1;
	}

	#measure(root: ReadabilityElement): void {
		const first = this.#length.length;
		const order: ReadabilityElement[] = [];
		const anchors: ReadabilityElement[] = [];
		const pending = [root];
		while (pending.length) {
			const node = pending.pop();
			if (!node) continue;
			this.#index.set(node, first + order.length);
			order.push(node);
			// An anchor counts for its ancestors only, so its own range starts after it.
			if (isTag(node, "A", "a")) anchors.push(node);
			this.#linkStart.push(this.#links.length + anchors.length);
			this.#linkEnd.push(0);
			this.#length.push(0);
			this.#flags.push(0);
			this.#commas.push(0);
			this.#separators.push(0);
			this.#paragraphs.push(0);
			this.#images.push(0);
			this.#inputs.push(0);
			const children = node.childNodes;
			for (let child = children.length - 1; child >= 0; child--) {
				if (children[child].nodeType === ELEMENT_NODE) pending.push(children[child] as ReadabilityElement);
			}
		}
		const run = new TextRun();
		// Reverse document order reaches every element after all of its descendants.
		for (let offset = order.length - 1; offset >= 0; offset--) {
			const node = order[offset];
			const index = first + offset;
			const children = node.childNodes;
			// A template's parsed children are not part of its text in every DOM; ask it directly.
			const leaf = !children.length || isTag(node, "TEMPLATE", "template");
			run.reset();
			if (leaf) run.appendText(node.textContent ?? "");
			let paragraphs = 0;
			let images = 0;
			let inputs = 0;
			let linkEnd = this.#linkStart[index];
			for (let child = 0; child < children.length; child++) {
				const childNode = children[child];
				if (childNode.nodeType !== ELEMENT_NODE) {
					if (!leaf && this.#countsAsText(childNode)) run.appendText(childNode.textContent ?? "");
					continue;
				}
				const element = childNode as ReadabilityElement;
				const at = this.#index.get(element) ?? -1;
				if (!leaf) run.append(this.#length[at], this.#flags[at], this.#commas[at], this.#separators[at]);
				paragraphs += this.#paragraphs[at] + (isTag(element, "P", "p") ? 1 : 0);
				images += this.#images[at] + (isTag(element, "IMG", "img") ? 1 : 0);
				inputs += this.#inputs[at] + (isTag(element, "INPUT", "input") ? 1 : 0);
				linkEnd = this.#linkEnd[at];
			}
			this.#length[index] = run.length;
			this.#flags[index] = run.flags;
			this.#commas[index] = run.commas;
			this.#separators[index] = run.separators;
			this.#paragraphs[index] = paragraphs;
			this.#images[index] = images;
			this.#inputs[index] = inputs;
			this.#linkEnd[index] = linkEnd;
		}
		for (const anchor of anchors) {
			const length = this.#length[this.#index.get(anchor) ?? -1];
			this.#links.push(length * ((anchor.getAttribute("href") ?? "").startsWith("#") ? 0.3 : 1));
		}
	}
}

function visible(node: ReadabilityElement): boolean {
	const style = node.getAttribute("style")?.toLowerCase() ?? "";
	return (
		!node.hasAttribute("hidden") &&
		node.getAttribute("aria-hidden") !== "true" &&
		!/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)
	);
}

function removeAll(root: ReadabilityNode, tags: readonly string[]): void {
	const container = root as ReadabilityElement;
	for (const tag of tags) {
		for (const node of elements(container.getElementsByTagName(tag))) node.remove();
	}
}

/** Replace `parent`'s children, detaching the old ones in one step where the DOM supports it. */
function replaceChildren(parent: ReadabilityNode, children: readonly ReadabilityNode[]): void {
	if (parent.replaceChildren) parent.replaceChildren();
	else while (parent.firstChild) parent.firstChild.remove();
	for (const child of children) parent.appendChild(child);
}

/** Move all of `from`'s children to the end of `to` without detaching them one by one. */
function moveChildren(from: ReadabilityNode, to: ReadabilityNode): void {
	if (!from.replaceChildren) {
		while (from.firstChild) to.appendChild(from.firstChild);
		return;
	}
	const children = Array.from(from.childNodes);
	from.replaceChildren();
	for (const child of children) to.appendChild(child);
}

function entityDecode(value: string | undefined | null): string | undefined | null {
	if (!value) return value;
	const named: Record<string, string> = { quot: '"', amp: "&", apos: "'", lt: "<", gt: ">" };
	return value
		.replace(/&(quot|amp|apos|lt|gt);/g, (_, name: string) => named[name] ?? "")
		.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex: string | undefined, decimal: string | undefined) => {
			const value = Number.parseInt(hex ?? decimal ?? "0", hex ? 16 : 10);
			return String.fromCodePoint(
				value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) ? 0xfffd : value,
			);
		});
}

function titleFromDocument(document: ReadabilityDocument): string {
	const titleElement = elements(document.getElementsByTagName("title"))[0];
	const original = typeof document.title === "string" ? document.title.trim() : titleElement ? text(titleElement) : "";
	let title = original;
	const separators = [...original.matchAll(/ [|\\/>»-] /g)];
	if (separators.length) {
		title = original.slice(0, separators.at(-1)?.index);
		if (title.trim().split(/\s+/).length < 3) title = original.replace(/^[^|\\/>»-]*[|\\/>»-]/, "");
	} else if (title.includes(": ")) {
		const matchingHeading = elements(document.querySelectorAll("h1, h2")).some(node => text(node) === title);
		if (!matchingHeading) {
			const suffix = original.slice(original.lastIndexOf(":") + 1);
			title = suffix.trim().split(/\s+/).length < 3 ? original.slice(original.indexOf(":") + 1) : suffix;
		}
	} else if (title.length > 150 || title.length < 15) {
		const headings = elements(document.getElementsByTagName("h1"));
		if (headings.length === 1) title = text(headings[0]);
	}
	title = title.trim().replace(NORMALIZE, " ");
	if (title.split(/\s+/).length <= 4) return original;
	return title;
}

function jsonLdMetadata(document: ReadabilityDocument): Metadata {
	for (const script of elements(document.getElementsByTagName("script"))) {
		if (script.getAttribute("type") !== "application/ld+json") continue;
		try {
			const decoded: unknown = JSON.parse((script.textContent ?? "").replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ""));
			const records = Array.isArray(decoded) ? decoded : [decoded];
			for (const candidate of records) {
				if (!candidate || typeof candidate !== "object") continue;
				const record = candidate as Record<string, unknown>;
				if (typeof record["@type"] !== "string" || !ARTICLE_TYPES.test(record["@type"])) continue;
				const author = record.author;
				let byline: string | undefined;
				if (author && typeof author === "object" && !Array.isArray(author)) {
					const name = (author as Record<string, unknown>).name;
					if (typeof name === "string") byline = name.trim();
				} else if (Array.isArray(author)) {
					const names = author.flatMap(item => {
						if (!item || typeof item !== "object") return [];
						const name = (item as Record<string, unknown>).name;
						return typeof name === "string" ? [name.trim()] : [];
					});
					if (names.length) byline = names.join(", ");
				}
				const publisher = record.publisher;
				const publisherName =
					publisher && typeof publisher === "object" ? (publisher as Record<string, unknown>).name : undefined;
				return {
					title:
						typeof record.name === "string"
							? record.name.trim()
							: typeof record.headline === "string"
								? record.headline.trim()
								: undefined,
					byline,
					excerpt: typeof record.description === "string" ? record.description.trim() : undefined,
					siteName: typeof publisherName === "string" ? publisherName.trim() : undefined,
					publishedTime: typeof record.datePublished === "string" ? record.datePublished.trim() : undefined,
				};
			}
		} catch {
			// Invalid publisher data is ignored just like malformed meta markup.
		}
	}
	return {};
}

function metadataFromDocument(document: ReadabilityDocument, jsonLd: Metadata): Metadata {
	const values = new Map<string, string>();
	for (const meta of elements(document.getElementsByTagName("meta"))) {
		const content = meta.getAttribute("content")?.trim();
		if (!content) continue;
		const property = meta.getAttribute("property")?.toLowerCase().replace(/\s/g, "");
		const name = meta.getAttribute("name")?.toLowerCase().replace(/\s/g, "").replace(/\./g, ":");
		if (
			property &&
			/^(?:article|dc|dcterm|og|twitter):(?:author|creator|description|published_time|title|site_name)$/.test(
				property,
			)
		)
			values.set(property, content);
		else if (
			name &&
			/^(?:(?:dc|dcterm|og|twitter|parsely|weibo:(?:article|webpage))[-:]?)?(?:author|creator|pub-date|description|title|site_name)$/.test(
				name,
			)
		)
			values.set(name, content);
	}
	const articleAuthor = values.get("article:author");
	const result: Metadata = {
		title:
			jsonLd.title ??
			values.get("dc:title") ??
			values.get("dcterm:title") ??
			values.get("og:title") ??
			values.get("title") ??
			values.get("twitter:title") ??
			titleFromDocument(document),
		byline:
			jsonLd.byline ??
			values.get("dc:creator") ??
			values.get("dcterm:creator") ??
			values.get("author") ??
			values.get("parsely-author") ??
			(articleAuthor && !/^https?:\/\//.test(articleAuthor) ? articleAuthor : undefined),
		excerpt:
			jsonLd.excerpt ??
			values.get("dc:description") ??
			values.get("dcterm:description") ??
			values.get("og:description") ??
			values.get("description") ??
			values.get("twitter:description"),
		siteName: jsonLd.siteName ?? values.get("og:site_name"),
		publishedTime:
			jsonLd.publishedTime ?? values.get("article:published_time") ?? values.get("parsely-pub-date") ?? null,
	};
	return {
		title: entityDecode(result.title) ?? undefined,
		byline: entityDecode(result.byline) ?? undefined,
		excerpt: entityDecode(result.excerpt) ?? undefined,
		siteName: entityDecode(result.siteName) ?? undefined,
		publishedTime: entityDecode(result.publishedTime),
	};
}

/** Extracts the article body and metadata from a standards-shaped document. */
export class Readability<T = string> {
	readonly #document: ReadabilityDocument;
	readonly #options: ReadabilityOptions<T>;
	readonly #scores = new Map<ReadabilityElement, number>();
	#byline: string | undefined;
	#lang: string | null = null;
	/** Per non-text node type, whether this DOM counts its `textContent` in a parent's. */
	readonly #textByNodeType = new Map<number, boolean>();

	constructor(document: ReadabilityDocument, options: ReadabilityOptions<T> = {}) {
		this.#document = document;
		this.#options = options;
	}

	/** Runs extraction once; the supplied document is consumed and should not be reused. */
	parse(): ReadabilityArticle<T> | null {
		const documentElement = this.#document.documentElement;
		if (!documentElement) return null;
		const max = this.#options.maxElemsToParse ?? 0;
		if (max > 0) {
			const count = descendants(documentElement).length + 1;
			if (count > max) throw new Error(`Aborting parsing document; ${count} elements found`);
		}
		const jsonLd = this.#options.disableJSONLD ? {} : jsonLdMetadata(this.#document);
		const metadata = metadataFromDocument(this.#document, jsonLd);
		removeAll(this.#document, ["script", "style"]);
		const body = this.#document.body;
		if (!body) return null;
		// Retries start from the body as it was before the first attempt rearranged it.
		const pristine = Array.from(body.childNodes, node => node.cloneNode(true));
		const attempts: Attempt[] = [];
		for (const mode of [0, 1, 2, 3]) {
			if (mode) replaceChildren(body, mode === 3 ? pristine : pristine.map(node => node.cloneNode(true)));
			this.#scores.clear();
			this.#byline = undefined;
			const attempt = this.#extract(body, documentElement, metadata.title ?? "", mode);
			if (attempt) attempts.push(attempt);
			if (attempt && attempt.length >= (this.#options.charThreshold || 500)) break;
		}
		attempts.sort((left, right) => right.length - left.length);
		const best = attempts[0];
		if (!best?.length) return null;
		if (!metadata.excerpt) {
			const firstParagraph = elements(best.element.getElementsByTagName("p"))[0];
			if (firstParagraph) metadata.excerpt = (firstParagraph.textContent ?? "").trim();
		}
		const contentText = best.element.textContent ?? "";
		const serializer =
			this.#options.serializer ?? ((node: ReadabilityNode) => (node as ReadabilityElement).innerHTML as T);
		return {
			title: metadata.title,
			byline: metadata.byline ?? this.#byline,
			dir: best.dir,
			lang: this.#lang,
			content: serializer(best.element),
			textContent: contentText,
			length: contentText.length,
			excerpt: metadata.excerpt,
			siteName: metadata.siteName,
			publishedTime: metadata.publishedTime,
		};
	}

	#extract(
		body: ReadabilityElement,
		documentElement: ReadabilityElement,
		articleTitle: string,
		mode: number,
	): Attempt | null {
		this.#lang = documentElement.getAttribute("lang");
		const stripUnlikely = mode === 0;
		const weightClasses = mode < 2;
		const all = [documentElement, ...descendants(documentElement)];
		const scored: ReadabilityElement[] = [];
		let titleRemoved = false;
		for (const node of all) {
			if (node === documentElement || node.tagName === "BODY") continue;
			const label = matchLabel(node);
			if (!visible(node) || (node.getAttribute("aria-modal") === "true" && node.getAttribute("role") === "dialog")) {
				node.remove();
				continue;
			}
			if (!this.#byline) {
				const byline = this.#bylineText(node, label);
				if (byline) {
					this.#byline = byline;
					node.remove();
					continue;
				}
			}
			if (!titleRemoved && /^(?:H1|H2)$/.test(node.tagName) && this.#similar(articleTitle, text(node)) > 0.75) {
				titleRemoved = true;
				node.remove();
				continue;
			}
			if (
				(stripUnlikely && UNLIKELY.test(label) && !POSSIBLE.test(label)) ||
				UNLIKELY_ROLES.has(node.getAttribute("role") ?? "")
			) {
				node.remove();
				continue;
			}
			if (SCORE_TAGS.has(node.tagName)) scored.push(node);
		}
		// Scoring and sibling selection below only read the tree, so one measurement serves them all.
		const stats = new SubtreeStats(this.#countsAsText);
		for (const paragraph of scored) this.#scoreParagraph(paragraph, weightClasses, stats);
		let top: ReadabilityElement | undefined;
		let topScore = Number.NEGATIVE_INFINITY;
		for (const [candidate, raw] of this.#scores) {
			if (candidate.tagName === "BODY" || candidate.tagName === "HTML") continue;
			const score = raw * (1 - stats.linkDensity(candidate));
			this.#scores.set(candidate, score);
			if (score > topScore) {
				top = candidate;
				topScore = score;
			}
		}
		if (!top || top.tagName === "BODY") top = body;
		while (
			top.parentNode &&
			(top.parentNode as ReadabilityElement).tagName !== "BODY" &&
			(top.parentNode as ReadabilityElement).children.length === 1
		)
			top = top.parentNode as ReadabilityElement;
		const parent = top.parentNode as ReadabilityElement | null;
		const article = this.#document.createElement("DIV");
		const siblings = parent ? elements(parent.children) : [top];
		const threshold = Math.max(10, (this.#scores.get(top) ?? topScore) * 0.2);
		for (const sibling of siblings) {
			// Moving earlier siblings into the article leaves this sibling's subtree, and so its stats, intact.
			const siblingLength = stats.length(sibling);
			const sameClassBonus =
				sibling.className && sibling.className === top.className ? (this.#scores.get(top) ?? 0) * 0.2 : 0;
			const include =
				sibling === top ||
				(this.#scores.get(sibling) ?? 0) + sameClassBonus >= threshold ||
				(sibling.tagName === "P" &&
					((siblingLength > 80 && stats.linkDensity(sibling) < 0.25) ||
						(siblingLength > 0 &&
							siblingLength < 80 &&
							stats.linkDensity(sibling) === 0 &&
							/\.(?: |$)/.test(text(sibling)))));
			if (!include) continue;
			if (["DIV", "ARTICLE", "SECTION", "P", "OL", "UL"].includes(sibling.tagName)) {
				article.appendChild(sibling);
				continue;
			}
			const replacement = this.#document.createElement("DIV");
			for (const attribute of Array.from(sibling.attributes))
				replacement.setAttribute(attribute.name, attribute.value);
			moveChildren(sibling, replacement);
			article.appendChild(replacement);
		}
		this.#clean(article, mode < 3);
		const page = this.#document.createElement("DIV");
		page.id = "readability-page-1";
		page.className = "page";
		moveChildren(article, page);
		article.appendChild(page);
		const content = text(article);
		let dir: string | null | undefined;
		let ancestor: ReadabilityNode | null = top;
		while (ancestor) {
			if ((ancestor as ReadabilityElement).getAttribute) {
				dir = (ancestor as ReadabilityElement).getAttribute("dir");
				if (dir) break;
			}
			ancestor = ancestor.parentNode;
		}
		return { element: article, length: content.length, dir };
	}

	#scoreParagraph(node: ReadabilityElement, weightClasses: boolean, stats: SubtreeStats): void {
		const length = stats.length(node);
		if (length < 25) return;
		const score = 1 + (stats.separators(node) + 1) + Math.min(Math.floor(length / 100), 3);
		let ancestor = node.parentNode;
		for (let level = 0; ancestor && level < 5; level++, ancestor = ancestor.parentNode) {
			const element = ancestor as ReadabilityElement;
			if (!element.tagName || !element.parentNode || !(element.parentNode as ReadabilityElement).tagName) continue;
			const baseline =
				this.#scores.get(element) ?? initialScore(element) - (weightClasses ? 0 : classWeight(element));
			const divisor = level === 0 ? 1 : level === 1 ? 2 : level * 3;
			this.#scores.set(element, baseline + score / divisor);
		}
	}

	#clean(root: ReadabilityElement, conditional: boolean): void {
		removeAll(root, DROP_TAGS);
		for (const heading of elements(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
			if (classWeight(heading) < 0 || linkDensity(heading) > 0.33) heading.remove();
		}
		if (conditional) {
			// Nodes come in document order, so removing one only changes ancestors that were already judged.
			const stats = new SubtreeStats(this.#countsAsText);
			for (const node of elements(root.querySelectorAll("table, ul, div"))) {
				if (node === root) continue;
				const paragraphs = stats.paragraphs(node);
				const images = stats.images(node);
				if (
					classWeight(node) < 0 ||
					(stats.blank(node) && !images) ||
					(stats.commas(node) + 1 < 10 &&
						((images > paragraphs && paragraphs > 0) ||
							stats.inputs(node) > Math.floor(paragraphs / 3) ||
							stats.linkDensity(node) > 0.5))
				)
					node.remove();
			}
		}
		for (const paragraph of elements(root.getElementsByTagName("p"))) {
			if (!text(paragraph) && !paragraph.querySelector("img, embed, object, iframe")) paragraph.remove();
		}
		for (const node of [root, ...descendants(root)]) {
			if (!this.#options.keepClasses) {
				const preserved = (this.#options.classesToPreserve ?? []).filter(name =>
					node.className.split(/\s+/).includes(name),
				);
				if (node.id === "readability-page-1") preserved.unshift("page");
				if (preserved.length) node.className = [...new Set(preserved)].join(" ");
				else node.removeAttribute("class");
			}
			for (const attr of [
				"style",
				"align",
				"background",
				"bgcolor",
				"border",
				"cellpadding",
				"cellspacing",
				"frame",
				"hspace",
				"rules",
				"valign",
				"vspace",
			])
				node.removeAttribute(attr);
		}
	}

	/** Byline text when `node` is marked as one; the attribute checks run first so most nodes never build text. */
	#bylineText(node: ReadabilityElement, label: string): string | undefined {
		if (
			node.getAttribute("rel") !== "author" &&
			!(node.getAttribute("itemprop") ?? "").includes("author") &&
			!BYLINE.test(label)
		)
			return undefined;
		const value = text(node);
		return value.length > 0 && value.length < 100 ? value : undefined;
	}

	/** Whether a non-element child's `textContent` is part of its parent's (text is; comments are in some DOMs). */
	readonly #countsAsText = (node: ReadabilityNode): boolean => {
		if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) return true;
		const value = node.textContent;
		if (!value) return false;
		let counts = this.#textByNodeType.get(node.nodeType);
		if (counts === undefined) {
			const probe = this.#document.createElement("DIV");
			probe.appendChild(node.cloneNode(false));
			counts = probe.textContent === value;
			this.#textByNodeType.set(node.nodeType, counts);
		}
		return counts;
	};

	#similar(left: string, right: string): number {
		const leftTokens = left.toLowerCase().split(/\W+/).filter(Boolean);
		const rightTokens = right.toLowerCase().split(/\W+/).filter(Boolean);
		if (!leftTokens.length || !rightTokens.length) return 0;
		const unmatched = rightTokens.filter(token => !leftTokens.includes(token));
		return 1 - unmatched.join(" ").length / rightTokens.join(" ").length;
	}
}
