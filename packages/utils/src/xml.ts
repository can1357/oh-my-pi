/** Behavior-compatible reimplementation of fast-xml-parser's used surface. */

/** Context supplied to an array-selection callback. */
export type XMLArraySelector = (
	tagName: string,
	jPath: string,
	isLeafNode: boolean,
	isAttribute: boolean | null,
) => boolean;

/** Options supported by {@link XMLParser}. */
export interface XMLParserOptions {
	/** Omits attributes when true (default). */
	ignoreAttributes?: boolean;
	/** Prefix applied to attribute property names. */
	attributeNamePrefix?: string;
	/** Property used for text alongside children or attributes. */
	textNodeName?: string;
	/** Trims ordinary text and attribute values. */
	trimValues?: boolean;
	/** Coerces numeric and boolean element text. */
	parseTagValue?: boolean;
	/** Coerces numeric and boolean attribute values. */
	parseAttributeValue?: boolean;
	/** Controls entity processing and its expansion ceiling. */
	processEntities?: boolean | { maxTotalExpansions?: number };
	/** Selects element or attribute properties that must always be arrays. */
	isArray?: XMLArraySelector;
}

type XmlObject = Record<string, unknown>;

const STANDARD_ENTITIES: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

interface ParsedElement {
	name: string;
	value: unknown;
	leaf: boolean;
}

interface ParserSettings {
	ignoreAttributes: boolean;
	attributeNamePrefix: string;
	textNodeName: string;
	trimValues: boolean;
	parseTagValue: boolean;
	parseAttributeValue: boolean;
	processEntities: boolean;
	maxTotalExpansions: number;
	isArray?: XMLArraySelector;
}

/** Parses XML into the object shape used by the document converters. */
export class XMLParser {
	readonly #settings: ParserSettings;

	constructor(options: XMLParserOptions = {}) {
		this.#settings = {
			ignoreAttributes: options.ignoreAttributes ?? true,
			attributeNamePrefix: options.attributeNamePrefix ?? "@_",
			textNodeName: options.textNodeName ?? "#text",
			trimValues: options.trimValues ?? true,
			parseTagValue: options.parseTagValue ?? true,
			parseAttributeValue: options.parseAttributeValue ?? false,
			processEntities: options.processEntities !== false,
			maxTotalExpansions:
				typeof options.processEntities === "object"
					? (options.processEntities.maxTotalExpansions ?? 100_000)
					: 100_000,
			isArray: options.isArray,
		};
	}

	/** Parses one XML document. */
	parse(xml: string): unknown {
		return new XmlReader(xml, this.#settings).parseDocument();
	}
}

class XmlReader {
	readonly #xml: string;
	readonly #settings: ParserSettings;
	readonly #entities = new Map<string, string>();
	#position = 0;
	#expansions = 0;

	constructor(xml: string, settings: ParserSettings) {
		this.#xml = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
		this.#settings = settings;
	}

	parseDocument(): XmlObject {
		const document: XmlObject = {};
		while (this.#position < this.#xml.length) {
			if (this.#xml.startsWith("<!--", this.#position)) {
				this.#skipThrough("-->");
				continue;
			}
			if (this.#xml.startsWith("<!DOCTYPE", this.#position)) {
				this.#readDoctype();
				continue;
			}
			if (this.#xml.startsWith("<?", this.#position)) {
				this.#readProcessingInstruction(document);
				continue;
			}
			if (this.#xml[this.#position] === "<") {
				const element = this.#readElement("");
				this.#addValue(document, element.name, element.name, element.value, element.leaf, null);
				continue;
			}
			this.#position++;
		}
		return document;
	}

	#readElement(parentPath: string): ParsedElement {
		this.#position++;
		const name = this.#readName();
		const path = parentPath ? `${parentPath}.${name}` : name;
		const attributes: [string, string][] = [];
		let selfClosing = false;
		while (this.#position < this.#xml.length) {
			this.#skipWhitespace();
			if (this.#xml.startsWith("/>", this.#position)) {
				this.#position += 2;
				selfClosing = true;
				break;
			}
			if (this.#xml[this.#position] === ">") {
				this.#position++;
				break;
			}
			const attributeName = this.#readName();
			this.#skipWhitespace();
			let value = "true";
			if (this.#xml[this.#position] === "=") {
				this.#position++;
				this.#skipWhitespace();
				value = this.#readAttributeValue();
			}
			attributes.push([attributeName, value]);
		}

		const children: XmlObject = {};
		let text = "";
		let hasChildren = false;
		if (!selfClosing) {
			while (this.#position < this.#xml.length) {
				if (this.#xml.startsWith(`</${name}`, this.#position)) {
					this.#position += name.length + 2;
					const close = this.#xml.indexOf(">", this.#position);
					this.#position = close < 0 ? this.#xml.length : close + 1;
					break;
				}
				if (this.#xml.startsWith("<![CDATA[", this.#position)) {
					const end = this.#xml.indexOf("]]>", this.#position + 9);
					const raw = this.#xml.slice(this.#position + 9, end < 0 ? this.#xml.length : end);
					const normalized = raw;
					text += this.#settings.parseTagValue ? String(coerceValue(normalized)) : normalized;
					this.#position = end < 0 ? this.#xml.length : end + 3;
					continue;
				}
				if (this.#xml.startsWith("<!--", this.#position)) {
					this.#skipThrough("-->");
					continue;
				}
				if (this.#xml.startsWith("<?", this.#position)) {
					this.#skipThrough("?>");
					continue;
				}
				if (this.#xml[this.#position] === "<") {
					const child = this.#readElement(path);
					hasChildren = true;
					this.#addValue(children, child.name, `${path}.${child.name}`, child.value, child.leaf, null);
					continue;
				}
				const next = this.#xml.indexOf("<", this.#position);
				const end = next < 0 ? this.#xml.length : next;
				const normalized = this.#normalizeText(this.#xml.slice(this.#position, end), true);
				text += this.#settings.parseTagValue ? String(coerceValue(normalized)) : normalized;
				this.#position = end;
			}
		}

		const hasAttributes = !this.#settings.ignoreAttributes && attributes.length > 0;
		const parsedText = this.#settings.parseTagValue ? coerceValue(text) : text;
		if (!hasChildren && !hasAttributes) return { name, value: parsedText, leaf: true };
		if (text !== "") children[this.#settings.textNodeName] = parsedText;
		if (hasAttributes) {
			for (const [attributeName, raw] of attributes) {
				const key = `${this.#settings.attributeNamePrefix}${attributeName}`;
				const value = this.#settings.parseAttributeValue ? coerceValue(raw) : raw;
				this.#addValue(children, key, `${path}.${attributeName}`, value, true, true);
			}
		}
		return { name, value: children, leaf: !hasChildren };
	}

	#readAttributeValue(): string {
		const quote = this.#xml[this.#position];
		if (quote === '"' || quote === "'") {
			const start = ++this.#position;
			const end = this.#xml.indexOf(quote, start);
			this.#position = end < 0 ? this.#xml.length : end + 1;
			return this.#normalizeText(this.#xml.slice(start, end < 0 ? this.#xml.length : end), true);
		}
		const start = this.#position;
		while (this.#position < this.#xml.length && !/[\s>]/.test(this.#xml[this.#position])) this.#position++;
		return this.#normalizeText(this.#xml.slice(start, this.#position), true);
	}

	#readProcessingInstruction(target: XmlObject): void {
		this.#position += 2;
		const name = this.#readName();
		const bodyStart = this.#position;
		const end = this.#xml.indexOf("?>", bodyStart);
		const body = this.#xml.slice(bodyStart, end < 0 ? this.#xml.length : end);
		this.#position = end < 0 ? this.#xml.length : end + 2;
		const value: XmlObject = {};
		let hasAttribute = false;
		const attributePattern = /([^\s=]+)\s*=\s*(["'])(.*?)\2/g;
		for (const match of body.matchAll(attributePattern)) {
			if (!this.#settings.ignoreAttributes) {
				value[`${this.#settings.attributeNamePrefix}${match[1]}`] = this.#normalizeText(match[3]!, true);
				hasAttribute = true;
			}
		}
		target[`?${name}`] = hasAttribute ? value : "";
	}

	#readDoctype(): void {
		const start = this.#position;
		let bracketDepth = 0;
		let quote = "";
		while (this.#position < this.#xml.length) {
			const char = this.#xml[this.#position++];
			if (quote) {
				if (char === quote) quote = "";
			} else if (char === '"' || char === "'") quote = char;
			else if (char === "[") bracketDepth++;
			else if (char === "]") bracketDepth--;
			else if (char === ">" && bracketDepth === 0) break;
		}
		const declaration = this.#xml.slice(start, this.#position);
		const entityPattern = /<!ENTITY\s+([^\s]+)\s+(["'])(.*?)\2\s*>/gs;
		for (const match of declaration.matchAll(entityPattern)) this.#entities.set(match[1]!, match[3]!);
	}

	#normalizeText(value: string, entities: boolean): string {
		let normalized = this.#settings.trimValues ? value.trim() : value;
		if (entities && this.#settings.processEntities && normalized.includes("&"))
			normalized = this.#expandEntities(normalized);
		return normalized;
	}

	#expandEntities(value: string, stack?: ReadonlySet<string>): string {
		return value.replace(/&([A-Za-z_:][\w.:-]*);/g, (whole, name: string) => {
			const standard = STANDARD_ENTITIES[name];
			if (standard !== undefined) return standard;
			const replacement = this.#entities.get(name);
			if (replacement === undefined || stack?.has(name)) return whole;
			this.#expansions++;
			if (this.#expansions > this.#settings.maxTotalExpansions) throw new Error("Entity expansion limit exceeded");
			const nextStack = new Set(stack);
			nextStack.add(name);
			return this.#expandEntities(replacement, nextStack);
		});
	}

	#addValue(
		target: XmlObject,
		name: string,
		path: string,
		value: unknown,
		leaf: boolean,
		attribute: boolean | null,
	): void {
		const present = Object.hasOwn(target, name);
		if (present) {
			const current = target[name];
			if (Array.isArray(current)) current.push(value);
			else target[name] = [current, value];
			return;
		}
		const forceArray = this.#settings.isArray?.(name, path, leaf, attribute) ?? false;
		target[name] = forceArray ? [value] : value;
	}

	#readName(): string {
		const start = this.#position;
		while (this.#position < this.#xml.length && !/[\s/>=]/.test(this.#xml[this.#position])) this.#position++;
		return this.#xml.slice(start, this.#position);
	}

	#skipWhitespace(): void {
		while (this.#position < this.#xml.length && /\s/.test(this.#xml[this.#position])) this.#position++;
	}

	#skipThrough(marker: string): void {
		const end = this.#xml.indexOf(marker, this.#position + marker.length);
		this.#position = end < 0 ? this.#xml.length : end + marker.length;
	}
}

function coerceValue(value: string): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	if (value !== "" && /^[+-]?(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(value)) {
		return Number(value);
	}
	return value;
}
