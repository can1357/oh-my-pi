import { Document, type DocumentFragment, Element, Text } from "./core";

/** Closing-tag patterns for raw-text elements, reused across parses (callers reset `lastIndex`). */
const RAW_TEXT_CLOSE: Record<string, RegExp> = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };
const DOCTYPE_PATTERN = /<!doctype\b/iy;
const TAG_NAME_PATTERN = /[^\s/>]+/y;
const ATTRIBUTE_NAME_PATTERN = /[^\s=/>]+/y;
const UNQUOTED_VALUE_PATTERN = /[^\s>]+/y;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const VOID_ELEMENTS: Record<string, true> = {
	area: true,
	base: true,
	br: true,
	col: true,
	embed: true,
	hr: true,
	img: true,
	input: true,
	link: true,
	meta: true,
	param: true,
	source: true,
	track: true,
	wbr: true,
};
const CLOSE_ON_OPEN: Record<string, readonly string[]> = {
	li: ["li"],
	dt: ["dt", "dd"],
	dd: ["dt", "dd"],
	tr: ["tr"],
	th: ["th", "td"],
	td: ["th", "td"],
	option: ["option"],
	thead: ["thead", "tbody", "tfoot"],
	tbody: ["thead", "tbody", "tfoot"],
	tfoot: ["thead", "tbody", "tfoot"],
};
const P_CLOSERS: Record<string, true> = {
	address: true,
	article: true,
	aside: true,
	blockquote: true,
	div: true,
	dl: true,
	fieldset: true,
	footer: true,
	form: true,
	h1: true,
	h2: true,
	h3: true,
	h4: true,
	h5: true,
	h6: true,
	header: true,
	hr: true,
	menu: true,
	nav: true,
	ol: true,
	p: true,
	pre: true,
	section: true,
	table: true,
	ul: true,
};

const NAMED_ENTITIES: Record<string, string> = {
	AElig: "Æ",
	Aacute: "Á",
	Acirc: "Â",
	Agrave: "À",
	Aring: "Å",
	Atilde: "Ã",
	Auml: "Ä",
	Ccedil: "Ç",
	ETH: "Ð",
	Eacute: "É",
	Ecirc: "Ê",
	Egrave: "È",
	Euml: "Ë",
	Iacute: "Í",
	Icirc: "Î",
	Igrave: "Ì",
	Iuml: "Ï",
	Ntilde: "Ñ",
	Oacute: "Ó",
	Ocirc: "Ô",
	Ograve: "Ò",
	Oslash: "Ø",
	Otilde: "Õ",
	Ouml: "Ö",
	THORN: "Þ",
	Uacute: "Ú",
	Ucirc: "Û",
	Ugrave: "Ù",
	Uuml: "Ü",
	Yacute: "Ý",
	aacute: "á",
	acirc: "â",
	aelig: "æ",
	agrave: "à",
	aring: "å",
	atilde: "ã",
	auml: "ä",
	amp: "&",
	apos: "'",
	bull: "•",
	brvbar: "¦",
	ccedil: "ç",
	cedil: "¸",
	cent: "¢",
	copy: "©",
	deg: "°",
	curren: "¤",
	divide: "÷",
	emsp: " ",
	ensp: " ",
	euro: "€",
	eacute: "é",
	ecirc: "ê",
	egrave: "è",
	eth: "ð",
	euml: "ë",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	gt: ">",
	iacute: "í",
	icirc: "î",
	iexcl: "¡",
	igrave: "ì",
	iquest: "¿",
	iuml: "ï",
	hellip: "…",
	laquo: "«",
	ldquo: "“",
	lsquo: "‘",
	lt: "<",
	mdash: "—",
	macr: "¯",
	micro: "µ",
	middot: "·",
	nbsp: " ",
	ndash: "–",
	ntilde: "ñ",
	oacute: "ó",
	ocirc: "ô",
	ograve: "ò",
	ordf: "ª",
	ordm: "º",
	oslash: "ø",
	otilde: "õ",
	ouml: "ö",
	para: "¶",
	pound: "£",
	plusmn: "±",
	quot: '"',
	raquo: "»",
	rdquo: "”",
	reg: "®",
	rsquo: "’",
	sect: "§",
	shy: "­",
	szlig: "ß",
	thorn: "þ",
	sup1: "¹",
	sup2: "²",
	sup3: "³",
	thinsp: " ",
	times: "×",
	trade: "™",
	uacute: "ú",
	ucirc: "û",
	ugrave: "ù",
	uml: "¨",
	uuml: "ü",
	yacute: "ý",
	yuml: "ÿ",
	yen: "¥",
};

const ENTITY_PATTERN = /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi;

/** Decode common named entities and all valid numeric character references. */
export function decodeEntities(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(ENTITY_PATTERN, (whole, entity: string) => {
		if (entity[0] !== "#") return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
		const hexadecimal = entity[1]?.toLowerCase() === "x";
		const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
		if (
			!Number.isFinite(codePoint) ||
			codePoint <= 0 ||
			codePoint > 0x10ffff ||
			(codePoint >= 0xd800 && codePoint <= 0xdfff)
		) {
			return "�";
		}
		return String.fromCodePoint(codePoint);
	});
}

function findTagEnd(html: string, start: number): number {
	let quote = "";
	for (let index = start; index < html.length; index++) {
		const character = html[index];
		if (quote) {
			if (character === quote) quote = "";
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return index;
		}
	}
	return html.length - 1;
}

function parseStartTag(
	source: string,
): { name: string; attributes: Array<[string, string]>; selfClosing: boolean } | null {
	let index = 0;
	while (/\s/.test(source[index] ?? "")) index++;
	TAG_NAME_PATTERN.lastIndex = index;
	const nameMatch = TAG_NAME_PATTERN.exec(source);
	if (!nameMatch) return null;
	const name = nameMatch[0].toLowerCase();
	index += nameMatch[0].length;
	const attributes: Array<[string, string]> = [];
	let selfClosing = false;
	while (index < source.length) {
		while (/\s/.test(source[index] ?? "")) index++;
		if (source[index] === "/") {
			selfClosing = true;
			break;
		}
		ATTRIBUTE_NAME_PATTERN.lastIndex = index;
		const attributeMatch = ATTRIBUTE_NAME_PATTERN.exec(source);
		if (!attributeMatch) break;
		const attributeName = attributeMatch[0];
		index += attributeMatch[0].length;
		while (/\s/.test(source[index] ?? "")) index++;
		let value = "";
		if (source[index] === "=") {
			index++;
			while (/\s/.test(source[index] ?? "")) index++;
			const quote = source[index];
			if (quote === '"' || quote === "'") {
				index++;
				const end = source.indexOf(quote, index);
				if (end < 0) {
					value = source.slice(index);
					index = source.length;
				} else {
					value = source.slice(index, end);
					index = end + 1;
				}
			} else {
				UNQUOTED_VALUE_PATTERN.lastIndex = index;
				const valueMatch = UNQUOTED_VALUE_PATTERN.exec(source);
				value = valueMatch?.[0] ?? "";
				index += value.length;
			}
		}
		if (!attributes.some(([existing]) => existing.toLowerCase() === attributeName.toLowerCase())) {
			attributes.push([attributeName, decodeEntities(value)]);
		}
	}
	return { name, attributes, selfClosing };
}

function closeOptionalElements(stack: Element[], incoming: string): void {
	const current = stack[stack.length - 1];
	if (!current) return;
	if (current.localName === "p" && P_CLOSERS[incoming]) {
		stack.pop();
		return;
	}
	const closeable = CLOSE_ON_OPEN[incoming];
	if (closeable?.includes(current.localName)) stack.pop();
}

/** Parse markup, appending the resulting nodes to `root` (a document, fragment, or element). */
export function parseInto(html: string, document: Document, root: Document | DocumentFragment | Element): void {
	const stack: Element[] = [];
	const xmlLike = root instanceof Document && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<(?:feed|rss)\b/i.test(html);
	let parent: Document | DocumentFragment | Element = root;
	let index = 0;
	while (index < html.length) {
		if (html.startsWith("<!--", index)) {
			const end = html.indexOf("-->", index + 4);
			const contentEnd = end < 0 ? html.length : end;
			parent.appendChild(document.createComment(html.slice(index + 4, contentEnd)));
			index = end < 0 ? html.length : end + 3;
			continue;
		}
		if (html[index] !== "<") {
			const next = html.indexOf("<", index);
			const end = next < 0 ? html.length : next;
			parent.appendChild(new Text(decodeEntities(html.slice(index, end)), document, xmlLike));
			index = end;
			continue;
		}
		if (html[index + 1] === "!" && isDoctypeAt(html, index)) {
			const end = html.indexOf(">", index + 2);
			index = end < 0 ? html.length : end + 1;
			continue;
		}
		if (html.startsWith("<![CDATA[", index)) {
			const end = html.indexOf("]]>", index + 9);
			const contentEnd = end < 0 ? html.length : end;
			parent.appendChild(new Text(html.slice(index + 9, contentEnd), document, xmlLike));
			index = end < 0 ? html.length : end + 3;
			continue;
		}
		if (html[index + 1] === "/") {
			const end = findTagEnd(html, index + 2);
			const closingName = html
				.slice(index + 2, end)
				.trim()
				.split(/\s/, 1)[0]
				.toLowerCase();
			const matchIndex = stack.findLastIndex(element => element.localName === closingName);
			if (matchIndex >= 0) stack.length = matchIndex;
			parent = stack[stack.length - 1] ?? root;
			index = end + 1;
			continue;
		}
		if (html[index + 1] === "!" || html[index + 1] === "?") {
			const end = html.indexOf(">", index + 2);
			index = end < 0 ? html.length : end + 1;
			continue;
		}
		const end = findTagEnd(html, index + 1);
		const parsed = parseStartTag(html.slice(index + 1, end));
		if (!parsed) {
			parent.appendChild(document.createTextNode("<"));
			index++;
			continue;
		}
		closeOptionalElements(stack, parsed.name);
		parent = stack[stack.length - 1] ?? root;
		// The root itself never supplies a namespace: fragments and documents are namespace-less, and
		// element roots (innerHTML) parse their top-level nodes as HTML like a detached fragment would.
		const namespace =
			(parent !== root && parent instanceof Element && parent.namespaceURI === SVG_NAMESPACE) ||
			parsed.name === "svg"
				? SVG_NAMESPACE
				: HTML_NAMESPACE;
		const element = document.createElementNS(namespace, parsed.name);
		for (let attributeIndex = parsed.attributes.length - 1; attributeIndex >= 0; attributeIndex--) {
			const [name, value] = parsed.attributes[attributeIndex];
			element.setAttribute(name, value);
		}
		parent.appendChild(element);
		index = end + 1;
		if (RAW_TEXT_CLOSE[parsed.name] && !parsed.selfClosing) {
			// Prototype keys (e.g. `<constructor>`) were historically treated as raw text too; keep that.
			const closePattern = Object.hasOwn(RAW_TEXT_CLOSE, parsed.name)
				? RAW_TEXT_CLOSE[parsed.name]
				: new RegExp(`</${parsed.name}\\s*>`, "ig");
			closePattern.lastIndex = index;
			const match = closePattern.exec(html);
			const rawEnd = match?.index ?? html.length;
			element.appendChild(new Text(html.slice(index, rawEnd), document));
			index = match ? closePattern.lastIndex : html.length;
			continue;
		}
		if (!VOID_ELEMENTS[parsed.name] && !(namespace === SVG_NAMESPACE && parsed.selfClosing)) {
			stack.push(element);
			parent = element;
		}
	}
}

function isDoctypeAt(html: string, index: number): boolean {
	DOCTYPE_PATTERN.lastIndex = index;
	return DOCTYPE_PATTERN.test(html);
}

/** Parse markup into a document fragment. `_contextTag` is accepted for compatibility and ignored. */
export function parseFragment(html: string, document: Document, _contextTag?: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	parseInto(html, document, fragment);
	return fragment;
}

/** Parse markup directly into a document. */
export function parseDocument(html: string): Document {
	const document = new Document();
	parseInto(html, document, document);
	return document;
}
