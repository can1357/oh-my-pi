interface XmlText {
	readonly kind: "text";
	readonly value: string;
}

/** A minimal XML element used by the DOCX reader. */
export interface XmlElement {
	readonly kind: "element";
	readonly name: string;
	readonly attributes: ReadonlyMap<string, string>;
	readonly children: readonly XmlNode[];
}

/** A node in the DOCX reader's minimal XML tree. */
export type XmlNode = XmlElement | XmlText;

const ENTITY_PATTERN = /&(?:#x[\da-fA-F]+|#\d+|amp|apos|gt|lt|quot);/g;
const ATTRIBUTE_PATTERN = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(value: string): string {
	return value.replace(ENTITY_PATTERN, entity => {
		switch (entity) {
			case "&amp;":
				return "&";
			case "&apos;":
				return "'";
			case "&gt;":
				return ">";
			case "&lt;":
				return "<";
			case "&quot;":
				return '"';
			default: {
				const hexadecimal = entity[2] === "x";
				const digits = entity.slice(hexadecimal ? 3 : 2, -1);
				const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
				return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
			}
		}
	});
}

/** Return the namespace-independent part of an XML qualified name. */
export function localName(name: string): string {
	const colon = name.indexOf(":");
	return colon === -1 ? name : name.slice(colon + 1);
}

/** Parse XML into a small namespace-tolerant element tree. */
export function parseXml(source: string): XmlElement {
	const synthetic: { name: string; attributes: Map<string, string>; children: XmlNode[] } = {
		name: "#document",
		attributes: new Map(),
		children: [],
	};
	const stack: Array<{ name: string; attributes: Map<string, string>; children: XmlNode[] }> = [synthetic];
	let offset = 0;
	while (offset < source.length) {
		const lessThan = source.indexOf("<", offset);
		if (lessThan === -1) {
			const value = decodeEntities(source.slice(offset));
			if (value) stack[stack.length - 1].children.push({ kind: "text", value });
			break;
		}
		if (lessThan > offset) {
			const value = decodeEntities(source.slice(offset, lessThan));
			if (value) stack[stack.length - 1].children.push({ kind: "text", value });
		}
		if (source.startsWith("<!--", lessThan)) {
			const end = source.indexOf("-->", lessThan + 4);
			if (end === -1) throw new Error("Invalid XML: unterminated comment");
			offset = end + 3;
			continue;
		}
		if (source.startsWith("<![CDATA[", lessThan)) {
			const end = source.indexOf("]]>", lessThan + 9);
			if (end === -1) throw new Error("Invalid XML: unterminated CDATA section");
			stack[stack.length - 1].children.push({ kind: "text", value: source.slice(lessThan + 9, end) });
			offset = end + 3;
			continue;
		}
		if (source.startsWith("<?", lessThan)) {
			const end = source.indexOf("?>", lessThan + 2);
			if (end === -1) throw new Error("Invalid XML: unterminated processing instruction");
			offset = end + 2;
			continue;
		}
		if (source.startsWith("<!", lessThan)) {
			const end = source.indexOf(">", lessThan + 2);
			if (end === -1) throw new Error("Invalid XML: unterminated declaration");
			offset = end + 1;
			continue;
		}
		const end = source.indexOf(">", lessThan + 1);
		if (end === -1) throw new Error("Invalid XML: unterminated tag");
		const raw = source.slice(lessThan + 1, end).trim();
		if (raw.startsWith("/")) {
			if (stack.length === 1) throw new Error("Invalid XML: unexpected closing tag");
			const closingName = raw.slice(1).trim();
			const completed = stack.pop();
			if (!completed || completed.name !== closingName)
				throw new Error(`Invalid XML: mismatched closing tag ${closingName}`);
			stack[stack.length - 1].children.push({
				kind: "element",
				name: completed.name,
				attributes: completed.attributes,
				children: completed.children,
			});
		} else {
			const selfClosing = raw.endsWith("/");
			const tag = selfClosing ? raw.slice(0, -1).trim() : raw;
			const whitespace = tag.search(/\s/);
			const name = whitespace === -1 ? tag : tag.slice(0, whitespace);
			const attributes = new Map<string, string>();
			ATTRIBUTE_PATTERN.lastIndex = whitespace === -1 ? tag.length : whitespace;
			for (let match = ATTRIBUTE_PATTERN.exec(tag); match; match = ATTRIBUTE_PATTERN.exec(tag)) {
				attributes.set(match[1], decodeEntities(match[2] ?? match[3] ?? ""));
			}
			const pending = { name, attributes, children: [] as XmlNode[] };
			if (selfClosing) {
				stack[stack.length - 1].children.push({ kind: "element", ...pending });
			} else {
				stack.push(pending);
			}
		}
		offset = end + 1;
	}
	if (stack.length !== 1) throw new Error(`Invalid XML: unclosed tag ${stack[stack.length - 1].name}`);
	const roots = synthetic.children.filter((node): node is XmlElement => node.kind === "element");
	if (roots.length !== 1) throw new Error("Invalid XML: expected one root element");
	return roots[0];
}

/** Return direct element children, optionally filtered by local name. */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
	return element.children.filter(
		(node): node is XmlElement => node.kind === "element" && (name === undefined || localName(node.name) === name),
	);
}

/** Return the first direct child with the given local name. */
export function firstChild(element: XmlElement | undefined, name: string): XmlElement | undefined {
	if (!element) return undefined;
	return element.children.find((node): node is XmlElement => node.kind === "element" && localName(node.name) === name);
}

/** Return an attribute by qualified or namespace-independent name. */
export function attribute(element: XmlElement | undefined, name: string): string | undefined {
	if (!element) return undefined;
	const exact = element.attributes.get(name);
	if (exact !== undefined) return exact;
	for (const [attributeName, value] of element.attributes) {
		if (localName(attributeName) === localName(name)) return value;
	}
	return undefined;
}

/** Return all descendant elements with a given local name. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
	const matches: XmlElement[] = [];
	for (const child of childElements(element)) {
		if (localName(child.name) === name) matches.push(child);
		matches.push(...descendants(child, name));
	}
	return matches;
}
