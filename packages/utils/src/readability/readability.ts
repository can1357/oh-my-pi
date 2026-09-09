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
		const source = body.innerHTML;
		const attempts: Attempt[] = [];
		for (const mode of [0, 1, 2, 3]) {
			if (mode) body.innerHTML = source;
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
			if (!this.#byline && this.#isByline(node, label)) {
				this.#byline = text(node);
				node.remove();
				continue;
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
		for (const paragraph of scored) this.#scoreParagraph(paragraph, weightClasses);
		let top: ReadabilityElement | undefined;
		let topScore = Number.NEGATIVE_INFINITY;
		for (const [candidate, raw] of this.#scores) {
			if (candidate.tagName === "BODY" || candidate.tagName === "HTML") continue;
			const score = raw * (1 - linkDensity(candidate));
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
			const siblingText = text(sibling);
			const sameClassBonus =
				sibling.className && sibling.className === top.className ? (this.#scores.get(top) ?? 0) * 0.2 : 0;
			const include =
				sibling === top ||
				(this.#scores.get(sibling) ?? 0) + sameClassBonus >= threshold ||
				(sibling.tagName === "P" &&
					((siblingText.length > 80 && linkDensity(sibling) < 0.25) ||
						(siblingText.length > 0 &&
							siblingText.length < 80 &&
							linkDensity(sibling) === 0 &&
							/\.(?: |$)/.test(siblingText))));
			if (!include) continue;
			if (["DIV", "ARTICLE", "SECTION", "P", "OL", "UL"].includes(sibling.tagName)) {
				article.appendChild(sibling);
				continue;
			}
			const replacement = this.#document.createElement("DIV");
			for (const attribute of Array.from(sibling.attributes))
				replacement.setAttribute(attribute.name, attribute.value);
			while (sibling.firstChild) replacement.appendChild(sibling.firstChild);
			article.appendChild(replacement);
		}
		this.#clean(article, mode < 3);
		const page = this.#document.createElement("DIV");
		page.id = "readability-page-1";
		page.className = "page";
		while (article.firstChild) page.appendChild(article.firstChild);
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

	#scoreParagraph(node: ReadabilityElement, weightClasses: boolean): void {
		const content = text(node);
		if (content.length < 25) return;
		const score =
			1 +
			content.split(/[\u002c\u060c\ufe50\ufe10\ufe11\u2e41\u2e34\u2e32\uff0c]/).length +
			Math.min(Math.floor(content.length / 100), 3);
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
			for (const node of elements(root.querySelectorAll("table, ul, div"))) {
				if (node === root) continue;
				const nodeText = text(node);
				const paragraphs = node.getElementsByTagName("p").length;
				const images = node.getElementsByTagName("img").length;
				const inputs = node.getElementsByTagName("input").length;
				if (
					classWeight(node) < 0 ||
					(!nodeText && !images) ||
					(nodeText.split(",").length < 10 &&
						((images > paragraphs && paragraphs > 0) ||
							inputs > Math.floor(paragraphs / 3) ||
							linkDensity(node) > 0.5))
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

	#isByline(node: ReadabilityElement, label: string): boolean {
		const value = text(node);
		return (
			value.length > 0 &&
			value.length < 100 &&
			(node.getAttribute("rel") === "author" ||
				(node.getAttribute("itemprop") ?? "").includes("author") ||
				BYLINE.test(label))
		);
	}

	#similar(left: string, right: string): number {
		const leftTokens = left.toLowerCase().split(/\W+/).filter(Boolean);
		const rightTokens = right.toLowerCase().split(/\W+/).filter(Boolean);
		if (!leftTokens.length || !rightTokens.length) return 0;
		const unmatched = rightTokens.filter(token => !leftTokens.includes(token));
		return 1 - unmatched.join(" ").length / rightTokens.join(" ").length;
	}
}
